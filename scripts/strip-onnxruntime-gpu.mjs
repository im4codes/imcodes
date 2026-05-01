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

// 6. Strip `sharp` wrapper + `@img/*` from the bundle so npm re-resolves
//    the entire sharp dependency tree on the user's actual platform at
//    install time. The previous fix (strip only `@img/sharp-*` binaries
//    but keep `sharp` wrapper) didn't go far enough:
//
//      a) macOS user runs `npm i -g imcodes`
//      b) npm extracts the bundle → `node_modules/sharp/` is present
//         (via @huggingface/transformers's bundleDependencies chain)
//      c) npm sees sharp's `optionalDependencies` listing all platform
//         variants (@img/sharp-darwin-arm64, …, @img/sharp-linux-x64)
//      d) **Because sharp itself is already bundled**, npm treats the
//         dep as resolved and DOES NOT walk its optionalDependencies
//         to fetch the correct platform binary. The user is left with
//         only @img/colour (kept as it's a non-platform regular dep).
//      e) `require('sharp')` at runtime: "Could not load the sharp
//         module using the darwin-arm64 runtime" → triggers the
//         sticky-disable in src/util/embeddings.ts → semantic memory
//         recall is permanently disabled for the daemon process.
//      f) User: "怎么完全搜不到相关记忆了"
//
//    The minimal fix is to strip BOTH the platform-specific binaries
//    AND the sharp wrapper itself from the bundle. npm at install time
//    sees sharp listed in transformers's regular `dependencies`, fetches
//    sharp from the registry on the user's actual platform, and that
//    install correctly walks sharp's optionalDependencies to grab the
//    matching @img/sharp-<platform>-<arch> binary.
//
//    Same family of bug as the fsevents one (a04ef030); both come from
//    "transitive optional native dep got hard-bundled by CI's platform
//    and rejected on the user's platform". Stripping the parent wrapper
//    is the load-bearing fix — without it, optionalDependencies
//    re-resolution doesn't kick in.
const imgRoot = join(repoRoot, 'node_modules', '@img');
if (existsSync(imgRoot)) {
  let imgRemovedCount = 0;
  let imgRemovedBytes = 0;
  for (const name of readdirSync(imgRoot)) {
    // Strip every @img package — colour is a regular dep of sharp, so
    // letting npm re-resolve sharp will also re-fetch colour for us.
    // Keeping colour while removing sharp/@img-binary leaves an
    // inconsistent tree where npm sees colour bundled but sharp re-
    // resolved → npm may complain about the version skew.
    const abs = join(imgRoot, name);
    const bytes = dirSize(abs);
    rmSync(abs, { recursive: true, force: true });
    imgRemovedBytes += bytes;
    imgRemovedCount += 1;
    console.log(`  - node_modules/@img/${name} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  if (imgRemovedCount > 0) {
    console.log(`[strip-onnxruntime-gpu] removed ${imgRemovedCount} @img/* dirs = ${(imgRemovedBytes / 1024 / 1024).toFixed(1)} MB`);
  }
  // Also walk transformers' nested node_modules in case any @img got hoisted
  // there instead of the top-level. Defensive — we've not seen this
  // structure in our published tarballs but bundleDependencies behavior can
  // vary across npm versions.
  const transformersImgRoot = join(repoRoot, 'node_modules', '@huggingface', 'transformers', 'node_modules', '@img');
  if (existsSync(transformersImgRoot)) {
    for (const name of readdirSync(transformersImgRoot)) {
      const abs = join(transformersImgRoot, name);
      const bytes = dirSize(abs);
      rmSync(abs, { recursive: true, force: true });
      console.log(`  - (nested) ${join('node_modules/@huggingface/transformers/node_modules/@img', name)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
    }
  }
}

// Strip the `sharp` wrapper itself so npm re-resolves it (and via its
// optionalDependencies, the correct platform binary) at install time.
// Check both top-level AND nested under transformers in case
// bundleDependencies hoisting differs across npm versions.
for (const sharpRoot of [
  join(repoRoot, 'node_modules', 'sharp'),
  join(repoRoot, 'node_modules', '@huggingface', 'transformers', 'node_modules', 'sharp'),
]) {
  if (!existsSync(sharpRoot)) continue;
  const bytes = dirSize(sharpRoot);
  rmSync(sharpRoot, { recursive: true, force: true });
  const rel = sharpRoot.startsWith(repoRoot) ? sharpRoot.slice(repoRoot.length + 1) : sharpRoot;
  console.log(`[strip-onnxruntime-gpu] removed ${rel} (${(bytes / 1024 / 1024).toFixed(1)} MB) — npm will re-resolve at install`);
}

// 7. Rewrite imcodes's own lifecycle scripts in the to-be-published
//    package.json:
//      - EVERY script except `postinstall` becomes a no-op echo.
//      - `postinstall` is force-set to invoke our bundled sharp self-heal
//        (`dist/src/util/postinstall-sharp-repair.js`).
//
// Real-world failure on big@172.16.253.213 (npm 11.12.1, node v24.15.0,
// fresh `npm i -g imcodes@dev`):
//
//   1. npm extracts imcodes from the registry. Bundle correctly omits
//      `node_modules/sharp/` (we strip it above), so npm re-resolves
//      `sharp` and fetches it fresh.
//   2. npm 11 + global install + nested deps half-extracts sharp under
//      `imcodes/node_modules/sharp/` — the `install/` subdir is missing
//      (the same documented npm bug we work around in command-handler.ts).
//   3. sharp's lifecycle install is `node install/check.js || npm run build`.
//      With install/check.js missing, the fallback runs `npm run build`.
//   4. `npm run build` walks UP looking for the script and finds imcodes's
//      `"build": "tsc"`. tsc isn't on the install-context PATH so it
//      exits 127 → the entire `npm i -g imcodes` aborts.
//   5. Even if (4) is dodged, sharp's transitive deps (detect-libc,
//      semver, @img/colour) frequently land as empty placeholder dirs
//      under the same npm-global bug → daemon crashes on first
//      `@huggingface/transformers` import → semantic search permanently
//      sticky-disabled until the user knows to run a manual repair.
//
// The daemon's auto-upgrade dodges (3-4) with `--ignore-scripts` and
// runs an inline bash repair for (5). Human `npm i -g imcodes@dev` users
// get neither protection without this prepack rewrite.
//
// Two-prong fix:
//
//   (a) Neutralize build/dev/test/etc. so sharp's `|| npm run build`
//       fallback can't hijack tsc. Required because we still need to
//       allow ANY lifecycle script through (sharp's fallback resolves
//       upward by name regardless of which lifecycle is currently
//       executing), so we can't just delete scripts wholesale.
//
//   (b) Inject our own `postinstall` that runs the bundled sharp self-
//       heal AFTER the install completes. This catches case (5) for
//       human installs the same way the bash repair catches it for the
//       daemon path. The script is bundled in `dist/`, lives next to
//       `sharp-repair-script.js`, and reuses SHARP_REQUIRED_DEPS so the
//       allowlist never drifts.
//
// Local dev side-effect: this prepack mutates the working-tree
// package.json. The accompanying `postpack` hook
// (`scripts/restore-package-json-after-pack.mjs`) runs
// `git checkout -- package.json` to restore it immediately after `npm
// pack` completes. If postpack doesn't run (Ctrl+C, pack errored),
// restore manually with the same command.
const imcodesPkgPath = join(repoRoot, 'package.json');
if (existsSync(imcodesPkgPath)) {
  const imcodesPkg = JSON.parse(readFileSync(imcodesPkgPath, 'utf8'));
  imcodesPkg.scripts = imcodesPkg.scripts ?? {};
  const NOOP = 'echo "imcodes: published tarball, lifecycle scripts disabled"';
  // Path is relative to the imcodes package root at install time, which is
  // also the postinstall script's cwd. Forward slashes work on Windows for
  // `node` invocation (Node accepts both separators on the CLI).
  const POSTINSTALL_CMD = 'node dist/src/util/postinstall-sharp-repair.js';
  let neutralized = 0;
  for (const key of Object.keys(imcodesPkg.scripts)) {
    if (key === 'postinstall') continue; // handled below
    if (imcodesPkg.scripts[key] !== NOOP) {
      imcodesPkg.scripts[key] = NOOP;
      neutralized += 1;
    }
  }
  // Force-write the published-only postinstall. The source-tree package.json
  // doesn't define one (we have a `prepare` hook for husky during dev), so
  // this is purely additive at pack time and gets reverted by postpack.
  if (imcodesPkg.scripts.postinstall !== POSTINSTALL_CMD) {
    imcodesPkg.scripts.postinstall = POSTINSTALL_CMD;
  }
  writeFileSync(imcodesPkgPath, JSON.stringify(imcodesPkg, null, 2) + '\n');
  console.log(
    `[strip-onnxruntime-gpu] neutralized ${neutralized} lifecycle script(s) ` +
      `and installed sharp-repair postinstall (postpack will restore via git checkout)`,
  );
  // Sanity-check: make sure the published tarball will actually contain
  // the bundled postinstall script. If `dist/src/util/postinstall-sharp-
  // repair.js` is missing, the postinstall would log "Cannot find module"
  // and skip the repair — better to fail the pack loudly here.
  const expectedPostinstallScript = join(repoRoot, 'dist', 'src', 'util', 'postinstall-sharp-repair.js');
  if (!existsSync(expectedPostinstallScript)) {
    console.error(
      `[strip-onnxruntime-gpu] FATAL: ${expectedPostinstallScript} not found. ` +
        `Did 'npm run build' run before pack? The published postinstall would no-op.`,
    );
    process.exit(1);
  }
}

console.log('[strip-onnxruntime-gpu] done.');
