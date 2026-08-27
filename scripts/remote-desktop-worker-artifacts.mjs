#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import macosIdentity from '../shared/remote-desktop-macos-identity.json' with { type: 'json' };
import nativePins from '../shared/remote-desktop-native-pins.json' with { type: 'json' };

export const REMOTE_DESKTOP_WORKER_FILENAME = 'imcodes-remote-desktop-worker.exe';
export const REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX = '.manifest.json';
// Bumped 3 -> 4 when the virtual-display helper became a shipped component.
// A manifest that omits it is not merely older, it describes a component set
// that cannot provide display control, so old and new must not be
// interchangeable across self-upgrade.
export const REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION = 4;
export const REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND = 'macos-component-set';
export const REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME = 'imcodes-remote-desktop.manifest.json';
export const REMOTE_DESKTOP_MACOS_WORKER_FILENAME = 'imcodes-remote-desktop-worker';
export const REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME = 'imcodes-remote-desktop-launch-agent';
export const REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME = 'imcodes-remote-desktop-disclosure';
export const REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME = 'imcodes-virtual-display-helper';
export const REMOTE_DESKTOP_MACOS_ARCHITECTURES = Object.freeze(['arm64', 'x64']);
export const REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS = Object.freeze({
  worker: 512 * 1024 * 1024,
  launchAgent: 128 * 1024 * 1024,
  disclosure: 128 * 1024 * 1024,
  virtualDisplayHelper: 128 * 1024 * 1024,
});
const REMOTE_DESKTOP_MACOS_COMPONENT_FILES = Object.freeze({
  worker: REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
  launchAgent: REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
  disclosure: REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
  virtualDisplayHelper: REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
});
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME = 'imcodes-virtual-display.zip';
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME = 'imcodes-virtual-display.manifest.json';
const GIT_REVISION_RE = /^[a-f0-9]{40}$/;
if (!GIT_REVISION_RE.test(nativePins.libwebrtcRevision)
  || !GIT_REVISION_RE.test(nativePins.depotToolsRevision)) {
  throw new Error('invalid remote desktop native revision pins');
}
export const PINNED_LIBWEBRTC_REVISION = nativePins.libwebrtcRevision;
export const PINNED_DEPOT_TOOLS_REVISION = nativePins.depotToolsRevision;

const SHA256_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const MACOS_VERSION_RE = /^(?:1[0-9]|[2-9][0-9])\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/;
const APPLE_TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const APPLE_BUNDLE_ID_RE = /^(?=.{3,255}$)(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z0-9][A-Za-z0-9-]*$/;
const NOTARIZATION_SUBMISSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const WINDOWS_TARGET = Object.freeze({ os: 'win32', arch: 'x64' });

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const expected = new Set(keys);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

if (!isRecord(macosIdentity)
  || !exactKeys(macosIdentity, ['teamId'])
  || typeof macosIdentity.teamId !== 'string'
  || !APPLE_TEAM_ID_RE.test(macosIdentity.teamId)) {
  throw new Error('invalid remote desktop macos identity');
}
export const REMOTE_DESKTOP_MACOS_TEAM_ID = macosIdentity.teamId;

function validPositiveSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validAppleDesignatedRequirement(value, bundleIdentifier, teamId) {
  return value === `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

function validMacosCodeSignature(value) {
  if (!isRecord(value)
    || !exactKeys(value, ['teamId', 'bundles'])
    || value.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || !isRecord(value.bundles)
    || !exactKeys(value.bundles, ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'])) return false;
  const bundleIdentifiers = new Set();
  for (const kind of ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper']) {
    const bundle = value.bundles[kind];
    if (!isRecord(bundle)
      || !exactKeys(bundle, ['bundleIdentifier', 'designatedRequirement', 'hardenedRuntime'])
      || typeof bundle.bundleIdentifier !== 'string'
      || !APPLE_BUNDLE_ID_RE.test(bundle.bundleIdentifier)
      || bundleIdentifiers.has(bundle.bundleIdentifier)
      || bundle.hardenedRuntime !== true
      || !validAppleDesignatedRequirement(
        bundle.designatedRequirement,
        bundle.bundleIdentifier,
        REMOTE_DESKTOP_MACOS_TEAM_ID,
      )) return false;
    bundleIdentifiers.add(bundle.bundleIdentifier);
  }
  return true;
}

function validMacosComponent(value, kind) {
  return isRecord(value)
    && exactKeys(value, ['fileName', 'size', 'sha256', 'notarization'])
    && value.fileName === REMOTE_DESKTOP_MACOS_COMPONENT_FILES[kind]
    && validPositiveSize(value.size)
    && value.size <= REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS[kind]
    && typeof value.sha256 === 'string'
    && SHA256_RE.test(value.sha256)
    && validMacosNotarization(value.notarization);
}

function validMacosNotarization(value) {
  return isRecord(value)
    && exactKeys(value, ['status', 'submissionId', 'ticketSha256', 'stapled', 'stapleValidated'])
    && value.status === 'accepted'
    && typeof value.submissionId === 'string'
    && NOTARIZATION_SUBMISSION_ID_RE.test(value.submissionId)
    && typeof value.ticketSha256 === 'string'
    && SHA256_RE.test(value.ticketSha256)
    && value.stapled === true
    && value.stapleValidated === true;
}

function validArtifactTarget(value) {
  return isRecord(value)
    && exactKeys(value, ['os', 'arch'])
    && ((value.os === 'win32' && value.arch === 'x64')
      || (value.os === 'darwin' && REMOTE_DESKTOP_MACOS_ARCHITECTURES.includes(value.arch)));
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

function validateWindowsRemoteDesktopWorkerReleaseManifest(value, expectedVersion) {
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
    || !validPositiveSize(value.size)
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
    return null;
  }
  return value;
}

function validateMacosRemoteDesktopWorkerReleaseManifest(value, expectedVersion) {
  if (!isRecord(value)
    || !exactKeys(value, [
      'manifestVersion', 'artifactKind', 'workerVersion', 'protocolVersion', 'ipcVersion',
      'os', 'arch', 'components', 'libwebrtcRevision', 'minimumOsVersion',
      'codeSignature', 'toolchain',
    ])
    || value.manifestVersion !== REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION
    || value.artifactKind !== REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND
    || typeof value.workerVersion !== 'string' || !VERSION_RE.test(value.workerVersion)
    || (expectedVersion !== undefined && value.workerVersion !== expectedVersion)
    || value.protocolVersion !== 2
    || value.ipcVersion !== 1
    || value.os !== 'darwin'
    || !REMOTE_DESKTOP_MACOS_ARCHITECTURES.includes(value.arch)
    || !isRecord(value.components)
    || !exactKeys(value.components, ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'])
    || !['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'].every(
      (kind) => validMacosComponent(value.components[kind], kind),
    )
    || value.libwebrtcRevision !== PINNED_LIBWEBRTC_REVISION
    || typeof value.minimumOsVersion !== 'string' || !MACOS_VERSION_RE.test(value.minimumOsVersion)
    || !validMacosCodeSignature(value.codeSignature)
    || !isRecord(value.toolchain)
    || !exactKeys(value.toolchain, ['xcode', 'macosSdk', 'clang'])
    || !Object.values(value.toolchain).every(
      (entry) => typeof entry === 'string' && VERSION_RE.test(entry),
    )) return null;
  return value;
}

export function validateRemoteDesktopWorkerReleaseManifest(
  value,
  expectedVersion,
  expectedTarget = WINDOWS_TARGET,
) {
  if (!validArtifactTarget(expectedTarget)) {
    throw new Error('invalid remote desktop worker artifact target');
  }
  const manifest = expectedTarget.os === 'win32'
    ? validateWindowsRemoteDesktopWorkerReleaseManifest(value, expectedVersion)
    : validateMacosRemoteDesktopWorkerReleaseManifest(value, expectedVersion);
  if (!manifest || manifest.os !== expectedTarget.os || manifest.arch !== expectedTarget.arch) {
    throw new Error('invalid remote desktop worker manifest');
  }
  return manifest;
}

export async function verifyRemoteDesktopWorkerArtifactSet(
  directory,
  expectedVersion,
  expectedTarget = WINDOWS_TARGET,
) {
  if (!validArtifactTarget(expectedTarget)) {
    throw new Error('invalid remote desktop worker artifact target');
  }
  const isWindows = expectedTarget.os === 'win32';
  const platformDirectory = join(
    directory,
    'remote-desktop-worker',
    `${expectedTarget.os}-${expectedTarget.arch}`,
  );
  const executablePath = isWindows
    ? join(platformDirectory, REMOTE_DESKTOP_WORKER_FILENAME)
    : undefined;
  const manifestPath = isWindows
    ? `${executablePath}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`
    : join(platformDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME);
  const archivePath = isWindows
    ? join(platformDirectory, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME)
    : undefined;
  const expectedEntries = new Set([
    ...(isWindows
      ? [
        REMOTE_DESKTOP_WORKER_FILENAME,
        `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`,
        REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      ]
      : [REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME, ...Object.values(REMOTE_DESKTOP_MACOS_COMPONENT_FILES)]),
  ]);
  const entries = await readdir(platformDirectory, { withFileTypes: true });
  if (entries.length !== expectedEntries.size
    || entries.some((entry) => !entry.isFile() || !expectedEntries.has(entry.name))) {
    throw new Error('remote desktop worker artifact set contains unexpected entries');
  }
  const componentPaths = isWindows ? undefined : Object.fromEntries(
    Object.entries(REMOTE_DESKTOP_MACOS_COMPONENT_FILES).map(([kind, fileName]) => [
      kind,
      join(platformDirectory, fileName),
    ]),
  );
  const [executableStat, manifestStat, archiveStat, componentStats] = await Promise.all([
    executablePath === undefined ? Promise.resolve(undefined) : lstat(executablePath),
    lstat(manifestPath),
    archivePath === undefined ? Promise.resolve(undefined) : lstat(archivePath),
    componentPaths === undefined
      ? Promise.resolve(undefined)
      : Promise.all(Object.values(componentPaths).map((path) => lstat(path))),
  ]);
  if ((executableStat !== undefined && (!executableStat.isFile() || executableStat.isSymbolicLink()))
    || !manifestStat.isFile() || manifestStat.isSymbolicLink()
    || (archiveStat !== undefined && (!archiveStat.isFile() || archiveStat.isSymbolicLink()))
    || componentStats?.some((stat) => !stat.isFile() || stat.isSymbolicLink())) {
    throw new Error('remote desktop worker artifact set contains a non-regular file');
  }
  const manifest = validateRemoteDesktopWorkerReleaseManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    expectedVersion,
    expectedTarget,
  );
  if (isWindows && executableStat !== undefined && manifest.size !== executableStat.size) {
    throw new Error(`remote desktop worker size mismatch: expected ${manifest.size}, got ${executableStat.size}`);
  }
  if (isWindows && archiveStat !== undefined
    && manifest.virtualDisplay.size !== archiveStat.size) {
    throw new Error(`virtual display archive size mismatch: expected ${manifest.virtualDisplay.size}, got ${archiveStat.size}`);
  }
  if (isWindows && executablePath !== undefined) {
    const actualSha256 = await sha256File(executablePath);
    if (actualSha256 !== manifest.sha256) {
      throw new Error(`remote desktop worker sha256 mismatch: expected ${manifest.sha256}, got ${actualSha256}`);
    }
  } else if (componentPaths !== undefined && componentStats !== undefined) {
    for (const [index, kind] of ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'].entries()) {
      const component = manifest.components[kind];
      const stat = componentStats[index];
      if (stat.size !== component.size) {
        throw new Error(`remote desktop ${kind} size mismatch: expected ${component.size}, got ${stat.size}`);
      }
      const actualSha256 = await sha256File(componentPaths[kind]);
      if (actualSha256 !== component.sha256) {
        throw new Error(`remote desktop ${kind} sha256 mismatch: expected ${component.sha256}, got ${actualSha256}`);
      }
    }
  }
  if (isWindows && archivePath !== undefined) {
    const archiveSha256 = await sha256File(archivePath);
    if (archiveSha256 !== manifest.virtualDisplay.sha256) {
      throw new Error(`virtual display archive sha256 mismatch: expected ${manifest.virtualDisplay.sha256}, got ${archiveSha256}`);
    }
  }
  return { executablePath, componentPaths, manifestPath, archivePath, manifest };
}

async function main() {
  const [, , command, directory, expectedVersion, os, arch] = process.argv;
  if (command !== 'verify' || !directory) {
    throw new Error('usage: remote-desktop-worker-artifacts.mjs verify <artifact-directory> [expected-version] [os arch]');
  }
  if ((os === undefined) !== (arch === undefined)) {
    throw new Error('remote desktop worker artifact target requires both os and arch');
  }
  const target = os === undefined ? WINDOWS_TARGET : { os, arch };
  const result = await verifyRemoteDesktopWorkerArtifactSet(directory, expectedVersion, target);
  const verifiedPath = result.executablePath ?? result.componentPaths.worker;
  const verifiedSha256 = result.manifest.sha256 ?? result.manifest.components.worker.sha256;
  process.stdout.write(`verified ${verifiedPath} (${verifiedSha256})\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
