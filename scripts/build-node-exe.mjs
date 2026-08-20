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
// SEA produces native Mach-O slices. macOS injects the same code-cache-free SEA
// blob into the official arm64 and x64 Node binaries, then combines them into a
// single Universal 2 executable.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, copyFile, writeFile, chmod, stat, readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createNodeExeManifest,
  normalizeNodeExeBuildVersion,
  verifyOfficialNodeArtifact,
  writeNodeExeManifest,
  NODE_EXE_MANIFEST_SUFFIX,
} from './node-exe-artifacts.mjs';

const NODE_VERSION = process.env.NODE_EXE_NODE_VERSION ?? 'v22.11.0';
const OFFICIAL_NODE_DIST = 'https://nodejs.org/dist';
const MIRROR = (process.env.NODE_EXE_MIRROR ?? OFFICIAL_NODE_DIST).replace(/\/+$/, '');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const platform = process.platform; // darwin | linux | win32
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const isWin = platform === 'win32';
const artifactArch = platform === 'darwin' ? 'universal' : arch;
const outName = isWin ? 'imcodes-node.exe' : `imcodes-node-${platform === 'darwin' ? 'macos' : 'linux'}`;

const root = resolve(process.cwd());
const buildDir = join(root, 'dist-node-exe');
const workDir = join(tmpdir(), `imcodes-node-build-${platform}-${arch}`);
const require = createRequire(import.meta.url);

function sh(file, args, opts = {}) { return execFileSync(file, args, { stdio: 'inherit', ...opts }); }

function runWindowsReleaseSigning(mode, artifactPath, expectedSignerSha256 = '') {
  if (!isWin) return;
  const thumbprint = process.env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT?.trim() ?? '';
  if (mode === 'Sign' && Boolean(thumbprint) !== Boolean(expectedSignerSha256)) {
    throw new Error(
      'Windows node signing requires both IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT and IMCODES_WINDOWS_SIGNING_CERT_SHA256',
    );
  }
  if (mode === 'Sign' && !thumbprint) return;
  if (!/^[a-f0-9]{40}$/i.test(thumbprint)) {
    if (mode === 'Sign') throw new Error('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT must be SHA-1 hex');
  }
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) throw new Error('SystemRoot is required to locate Windows PowerShell');
  sh(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(root, 'scripts', 'windows-sign-release-artifact.ps1'),
    '-Mode',
    mode,
    '-ArtifactPath',
    artifactPath,
    ...(mode === 'Sign' ? [
      '-CodeSigningCertificateThumbprint',
      thumbprint,
      '-ExpectedSignerSha256',
      expectedSignerSha256,
      '-TimestampUrl',
      process.env.IMCODES_WINDOWS_SIGNING_TIMESTAMP_URL?.trim() || 'http://timestamp.digicert.com',
    ] : []),
  ]);
}

