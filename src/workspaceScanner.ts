import * as vscode from "vscode";
import { parseCatalogEntries } from "./yamlParser";
import { parsePackageJsonEntries } from "./packageJsonParser";
import { isLookupableVersion } from "./npmRegistry";

// ── Types ──

export interface PackageUsage {
  version: string;
  fileUri: vscode.Uri;
  line: number;
}

export interface PackageInfo {
  catalogVersion?: string;
  catalogUri?: vscode.Uri;
  catalogLine?: number;
  usages: PackageUsage[];
}

export interface CatalogEntryLocation {
  version: string;
  uri: vscode.Uri;
  line: number;
}

// ── State ──

let versionMap = new Map<string, PackageInfo>();
/** catalogSection -> packageName -> location. "catalog" = default catalog. */
let catalogLookup = new Map<string, Map<string, CatalogEntryLocation>>();
let diagnosticCollection: vscode.DiagnosticCollection;
let scanInProgress = false;
let scanQueued = false;
let onScanComplete: (() => void) | undefined;

// ── Public API ──

export function initScanner(
  context: vscode.ExtensionContext,
  onComplete?: () => void,
) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "packageVersionUpgrade",
  );
  context.subscriptions.push(diagnosticCollection);
  onScanComplete = onComplete;
}

export function getPackageInfo(name: string): PackageInfo | undefined {
  return versionMap.get(name);
}

/**
 * Resolve a `catalog:` or `catalog:<name>` reference to the actual version.
 * Returns the version string and its location in the workspace config.
 */
export function resolveCatalogRef(
  packageName: string,
  catalogRef: string,
): CatalogEntryLocation | undefined {
  if (!catalogRef.startsWith("catalog:")) return undefined;
  const name = catalogRef.slice("catalog:".length).trim() || "catalog";
  return catalogLookup.get(name)?.get(packageName);
}

export async function scanWorkspace(): Promise<void> {
  if (scanInProgress) {
    scanQueued = true;
    return;
  }
  scanInProgress = true;
  try {
    await doScan();
    onScanComplete?.();
  } catch (err) {
    console.error("[dep-lens] scan failed:", err);
  } finally {
    scanInProgress = false;
    if (scanQueued) {
      scanQueued = false;
      scanWorkspace();
    }
  }
}

// ── Scan implementation ──

async function doScan() {
  const map = new Map<string, PackageInfo>();
  const lookup = new Map<string, Map<string, CatalogEntryLocation>>();

  // 1. Parse pnpm-workspace.yaml catalog(s)
  const yamlFiles = await vscode.workspace.findFiles(
    "pnpm-workspace.yaml",
    null,
    5,
  );
  for (const uri of yamlFiles) {
    const text = await readFile(uri);
    for (const entry of parseCatalogEntries(text)) {
      if (!isLookupableVersion(entry.version)) continue;
      const info = getOrCreate(map, entry.packageName);
      info.catalogVersion = entry.version;
      info.catalogUri = uri;
      info.catalogLine = entry.line;

      // Store in lookup for catalog: resolution
      const section = entry.section || "catalog";
      if (!lookup.has(section)) lookup.set(section, new Map());
      lookup.get(section)!.set(entry.packageName, {
        version: entry.version,
        uri,
        line: entry.line,
      });
    }
  }

  // 2. Parse all package.json files
  const jsonFiles = await vscode.workspace.findFiles(
    "**/package.json",
    "{**/node_modules/**,**/.next/**,**/dist/**,**/build/**,**/out/**}",
  );
  for (const uri of jsonFiles) {
    const text = await readFile(uri);
    for (const entry of parsePackageJsonEntries(text)) {
      // catalog: and workspace: are consistent by definition — skip
      if (
        entry.version.startsWith("catalog:") ||
        entry.version.startsWith("workspace:")
      )
        continue;
      if (!isLookupableVersion(entry.version)) continue;

      const info = getOrCreate(map, entry.packageName);
      info.usages.push({
        version: entry.version,
        fileUri: uri,
        line: entry.line,
      });
    }
  }

  versionMap = map;
  catalogLookup = lookup;
  updateDiagnostics();
}

// ── Diagnostics ──

function updateDiagnostics() {
  diagnosticCollection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();

  const allowed = new Set(
    vscode.workspace
      .getConfiguration("depLens")
      .get<string[]>("allowedMismatches", []),
  );

  for (const [name, info] of versionMap) {
    if (allowed.has(name)) continue;

    // Case 1: catalog exists — flag usages that differ
    if (info.catalogVersion) {
      for (const u of info.usages) {
        if (u.version === info.catalogVersion) continue;

        const diag = new vscode.Diagnostic(
          new vscode.Range(u.line, 0, u.line, 1000),
          `"${name}" is "${u.version}" here but catalog defines "${info.catalogVersion}"`,
          vscode.DiagnosticSeverity.Warning,
        );
        diag.source = "DepLens";
        diag.code = "catalog-mismatch";

        if (info.catalogUri !== undefined && info.catalogLine !== undefined) {
          diag.relatedInformation = [
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(
                info.catalogUri,
                new vscode.Range(
                  info.catalogLine,
                  0,
                  info.catalogLine,
                  1000,
                ),
              ),
              `Catalog defines "${info.catalogVersion}"`,
            ),
          ];
        }

        pushDiag(byFile, u.fileUri, diag);
      }
      continue; // catalog is source of truth — don't also check cross-workspace
    }

    // Case 2: no catalog — flag if multiple distinct versions in workspace
    if (info.usages.length < 2) continue;

    const groups = new Map<string, PackageUsage[]>();
    for (const u of info.usages) {
      const arr = groups.get(u.version) || [];
      arr.push(u);
      groups.set(u.version, arr);
    }
    if (groups.size < 2) continue;

    // Find the most common version
    let topVersion = "";
    let topCount = 0;
    for (const [v, arr] of groups) {
      if (arr.length > topCount) {
        topVersion = v;
        topCount = arr.length;
      }
    }

    // Flag minority usages
    for (const u of info.usages) {
      if (u.version === topVersion) continue;

      const others = [...groups.keys()].filter((v) => v !== u.version);
      const diag = new vscode.Diagnostic(
        new vscode.Range(u.line, 0, u.line, 1000),
        `"${name}" has ${groups.size} versions across workspace (also: ${others.join(", ")})`,
        vscode.DiagnosticSeverity.Hint,
      );
      diag.source = "DepLens";
      diag.code = "version-inconsistency";

      diag.relatedInformation = [];
      for (const [v, usages] of groups) {
        if (v === u.version) continue;
        for (const ref of usages.slice(0, 3)) {
          diag.relatedInformation.push(
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(
                ref.fileUri,
                new vscode.Range(ref.line, 0, ref.line, 1000),
              ),
              `Uses "${ref.version}"`,
            ),
          );
        }
      }

      pushDiag(byFile, u.fileUri, diag);
    }
  }

  for (const [key, diags] of byFile) {
    diagnosticCollection.set(vscode.Uri.parse(key), diags);
  }
}

// ── Helpers ──

function getOrCreate(
  map: Map<string, PackageInfo>,
  name: string,
): PackageInfo {
  let info = map.get(name);
  if (!info) {
    info = { usages: [] };
    map.set(name, info);
  }
  return info;
}

function pushDiag(
  map: Map<string, vscode.Diagnostic[]>,
  uri: vscode.Uri,
  diag: vscode.Diagnostic,
) {
  const key = uri.toString();
  const arr = map.get(key) || [];
  arr.push(diag);
  map.set(key, arr);
}

async function readFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}
