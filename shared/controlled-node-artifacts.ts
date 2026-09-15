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
  REMOTE_DESKTOP_MACOS_COMPONENT_SET: 'remote-desktop-macos-component-set',
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
  | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY
  | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET;

export function isRemoteDesktopArtifactAsset(asset: string): asset is RemoteDesktopArtifactAsset {
  return asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
    || asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
    || asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY
    || asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET;
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

/* ────────────────────────────────────────────────────────────────────────── */
/* Download-ticket delivery                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * How a minted enrolment ticket reaches the machine being enrolled.
 *
 * These are two genuinely different threat/usability trade-offs, not one
 * setting with two numbers:
 *
 * - `browser` — the operator is sitting at the machine and the browser redeems
 *   the ticket within seconds. The exposure window should be as small as the
 *   round trip allows.
 * - `remote_link` — the operator is NOT at the machine. The link has to survive
 *   being copied into a chat, an email or a ticketing system and opened later
 *   on the target box. Without this, installing on a remote machine requires
 *   downloading locally and transferring the binary by some other tool — which
 *   is exactly the tool you cannot install yet.
 *
 * - `install_command` — a one-line shell command the operator pastes into a
 *   terminal on the target machine. Unlike the two above it is meant to be kept
 *   and reused across many machines, so it is long-lived and admits many
 *   downloads. Its exposure is bounded by what the credential can actually do,
 *   which is add a machine to the owner's account, never read from it.
 *
 * The ticket itself is identical in kind; only its lifetime and download budget
 * differ. Browser tickets and install commands retain bounded budgets. A remote
 * link instead admits any number of downloads and remains valid until its owner
 * explicitly revokes that stable owner/OS/arch/host binding.
 */
export const CONTROLLED_NODE_TICKET_DELIVERY = {
  BROWSER: 'browser',
  REMOTE_LINK: 'remote_link',
  INSTALL_COMMAND: 'install_command',
} as const;

export type ControlledNodeTicketDelivery =
  (typeof CONTROLLED_NODE_TICKET_DELIVERY)[keyof typeof CONTROLLED_NODE_TICKET_DELIVERY];

export const CONTROLLED_NODE_TICKET_DELIVERY_VALUES: readonly ControlledNodeTicketDelivery[] = [
  CONTROLLED_NODE_TICKET_DELIVERY.BROWSER,
  CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK,
  CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND,
];

/**
 * Ticket lifetime per delivery mode. `null` means the stable remote-link
 * credential ends only at owner revocation; it is not an accidental missing
 * timestamp.
 *
 * The install command is deliberately long-lived: it is meant to be saved and
 * pasted on new machines whenever one is set up, and an expiry would silently
 * turn a documented command into a broken one. A finite value is still used
 * rather than "never", so a ticket that is genuinely forgotten eventually stops
 * working and retention can reclaim the row.
 */
export const CONTROLLED_NODE_TICKET_TTL_MS: Readonly<
  Record<ControlledNodeTicketDelivery, number | null>
> = {
  [CONTROLLED_NODE_TICKET_DELIVERY.BROWSER]: 5 * 60 * 1000,
  [CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK]: null,
  [CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND]: 10 * 365 * 24 * 60 * 60 * 1000,
};

/**
 * How many downloads a ticket admits, per delivery mode.
 *
 * `browser` enrols one machine, with spare attempts so a failed download is
 * recoverable. `remote_link` uses `null` deliberately: it may be carried to any
 * number of machines until explicit revocation and must never fail because a
 * consume counter crossed an arbitrary threshold. The install command is a
 * separate, ten-year credential whose bounded fleet budget remains unchanged.
 *
 * `null` is persisted as SQL NULL. Do not replace it with a very large integer:
 * doing so would only hide a finite limit and eventually make an otherwise-live
 * link fail for the wrong reason.
 */
export const CONTROLLED_NODE_TICKET_MAX_CONSUMES = {
  [CONTROLLED_NODE_TICKET_DELIVERY.BROWSER]: 3,
  [CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK]: null,
  [CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND]: 500,
} as const satisfies Readonly<Record<ControlledNodeTicketDelivery, number | null>>;

/**
 * Alphabet for the install code that appears in the pasted command.
 *
 * Crockford-style: no `I`, `L`, `O` or `U`, so the code survives being read off
 * a phone screen, dictated over a call, or copied out of a screenshot by hand.
 * Uppercase only, for the same reason.
 */
export const CONTROLLED_NODE_INSTALL_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 12 characters over a 32-symbol alphabet: 60 bits, far past guessing. */
export const CONTROLLED_NODE_INSTALL_CODE_LENGTH = 12;

const INSTALL_CODE_RE = new RegExp(
  `^[${CONTROLLED_NODE_INSTALL_CODE_ALPHABET}]{${CONTROLLED_NODE_INSTALL_CODE_LENGTH}}$`,
);

/** Exact-shape check. Callers must reject before any database lookup. */
export function isControlledNodeInstallCode(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_CODE_RE.test(value);
}

/**
 * Normalize a hand-typed code.
 *
 * Accepts lowercase and the visually ambiguous characters the alphabet omits,
 * so someone who typed `l` for `1` or `O` for `0` is not told their code is
 * wrong. Returns null when the result is still not a valid code.
 */
export function normalizeControlledNodeInstallCode(value: string): string | null {
  const folded = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/[O]/g, '0')
    .replace(/[U]/g, 'V');
  return isControlledNodeInstallCode(folded) ? folded : null;
}

export function isControlledNodeTicketDelivery(
  value: unknown,
): value is ControlledNodeTicketDelivery {
  return typeof value === 'string'
    && (CONTROLLED_NODE_TICKET_DELIVERY_VALUES as readonly string[]).includes(value);
}

/**
 * Ticket lifetime for a delivery mode, defaulting to the short browser window.
 *
 * Validates rather than indexing blindly. The argument is typed, but this value
 * originates in a request body, so a caller that skipped validation would
 * otherwise index the map with an unknown key and get `undefined` — which would
 * flow into `now + undefined` and produce a NaN expiry. Failing to the short
 * window keeps every unrecognized input on the conservative side.
 */
export function controlledNodeTicketTtlMs(delivery?: ControlledNodeTicketDelivery): number | null {
  return isControlledNodeTicketDelivery(delivery)
    ? CONTROLLED_NODE_TICKET_TTL_MS[delivery]
    : CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER];
}

export const CONTROLLED_NODE_ENROLL_AUDIT_ACTION = {
  TICKET_REVOKE: 'enroll.v2.ticket.revoke',
} as const;

/**
 * Download budget for a delivery mode, validated for the same reason as the
 * TTL. `null` is the explicit no-count-limit contract for a remote link.
 */
export function controlledNodeTicketMaxConsumes(
  delivery?: ControlledNodeTicketDelivery,
): number | null {
  return isControlledNodeTicketDelivery(delivery)
    ? CONTROLLED_NODE_TICKET_MAX_CONSUMES[delivery]
    : CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER];
}
