import * as vscode from "vscode";
import * as path from "path";
import { parseCatalogEntries } from "./yamlParser";
import { parsePackageJsonEntries } from "./packageJsonParser";
import {
  fetchPackageData,
  isLookupableVersion,
  computeUpgrades,
  extractPrefix,
  getCachedData,
  clearCache,
} from "./npmRegistry";
import {
  initScanner,
  scanWorkspace,
  getPackageInfo,
  getUsageCount,
  getOtherUsageCount,
  isScanComplete,
  resolveCatalogRef,
  getLockedVersion,
  getCatalogLockedVersion,
} from "./workspaceScanner";
import { DependencyEntry, NpmPackageData } from "./types";

// ── Output channel for debugging ──

const log = vscode.window.createOutputChannel("DepLens");

// ── Decoration types ──

const majorDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#4FC1FF", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
  overviewRulerColor: "#4FC1FF",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const minorDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FFD700", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
  overviewRulerColor: "#FFD700",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const patchDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#89D185", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
  overviewRulerColor: "#89D185",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const prereleaseDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FF79C6", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
});

const loadingDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#888888", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
});

const errorDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FF6B6B", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
});

const mismatchDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FFA500", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
  overviewRulerColor: "#FFA500",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const catalogResolvedDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#7a9aaa", margin: "0 0 0 1em", fontWeight: "normal; font-size: 0.9em" },
});

const usageCountDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#666666", margin: "0 0 0 0.6em", fontWeight: "normal; font-size: 0.85em" },
});

const ALL_DEC_TYPES = [
  majorDecType,
  minorDecType,
  patchDecType,
  prereleaseDecType,
  loadingDecType,
  errorDecType,
  mismatchDecType,
  catalogResolvedDecType,
  usageCountDecType,
];

// ── State ──

let currentPaintVersion = 0;
let decorationsEnabled = true;
const fetchLimit = pLimit(15);

/** Cached paint state for lightweight repaint on selection change. */
let lastPaintState:
  | {
      editor: vscode.TextEditor;
      entries: DependencyEntry[];
      results: Map<string, NpmPackageData>;
      errors: Map<string, string>;
    }
  | undefined;

// ── File type detection ──

function isPnpmWorkspaceYaml(document: vscode.TextDocument): boolean {
  return path.basename(document.fileName) === "pnpm-workspace.yaml";
}

function isPackageJson(document: vscode.TextDocument): boolean {
  return path.basename(document.fileName) === "package.json";
}

function isSupportedFile(document: vscode.TextDocument): boolean {
  return isPnpmWorkspaceYaml(document) || isPackageJson(document);
}

/** Memoized parse — avoids re-parsing on every hover/code-action if document hasn't changed. */
let parseCache: { uri: string; version: number; entries: DependencyEntry[] } | undefined;

function parseEntries(document: vscode.TextDocument): DependencyEntry[] {
  const uri = document.uri.toString();
  const version = document.version;
  if (parseCache?.uri === uri && parseCache.version === version) {
    return parseCache.entries;
  }
  const text = document.getText();
  let entries: DependencyEntry[];
  if (isPnpmWorkspaceYaml(document)) entries = parseCatalogEntries(text);
  else if (isPackageJson(document)) entries = parsePackageJsonEntries(text);
  else entries = [];
  parseCache = { uri, version, entries };
  return entries;
}

// ── Helpers ──

function pLimit(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;

  function next() {
    while (queue.length > 0 && active < concurrency) {
      active++;
      const fn = queue.shift()!;
      fn();
    }
  }

  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as any;
}

function clearAllDecorations(editor: vscode.TextEditor) {
  for (const type of ALL_DEC_TYPES) {
    editor.setDecorations(type, []);
  }
}

function findVersionInLine(
  document: vscode.TextDocument,
  line: number,
  version: string,
): vscode.Range | undefined {
  if (line >= document.lineCount) return undefined;
  const text = document.lineAt(line).text;
  const idx = text.lastIndexOf(version);
  if (idx === -1) return undefined;
  return new vscode.Range(line, idx, line, idx + version.length);
}

// ── Decoration painting ──

