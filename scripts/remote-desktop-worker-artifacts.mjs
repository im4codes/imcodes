#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMOTE_DESKTOP_WORKER_FILENAME = 'imcodes-remote-desktop-worker.exe';
export const REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX = '.manifest.json';
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME = 'imcodes-virtual-display.zip';
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME = 'imcodes-virtual-display.manifest.json';
export const PINNED_LIBWEBRTC_REVISION = 'f20ebb8adbf4fa781830e4384c61f732bd28a217';
export const PINNED_DEPOT_TOOLS_REVISION = 'a1bda5b6167435ad0666191f0353f242104f5845';

const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export function validateRemoteDesktopWorkerReleaseManifest(value, expectedVersion) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'workerVersion', 'protocolVersion', 'ipcVersion', 'os', 'arch',
      'fileName', 'size', 'sha256', 'authenticodeSignerSha256', 'libwebrtcRevision',
      'virtualDisplay', 'toolchain',
    ])
    || value.manifestVersion !== 2
    || typeof value.workerVersion !== 'string' || !VERSION_RE.test(value.workerVersion)
    || (expectedVersion !== undefined && value.workerVersion !== expectedVersion)
    || value.protocolVersion !== 2
    || value.ipcVersion !== 1
    || value.os !== 'win32'
    || value.arch !== 'x64'
    || value.fileName !== REMOTE_DESKTOP_WORKER_FILENAME
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0
    || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)
    || typeof value.authenticodeSignerSha256 !== 'string'
    || !SHA256_RE.test(value.authenticodeSignerSha256)
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
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
    throw new Error('invalid remote desktop worker manifest');
  }
  return value;
}

export async function verifyRemoteDesktopWorkerArtifactSet(directory, expectedVersion) {
  const platformDirectory = join(directory, 'remote-desktop-worker', 'win32-x64');
  const executablePath = join(platformDirectory, REMOTE_DESKTOP_WORKER_FILENAME);
  const manifestPath = `${executablePath}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
  const archivePath = join(platformDirectory, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME);
  const expectedEntries = new Set([
    REMOTE_DESKTOP_WORKER_FILENAME,
    `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
    REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  ]);
  const entries = await readdir(platformDirectory, { withFileTypes: true });
  if (entries.length !== expectedEntries.size
    || entries.some((entry) => !entry.isFile() || !expectedEntries.has(entry.name))) {
    throw new Error('remote desktop worker artifact set contains unexpected entries');
  }
  const [executableStat, manifestStat, archiveStat] = await Promise.all([
    lstat(executablePath),
    lstat(manifestPath),
    lstat(archivePath),
  ]);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()
    || !manifestStat.isFile() || manifestStat.isSymbolicLink()
    || !archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw new Error('remote desktop worker artifact set contains a non-regular file');
  }
  const manifest = validateRemoteDesktopWorkerReleaseManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    expectedVersion,
  );
  if (manifest.size !== executableStat.size) {
    throw new Error(`remote desktop worker size mismatch: expected ${manifest.size}, got ${executableStat.size}`);
  }
  if (manifest.virtualDisplay.size !== archiveStat.size) {
    throw new Error(`virtual display archive size mismatch: expected ${manifest.virtualDisplay.size}, got ${archiveStat.size}`);
  }
  const actualSha256 = await sha256File(executablePath);
  if (actualSha256 !== manifest.sha256) {
    throw new Error(`remote desktop worker sha256 mismatch: expected ${manifest.sha256}, got ${actualSha256}`);
  }
  const archiveSha256 = await sha256File(archivePath);
  if (archiveSha256 !== manifest.virtualDisplay.sha256) {
    throw new Error(`virtual display archive sha256 mismatch: expected ${manifest.virtualDisplay.sha256}, got ${archiveSha256}`);
  }
  return { executablePath, manifestPath, archivePath, manifest };
}

async function main() {
  const [, , command, directory, expectedVersion] = process.argv;
  if (command !== 'verify' || !directory) {
    throw new Error('usage: remote-desktop-worker-artifacts.mjs verify <artifact-directory> [expected-version]');
  }
  const result = await verifyRemoteDesktopWorkerArtifactSet(directory, expectedVersion);
  process.stdout.write(`verified ${result.executablePath} (${result.manifest.sha256})\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
