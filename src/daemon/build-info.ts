import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildManifest, DaemonBuildInfo } from '../../shared/build-manifest-types.js';

let cachedBuildInfo: DaemonBuildInfo | null | undefined;

export function getDaemonBuildInfo(): DaemonBuildInfo | null {
  if (cachedBuildInfo !== undefined) return cachedBuildInfo;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = join(here, '..', '..', '.build-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BuildManifest;
    cachedBuildInfo = {
      buildId: manifest.buildId,
      gitSha: manifest.gitSha,
      gitDirty: manifest.gitDirty,
      packageVersion: manifest.packageVersion,
      builtAt: manifest.builtAt,
    };
  } catch {
    cachedBuildInfo = null;
  }
  return cachedBuildInfo;
}
