#!/usr/bin/env node
/**
 * Shared manifest, pruning, and verification helpers for the standalone
 * read-only Coding Daemon runtime bundle (`daemon-runtime/<os>-<arch>`).
 *
 * Reuses `node-exe-artifacts.mjs` for Node SHASUMS verification, SHA-256
 * hashing, and build version normalization so release provenance rules do not
 * drift across runtime artifacts.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizeNodeExeBuildVersion, sha256File } from './node-exe-artifacts.mjs';

export const DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION = 1;
export const DAEMON_RUNTIME_FILES_FILENAME = 'daemon-runtime.files.json';
export const DEFAULT_DAEMON_RUNTIME_NODE_VERSION = 'v24.16.0';
export const DAEMON_RUNTIME_SUPPORTED_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
]);

export const DAEMON_RUNTIME_CRITICAL_ENTRIES = Object.freeze([
  'package/package.json',
  'package/config/default.yaml',
  'package/dist/src/index.js',
  'package/dist/src/cli.js',
  'package/dist/src/daemon/memory-mcp-bootstrap.js',
  'package/dist/src/context/embedding-worker-bootstrap.mjs',
  'package/dist/src/store/context-store-worker-bootstrap.mjs',
]);

const SHA256_RE = /^[a-f0-9]{64}$/;
const NODE_VERSION_RE = /^v\d+\.\d+\.\d+$/;
const ARCHIVE_FORMATS = new Set(['tar.gz', 'zip']);

const ONNXRUNTIME_GPU_STRIP_RULES = Object.freeze([
  {
    os: 'linux',
    arch: 'x64',
    files: ['libonnxruntime_providers_cuda.so', 'libonnxruntime_providers_tensorrt.so'],
  },
  // DirectML.dll stays untouched because onnxruntime.dll imports it statically.
  { os: 'win32', arch: 'x64', files: ['dxcompiler.dll', 'dxil.dll'] },
  { os: 'win32', arch: 'arm64', files: ['dxcompiler.dll', 'dxil.dll'] },
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Parse and validate target OS/arch into a canonical descriptor.
 */
export function parseDaemonRuntimeTarget(osOrTriple, maybeArch) {
  let os = osOrTriple;
  let arch = maybeArch;
  if (typeof osOrTriple === 'string' && !maybeArch && osOrTriple.includes('-')) {
    const [parsedOs, parsedArch, ...rest] = osOrTriple.split('-');
    if (rest.length > 0) throw new Error(`unsupported daemon-runtime target: ${osOrTriple}`);
    os = parsedOs;
    arch = parsedArch;
  }
  const target = `${os}-${arch}`;
  if (!DAEMON_RUNTIME_SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`unsupported daemon-runtime target: ${target}`);
  }
  const isWindows = os === 'win32';
  return Object.freeze({
    os,
    arch,
    target,
    isWindows,
    archiveFormat: isWindows ? 'zip' : 'tar.gz',
    nodeRelativePath: isWindows ? 'node.exe' : 'bin/node',
  });
}

/**
 * Validate and normalize a bundle-relative POSIX path, rejecting traversal or control bytes.
 */
export function sanitizeBundleRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('bundle relative path must be a non-empty string');
  }
  if (relPath.includes('\0') || /[\r\n]/.test(relPath) || relPath.includes('\\')) {
    throw new Error(`unsafe bundle relative path: ${relPath}`);
  }
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath) || relPath.endsWith('/')) {
    throw new Error(`bundle relative path must stay relative without trailing slash: ${relPath}`);
  }
  const segments = relPath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`bundle relative path contains invalid segment: ${relPath}`);
  }
  return relPath;
}

/**
 * Allowed `@img/*` subpackages for a given target triple (standard glibc on Linux).
 */
export function allowedImgSubpackagesForTarget(target) {
  return new Set([
    'colour',
    `sharp-${target.os}-${target.arch}`,
    `sharp-libvips-${target.os}-${target.arch}`,
  ]);
}

function isMuslPackageName(name) {
  return name.includes('linuxmusl') || name.endsWith('-musl');
}

