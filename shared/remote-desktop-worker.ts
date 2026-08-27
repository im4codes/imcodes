import { REMOTE_DESKTOP_PROTOCOL_VERSION } from './remote-desktop.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from './remote-desktop-qualification.js';
import macosIdentity from './remote-desktop-macos-identity.json' with { type: 'json' };

export const REMOTE_DESKTOP_WORKER_IPC_VERSION = 1 as const;
// Nodes already deployed with remote-desktop protocol v1 request upgrade
// artifacts without an explicit protocol header. The server gives those nodes
// a v1-shaped manifest so their embedded strict validator can complete the
// one-hop upgrade to a v2 worker. The signed worker handshake still uses the
// current protocol and is independently checked after the new Node starts.
export const REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION = 1 as const;
export const REMOTE_DESKTOP_WORKER_FILENAME = 'imcodes-remote-desktop-worker.exe' as const;
export const REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX = '.manifest.json' as const;
// Bumped 3 -> 4 when the virtual-display helper became a shipped component of
// the atomic macOS component set. A v3 manifest is not merely older: it
// describes a set with no display-control component, so old and new must not be
// interchangeable across self-upgrade. Kept byte-identical to the producer-side
// constant in scripts/remote-desktop-worker-artifacts.mjs; they drifted once
// (shared 3 vs producer 4) and every strict validation silently returned null.
export const REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION = 4 as const;
export const REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND = 'macos-component-set' as const;
export const REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME = 'imcodes-remote-desktop.manifest.json' as const;
export const REMOTE_DESKTOP_MACOS_WORKER_FILENAME = 'imcodes-remote-desktop-worker' as const;
export const REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME = 'imcodes-remote-desktop-launch-agent' as const;
export const REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME = 'imcodes-remote-desktop-disclosure' as const;
export const REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME = 'imcodes-virtual-display-helper' as const;
/**
 * The ONE Apple Developer Team that may sign remote-desktop components.
 *
 * A manifest is attacker-reachable input: it travels with the artifact it
 * describes. Every other field in it is cross-checked against something the
 * daemon already knows, but the team id used to be taken on the manifest's
 * word and only shape-checked against /^[A-Z0-9]{10}$/. That let a component
 * set signed by ANY Apple team declare its own team, derive a matching
 * designated requirement, and satisfy every downstream comparison -- because
 * the thing being compared against came from the same untrusted file.
 *
 * Pinning the value here makes the expectation independent of the manifest, so
 * a foreign-team component set fails closed instead of defining its own bar.
 */
export const REMOTE_DESKTOP_MACOS_TEAM_ID = macosIdentity.teamId;
export const REMOTE_DESKTOP_MACOS_ARCHITECTURES = ['arm64', 'x64'] as const;
export const REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS = Object.freeze({
  worker: 512 * 1024 * 1024,
  launchAgent: 128 * 1024 * 1024,
  disclosure: 128 * 1024 * 1024,
  virtualDisplayHelper: 128 * 1024 * 1024,
} as const);
export const REMOTE_DESKTOP_MACOS_COMPONENT_ORDER = Object.freeze([
  'worker',
  'launchAgent',
  'disclosure',
  'virtualDisplayHelper',
] as const);
export const REMOTE_DESKTOP_MACOS_COMPONENT_SET_ARCHIVE_MAGIC = Object.freeze([
  0x49, 0x4d, 0x43, 0x4f, 0x44, 0x45, 0x53, 0x2d,
  0x4d, 0x41, 0x43, 0x4f, 0x53, 0x2d, 0x52, 0x44,
  0x2d, 0x53, 0x45, 0x54, 0x2d, 0x56, 0x31, 0x0a,
] as const);
export const REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES = 64 * 1024;
export const REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES =
  REMOTE_DESKTOP_MACOS_COMPONENT_SET_ARCHIVE_MAGIC.length + 4;
