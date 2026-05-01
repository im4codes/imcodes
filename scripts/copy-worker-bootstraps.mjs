#!/usr/bin/env node
/**
 * Copy plain-JS worker bootstrap files from src/ into dist/src/.
 *
 * `tsc` only processes .ts files (and .js when allowJs is on). Our worker
 * bootstraps are intentionally .mjs so they can be loaded by `new Worker()`
 * without any TS loader — but that means tsc ignores them, and the built
 * `dist/` tree would be missing the entry point the pool tries to spawn.
 *
 * This script copies every `src/**\/*.mjs` into the matching path under
 * `dist/src/`, preserving directory structure.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const srcRoot = join(repoRoot, 'src');
const distSrcRoot = join(repoRoot, 'dist', 'src');

if (!existsSync(srcRoot)) {
  console.warn(`copy-worker-bootstraps: missing src/ at ${srcRoot}, skipping`);
  process.exit(0);
}
if (!existsSync(distSrcRoot)) {
  console.warn(`copy-worker-bootstraps: missing dist/src/ at ${distSrcRoot}, skipping (run tsc first)`);
  process.exit(0);
}

let copied = 0;

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith('.mjs')) continue;
    const rel = full.slice(srcRoot.length + 1);
    const target = join(distSrcRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(full, target);
    copied++;
  }
}

walk(srcRoot);
console.log(`copy-worker-bootstraps: copied ${copied} .mjs file(s) to dist/src/`);