function paintResults(
  editor: vscode.TextEditor,
  entries: DependencyEntry[],
  results: Map<string, NpmPackageData>,
  errors: Map<string, string>,
  cursorLine?: number,
) {
  // Cache state for lightweight repaint on selection change
  lastPaintState = { editor, entries, results, errors };

  const decorations = {
    major: [] as vscode.DecorationOptions[],
    minor: [] as vscode.DecorationOptions[],
    patch: [] as vscode.DecorationOptions[],
    prerelease: [] as vscode.DecorationOptions[],
    loading: [] as vscode.DecorationOptions[],
    error: [] as vscode.DecorationOptions[],
    mismatch: [] as vscode.DecorationOptions[],
    catalogResolved: [] as vscode.DecorationOptions[],
    usageCount: [] as vscode.DecorationOptions[],
  };

  const isJson = isPackageJson(editor.document);
  const currentFileUri = editor.document.uri.toString();
  const config = vscode.workspace.getConfiguration("depLens");
  const allowed = new Set(config.get<string[]>("allowedMismatches", []));
  const showUsage = config.get("showUsageCount", true);
  const showPre = config.get("showPrerelease", false);
  const scanDone = isScanComplete();

  for (const entry of entries) {
    if (entry.line >= editor.document.lineCount) continue;

    // Selection-aware: skip decorations on the cursor line
    if (cursorLine !== undefined && entry.line === cursorLine) continue;

    const lineLength = editor.document.lineAt(entry.line).text.length;
    const range = new vscode.Range(
      entry.line,
      lineLength,
      entry.line,
      lineLength,
    );

    // ── Feature 1: Resolve catalog: references in package.json ──
    if (isJson && entry.version.startsWith("catalog:")) {
      const resolved = resolveCatalogRef(entry.packageName, entry.version);
      if (resolved) {
        const catalogName = entry.version.slice("catalog:".length).trim();
        const label = catalogName ? ` (${catalogName})` : "";
        decorations.catalogResolved.push({
          range,
          renderOptions: {
            after: { contentText: `${resolved.version}${label}` },
          },
        });
      }
      // Also show usage count for catalog: refs
      if (showUsage && scanDone) {
        const otherCount = getOtherUsageCount(entry.packageName, currentFileUri);
        if (otherCount > 0) {
          decorations.usageCount.push({
            range,
            renderOptions: {
              after: {
                contentText: `+${otherCount} pkg${otherCount !== 1 ? "s" : ""}`,
              },
            },
          });
        }
      }
      continue;
    }

    if (!isLookupableVersion(entry.version)) continue;

    // Check for catalog mismatch (only in package.json files, skip allowed)
    const pkgInfo = isJson ? getPackageInfo(entry.packageName) : undefined;
    const catalogMismatch =
      pkgInfo?.catalogVersion &&
      entry.version !== pkgInfo.catalogVersion &&
      !allowed.has(entry.packageName);

    // Catalog mismatch takes priority for inline decoration
    if (catalogMismatch) {
      decorations.mismatch.push({
        range,
        renderOptions: {
          after: {
            contentText: `\u26A0 catalog: ${pkgInfo!.catalogVersion}`,
          },
        },
      });
      continue;
    }

    // Otherwise show upgrade / loading / error as before
    if (errors.has(entry.packageName)) {
      decorations.error.push({
        range,
        renderOptions: {
          after: { contentText: `\u2717 ${errors.get(entry.packageName)}` },
        },
      });
      continue;
    }

    const data = results.get(entry.packageName);
    if (!data) {
      decorations.loading.push({
        range,
        renderOptions: { after: { contentText: "loading..." } },
      });
      continue;
    }

    const upgrades = computeUpgrades(entry.version, data);

    // Build the prerelease suffix shown alongside stable upgrades
    const preSuffix =
      showPre && upgrades.latestPrerelease
        ? ` \u03B2 ${upgrades.latestPrerelease}`
        : "";

    // Usage count as separate neutral-colored decoration (after scan)
    if (showUsage && scanDone) {
      if (isJson) {
        const otherCount = getOtherUsageCount(entry.packageName, currentFileUri);
        if (otherCount > 0) {
          decorations.usageCount.push({
            range,
            renderOptions: {
              after: {
                contentText: `+${otherCount} pkg${otherCount !== 1 ? "s" : ""}`,
              },
            },
          });
        }
      } else {
        const count = getUsageCount(entry.packageName);
        decorations.usageCount.push({
          range,
          renderOptions: {
            after: {
              contentText: count === 0 ? "unused" : `${count} pkg${count !== 1 ? "s" : ""}`,
            },
          },
        });
      }
    }

    if (upgrades.major) {
      decorations.major.push({
        range,
        renderOptions: {
          after: { contentText: `${upgrades.major}${preSuffix}` },
        },
      });
    } else if (upgrades.minor) {
      decorations.minor.push({
        range,
        renderOptions: {
          after: { contentText: `${upgrades.minor}${preSuffix}` },
        },
      });
    } else if (upgrades.patch) {
      decorations.patch.push({
        range,
        renderOptions: {
          after: { contentText: `${upgrades.patch}${preSuffix}` },
        },
      });
    } else if (upgrades.prerelease) {
      decorations.prerelease.push({
        range,
        renderOptions: {
          after: { contentText: `${upgrades.prerelease}` },
        },
      });
    } else if (showPre && upgrades.latestPrerelease) {
      decorations.prerelease.push({
        range,
        renderOptions: {
          after: {
            contentText: `\u03B2 ${upgrades.latestPrerelease}`,
          },
        },
      });
    }
  }

  editor.setDecorations(majorDecType, decorations.major);
  editor.setDecorations(minorDecType, decorations.minor);
  editor.setDecorations(patchDecType, decorations.patch);
  editor.setDecorations(prereleaseDecType, decorations.prerelease);
  editor.setDecorations(loadingDecType, decorations.loading);
  editor.setDecorations(errorDecType, decorations.error);
  editor.setDecorations(mismatchDecType, decorations.mismatch);
  editor.setDecorations(catalogResolvedDecType, decorations.catalogResolved);
  editor.setDecorations(usageCountDecType, decorations.usageCount);
}