export const REMOTE_DESKTOP_MACOS_COMPONENT_SET_MAX_BYTES =
  REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES
  + REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES
  + Object.values(REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS).reduce((total, size) => total + size, 0);
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME = 'imcodes-virtual-display.zip' as const;
export const REMOTE_DESKTOP_VIRTUAL_DISPLAY_MANIFEST_FILENAME = 'imcodes-virtual-display.manifest.json' as const;
export const REMOTE_DESKTOP_WORKER_HELLO_TYPE = 'remote_desktop.worker_hello' as const;
// Last words of a worker that hit a structured exception. The worker writes one
// bounded frame from its unhandled-exception filter and then terminates, so a
// native fault is diagnosable without a debugger and never looks like a plain
// disconnect. It carries no session, capability, media, or input data.
export const REMOTE_DESKTOP_WORKER_CRASH_TYPE = 'remote_desktop.worker_crash' as const;

export interface RemoteDesktopWindowsWorkerManifest {
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

/**
 * Historical name retained for Windows-only consumers. Those consumers still
 * resolve the v2 PE/virtual-display artifact and must not accidentally accept a
 * macOS artifact before the platform host exists.
 */
export type RemoteDesktopWorkerManifest = RemoteDesktopWindowsWorkerManifest;

export type RemoteDesktopMacosArchitecture = typeof REMOTE_DESKTOP_MACOS_ARCHITECTURES[number];

export interface RemoteDesktopMacosCodeIdentity {
  teamId: string;
  bundles: {
    worker: {
      bundleIdentifier: string;
      designatedRequirement: string;
      hardenedRuntime: true;
    };
    launchAgent: {
      bundleIdentifier: string;
      designatedRequirement: string;
      hardenedRuntime: true;
    };
    disclosure: {
      bundleIdentifier: string;
      designatedRequirement: string;
      hardenedRuntime: true;
    };
    virtualDisplayHelper: {
      bundleIdentifier: string;
      designatedRequirement: string;
      hardenedRuntime: true;
    };
  };
}

export interface RemoteDesktopMacosNotarizationEvidence {
  status: 'accepted';
  submissionId: string;
  ticketSha256: string;
  stapled: true;
  stapleValidated: true;
}

export interface RemoteDesktopMacosWorkerManifest {
  manifestVersion: typeof REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION;
  artifactKind: typeof REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND;
  workerVersion: string;
  protocolVersion: typeof REMOTE_DESKTOP_PROTOCOL_VERSION;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  os: 'darwin';
  arch: RemoteDesktopMacosArchitecture;
  components: {
    worker: {
      fileName: typeof REMOTE_DESKTOP_MACOS_WORKER_FILENAME;
      size: number;
      sha256: string;
      notarization: RemoteDesktopMacosNotarizationEvidence;
    };
    launchAgent: {
      fileName: typeof REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME;
      size: number;
      sha256: string;
      notarization: RemoteDesktopMacosNotarizationEvidence;
    };
    disclosure: {
      fileName: typeof REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME;
      size: number;
      sha256: string;
      notarization: RemoteDesktopMacosNotarizationEvidence;
    };
    virtualDisplayHelper: {
      fileName: typeof REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME;
      size: number;
      sha256: string;
      notarization: RemoteDesktopMacosNotarizationEvidence;
    };
  };
  libwebrtcRevision: string;
  minimumOsVersion: string;
  codeSignature: RemoteDesktopMacosCodeIdentity;
  toolchain: {
    xcode: string;
    macosSdk: string;
    clang: string;
  };
}

export function remoteDesktopMacosComponentSetFilename(
  arch: RemoteDesktopMacosArchitecture,
): string {
  return `imcodes-remote-desktop-darwin-${arch}.set`;
}

export function encodeRemoteDesktopMacosComponentSetPrefix(
  manifestSize: number,
): Uint8Array {
  if (!Number.isSafeInteger(manifestSize)
    || manifestSize <= 0
    || manifestSize > REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES) {
    throw new Error('remote_desktop_macos_component_set_manifest_size_invalid');
  }
  const prefix = new Uint8Array(REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES);
  prefix.set(REMOTE_DESKTOP_MACOS_COMPONENT_SET_ARCHIVE_MAGIC, 0);
  new DataView(prefix.buffer).setUint32(
    REMOTE_DESKTOP_MACOS_COMPONENT_SET_ARCHIVE_MAGIC.length,
    manifestSize,
    false,
  );
  return prefix;
}

export function decodeRemoteDesktopMacosComponentSetPrefix(
  prefix: Uint8Array,
): { manifestSize: number } | null {
  if (prefix.byteLength !== REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES
    || REMOTE_DESKTOP_MACOS_COMPONENT_SET_ARCHIVE_MAGIC.some(
      (byte, index) => prefix[index] !== byte,
    )) return null;
  const manifestSize = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  ).getUint32(REMOTE_DESKTOP_MACOS_COMPONENT_SET_ARCHIVE_MAGIC.length, false);
  return Number.isSafeInteger(manifestSize)
    && manifestSize > 0
    && manifestSize <= REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES
    ? { manifestSize }
    : null;
}

