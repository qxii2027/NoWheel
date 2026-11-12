---
name: nowheel
description: Use when building UI/UX interfaces, advanced visual effects, or complex product features — and especially before drawing an icon SVG by hand, inventing an icon name from memory, or implementing a complex capability (editor, drag-and-drop, charts, 3D, rich text, virtual scrolling, media) that likely has a proven open-source implementation. Also use when a design or dependency choice could reasonably go several ways.
---

# NoWheel

Apply these three rules to any interface design, component build, animation, or complex feature. Every command below is relative to this file's `scripts/` directory.

## Setup

On a new machine, follow `INSTALL.md` and run `node scripts/doctor.mjs`. Node.js >= 18 is the only requirement — there is no `npm install`. Proxy handling, request retries, and mirror failover are automatic: never retry a failed command by hand, report its error instead.

Commands are written relative to this file's folder. If your harness starts you in the project directory, resolve the directory containing this `SKILL.md` and prefix commands with it. To install this skill into another harness, see `HARNESSES.md`.

## Feature switches

Check the switches once per task:

```bash
node scripts/control.mjs status
```

| Switch | Rule | When off |
| --- | --- | --- |
| `ask` | Rule 1 | Skip the pause; make the call and proceed. |
| `icons` | Rule 2 | Do not call `icon-tool.mjs`; follow the project's existing icon approach. |
| `oss` | Rule 3 | Do not call `oss-scout.mjs`; implement directly. |

Defaults are all on. Users toggle them in the local panel (`node scripts/control.mjs`, `127.0.0.1:4317`). The switches override the rules below.

## Rule 1 — Interrupt and ask before major decisions

*Active only while the `ask` switch is on.*

Never generate a large body of code while an important choice is still open. Stop and ask the user when any of these is true:

1. **Design direction** — layout structure, core interaction flow, motion style (restrained vs. expressive), or visual tone has several reasonable options.
2. **Open-source trade-off** — multiple candidates differ meaningfully in bundle size, customization freedom, or fidelity.
3. **Heavy dependency or license risk** — a large framework is required, or a candidate uses `GPL` / `AGPL` / `SSPL` / a commercial restriction / no clear license.
4. **Deep fork** — the library's native API is insufficient and its source must be heavily trimmed or rewritten.

Ask in this shape:

- **Decision**: one sentence naming what must be decided.
- **Options (2–3)**: approach or candidate project, with stars, maintenance status, pros/cons, and adaptation cost.
- **Recommendation**: your preferred option and why. Wait for confirmation before coding.

## Rule 2 — Never hand-draw icons

*Active only while the `icons` switch is on.*

**Banned outright:**

- Writing `<svg><path d="..."/></svg>` from scratch for UI icons, illustrations, or brand logos. (Trivial geometric marks like a plain arrow or an X still come from an icon library first.)
- Building icons from stacked `div`s and pseudo-elements.
- Guessing export names such as `<LucideMagicWand />` before verifying they exist.

**Required flow:**

1. **Detect what the project already uses** — reuse the installed set so stroke weight and style stay consistent.
   ```bash
   node scripts/icon-tool.mjs check-local .
   ```
2. **Search for real icon ids.** Ordinary UI: `lucide`, `tabler`, `ph`. Brand logos: `simple-icons`.
   ```bash
   node scripts/icon-tool.mjs search "arrow up right" --prefix lucide,tabler --limit 15
   ```
3. **Install/import the verified component, or fetch the official SVG** for plain HTML or zero-dependency files.
   ```bash
   node scripts/icon-tool.mjs svg "lucide:arrow-up-right" --size 24 --out src/assets/arrow.svg
   ```

After fetching, only `width`/`height`, color (`currentColor`), and `class` may change. Never rewrite the path data.

## Rule 3 — Reuse and adapt open source instead of rebuilding

*Active only while the `oss` switch is on.*

Do not hand-build the core of **advanced visuals** (3D/WebGL, particles/fluid, spring physics, parallax, complex micro-interactions) or **complex features** (rich-text editor, drag-and-drop or canvas, flow charts, virtual scrolling, complex charts, audio/video, file parsing).

**Where to look**

- Motion/UI: Motion (Framer Motion), GSAP, Lenis, Three.js / R3F, and source-level component ecosystems such as shadcn/ui, Magic UI, Aceternity UI, Cult UI.
- Complex features: high-star GitHub repos and high-download packages in the project's ecosystem (npm / PyPI / crates.io).