async function downloadFile(url, destination, redirect = 'follow') {
  const response = await fetch(url, { redirect });
  if (!response.ok) throw new Error(`download failed (${response.status}) for ${url}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function ensureOfficialNode(targetArch = arch) {
  const nodePlatform = platform === 'win32' ? 'win' : platform; // darwin|linux|win
  const dirName = `node-${NODE_VERSION}-${nodePlatform}-${targetArch}`;
  const cacheRoot = process.env.NODE_EXE_CACHE ?? join(tmpdir(), 'officialnode');
  const archiveName = `${dirName}.${isWin ? 'zip' : 'tar.gz'}`;
  const archivePath = join(cacheRoot, archiveName);
  const archiveTemp = `${archivePath}.${process.pid}.tmp`;
  const shasumsPath = join(workDir, `SHASUMS256-${targetArch}.txt`);
  const nodeBin = isWin
    ? join(cacheRoot, dirName, 'node.exe')
    : join(cacheRoot, dirName, 'bin', 'node');
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(workDir, { recursive: true });

  // The mirror is only a byte source. Trust is anchored to the official
  // nodejs.org SHASUMS256 entry for the exact archive on every build, including
  // cache hits. A corrupted cache or mirror response therefore fails closed.
  await downloadFile(`${OFFICIAL_NODE_DIST}/${NODE_VERSION}/SHASUMS256.txt`, shasumsPath, 'error');
  if (!existsSync(archivePath)) {
    await rm(archiveTemp, { force: true });
    await downloadFile(`${MIRROR}/${NODE_VERSION}/${archiveName}`, archiveTemp);
    await rename(archiveTemp, archivePath);
  }
  const nodeArchiveSha256 = await verifyOfficialNodeArtifact(archivePath, archiveName, await readFile(shasumsPath, 'utf8'));

  // Re-extract from the verified archive so a tampered extracted cache cannot
  // bypass archive verification.
  await rm(join(cacheRoot, dirName), { recursive: true, force: true });
  sh('tar', ['-xf', archivePath, '-C', cacheRoot]);
  if (!existsSync(nodeBin)) throw new Error(`verified Node archive did not contain ${nodeBin}`);
  return { nodeBin, nodeArchive: archiveName, nodeArchiveSha256 };
}

async function main() {
  const officialNodes = platform === 'darwin'
    ? await Promise.all(['arm64', 'x64'].map((targetArch) => ensureOfficialNode(targetArch)))
    : [await ensureOfficialNode()];
  const officialNode = officialNodes.find(({ nodeBin }) => nodeBin.includes(`-${arch}/`)) ?? officialNodes[0];
  if (!officialNode) throw new Error(`no official Node binary for build host architecture ${arch}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await mkdir(buildDir, { recursive: true });

  // 2. Bundle the thin entry to a single CJS file.
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const packageVersion = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  const buildVersion = normalizeNodeExeBuildVersion(process.env.IMCODES_BUILD_VERSION?.trim() || packageVersion);
  const windowsReleaseSignerSha256 = process.env.IMCODES_WINDOWS_SIGNING_CERT_SHA256?.trim().toLowerCase() ?? '';
  if (windowsReleaseSignerSha256 && !/^[a-f0-9]{64}$/.test(windowsReleaseSignerSha256)) {
    throw new Error('IMCODES_WINDOWS_SIGNING_CERT_SHA256 must be lowercase SHA-256 hex');
  }
  const bundlePath = join(workDir, 'app.cjs');
  await build({
    entryPoints: [join(root, 'src/node/index.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundlePath,
    external: ['bufferutil', 'utf8-validate'],
    define: {
      'process.env.IMCODES_BUILD_VERSION': JSON.stringify(buildVersion),
      __IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__: JSON.stringify(
        isWin ? windowsReleaseSignerSha256 : '',
      ),
    },
    logLevel: 'info',
  });

  // 3. Generate the SEA blob with the OFFICIAL node (V8 match).
  const seaConfig = join(workDir, 'sea-config.json');
  const blobPath = join(workDir, 'app.blob');
  await writeFile(seaConfig, JSON.stringify({ main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true }));
  sh(officialNode.nodeBin, ['--experimental-sea-config', seaConfig]);

  // 4. Copy the node binary → target exe (or inject both macOS slices).
  const outPath = join(buildDir, outName);
  await rm(outPath, { force: true });

  // 5. postject-inject the SEA blob with the exact lockfile dependency. Never
  // resolve mutable registry state during a release build.
  const postjectPackage = JSON.parse(await readFile(join(root, 'node_modules', 'postject', 'package.json'), 'utf8'));
  const postjectVersion = postjectPackage.version;
  if (typeof postjectVersion !== 'string' || !postjectPackage.bin?.postject) throw new Error('invalid installed postject package');
  const postjectBin = join(root, 'node_modules', 'postject', postjectPackage.bin.postject);
  // Use the pinned package API only on Windows. On older Windows hosts the CLI
  // child can finish PE injection yet terminate its execFileSync caller before
  // mandatory Authenticode signing. macOS/Linux retain the already-qualified
  // CLI path because postject's native API has different process-exit semantics
  // on those platforms.
  const postjectApi = isWin
    ? require(join(root, 'node_modules', 'postject', 'dist', 'api.js'))
    : null;
  if (isWin && typeof postjectApi?.inject !== 'function') throw new Error('invalid installed postject API');
  const seaBlob = isWin ? await readFile(blobPath) : null;
  const inject = async (nodeBin, destination) => {
    await rm(destination, { force: true });
    await copyFile(nodeBin, destination);
    await chmod(destination, 0o755).catch(() => {});
    if (isWin) {
      // Official node.exe is Authenticode-signed. Node's documented SEA flow
      // requires removing that certificate table before postject rewrites the
      // PE, otherwise a later SignTool invocation fails with ERROR_BAD_EXE_FORMAT.
      runWindowsReleaseSigning('Remove', destination);
    }
    if (platform === 'darwin') {
      try { sh('codesign', ['--remove-signature', destination]); } catch { /* unsigned already */ }
    }
    if (isWin) {
      await postjectApi.inject(destination, 'NODE_SEA_BLOB', seaBlob, { sentinelFuse: SEA_FUSE });
    } else {
      const args = [destination, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', SEA_FUSE];
      if (platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
      sh(process.execPath, [postjectBin, ...args]);
    }
  };
  if (platform === 'darwin') {
    const slices = [];
    for (const node of officialNodes) {
      const slicePath = join(workDir, `imcodes-node-macos-${node.nodeArchive.includes('-arm64.') ? 'arm64' : 'x64'}`);
      await inject(node.nodeBin, slicePath);
      slices.push(slicePath);
    }
    sh('lipo', ['-create', ...slices, '-output', outPath]);
    sh('codesign', ['--force', '--sign', '-', outPath]);
  } else {
    await inject(officialNode.nodeBin, outPath);
  }

  const buildCommit = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  // Copy the platform Computer Use helper as a sidecar artifact when available.
  // It is not injected into the SEA binary: the helper is an independently
  // signed/native executable and should remain replaceable/verifiable.
  sh(process.execPath, [join(root, 'scripts', 'copy-computer-use-helper.mjs'), '--node-exe'], {
    env: {
      ...process.env,
      ...(platform === 'darwin' ? { IMCODES_COMPUTER_USE_HELPER_TARGET_ARCH: 'universal' } : {}),
    },
  });

  if (isWin) {
    runWindowsReleaseSigning(
      'Sign',
      join(buildDir, 'computer-use-helper', 'win32-x64', 'open-computer-use.exe'),
      windowsReleaseSignerSha256,
    );
  }

  // postject changes the official node.exe bytes and therefore invalidates its
  // Microsoft signature. Sign the final SEA executable before hashing it into
  // the release manifest. Formal Windows CI always supplies both signer values;
  // unsigned local developer builds remain possible when neither is supplied.
  runWindowsReleaseSigning('Sign', outPath, windowsReleaseSignerSha256);

  const helperRelativePath = platform === 'darwin'
    ? 'computer-use-helper/darwin-universal/open-computer-use.app.zip'
    : `computer-use-helper/${platform}-${arch}/open-computer-use${isWin ? '.exe' : ''}`;
  const helperPath = join(buildDir, ...helperRelativePath.split('/'));

  const manifestPath = `${outPath}${NODE_EXE_MANIFEST_SUFFIX}`;
  const manifest = await createNodeExeManifest({
    artifactPath: outPath,
    os: platform,
    arch: artifactArch,
    nodeVersion: NODE_VERSION,
    nodeArchive: officialNode.nodeArchive,
    nodeArchiveSha256: officialNode.nodeArchiveSha256,
    ...(platform === 'darwin'
      ? {
          nodeArchives: officialNodes.map((node) => ({
            arch: node.nodeArchive.includes('-arm64.') ? 'arm64' : 'x64',
            nodeArchive: node.nodeArchive,
            nodeArchiveSha256: node.nodeArchiveSha256,
          })),
        }
      : {}),
    postjectVersion,
    buildCommit,
    buildVersion,
    helperPath,
    helperRelativePath,
    ...(isWin && windowsReleaseSignerSha256
      ? { authenticodeSignerSha256: windowsReleaseSignerSha256 }
      : {}),
  });
  await writeNodeExeManifest(manifest, manifestPath);
  const { size } = await stat(outPath);
  console.log(`\n✅ built ${outName} (${(size / 1048576).toFixed(1)} MB) at ${outPath}`);
  console.log(`✅ wrote verified artifact manifest at ${manifestPath}`);
}

main().catch((err) => { console.error('build failed:', err?.message ?? err); process.exit(1); });