function extractLockPackageName(lockKey) {
  const idx = lockKey.lastIndexOf('node_modules/');
  if (idx === -1) return null;
  return lockKey.slice(idx + 'node_modules/'.length);
}

/**
 * Determine whether a `package-lock.json` `packages` entry belongs in a
 * production `daemon-runtime` bundle for `target`.
 */
export function shouldKeepPackageLockEntry(lockKey, pkgMeta, target) {
  if (typeof lockKey !== 'string' || !lockKey.startsWith('node_modules/')) return false;
  if (!pkgMeta || typeof pkgMeta !== 'object') return false;
  if (pkgMeta.dev === true || pkgMeta.devOptional === true) return false;
  if (pkgMeta.link === true) return false;

  const pkgName = extractLockPackageName(lockKey);
  if (!pkgName) return false;
  if (isMuslPackageName(pkgName)) return false;

  if (Array.isArray(pkgMeta.os) && pkgMeta.os.length > 0 && !pkgMeta.os.includes(target.os)) {
    return false;
  }
  if (Array.isArray(pkgMeta.cpu) && pkgMeta.cpu.length > 0 && !pkgMeta.cpu.includes(target.arch)) {
    return false;
  }

  if (pkgName.startsWith('@img/')) {
    const subName = pkgName.slice('@img/'.length);
    return allowedImgSubpackagesForTarget(target).has(subName);
  }

  return true;
}

/**
 * Trim staged `node_modules` down to target OS/arch production assets.
 * Operates ONLY on the staged destination directory, never repo `node_modules`.
 */
