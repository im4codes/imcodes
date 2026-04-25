#!/usr/bin/env node
// Trim onnxruntime-node down to its CPU-only footprint before `npm pack`.
//
// Why: imcodes bundles `@huggingface/transformers` (and its onnxruntime-node
// dep) directly into the published tarball via `bundleDependencies`, so users
// in restricted networks don't hit the broken NuGet 302 redirect that
// onnxruntime's postinstall walks into. The full onnxruntime-node tree is
// ~513 MB — the GPU/DirectML/TensorRT extras alone account for ~382 MB and
// are useless for our CPU-only embedding pipeline (all-MiniLM-L6-v2 quant8
// runs entirely on CPU, see src/context/embedding.ts). Stripping them
// brings the bundle down to ~134 MB across all 5 supported platforms.
//
// What this does (idempotent):
//   1. Delete GPU-only native libs (CUDA, TensorRT, DirectML, dxcompiler, dxil)
//      from node_modules/onnxruntime-node/bin/.
//   2. Patch `script/install-metadata.js` so `linux/x64.requirements`, the
//      only platform that defaults to a NuGet fetch, becomes []. This keeps
//      `npm rebuild` safe: even if a downstream user triggers it, no network
//      hit will be attempted.
//   3. Replace onnxruntime-node's `scripts.install` with an echo so the
//      postinstall is a permanent no-op even when the install hook somehow
//      fires.
//
// Side effect for local dev: after `npm pack` runs the prepack hook, the
// repo's `node_modules/onnxruntime-node` is also stripped. CPU embedding
// still works fine (we never used the GPU EPs); restore via `npm ci` if you
// need a clean tree for any reason.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const onnxRoot = join(repoRoot, 'node_modules', 'onnxruntime-node');

if (!existsSync(onnxRoot)) {
  console.warn('[strip-onnxruntime-gpu] onnxruntime-node not installed — nothing to strip');
  process.exit(0);
}

/** Recursive byte-counter for `du`-style logging. */
async function dirSize(p) {
  let bytes = 0;
  const stack = [p];
  const { readdirSync } = await import('node:fs');
  while (stack.length) {
    const cur = stack.pop();
    const s = statSync(cur);
    if (s.isDirectory()) {
      for (const name of readdirSync(cur)) stack.push(join(cur, name));
    } else {
      bytes += s.size;
    }
  }
  return bytes;
}

/** Remove a single file if present, returning bytes freed. */
function tryRm(abs) {
  if (!existsSync(abs)) return 0;
  const size = statSync(abs).size;
  rmSync(abs);
  return size;
}

/** Remove a glob-matched set inside a directory (no glob lib — we hand-roll a
 *  prefix/suffix match against readdirSync to keep zero deps). */
async function rmMatch(dir, predicate) {
  if (!existsSync(dir)) return 0;
  const { readdirSync } = await import('node:fs');
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    if (!predicate(name)) continue;
    bytes += tryRm(join(dir, name));
  }
  return bytes;
}

// 0. Drop @huggingface/transformers/.cache. This directory is created at
//    runtime when the lib downloads model weights; if any developer ran the
//    daemon locally before publishing, the cache (e.g. ~130 MB of leftover
//    paraphrase-multilingual-MiniLM-L12-v2) sits inside node_modules and
//    would balloon the bundled tarball. End users will repopulate the cache
//    on first use under IMCODES_EMBEDDING_CACHE_DIR / OS-default.
const transformersCache = join(repoRoot, 'node_modules', '@huggingface', 'transformers', '.cache');
if (existsSync(transformersCache)) {
  // Stat-walk to print savings before nuking.
  let cacheBytes = 0;
  const stack = [transformersCache];
  while (stack.length) {
    const p = stack.pop();
    const s = statSync(p);
    if (s.isDirectory()) {
      const { readdirSync } = await import('node:fs');
      for (const name of readdirSync(p)) stack.push(join(p, name));
    } else {
      cacheBytes += s.size;
    }
  }
  rmSync(transformersCache, { recursive: true, force: true });
  console.log(`[strip-onnxruntime-gpu] removed transformers/.cache = ${(cacheBytes / 1024 / 1024).toFixed(1)} MB`);
}

