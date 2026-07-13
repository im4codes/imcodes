// Canonical controlled-node installer artifacts shared by web (and server tests).
//
// The 7.5 product gate requires exactly three platform pairs. On-disk layout
// today uses one manifest per OS filename, so this list is the explicit product
// contract — do not assume an arbitrary OS×arch matrix without changing disk layout.

export const CONTROLLED_NODE_OS_WIN = 'win' as const;
export const CONTROLLED_NODE_OS_MAC = 'mac' as const;
export const CONTROLLED_NODE_OS_LINUX = 'linux' as const;

export const CONTROLLED_NODE_ARCH_X64 = 'x64' as const;
export const CONTROLLED_NODE_ARCH_ARM64 = 'arm64' as const;

export type ControlledNodeOs =
  | typeof CONTROLLED_NODE_OS_WIN
  | typeof CONTROLLED_NODE_OS_MAC
  | typeof CONTROLLED_NODE_OS_LINUX;

export type ControlledNodeArch =
  | typeof CONTROLLED_NODE_ARCH_X64
  | typeof CONTROLLED_NODE_ARCH_ARM64;

export interface ControlledNodeArtifactPair {
  os: ControlledNodeOs;
  arch: ControlledNodeArch;
}

/** Fixed triple for Win x64 / macOS arm64 / Linux x64 (7.5 gate). */
export const CONTROLLED_NODE_CANONICAL_ARTIFACTS: readonly ControlledNodeArtifactPair[] = [
  { os: CONTROLLED_NODE_OS_WIN, arch: CONTROLLED_NODE_ARCH_X64 },
  { os: CONTROLLED_NODE_OS_MAC, arch: CONTROLLED_NODE_ARCH_ARM64 },
  { os: CONTROLLED_NODE_OS_LINUX, arch: CONTROLLED_NODE_ARCH_X64 },
] as const;

export const CONTROLLED_NODE_OS_ORDER: readonly ControlledNodeOs[] = [
  CONTROLLED_NODE_OS_WIN,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_LINUX,
] as const;

export const CONTROLLED_NODE_ARCH_ORDER: readonly ControlledNodeArch[] = [
  CONTROLLED_NODE_ARCH_X64,
  CONTROLLED_NODE_ARCH_ARM64,
] as const;

/** All known OS values for wire/manifest guards. */
export const CONTROLLED_NODE_OS_VALUES: readonly ControlledNodeOs[] = CONTROLLED_NODE_OS_ORDER;

/** All known arch values for wire/manifest guards. */
export const CONTROLLED_NODE_ARCH_VALUES: readonly ControlledNodeArch[] = CONTROLLED_NODE_ARCH_ORDER;

const CONTROLLED_NODE_OS_SET = new Set<string>(CONTROLLED_NODE_OS_VALUES);
const CONTROLLED_NODE_ARCH_SET = new Set<string>(CONTROLLED_NODE_ARCH_VALUES);

/** Availability manifest sha256: non-empty 64-char lowercase/uppercase hex. */
export const CONTROLLED_NODE_ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function isControlledNodeOs(value: string): value is ControlledNodeOs {
  return CONTROLLED_NODE_OS_SET.has(value);
}

export function isControlledNodeArch(value: string): value is ControlledNodeArch {
  return CONTROLLED_NODE_ARCH_SET.has(value);
}

export function isControlledNodeArtifactSha256(value: string): boolean {
  return CONTROLLED_NODE_ARTIFACT_SHA256_PATTERN.test(value);
}

/** Server mint / download error codes surfaced to the Web panel. */
export const CONTROLLED_NODE_MINT_ERRORS = {
  EXECUTABLE_NOT_BUILT: 'executable_not_built',
  CANONICAL_SERVER_URL_REQUIRED: 'canonical_server_url_required',
  INVALID_OR_EXPIRED_TICKET: 'invalid_or_expired_ticket',
} as const;

export function controlledNodeArtifactKey(os: ControlledNodeOs, arch: ControlledNodeArch): string {
  return `${os}:${arch}`;
}

export function isCanonicalControlledNodePair(os: string, arch: string): boolean {
  return CONTROLLED_NODE_CANONICAL_ARTIFACTS.some((pair) => pair.os === os && pair.arch === arch);
}

export function compareControlledNodeArtifactPairs(
  a: ControlledNodeArtifactPair,
  b: ControlledNodeArtifactPair,
): number {
  const osCmp = CONTROLLED_NODE_OS_ORDER.indexOf(a.os) - CONTROLLED_NODE_OS_ORDER.indexOf(b.os);
  if (osCmp !== 0) return osCmp;
  return CONTROLLED_NODE_ARCH_ORDER.indexOf(a.arch) - CONTROLLED_NODE_ARCH_ORDER.indexOf(b.arch);
}