export function pruneStagedNodeModulesForTarget(nodeModulesDir, target, options = {}) {
  const hostOs = options.hostOs ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  let bytesRemoved = 0;

  const measureAndRemove = (absPath) => {
    if (!existsSync(absPath)) return;
    const stack = [absPath];
    while (stack.length > 0) {
      const cur = stack.pop();
      const lst = lstatSync(cur);
      if (lst.isSymbolicLink() || !lst.isDirectory()) {
        bytesRemoved += lst.size;
      } else {
        for (const name of readdirSync(cur)) stack.push(join(cur, name));
      }
    }
    rmSync(absPath, { recursive: true, force: true });
  };

  // 1. Remove symlinks and build/cache artifacts (.bin, transformers .cache).
  measureAndRemove(join(nodeModulesDir, '.bin'));
  measureAndRemove(join(nodeModulesDir, '@huggingface', 'transformers', '.cache'));

  // 2. Keep only target @img/* packages (top-level and nested under transformers).
  const allowedImg = allowedImgSubpackagesForTarget(target);
  for (const imgRoot of [
    join(nodeModulesDir, '@img'),
    join(nodeModulesDir, '@huggingface', 'transformers', 'node_modules', '@img'),
  ]) {
    if (!existsSync(imgRoot)) continue;
    for (const entry of readdirSync(imgRoot)) {
      if (!allowedImg.has(entry)) measureAndRemove(join(imgRoot, entry));
    }
  }

  // 3. Prune onnxruntime-node to target OS/arch + CPU-only execution providers.
  const onnxRoot = join(nodeModulesDir, 'onnxruntime-node');
  if (existsSync(onnxRoot)) {
    const binRoot = join(onnxRoot, 'bin');
    if (existsSync(binRoot)) {
      for (const napiDir of readdirSync(binRoot).filter((name) => name.startsWith('napi-v'))) {
        const napiPath = join(binRoot, napiDir);
        for (const osEntry of readdirSync(napiPath)) {
          const osPath = join(napiPath, osEntry);
          if (osEntry !== target.os) {
            measureAndRemove(osPath);
            continue;
          }
          for (const archEntry of readdirSync(osPath)) {
            const archPath = join(osPath, archEntry);
            if (archEntry !== target.arch) {
              measureAndRemove(archPath);
              continue;
            }
            for (const rule of ONNXRUNTIME_GPU_STRIP_RULES) {
              if (rule.os === target.os && rule.arch === target.arch) {
                for (const fileName of rule.files) measureAndRemove(join(archPath, fileName));
              }
            }
          }
        }
      }
    }
    const installMetaPath = join(onnxRoot, 'script', 'install-metadata.js');
    if (existsSync(installMetaPath)) {
      const before = readFileSync(installMetaPath, 'utf8');
      const after = before.replace(/'linux\/x64':\s*\['cuda12'\]/g, "'linux/x64': []");
      if (before !== after) writeFileSync(installMetaPath, after);
    }
    const onnxPkgPath = join(onnxRoot, 'package.json');
    if (existsSync(onnxPkgPath)) {
      const pkg = JSON.parse(readFileSync(onnxPkgPath, 'utf8'));
      const noop = 'echo "imcodes: standalone daemon-runtime, install skipped"';
      let changed = false;
      if (pkg.scripts?.install && pkg.scripts.install !== noop) {
        pkg.scripts.install = noop;
        changed = true;
      }
      if (pkg.scripts?.postinstall && pkg.scripts.postinstall !== noop) {
        pkg.scripts.postinstall = noop;
        changed = true;
      }
      if (changed) writeFileSync(onnxPkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }

  // 4. Trim onnxruntime-web browser payloads (daemon uses onnxruntime-node only).
  const ortWebDist = join(nodeModulesDir, 'onnxruntime-web', 'dist');
  if (existsSync(ortWebDist)) {
    for (const fileName of readdirSync(ortWebDist)) {
      if (
        fileName.endsWith('.wasm')
        || fileName.endsWith('.map')
        || fileName.startsWith('ort.all.')
        || fileName.startsWith('ort.webgl.')
      ) {
        measureAndRemove(join(ortWebDist, fileName));
      }
    }
  }

  // 5. Prune node-pty foreign prebuilds (and mismatched host build dir if cross-targeting).
  const nodePtyRoot = join(nodeModulesDir, 'node-pty');
  if (existsSync(nodePtyRoot)) {
    const prebuildsDir = join(nodePtyRoot, 'prebuilds');
    if (existsSync(prebuildsDir)) {
      for (const entry of readdirSync(prebuildsDir)) {
        if (entry !== target.target) measureAndRemove(join(prebuildsDir, entry));
      }
    }
    if (hostOs !== target.os || hostArch !== target.arch) {
      measureAndRemove(join(nodePtyRoot, 'build'));
    }
  }

  return { bytesRemoved };
}

/**
 * Walk `bundleRoot` deterministically, disallowing symlinks and collecting
 * relative POSIX paths, byte sizes, SHA-256 digests, and POSIX executable flags.
 */
export async function collectBundleFileEntries(bundleRoot, options = {}) {
  const ignoreRelativePaths = new Set(options.ignoreRelativePaths ?? [DAEMON_RUNTIME_FILES_FILENAME]);
  const rootReal = realpathSync(resolve(bundleRoot));
  const collected = [];

  const walk = async (dirAbs, relPrefix) => {
    const names = readdirSync(dirAbs).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const childAbs = join(dirAbs, name);
      const lst = lstatSync(childAbs);
      if (lst.isSymbolicLink()) {
        throw new Error(`daemon-runtime bundle must not contain symbolic links: ${join(relPrefix, name)}`);
      }
      const relPosix = relPrefix ? `${relPrefix}/${name}` : name;
      if (lst.isDirectory()) {
        await walk(childAbs, relPosix);
        continue;
      }
      if (!lst.isFile()) {
        throw new Error(`daemon-runtime bundle contains unsupported non-regular entry: ${relPosix}`);
      }
      sanitizeBundleRelativePath(relPosix);
      if (ignoreRelativePaths.has(relPosix)) continue;
      const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
      if (!realpathSync(childAbs).startsWith(rootPrefix)) {
        throw new Error(`daemon-runtime bundle entry escapes root: ${relPosix}`);
      }
      collected.push({
        path: relPosix,
        size: lst.size,
        sha256: await sha256File(childAbs),
        executable: (lst.mode & 0o111) !== 0,
      });
    }
  };

  await walk(rootReal, '');
  collected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return collected;
}

/**
 * Build the bundle-internal `daemon-runtime.files.json` document describing
 * target, entrypoint, toolchain provenance, build metadata, and tracked files.
 */
export async function createDaemonRuntimeFilesDocument({
  bundleRoot,
  os,
  arch,
  nodeVersion,
  nodeProvider = 'official-node',
  nodeArchive,
  nodeArchiveSha256,
  nodeBinarySha256,
  buildCommit,
  buildVersion,
}) {
  const target = parseDaemonRuntimeTarget(os, arch);
  if (typeof nodeVersion !== 'string' || !NODE_VERSION_RE.test(nodeVersion)) {
    throw new Error('invalid daemon-runtime Node version');
  }
  if (typeof buildCommit !== 'string' || !/^[a-f0-9]{7,64}$/.test(buildCommit.trim())) {
    throw new Error('invalid daemon-runtime build commit');
  }
  const normalizedBuildVersion = normalizeNodeExeBuildVersion(buildVersion);
  if (nodeProvider === 'official-node') {
    if (typeof nodeArchive !== 'string' || basename(nodeArchive) !== nodeArchive || !nodeArchive.length) {
      throw new Error('official-node provenance requires nodeArchive basename');
    }
    if (typeof nodeArchiveSha256 !== 'string' || !SHA256_RE.test(nodeArchiveSha256)) {
      throw new Error('official-node provenance requires lowercase nodeArchiveSha256');
    }
  } else if (nodeProvider === 'local-node-bin') {
    if (typeof nodeBinarySha256 !== 'string' || !SHA256_RE.test(nodeBinarySha256)) {
      throw new Error('local-node-bin provenance requires nodeBinarySha256');
    }
  } else {
    throw new Error(`unsupported daemon-runtime nodeProvider: ${nodeProvider}`);
  }

  const files = await collectBundleFileEntries(bundleRoot, {
    ignoreRelativePaths: [DAEMON_RUNTIME_FILES_FILENAME],
  });
  const totalUncompressedBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const filesByPath = new Set(files.map((entry) => entry.path));
  for (const required of [target.nodeRelativePath, ...DAEMON_RUNTIME_CRITICAL_ENTRIES]) {
    if (!filesByPath.has(required)) {
      throw new Error(`daemon-runtime bundle missing required entry: ${required}`);
    }
  }

  return {
    schemaVersion: DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION,
    target: { os: target.os, arch: target.arch },
    entrypoint: {
      node: target.nodeRelativePath,
      script: 'package/dist/src/index.js',
    },
    toolchain: {
      nodeVersion,
      nodeProvider,
      ...(nodeArchive ? { nodeArchive, nodeArchiveSha256 } : {}),
      ...(nodeBinarySha256 ? { nodeBinarySha256 } : {}),
    },
    build: {
      commit: buildCommit.trim(),
      version: normalizedBuildVersion,
    },
    totalUncompressedBytes,
    fileCount: files.length,
    files,
  };
}

/**
 * Build runtime `daemon-runtime.files.json` and top-level `.manifest.json`.
 */
export async function createDaemonRuntimeManifest({
  bundleRoot,
  archivePath,
  os,
  arch,
  nodeVersion,
  nodeProvider = 'official-node',
  nodeArchive,
  nodeArchiveSha256,
  nodeBinarySha256,
  buildCommit,
  buildVersion,
  authenticodeSignerSha256,
  macosSigningIdentitySha1,
}) {
  const target = parseDaemonRuntimeTarget(os, arch);
  if (authenticodeSignerSha256 !== undefined
    && (typeof authenticodeSignerSha256 !== 'string' || !SHA256_RE.test(authenticodeSignerSha256))) {
    throw new Error('invalid Authenticode signer SHA-256');
  }
  if (macosSigningIdentitySha1 !== undefined
    && (typeof macosSigningIdentitySha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(macosSigningIdentitySha1))) {
    throw new Error('invalid macOS signing identity SHA-1');
  }

  const filesDocument = await createDaemonRuntimeFilesDocument({
    bundleRoot,
    os: target.os,
    arch: target.arch,
    nodeVersion,
    nodeProvider,
    nodeArchive,
    nodeArchiveSha256,
    nodeBinarySha256,
    buildCommit,
    buildVersion,
  });

  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size <= 0) {
    throw new Error(`daemon-runtime archive is missing or empty: ${archivePath}`);
  }
  const manifest = {
    schemaVersion: DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION,
    artifact: {
      fileName: basename(archivePath),
      format: target.archiveFormat,
      os: target.os,
      arch: target.arch,
      size: archiveStat.size,
      sha256: await sha256File(archivePath),
      ...(authenticodeSignerSha256 ? { authenticodeSignerSha256 } : {}),
      ...(macosSigningIdentitySha1 ? { macosSigningIdentitySha1: macosSigningIdentitySha1.toLowerCase() } : {}),
    },
    entrypoint: filesDocument.entrypoint,
    toolchain: filesDocument.toolchain,
    build: filesDocument.build,
    totalUncompressedBytes: filesDocument.totalUncompressedBytes,
    fileCount: filesDocument.fileCount,
    files: filesDocument.files,
  };

  assertDaemonRuntimeManifestShape(manifest, archivePath);
  return { manifest, filesDocument };
}

