#!/usr/bin/env node
// Build the self-contained controlled-node executable (task 7.1) via Node SEA.
//
// Codifies the flow validated on real macOS + Linux (see tasks 2.5):
//   1. Use the OFFICIAL statically-linked node for the target (nodejs.org / mirror)
//      — a package-manager node may be a dynamically-linked shim that fails SEA.
//   2. esbuild-bundle the thin entry (native-free; guarded by check-node-exe-deps.mjs).
//   3. Generate the SEA blob with THAT EXACT node binary (V8 must match, else the
//      exe crashes with `v8::ToLocalChecked Empty MaybeLocal`).
//   4. Copy the node binary → imcodes-node[.exe]; on macOS strip the signature
//      before postject and ad-hoc re-sign after.
//   5. postject-inject NODE_SEA_BLOB (macOS also needs --macho-segment-name NODE_SEA).
//
// SEA produces a binary for the HOST platform only; CI runs one matrix job per OS.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, copyFile, writeFile, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const NODE_VERSION = process.env.NODE_EXE_NODE_VERSION ?? 'v22.11.0';
const MIRROR = process.env.NODE_EXE_MIRROR ?? 'https://registry.npmmirror.com/-/binary/node';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const platform = process.platform; // darwin | linux | win32
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const isWin = platform === 'win32';
const outName = isWin ? 'imcodes-node.exe' : `imcodes-node-${platform === 'darwin' ? 'macos' : 'linux'}`;

const root = resolve(process.cwd());
const buildDir = join(root, 'dist-node-exe');
const workDir = join(tmpdir(), `imcodes-node-build-${platform}-${arch}`);

function sh(file, args, opts = {}) { return execFileSync(file, args, { stdio: 'inherit', ...opts }); }

async function ensureOfficialNode() {
  const nodePlatform = platform === 'win32' ? 'win' : platform; // darwin|linux|win
  const dirName = `node-${NODE_VERSION}-${nodePlatform}-${arch}`;
  const cacheRoot = process.env.NODE_EXE_CACHE ?? join(tmpdir(), 'officialnode');
  const nodeBin = isWin
    ? join(cacheRoot, dirName, 'node.exe')
    : join(cacheRoot, dirName, 'bin', 'node');
  if (existsSync(nodeBin)) return nodeBin;
  await mkdir(cacheRoot, { recursive: true });
  if (isWin) {
    // Windows ships a standalone node.exe under win-x64/.
    sh('curl', ['-fsSL', `${MIRROR}/${NODE_VERSION}/win-${arch}/node.exe`, '-o', nodeBin]);
    return nodeBin;
  }
  const tarball = `${dirName}.tar.gz`;
  sh('bash', ['-c', `cd ${cacheRoot} && curl -fsSL ${MIRROR}/${NODE_VERSION}/${tarball} -o n.tgz && tar xzf n.tgz && rm n.tgz`]);
  return nodeBin;
}

async function main() {
  const officialNode = await ensureOfficialNode();
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  // 2. Bundle the thin entry to a single CJS file.
  const bundlePath = join(workDir, 'app.cjs');
  await build({
    entryPoints: [join(root, 'src/node/index.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
    external: ['bufferutil', 'utf8-validate'], logLevel: 'info',
  });

  // 3. Generate the SEA blob with the OFFICIAL node (V8 match).
  const seaConfig = join(workDir, 'sea-config.json');
  const blobPath = join(workDir, 'app.blob');
  await writeFile(seaConfig, JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }));
  sh(officialNode, ['--experimental-sea-config', seaConfig]);

  // 4. Copy the node binary → target exe (strip macOS signature before postject).
  const outPath = join(buildDir, outName);
  await rm(outPath, { force: true });
  await copyFile(officialNode, outPath);
  await chmod(outPath, 0o755).catch(() => {});
  if (platform === 'darwin') { try { sh('codesign', ['--remove-signature', outPath]); } catch { /* unsigned already */ } }

  // 5. postject-inject the SEA blob.
  const postjectArgs = [outPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE];
  if (platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  sh('npx', ['-y', 'postject', ...postjectArgs]);
  if (platform === 'darwin') { try { sh('codesign', ['--sign', '-', outPath]); } catch { /* ad-hoc sign best-effort */ } }

  const { size } = await stat(outPath);
  console.log(`\n✅ built ${outName} (${(size / 1048576).toFixed(1)} MB) at ${outPath}`);
}

main().catch((err) => { console.error('build failed:', err?.message ?? err); process.exit(1); });
