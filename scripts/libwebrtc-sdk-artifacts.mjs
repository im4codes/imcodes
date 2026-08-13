#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PINNED_DEPOT_TOOLS_REVISION,
  PINNED_LIBWEBRTC_REVISION,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  verifyRemoteDesktopWorkerArtifactSet,
} from './remote-desktop-worker-artifacts.mjs';

export const LIBWEBRTC_SDK_MANIFEST_FILENAME = 'imcodes-libwebrtc-sdk.manifest.json';
export const LIBWEBRTC_SDK_ARCHIVE_FILENAME = 'imcodes-libwebrtc-sdk-windows-x64.zip';
export const LIBWEBRTC_SDK_LOCK_FILENAME = 'libwebrtc-sdk.lock.json';

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const RELEASE_TAG_RE = /^libwebrtc-sdk-windows-x64-[a-f0-9]{16}-[a-f0-9]{16}$/;
const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Only files that affect the native bytes or their release verification are
// fingerprinted. Documentation-only edits must not force a multi-hour SDK
// rebuild, while source, GN, driver, signing/package, and toolchain-resolution
// changes must never silently consume an older binary.
const SOURCE_INPUTS = Object.freeze([
  {
    directory: 'native/windows-remote-desktop',
    extensions: new Set(['.cc', '.h', '.gn', '.ps1', '.def', '.idl', '.json', '.py']),
  },
  {
    directory: 'native/windows-virtual-display',
    extensions: new Set([
      '.cc', '.h', '.inf', '.rc', '.sln', '.txt', '.vcxproj', '.props', '.targets', '.filters', '.def', '.idl', '.json', '.py', '.ps1',
    ]),
  },
  { file: 'scripts/remote-desktop-worker-artifacts.mjs' },
  { file: 'scripts/resolve-windows-driver-kit.ps1' },
  { file: 'scripts/windows-sign-release-artifact.ps1' },
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function normalizedRelativePath(path) {
  return relative(repositoryRoot, path).split(sep).join('/');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolveStream, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolveStream);
  });
  return hash.digest('hex');
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`libwebrtc SDK input is not a regular file: ${normalizedRelativePath(path)}`);
  }
  return stat;
}

async function sourceFiles() {
  const files = [];
  const visit = async (directory, extensions) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['out', 'build', '.git'].includes(entry.name.toLowerCase())) {
          await visit(path, extensions);
        }
      } else {
        const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        if (!extensions.has(extension)) continue;
        await regularFile(path);
        files.push(path);
      }
    }
  };
  for (const input of SOURCE_INPUTS) {
    if ('file' in input) {
      const path = resolve(repositoryRoot, input.file);
      await regularFile(path);
      files.push(path);
      continue;
    }
    const directory = resolve(repositoryRoot, input.directory);
    await visit(directory, input.extensions);
  }
  return files.sort((left, right) => normalizedRelativePath(left).localeCompare(normalizedRelativePath(right)));
}