export function assertDaemonRuntimeManifestShape(value, context = 'manifest') {
  const fail = (reason) => {
    throw new Error(`invalid daemon-runtime manifest ${context}: ${reason}`);
  };
  if (!isRecord(value)) fail('root must be an object');
  if (value.schemaVersion !== DAEMON_RUNTIME_MANIFEST_SCHEMA_VERSION) fail('unsupported schemaVersion');

  const { artifact, entrypoint, toolchain, build, files } = value;
  if (!isRecord(artifact)) fail('artifact must be an object');
  if (typeof artifact.fileName !== 'string' || basename(artifact.fileName) !== artifact.fileName || !artifact.fileName) {
    fail('artifact.fileName must be a basename');
  }
  if (!ARCHIVE_FORMATS.has(artifact.format)) fail('artifact.format is unsupported');
  const target = parseDaemonRuntimeTarget(artifact.os, artifact.arch);
  if (artifact.format !== target.archiveFormat) fail('artifact.format mismatches artifact.os');
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) fail('artifact.size must be positive');
  if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) {
    fail('artifact.sha256 must be lowercase SHA-256 hex');
  }
  if (artifact.authenticodeSignerSha256 !== undefined
    && (typeof artifact.authenticodeSignerSha256 !== 'string' || !SHA256_RE.test(artifact.authenticodeSignerSha256))) {
    fail('artifact.authenticodeSignerSha256 is invalid');
  }
  if (artifact.macosSigningIdentitySha1 !== undefined
    && (typeof artifact.macosSigningIdentitySha1 !== 'string' || !/^[a-f0-9]{40}$/.test(artifact.macosSigningIdentitySha1))) {
    fail('artifact.macosSigningIdentitySha1 is invalid');
  }

  if (!isRecord(entrypoint) || entrypoint.node !== target.nodeRelativePath || entrypoint.script !== 'package/dist/src/index.js') {
    fail('entrypoint is invalid');
  }
  if (!isRecord(toolchain) || typeof toolchain.nodeVersion !== 'string' || !NODE_VERSION_RE.test(toolchain.nodeVersion)) {
    fail('toolchain.nodeVersion is invalid');
  }
  if (toolchain.nodeProvider === 'official-node') {
    if (typeof toolchain.nodeArchive !== 'string' || basename(toolchain.nodeArchive) !== toolchain.nodeArchive) {
      fail('toolchain.nodeArchive is invalid');
    }
    if (typeof toolchain.nodeArchiveSha256 !== 'string' || !SHA256_RE.test(toolchain.nodeArchiveSha256)) {
      fail('toolchain.nodeArchiveSha256 is invalid');
    }
  } else if (toolchain.nodeProvider === 'local-node-bin') {
    if (typeof toolchain.nodeBinarySha256 !== 'string' || !SHA256_RE.test(toolchain.nodeBinarySha256)) {
      fail('toolchain.nodeBinarySha256 is invalid');
    }
  } else {
    fail('toolchain.nodeProvider is invalid');
  }

  if (!isRecord(build) || typeof build.commit !== 'string' || !/^[a-f0-9]{7,64}$/.test(build.commit)) {
    fail('build.commit is invalid');
  }
  normalizeNodeExeBuildVersion(build.version);

  if (!Number.isSafeInteger(value.totalUncompressedBytes) || value.totalUncompressedBytes <= 0) {
    fail('totalUncompressedBytes must be positive');
  }
  if (!Array.isArray(files) || files.length === 0 || value.fileCount !== files.length) {
    fail('files list must match fileCount');
  }

  const seenPaths = new Set();
  let sumBytes = 0;
  for (const entry of files) {
    if (!isRecord(entry)) fail('file entry must be an object');
    const rel = sanitizeBundleRelativePath(entry.path);
    if (seenPaths.has(rel)) fail(`duplicate file entry: ${rel}`);
    seenPaths.add(rel);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail(`invalid file size for ${rel}`);
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) fail(`invalid sha256 for ${rel}`);
    if (typeof entry.executable !== 'boolean') fail(`invalid executable flag for ${rel}`);
    sumBytes += entry.size;
  }
  if (sumBytes !== value.totalUncompressedBytes) {
    fail('totalUncompressedBytes does not match sum of file sizes');
  }
  if (!seenPaths.has(target.nodeRelativePath) || !seenPaths.has('package/dist/src/index.js')) {
    fail('files list missing required runtime entrypoints');
  }
  return value;
}

