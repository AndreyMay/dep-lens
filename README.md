# DepLens

Inline version upgrades + monorepo version-drift detection for **package.json** and **pnpm-workspace.yaml** catalogs.

## Features

### Inline Version Upgrades

Color-coded decorations appear next to each dependency showing the latest available version:

- **Blue** — major update available
- **Yellow** — minor update available
- **Green** — patch update available
- **Pink** — prerelease update available

Works in both `package.json` and `pnpm-workspace.yaml` catalog entries.

### Monorepo Version-Drift Detection

Scans all `package.json` files across your workspace and flags inconsistencies:

- **Warning** (yellow squiggly) — version differs from the `pnpm-workspace.yaml` catalog (source of truth)
- **Hint** (subtle dots) — same package has different versions across workspace packages (no catalog defined)

Mismatches appear in the **Problems** panel with clickable links to the conflicting files.

### Code Actions (Ctrl+. / Cmd+.)

On any dependency line:

- **Switch to `catalog:` protocol** — replace a hardcoded version with `catalog:`
- **Align to catalog version** — match the catalog's version
- **Align to most common version** — for cross-workspace inconsistencies
- **Upgrade to X.Y.Z (patch/minor/major)** — bump the version
- **Allow version mismatch** — mark an intentional discrepancy (adds to workspace settings)
- **Open on npm** — view the package on npmjs.com

### Update All

Command palette → `DepLens: Update All Dependencies` — bulk upgrade with a level picker (major / minor / patch).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `depLens.showDecorations` | `true` | Show/hide inline version decorations |
| `depLens.allowedMismatches` | `[]` | Package names whose version mismatches are intentional |

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

Skips non-npm versions (`github:`, `workspace:`, `catalog:`, `file:`, `*`, etc.) automatically.

## License

MIT
