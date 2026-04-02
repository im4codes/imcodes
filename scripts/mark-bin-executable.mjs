#!/usr/bin/env node

import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(scriptDir, '../dist/src/index.js');

if (!existsSync(binPath)) {
  console.warn(`mark-bin-executable: skipped, missing ${binPath}`);
  process.exit(0);
}

try {
  chmodSync(binPath, 0o755);
} catch (error) {
  console.warn(`mark-bin-executable: failed to chmod ${binPath}: ${error instanceof Error ? error.message : String(error)}`);
}
