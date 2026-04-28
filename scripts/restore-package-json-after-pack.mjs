#!/usr/bin/env node
// postpack: restore the working-tree package.json after our prepack
// (`scripts/strip-onnxruntime-gpu.mjs`) neutralized its lifecycle scripts.
//
// Why this exists: end users running `npm i -g imcodes` get burned by a
// transitive sharp install hook that can `npm run build` upward into
// imcodes's `"build": "tsc"` and explode with exit 127. The prepack
// rewrites EVERY script to a no-op so the published tarball can't be
// hijacked that way. But the prepack edits the source tree in place,
// so without a restore step the local dev environment ends up with
// neutered scripts after every `npm pack` / `npm publish`.
//
// We restore via `git checkout -- package.json`. If we're not in a git
// repo (e.g. CI checked out as tarball), just warn and exit 0 — there's
// nothing to restore in that context anyway because the build pipeline
// re-clones for the next run.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const pkgPath = join(repoRoot, 'package.json');

if (!existsSync(pkgPath)) {
  console.warn('[restore-package-json-after-pack] package.json not found — nothing to restore');
  process.exit(0);
}

// Only attempt git restore if the repo root looks like a git working tree.
// `.git` is usually a directory, but for worktrees it's a file pointing
// at the real gitdir — accept either.
const gitMarker = join(repoRoot, '.git');
if (!existsSync(gitMarker)) {
  console.warn('[restore-package-json-after-pack] no .git found — skipping restore (CI tarball context?)');
  process.exit(0);
}

const result = spawnSync('git', ['-C', repoRoot, 'checkout', '--', 'package.json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'inherit', 'inherit'],
});

if (result.status !== 0) {
  // Don't fail the pack — we only ran prepack-then-pack-then-postpack
  // and the tarball is already produced. Log loudly so the operator can
  // restore manually.
  console.warn(`[restore-package-json-after-pack] git checkout returned ${result.status} — restore manually with: git checkout -- package.json`);
  process.exit(0);
}

console.log('[restore-package-json-after-pack] working-tree package.json restored');
// Sanity-log so a future maintainer following the trail can see the
// restore actually landed.
const stat = statSync(pkgPath);
console.log(`[restore-package-json-after-pack] package.json size: ${stat.size} bytes`);
