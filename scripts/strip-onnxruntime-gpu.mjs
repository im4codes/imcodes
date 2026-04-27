#!/usr/bin/env node
// Trim onnxruntime-node down to its CPU-only footprint before `npm pack`.
//
// Why: imcodes bundles `@huggingface/transformers` (and its onnxruntime-node
// dep) directly into the published tarball via `bundleDependencies`, so users
// in restricted networks don't hit the broken NuGet 302 redirect that
// onnxruntime's postinstall walks into. The stripped tarball is also why
// the daemon ships with a working CPU embedding pipeline out of the box —
// no postinstall, no network hits, no surprises.
//
// What this does (idempotent):
//   1. Auto-detect the napi prebuild directory (`napi-v3` for 1.20.x,
//      `napi-v6` for 1.24.x). The strip is the same conceptually but the
//      file paths shifted between versions.
//   2. Delete *optional* GPU-only EP plugins that are NOT statically imported
//      by `onnxruntime.dll`:
//        - linux/x64: libonnxruntime_providers_cuda.so, libonnxruntime_providers_tensorrt.so
//        - win32/{x64,arm64}: dxcompiler.dll, dxil.dll
//      We DO NOT strip:
//        - DirectML.dll (statically imported by onnxruntime.dll's IAT — removing it
//          breaks load on machines where System32 directml.dll is absent or
//          ABI-incompatible. We've actually seen this break on Broadwell-EP.
//          Keeping the ~17 MB bundled copy is cheap insurance.)
//        - libonnxruntime_providers_shared.so (CPU EP infrastructure on Linux —
//          some configurations still link to it.)
//   3. Patch any install-metadata / install lifecycle so `npm rebuild` is a
//      permanent no-op even if a downstream user triggers it.
//   4. Trim `onnxruntime-web` (transformers static-imports it for browser/WASM
//      backends; in our daemon we run via onnxruntime-node only). Drop the
//      unused multi-flavor .wasm payloads + source maps.
//
// Why not strip DirectML.dll: when we tested removing the bundled copy on
// Windows the binding fell through to System32's directml.dll, hit a version
// mismatch on older boxes, and crashed at DllMain with ERR_DLOPEN_FAILED.
// 17 MB on five platforms is a fine price for guaranteed loadability.
//
// Side effect for local dev: after `npm pack` runs the prepack hook, the
// repo's `node_modules/onnxruntime-node` is also stripped. CPU embedding
// still works fine; restore via `rm -rf node_modules && npm install` if you
// need a clean tree for any reason.

import { existsSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
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
function dirSize(p) {
  let bytes = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    if (!existsSync(cur)) continue;
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

/** Remove glob-matched entries inside a directory. */
function rmMatch(dir, predicate) {
  if (!existsSync(dir)) return 0;
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
  const cacheBytes = dirSize(transformersCache);
  rmSync(transformersCache, { recursive: true, force: true });
  console.log(`[strip-onnxruntime-gpu] removed transformers/.cache = ${(cacheBytes / 1024 / 1024).toFixed(1)} MB`);
}

// 1. Auto-detect the napi prebuild directory. onnxruntime-node 1.20.x ships
//    `napi-v3`; 1.24.x ships `napi-v6`. Walk whatever is there.
const binRoot = join(onnxRoot, 'bin');
const napiDirs = existsSync(binRoot)
  ? readdirSync(binRoot).filter((name) => name.startsWith('napi-v'))
  : [];
if (napiDirs.length === 0) {
  console.warn('[strip-onnxruntime-gpu] no bin/napi-v* directory found — nothing to strip');
} else {
  console.log(`[strip-onnxruntime-gpu] napi prebuild dirs: ${napiDirs.join(', ')}`);
}

// 2. Strip GPU-only EP plugins. Only the files listed here are GUARANTEED
//    safe to remove without breaking onnxruntime.dll's import resolution.
//
//    DirectML.dll is intentionally NOT in this list — it's a static import
//    of onnxruntime.dll on Windows. Removing it forces fallthrough to
//    System32, which on older Windows boxes (e.g. Broadwell-EP servers) is
//    a different ABI and crashes at DllMain.
const STRIP_PATTERNS = [
  // Linux x64: CUDA + TensorRT EPs. These are loaded dynamically only when
  // the user explicitly registers them, so removal is safe for CPU-only.
  { platform: 'linux', arch: 'x64', files: [
    'libonnxruntime_providers_cuda.so',
    'libonnxruntime_providers_tensorrt.so',
  ]},
  // Windows x64/arm64: dxcompiler/dxil are DirectX shader compilers used
  // only when DirectML actually executes a graph. They're not in the IAT,
  // so removal won't block load — DirectML degrades gracefully.
  { platform: 'win32', arch: 'x64', files: ['dxcompiler.dll', 'dxil.dll'] },
  { platform: 'win32', arch: 'arm64', files: ['dxcompiler.dll', 'dxil.dll'] },
];

let removedBytes = 0;
let removedCount = 0;
for (const napi of napiDirs) {
  for (const { platform, arch, files } of STRIP_PATTERNS) {
    const dir = join(binRoot, napi, platform, arch);
    for (const file of files) {
      const abs = join(dir, file);
      if (!existsSync(abs)) continue;
      const size = statSync(abs).size;
      rmSync(abs);
      removedBytes += size;
      removedCount += 1;
      console.log(`  - ${join('bin', napi, platform, arch, file)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}
console.log(`[strip-onnxruntime-gpu] removed ${removedCount} GPU files = ${(removedBytes / 1024 / 1024).toFixed(1)} MB`);

// 3. Patch install-metadata.js (1.24+) so linux/x64 no longer requests cuda12
//    from NuGet. Older versions (1.20) don't have this file — that's fine.
const metaPath = join(onnxRoot, 'script', 'install-metadata.js');
if (existsSync(metaPath)) {
  const before = readFileSync(metaPath, 'utf8');
  const after = before.replace(/'linux\/x64':\s*\['cuda12'\]/g, "'linux/x64': []");
  if (before !== after) {
    writeFileSync(metaPath, after);
    console.log("[strip-onnxruntime-gpu] patched install-metadata.js: linux/x64 -> []");
  }
}

// 4. Neutralize onnxruntime-node's install lifecycle so any rebuild is a
//    no-op. Both `scripts.install` (1.24+) and `scripts.postinstall` (1.20)
//    must be killed.
const pkgPath = join(onnxRoot, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const noop = 'echo "imcodes: cpu-only bundle, install skipped"';
  let changed = false;
  if (pkg.scripts?.install && pkg.scripts.install !== noop) {
    pkg.scripts.install = noop;
    changed = true;
  }
  if (pkg.scripts?.postinstall && pkg.scripts.postinstall !== noop) {
    pkg.scripts.postinstall = noop;
    changed = true;
  }
  if (changed) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('[strip-onnxruntime-gpu] neutralized onnxruntime-node install/postinstall scripts');
  }
}

// 5. Trim onnxruntime-web (transformers static-imports it for browser/WASM
//    backends; in our daemon we run via onnxruntime-node only). Drop the
//    multi-flavor .wasm payloads and source maps — keep the JS shells so
//    `import 'onnxruntime-web/webgpu'` still resolves. ~75 MB savings.
const ortWebDist = join(repoRoot, 'node_modules', 'onnxruntime-web', 'dist');
if (existsSync(ortWebDist)) {
  const before = dirSize(ortWebDist);
  const wasmBytes = rmMatch(ortWebDist, (name) => name.endsWith('.wasm'));
  const mapBytes = rmMatch(ortWebDist, (name) => name.endsWith('.map'));
  // Drop the unused build flavors that transformers never reaches.
  const flavorBytes = rmMatch(ortWebDist, (name) => (
    name.startsWith('ort.all.') || name.startsWith('ort.webgl.')
  ));
  const after = dirSize(ortWebDist);
  const total = wasmBytes + mapBytes + flavorBytes;
  if (total > 0) {
    console.log(`[strip-onnxruntime-gpu] onnxruntime-web/dist: ${(before / 1024 / 1024).toFixed(1)} -> ${(after / 1024 / 1024).toFixed(1)} MB (saved ${(total / 1024 / 1024).toFixed(1)} MB)`);
  }
}

console.log('[strip-onnxruntime-gpu] done.');