export async function computeLibwebrtcSdkSourceSha256() {
  const hash = createHash('sha256');
  for (const path of await sourceFiles()) {
    const name = normalizedRelativePath(path);
    // Git checks PowerShell files out as CRLF on Windows. Fingerprint canonical
    // source content so the lock created on Windows verifies on Linux/macOS.
    const originalBytes = await readFile(path);
    const bytes = path.toLowerCase().endsWith('.ps1')
      ? Buffer.from(originalBytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
      : originalBytes;
    hash.update(`${Buffer.byteLength(name, 'utf8')}:`);
    hash.update(name, 'utf8');
    hash.update(`:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function validateLibwebrtcSdkManifest(value, expectedSourceSha256) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'os', 'arch', 'sourceSha256', 'sourceCommit',
      'libwebrtcRevision', 'depotToolsRevision', 'worker', 'virtualDisplay', 'toolchain',
    ])
    || value.manifestVersion !== 1
    || value.os !== 'win32'
    || value.arch !== 'x64'
    || typeof value.sourceSha256 !== 'string' || !SHA256_RE.test(value.sourceSha256)
    || (expectedSourceSha256 !== undefined && value.sourceSha256 !== expectedSourceSha256)
    || typeof value.sourceCommit !== 'string' || !COMMIT_RE.test(value.sourceCommit)
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
    || value.depotToolsRevision !== PINNED_DEPOT_TOOLS_REVISION
    || !isRecord(value.worker)
    || !exactKeys(value.worker, ['fileName', 'size', 'sha256', 'authenticodeSignerSha256'])
    || value.worker.fileName !== REMOTE_DESKTOP_WORKER_FILENAME
    || typeof value.worker.size !== 'number' || !Number.isSafeInteger(value.worker.size) || value.worker.size <= 0
    || typeof value.worker.sha256 !== 'string' || !SHA256_RE.test(value.worker.sha256)
    || typeof value.worker.authenticodeSignerSha256 !== 'string'
    || !SHA256_RE.test(value.worker.authenticodeSignerSha256)
    || !isRecord(value.virtualDisplay)
    || !exactKeys(value.virtualDisplay, [
      'archiveFileName', 'packageManifestFileName', 'size', 'sha256',
    ])
    || value.virtualDisplay.archiveFileName !== REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME
    || value.virtualDisplay.packageManifestFileName !== REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME
    || typeof value.virtualDisplay.size !== 'number'
    || !Number.isSafeInteger(value.virtualDisplay.size) || value.virtualDisplay.size <= 0
    || typeof value.virtualDisplay.sha256 !== 'string'
    || !SHA256_RE.test(value.virtualDisplay.sha256)
    || !isRecord(value.toolchain)
    || !exactKeys(value.toolchain, ['msvc', 'windowsSdk', 'cmake', 'ninja', 'depotTools'])
    || !Object.values(value.toolchain).every((entry) => typeof entry === 'string' && VERSION_RE.test(entry))
    || value.toolchain.depotTools !== PINNED_DEPOT_TOOLS_REVISION) {
    throw new Error('invalid libwebrtc SDK manifest');
  }
  return value;
}

export function validateLibwebrtcSdkLock(value, expectedSourceSha256) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'repository', 'releaseTag', 'assetName', 'sha256',
      'sourceSha256', 'sourceCommit', 'libwebrtcRevision', 'depotToolsRevision',
      'workerSha256', 'virtualDisplaySha256', 'authenticodeSignerSha256', 'toolchain',
    ])
    || value.manifestVersion !== 1
    || value.repository !== 'im4codes/imcodes'
    || typeof value.releaseTag !== 'string' || !RELEASE_TAG_RE.test(value.releaseTag)
    || value.assetName !== LIBWEBRTC_SDK_ARCHIVE_FILENAME
    || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)
    || typeof value.sourceSha256 !== 'string' || !SHA256_RE.test(value.sourceSha256)
    || (expectedSourceSha256 !== undefined && value.sourceSha256 !== expectedSourceSha256)
    || typeof value.sourceCommit !== 'string' || !COMMIT_RE.test(value.sourceCommit)
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
    || value.depotToolsRevision !== PINNED_DEPOT_TOOLS_REVISION
    || typeof value.workerSha256 !== 'string' || !SHA256_RE.test(value.workerSha256)
    || typeof value.virtualDisplaySha256 !== 'string' || !SHA256_RE.test(value.virtualDisplaySha256)
    || typeof value.authenticodeSignerSha256 !== 'string'
    || !SHA256_RE.test(value.authenticodeSignerSha256)
    || !isRecord(value.toolchain)
    || !exactKeys(value.toolchain, ['msvc', 'windowsSdk', 'cmake', 'ninja', 'depotTools'])
    || !Object.values(value.toolchain).every((entry) => typeof entry === 'string' && VERSION_RE.test(entry))
    || value.toolchain.depotTools !== PINNED_DEPOT_TOOLS_REVISION) {
    throw new Error('invalid libwebrtc SDK lock');
  }
  if (value.releaseTag !== `libwebrtc-sdk-windows-x64-${value.sourceSha256.slice(0, 16)}-${value.sha256.slice(0, 16)}`) {
    throw new Error('libwebrtc SDK release tag does not match its source and archive fingerprints');
  }
  return value;
}

export async function verifyLibwebrtcSdkDirectory(directory) {
  const expectedEntries = new Set([
    LIBWEBRTC_SDK_MANIFEST_FILENAME,
    REMOTE_DESKTOP_WORKER_FILENAME,
    REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  ]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== expectedEntries.size
    || entries.some((entry) => !entry.isFile() || !expectedEntries.has(entry.name))) {
    throw new Error('libwebrtc SDK contains unexpected entries');
  }
  const sourceSha256 = await computeLibwebrtcSdkSourceSha256();
  const manifestPath = join(directory, LIBWEBRTC_SDK_MANIFEST_FILENAME);
  const workerPath = join(directory, REMOTE_DESKTOP_WORKER_FILENAME);
  const virtualDisplayPath = join(directory, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME);
  const [manifestStat, workerStat, virtualDisplayStat] = await Promise.all([
    regularFile(manifestPath), regularFile(workerPath), regularFile(virtualDisplayPath),
  ]);
  if (manifestStat.size <= 0 || manifestStat.size > 64 * 1024) {
    throw new Error('libwebrtc SDK manifest size is invalid');
  }
  const manifest = validateLibwebrtcSdkManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    sourceSha256,
  );
  if (workerStat.size !== manifest.worker.size
    || await sha256File(workerPath) !== manifest.worker.sha256) {
    throw new Error('libwebrtc SDK worker hash or size mismatch');
  }
  if (virtualDisplayStat.size !== manifest.virtualDisplay.size
    || await sha256File(virtualDisplayPath) !== manifest.virtualDisplay.sha256) {
    throw new Error('libwebrtc SDK virtual-display hash or size mismatch');
  }
  return { manifest, manifestPath, workerPath, virtualDisplayPath };
}

export async function createLibwebrtcSdkDirectory(releaseDirectory, sdkDirectory, sourceCommit) {
  if (!COMMIT_RE.test(sourceCommit)) throw new Error('source commit must be a full lowercase Git SHA');
  const release = await verifyRemoteDesktopWorkerArtifactSet(releaseDirectory);
  const sourceSha256 = await computeLibwebrtcSdkSourceSha256();
  await rm(sdkDirectory, { recursive: true, force: true });
  await mkdir(sdkDirectory, { recursive: true });
  const workerPath = join(sdkDirectory, REMOTE_DESKTOP_WORKER_FILENAME);
  const virtualDisplayPath = join(sdkDirectory, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME);
  await Promise.all([
    copyFile(release.executablePath, workerPath),
    copyFile(release.archivePath, virtualDisplayPath),
  ]);
  const manifest = {
    manifestVersion: 1,
    os: 'win32',
    arch: 'x64',
    sourceSha256,
    sourceCommit,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    worker: {
      fileName: REMOTE_DESKTOP_WORKER_FILENAME,
      size: release.manifest.size,
      sha256: release.manifest.sha256,
      authenticodeSignerSha256: release.manifest.authenticodeSignerSha256,
    },
    virtualDisplay: { ...release.manifest.virtualDisplay },
    toolchain: { ...release.manifest.toolchain },
  };
  await writeFile(
    join(sdkDirectory, LIBWEBRTC_SDK_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return verifyLibwebrtcSdkDirectory(sdkDirectory);
}

export async function materializeLibwebrtcSdk(sdkDirectory, releaseDirectory, workerVersion) {
  if (!VERSION_RE.test(workerVersion)) throw new Error('invalid worker version');
  const sdk = await verifyLibwebrtcSdkDirectory(sdkDirectory);
  const targetDirectory = join(releaseDirectory, 'remote-desktop-worker', 'win32-x64');
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  const workerPath = join(targetDirectory, REMOTE_DESKTOP_WORKER_FILENAME);
  const virtualDisplayPath = join(targetDirectory, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME);
  await Promise.all([
    copyFile(sdk.workerPath, workerPath),
    copyFile(sdk.virtualDisplayPath, virtualDisplayPath),
  ]);
  const releaseManifest = {
    manifestVersion: 2,
    workerVersion,
    protocolVersion: 2,
    ipcVersion: 1,
    os: 'win32',
    arch: 'x64',
    fileName: REMOTE_DESKTOP_WORKER_FILENAME,
    size: sdk.manifest.worker.size,
    sha256: sdk.manifest.worker.sha256,
    authenticodeSignerSha256: sdk.manifest.worker.authenticodeSignerSha256,
    libwebrtcRevision: sdk.manifest.libwebrtcRevision,
    virtualDisplay: { ...sdk.manifest.virtualDisplay },
    toolchain: { ...sdk.manifest.toolchain },
  };
  await writeFile(
    `${workerPath}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    'utf8',
  );
  return verifyRemoteDesktopWorkerArtifactSet(releaseDirectory, workerVersion);
}

function sdkLockMatchesManifest(lock, manifest) {
  return lock.sourceSha256 === manifest.sourceSha256
    && lock.sourceCommit === manifest.sourceCommit
    && lock.libwebrtcRevision === manifest.libwebrtcRevision
    && lock.depotToolsRevision === manifest.depotToolsRevision
    && lock.workerSha256 === manifest.worker.sha256
    && lock.virtualDisplaySha256 === manifest.virtualDisplay.sha256
    && lock.authenticodeSignerSha256 === manifest.worker.authenticodeSignerSha256
    && Object.keys(lock.toolchain).every((key) => lock.toolchain[key] === manifest.toolchain[key]);
}

export async function createLibwebrtcSdkLock(archivePath, sdkDirectory, outputPath) {
  if (basename(archivePath) !== LIBWEBRTC_SDK_ARCHIVE_FILENAME) {
    throw new Error(`SDK archive must be named ${LIBWEBRTC_SDK_ARCHIVE_FILENAME}`);
  }
  await regularFile(archivePath);
  const sdk = await verifyLibwebrtcSdkDirectory(sdkDirectory);
  const sourceSha256 = sdk.manifest.sourceSha256;
  const archiveSha256 = await sha256File(archivePath);
  const lock = {
    manifestVersion: 1,
    repository: 'im4codes/imcodes',
    releaseTag: `libwebrtc-sdk-windows-x64-${sourceSha256.slice(0, 16)}-${archiveSha256.slice(0, 16)}`,
    assetName: LIBWEBRTC_SDK_ARCHIVE_FILENAME,
    sha256: archiveSha256,
    sourceSha256,
    sourceCommit: sdk.manifest.sourceCommit,
    libwebrtcRevision: PINNED_LIBWEBRTC_REVISION,
    depotToolsRevision: PINNED_DEPOT_TOOLS_REVISION,
    workerSha256: sdk.manifest.worker.sha256,
    virtualDisplaySha256: sdk.manifest.virtualDisplay.sha256,
    authenticodeSignerSha256: sdk.manifest.worker.authenticodeSignerSha256,
    toolchain: { ...sdk.manifest.toolchain },
  };
  validateLibwebrtcSdkLock(lock, sourceSha256);
  await writeFile(outputPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

export async function verifyLibwebrtcSdkLock(lockPath, archivePath, sdkDirectory) {
  const sourceSha256 = await computeLibwebrtcSdkSourceSha256();
  const lock = validateLibwebrtcSdkLock(
    JSON.parse(await readFile(lockPath, 'utf8')),
    sourceSha256,
  );
  if (archivePath !== undefined) {
    await regularFile(archivePath);
    if (basename(archivePath) !== lock.assetName || await sha256File(archivePath) !== lock.sha256) {
      throw new Error('libwebrtc SDK archive does not match the repository lock');
    }
  }
  if (sdkDirectory !== undefined) {
    const sdk = await verifyLibwebrtcSdkDirectory(sdkDirectory);
    if (!sdkLockMatchesManifest(lock, sdk.manifest)) {
      throw new Error('libwebrtc SDK contents do not match the repository lock');
    }
  }
  return lock;
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command === 'fingerprint' && args.length === 0) {
    process.stdout.write(`${await computeLibwebrtcSdkSourceSha256()}\n`);
    return;
  }
  if (command === 'create' && args.length === 3) {
    await createLibwebrtcSdkDirectory(args[0], args[1], args[2]);
    process.stdout.write(`created ${resolve(args[1])}\n`);
    return;
  }
  if (command === 'verify' && args.length === 1) {
    const result = await verifyLibwebrtcSdkDirectory(args[0]);
    process.stdout.write(`verified ${result.manifest.sourceSha256}\n`);
    return;
  }
  if (command === 'materialize' && args.length === 3) {
    const result = await materializeLibwebrtcSdk(args[0], args[1], args[2]);
    process.stdout.write(`materialized ${result.executablePath}\n`);
    return;
  }
  if (command === 'create-lock' && args.length === 3) {
    const lock = await createLibwebrtcSdkLock(args[0], args[1], args[2]);
    process.stdout.write(`${JSON.stringify(lock)}\n`);
    return;
  }
  if (command === 'verify-lock' && args.length >= 1 && args.length <= 3) {
    const lock = await verifyLibwebrtcSdkLock(args[0], args[1], args[2]);
    process.stdout.write(`${JSON.stringify(lock)}\n`);
    return;
  }
  throw new Error(
    'usage: libwebrtc-sdk-artifacts.mjs '
      + '<fingerprint|create <release-dir> <sdk-dir> <commit>|verify <sdk-dir>|'
      + 'materialize <sdk-dir> <release-dir> <version>|'
      + 'create-lock <archive> <sdk-dir> <lock>|verify-lock <lock> [archive] [sdk-dir]>',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
