# Harness Installation Guide

This skill is a plain folder — `SKILL.md`, `INSTALL.md`, `HARNESSES.md`, `scripts/` — with no build step and no npm dependencies. Installing it means placing that folder where a harness looks for skills (or leaving a small router file that points to it).

Requirements: Node.js >= 18 for the scripts. The skill text itself needs nothing.

## One command

```bash
node scripts/install.mjs                 # user level: ~/.agents + ~/.claude
node scripts/install.mjs --target all    # + ~/.gemini + ~/.copilot
node scripts/install.mjs --project .     # project level + AGENTS.md + editor rules
```

The installer is idempotent, refuses to overwrite a different installed version without `--force`, and keeps any existing `skill.config.json` at the destination.

| Flag | Meaning |
| --- | --- |
| `--target agents,claude,gemini,copilot,all` | Which skill directories to write (default `agents,claude`). |
| `--project <dir>` | Install into a project instead of the user home. |
| `--home <dir>` | Override the home directory (containers, testing). |
| `--rules agents,cursor,windsurf,cline,copilot,auto,none` | Project mode only. `auto` detects editor folders. |
| `--link` | Symlink (junction on Windows) instead of copying. |
| `--force` | Replace a different installed version. |
| `--dry-run` | Print the plan, change nothing. |
| `--json` | Machine-readable result. |

## Where each harness looks

| Harness | Mechanism | Install location |
| --- | --- | --- |
| Claude Code | native `SKILL.md` | `~/.claude/skills/<name>/` or `<project>/.claude/skills/<name>/` |
| Codex CLI | native Agent Skills | `~/.agents/skills/<name>/` or `<project>/.agents/skills/<name>/` |
| Gemini CLI | native; `.agents` alias takes precedence | `~/.gemini/skills/<name>/` or `~/.agents/skills/<name>/` |
| GitHub Copilot CLI | native; `.agents` alias accepted | `~/.copilot/skills/<name>/` or `~/.agents/skills/<name>/` |
| VS Code Copilot | skills + instructions | `<project>/.github/skills/<name>/`, `.github/instructions/*.instructions.md` |
| Cline, Amp, OpenCode, Kimi, Warp | native `.agents` | `<project>/.agents/skills/<name>/` |
| Cursor | recent builds read `.agents`; otherwise rules | generated `.cursor/rules/nowheel.mdc` |
| Windsurf | rules | generated `.windsurf/rules/nowheel.md` |
| Any harness reading `AGENTS.md` | router block | appended to `<project>/AGENTS.md` |

`.agents/skills/` is the emerging cross-runtime location; Claude Code is the notable holdout, which is why the default install writes both `.agents` and `.claude`. Names must match the folder (`nowheel`).

## Project install

```bash
node scripts/install.mjs --project .
```

Writes:

- `.agents/skills/nowheel/` — universal copy (Codex, Gemini, Copilot, Cline, Amp, OpenCode, …)
- `.claude/skills/nowheel/` — Claude Code copy
- `AGENTS.md` — a marked block telling the agent to read `SKILL.md`, run `control.mjs status`, and obey the three rules
- `.cursor/rules/nowheel.mdc`, `.windsurf/rules/nowheel.md`, `.clinerules/nowheel.md`, `.github/instructions/nowheel.instructions.md` — only when the matching folder exists, or when requested with `--rules`
- `.github/skills/nowheel/` — when the Copilot rule is selected, so VS Code Copilot discovers it natively

All inserted blocks and rule files carry the `nowheel` marker, so `uninstall` removes exactly what the installer added.

## Manual install (any harness)

Copy the whole skill folder to one of the locations above. The tools are invoked as `node <skill-dir>/scripts/...`; nothing else is required. For a harness with no skill loader, paste this into its always-on instructions (or `AGENTS.md`):

```
Before any UI, icon, animation, or complex-feature work, read
<skill-dir>/SKILL.md, run `node <skill-dir>/scripts/control.mjs status`,
and follow its three rules and feature switches.
```

## Update, verify, remove

```bash
node scripts/install.mjs status --project .
node scripts/install.mjs --project . --force
node scripts/install.mjs uninstall --project .
```

Restart the harness after installing or updating — skill directories are scanned at startup. Then verify the tools from the installed copy:

```bash
node "<installed-skill>/scripts/doctor.mjs"
```

## Notes and limits

- Cursor and Windsurf support for `.agents/skills` varies by build. The installer writes both the folder and an always-on rule, so either discovery path works.
- `--link` keeps one source of truth while developing; Windows uses a junction and needs no admin rights. Copy is the default because links break when the skill folder moves.
- The router assumes commands run from the project root. If your harness starts elsewhere, prefix the paths with the project root.
- `skill.config.json` is local to each install. Copying the folder does not copy toggles; use `control.mjs` in the installed copy.
- Harnesses with no extension mechanism at all cannot be automated — use the manual instructions above.
