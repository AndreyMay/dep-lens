import * as semver from "semver";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NpmPackageData, CacheEntry, UpgradeInfo } from "./types";

const CACHE_TTL_MS = 120 * 60 * 1000; // 2 hours
const cache = new Map<string, CacheEntry>();

// ── .npmrc config ──

interface NpmrcConfig {
  defaultRegistry: string;
  scopedRegistries: Map<string, string>;
  authTokens: Map<string, string>;
}

let npmrcConfig: NpmrcConfig | undefined;

function getNpmrcConfig(workspaceRoot?: string): NpmrcConfig {
  if (npmrcConfig) return npmrcConfig;

  const config: NpmrcConfig = {
    defaultRegistry: "https://registry.npmjs.org",
    scopedRegistries: new Map(),
    authTokens: new Map(),
  };

  const paths = [path.join(os.homedir(), ".npmrc")];
  if (workspaceRoot) {
    paths.push(path.join(workspaceRoot, ".npmrc"));
  }

  for (const p of paths) {
    try {
      const content = fs.readFileSync(p, "utf8");
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;

        const eqIdx = line.indexOf("=");
        if (eqIdx === -1) continue;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();

        if (key === "registry") {
          config.defaultRegistry = value.replace(/\/$/, "");
        } else if (/^@[\w\-_.]+:registry$/.test(key)) {
          const scope = key.split(":registry")[0];
          config.scopedRegistries.set(scope, value.replace(/\/$/, ""));
        } else if (/^\/\/.*\/:_authToken$/.test(key)) {
          const host = key.replace(/^\/\//, "").replace(/\/:_authToken$/, "");
          config.authTokens.set(host, value);
        }
      }
    } catch {
      // File not found, skip
    }
  }

  npmrcConfig = config;
  return config;
}

function getRegistryForPackage(
  packageName: string,
  config: NpmrcConfig,
): { registry: string; authToken?: string } {
  let registry = config.defaultRegistry;

  if (packageName.startsWith("@")) {
    const scope = packageName.split("/")[0];
    const scopedRegistry = config.scopedRegistries.get(scope);
    if (scopedRegistry) registry = scopedRegistry;
  }

  const registryHost = registry
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const authToken = config.authTokens.get(registryHost);

  return { registry, authToken };
}

function encodePackageName(name: string): string {
  if (name.startsWith("@")) {
    return "@" + encodeURIComponent(name.slice(1));
  }
  return encodeURIComponent(name);
}

// ── Public API ──

export function isLookupableVersion(version: string): boolean {
  if (!version || version === "*" || version === "latest") return false;
  if (
    /^(github:|git\+|git:\/\/|https?:\/\/|file:|link:|workspace:|catalog:|npm:)/.test(
      version,
    )
  )
    return false;
  return semver.coerce(version) !== null;
}

export async function fetchPackageData(
  packageName: string,
  workspaceRoot?: string,
): Promise<NpmPackageData> {
  const cached = cache.get(packageName);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const config = getNpmrcConfig(workspaceRoot);
  const { registry, authToken } = getRegistryForPackage(packageName, config);
  const url = `${registry}/${encodePackageName(packageName)}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.npm.install-v1+json", // abbreviated metadata
  };
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as NpmPackageData;
    cache.set(packageName, { data, fetchedAt: Date.now() });
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function getCachedData(
  packageName: string,
): NpmPackageData | undefined {
  return cache.get(packageName)?.data;
}

export function clearCache() {
  cache.clear();
  npmrcConfig = undefined;
}

// ── Version comparison ──

function parseCurrentVersion(versionStr: string): semver.SemVer | null {
  // Strip range prefix (~, ^, >=, etc.)
  const stripped = versionStr.replace(/^[~^>=<]+\s*/, "");
  // Try exact parse first (preserves prerelease tags)
  const exact = semver.parse(stripped);
  if (exact) return exact;
  // Fall back to coerce for shorthand like "22" or malformed strings
  return semver.coerce(stripped);
}

export function computeUpgrades(
  currentRange: string,
  npmData: NpmPackageData,
): UpgradeInfo {
  const current = parseCurrentVersion(currentRange);
  if (!current) return {};

  const allVersions = Object.keys(npmData.versions || {})
    .map((v) => semver.parse(v))
    .filter(
      (v): v is semver.SemVer =>
        v !== null && v.prerelease.length === 0 && semver.gt(v, current),
    )
    .sort(semver.rcompare);

  const result: UpgradeInfo = {};

  for (const v of allVersions) {
    if (v.major !== current.major && !result.major) {
      result.major = v.format();
    } else if (
      v.major === current.major &&
      v.minor !== current.minor &&
      !result.minor
    ) {
      result.minor = v.format();
    } else if (
      v.major === current.major &&
      v.minor === current.minor &&
      !result.patch
    ) {
      result.patch = v.format();
    }
    if (result.major && result.minor && result.patch) break;
  }

  // For prerelease current versions: also check for newer prereleases
  if (
    current.prerelease.length > 0 &&
    !result.major &&
    !result.minor &&
    !result.patch
  ) {
    const prereleaseVersions = Object.keys(npmData.versions || {})
      .map((v) => semver.parse(v))
      .filter(
        (v): v is semver.SemVer => v !== null && semver.gt(v, current),
      )
      .sort(semver.rcompare);

    if (prereleaseVersions.length > 0) {
      const latest = prereleaseVersions[0];
      if (latest.prerelease.length > 0) {
        result.prerelease = latest.format();
      } else {
        // It's a stable release newer than our prerelease
        if (latest.major !== current.major) result.major = latest.format();
        else if (latest.minor !== current.minor)
          result.minor = latest.format();
        else result.patch = latest.format();
      }
    }
  }

  return result;
}

export function extractPrefix(versionRange: string): string {
  const match = versionRange.match(/^([~^>=<]*)/);
  return match ? match[1] : "";
}
