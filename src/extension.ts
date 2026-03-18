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
} from "./workspaceScanner";
import { DependencyEntry, NpmPackageData } from "./types";

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

const ALL_DEC_TYPES = [
  majorDecType,
  minorDecType,
  patchDecType,
  prereleaseDecType,
  loadingDecType,
  errorDecType,
  mismatchDecType,
];

// ── State ──

let currentPaintVersion = 0;
let decorationsEnabled = true;

// ── File type detection ──

function isPnpmWorkspaceYaml(document: vscode.TextDocument): boolean {
  return (
    document.languageId === "yaml" &&
    path.basename(document.fileName) === "pnpm-workspace.yaml"
  );
}

function isPackageJson(document: vscode.TextDocument): boolean {
  return (
    (document.languageId === "json" || document.languageId === "jsonc") &&
    path.basename(document.fileName) === "package.json"
  );
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
) {
  const decorations = {
    major: [] as vscode.DecorationOptions[],
    minor: [] as vscode.DecorationOptions[],
    patch: [] as vscode.DecorationOptions[],
    prerelease: [] as vscode.DecorationOptions[],
    loading: [] as vscode.DecorationOptions[],
    error: [] as vscode.DecorationOptions[],
    mismatch: [] as vscode.DecorationOptions[],
  };

  const isJson = isPackageJson(editor.document);
  const allowed = new Set(
    vscode.workspace
      .getConfiguration("depLens")
      .get<string[]>("allowedMismatches", []),
  );

  for (const entry of entries) {
    if (!isLookupableVersion(entry.version)) continue;
    if (entry.line >= editor.document.lineCount) continue;

    const lineLength = editor.document.lineAt(entry.line).text.length;
    const range = new vscode.Range(
      entry.line,
      lineLength,
      entry.line,
      lineLength,
    );

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

    if (upgrades.major) {
      decorations.major.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.major}` },
        },
      });
    } else if (upgrades.minor) {
      decorations.minor.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.minor}` },
        },
      });
    } else if (upgrades.patch) {
      decorations.patch.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.patch}` },
        },
      });
    } else if (upgrades.prerelease) {
      decorations.prerelease.push({
        range,
        renderOptions: {
          after: { contentText: `  \u2191 ${upgrades.prerelease}` },
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
}

// ── Core update loop ──

async function updateDecorations(editor: vscode.TextEditor) {
  if (!decorationsEnabled || !isSupportedFile(editor.document)) {
    clearAllDecorations(editor);
    return;
  }

  const entries = parseEntries(editor.document);
  const lookupable = entries.filter((e) => isLookupableVersion(e.version));

  if (lookupable.length === 0) {
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

// ── Activation ──

export function activate(context: vscode.ExtensionContext) {
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

  // Initial update for the active editor
  const editor = vscode.window.activeTextEditor;
  if (editor && isSupportedFile(editor.document)) {
    updateDecorations(editor);
  }
}

export function deactivate() {
  clearCache();
}
