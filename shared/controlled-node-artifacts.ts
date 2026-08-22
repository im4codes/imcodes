// Canonical controlled-node installer artifacts shared by web (and server tests).
//
// The product ships one downloadable artifact per OS. macOS is a Universal 2
// binary while the enrolled machine still reports its real runtime architecture.

import { AUTH_IDENTITY_ERRORS } from './auth-identity.js';

export const CONTROLLED_NODE_OS_WIN = 'win' as const;
export const CONTROLLED_NODE_OS_MAC = 'mac' as const;
export const CONTROLLED_NODE_OS_LINUX = 'linux' as const;

export const CONTROLLED_NODE_ARCH_X64 = 'x64' as const;
export const CONTROLLED_NODE_ARCH_ARM64 = 'arm64' as const;
export const CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL = 'universal' as const;

export type ControlledNodeOs =
  | typeof CONTROLLED_NODE_OS_WIN
  | typeof CONTROLLED_NODE_OS_MAC
  | typeof CONTROLLED_NODE_OS_LINUX;

export type ControlledNodeArch =
  | typeof CONTROLLED_NODE_ARCH_X64
  | typeof CONTROLLED_NODE_ARCH_ARM64;

export type ControlledNodeArtifactArch =
  | ControlledNodeArch
  | typeof CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL;

export interface ControlledNodeArtifactPair {
  os: ControlledNodeOs;
  arch: ControlledNodeArtifactArch;
}

/** Fixed triple for Win x64 / macOS Universal 2 / Linux x64. */
export const CONTROLLED_NODE_CANONICAL_ARTIFACTS: readonly ControlledNodeArtifactPair[] = [
  { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 },
  { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL },
  { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64 },
] as const;

export const CONTROLLED_NODE_OS_ORDER: readonly ControlledNodeOs[] = [
  CONTROLLED_NODE_OS_WIN,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_LINUX,
] as const;

export const CONTROLLED_NODE_ARCH_ORDER: readonly ControlledNodeArtifactArch[] = [
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARCH_ARM64,
  CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL,
] as const;

/** All known OS values for wire/manifest guards. */
export const CONTROLLED_NODE_OS_VALUES: readonly ControlledNodeOs[] = CONTROLLED_NODE_OS_ORDER;

/** Runtime architectures reported by an enrolled machine. */
export const CONTROLLED_NODE_ARCH_VALUES: readonly ControlledNodeArch[] = [
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARCH_ARM64,
] as const;

/** Architectures exposed by downloadable artifacts. */
export const CONTROLLED_NODE_ARTIFACT_ARCH_VALUES: readonly ControlledNodeArtifactArch[] = CONTROLLED_NODE_ARCH_ORDER;

const CONTROLLED_NODE_OS_SET = new Set<string>(CONTROLLED_NODE_OS_VALUES);
const CONTROLLED_NODE_ARCH_SET = new Set<string>(CONTROLLED_NODE_ARCH_VALUES);
const CONTROLLED_NODE_ARTIFACT_ARCH_SET = new Set<string>(CONTROLLED_NODE_ARTIFACT_ARCH_VALUES);

/** Availability manifest sha256: non-empty 64-char lowercase/uppercase hex. */
export const CONTROLLED_NODE_ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function isControlledNodeOs(value: string): value is ControlledNodeOs {
  return CONTROLLED_NODE_OS_SET.has(value);
}

export function isControlledNodeArch(value: string): value is ControlledNodeArch {
  return CONTROLLED_NODE_ARCH_SET.has(value);
}

export function isControlledNodeArtifactArch(value: string): value is ControlledNodeArtifactArch {
  return CONTROLLED_NODE_ARTIFACT_ARCH_SET.has(value);
}

export function isControlledNodeArtifactSha256(value: string): boolean {
  return CONTROLLED_NODE_ARTIFACT_SHA256_PATTERN.test(value);
}

/** Server mint / download error codes surfaced to the Web panel. */
export const CONTROLLED_NODE_MINT_ERRORS = {
  EXECUTABLE_NOT_BUILT: 'executable_not_built',
  CANONICAL_SERVER_URL_REQUIRED: 'canonical_server_url_required',
  INVALID_OR_EXPIRED_TICKET: 'invalid_or_expired_ticket',
  AUTH_IDENTITY_CHANGED: AUTH_IDENTITY_ERRORS.CHANGED,
  AUTH_IDENTITY_EXPECTATION_REQUIRED: AUTH_IDENTITY_ERRORS.EXPECTATION_REQUIRED,
} as const;



/** Controlled node runtime self-upgrade artifact endpoint (node-token authenticated). */
export const CONTROLLED_NODE_ARTIFACT_UPGRADE_PATH = '/api/enroll/v2/node-artifact' as const;

/** HTTP content coding used for on-the-fly controlled-node artifact downloads. */
export const CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING = 'gzip' as const;