// ── Core update loop ──

async function updateDecorations(editor: vscode.TextEditor) {
  const fileName = path.basename(editor.document.fileName);
  log.appendLine(`[DepLens] updateDecorations: ${fileName} (lang=${editor.document.languageId}, supported=${isSupportedFile(editor.document)}, enabled=${decorationsEnabled})`);

  if (!decorationsEnabled || !isSupportedFile(editor.document)) {
    clearAllDecorations(editor);
    return;
  }

  const entries = parseEntries(editor.document);
  const lookupable = entries.filter((e) => isLookupableVersion(e.version));
  const hasCatalogRefs = entries.some((e) => e.version.startsWith("catalog:"));
  log.appendLine(`[DepLens]   entries=${entries.length}, lookupable=${lookupable.length}, catalogRefs=${hasCatalogRefs}`);

  if (lookupable.length === 0 && !hasCatalogRefs) {
    clearAllDecorations(editor);
    return;
  }

  const paintVersion = ++currentPaintVersion;
  const workspaceRoot =
    vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath ??
    path.dirname(editor.document.uri.fsPath);

  const results = new Map<string, NpmPackageData>();
  const errors = new Map<string, string>();

  // Immediately paint cached results + mismatch info
  for (const entry of lookupable) {
    const cached = getCachedData(entry.packageName);
    if (cached) results.set(entry.packageName, cached);
  }
  paintResults(editor, entries, results, errors);

  // Deduplicate and find uncached packages
  const seen = new Set<string>();
  const toFetch = lookupable.filter((e) => {
    if (results.has(e.packageName) || seen.has(e.packageName)) return false;
    seen.add(e.packageName);
    return true;
  });

  if (toFetch.length === 0) return;

  const promises = toFetch.map((entry) =>
    fetchLimit(async () => {
      try {
        const data = await fetchPackageData(entry.packageName, workspaceRoot);
        results.set(entry.packageName, data);
      } catch (err: any) {
        const msg = String(err?.message || "Failed").slice(0, 50);
        errors.set(entry.packageName, msg);
      }
    }),
  );

  // Progressive repaint
  const interval = setInterval(() => {
    if (
      paintVersion !== currentPaintVersion ||
      editor !== vscode.window.activeTextEditor
    ) {
      clearInterval(interval);
      return;
    }
    paintResults(editor, entries, results, errors);
  }, 500);

  await Promise.allSettled(promises);
  clearInterval(interval);

  if (
    paintVersion === currentPaintVersion &&
    editor === vscode.window.activeTextEditor
  ) {
    paintResults(editor, entries, results, errors);
  }
}

// ── Code Action Provider ──

class DependencyCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] | undefined {
    if (!isSupportedFile(document)) return;

    const line = range.start.line;
    const entries = parseEntries(document);

    const entry = entries.find((e) => e.line === line);
    if (!entry || !isLookupableVersion(entry.version)) return;