// 1. Delete GPU/DirectML/TensorRT binaries we never load.
const gpuBinaries = [
  // linux/x64 — CUDA + TensorRT EPs (the 302-MB elephant)
  'bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so',
  'bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so',
  'bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so',
  // win32/x64 — DirectML stack
  'bin/napi-v6/win32/x64/DirectML.dll',
  'bin/napi-v6/win32/x64/dxcompiler.dll',
  'bin/napi-v6/win32/x64/dxil.dll',
  // win32/arm64 — DirectML stack
  'bin/napi-v6/win32/arm64/DirectML.dll',
  'bin/napi-v6/win32/arm64/dxcompiler.dll',
  'bin/napi-v6/win32/arm64/dxil.dll',
];

let removedBytes = 0;
let removedCount = 0;
for (const rel of gpuBinaries) {
  const abs = join(onnxRoot, rel);
  if (!existsSync(abs)) continue;
  const size = statSync(abs).size;
  rmSync(abs);
  removedBytes += size;
  removedCount += 1;
  console.log(`  - ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(`[strip-onnxruntime-gpu] removed ${removedCount} GPU files = ${(removedBytes / 1024 / 1024).toFixed(1)} MB`);

// 2. Patch install-metadata.js so linux/x64 no longer requests cuda12 from NuGet.
const metaPath = join(onnxRoot, 'script', 'install-metadata.js');
if (existsSync(metaPath)) {
  const before = readFileSync(metaPath, 'utf8');
  const after = before.replace(/'linux\/x64':\s*\['cuda12'\]/g, "'linux/x64': []");
  if (before !== after) {
    writeFileSync(metaPath, after);
    console.log("[strip-onnxruntime-gpu] patched install-metadata.js: linux/x64 -> []");
  } else {
    console.log("[strip-onnxruntime-gpu] install-metadata.js already patched (or upstream layout changed) — skipping");
  }
}

// 3. Neutralize onnxruntime-node's install lifecycle so any rebuild is a no-op.
const pkgPath = join(onnxRoot, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const noop = 'echo "imcodes: cpu-only bundle, install skipped"';
  if (pkg.scripts?.install && pkg.scripts.install !== noop) {
    pkg.scripts.install = noop;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[strip-onnxruntime-gpu] neutralized onnxruntime-node install script');
  }
}

// 4. Trim onnxruntime-web (transformers static-imports it for browser/wasm
//    backends; in our daemon we run via onnxruntime-node only). Drop the
//    multi-flavor .wasm payloads and source maps — keep the JS shells so
//    `import 'onnxruntime-web/webgpu'` still resolves. ~75 MB savings.
const ortWebDist = join(repoRoot, 'node_modules', 'onnxruntime-web', 'dist');
if (existsSync(ortWebDist)) {
  const before = await dirSize(ortWebDist);
  const wasmBytes = await rmMatch(ortWebDist, (name) => name.endsWith('.wasm'));
  const mapBytes = await rmMatch(ortWebDist, (name) => name.endsWith('.map'));
  // Also drop the unused build flavors that transformers never reaches —
  // it imports `onnxruntime-web/webgpu`, the others (`/all`, `/webgl`) are
  // alternative builds. The `.d.ts`, `.js`, `.mjs` for `webgpu` and the
  // top-level `ort.node.min.js` (the `main` entry) stay.
  const flavorBytes = await rmMatch(ortWebDist, (name) => (
    name.startsWith('ort.all.') || name.startsWith('ort.webgl.')
  ));
  const after = await dirSize(ortWebDist);
  const total = wasmBytes + mapBytes + flavorBytes;
  if (total > 0) {
    console.log(`[strip-onnxruntime-gpu] onnxruntime-web/dist: ${(before / 1024 / 1024).toFixed(1)} -> ${(after / 1024 / 1024).toFixed(1)} MB (saved ${(total / 1024 / 1024).toFixed(1)} MB)`);
  }
}

console.log('[strip-onnxruntime-gpu] done.');
