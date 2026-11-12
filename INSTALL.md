# Install & Network Setup

For an AI agent setting this skill up on a fresh machine. Run every command from the folder containing this file.

**The only hard requirement is Node.js >= 18. There is no `npm install`.** Both tools use Node built-ins only, and all helpers below are optional.

## 30-second path

```bash
node --version                 # must print v18.x or newer
node scripts/doctor.mjs        # checks node, scripts, auth, proxy, and every endpoint
```

If the verdict says `ready` or `limited`, installation is complete. `limited` only means some endpoints are blocked; the doctor lists the automatic fallback for each.

## Install into a harness

```bash
node scripts/install.mjs                  # ~/.agents + ~/.claude
node scripts/install.mjs --target all     # + ~/.gemini + ~/.copilot
node scripts/install.mjs --project .      # project level + AGENTS.md + editor rules
```

`.agents/skills` covers Codex, Gemini CLI, Copilot CLI, Cline, Amp, OpenCode and other Agent Skills runtimes; Claude Code needs `.claude/skills`. For the full support matrix, Cursor/Windsurf routing, and uninstall steps, see `HARNESSES.md`.

## Control panel

```bash
node scripts/control.mjs            # opens http://127.0.0.1:4317
node scripts/control.mjs status     # compact state for an agent
node scripts/control.mjs set icons off
```

The three switches (`ask`, `icons`, `oss`) map to the three rules in `SKILL.md`. State is written to `skill.config.json` next to `SKILL.md`; `reset` returns to all on. The panel binds to `127.0.0.1` only.

## 1. Hard requirement — Node.js >= 18

Skip this section if `node --version` already prints v18+.

| OS | Install |
| --- | --- |
| Windows | `winget install OpenJS.NodeJS.LTS` (or `scoop install nodejs-lts`, `choco install nodejs-lts`) |
| macOS | `brew install node@22` (or `nvm install --lts`) |
| Debian/Ubuntu | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt-get install -y nodejs` |
| Any (nvm) | `nvm install --lts && nvm use --lts` |

**Slow or blocked nodejs.org (e.g. mainland China)**

- Download the LTS archive from `https://npmmirror.com/mirrors/node/`.
- nvm: `export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node`
- npm registry: `npm config set registry https://registry.npmmirror.com`

**Offline / air-gapped machine**

Copy a portable Node archive and this skill folder over by USB, unzip, add `node` to `PATH`. Nothing else is downloaded at install time.

## 2. Optional helpers (auto-detected; never required)

**GitHub token — raises the API limit from 60 to 5000 requests/hour**

```bash
export GITHUB_TOKEN=ghp_xxx        # PowerShell: $env:GITHUB_TOKEN = 'ghp_xxx'
# or install the gh CLI and sign in:
winget install GitHub.cli          # brew install gh / sudo apt install gh
gh auth login
```

The scripts try `GITHUB_TOKEN` → `gh auth token` → anonymous, in that order.

**repomix — richer source unpacking**

Nothing to install. The first `unpack` runs `npx -y repomix`. If `npx` or the npm registry is unavailable, the built-in GitHub Trees engine runs automatically.

## 3. Working behind any network

| Environment | Setup | What happens automatically |
| --- | --- | --- |
| Direct internet | none | — |
| Corporate / local proxy | set `HTTPS_PROXY` and `HTTP_PROXY` (see below) | The scripts tunnel HTTPS through the proxy themselves, including on Node 18–22. Credentials in the URL are supported: `http://user:pass@host:port`. `NO_PROXY` is honoured. |
| Mainland China | proxy or token recommended for GitHub | npm falls back to `registry.npmmirror.com`; Iconify falls back to `api.simplesvg.com` / `api.unisvg.com`. |
| Blocked raw.githubusercontent | none | File reads fall back to jsDelivr, then the GitHub contents API. |
| Air-gapped | none | `check-local` and local SVG work offline; online commands fail with one clear message instead of hanging. |

Setting proxy variables:

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1
```

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'   # current session
setx HTTPS_PROXY 'http://127.0.0.1:7890'      # permanent
```

```bat
set HTTPS_PROXY=http://127.0.0.1:7890
```

## 4. Resilience the tools already do — do not repair by hand

- Every request retries **3 times** on network errors, `408`, `429`, and `5xx`, with exponential backoff and `Retry-After` support.
- Iconify hosts: `api.iconify.design` → `api.simplesvg.com` → `api.unisvg.com`.
- npm registries: `registry.npmjs.org` → `registry.npmmirror.com`.
- Repo files: `raw.githubusercontent.com` → jsDelivr → GitHub contents API.
- Docs pages: Jina Reader → direct HTML extraction.
- `unpack`: repomix → GitHub Trees API.
- GitHub rate limits produce a message with the reset time and the fix — not a silent failure.

If a command still fails, show its error text to the user. Do not re-run it in a loop.

## 5. Verify

```bash
node scripts/doctor.mjs
node scripts/icon-tool.mjs search "sparkles" --limit 1
node scripts/oss-scout.mjs search "zustand" --ecosystem npm --limit 1
```

## 6. The only problems you must fix manually

| Symptom | Fix |
| --- | --- |
| `node: command not found` / `v16.x` | Install or upgrade Node to 18+ (section 1). |
| Every network row shows ❌ | Set the proxy variables (section 3), or accept offline mode. |
| GitHub returns 403 rate limit | Set `GITHUB_TOKEN` or run `gh auth login`. |
| `unpack` is slow on a restricted network | Expected: repomix times out, then the built-in engine finishes. Add `--engine builtin` to skip the attempt. |
| npx blocked by an execution policy | Use `--engine builtin`; no installation needed. |
