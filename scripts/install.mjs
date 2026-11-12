#!/usr/bin/env node
/**
 * install — deploy this skill into AI coding harnesses.
 *
 *   node scripts/install.mjs                      user level: ~/.agents + ~/.claude
 *   node scripts/install.mjs --target all         + ~/.gemini, ~/.copilot
 *   node scripts/install.mjs --project .          project level + AGENTS.md + editor rules
 *   node scripts/install.mjs status               show what is installed
 *   node scripts/install.mjs uninstall --project .
 *
 * Copies (or links) SKILL.md, INSTALL.md, HARNESSES.md and scripts/.
 * Existing skill.config.json at the destination is preserved.
 *
 * Zero npm dependencies. Node.js >= 18.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fail, hasHelp, parseCliArgs, printHelp, runMain } from './shared.mjs';

const SKILL_NAME = 'nowheel';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.resolve(scriptDir, '..');
const ENTRIES = ['LICENSE', 'NOTICE', 'SKILL.md', 'INSTALL.md', 'HARNESSES.md', 'scripts'];
const DEFAULT_TARGETS = ['agents', 'claude'];

const TARGETS = {
  agents: { label: 'universal .agents', segments: ['.agents', 'skills'] },
  claude: { label: 'Claude Code', segments: ['.claude', 'skills'] },
  gemini: { label: 'Gemini CLI', segments: ['.gemini', 'skills'] },
  copilot: { label: 'Copilot CLI', segments: ['.copilot', 'skills'] },
};

const RULE_IDS = ['agents', 'cursor', 'windsurf', 'cline', 'copilot'];

const USAGE = `
install — deploy the skill into AI harnesses

Usage:
  node scripts/install.mjs [install] [options]
  node scripts/install.mjs status [--project dir] [--home dir] [--json]
  node scripts/install.mjs uninstall [--project dir] [--target list] [--home dir]

Options:
  --target <list>   agents,claude,gemini,copilot,all (default: agents,claude)
  --project <dir>   install into a project instead of the user home
  --home <dir>      override the home directory (testing / containers)
  --rules <list>    project mode: agents,cursor,windsurf,cline,copilot,auto,none
  --link            symlink instead of copying (Windows uses a junction)
  --force           overwrite a different installed version
  --dry-run         print the plan, change nothing
  --json            machine-readable output

Harness support:
  .agents/skills   Codex, Gemini CLI, Copilot CLI, Cline, Amp, OpenCode, Cursor
                   (recent builds), and other Agent Skills runtimes
  .claude/skills   Claude Code (it does not read .agents)
  .gemini/skills   Gemini CLI native location (alias also works)
  .copilot/skills  Copilot CLI native location (alias also works)

Project mode also writes a routing block into AGENTS.md and, when the editor
folder is present, rule files for Cursor, Windsurf, Cline and Copilot so a
harness without native skill loading still finds this skill.
`;

/* ------------------------------------------------------------------ */
/* Small filesystem helpers                                           */
/* ------------------------------------------------------------------ */