    const actions: vscode.CodeAction[] = [];
    const pkgInfo = getPackageInfo(entry.packageName);
    const allowed = new Set(
      vscode.workspace
        .getConfiguration("depLens")
        .get<string[]>("allowedMismatches", []),
    );
    const isMismatchAllowed = allowed.has(entry.packageName);

    // ── Mismatch actions (shown first — most immediately actionable) ──

    if (
      pkgInfo?.catalogVersion &&
      entry.version !== pkgInfo.catalogVersion &&
      !isMismatchAllowed
    ) {
      // Switch to catalog: protocol (preferred for pnpm workspaces)
      if (isPackageJson(document)) {
        const catalogAction = new vscode.CodeAction(
          `Switch to catalog: protocol`,
          vscode.CodeActionKind.QuickFix,
        );
        const edit = new vscode.WorkspaceEdit();
        const versionRange = findVersionInLine(
          document,
          entry.line,
          entry.version,
        );
        if (versionRange) {
          edit.replace(document.uri, versionRange, "catalog:");
        }
        catalogAction.edit = edit;
        catalogAction.isPreferred = true;
        actions.push(catalogAction);
      }

      // Align to catalog version
      const alignAction = new vscode.CodeAction(
        `Align to catalog version ${pkgInfo.catalogVersion}`,
        vscode.CodeActionKind.QuickFix,
      );
      const alignEdit = new vscode.WorkspaceEdit();
      const vr = findVersionInLine(document, entry.line, entry.version);
      if (vr) {
        alignEdit.replace(document.uri, vr, pkgInfo.catalogVersion);
      }
      alignAction.edit = alignEdit;
      actions.push(alignAction);
    }

    // ── Cross-workspace inconsistency action ──

    if (
      !pkgInfo?.catalogVersion &&
      !isMismatchAllowed &&
      pkgInfo &&
      pkgInfo.usages.length > 1
    ) {
      const versionCounts = new Map<string, number>();
      for (const u of pkgInfo.usages) {
        versionCounts.set(u.version, (versionCounts.get(u.version) || 0) + 1);
      }

      if (versionCounts.size > 1) {
        let topVersion = "";
        let topCount = 0;
        for (const [v, c] of versionCounts) {
          if (c > topCount) {
            topVersion = v;
            topCount = c;
          }
        }

        if (entry.version !== topVersion) {
          const action = new vscode.CodeAction(
            `Align to most common version ${topVersion} (${topCount} packages)`,
            vscode.CodeActionKind.QuickFix,
          );
          const edit = new vscode.WorkspaceEdit();
          const vr = findVersionInLine(document, entry.line, entry.version);
          if (vr) {
            edit.replace(document.uri, vr, topVersion);
          }
          action.edit = edit;
          actions.push(action);
        }
      }
    }

    // ── Allow mismatch (shared for both catalog and cross-workspace) ──
    if (actions.length > 0 && !isMismatchAllowed) {
      const hasMismatchAction = actions.some(
        (a) => a.kind?.contains(vscode.CodeActionKind.QuickFix) &&
          a.title.startsWith("Switch to") || a.title.startsWith("Align to"),
      );
      if (hasMismatchAction) {
        const allowAction = new vscode.CodeAction(
          `Allow version mismatch for "${entry.packageName}"`,
          vscode.CodeActionKind.QuickFix,
        );
        allowAction.command = {
          title: "Allow mismatch",
          command: "depLens.allowMismatch",
          arguments: [entry.packageName],
        };
        actions.push(allowAction);
      }
    }

    // ── Upgrade actions ──

    const cached = getCachedData(entry.packageName);
    if (cached) {
      const upgrades = computeUpgrades(entry.version, cached);
      const prefix = extractPrefix(entry.version);

      if (upgrades.patch) {
        actions.push(
          this.createUpgradeAction(
            document,
            entry,
            `${prefix}${upgrades.patch}`,
            "patch",
          ),
        );
      }
      if (upgrades.minor) {
        actions.push(
          this.createUpgradeAction(
            document,
            entry,
            `${prefix}${upgrades.minor}`,
            "minor",
          ),
        );
      }
      if (upgrades.major) {
        actions.push(
          this.createUpgradeAction(
            document,
            entry,
            `${prefix}${upgrades.major}`,
            "major",
          ),
        );
      }
      if (upgrades.prerelease) {
        actions.push(
          this.createUpgradeAction(
            document,
            entry,
            `${prefix}${upgrades.prerelease}`,
            "prerelease",
          ),
        );
      }
    }