/**
 * Verify every file in an already-extracted `bundleRoot` against expected manifest entries.
 */
export async function verifyExtractedDaemonRuntime(bundleRoot, expectedFiles, options = {}) {
  const checkExecutableBit = options.checkExecutableBit ?? process.platform !== 'win32';
  const expectedMap = new Map();
  for (const entry of expectedFiles) {
    const safePath = sanitizeBundleRelativePath(entry.path);
    if (expectedMap.has(safePath)) throw new Error(`duplicate manifest file entry: ${safePath}`);
    expectedMap.set(safePath, entry);
  }

  const actualFiles = await collectBundleFileEntries(bundleRoot, {
    ignoreRelativePaths: [DAEMON_RUNTIME_FILES_FILENAME],
  });
  const actualMap = new Map(actualFiles.map((entry) => [entry.path, entry]));

  for (const [relPath, expected] of expectedMap) {
    const actual = actualMap.get(relPath);
    if (!actual) throw new Error(`extracted daemon-runtime missing file: ${relPath}`);
    if (actual.size !== expected.size) {
      throw new Error(`extracted daemon-runtime size mismatch for ${relPath}: expected ${expected.size}, got ${actual.size}`);
    }
    if (actual.sha256 !== expected.sha256) {
      throw new Error(`extracted daemon-runtime checksum mismatch for ${relPath}`);
    }
    if (checkExecutableBit && expected.executable && !actual.executable) {
      throw new Error(`extracted daemon-runtime file lost executable bit: ${relPath}`);
    }
  }
  for (const relPath of actualMap.keys()) {
    if (!expectedMap.has(relPath)) {
      throw new Error(`extracted daemon-runtime contains unexpected untracked file: ${relPath}`);
    }
  }
  return { fileCount: actualFiles.length };
}

