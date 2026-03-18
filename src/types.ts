export interface DependencyEntry {
  packageName: string;
  version: string;
  line: number;
  /** e.g. "catalog" / "react17" for yaml, "dependencies" / "devDependencies" for package.json */
  section?: string;
}

export interface UpgradeInfo {
  major?: string;
  minor?: string;
  patch?: string;
  prerelease?: string;
  /** Latest prerelease/beta/canary version (shown alongside stable when enabled) */
  latestPrerelease?: string;
}

export interface NpmPackageData {
  "dist-tags": Record<string, string>;
  versions: Record<string, unknown>;
  homepage?: string;
  repository?: { url: string } | string;
}

export interface CacheEntry {
  data: NpmPackageData;
  fetchedAt: number;
}