    // ── Open on npm ──

    const npmAction = new vscode.CodeAction(
      `Open ${entry.packageName} on npm`,
      vscode.CodeActionKind.Empty,
    );
    npmAction.command = {
      title: "Open on npm",
      command: "depLens.openUrl",
      arguments: [`https://www.npmjs.com/package/${entry.packageName}`],
    };
    actions.push(npmAction);

    return actions;
  }

  private createUpgradeAction(
    document: vscode.TextDocument,
    entry: DependencyEntry,
    newVersion: string,
    level: string,
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Upgrade to ${newVersion} (${level})`,
      vscode.CodeActionKind.QuickFix,
    );
    const edit = new vscode.WorkspaceEdit();
    const versionRange = findVersionInLine(
      document,
      entry.line,
      entry.version,
    );
    if (versionRange) {
      edit.replace(document.uri, versionRange, newVersion);
    }
    action.edit = edit;
    return action;
  }
}

// ── Hover Provider (catalog usage info) ──

class DependencyHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (!isSupportedFile(document)) return;

    const entries = parseEntries(document);
    const entry = entries.find((e) => e.line === position.line);
    if (!entry) return;

    const info = getPackageInfo(entry.packageName);
    const isYaml = isPnpmWorkspaceYaml(document);
    const isJson = isPackageJson(document);
    const lines: string[] = [];
    const currentFileUri = document.uri.toString();

    // ── Usage info ──
    if (info && isScanComplete()) {
      if (isYaml) {
        // Catalog file: show full usage list
        const totalUsages = info.catalogUsages.length + info.usages.length;
        lines.push(
          `**${entry.packageName}** — ${totalUsages === 0 ? "unused in workspace" : `used in ${totalUsages} package${totalUsages !== 1 ? "s" : ""}`}`,
        );

        const catLocked = getCatalogLockedVersion(entry.packageName);
        if (catLocked) {
          lines.push(`\nLocked: \`${catLocked}\``);
        }

        lines.push("");

        for (const u of info.catalogUsages) {
          const rel = vscode.workspace.asRelativePath(u.fileUri);
          lines.push(`- \`${rel}\` — \`${u.ref}\``);
        }
        for (const u of info.usages) {
          const rel = vscode.workspace.asRelativePath(u.fileUri);
          const differs = info.catalogVersion && u.version !== info.catalogVersion;
          const badge = differs ? ' <span style="color:#ff6b6b;">⚠ differs</span>' : "";
          lines.push(`- \`${rel}\` — \`${u.version}\`${badge}`);
        }

        if (totalUsages === 0) {
          lines.push(
            "_No package.json in the workspace references this package._",
          );
        }
      } else if (isJson) {
        // package.json: show "also used by" (other packages, not this file)
        lines.push(`**${entry.packageName}**`);

        if (info.catalogVersion) {
          lines.push(`\nCatalog: \`${info.catalogVersion}\``);
        }

        const locked = getLockedVersion(document.uri, entry.packageName);
        if (locked) {
          lines.push(`Locked: \`${locked}\``);
        }

        const others = [
          ...info.catalogUsages.filter(
            (u) => u.fileUri.toString() !== currentFileUri,
          ),
          ...info.usages.filter(
            (u) => u.fileUri.toString() !== currentFileUri,
          ),
        ];

        if (others.length > 0) {
          lines.push("");
          lines.push(
            `**Also used by** (${others.length} other package${others.length !== 1 ? "s" : ""}):`,
          );
          for (const u of others) {
            const rel = vscode.workspace.asRelativePath(u.fileUri);
            let detail: string;
            if ("ref" in u) {
              detail = `\`${u.ref}\``;
            } else {
              const differs = info.catalogVersion && u.version !== info.catalogVersion;
              detail = `\`${u.version}\`${differs ? ' <span style="color:#ff6b6b;">⚠ differs</span>' : ""}`;
            }
            lines.push(`- \`${rel}\` — ${detail}`);
          }
        }
      }
    } else {
      lines.push(`**${entry.packageName}**`);
    }

    // ── Available upgrades (clickable) — only for direct versions, not catalog: refs ──
    const isCatalogRef = entry.version.startsWith("catalog:");
    const versionToCheck =
      !isCatalogRef && isLookupableVersion(entry.version)
        ? entry.version
        : undefined;

    if (versionToCheck) {
      const cached = getCachedData(entry.packageName);
      if (cached) {
        const upgrades = computeUpgrades(versionToCheck, cached);
        const prefix = extractPrefix(versionToCheck);
        const upgradeLines: string[] = [];

        const mkLink = (newVersion: string) => {
          const args = encodeURIComponent(
            JSON.stringify({
              uri: document.uri.toString(),
              line: entry.line,
              oldVersion: entry.version,
              newVersion,
            }),
          );
          return `[${newVersion}](command:depLens.upgradeVersion?${args} "Click to upgrade")`;
        };

        if (upgrades.patch) {
          upgradeLines.push(
            `- **patch** → ${mkLink(`${prefix}${upgrades.patch}`)}`,
          );
        }
        if (upgrades.minor) {
          upgradeLines.push(
            `- **minor** → ${mkLink(`${prefix}${upgrades.minor}`)}`,
          );
        }
        if (upgrades.major) {
          upgradeLines.push(
            `- **latest stable** → ${mkLink(`${prefix}${upgrades.major}`)}`,
          );
        }
        if (upgrades.latestPrerelease) {
          upgradeLines.push(
            `- **prerelease** → ${mkLink(`${prefix}${upgrades.latestPrerelease}`)}`,
          );
        }

        if (upgradeLines.length > 0) {
          lines.push("");
          lines.push("**Available upgrades:**");
          lines.push(...upgradeLines);
        }
      }
    }

    if (lines.length <= 1 && !info) return; // nothing useful to show

    const md = new vscode.MarkdownString(lines.join("\n"));
    md.isTrusted = true;
    md.supportHtml = true;
    return new vscode.Hover(md);
  }
}