function extractArchiveToDir(archivePath, format, destDir) {
  if (format === 'tar.gz') {
    execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'pipe' });
    return;
  }
  if (format === 'zip') {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        archivePath, destDir,
      ], { stdio: 'pipe' });
    } else {
      execFileSync('unzip', ['-q', archivePath, '-d', destDir], { stdio: 'pipe' });
    }
    return;
  }
  throw new Error(`unsupported archive format: ${format}`);
}

/**
 * Verify a packaged archive against its `.manifest.json` (both archive digest
 * and, by default, extracting into an isolated temp dir to verify every file).
 */
export async function verifyDaemonRuntimeArchive(manifestPath, options = {}) {
  const absManifestPath = resolve(manifestPath);
  const manifest = assertDaemonRuntimeManifestShape(
    JSON.parse(await readFile(absManifestPath, 'utf8')),
    absManifestPath,
  );
  if (options.requireOfficialNode !== false && manifest.toolchain.nodeProvider !== 'official-node') {
    throw new Error(`daemon-runtime manifest ${absManifestPath} uses non-official nodeProvider (${manifest.toolchain.nodeProvider})`);
  }
  if (options.expectedVersion && manifest.build.version !== normalizeNodeExeBuildVersion(options.expectedVersion)) {
    throw new Error(`daemon-runtime version mismatch: expected ${options.expectedVersion}, got ${manifest.build.version}`);
  }
  if (options.expectedOs && manifest.artifact.os !== options.expectedOs) {
    throw new Error(`daemon-runtime os mismatch: expected ${options.expectedOs}, got ${manifest.artifact.os}`);
  }
  if (options.expectedArch && manifest.artifact.arch !== options.expectedArch) {
    throw new Error(`daemon-runtime arch mismatch: expected ${options.expectedArch}, got ${manifest.artifact.arch}`);
  }

  const artifactDir = options.artifactDir ? resolve(options.artifactDir) : dirname(absManifestPath);
  const archivePath = join(artifactDir, manifest.artifact.fileName);
  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile()) throw new Error(`daemon-runtime archive missing: ${archivePath}`);
  if (archiveStat.size !== manifest.artifact.size) {
    throw new Error(`daemon-runtime archive size mismatch: expected ${manifest.artifact.size}, got ${archiveStat.size}`);
  }
  const actualArchiveSha256 = await sha256File(archivePath);
  if (actualArchiveSha256 !== manifest.artifact.sha256) {
    throw new Error(`daemon-runtime archive checksum mismatch: expected ${manifest.artifact.sha256}, got ${actualArchiveSha256}`);
  }

  if (options.verifyContents !== false) {
    const extractDir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-runtime-verify-'));
    try {
      extractArchiveToDir(archivePath, manifest.artifact.format, extractDir);
      await verifyExtractedDaemonRuntime(extractDir, manifest.files, {
        checkExecutableBit: manifest.artifact.os !== 'win32' && process.platform !== 'win32',
      });
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }
  return manifest;
}