export function remoteDesktopMacosComponentSetSize(
  manifest: RemoteDesktopMacosWorkerManifest,
  manifestSize: number,
): number {
  encodeRemoteDesktopMacosComponentSetPrefix(manifestSize);
  const total = REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.reduce(
    (size, kind) => size + manifest.components[kind].size,
    REMOTE_DESKTOP_MACOS_COMPONENT_SET_PREFIX_BYTES + manifestSize,
  );
  if (!Number.isSafeInteger(total) || total > REMOTE_DESKTOP_MACOS_COMPONENT_SET_MAX_BYTES) {
    throw new Error('remote_desktop_macos_component_set_size_invalid');
  }
  return total;
}

/** Strictly versioned and platform/architecture-discriminated release shape. */
export type RemoteDesktopWorkerReleaseManifest =
  | RemoteDesktopWindowsWorkerManifest
  | RemoteDesktopMacosWorkerManifest;

export type RemoteDesktopWorkerArtifactTarget =
  | { os: 'win32'; arch: 'x64' }
  | { os: 'darwin'; arch: RemoteDesktopMacosArchitecture };

export interface RemoteDesktopWorkerCrash {
  type: typeof REMOTE_DESKTOP_WORKER_CRASH_TYPE;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  nonce: string;
  pid: number;
  /** Windows structured exception code, e.g. 0xC0000005 access violation. */
  exceptionCode: number;
  /** Base name of the module the faulting address belongs to. */
  module: string;
  /** Faulting address relative to that module's base. */
  moduleOffset: number;
}

export interface RemoteDesktopWorkerHello {
  type: typeof REMOTE_DESKTOP_WORKER_HELLO_TYPE;
  ipcVersion: typeof REMOTE_DESKTOP_WORKER_IPC_VERSION;
  nonce: string;
  pid: number;
  /**
   * Which desktop this worker actually landed on. The service decides at launch
   * but the decision can be stale by the time the process exists, and the
   * replacement after a desktop switch has to go to the *other* desktop.
   * Absent from workers built before the handover existed.
   */
  secureConsole?: boolean;
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
const CRASH_MODULE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MACOS_VERSION_RE = /^(?:1[0-9]|[2-9][0-9])\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/;
const APPLE_BUNDLE_ID_RE = /^(?=.{3,255}$)(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z0-9][A-Za-z0-9-]*$/;
const NOTARIZATION_SUBMISSION_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const wanted = new Set([...keys, ...optional]);
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => wanted.has(key));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPositiveSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validAppleDesignatedRequirement(
  value: unknown,
  bundleIdentifier: string,
  teamId: string,
): value is string {
  return value === `identifier "${bundleIdentifier}" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`;
}