async function statSafe(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

async function lstatSafe(target) {
  try {
    return await lstat(target);
  } catch {
    return null;
  }
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Hash of every file this installer manages, so upgrades are detected. */
async function treeHash(dir) {
  const dirInfo = await statSafe(dir);
  if (!dirInfo || !dirInfo.isDirectory()) return null;

  const hash = createHash('sha256');
  let count = 0;
  for (const entry of [...ENTRIES].sort()) {
    const full = path.join(dir, entry);
    const info = await statSafe(full);
    if (!info) continue;
    if (info.isDirectory()) {
      const names = (await readdir(full)).sort();
      for (const name of names) {
        const file = path.join(full, name);
        const fileInfo = await statSafe(file);
        if (!fileInfo || !fileInfo.isFile()) continue;
        hash.update(`${entry}/${name}\0`);
        hash.update(await readFile(file));
        count += 1;
      }
    } else {
      hash.update(`${entry}\0`);
      hash.update(await readFile(full));
      count += 1;
    }
  }
  return count ? hash.digest('hex') : null;
}

async function isOurSkill(dest) {
  const text = await readText(path.join(dest, 'SKILL.md'));
  return text !== null && new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm').test(text);
}

async function removePath(dest) {
  const info = await lstatSafe(dest);
  if (!info) return false;
  if (info.isSymbolicLink()) await unlink(dest);
  else await rm(dest, { recursive: true, force: true });
  return true;
}

async function copySkill(source, dest) {
  await mkdir(dest, { recursive: true });
  // Replace scripts/ so deleted files do not linger; keep skill.config.json.
  await rm(path.join(dest, 'scripts'), { recursive: true, force: true });
  for (const entry of ENTRIES) {
    const from = path.join(source, entry);
    if (!existsSync(from)) continue;
    await cp(from, path.join(dest, entry), { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Deploy                                                             */
/* ------------------------------------------------------------------ */

function sourceHash() {
  return treeHash(SOURCE_DIR);
}

async function deploy(dest, opts) {
  const info = await lstatSafe(dest);
  const hash = await treeHash(dest);

  if (info && info.isSymbolicLink()) {
    const target = await realpath(dest).catch(() => null);
    if (target === SOURCE_DIR) return { action: 'up-to-date' };
    if (!opts.force) {
      return { action: 'conflict', detail: 'destination is a symlink to another folder' };
    }
  } else if (info && !info.isDirectory()) {
    if (!opts.force) {
      return { action: 'conflict', detail: 'destination exists and is a file' };
    }
  } else if (info && hash === opts.hash) {
    return { action: 'up-to-date' };
  } else if (info && hash === null) {
    let entries = [];
    try {
      entries = await readdir(dest);
    } catch {
      entries = [];
    }
    if (entries.length && !opts.force) {
      return { action: 'conflict', detail: 'destination exists and is not this skill' };
    }
  } else if (info && hash !== opts.hash && !opts.force) {
    return { action: 'conflict', detail: 'a different version is installed (use --force)' };
  }

  const action = info ? 'updated' : 'installed';
  if (opts.dryRun) return { action: opts.link ? 'linked' : action };

  if (opts.link) {
    if (info) await removePath(dest);
    await mkdir(path.dirname(dest), { recursive: true });
    await symlink(SOURCE_DIR, dest, process.platform === 'win32' ? 'junction' : 'dir');
    return { action: 'linked' };
  }

  await copySkill(SOURCE_DIR, dest);
  return { action };
}

/* ------------------------------------------------------------------ */
/* Project routing files                                              */
/* ------------------------------------------------------------------ */

const ROUTER_MARKER = `<!-- ${SKILL_NAME} -->`;

function routerText(relSkill) {
  return (
    `Before any UI design, icon, animation, or complex-feature work, read \`${relSkill}/SKILL.md\`, ` +
    `run \`node ${relSkill}/scripts/control.mjs status\`, and follow its three rules and feature switches. ` +
    'Never hand-draw icon paths (use scripts/icon-tool.mjs). Never rebuild a proven feature (use scripts/oss-scout.mjs).'
  );
}

function ruleFile(ruleId, relSkill) {
  const body = `${ROUTER_MARKER}\n${routerText(relSkill)}\n`;
  switch (ruleId) {
    case 'cursor':
      return {
        file: path.join('.cursor', 'rules', 'nowheel.mdc'),
        content: `---\ndescription: NoWheel — pragmatic design and open-source workflow\nglobs:\nalwaysApply: true\n---\n\n${body}`,
      };
    case 'windsurf':
      return {
        file: path.join('.windsurf', 'rules', 'nowheel.md'),
        content: `---\ntrigger: always_on\n---\n\n${body}`,
      };
    case 'cline':
      return {
        file: path.join('.clinerules', 'nowheel.md'),
        content: body,
      };
    case 'copilot':
      return {
        file: path.join('.github', 'instructions', 'nowheel.instructions.md'),
        content: `---\napplyTo: "**"\n---\n\n${body}`,
      };
    default:
      return null;
  }
}

function detectRules(projectDir) {
  const rules = ['agents'];
  if (existsSync(path.join(projectDir, '.cursor'))) rules.push('cursor');
  if (existsSync(path.join(projectDir, '.windsurf'))) rules.push('windsurf');
  if (existsSync(path.join(projectDir, '.clinerules'))) rules.push('cline');
  if (existsSync(path.join(projectDir, '.github'))) rules.push('copilot');
  return rules;
}

function resolveRules(value, projectDir) {
  if (!value || value === 'auto') return detectRules(projectDir);
  if (value === 'none') return [];
  const requested = value.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = requested.filter((item) => !RULE_IDS.includes(item));
  if (invalid.length) {
    fail(`Unknown rule target: ${invalid.join(', ')}.`, `Use ${RULE_IDS.join(', ')}, auto, or none.`);
  }
  return requested;
}

async function upsertAgentsBlock(projectDir, relSkill, opts, actions) {
  const file = path.join(projectDir, 'AGENTS.md');
  const existing = (await readText(file)) || '';
  const block = `<!-- ${SKILL_NAME}:start -->\n## NoWheel\n\n${routerText(
    relSkill,
  )}\n<!-- ${SKILL_NAME}:end -->`;

  let next;
  const pattern = new RegExp(
    `<!-- ${SKILL_NAME}:start -->[\\s\\S]*?<!-- ${SKILL_NAME}:end -->`,
  );
  if (pattern.test(existing)) next = existing.replace(pattern, block);
  else {
    const trimmed = existing.trimEnd();
    next = `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
  }

  if (next === existing) {
    actions.push({ label: 'agents file', path: file, action: 'up-to-date' });
    return;
  }
  const action = existing ? 'updated' : 'installed';
  if (!opts.dryRun) await writeFile(file, next, 'utf8');
  actions.push({ label: 'agents file', path: file, action });
}

async function writeRuleFile(ruleId, projectDir, relSkill, opts, actions) {
  const rule = ruleFile(ruleId, relSkill);
  if (!rule) return;
  const file = path.join(projectDir, rule.file);
  const existing = await readText(file);

  if (existing !== null && !existing.includes(ROUTER_MARKER) && !opts.force) {
    actions.push({
      label: ruleId,
      path: file,
      action: 'conflict',
      detail: 'file exists without the skill marker (use --force)',
    });
    return;
  }
  if (existing === rule.content) {
    actions.push({ label: ruleId, path: file, action: 'up-to-date' });
    return;
  }
  const action = existing === null ? 'installed' : 'updated';
  if (!opts.dryRun) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, rule.content, 'utf8');
  }
  actions.push({ label: ruleId, path: file, action });
}

async function removeAgentsBlock(projectDir, opts, actions) {
  const file = path.join(projectDir, 'AGENTS.md');
  const existing = await readText(file);
  if (!existing) return;
  const pattern = new RegExp(
    `\\n?<!-- ${SKILL_NAME}:start -->[\\s\\S]*?<!-- ${SKILL_NAME}:end -->\\n?`,
    'g',
  );
  if (!pattern.test(existing)) return;
  const next = `${existing.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  if (!opts.dryRun) {
    if (next.trim()) await writeFile(file, next, 'utf8');
    else await rm(file, { force: true });
  }
  actions.push({ label: 'agents file', path: file, action: 'removed' });
}

async function removeRuleFile(ruleId, projectDir, opts, actions) {
  const rule = ruleFile(ruleId, '.agents');
  if (!rule) return;
  const file = path.join(projectDir, rule.file);
  const existing = await readText(file);
  if (existing === null || !existing.includes(ROUTER_MARKER)) return;
  if (!opts.dryRun) await rm(file, { force: true });
  actions.push({ label: ruleId, path: file, action: 'removed' });
}

/* ------------------------------------------------------------------ */
/* Install / status / uninstall                                       */
/* ------------------------------------------------------------------ */

function resolveTargets(value, fallback) {
  if (!value) return fallback;
  if (value === 'all') return Object.keys(TARGETS);
  const requested = value.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = requested.filter((item) => !TARGETS[item]);
  if (invalid.length) {
    fail(`Unknown target: ${invalid.join(', ')}.`, `Use ${Object.keys(TARGETS).join(', ')}, or all.`);
  }
  return requested;
}

function relativeSkillPath(targets) {
  const primary = targets.includes('agents') ? 'agents' : targets[0];
  return `${TARGETS[primary].segments.join('/')}/${SKILL_NAME}`;
}

function printActions(actions, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ actions }, null, 2)}\n`);
    return;
  }
  const marks = {
    installed: '✅',
    updated: '✅',
    linked: '✅',
    'up-to-date': '✅',
    conflict: '⛔',
    removed: '🗑️',
  };
  for (const item of actions) {
    const detail = item.detail ? ` — ${item.detail}` : '';
    process.stdout.write(
      `${marks[item.action] || '•'} ${item.label.padEnd(12)} ${item.path} (${item.action}${detail})\n`,
    );
  }
}

async function installCommand(args) {
  const { values } = parseCliArgs(args, {
    target: { type: 'string' },
    project: { type: 'string' },
    home: { type: 'string' },
    rules: { type: 'string' },
    link: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });

  const opts = {
    link: values.link,
    force: values.force,
    dryRun: values['dry-run'],
    hash: await sourceHash(),
  };

  if (!opts.dryRun && !existsSync(path.join(SOURCE_DIR, 'SKILL.md'))) {
    fail(`Source skill not found at ${SOURCE_DIR}.`, 'Run this script from the skill folder.');
  }

  const actions = [];
  let mode;
  let base;

  if (values.project) {
    mode = 'project';
    base = path.resolve(values.project);
    const info = await statSafe(base);
    if (!info || !info.isDirectory()) {
      fail(`Project directory not found: ${base}`, 'Create it or pass the correct path.');
    }

    const targets = resolveTargets(values.target, DEFAULT_TARGETS);
    for (const target of targets) {
      const dest = path.join(base, ...TARGETS[target].segments, SKILL_NAME);
      actions.push({ label: target, path: dest, ...(await deploy(dest, opts)) });
    }

    const rules = resolveRules(values.rules, base);
    const relSkill = relativeSkillPath(targets);
    if (rules.includes('agents')) await upsertAgentsBlock(base, relSkill, opts, actions);
    for (const ruleId of rules) {
      if (ruleId !== 'agents') await writeRuleFile(ruleId, base, relSkill, opts, actions);
    }
    if (rules.includes('copilot')) {
      // VS Code Copilot also discovers project skills natively here.
      const dest = path.join(base, '.github', 'skills', SKILL_NAME);
      actions.push({ label: 'vscode', path: dest, ...(await deploy(dest, opts)) });
    }
  } else {
    mode = 'user';
    base = path.resolve(values.home || os.homedir());
    if (values.rules) fail('--rules requires --project.');
    const targets = resolveTargets(values.target, DEFAULT_TARGETS);
    for (const target of targets) {
      const dest = path.join(base, ...TARGETS[target].segments, SKILL_NAME);
      actions.push({ label: target, path: dest, ...(await deploy(dest, opts)) });
    }
  }

  const conflicts = actions.filter((item) => item.action === 'conflict');
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({ mode, base, dryRun: opts.dryRun, skill: SOURCE_DIR, actions }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`# Harness install — ${SKILL_NAME}\n\n`);
    process.stdout.write(`Mode: ${mode} · ${base}${opts.dryRun ? ' · dry run' : ''}\n\n`);
    printActions(actions, false);
    if (!conflicts.length) {
      const first = actions.find((item) => item.action !== 'conflict');
      process.stdout.write('\nNext: restart the harness, then verify with:\n');
      process.stdout.write(
        `node "${path.join(first ? first.path : base, 'scripts', 'doctor.mjs')}"\n`,
      );
    }
  }

  if (conflicts.length) process.exitCode = 1;
}

async function statusCommand(args) {
  const { values } = parseCliArgs(args, {
    project: { type: 'string' },
    home: { type: 'string' },
    target: { type: 'string' },
    json: { type: 'boolean', default: false },
  });

  const hash = await sourceHash();
  const mode = values.project ? 'project' : 'user';
  const base = values.project
    ? path.resolve(values.project)
    : path.resolve(values.home || os.homedir());
  const targets = resolveTargets(values.target, mode === 'project' ? DEFAULT_TARGETS : Object.keys(TARGETS));

  const rows = [];
  for (const target of targets) {
    const dest = path.join(base, ...TARGETS[target].segments, SKILL_NAME);
    const installed = await treeHash(dest);
    let state = 'not installed';
    if (installed === hash) state = 'up to date';
    else if (installed !== null) state = 'different version';
    else if ((await lstatSafe(dest))?.isSymbolicLink()) state = 'broken link';
    rows.push({ target, path: dest, state });
  }

  if (mode === 'project') {
    const dest = path.join(base, '.github', 'skills', SKILL_NAME);
    if (await statSafe(dest)) {
      rows.push({
        target: 'vscode',
        path: dest,
        state: (await treeHash(dest)) === hash ? 'up to date' : 'different version',
      });
    }
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ mode, base, actions: rows }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`# Install status — ${mode} · ${base}\n\n`);
  for (const row of rows) {
    const mark = row.state === 'up to date' ? '✅' : row.state === 'not installed' ? '⬜' : '⚠️';
    process.stdout.write(`${mark} ${row.target.padEnd(8)} ${row.path} (${row.state})\n`);
  }
}

async function uninstallCommand(args) {
  const { values } = parseCliArgs(args, {
    target: { type: 'string' },
    project: { type: 'string' },
    home: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  });

  const opts = { dryRun: values['dry-run'], force: true };
  const actions = [];
  const mode = values.project ? 'project' : 'user';
  const base = values.project
    ? path.resolve(values.project)
    : path.resolve(values.home || os.homedir());
  const targets = resolveTargets(values.target, values.project ? DEFAULT_TARGETS : Object.keys(TARGETS));

  for (const target of targets) {
    const dest = path.join(base, ...TARGETS[target].segments, SKILL_NAME);
    if (!(await isOurSkill(dest))) continue;
    if (!opts.dryRun) await removePath(dest);
    actions.push({ label: target, path: dest, action: 'removed' });
  }

  if (values.project) {
    const extra = path.join(base, '.github', 'skills', SKILL_NAME);
    if (await isOurSkill(extra)) {
      if (!opts.dryRun) await removePath(extra);
      actions.push({ label: 'vscode', path: extra, action: 'removed' });
    }
    await removeAgentsBlock(base, opts, actions);
    for (const ruleId of ['cursor', 'windsurf', 'cline', 'copilot']) {
      await removeRuleFile(ruleId, base, opts, actions);
    }
  }

  if (!actions.length) {
    process.stdout.write('Nothing to remove.\n');
    return;
  }
  if (values.json) process.stdout.write(`${JSON.stringify({ actions }, null, 2)}\n`);
  else printActions(actions, false);
}

/* ------------------------------------------------------------------ */
/* Entry                                                              */
/* ------------------------------------------------------------------ */

runMain(async () => {
  const argv = process.argv.slice(2);
  if (hasHelp(argv)) return printHelp(USAGE);

  const commands = new Set(['install', 'status', 'uninstall']);
  const command = commands.has(argv[0]) ? argv[0] : 'install';
  const args = commands.has(argv[0]) ? argv.slice(1) : argv;

  switch (command) {
    case 'status':
      return statusCommand(args);
    case 'uninstall':
      return uninstallCommand(args);
    default:
      return installCommand(args);
  }
});
