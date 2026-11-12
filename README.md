# NoWheel

> Pragmatic design and open-source workflow, packaged as an Agent Skill.

An Agent Skill that stops three expensive habits:

1. **Ask before deciding** — pause when layout, motion, dependencies, or licenses are genuinely open.
2. **Never hand-draw icons** — detect the installed icon set, search real ids, fetch official SVGs.
3. **Reuse open source** — search, license-audit, read, and adapt proven projects instead of rebuilding them.

It ships with zero-dependency Node.js tools, so it works offline after installation and needs no build step.

## Install

From a clone or an extracted release archive:

```bash
node scripts/install.mjs --project .     # project: .agents + .claude + AGENTS.md + editor rules
node scripts/install.mjs --target all    # user: ~/.agents, ~/.claude, ~/.gemini, ~/.copilot
```

From GitHub without cloning (after pushing this repository):

```bash
npx github:Qxii2027/NoWheel install --project .
```

From npm (after publishing):

```bash
npx nowheel install --project .
```

Works with Claude Code, Codex CLI, Gemini CLI, Copilot CLI, Cline, Amp, OpenCode, Cursor, Windsurf, and any harness that reads `AGENTS.md`. See [HARNESSES.md](HARNESSES.md) for the full matrix and manual install.

## Tools

| Script | Purpose |
| --- | --- |
| `scripts/install.mjs` | Install, update, or remove the skill across harnesses. |
| `scripts/doctor.mjs` | One-command environment and network check. |
| `scripts/control.mjs` | Toggle the three rules; opens a local panel at `127.0.0.1:4317`. |
| `scripts/icon-tool.mjs` | `check-local` · `search` · `svg` against Iconify. |
| `scripts/oss-scout.mjs` | `search` · `inspect` · `unpack` with license auditing. |
| `scripts/package.mjs` | Build a release ZIP with a SHA-256 checksum. |

Requirements: **Node.js >= 18**. No `npm install`, no third-party packages.

## Docs

- [SKILL.md](SKILL.md) — the rules an agent follows.
- [INSTALL.md](INSTALL.md) — setup, proxies, mirrors, control panel.
- [HARNESSES.md](HARNESSES.md) — installation per harness.
- [DISTRIBUTION.md](DISTRIBUTION.md) — releases, npm, plugin marketplace, offline.

## License

Apache-2.0 © 2026 Qxii2027. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Development

```bash
node scripts/doctor.mjs
node scripts/package.mjs
```

Version lives in `package.json`; tag releases as `v<version>`.