export const CONTROLLED_NODE_ARTIFACT_ASSETS = {
  NODE: 'node',
  COMPUTER_USE_HELPER: 'computer-use-helper',
  REMOTE_DESKTOP_WORKER: 'remote-desktop-worker',
  REMOTE_DESKTOP_WORKER_MANIFEST: 'remote-desktop-worker-manifest',
  REMOTE_DESKTOP_VIRTUAL_DISPLAY: 'remote-desktop-virtual-display',
} as const;

/**
 * Whether `asset` is part of the remote-desktop worker bundle.
 *
 * This is the one artifact family a normal (FULL) daemon may download as well:
 * a Windows daemon serves remote control with the exact same native worker a
 * controlled node uses, so it fetches it through the same artifact route. Every
 * other asset — above all the controlled-node runtime itself — stays
 * CONTROLLED-only.
 */
export type RemoteDesktopArtifactAsset =
  | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
  | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
  | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY;

export function isRemoteDesktopArtifactAsset(asset: string): asset is RemoteDesktopArtifactAsset {
  return asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
    || asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
    || asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY;
}

export const CONTROLLED_NODE_COMPUTER_USE_HELPER_FILENAMES = {
  [CONTROLLED_NODE_OS_WIN]: 'open-computer-use.exe',
  [CONTROLLED_NODE_OS_MAC]: 'open-computer-use.app.zip',
  [CONTROLLED_NODE_OS_LINUX]: 'open-computer-use',
} as const satisfies Record<ControlledNodeOs, string>;

export function controlledNodeComputerUseHelperFilename(os: ControlledNodeOs): string {
  return CONTROLLED_NODE_COMPUTER_USE_HELPER_FILENAMES[os];
}

export const CONTROLLED_NODE_ARTIFACT_HEADERS = {
  SHA256: 'x-imcodes-node-artifact-sha256',
  SIZE_BYTES: 'x-imcodes-node-artifact-size-bytes',
  FILENAME: 'x-imcodes-node-artifact-filename',
  VERSION: 'x-imcodes-node-artifact-version',
  AUTHENTICODE_SIGNER_SHA256: 'x-imcodes-node-artifact-authenticode-signer-sha256',
  REMOTE_DESKTOP_PROTOCOL_VERSION: 'x-imcodes-remote-desktop-protocol-version',
} as const;

export function controlledNodeArtifactKey(os: ControlledNodeOs, arch: ControlledNodeArtifactArch): string {
  return `${os}:${arch}`;
}

export function isCanonicalControlledNodePair(os: string, arch: string): boolean {
  return CONTROLLED_NODE_CANONICAL_ARTIFACTS.some((pair) => pair.os === os && pair.arch === arch);
}

/** Normalize a current artifact target or a legacy macOS runtime target. */
export function normalizeControlledNodeArtifactPair(os: string, arch: string): ControlledNodeArtifactPair | null {
  const canonical = CONTROLLED_NODE_CANONICAL_ARTIFACTS.find((pair) => pair.os === os && pair.arch === arch);
  if (canonical) return canonical;
  if (os === CONTROLLED_NODE_OS_MAC
    && (arch === CONTROLLED_NODE_ARCH_X64 || arch === CONTROLLED_NODE_ARCH_ARM64)) {
    return { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL };
  }
  return null;
}

export function isControlledNodeRuntimePair(os: string, arch: string): boolean {
  return (os === CONTROLLED_NODE_OS_WIN && arch === CONTROLLED_NODE_ARCH_X64)
    || (os === CONTROLLED_NODE_OS_MAC
      && (arch === CONTROLLED_NODE_ARCH_X64 || arch === CONTROLLED_NODE_ARCH_ARM64))
    || (os === CONTROLLED_NODE_OS_LINUX && arch === CONTROLLED_NODE_ARCH_X64);
}

export function isControlledNodeArtifactCompatibleWithRuntime(
  artifactOs: string,
  artifactArch: string,
  runtimeOs: string,
  runtimeArch: string,
): boolean {
  if (!isControlledNodeRuntimePair(runtimeOs, runtimeArch) || artifactOs !== runtimeOs) return false;
  // Preserve redemption of already-downloaded legacy per-architecture packages.
  if (artifactArch === runtimeArch) return true;
  return artifactOs === CONTROLLED_NODE_OS_MAC
    && artifactArch === CONTROLLED_NODE_ARTIFACT_ARCH_UNIVERSAL
    && isCanonicalControlledNodePair(artifactOs, artifactArch);
}

export function compareControlledNodeArtifactPairs(
  a: ControlledNodeArtifactPair,
  b: ControlledNodeArtifactPair,
): number {
  const osCmp = CONTROLLED_NODE_OS_ORDER.indexOf(a.os) - CONTROLLED_NODE_OS_ORDER.indexOf(b.os);
  if (osCmp !== 0) return osCmp;
  return CONTROLLED_NODE_ARCH_ORDER.indexOf(a.arch) - CONTROLLED_NODE_ARCH_ORDER.indexOf(b.arch);
}
