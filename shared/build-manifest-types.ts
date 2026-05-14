export const BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface BuildManifest {
  schemaVersion: typeof BUILD_MANIFEST_SCHEMA_VERSION;
  buildId: string;
  gitSha: string;
  gitDirty: boolean;
  gitBranch: string | null;
  builtAt: string;
  node: string;
  npmVersion: string;
  packageVersion: string;
  critical: Record<string, string>;
}

export interface DaemonBuildInfo {
  buildId: string;
  gitSha: string;
  gitDirty: boolean;
  packageVersion: string;
  builtAt: string;
}

export const CRITICAL_DIST_FILES = [
  'dist/src/index.js',
  'dist/src/daemon/command-handler.js',
  'dist/src/daemon/server-link.js',
  'dist/src/daemon/timeline-history-worker.js',
  'dist/src/daemon/timeline-history-sanitize.js',
  'dist/src/daemon/timeline-detail-store.js',
  'dist/src/daemon/fs-list-worker.js',
  'dist/src/daemon/fs-git-status-worker.js',
  'dist/src/daemon/fs-list-pool.js',
  'dist/src/daemon/fs-git-status-pool.js',
  'dist/src/daemon/latency-tracer.js',
] as const;