function validateMacosCodeIdentity(value: unknown): value is RemoteDesktopMacosCodeIdentity {
  if (!record(value)
    || !exactKeys(value, ['teamId', 'bundles'])
    // EXACT, not shaped. A manifest is attacker-reachable input that travels
    // with the artifact it describes, and every designated requirement below is
    // derived from THIS field -- so a foreign team that names itself here is
    // self-consistent and satisfies every downstream comparison. Shape-checking
    // it made the manifest the authority on who is allowed to sign the product.
    || value.teamId !== REMOTE_DESKTOP_MACOS_TEAM_ID
    || !record(value.bundles)
    || !exactKeys(value.bundles, ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'])) return false;
  const bundleIdentifiers = new Set<string>();
  for (const kind of ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'] as const) {
    const bundle = value.bundles[kind];
    if (!record(bundle)
      || !exactKeys(bundle, ['bundleIdentifier', 'designatedRequirement', 'hardenedRuntime'])
      || typeof bundle.bundleIdentifier !== 'string'
      || !APPLE_BUNDLE_ID_RE.test(bundle.bundleIdentifier)
      || bundleIdentifiers.has(bundle.bundleIdentifier)
      || bundle.hardenedRuntime !== true
      || !validAppleDesignatedRequirement(
        bundle.designatedRequirement,
        bundle.bundleIdentifier,
        value.teamId,
      )) return false;
    bundleIdentifiers.add(bundle.bundleIdentifier);
  }
  return true;
}

function validateMacosComponent(
  value: unknown,
  fileName: string,
  maxSize: number,
): boolean {
  return record(value)
    && exactKeys(value, ['fileName', 'size', 'sha256', 'notarization'])
    && value.fileName === fileName
    && validPositiveSize(value.size)
    && value.size <= maxSize
    && typeof value.sha256 === 'string'
    && SHA256_RE.test(value.sha256)
    && validateMacosNotarizationEvidence(value.notarization);
}

function validateMacosNotarizationEvidence(
  value: unknown,
): value is RemoteDesktopMacosNotarizationEvidence {
  return record(value)
    && exactKeys(value, ['status', 'submissionId', 'ticketSha256', 'stapled', 'stapleValidated'])
    && value.status === 'accepted'
    && typeof value.submissionId === 'string'
    && NOTARIZATION_SUBMISSION_ID_RE.test(value.submissionId)
    && typeof value.ticketSha256 === 'string'
    && SHA256_RE.test(value.ticketSha256)
    && value.stapled === true
    && value.stapleValidated === true;
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

function validateWindowsRemoteDesktopWorkerManifest(
  value: unknown,
): RemoteDesktopWindowsWorkerManifest | null {
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
    || !validPositiveSize(value.size)
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
  return value as unknown as RemoteDesktopWindowsWorkerManifest;
}

function validateMacosRemoteDesktopWorkerManifest(
  value: unknown,
): RemoteDesktopMacosWorkerManifest | null {
  if (!record(value)
    || !exactKeys(value, [
      'manifestVersion', 'artifactKind', 'workerVersion', 'protocolVersion', 'ipcVersion',
      'os', 'arch', 'components', 'libwebrtcRevision', 'minimumOsVersion',
      'codeSignature', 'toolchain',
    ])
    || value.manifestVersion !== REMOTE_DESKTOP_MACOS_WORKER_MANIFEST_VERSION
    || value.artifactKind !== REMOTE_DESKTOP_MACOS_WORKER_ARTIFACT_KIND
    || typeof value.workerVersion !== 'string' || !VERSION_RE.test(value.workerVersion)
    || value.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
    || value.ipcVersion !== REMOTE_DESKTOP_WORKER_IPC_VERSION
    || value.os !== 'darwin'
    || !REMOTE_DESKTOP_MACOS_ARCHITECTURES.some((arch) => value.arch === arch)
    || !record(value.components)
    || !exactKeys(value.components, ['worker', 'launchAgent', 'disclosure', 'virtualDisplayHelper'])
    || !validateMacosComponent(
      value.components.worker,
      REMOTE_DESKTOP_MACOS_WORKER_FILENAME,
      REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS.worker,
    )
    || !validateMacosComponent(
      value.components.launchAgent,
      REMOTE_DESKTOP_MACOS_LAUNCH_AGENT_FILENAME,
      REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS.launchAgent,
    )
    || !validateMacosComponent(
      value.components.disclosure,
      REMOTE_DESKTOP_MACOS_DISCLOSURE_FILENAME,
      REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS.disclosure,
    )
    // The helper descriptor was reachable through exactKeys but never
    // VALIDATED: a manifest could name it with the wrong filename, an
    // out-of-range size, a malformed digest or bogus notarization and still be
    // accepted. exactKeys proves a key is present, not that its value is sane.
    || !validateMacosComponent(
      value.components.virtualDisplayHelper,
      REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_HELPER_FILENAME,
      REMOTE_DESKTOP_MACOS_COMPONENT_LIMITS.virtualDisplayHelper,
    )
    || value.libwebrtcRevision !== WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision
    || typeof value.minimumOsVersion !== 'string' || !MACOS_VERSION_RE.test(value.minimumOsVersion)
    || !validateMacosCodeIdentity(value.codeSignature)
    || !record(value.toolchain)
    || !exactKeys(value.toolchain, ['xcode', 'macosSdk', 'clang'])
    || !Object.values(value.toolchain).every(
      (entry) => typeof entry === 'string' && VERSION_RE.test(entry),
    )) return null;
  return value as unknown as RemoteDesktopMacosWorkerManifest;
}

export function validateRemoteDesktopWorkerReleaseManifest(
  value: unknown,
  expectedTarget?: RemoteDesktopWorkerArtifactTarget,
): RemoteDesktopWorkerReleaseManifest | null {
  const manifest = validateWindowsRemoteDesktopWorkerManifest(value)
    ?? validateMacosRemoteDesktopWorkerManifest(value);
  if (!manifest || (expectedTarget !== undefined
    && (manifest.os !== expectedTarget.os || manifest.arch !== expectedTarget.arch))) return null;
  return manifest;
}

/** Windows-only compatibility entry point for the currently shipped host. */
export function validateRemoteDesktopWorkerManifest(value: unknown): RemoteDesktopWorkerManifest | null {
  return validateWindowsRemoteDesktopWorkerManifest(value);
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

export function validateRemoteDesktopWorkerCrash(
  value: unknown,
  expectedNonce: string,
): value is RemoteDesktopWorkerCrash {
  return record(value)
    && exactKeys(value, ['type', 'ipcVersion', 'nonce', 'pid', 'exceptionCode', 'module', 'moduleOffset'])
    && value.type === REMOTE_DESKTOP_WORKER_CRASH_TYPE
    && value.ipcVersion === REMOTE_DESKTOP_WORKER_IPC_VERSION
    && typeof value.nonce === 'string'
    && NONCE_RE.test(value.nonce)
    && value.nonce === expectedNonce
    && typeof value.pid === 'number'
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.exceptionCode === 'number'
    && Number.isSafeInteger(value.exceptionCode)
    && value.exceptionCode >= 0
    && value.exceptionCode <= 0xffff_ffff
    && typeof value.module === 'string'
    && CRASH_MODULE_RE.test(value.module)
    && typeof value.moduleOffset === 'number'
    && Number.isSafeInteger(value.moduleOffset)
    && value.moduleOffset >= 0;
}

export function validateRemoteDesktopWorkerHello(
  value: unknown,
  expectedNonce: string,
): value is RemoteDesktopWorkerHello {
  return record(value)
    && exactKeys(value, ['type', 'ipcVersion', 'nonce', 'pid'], ['secureConsole'])
    && value.type === REMOTE_DESKTOP_WORKER_HELLO_TYPE
    && (value.secureConsole === undefined || typeof value.secureConsole === 'boolean')
    && value.ipcVersion === REMOTE_DESKTOP_WORKER_IPC_VERSION
    && typeof value.nonce === 'string'
    && NONCE_RE.test(value.nonce)
    && value.nonce === expectedNonce
    && typeof value.pid === 'number'
    && Number.isSafeInteger(value.pid)
    && value.pid > 0;
}
