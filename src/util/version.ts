import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageJson(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readVersion(): string {
  const embedded = process.env.IMCODES_BUILD_VERSION?.trim();
  if (embedded) return embedded;
  try {
    // Resolve from this module instead of process.cwd(). A globally installed
    // daemon is commonly launched from $HOME (or a service working directory),
    // which has no package.json and previously made the wire version 0.0.0.
    // Controlled-node SEA builds replace IMCODES_BUILD_VERSION at bundle time,
    // so they return above without evaluating import.meta.url in the CJS blob.
    const packageJsonPath = findPackageJson(dirname(fileURLToPath(import.meta.url)));
    if (!packageJsonPath) return '0.0.0';
    const raw = readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const DAEMON_VERSION = readVersion();
