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
  resolveCatalogRef,
} from "./workspaceScanner";
import { DependencyEntry, NpmPackageData } from "./types";

// ── Output channel for debugging ──

const log = vscode.window.createOutputChannel("DepLens");

// ── Decoration types ──

const majorDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#4FC1FF", fontStyle: "italic" },
  overviewRulerColor: "#4FC1FF",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const minorDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FFD700", fontStyle: "italic" },
  overviewRulerColor: "#FFD700",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const patchDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#89D185", fontStyle: "italic" },
  overviewRulerColor: "#89D185",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const prereleaseDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FF79C6", fontStyle: "italic" },
});

const loadingDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#888888", fontStyle: "italic" },
});

const errorDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FF6B6B", fontStyle: "italic" },
});

const mismatchDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#FFA500", fontStyle: "italic" },
  overviewRulerColor: "#FFA500",
  overviewRulerLane: vscode.OverviewRulerLane.Right,
});

const catalogResolvedDecType = vscode.window.createTextEditorDecorationType({
  after: { color: "#7a9aaa", fontStyle: "italic" },
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
];

// ── State ──

let currentPaintVersion = 0;
let decorationsEnabled = true;

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

function parseEntries(document: vscode.TextDocument): DependencyEntry[] {
  const text = document.getText();
  if (isPnpmWorkspaceYaml(document)) return parseCatalogEntries(text);
  if (isPackageJson(document)) return parsePackageJsonEntries(text);
  return [];
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
  };

  const isJson = isPackageJson(editor.document);
  const allowed = new Set(
    vscode.workspace
      .getConfiguration("depLens")
      .get<string[]>("allowedMismatches", []),
  );

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
            after: { contentText: `  ${resolved.version}${label}` },
          },
        });
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
            contentText: `  \u26A0 catalog: ${pkgInfo!.catalogVersion}`,
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
          after: { contentText: `  \u2717 ${errors.get(entry.packageName)}` },
        },
      });
      continue;
    }

    const data = results.get(entry.packageName);
    if (!data) {
      decorations.loading.push({
        range,
        renderOptions: { after: { contentText: "  loading..." } },
      });
      continue;
    }

    const upgrades = computeUpgrades(entry.version, data);
    const showPre = vscode.workspace
      .getConfiguration("depLens")
      .get("showPrerelease", false);

    // Build the prerelease suffix shown alongside stable upgrades
    const preSuffix =
      showPre && upgrades.latestPrerelease
        ? `  \u03B2 ${upgrades.latestPrerelease}`
        : "";

    if (upgrades.major) {
      decorations.major.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.major}${preSuffix}` },
        },
      });
    } else if (upgrades.minor) {
      decorations.minor.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.minor}${preSuffix}` },
        },
      });
    } else if (upgrades.patch) {
      decorations.patch.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.patch}${preSuffix}` },
        },
      });
    } else if (upgrades.prerelease) {
      // No stable upgrade — show prerelease as the primary hint
      decorations.prerelease.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.prerelease}` },
        },
      });
    } else if (showPre && upgrades.latestPrerelease) {
      // Up to date on stable, but a prerelease exists
      decorations.prerelease.push({
        range,
        renderOptions: {
          after: {
            contentText: `  \u03B2 ${upgrades.latestPrerelease}`,
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
  const workspaceRoot = path.dirname(editor.document.uri.fsPath);

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

  const limit = pLimit(15);
  const promises = toFetch.map((entry) =>
    limit(async () => {
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

      // Allow this mismatch
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

          // Allow this mismatch
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
}
