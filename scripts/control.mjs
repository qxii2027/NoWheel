#!/usr/bin/env node
/**
 * control — switch the skill's three rules on or off.
 *
 *   node scripts/control.mjs              local panel at http://127.0.0.1:4317
 *   node scripts/control.mjs status       compact state for an agent
 *   node scripts/control.mjs set icons off
 *   node scripts/control.mjs reset        back to defaults (all on)
 *
 * State lives in skill.config.json next to SKILL.md. Zero npm dependencies.
 */

import http from 'node:http';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fail, hasHelp, parseCliArgs, printHelp, runCommand, runMain } from './shared.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.resolve(scriptDir, '..', 'skill.config.json');
const UI_PATH = path.join(scriptDir, 'control-ui.html');
const DEFAULT_PORT = 4317;

const FEATURES = [
  {
    id: 'ask',
    rule: 'Rule 01',
    title: 'Ask before decisions',
    description:
      'Pause when layout, interaction flow, motion style, dependency, or license choices are genuinely open. Present 2–3 options and a recommendation.',
    tool: 'no script',
  },
  {
    id: 'icons',
    rule: 'Rule 02',
    title: 'Icon library enforcement',
    description:
      'Detect the icon set already installed, search real ids, and fetch official SVG sources. No hand-written paths, no guessed export names.',
    tool: 'icon-tool.mjs',
  },
  {
    id: 'oss',
    rule: 'Rule 03',
    title: 'Open-source reuse',
    description:
      'Search, audit, read, and adapt proven open-source projects instead of rebuilding complex features from scratch.',
    tool: 'oss-scout.mjs',
  },
];

const USAGE = `
control — turn the skill's rules on or off

Usage:
  node scripts/control.mjs [--port 4317] [--no-open]   open the local panel
  node scripts/control.mjs serve [--port 4317] [--no-open]
  node scripts/control.mjs status [--json]             compact state (for agents)
  node scripts/control.mjs set <ask|icons|oss|all> <on|off>
  node scripts/control.mjs reset                       defaults (all on)

State file: skill.config.json (created on first change).
The panel binds to 127.0.0.1 only.
`;

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

function defaultConfig() {
  return {
    version: 1,
    features: Object.fromEntries(FEATURES.map((feature) => [feature.id, true])),
  };
}

function normalizeConfig(raw) {
  const config = defaultConfig();
  const features = raw && typeof raw === 'object' && raw.features ? raw.features : {};
  for (const feature of FEATURES) {
    if (typeof features[feature.id] === 'boolean') {
      config.features[feature.id] = features[feature.id];
    }
  }
  return config;
}

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    return { config: normalizeConfig(JSON.parse(raw)), exists: true };
  } catch {
    return { config: defaultConfig(), exists: false };
  }
}

async function saveConfig(config) {
  const tmp = `${CONFIG_PATH}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, 'utf8');
  await rename(tmp, CONFIG_PATH);
}

function featurePayload(config) {
  return FEATURES.map((feature) => ({
    ...feature,
    enabled: config.features[feature.id],
  }));
}

/* ------------------------------------------------------------------ */
/* status / set / reset                                               */
/* ------------------------------------------------------------------ */

async function statusCommand(args) {
  const { values } = parseCliArgs(args, { json: { type: 'boolean', default: false } });
  const { config, exists } = await loadConfig();

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          configPath: CONFIG_PATH,
          exists,
          features: config.features,
          meta: FEATURES.map(({ id, title, rule }) => ({ id, title, rule })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = ['# Skill features', ''];
  for (const feature of FEATURES) {
    const on = config.features[feature.id];
    lines.push(`${on ? '✅' : '⛔'} ${feature.id.padEnd(6)} ${feature.title} (${feature.rule})`);
  }
  lines.push('');
  lines.push(`Config: ${CONFIG_PATH}${exists ? '' : ' (defaults, no file yet)'}`);
  lines.push('Change: node scripts/control.mjs');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function setCommand(args) {
  const { positionals } = parseCliArgs(args, {});
  const [id, state] = positionals;
  if (!id || !state) {
    fail('Missing arguments.', 'Usage: set <ask|icons|oss|all> <on|off>');
  }
  if (!['on', 'off'].includes(state)) {
    fail(`Invalid state "${state}".`, 'Use on or off.');
  }
  const targets = id === 'all' ? FEATURES.map((feature) => feature.id) : [id];
  if (id !== 'all' && !FEATURES.some((feature) => feature.id === id)) {
    fail(`Unknown feature "${id}".`, `Use one of: ${FEATURES.map((f) => f.id).join(', ')}, all.`);
  }

  const { config } = await loadConfig();
  for (const target of targets) config.features[target] = state === 'on';
  await saveConfig(config);

  const summary = FEATURES.map((f) => `${f.id}=${config.features[f.id] ? 'on' : 'off'}`).join(' ');
  process.stdout.write(`Saved ${summary}\n`);
}

async function resetCommand() {
  try {
    await unlink(CONFIG_PATH);
    process.stdout.write('Removed skill.config.json — all features are on by default.\n');
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stdout.write('No config file; all features are already on by default.\n');
      return;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Panel server                                                       */
/* ------------------------------------------------------------------ */

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await runCommand(command, args, { timeout: 5000 });
}

async function serveCommand(args) {
  const { values } = parseCliArgs(args, {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
  });

  let html;
  try {
    html = await readFile(UI_PATH, 'utf8');
  } catch {
    fail(`Missing ${UI_PATH}.`, 'Re-copy the scripts/ directory from the skill.');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, 'text/html; charset=utf-8', html);
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        const { config } = await loadConfig();
        return sendJson(res, 200, {
          configPath: CONFIG_PATH,
          features: featurePayload(config),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = await readJsonBody(req);
        const feature = body && FEATURES.find((entry) => entry.id === body.id);
        if (!feature || typeof body.enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'Expected { id, enabled: boolean }.' });
        }
        const { config } = await loadConfig();
        config.features[feature.id] = body.enabled;
        await saveConfig(config);
        return sendJson(res, 200, { ok: true, features: featurePayload(config) });
      }

      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });

  const preferredPort = Math.min(
    65535,
    Math.max(1024, Number.parseInt(values.port || String(DEFAULT_PORT), 10) || DEFAULT_PORT),
  );

  let port = preferredPort;
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await listen(server, port);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EADDRINUSE') break;
      port += 1;
    }
  }
  if (lastError) {
    fail(`Could not start the panel on port ${preferredPort}.`, lastError.message);
  }

  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(`Control panel: ${url}\nConfig file:   ${CONFIG_PATH}\nPress Ctrl+C to stop.\n`);
  if (!values['no-open']) openBrowser(url);

  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

runMain(async () => {
  const argv = process.argv.slice(2);
  if (hasHelp(argv)) return printHelp(USAGE);

  const commands = new Set(['serve', 'status', 'set', 'reset']);
  const command = commands.has(argv[0]) ? argv[0] : 'serve';
  const args = commands.has(argv[0]) ? argv.slice(1) : argv;

  switch (command) {
    case 'status':
      return statusCommand(args);
    case 'set':
      return setCommand(args);
    case 'reset':
      return resetCommand();
    default:
      return serveCommand(args);
  }
});