// ── Definition Provider (Ctrl+Click on catalog: refs) ──

class CatalogDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | undefined {
    if (!isPackageJson(document)) return;

    const entries = parseEntries(document);
    const entry = entries.find((e) => e.line === position.line);
    if (!entry || !entry.version.startsWith("catalog:")) return;

    const resolved = resolveCatalogRef(entry.packageName, entry.version);
    if (!resolved) return;

    return new vscode.Location(
      resolved.uri,
      new vscode.Range(resolved.line, 0, resolved.line, 1000),
    );
  }
}

// ── Activation ──

export function activate(context: vscode.ExtensionContext) {
  log.appendLine("[DepLens] Extension activated");

  const config = vscode.workspace.getConfiguration("depLens");
  decorationsEnabled = config.get("showDecorations", true);

  // Dispose decoration types on deactivation
  context.subscriptions.push(...ALL_DEC_TYPES);

  // Initialize workspace scanner — repaint active editor when scan completes
  initScanner(context, () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && isSupportedFile(editor.document)) {
      updateDecorations(editor);
    }
  });

  // Kick off initial workspace scan (async, non-blocking)
  scanWorkspace();

  const debouncedUpdate = debounce((editor: vscode.TextEditor) => {
    updateDecorations(editor);
  }, 500);

  // Active editor change
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) debouncedUpdate(editor);
    }),
  );

  // Document change
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) {
        debouncedUpdate(editor);
      }
    }),
  );

  // Re-scan workspace when a relevant file is saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isPnpmWorkspaceYaml(document) || isPackageJson(document)) {
        scanWorkspace();
      }
    }),
  );

  // Config change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("depLens")) {
        decorationsEnabled = vscode.workspace
          .getConfiguration("depLens")
          .get("showDecorations", true);

        // Re-scan if the allowed list changed (clears/creates diagnostics)
        if (
          event.affectsConfiguration("depLens.allowedMismatches")
        ) {
          scanWorkspace();
        }

        const editor = vscode.window.activeTextEditor;
        if (editor) {
          if (decorationsEnabled) updateDecorations(editor);
          else clearAllDecorations(editor);
        }
      }
    }),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("depLens.toggle", () => {
      decorationsEnabled = !decorationsEnabled;
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        if (decorationsEnabled) updateDecorations(editor);
        else clearAllDecorations(editor);
      }
      vscode.window.setStatusBarMessage(
        `Version decorations: ${decorationsEnabled ? "ON" : "OFF"}`,
        3000,
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("depLens.refresh", () => {
      clearCache();
      scanWorkspace();
      const editor = vscode.window.activeTextEditor;
      if (editor) updateDecorations(editor);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "depLens.openUrl",
      (url: string) => {
        vscode.env.openExternal(vscode.Uri.parse(url));
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "depLens.allowMismatch",
      async (packageName: string) => {
        const config =
          vscode.workspace.getConfiguration("depLens");
        const current = config.get<string[]>("allowedMismatches", []);
        if (!current.includes(packageName)) {
          current.push(packageName);
          await config.update(
            "allowedMismatches",
            current,
            vscode.ConfigurationTarget.Workspace,
          );
        }
        // Config change listener handles re-scan + repaint
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "depLens.upgradeVersion",
      async (args: {
        uri: string;
        line: number;
        oldVersion: string;
        newVersion: string;
      }) => {
        const uri = vscode.Uri.parse(args.uri);
        const doc = await vscode.workspace.openTextDocument(uri);
        const range = findVersionInLine(doc, args.line, args.oldVersion);
        if (range) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, range, args.newVersion);
          await vscode.workspace.applyEdit(edit);
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "depLens.updateAll",
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSupportedFile(editor.document)) {
          vscode.window.showWarningMessage(
            "Open a package.json or pnpm-workspace.yaml file first",
          );
          return;
        }

        const level = await vscode.window.showQuickPick(
          [
            {
              label: "major",
              description:
                "Update to latest version (including major bumps)",
            },
            {
              label: "minor",
              description: "Update to latest within current major version",
            },
            {
              label: "patch",
              description:
                "Update to latest within current major.minor version",
            },
          ],
          { placeHolder: "Select upgrade level" },
        );
        if (!level) return;

        const entries = parseEntries(editor.document);
        const edit = new vscode.WorkspaceEdit();
        let count = 0;

        for (const entry of entries) {
          if (!isLookupableVersion(entry.version)) continue;

          const data = getCachedData(entry.packageName);
          if (!data) continue;

          const upgrades = computeUpgrades(entry.version, data);
          let target: string | undefined;

          if (level.label === "patch") {
            target = upgrades.patch;
          } else if (level.label === "minor") {
            target = upgrades.minor || upgrades.patch;
          } else {
            target = upgrades.major || upgrades.minor || upgrades.patch;
          }

          if (!target) continue;

          const prefix = extractPrefix(entry.version);
          const newVersion = `${prefix}${target}`;
          const range = findVersionInLine(
            editor.document,
            entry.line,
            entry.version,
          );
          if (range) {
            edit.replace(editor.document.uri, range, newVersion);
            count++;
          }
        }

        if (count > 0) {
          await vscode.workspace.applyEdit(edit);
          vscode.window.showInformationMessage(
            `Updated ${count} dependencies`,
          );
        } else {
          vscode.window.showInformationMessage(
            "All dependencies are up to date at the selected level",
          );
        }
      },
    ),
  );

  // Code action provider — both file types
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      [
        { scheme: "file", pattern: "**/package.json" },
        { scheme: "file", pattern: "**/pnpm-workspace.yaml" },
      ],
      new DependencyCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  // Hover provider — usage info + upgrades for both file types
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [
        { scheme: "file", pattern: "**/pnpm-workspace.yaml" },
        { scheme: "file", pattern: "**/package.json" },
      ],
      new DependencyHoverProvider(),
    ),
  );

  // Definition provider — Ctrl+Click on catalog: refs jumps to catalog
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { scheme: "file", pattern: "**/package.json" },
      new CatalogDefinitionProvider(),
    ),
  );

  // Selection-aware decoration hiding — repaint when cursor moves
  const debouncedSelectionRepaint = debounce(
    (e: vscode.TextEditorSelectionChangeEvent) => {
      const hideOnCursor = vscode.workspace
        .getConfiguration("depLens")
        .get("hideOnCursorLine", false);
      if (
        hideOnCursor &&
        lastPaintState &&
        lastPaintState.editor === e.textEditor &&
        isSupportedFile(e.textEditor.document)
      ) {
        paintResults(
          lastPaintState.editor,
          lastPaintState.entries,
          lastPaintState.results,
          lastPaintState.errors,
          e.selections[0]?.active.line,
        );
      }
    },
    50,
  );
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(debouncedSelectionRepaint),
  );

  // Initial update for the active editor
  const editor = vscode.window.activeTextEditor;
  if (editor && isSupportedFile(editor.document)) {
    updateDecorations(editor);
  }
}

export function deactivate() {
  clearCache();
  lastPaintState = undefined;
  parseCache = undefined;
  currentPaintVersion = 0;
}
