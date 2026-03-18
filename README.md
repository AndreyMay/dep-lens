# DepLens — Monorepo Dependency Manager

A VS Code / Cursor extension built for **monorepos**. Shows inline version upgrades, resolves `catalog:` references, detects version drift across packages, and tracks which packages use each dependency.

## Why?

In a monorepo with dozens of packages, dependency versions silently drift apart. One package pins `react@^18`, another uses `^19`, a third ignores the catalog entirely. DepLens makes this visible at a glance — and fixable with a single click.

## Features

### Inline Version Upgrades

Color-coded decorations appear next to each dependency:

| Indicator | Meaning | Example |
|-----------|---------|---------|
| 🔵 `20.0.0` | Major update available | `react: "^19.0.0"` → `20.0.0` |
| 🟡 `19.3.0` | Minor update available | `react: "^19.0.0"` → `19.3.0` |
| 🟢 `19.0.1` | Patch update available | `react: "^19.0.0"` → `19.0.1` |
| 🩷 `5.0.0-beta.30` | Prerelease update (no stable available) | `next-auth: "5.0.0-beta.25"` → `5.0.0-beta.30` |
| 🩷 `β 20.0.0-canary.1` | Latest prerelease (`showPrerelease` on) | `react: "^19.0.0"` → `19.3.0 β 20.0.0-canary.1` |
| 🟠 `⚠ catalog: ^19.0.0` | Version differs from pnpm catalog | `react: "^18.2.0"` → `⚠ catalog: ^19.0.0` |
| ⚪ `^19.0.0` | Resolved `catalog:` reference | `react: "catalog:"` → `^19.0.0` |
| ⚫ `3 pkgs` | Package usage count (catalog yaml) | `react: "^19.0.0"` → `19.3.0 3 pkgs` |
| ⚫ `+2 pkgs` | Also used by N other packages (package.json) | `react: "catalog:"` → `^19.0.0 +2 pkgs` |
| ⚫ `unused` | No package.json references this entry | `old-lib: "^1.0.0"` → `unused` |

Works in both `package.json` and `pnpm-workspace.yaml` catalog entries.

### Hover Details

Hover any dependency line to see rich information:

**In `pnpm-workspace.yaml`:**
- **Which packages use it** — lists every `package.json` that references the dependency, showing whether it uses `catalog:` or a hardcoded version (with a ⚠ badge if it differs from the catalog)
- **Available upgrades** — patch, minor, latest stable, and prerelease versions, each as a **clickable link** that applies the upgrade directly

**In `package.json`:**
- **Catalog version** — shows what the catalog defines (if applicable)
- **Also used by** — lists other packages in the workspace that use the same dependency
- **Available upgrades** — clickable upgrade links (only for direct versions, not `catalog:` refs)

### pnpm Catalog Support

- **Resolves `catalog:` references** — shows the actual version inline in `package.json` when a dependency uses `catalog:` or `catalog:<name>`
- **Go to Definition** — `Ctrl+Click` / `Cmd+Click` on a `catalog:` reference jumps to the definition in `pnpm-workspace.yaml`
- **Named catalog labels** — named catalog references show the catalog name alongside the resolved version

### Cross-Package Version-Drift Detection

Scans every `package.json` in your workspace and flags inconsistencies:

- **Warning** — version differs from the `pnpm-workspace.yaml` catalog (source of truth)
- **Hint** — same package has different versions across workspace packages (no catalog defined)

Mismatches appear in the **Problems** panel with clickable links to the conflicting files.

### Quick Fixes (`Cmd+.` / `Ctrl+.`)

On any dependency line:

- **Switch to `catalog:` protocol** — replace a hardcoded version with `catalog:`
- **Align to catalog version** — match the catalog's version
- **Align to most common version** — for cross-workspace inconsistencies
- **Upgrade to X.Y.Z (patch/minor/major)** — bump the version
- **Allow version mismatch** — mark an intentional discrepancy (adds to workspace settings)
- **Open on npm** — view the package on npmjs.com

### Bulk Update

Command palette → `DepLens: Update All Dependencies` — upgrade every dependency in the current file with a level picker (major / minor / patch).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `depLens.showDecorations` | `true` | Show/hide inline version decorations |
| `depLens.showUsageCount` | `true` | Show how many workspace packages use each catalog dependency |
| `depLens.showPrerelease` | `false` | Show latest beta/canary/prerelease version alongside stable upgrades |
| `depLens.hideOnCursorLine` | `false` | Hide decorations when the cursor is on that line |
| `depLens.excludePaths` | *(see below)* | Glob patterns for paths to exclude when scanning package.json files |
| `depLens.allowedMismatches` | `[]` | Package names whose version mismatches are intentional |

Default `excludePaths`: `node_modules`, `.next`, `.open-next`, `.turbo`, `.vercel`, `.sst*`, `dist`, `build`, `out`, `.cache`, `coverage`

## Commands

| Command | Description |
|---------|-------------|
| `DepLens: Update All Dependencies` | Bulk upgrade all dependencies in the current file |
| `DepLens: Toggle Decorations` | Show/hide version decorations |
| `DepLens: Refresh Version Data` | Clear cache and re-fetch from npm |

## How It Works

- **npm registry** — fetches package metadata directly (respects `.npmrc` for custom registries and auth tokens)
- **Caching** — 2-hour in-memory cache, 15-concurrent request limit
- **Progressive loading** — cached results render instantly, uncached packages load in the background
- **Workspace scanning** — runs on activation and whenever a `package.json` or `pnpm-workspace.yaml` is saved
- **Excluded paths** — configurable via `depLens.excludePaths` (defaults exclude `node_modules`, `.next`, `.open-next`, `.turbo`, `.vercel`, `.sst*`, `dist`, `build`, `out`, `.cache`, `coverage`)

## Supported Formats

**pnpm-workspace.yaml:**
```yaml
catalog:
  react: ^19.0.0
  lodash: ^4.17.21

catalogs:
  react17:
    react: ^17.0.2
```

**package.json:**
```json
{
  "dependencies": {
    "react": "^19.0.0",
    "lodash": "catalog:"
  }
}
```

Skips non-npm versions (`github:`, `workspace:`, `file:`, `*`, etc.) automatically.

## License

MIT
