import { REMOTE_DESKTOP_PROTOCOL_VERSION } from './remote-desktop.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from './remote-desktop-qualification.js';

export const REMOTE_DESKTOP_WORKER_IPC_VERSION = 1 as const;
// Nodes already deployed with remote-desktop protocol v1 request upgrade
// artifacts without an explicit protocol header. The server gives those nodes
// a v1-shaped manifest so their embedded strict validator can complete the
// one-hop upgrade to a v2 worker. The signed worker handshake still uses the
// current protocol and is independently checked after the new Node starts.
export const REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_DESKTOP_WORKER_FILENAME = 'imcodes-remote-desktop-worker.exe' as const;
export const REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX = '.manifest.json' as const;
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME = 'imcodes-virtual-display.zip' as const;
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME = 'imcodes-virtual-display.manifest.json' as const;
export const REMOTE_DESKTOP_WORKER_HELLO_TYPE = 'remote_desktop.worker_hello' as const;

export interface RemoteDesktopWorkerManifest {
  manifestVersion: 2;
  workerVersion: string;
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  os: 'win32';
  arch: 'x64';
  fileName: typeof REMOTE_DESKTOP_WORKER_FILENAME;
  size: number;
  sha256: string;
  authenticodeSignerSha256: string;
  libwebrtcRevision: string;
  virtualDisplay: {
    archiveFileName: typeof REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME;
    packageManifestFileName: typeof REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME;
    size: number;
    sha256: string;
  };
  toolchain: {
    msvc: string;
    windowsSdk: string;
    cmake: string;
    ninja: string;
    depotTools: string;
  };
}

export interface RemoteDesktopWorkerHello {
  type: typeof REMOTE_DESKTOP_WORKER_HELLO_TYPE;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  nonce: string;
  pid: number;
}

export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES = [
  'imcodes-virtual-display.dll',
  'imcodes-virtual-display.inf',
  'imcodes-virtual-display.cat',
  'LICENSE.microsoft.txt',
  'THIRD_PARTY_NOTICES.webrtc.md',
] as const;

export interface RemoteDesktopVirtualDisplayPackageManifest {
  manifestVersion: 1;
  hardwareId: 'ImcodesVirtualDisplay';
  dllSignerSha256: string;
  catalogSignerSha256: string;
  files: Array<{
    name: typeof REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES[number];
    size: number;
    sha256: string;
  }>;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const wanted = new Set(keys);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => wanted.has(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateRemoteDesktopVirtualDisplayPackageManifest(
  value: unknown,
): RemoteDesktopVirtualDisplayPackageManifest | null {
  if (!record(value)
    || !exactKeys(value, [
      'manifestVersion', 'hardwareId', 'dllSignerSha256',
      'catalogSignerSha256', 'files',
    ])
    || value.manifestVersion !== 1
    || value.hardwareId !== 'ImcodesVirtualDisplay'
    || typeof value.dllSignerSha256 !== 'string' || !SHA256_RE.test(value.dllSignerSha256)
    || typeof value.catalogSignerSha256 !== 'string' || !SHA256_RE.test(value.catalogSignerSha256)
    || !Array.isArray(value.files)
    || value.files.length !== REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES.length) return null;
  const expected = new Set<string>(REMOTE_DESKTOP_VIRTUAL_DISPLAY_FILES);
  const seen = new Set<string>();
  for (const entry of value.files) {
    if (!record(entry) || !exactKeys(entry, ['name', 'size', 'sha256'])
      || typeof entry.name !== 'string' || !expected.has(entry.name) || seen.has(entry.name)
      || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0
      || typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) return null;
    seen.add(entry.name);
  }
  return value as unknown as RemoteDesktopVirtualDisplayPackageManifest;
}

export function validateRemoteDesktopWorkerManifest(value: unknown): RemoteDesktopWorkerManifest | null {
  if (!record(value)
    || !exactKeys(value, [
      'manifestVersion', 'workerVersion', 'protocolVersion', 'ipcVersion', 'os', 'arch',
      'fileName', 'size', 'sha256', 'authenticodeSignerSha256', 'libwebrtcRevision',
      'virtualDisplay', 'toolchain',
    ])
    || value.manifestVersion !== 2
    || typeof value.workerVersion !== 'string' || !VERSION_RE.test(value.workerVersion)
    || value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
    || value.ipcVersion !== REMOTE_DESKTOP_WORKER_IPC_VERSION
    || value.os !== 'win32'
    || value.arch !== 'x64'
    || value.fileName !== REMOTE_DESKTOP_WORKER_FILENAME
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0
    || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)
    || typeof value.authenticodeSignerSha256 !== 'string'
    || !SHA256_RE.test(value.authenticodeSignerSha256)
    || value.libwebrtcRevision !== WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision
    || !record(value.virtualDisplay)
    || !exactKeys(value.virtualDisplay, [
      'archiveFileName', 'packageManifestFileName', 'size', 'sha256',
    ])
    || value.virtualDisplay.archiveFileName !== REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME
    || value.virtualDisplay.packageManifestFileName !== REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME
    || typeof value.virtualDisplay.size !== 'number'
    || !Number.isSafeInteger(value.virtualDisplay.size) || value.virtualDisplay.size <= 0
    || typeof value.virtualDisplay.sha256 !== 'string'
    || !SHA256_RE.test(value.virtualDisplay.sha256)
    || !record(value.toolchain)
    || !exactKeys(value.toolchain, ['msvc', 'windowsSdk', 'cmake', 'ninja', 'depotTools'])
    || !Object.values(value.toolchain).every((entry) => typeof entry === 'string' && VERSION_RE.test(entry))
    || value.toolchain.depotTools
      !== WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision) {
    return null;
  }
  return value as unknown as RemoteDesktopWorkerManifest;
}

/**
 * Convert the one-hop v1 manifest served only to the already-deployed v94 node
 * into the canonical v2 runtime contract. This is deliberately not part of the
 * general manifest validator: the exception is accepted only when the worker
 * was built for the exact Node version that is starting it. A stale or copied
 * v1 package therefore cannot remain a permanently accepted runtime format.
 */
export function upgradeLegacyRemoteDesktopWorkerManifest(
  value: unknown,
  expectedWorkerVersion: string,
): RemoteDesktopWorkerManifest | null {
  if (!record(value)
    || value.protocolVersion !== REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION
    || value.workerVersion !== expectedWorkerVersion) return null;
  return validateRemoteDesktopWorkerManifest({
    ...value,
    protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
  });
}

export function validateRemoteDesktopWorkerHello(
  value: unknown,
  expectedNonce: string,
): value is RemoteDesktopWorkerHello {
  return record(value)
    && exactKeys(value, ['type', 'ipcVersion', 'nonce', 'pid'])
    && value.type === REMOTE_DESKTOP_WORKER_HELLO_TYPE
    && value.ipcVersion === REMOTE_DESKTOP_WORKER_IPC_VERSION
    && typeof value.nonce === 'string'
    && NONCE_RE.test(value.nonce)
    && value.nonce === expectedNonce
    && typeof value.pid === 'number'
    && Number.isSafeInteger(value.pid)
    && value.pid > 0;
}
