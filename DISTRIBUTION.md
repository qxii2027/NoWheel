# Distribution

Three questions decide how this skill reaches users: **how they get it**, **where it installs**, **how it updates**. `scripts/install.mjs` answers the last two; this document covers the first.

## Channels at a glance

| Channel | Best for | One-line install |
| --- | --- | --- |
| GitHub release ZIP | public default | download, extract, run `scripts/install.mjs` |
| `git clone` | contributors, pinned versions | `node <repo>/scripts/install.mjs --project .` |
| `npx github:Qxii2027/NoWheel` | one-liner, no clone | `npx github:Qxii2027/NoWheel install --project .` |
| npm | discoverability | `npx nowheel install --project .` |
| Vendoring | teams that pin dependencies | commit `.agents/skills/...` into the repo |
| Offline archive | air-gapped machines | copy the ZIP + `.sha256` by hand |
| Claude Code plugin | marketplace users | plugin layout below |

## Before publishing

1. **Keep the license current.** This project is Apache-2.0 (`LICENSE`, `NOTICE`, and `package.json`). If you fork it under a different copyright holder, update the attribution line in `NOTICE`.
2. **Set the version** in `package.json` (semver) and tag the commit as `v<version>`.
3. **Run the checks**: `node scripts/doctor.mjs` and `node scripts/package.mjs`.
4. **Test a clean install** with an isolated home:
   ```bash
   node scripts/install.mjs --home .tmp/clean-home --target all
   node scripts/install.mjs status --home .tmp/clean-home
   ```

## 1. GitHub repository + release (recommended)

```bash
git init
git add .
git commit -m "feat: NoWheel initial release"
git branch -M main
git remote add origin https://github.com/Qxii2027/NoWheel.git
git push -u origin main

git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/release.yml` builds `dist/*.zip` on every `v*` tag and attaches it (plus the checksum) to the GitHub release. Consumers:

```bash
curl -LO https://github.com/Qxii2027/NoWheel/releases/download/v1.0.0/nowheel-1.0.0.zip
unzip nowheel-1.0.0.zip
node nowheel/scripts/install.mjs --project .
```

Or clone and install:

```bash
git clone --depth 1 https://github.com/Qxii2027/NoWheel.git
node <repo>/scripts/install.mjs --project .
```

## 2. npx

`package.json` exposes the installer as a `bin`, so no publish is required to run it from a Git URL:

```bash
npx github:Qxii2027/NoWheel install --project .
```

After `npm publish --access public` (the package name may need your scope):

```bash
npx nowheel install --project .
```

`install.mjs` treats the installed npm package as its source folder, so `SKILL.md` and `scripts/` come from the same version.

## 3. npm package

```bash
npm publish --access public
```

The `files` field limits the tarball to the skill docs and `scripts/`. Requirements are Node >= 18 and no dependencies. Consumers can also `npm i -D` it and run `npx nowheel --project .`.

## 4. Claude Code plugin marketplace (optional)

The flat skill folder is **not** a plugin. To ship as a plugin, add a marketplace layout around it:

```text
repo/
  .claude-plugin/marketplace.json
  plugins/nowheel/
    .claude-plugin/plugin.json
    skills/nowheel/
      SKILL.md
      INSTALL.md
      HARNESSES.md
      scripts/
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "nowheel",
  "owner": { "name": "<your name>" },
  "plugins": [
    {
      "name": "nowheel",
      "source": "./plugins/nowheel",
      "description": "Pragmatic design and open-source workflow"
    }
  ]
}
```

`plugins/nowheel/.claude-plugin/plugin.json`:

```json
{
  "name": "nowheel",
  "version": "1.0.0",
  "description": "Ask before decisions, never hand-draw icons, reuse proven open source."
}
```

Consumers add the marketplace with `/plugin marketplace add Qxii2027/NoWheel` and install the plugin from it. Confirm the manifest fields against the current Claude Code plugin documentation before publishing; the rules in `SKILL.md` are unchanged by this packaging choice.

## 5. Vendoring and offline

Commit the installed copy so every teammate gets the same version with no setup:

```bash
node scripts/install.mjs --project . --rules auto
git add .agents .claude AGENTS.md .cursor .windsurf .clinerules .github
```

For air-gapped machines, run `node scripts/package.mjs`, copy the ZIP and its `.sha256`, verify the checksum, extract, and install locally. Nothing downloads at install time.

## Updating

Installed copies are compared by a hash of all managed files:

```bash
node scripts/install.mjs status --project .
node scripts/install.mjs --project . --force     # replace a different version
node scripts/install.mjs uninstall --project .
```

`skill.config.json` (the three feature switches) is preserved across updates and is local to each install.

## Versioning rules

- `package.json` `version` is the source of truth; release tags must be `v<version>`.
- The release workflow fails if the tag and `package.json` disagree.
- Hash comparison, not the version string, drives `install.mjs status`/updates.
