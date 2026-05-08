#!/usr/bin/env node

import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// Anything declared in `package.json#bin` must be +x or `npm install -g`
// silently creates an unusable symlink (no error, just EACCES at exec
// time). Keep this list in lockstep with package.json#bin.
const targets = [
  '../dist/src/index.js',
  '../bin/imcodes-launch.sh',
  '../dist/src/util/windows-launch-preflight.mjs',
  '../dist/src/util/preinstall-cleanup.mjs',
];

for (const rel of targets) {
  const binPath = resolve(scriptDir, rel);
  if (!existsSync(binPath)) {
    console.warn(`mark-bin-executable: skipped, missing ${binPath}`);
    continue;
  }
  try {
    chmodSync(binPath, 0o755);
  } catch (error) {
    console.warn(`mark-bin-executable: failed to chmod ${binPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
