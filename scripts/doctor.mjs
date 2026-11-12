#!/usr/bin/env node
/**
 * doctor — one-command toolchain check for a fresh machine.
 *
 * Verifies the hard requirement (Node >= 18), optional helpers (proxy,
 * GitHub auth, npx/repomix), and every external endpoint the other scripts
 * use. Network failures are reported with the automatic fallback that will
 * be used, so the agent does not have to repair anything.
 *
 * Zero npm dependencies. Node.js >= 18.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ICONIFY_API_HOSTS,
  NPM_REGISTRIES,
  getGithubAuth,
  hasHelp,
  parseCliArgs,
  printHelp,
  proxyForUrl,
  request,
  runCommand,
  runMain,
} from './shared.mjs';

const USAGE = `
doctor — verify the toolchain on this machine

Usage:
  node scripts/doctor.mjs [--json]

Checks:
  - Node.js version (hard requirement: >= 18)
  - Skill scripts present
  - Proxy configuration (HTTPS_PROXY / HTTP_PROXY / NO_PROXY)
  - GitHub auth (GITHUB_TOKEN -> gh CLI -> anonymous)
  - npx availability (optional; repomix downloads on first unpack)
  - Reachability of Iconify (2 hosts), npm (2 registries), GitHub API,
    Jina Reader, raw.githubusercontent and jsDelivr

Exit code 0 means installed. Network gaps are fine: every failing row names
the automatic fallback, so there is nothing to fix by hand.
`;

const PROBE_TIMEOUT = 8000;

async function probe(url, headers = {}) {
  const started = Date.now();
  try {
    const res = await request(url, {
      headers: { Accept: 'application/json', ...headers },
      timeout: PROBE_TIMEOUT,
      retries: 0,
    });
    return {
      reachable: res.status >= 200 && res.status < 500,
      status: res.status,
      ms: Date.now() - started,
      error: res.status >= 500 ? `HTTP ${res.status}` : null,
    };
  } catch (err) {
    return {
      reachable: false,
      status: 0,
      ms: Date.now() - started,
      error: shortError(err),
    };
  }
}

function statusMark(result) {
  if (!result.reachable) return '❌';
  return '✅';
}

function shortError(err) {
  const message = err && err.message ? err.message : String(err);
  const detail = /\(([^()]*)\)\s*$/.exec(message);
  return (detail ? detail[1] : message).slice(0, 64);
}

function seconds(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function redactProxy(proxy) {
  if (!proxy) return '';
  return `${proxy.protocol}//${proxy.host}`;
}

runMain(async () => {
  const argv = process.argv.slice(2);
  if (hasHelp(argv)) return printHelp(USAGE);
  const { values } = parseCliArgs(argv, { json: { type: 'boolean', default: false } });

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const expectedScripts = [
    'icon-tool.mjs',
    'oss-scout.mjs',
    'control.mjs',
    'control-ui.html',
    'install.mjs',
    'package.mjs',
    'shared.mjs',
    'doctor.mjs',
  ];
  const missingScripts = expectedScripts.filter(
    (name) => !existsSync(path.join(scriptDir, name)),
  );
  const skillRoot = path.resolve(scriptDir, '..');
  const expectedDocs = ['LICENSE', 'NOTICE', 'SKILL.md', 'INSTALL.md', 'HARNESSES.md'];
  const missingDocs = expectedDocs.filter((name) => !existsSync(path.join(skillRoot, name)));

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);

  const auth = await getGithubAuth();
  const authHeaders = { Accept: 'application/vnd.github+json' };
  if (auth.token) authHeaders.Authorization = `Bearer ${auth.token}`;

  const [npxCheck, iconPrimary, iconMirror, npmPrimary, npmMirror, github, jina, raw, jsdelivr] =
    await Promise.all([
      runCommand('npx', ['--version'], { timeout: 10000 }),
      probe(`${ICONIFY_API_HOSTS[0]}/search?query=star&limit=1`),
      probe(`${ICONIFY_API_HOSTS[1]}/search?query=star&limit=1`),
      probe(`${NPM_REGISTRIES[0]}/-/v1/search?text=react&size=1`),
      probe(`${NPM_REGISTRIES[1]}/-/v1/search?text=react&size=1`),
      probe('https://api.github.com/rate_limit', authHeaders),
      probe('https://r.jina.ai/https://example.com', {
        'X-Return-Format': 'markdown',
        Accept: 'text/plain',
      }),
      probe('https://raw.githubusercontent.com/lukeed/clsx/master/package.json', {
        Accept: 'text/plain',
      }),
      probe('https://cdn.jsdelivr.net/gh/lukeed/clsx@master/package.json', {
        Accept: 'text/plain',
      }),
    ]);

  const npxVersion = npxCheck.code === 0 ? npxCheck.stdout.trim() : null;

  let githubRemaining = null;
  if (github.reachable) {
    try {
      const res = await request('https://api.github.com/rate_limit', {
        headers: authHeaders,
        timeout: PROBE_TIMEOUT,
        retries: 0,
      });
      const data = JSON.parse(res.text);
      githubRemaining = data?.resources?.core?.remaining ?? data?.rate?.remaining ?? null;
    } catch {
      // Rate detail is optional.
    }
  }

  const proxy = proxyForUrl('https://api.iconify.design');
  const iconOk = iconPrimary.reachable || iconMirror.reachable;
  const ossOk = npmPrimary.reachable || npmMirror.reachable || github.reachable;
  const scriptsOk = missingScripts.length === 0;

  const verdict = !scriptsOk
    ? 'incomplete — re-copy the scripts/ directory'
    : (iconOk && ossOk
        ? 'ready'
        : 'limited — offline commands still work (check-local, installed icon libs)');

  const notes = [];
  if (!iconPrimary.reachable && iconMirror.reachable) {
    notes.push('icons: primary host unreachable, the mirror is used automatically.');
  }
  if (!npmPrimary.reachable && npmMirror.reachable) {
    notes.push('npm: official registry unreachable, the npmmirror registry is used automatically.');
  }
  if (!jina.reachable) {
    notes.push('docs: Jina Reader unreachable, `inspect <url>` falls back to direct HTML.');
  }
  if (!raw.reachable) {
    notes.push('source: raw.githubusercontent unreachable, `unpack` uses jsDelivr, then the contents API.');
  }
  if (auth.source === 'anonymous') {
    notes.push('github: set GITHUB_TOKEN or run `gh auth login` to avoid the 60 requests/hour limit.');
  }
  if (!npxVersion) {
    notes.push('npx missing: `unpack` uses the built-in GitHub Trees engine (no action needed).');
  }

  const data = {
    node: { version: nodeVersion, ok: nodeMajor >= 18 },
    scripts: { ok: scriptsOk, missing: missingScripts },
    docs: { ok: missingDocs.length === 0, missing: missingDocs },
    proxy: proxy ? redactProxy(proxy) : null,
    githubAuth: auth.source,
    npx: npxVersion,
    probes: { iconPrimary, iconMirror, npmPrimary, npmMirror, github, jina, raw, jsdelivr },
    githubRemaining,
    verdict,
    notes,
  };

  if (values.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push('# Toolchain check');
  lines.push('');
  lines.push(`Node           ${nodeMajor >= 18 ? '✅' : '❌'} v${nodeVersion} (require >= 18)`);
  lines.push(`Scripts        ${scriptsOk ? '✅' : '❌'} ${scriptsOk ? expectedScripts.join(' · ') : `missing: ${missingScripts.join(', ')}`}`);
  lines.push(
    `Docs           ${missingDocs.length ? '❌' : '✅'} ${
      missingDocs.length ? `missing: ${missingDocs.join(', ')}` : expectedDocs.join(' · ')
    }`,
  );
  lines.push(
    `Proxy          ${proxy ? `✅ ${redactProxy(proxy)}` : '⚠️ not set — only needed if requests fail'}`,
  );
  lines.push(
    `GitHub auth    ${auth.source === 'anonymous' ? '⚠️ anonymous (60 req/h)' : `✅ ${auth.source}`}`,
  );
  lines.push(
    `npx            ${npxVersion ? `✅ ${npxVersion} (repomix optional)` : '⚠️ missing (built-in engine used)'}`,
  );
  lines.push('');
  lines.push('Network');
  lines.push(`  iconify        ${statusMark(iconPrimary)} primary ${iconPrimary.reachable ? `${iconPrimary.status} · ${seconds(iconPrimary.ms)}` : iconPrimary.error}`);
  lines.push(`                 ${statusMark(iconMirror)} mirror  ${iconMirror.reachable ? `${iconMirror.status} · ${seconds(iconMirror.ms)}` : iconMirror.error}`);
  lines.push(`  npm            ${statusMark(npmPrimary)} registry ${npmPrimary.reachable ? `${npmPrimary.status} · ${seconds(npmPrimary.ms)}` : npmPrimary.error}`);
  lines.push(`                 ${statusMark(npmMirror)} mirror   ${npmMirror.reachable ? `${npmMirror.status} · ${seconds(npmMirror.ms)}` : npmMirror.error}`);
  lines.push(
    `  GitHub API     ${statusMark(github)} ${github.reachable ? `${github.status}${githubRemaining !== null ? ` · ${githubRemaining} req left` : ''} · ${seconds(github.ms)}` : github.error}`,
  );
  lines.push(`  docs (Jina)    ${statusMark(jina)} ${jina.reachable ? `${jina.status} · ${seconds(jina.ms)}` : jina.error}`);
  lines.push(`  raw source     ${statusMark(raw)} ${raw.reachable ? `${raw.status} · ${seconds(raw.ms)}` : raw.error}`);
  lines.push(`  jsDelivr       ${statusMark(jsdelivr)} ${jsdelivr.reachable ? `${jsdelivr.status} · ${seconds(jsdelivr.ms)}` : jsdelivr.error}`);
  lines.push('');
  lines.push(`Verdict        ${verdict}`);

  if (notes.length) {
    lines.push('');
    lines.push('Notes');
    for (const note of notes) lines.push(`- ${note}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
});