**Scout, then filter**

```bash
# GitHub + npm, archived repos excluded, licenses audited
node scripts/oss-scout.mjs search "react kanban drag drop" --ecosystem all --limit 6
```

Admission criteria:

- **Maturity**: high stars / weekly downloads; battle-tested.
- **Maintenance**: updated within 6–12 months (tiny stable libraries excepted). Reject archived or framework-incompatible dead projects.
- **License**: prefer `MIT` / `Apache-2.0` / `ISC` / `BSD`. Any `⚠️` verdict triggers Rule 1 — ask the user.

If several candidates are close, or the dependency is large, ask the user before choosing.

**Read current docs before writing code** (never code from stale memory):

```bash
node scripts/oss-scout.mjs inspect "<owner/repo or docs URL>"
```

If a Context7 MCP is available, use it first; `inspect` is the fallback.

## Tool reference

Node.js **>= 18**, zero npm dependencies, no install step. Every command supports `--help`, prints compact Markdown by default, and accepts `--json`.

- **`doctor.mjs`** — environment check: Node, scripts, proxy, auth, npx, and every endpoint with its automatic fallback. Run it first on a new machine.
- **`control.mjs`** — `status`, `set <ask|icons|oss|all> <on|off>`, `reset`; a bare invocation opens the local panel.
- **`icon-tool.mjs`** — `check-local [dir]` · `search <query> --prefix a,b --limit n` · `svg <prefix:name> --size --color --out`.
- **`oss-scout.mjs`** — `search <query> --ecosystem all|github|npm|pypi --limit n` · `inspect <owner/repo|url> --max-chars n` · `unpack <owner/repo> --include "src/**" --out dir --engine auto|repomix|builtin`.

**License verdicts:** `✅ Permissive` / `⚠️ Copyleft or restricted` / `⚠️ Unclear`. When GitHub reports `NOASSERTION`, the tool reads the LICENSE file and sniffs MIT/ISC/Apache/GPL/BSD/etc. Any `⚠️` result must be confirmed with the user.

**GitHub auth:** `GITHUB_TOKEN` → local `gh auth token` → anonymous REST. Rate-limit exhaustion produces an explicit message with the reset time.

**Network:** retries, proxy support, and mirror fallbacks are built in — see `INSTALL.md`. Never retry a failed command by hand.

## Adapting an open-source project

**Mode A — black-box customization** (heavy logic: editors, charts, physics engines)

1. Install it normally.
2. Customize through its supported extension points: headless API, props, plugins, slots, CSS variables. Write a local wrapper.
3. Never edit files inside `node_modules`.

**Mode B — white-box source port** (UI effect components, lightweight implementations, or when the public API cannot express the design)

1. Pull the relevant source into a temporary reference directory.
   ```bash
   node scripts/oss-scout.mjs unpack "<owner/repo>" --include "src/**" --out .tmp/oss-ref
   ```
2. Read the core implementation; strip what you do not need.
3. Port into `src/components/` or `src/lib/`, adapt to the project's styling system (Tailwind, CSS Modules) and types, and adjust parameters/structure as needed.
4. Keep the upstream repository URL and license text in a header comment of every ported file.
5. Delete the temporary directory when finished.

## Red flags — stop and go back a step

| Thought | Reality |
| --- | --- |
| "It's just one simple icon, I'll draw it." | Hand-drawn icons drift from the installed set. Search the library. |
| "I remember the export name." | Guessed names break builds. Run `search` / `check-local`. |
| "This component is small enough to build." | If a maintained implementation exists, reuse it and customize. |
| "Adding another icon library is fine." | Mixing sets breaks visual consistency. Reuse the installed one or ask. |
| "The license is probably MIT." | Check it. Copyleft and unclear licenses require user confirmation. |
| "I can code the API from memory." | APIs change. Read current docs with `inspect` first. |
| "I'll adapt the source later." | Extract it first; do not hand-roll a partial copy from memory. |
| "The user said it's urgent, skip the question." | An unresolved design or dependency choice costs more to undo than to ask about. |

## Completion checklist

- [ ] Icons come from the installed library or a verified Iconify id; no hand-written paths.
- [ ] Complex capabilities were searched for an open-source implementation before coding.
- [ ] License verdict checked; any `⚠️` confirmed with the user.
- [ ] Docs read from the current source, not memory.
- [ ] Open design/dependency forks were raised while `ask` is on; ported code keeps its upstream URL and license header.