export async function writeDaemonRuntimeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'verify') {
    throw new Error('usage: daemon-runtime-artifacts.mjs verify <manifestPath> [--expected-version <v>] [--os <os>] [--arch <arch>] [--allow-local-node] [--archive-only]');
  }
  const positional = [];
  const flags = {
    requireOfficialNode: true,
    verifyContents: true,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--expected-version') flags.expectedVersion = rest[++i];
    else if (arg === '--os') flags.expectedOs = rest[++i];
    else if (arg === '--arch') flags.expectedArch = rest[++i];
    else if (arg === '--allow-local-node') flags.requireOfficialNode = false;
    else if (arg === '--archive-only') flags.verifyContents = false;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new Error('usage: daemon-runtime-artifacts.mjs verify <manifestPath> [...]');
  }
  return { manifestPath: positional[0], flags };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  Promise.resolve().then(async () => {
    const { manifestPath, flags } = parseCliArgs(process.argv.slice(2));
    const manifest = await verifyDaemonRuntimeArchive(manifestPath, flags);
    console.log(
      `verified ${manifest.artifact.fileName} (${manifest.artifact.os}-${manifest.artifact.arch}, ${manifest.fileCount} files, ${(manifest.artifact.size / 1048576).toFixed(1)} MB compressed, ${(manifest.totalUncompressedBytes / 1048576).toFixed(1)} MB uncompressed)`,
    );
  }).catch((err) => {
    console.error(`daemon-runtime verification failed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
