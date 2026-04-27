#!/usr/bin/env node
/**
 * Copy plain-JS worker bootstrap files from server/src/ into server/dist/.
 *
 * `tsc` only processes .ts files. Our worker bootstraps are intentionally
 * .mjs so they can be loaded by `new Worker()` without any TS loader —
 * but that means tsc ignores them, and the built `dist/` tree would be
 * missing the entry point the pool tries to spawn.
 *
 * Server tsconfig has `rootDir: ".."` so .ts outputs land under
 * `dist/server/src/...`. We mirror the same layout for .mjs files.
 *
 * Mirrors `scripts/copy-worker-bootstraps.mjs` at repo root which handles
 * the daemon side. Keep both in sync if the bootstrap pattern evolves.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, '..');
const srcRoot = join(serverRoot, 'src');
// Server's tsconfig uses rootDir="..", so outputs land under
// dist/server/src/... — match that layout when copying .mjs files.
const distSrcRoot = join(serverRoot, 'dist', 'server', 'src');

if (!existsSync(srcRoot)) {
  console.warn(`copy-worker-bootstraps: missing ${srcRoot}, skipping`);
  process.exit(0);
}
if (!existsSync(distSrcRoot)) {
  console.warn(`copy-worker-bootstraps: missing ${distSrcRoot}, skipping (run tsc first)`);
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
console.log(`copy-worker-bootstraps (server): copied ${copied} .mjs file(s) to ${distSrcRoot}`);
