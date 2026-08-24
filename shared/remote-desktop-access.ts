/**
 * Remote-desktop access, authority, routing, consent and privacy contracts.
 *
 * This module is the single source of truth for the identity/authority layer
 * that Server, daemon and Web all speak. It deliberately holds no platform
 * branch: `windows` never appears in a semantic type, because an OS adapter
 * advertises its capability separately and Server/Web must not decide policy
 * from the operating system.
 *
 * Two rules shape almost every declaration here:
 *
 * 1. Secrets never become protocol fields. A raw link bearer or node password
 *    is proved once over HTTPS and then only its hash, generation or derived
 *    actor identity travels. Whole-desktop capture makes any on-screen secret
 *    a disclosure even when the Worker never receives its bytes, so the
 *    privacy contracts below coordinate the screen, not just the wire.
 * 2. Every mutation is monotonic and explicitly revisioned. Authority may only
 *    narrow (Control to View, longer expiry to shorter); widening requires a
 *    new credential. That is what lets a stale retry be recognised instead of
 *    silently re-granting something the owner already revoked.
 */

import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  type RemoteDesktopAccessMode,
  type RemoteDesktopValidationResult,
} from './remote-desktop.js';
import {
  hasExactRemoteDesktopKeys,
  isBoundedRemoteDesktopString,
  isRemoteDesktopId,
  isRemoteDesktopRecord,
  isSafeNonNegativeRemoteDesktopInteger,
  remoteDesktopUtf8Bytes,
} from './remote-desktop-contract-primitives.js';

function invalid<T>(): RemoteDesktopValidationResult<T> {
  return { ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST };
}

function ok<T>(value: unknown): RemoteDesktopValidationResult<T> {
  return { ok: true, value: value as T };
}

/* ------------------------------------------------------------------------ */
/* 2.1 Canonical host principal and execution endpoint                       */
/* ------------------------------------------------------------------------ */

/**
 * Public identity belongs to one physical desktop, not to one `servers.id`.
 * When a FULL daemon hosts a controlled node for the same machine, both
 * endpoint rows attach to this principal, so the pair cannot open two public
 * entrances or two guest sessions for one authority.
 */
export interface RemoteDesktopCanonicalHost {
  hostId: string;
  ownerUserId: string;
  /** Present only once the principal qualifies; absence is not an error. */
  publicNodeId?: number;
  executionEndpoint: RemoteDesktopExecutionEndpoint;
  /** Bumped by endpoint replacement; never rotates public identity. */
  endpointGeneration: number;
}

export const REMOTE_DESKTOP_ENDPOINT_KIND = {
  CONTROLLED_NODE: 'controlled_node',
  FULL_DAEMON: 'full_daemon',
} as const;

export type RemoteDesktopEndpointKind =
  typeof REMOTE_DESKTOP_ENDPOINT_KIND[keyof typeof REMOTE_DESKTOP_ENDPOINT_KIND];

/**
 * Exactly one endpoint executes for a principal. `serverId` is a routing key,
 * never authorization: it is disclosed only after proof succeeds and grants
 * nothing on its own.
 */
export interface RemoteDesktopExecutionEndpoint {
  kind: RemoteDesktopEndpointKind;
  serverId: string;
  endpointGeneration: number;
}

/**
 * Selection prefers the qualified hosted controlled-node endpoint while that
 * hosting relationship is active, otherwise the qualified FULL daemon. Kept
 * here rather than in Server code so daemon and Web cannot disagree about
 * which endpoint a principal is currently executing on.
 */
export function selectRemoteDesktopExecutionEndpoint(
  endpoints: readonly RemoteDesktopExecutionEndpoint[],
  hostedControlledNodeActive: boolean,
): RemoteDesktopExecutionEndpoint | undefined {
  if (hostedControlledNodeActive) {
    const hosted = endpoints.find((entry) => entry.kind === REMOTE_DESKTOP_ENDPOINT_KIND.CONTROLLED_NODE);
    if (hosted) return hosted;
  }
  return endpoints.find((entry) => entry.kind === REMOTE_DESKTOP_ENDPOINT_KIND.FULL_DAEMON);
}

/**
 * Pairing two already-qualified independent principals is a migration
 * conflict, not a silent merge: one public ID is permanently retired and guest
 * admission stays disabled until the owner resolves which authority survives.
 */
export const REMOTE_DESKTOP_HOST_MERGE_STATE = {
  NONE: 'none',
  CONFLICT_PENDING_OWNER: 'conflict_pending_owner',
  RESOLVED: 'resolved',
} as const;

export type RemoteDesktopHostMergeState =
  typeof REMOTE_DESKTOP_HOST_MERGE_STATE[keyof typeof REMOTE_DESKTOP_HOST_MERGE_STATE];

/* ------------------------------------------------------------------------ */
/* 2.2 Public node ID range, rejection sampling and bounded allocation       */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_PUBLIC_ID = {
  MIN: 5_000_000_000,
  MAX: 9_999_999_999,
  DIGITS: 10,
  /** Total zero digits at or above which a candidate is rejected. */
  MAX_ZERO_DIGITS_EXCLUSIVE: 4,
  /** Any run of this many equal, ascending or descending digits is rejected. */
  MAX_RUN_LENGTH_EXCLUSIVE: 4,
  /** A 2- or 3-digit motif covering this many consecutive digits is rejected. */
  MOTIF_SPAN_EXCLUSIVE: 6,
  MOTIF_PERIODS: [2, 3] as readonly number[],
  /** Bounded retry; exhaustion is an error, never a fallback to a seed. */
  MAX_ALLOCATION_ATTEMPTS: 16,
} as const;

/**
 * Deterministic, shared candidate rejection.
 *
 * Both the allocator and its tests must agree exactly, so this predicate — not
 * a Server-local copy — decides. A rejected value is never "fixed up" by
 * incrementing: derivation from a seed, owner, UUID, hostname or enrolment
 * order would make one public ID predict another.
 */
export function isProhibitedRemoteDesktopPublicIdPattern(value: number): boolean {
  const text = String(value);
  const digits = [...text].map((char) => char.charCodeAt(0) - 48);
  let zeros = 0;
  for (const digit of digits) if (digit === 0) zeros += 1;
  if (zeros >= REMOTE_DESKTOP_PUBLIC_ID.MAX_ZERO_DIGITS_EXCLUSIVE) return true;

  const run = REMOTE_DESKTOP_PUBLIC_ID.MAX_RUN_LENGTH_EXCLUSIVE;
  for (let i = 0; i + run - 1 < digits.length; i += 1) {
    let equal = true;
    let ascending = true;
    let descending = true;
    for (let k = 0; k + 1 < run; k += 1) {
      const current = digits[i + k]!;
      const next = digits[i + k + 1]!;
      if (next !== current) equal = false;
      // "Without wrap": 9 does not ascend into 0, so plain arithmetic is right.
      if (next !== current + 1) ascending = false;
      if (next !== current - 1) descending = false;
    }
    if (equal || ascending || descending) return true;
  }

  for (const period of REMOTE_DESKTOP_PUBLIC_ID.MOTIF_PERIODS) {
    for (let start = 0; start < digits.length; start += 1) {
      let end = start + period;
      while (end < digits.length && digits[end] === digits[end - period]) end += 1;
      if (end - start >= REMOTE_DESKTOP_PUBLIC_ID.MOTIF_SPAN_EXCLUSIVE) return true;
    }
  }
  return false;
}

export function isRemoteDesktopPublicNodeId(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= REMOTE_DESKTOP_PUBLIC_ID.MIN
    && value <= REMOTE_DESKTOP_PUBLIC_ID.MAX;
}

/** A candidate is acceptable only when it is in range AND not a weak pattern. */
export function isAcceptableRemoteDesktopPublicNodeId(value: unknown): value is number {
  return isRemoteDesktopPublicNodeId(value) && !isProhibitedRemoteDesktopPublicIdPattern(value);
}

/* ------------------------------------------------------------------------ */
/* 2.3 Link policy: kinds, ceilings, exact durations, monotonic mutation     */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_LINK_KIND = {
  ATTENDED: 'attended',
  UNATTENDED: 'unattended',
} as const;

export type RemoteDesktopLinkKind =
  typeof REMOTE_DESKTOP_LINK_KIND[keyof typeof REMOTE_DESKTOP_LINK_KIND];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Unattended links take exactly one of these, measured from Server commit
 * time. An arbitrary duration is rejected rather than clamped: clamping would
 * silently grant something the owner did not choose.
 */
export const REMOTE_DESKTOP_LINK_DURATION_MS = {
  H1: HOUR_MS,
  H6: 6 * HOUR_MS,
  H24: DAY_MS,
  D7: 7 * DAY_MS,
  D30: 30 * DAY_MS,
} as const;

export const REMOTE_DESKTOP_LINK_DURATIONS_MS: readonly number[] =
  Object.values(REMOTE_DESKTOP_LINK_DURATION_MS);

export function isRemoteDesktopLinkDurationMs(value: unknown): value is number {
  return typeof value === 'number' && REMOTE_DESKTOP_LINK_DURATIONS_MS.includes(value);
}

export const REMOTE_DESKTOP_LINK_LIMITS = {
  /** One link admits at most one live session, and binds to one browser key. */
  MAX_LIVE_SESSIONS_PER_LINK: 1,
  MAX_CLAIMED_BROWSERS_PER_LINK: 1,
  LABEL_BYTES: 256,
  /** Attended approval is bounded so a silent node cannot hold a request open. */
  CONSENT_DEADLINE_MS: 60_000,
  /** Bootstrap records are short-lived and single-use. */
  BOOTSTRAP_TTL_MS: 60_000,
  /** Explicit effects and natural expiry must both apply within this window. */
  EFFECT_APPLY_DEADLINE_MS: 2_000,
  /** Multi-pod expiry workers claim due rows at least this often. */
  EXPIRY_POLL_INTERVAL_MS: 500,
} as const;

/**
 * Owner mutations may only narrow authority.
 *
 * Control-to-View increments `authorityGeneration` (it invalidates derived
 * routes); shortening an expiry increments only `expiryRevision` (a live route
 * stays usable until the earlier deadline). Conflating the two would either
 * kill a healthy session on a label edit or let a revoked grant survive.
 */
export const REMOTE_DESKTOP_LINK_MUTATION = {
  SET_LABEL: 'set_label',
  REDUCE_TO_VIEW: 'reduce_to_view',
  SHORTEN_EXPIRY: 'shorten_expiry',
  REVOKE: 'revoke',
} as const;

export type RemoteDesktopLinkMutation =
  typeof REMOTE_DESKTOP_LINK_MUTATION[keyof typeof REMOTE_DESKTOP_LINK_MUTATION];

export interface RemoteDesktopLinkPolicy {
  hostId: string;
  kind: RemoteDesktopLinkKind;
  mode: RemoteDesktopAccessMode;
  /** Required for `unattended`, forbidden for `attended`. */
  durationMs?: number;
  label: string;
}

/**
 * Rejects every widening mutation. Enumerated explicitly rather than derived,
 * because "attended to unattended" and "View to Control" are the two changes
 * that would convert a narrow grant into standing remote control.
 */
export function isMonotonicRemoteDesktopLinkMutation(
  current: RemoteDesktopLinkPolicy,
  next: Partial<RemoteDesktopLinkPolicy>,
): boolean {
  if (next.hostId !== undefined && next.hostId !== current.hostId) return false;
  if (next.kind !== undefined && next.kind !== current.kind) return false;
  if (next.mode !== undefined
    && next.mode !== current.mode
    && !(current.mode === REMOTE_DESKTOP_ACCESS_MODE.CONTROL
      && next.mode === REMOTE_DESKTOP_ACCESS_MODE.VIEW)) return false;
  if (next.durationMs !== undefined) {
    if (current.kind !== REMOTE_DESKTOP_LINK_KIND.UNATTENDED) return false;
    if (!isRemoteDesktopLinkDurationMs(next.durationMs)) return false;
    if (current.durationMs === undefined || next.durationMs >= current.durationMs) return false;
  }
  if (next.label !== undefined && !isBoundedRemoteDesktopString(next.label, REMOTE_DESKTOP_LINK_LIMITS.LABEL_BYTES)) {
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------------ */
/* 2.4 One discriminated actor authority                                     */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_ACTOR_SOURCE = {
  ACCOUNT: 'account',
  ATTENDED_LINK: 'attended_link',
  UNATTENDED_LINK: 'unattended_link',
  NODE_PASSWORD: 'node_password',
} as const;

export type RemoteDesktopActorSource =
  typeof REMOTE_DESKTOP_ACTOR_SOURCE[keyof typeof REMOTE_DESKTOP_ACTOR_SOURCE];

interface RemoteDesktopActorBase {
  /** Stable audit identity. Never the raw bearer, password or browser key. */
  auditId: string;
  hostId: string;
  endpointGeneration: number;
  modeCeiling: RemoteDesktopAccessMode;
  /** Link authority generation or password credential generation. */
  authorityGeneration: number;
  expiryRevision: number;
  /** Absolute; 0 means "no natural expiry" (attended links, account authority). */
  expiresAt: number;
}

export interface RemoteDesktopAccountActor extends RemoteDesktopActorBase {
  source: typeof REMOTE_DESKTOP_ACTOR_SOURCE.ACCOUNT;
  userId: string;
}

export interface RemoteDesktopLinkActor extends RemoteDesktopActorBase {
  source: typeof REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
    | typeof REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK;
  linkId: string;
  browserKeyThumbprint: string;
}

export interface RemoteDesktopPasswordActor extends RemoteDesktopActorBase {
  source: typeof REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD;
  publicNodeId: number;
}

export type RemoteDesktopActor =
  | RemoteDesktopAccountActor
  | RemoteDesktopLinkActor
  | RemoteDesktopPasswordActor;

/**
 * Renewal resolves the original source authoritatively. It may never upgrade
 * View to Control, move hosts, transfer a browser claim, outlive its
 * generation or survive revocation. A changed `expiryRevision` alone is not an
 * invalidation — it only moves the deadline earlier.
 */
export function isRemoteDesktopActorRenewable(
  previous: RemoteDesktopActor,
  current: RemoteDesktopActor,
  nowMs: number,
): boolean {
  if (previous.source !== current.source) return false;
  if (previous.auditId !== current.auditId || previous.hostId !== current.hostId) return false;
  if (current.authorityGeneration !== previous.authorityGeneration) return false;
  if (current.expiryRevision < previous.expiryRevision) return false;
  if (previous.modeCeiling === REMOTE_DESKTOP_ACCESS_MODE.VIEW
    && current.modeCeiling === REMOTE_DESKTOP_ACCESS_MODE.CONTROL) return false;
  if (previous.source === REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK
    || previous.source === REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK) {
    const before = previous as RemoteDesktopLinkActor;
    const after = current as RemoteDesktopLinkActor;
    if (before.linkId !== after.linkId
      || before.browserKeyThumbprint !== after.browserKeyThumbprint) return false;
  }
  if (current.expiresAt !== 0 && nowMs >= current.expiresAt) return false;
  return true;
}

/* ------------------------------------------------------------------------ */
/* 2.10 Frozen bearer / request wire format                                  */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_LINK_TOKEN = {
  RAW_BYTES: 32,
  /** base64url, no padding: ceil(32 * 4 / 3) with padding stripped. */
  ENCODED_LENGTH: 43,
  HASH_VERSION: 'v1',
  FRAGMENT_KEY: 'invite',
  /** Domain separation stops a hash from being replayed into another context. */
  HASH_DOMAIN: 'imcodes.remote-desktop.link.v1',
  HASH_DOMAIN_SEPARATOR_BYTE: 0x00,
  HASH_ALGORITHM: 'SHA-256',
  /** Hex SHA-256. */
  HASH_LENGTH: 64,
  CREATION_REQUEST_ID_BYTES: 32,
} as const;

export const REMOTE_DESKTOP_GUEST_HTTP_PATH = {
  FRAGMENT_BOOTSTRAP: '/api/remote-desktop/guest/link/bootstrap',
} as const;

const BASE64URL_NO_PADDING_RE = /^[A-Za-z0-9_-]+$/;
const LOWER_HEX_RE = /^[0-9a-f]+$/;

/**
 * Canonical base64url without padding, of exactly the frozen length.
 *
 * Non-canonical encodings are rejected rather than normalised: two spellings
 * of one secret would produce two hashes and could alias or split an
 * authority.
 */
export function isCanonicalRemoteDesktopLinkToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === REMOTE_DESKTOP_LINK_TOKEN.ENCODED_LENGTH
    && BASE64URL_NO_PADDING_RE.test(value);
}

export function isCanonicalRemoteDesktopCreationRequestId(value: unknown): value is string {
  return isCanonicalRemoteDesktopLinkToken(value);
}

export function isRemoteDesktopLinkTokenHash(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === REMOTE_DESKTOP_LINK_TOKEN.HASH_LENGTH
    && LOWER_HEX_RE.test(value);
}

/** `#invite=v1.<43-char base64url>` — the only shape the scrubber accepts. */
export function parseRemoteDesktopLinkFragment(fragment: string): string | undefined {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const prefix = `${REMOTE_DESKTOP_LINK_TOKEN.FRAGMENT_KEY}=${REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION}.`;
  if (!raw.startsWith(prefix)) return undefined;
  const token = raw.slice(prefix.length);
  return isCanonicalRemoteDesktopLinkToken(token) ? token : undefined;
}

/**
 * Exact preimage: UTF8(domain) || 0x00 || raw32.
 *
 * Returned as bytes so callers hash with the platform digest rather than
 * re-deriving the layout; a second implementation of this concatenation is
 * how domain separation quietly stops matching.
 */
export function remoteDesktopLinkTokenHashPreimage(raw: Uint8Array): Uint8Array {
  if (raw.byteLength !== REMOTE_DESKTOP_LINK_TOKEN.RAW_BYTES) {
    throw new Error('remote_desktop_link_token_length');
  }
  const domain = new TextEncoder().encode(REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN);
  const out = new Uint8Array(domain.byteLength + 1 + raw.byteLength);
  out.set(domain, 0);
  out[domain.byteLength] = REMOTE_DESKTOP_LINK_TOKEN.HASH_DOMAIN_SEPARATOR_BYTE;
  out.set(raw, domain.byteLength + 1);
  return out;
}

/* ------------------------------------------------------------------------ */
/* 2.6 Platform-neutral local consent                                        */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_CONSENT_MSG = {
  REQUEST: 'remote_desktop.consent.request',
  RESULT: 'remote_desktop.consent.result',
  CANCEL: 'remote_desktop.consent.cancel',
} as const;

export const REMOTE_DESKTOP_CONSENT_DECISION = {
  APPROVED: 'approved',
  DENIED: 'denied',
} as const;

export type RemoteDesktopConsentDecision =
  typeof REMOTE_DESKTOP_CONSENT_DECISION[keyof typeof REMOTE_DESKTOP_CONSENT_DECISION];

/**
 * Every cancellation cause is enumerated so a node cannot report a generic
 * failure that the Server would mistake for a denial — or worse, for silence
 * that later gets retried into an approval.
 */
export const REMOTE_DESKTOP_CONSENT_CANCEL_REASON = {
  TIMEOUT: 'timeout',
  LOCAL_UI_FAILED: 'local_ui_failed',
  PROTECTED_DESKTOP: 'protected_desktop',
  NON_INTERACTIVE_SESSION: 'non_interactive_session',
  NODE_RESTARTED: 'node_restarted',
  DAEMON_GENERATION_CHANGED: 'daemon_generation_changed',
  BROWSER_DISCONNECTED: 'browser_disconnected',
  LINK_REVOKED: 'link_revoked',
  MODE_MISMATCH: 'mode_mismatch',
  /**
   * The approval names a different canonical host than the one this node
   * serves. Distinct from MODE_MISMATCH: a wrong mode is a narrowing question
   * the owner could answer, whereas a wrong host means the request was routed
   * to the wrong desktop and no local answer can make it correct.
   */
  HOST_MISMATCH: 'host_mismatch',
} as const;

export type RemoteDesktopConsentCancelReason =
  typeof REMOTE_DESKTOP_CONSENT_CANCEL_REASON[keyof typeof REMOTE_DESKTOP_CONSENT_CANCEL_REASON];

export const REMOTE_DESKTOP_CONSENT_LIMITS = {
  REQUESTER_LABEL_BYTES: 128,
} as const;

/** Carries no link token, password, browser key or capability. */
export interface RemoteDesktopConsentRequest {
  type: typeof REMOTE_DESKTOP_CONSENT_MSG.REQUEST;
  approvalId: string;
  hostId: string;
  mode: RemoteDesktopAccessMode;
  requesterLabel: string;
  createdAt: number;
  deadlineAt: number;
  daemonGeneration: number;
}

export interface RemoteDesktopConsentResult {
  type: typeof REMOTE_DESKTOP_CONSENT_MSG.RESULT;
  approvalId: string;
  decision: RemoteDesktopConsentDecision;
  daemonGeneration: number;
}

export interface RemoteDesktopConsentCancel {
  type: typeof REMOTE_DESKTOP_CONSENT_MSG.CANCEL;
  approvalId: string;
  reason: RemoteDesktopConsentCancelReason;
}

export type RemoteDesktopConsentMessage =
  | RemoteDesktopConsentRequest
  | RemoteDesktopConsentResult
  | RemoteDesktopConsentCancel;

/**
 * Server-authoritative identity context for the connected controlled node.
 * The node cannot derive either value locally: `serverId` is an execution
 * endpoint rather than the canonical physical-host principal, while the
 * daemon generation belongs to the Server bridge connection.
 */
export const REMOTE_DESKTOP_NODE_CONTEXT_MSG = {
  CURRENT: 'remote_desktop.node_context.current',
  UNAVAILABLE: 'remote_desktop.node_context.unavailable',
} as const;

export interface RemoteDesktopCurrentNodeAuthorityContext {
  type: typeof REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT;
  hostId: string;
  daemonGeneration: number;
}

export interface RemoteDesktopUnavailableNodeAuthorityContext {
  type: typeof REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE;
  daemonGeneration: number;
}

export type RemoteDesktopNodeAuthorityContext =
  | RemoteDesktopCurrentNodeAuthorityContext
  | RemoteDesktopUnavailableNodeAuthorityContext;

export function validateRemoteDesktopNodeAuthorityContext(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopNodeAuthorityContext> {
  if (!isRemoteDesktopRecord(value)) return invalid();
  if (value.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.CURRENT) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'hostId', 'daemonGeneration'])
      || !isRemoteDesktopId(value.hostId)
      || !isSafeNonNegativeRemoteDesktopInteger(value.daemonGeneration)) return invalid();
    return ok<RemoteDesktopCurrentNodeAuthorityContext>(value);
  }
  if (value.type === REMOTE_DESKTOP_NODE_CONTEXT_MSG.UNAVAILABLE) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'daemonGeneration'])
      || !isSafeNonNegativeRemoteDesktopInteger(value.daemonGeneration)) return invalid();
    return ok<RemoteDesktopUnavailableNodeAuthorityContext>(value);
  }
  return invalid();
}

/**
 * OS adapters advertise these independently. A host without the consent
 * adapter cannot serve attended links; one without the shell/privacy
 * capability stays manageable from another Web device but cannot expose
 * controlled-computer management.
 */
export const REMOTE_DESKTOP_ADAPTER_CAPABILITY = {
  LOCAL_CONSENT: 'remote.desktop.consent.local.v1',
  SIGNED_ACCOUNT_SHELL: 'remote.desktop.shell.signed.v1',
  CAPTURE_PRIVACY: 'remote.desktop.privacy.capture.v1',
  INPUT: 'remote.desktop.input.v1',
  LOCK_SCREEN: 'remote.desktop.lock_screen.v1',
  CANONICAL_BRANDING: 'remote.desktop.branding.canonical.v1',
  LOCAL_DISCLOSURE: 'remote.desktop.disclosure.local.v1',
} as const;

export type RemoteDesktopAdapterCapability = typeof REMOTE_DESKTOP_ADAPTER_CAPABILITY[
  keyof typeof REMOTE_DESKTOP_ADAPTER_CAPABILITY
];

/**
 * Decision 11's complete platform-adapter matrix. Registration is not an
 * availability claim: each runtime advertises only the entries its current
 * adapter explicitly implements and can keep fail-closed.
 */
export const REMOTE_DESKTOP_ADAPTER_CAPABILITIES = Object.freeze(
  Object.values(REMOTE_DESKTOP_ADAPTER_CAPABILITY),
) as readonly RemoteDesktopAdapterCapability[];

// Compatibility names for the three capabilities introduced with the consent
// and privacy contracts. Their values still have one source of truth above.
export const REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCAL_CONSENT;
export const REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.SIGNED_ACCOUNT_SHELL;
export const REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.CAPTURE_PRIVACY;
export const REMOTE_DESKTOP_INPUT_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.INPUT;
export const REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCK_SCREEN;
export const REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.CANONICAL_BRANDING;
export const REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY = REMOTE_DESKTOP_ADAPTER_CAPABILITY.LOCAL_DISCLOSURE;

/**
 * Stronger capture-privacy refinement used only for transparent route
 * replacement.  The base capture-privacy marker proves an already-running
 * Worker can shield its current routes; it does not prove that a fresh Worker
 * can arm the epoch before PREPARE and keep every replacement source opaque.
 */
export const REMOTE_DESKTOP_DEFAULT_SHIELDED_ROUTE_CAPABILITY =
  'remote.desktop.privacy.default-shielded-route.v1';

export const REMOTE_DESKTOP_CONTROLLED_MANAGEMENT_REQUIRED_CAPABILITIES = Object.freeze([
  REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY,
  REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY,
  REMOTE_DESKTOP_INPUT_CAPABILITY,
  REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY,
  REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
] as const);

export interface RemoteDesktopAdapterReadiness {
  localConsent: boolean;
  signedAccountShell: boolean;
  capturePrivacy: boolean;
  input: boolean;
  lockScreen: boolean;
  canonicalBranding: boolean;
  localDisclosure: boolean;
  /** Presentation readiness only; Owner account authority remains Server-side. */
  controlledComputerManagement: boolean;
}

/**
 * Missing or unknown capabilities never inherit readiness from the base
 * remote-desktop capture capability. This is the mixed-version fail-closed
 * projection shared by future Server/Web consumers.
 */
export function remoteDesktopAdapterReadiness(
  capabilities: readonly unknown[] | undefined,
): RemoteDesktopAdapterReadiness {
  const known = new Set(
    (capabilities ?? []).filter((value): value is RemoteDesktopAdapterCapability => (
      typeof value === 'string'
      && (REMOTE_DESKTOP_ADAPTER_CAPABILITIES as readonly string[]).includes(value)
    )),
  );
  const has = (capability: RemoteDesktopAdapterCapability) => known.has(capability);
  return {
    localConsent: has(REMOTE_DESKTOP_LOCAL_CONSENT_CAPABILITY),
    signedAccountShell: has(REMOTE_DESKTOP_SIGNED_SHELL_CAPABILITY),
    capturePrivacy: has(REMOTE_DESKTOP_CAPTURE_PRIVACY_CAPABILITY),
    input: has(REMOTE_DESKTOP_INPUT_CAPABILITY),
    lockScreen: has(REMOTE_DESKTOP_LOCK_SCREEN_CAPABILITY),
    canonicalBranding: has(REMOTE_DESKTOP_CANONICAL_BRANDING_CAPABILITY),
    localDisclosure: has(REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY),
    controlledComputerManagement: REMOTE_DESKTOP_CONTROLLED_MANAGEMENT_REQUIRED_CAPABILITIES
      .every((capability) => known.has(capability)),
  };
}

const CONSENT_DECISIONS = new Set<string>(Object.values(REMOTE_DESKTOP_CONSENT_DECISION));
const CONSENT_CANCEL_REASONS = new Set<string>(Object.values(REMOTE_DESKTOP_CONSENT_CANCEL_REASON));
const ACCESS_MODES = new Set<string>(Object.values(REMOTE_DESKTOP_ACCESS_MODE));

export function validateRemoteDesktopConsentMessage(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopConsentMessage> {
  if (!isRemoteDesktopRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === REMOTE_DESKTOP_CONSENT_MSG.REQUEST) {
    if (!hasExactRemoteDesktopKeys(value, [
      'type', 'approvalId', 'hostId', 'mode', 'requesterLabel', 'createdAt', 'deadlineAt', 'daemonGeneration',
    ])
      || !isRemoteDesktopId(value.approvalId)
      || !isRemoteDesktopId(value.hostId)
      || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)
      || !isBoundedRemoteDesktopString(value.requesterLabel, REMOTE_DESKTOP_CONSENT_LIMITS.REQUESTER_LABEL_BYTES)
      || !isSafeNonNegativeRemoteDesktopInteger(value.createdAt)
      || !isSafeNonNegativeRemoteDesktopInteger(value.deadlineAt)
      || !isSafeNonNegativeRemoteDesktopInteger(value.daemonGeneration)
      // A non-advancing deadline would make the request immediately expired or
      // unbounded, and both let a stale approval linger.
      || value.deadlineAt <= value.createdAt
      || value.deadlineAt - value.createdAt > REMOTE_DESKTOP_LINK_LIMITS.CONSENT_DEADLINE_MS) return invalid();
    return ok<RemoteDesktopConsentMessage>(value);
  }
  if (value.type === REMOTE_DESKTOP_CONSENT_MSG.RESULT) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'approvalId', 'decision', 'daemonGeneration'])
      || !isRemoteDesktopId(value.approvalId)
      || typeof value.decision !== 'string' || !CONSENT_DECISIONS.has(value.decision)
      || !isSafeNonNegativeRemoteDesktopInteger(value.daemonGeneration)) return invalid();
    return ok<RemoteDesktopConsentMessage>(value);
  }
  if (value.type === REMOTE_DESKTOP_CONSENT_MSG.CANCEL) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'approvalId', 'reason'])
      || !isRemoteDesktopId(value.approvalId)
      || typeof value.reason !== 'string' || !CONSENT_CANCEL_REASONS.has(value.reason)) return invalid();
    return ok<RemoteDesktopConsentMessage>(value);
  }
  return invalid();
}

/* ------------------------------------------------------------------------ */
/* 2.8 + 2.13 Signed shell launch context and durable management privacy     */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_PRIVACY_MSG = {
  BEGIN: 'management_privacy.begin',
  ACK: 'management_privacy.ack',
  END: 'management_privacy.end',
} as const;

export const REMOTE_DESKTOP_PRIVACY_PHASE = {
  STARTING: 'starting',
  ACTIVE: 'active',
  ENDING: 'ending',
  RECOVERY_REQUIRED: 'recovery_required',
} as const;

export type RemoteDesktopPrivacyPhase =
  typeof REMOTE_DESKTOP_PRIVACY_PHASE[keyof typeof REMOTE_DESKTOP_PRIVACY_PHASE];

export const REMOTE_DESKTOP_PRIVACY_ADMISSION = {
  OPEN: 'open',
  CLOSED: 'closed',
} as const;

export type RemoteDesktopPrivacyAdmission =
  typeof REMOTE_DESKTOP_PRIVACY_ADMISSION[keyof typeof REMOTE_DESKTOP_PRIVACY_ADMISSION];

/** Who is presenting the secret UI. Advisory companion detection is not here. */
export const REMOTE_DESKTOP_PRESENTATION_SOURCE = {
  SIGNED_SHELL: 'signed_shell',
  MANAGEMENT_WEB: 'management_web',
} as const;

export type RemoteDesktopPresentationSource =
  typeof REMOTE_DESKTOP_PRESENTATION_SOURCE[keyof typeof REMOTE_DESKTOP_PRESENTATION_SOURCE];

export const REMOTE_DESKTOP_PRIVACY_LIMITS = {
  /** Bounded so a lost shell cannot hold admission closed forever. */
  MAX_LEASE_MS: 5 * 60_000,
  /** The acknowledgement set is bounded by the host's own route ceiling. */
  MAX_ACK_ROUTES: REMOTE_DESKTOP_LIMITS.DISPLAYS,
  /** Includes verified Worker cold start plus exact replacement-route ACK. */
  ROUTE_REPLACEMENT_ACK_MS: 35_000,
  LAUNCH_CONTEXT_TTL_MS: 60_000,
  /** The whole launch context, serialized. It carries no secret, so a large
   *  body means an implementation is attaching something it should not. */
  LAUNCH_CONTEXT_BYTES: 1024,
  CLIPBOARD_CLEANUP_MS: 60_000,
} as const;

/**
 * Short one-time context proving "this shell is the local presentation of that
 * host". It grants no management authority and cannot be redeemed without the
 * Owner session; its only privileged purpose is privacy coordination.
 */
export interface RemoteDesktopShellLaunchContext {
  hostId: string;
  launchId: string;
  issuedAt: number;
  expiresAt: number;
  endpointGeneration: number;
}

export const REMOTE_DESKTOP_SHELL_MSG = {
  LAUNCH: 'remote_desktop.shell.launch',
  RECOVERY_REQUIRED: 'remote_desktop.shell.recovery_required',
} as const;

export const REMOTE_DESKTOP_SHELL_RECOVERY_REASON = {
  LAUNCH_CONTEXT_INVALID: 'launch_context_invalid',
  LAUNCH_CONTEXT_STALE: 'launch_context_stale',
  LAUNCH_CONTEXT_REPLAY: 'launch_context_replay',
  SHELL_LAUNCH_FAILED: 'shell_launch_failed',
  SHELL_CRASHED: 'shell_crashed',
  SHELL_LOGOUT: 'shell_logout',
  CLIPBOARD_WATCHDOG_FAILED: 'clipboard_watchdog_failed',
  CLIPBOARD_WATCHDOG_CRASHED: 'clipboard_watchdog_crashed',
  CLIPBOARD_CLEANUP_UNCERTAIN: 'clipboard_cleanup_uncertain',
} as const;

export type RemoteDesktopSignedShellRecoveryReason =
  typeof REMOTE_DESKTOP_SHELL_RECOVERY_REASON[
    keyof typeof REMOTE_DESKTOP_SHELL_RECOVERY_REASON
  ];

export interface RemoteDesktopShellLaunchMessage {
  type: typeof REMOTE_DESKTOP_SHELL_MSG.LAUNCH;
  context: RemoteDesktopShellLaunchContext;
}

export interface RemoteDesktopShellRecoveryRequiredMessage {
  type: typeof REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED;
  hostId: string;
  epochId: string;
  endpointGeneration: number;
  reason: RemoteDesktopSignedShellRecoveryReason;
}

export type RemoteDesktopShellMessage =
  | RemoteDesktopShellLaunchMessage
  | RemoteDesktopShellRecoveryRequiredMessage;

/**
 * Strict validation for the one-time signed-shell launch context.
 *
 * This context is the only thing that lets a local shell say "I am the
 * presentation of that host", so it is validated as tightly as a wire message
 * even though it travels the already-authenticated node channel: exact keys, a
 * bounded serialized body, an advancing bounded lifetime, and an explicit
 * secret-field sweep. It grants no management authority, and rejecting a body
 * that tries to carry an account session or token here is what keeps that
 * true in practice rather than only in the doc comment.
 */
export function validateRemoteDesktopShellLaunchContext(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopShellLaunchContext> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, ['hostId', 'launchId', 'issuedAt', 'expiresAt', 'endpointGeneration'])
    || !isRemoteDesktopId(value.hostId)
    || !isRemoteDesktopId(value.launchId)
    || !isSafeNonNegativeRemoteDesktopInteger(value.issuedAt)
    || !isSafeNonNegativeRemoteDesktopInteger(value.expiresAt)
    || !isSafeNonNegativeRemoteDesktopInteger(value.endpointGeneration)
    // A non-advancing or unbounded lifetime would make the one-time context
    // either dead on arrival or effectively permanent.
    || value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_TTL_MS
    || containsRemoteDesktopSecretField(value)) return invalid();
  if (remoteDesktopUtf8Bytes(JSON.stringify(value)) > REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_BYTES) {
    return invalid();
  }
  return ok<RemoteDesktopShellLaunchContext>(value);
}

const REMOTE_DESKTOP_SHELL_RECOVERY_REASONS = new Set<string>(
  Object.values(REMOTE_DESKTOP_SHELL_RECOVERY_REASON),
);

/**
 * Shell lifecycle messages ride only the authenticated controlled-node
 * channel. They carry presentation identity or fail-closed recovery state,
 * never an Owner session, bearer, password, bootstrap or management grant.
 */
export function validateRemoteDesktopShellMessage(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopShellMessage> {
  if (!isRemoteDesktopRecord(value)) return invalid();
  if (value.type === REMOTE_DESKTOP_SHELL_MSG.LAUNCH) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'context'])) return invalid();
    const context = validateRemoteDesktopShellLaunchContext(value.context);
    if (!context.ok) return invalid();
    return ok<RemoteDesktopShellLaunchMessage>({
      type: REMOTE_DESKTOP_SHELL_MSG.LAUNCH,
      context: context.value,
    });
  }
  if (value.type === REMOTE_DESKTOP_SHELL_MSG.RECOVERY_REQUIRED) {
    if (!hasExactRemoteDesktopKeys(
      value,
      ['type', 'hostId', 'epochId', 'endpointGeneration', 'reason'],
    )
      || !isRemoteDesktopId(value.hostId)
      || !isRemoteDesktopId(value.epochId)
      || !isSafeNonNegativeRemoteDesktopInteger(value.endpointGeneration)
      || typeof value.reason !== 'string'
      || !REMOTE_DESKTOP_SHELL_RECOVERY_REASONS.has(value.reason)
      || containsRemoteDesktopSecretField(value)) return invalid();
    return ok<RemoteDesktopShellRecoveryRequiredMessage>(value as unknown as RemoteDesktopShellRecoveryRequiredMessage);
  }
  return invalid();
}

/**
 * A launch context proves presentation identity only while it is unexpired and
 * still describes the endpoint generation it was minted against. An endpoint
 * replacement invalidates it: the shell would otherwise keep speaking for a
 * desktop that has moved.
 */
export function isRemoteDesktopShellLaunchContextCurrent(
  context: RemoteDesktopShellLaunchContext,
  expected: { hostId: string; endpointGeneration: number },
  nowMs: number,
): boolean {
  return context.hostId === expected.hostId
    && context.endpointGeneration === expected.endpointGeneration
    && nowMs < context.expiresAt;
}

/** A route and the exact generation the acknowledgement is bound to. */
export interface RemoteDesktopRouteGeneration {
  routeId: string;
  routeGeneration: number;
}

/**
 * Durable per-host privacy epoch.
 *
 * Delivery is durable state plus monotonic polling, never process-local
 * memory: shell/browser/pod/Worker disconnect, message loss, route churn or a
 * cluster restart must not be able to reopen admission or visible capture.
 */
export interface RemoteDesktopPrivacyEpoch {
  hostId: string;
  epochId: string;
  /** Monotonic. A lower revision is always a stale no-op. */
  revision: number;
  phase: RemoteDesktopPrivacyPhase;
  admission: RemoteDesktopPrivacyAdmission;
  presentationSource: RemoteDesktopPresentationSource;
  executionEndpointServerId: string;
  leaseExpiresAt: number;
  /** Complete sorted snapshot the owning pod must acknowledge. */
  routeSnapshot: readonly RemoteDesktopRouteGeneration[];
  workerGeneration: number;
  acknowledgedRoutes: readonly RemoteDesktopRouteGeneration[];
}

export interface RemoteDesktopPrivacyBegin {
  type: typeof REMOTE_DESKTOP_PRIVACY_MSG.BEGIN;
  hostId: string;
  epochId: string;
  revision: number;
  presentationSource: RemoteDesktopPresentationSource;
  deadlineAt: number;
  /** Exact durable snapshot the Worker must match before acknowledging. */
  routeSnapshot: readonly RemoteDesktopRouteGeneration[];
}

export interface RemoteDesktopPrivacyAck {
  type: typeof REMOTE_DESKTOP_PRIVACY_MSG.ACK;
  hostId: string;
  epochId: string;
  revision: number;
  workerGeneration: number;
  routes: readonly RemoteDesktopRouteGeneration[];
}

export interface RemoteDesktopPrivacyEnd {
  type: typeof REMOTE_DESKTOP_PRIVACY_MSG.END;
  hostId: string;
  epochId: string;
  revision: number;
  /** Proof of a fresh post-secret frame; a cached pre-end frame cannot satisfy it. */
  freshFrameWorkerGeneration: number;
}

export type RemoteDesktopPrivacyMessage =
  | RemoteDesktopPrivacyBegin
  | RemoteDesktopPrivacyAck
  | RemoteDesktopPrivacyEnd;

const PRIVACY_SOURCES = new Set<string>(Object.values(REMOTE_DESKTOP_PRESENTATION_SOURCE));

function isRouteGenerationList(value: unknown): value is RemoteDesktopRouteGeneration[] {
  if (!Array.isArray(value) || value.length > REMOTE_DESKTOP_PRIVACY_LIMITS.MAX_ACK_ROUTES) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRemoteDesktopRecord(entry)
      || !hasExactRemoteDesktopKeys(entry, ['routeId', 'routeGeneration'])
      || !isRemoteDesktopId(entry.routeId)
      || !isSafeNonNegativeRemoteDesktopInteger(entry.routeGeneration)) return false;
    if (seen.has(entry.routeId)) return false;
    seen.add(entry.routeId);
  }
  return true;
}

/**
 * These messages carry no account session, token or password by construction:
 * exact-key validation means an implementation that tries to attach one is
 * rejected at the wire rather than trusted and logged.
 */
export function validateRemoteDesktopPrivacyMessage(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopPrivacyMessage> {
  if (!isRemoteDesktopRecord(value) || typeof value.type !== 'string') return invalid();
  if (value.type === REMOTE_DESKTOP_PRIVACY_MSG.BEGIN) {
    if (!hasExactRemoteDesktopKeys(value, [
      'type', 'hostId', 'epochId', 'revision', 'presentationSource', 'deadlineAt', 'routeSnapshot',
    ])
      || !isRemoteDesktopId(value.hostId)
      || !isRemoteDesktopId(value.epochId)
      || !isSafeNonNegativeRemoteDesktopInteger(value.revision)
      || typeof value.presentationSource !== 'string' || !PRIVACY_SOURCES.has(value.presentationSource)
      || !isSafeNonNegativeRemoteDesktopInteger(value.deadlineAt)
      || !isRouteGenerationList(value.routeSnapshot)) return invalid();
    return ok<RemoteDesktopPrivacyMessage>(value);
  }
  if (value.type === REMOTE_DESKTOP_PRIVACY_MSG.ACK) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'hostId', 'epochId', 'revision', 'workerGeneration', 'routes'])
      || !isRemoteDesktopId(value.hostId)
      || !isRemoteDesktopId(value.epochId)
      || !isSafeNonNegativeRemoteDesktopInteger(value.revision)
      || !isSafeNonNegativeRemoteDesktopInteger(value.workerGeneration)
      || !isRouteGenerationList(value.routes)) return invalid();
    return ok<RemoteDesktopPrivacyMessage>(value);
  }
  if (value.type === REMOTE_DESKTOP_PRIVACY_MSG.END) {
    if (!hasExactRemoteDesktopKeys(value, ['type', 'hostId', 'epochId', 'revision', 'freshFrameWorkerGeneration'])
      || !isRemoteDesktopId(value.hostId)
      || !isRemoteDesktopId(value.epochId)
      || !isSafeNonNegativeRemoteDesktopInteger(value.revision)
      || !isSafeNonNegativeRemoteDesktopInteger(value.freshFrameWorkerGeneration)) return invalid();
    return ok<RemoteDesktopPrivacyMessage>(value);
  }
  return invalid();
}

/**
 * An acknowledgement enables secret UI only when it is complete and current.
 *
 * Wrong pod, stale revision, replaced Worker generation or a partial route set
 * must all fail closed — a subset would mean some remote viewer is still
 * showing real pixels while the owner types a password.
 */
export function isCompleteRemoteDesktopPrivacyAck(
  epoch: RemoteDesktopPrivacyEpoch,
  ack: RemoteDesktopPrivacyAck,
  owningPodServerId: string,
): boolean {
  if (owningPodServerId !== epoch.executionEndpointServerId) return false;
  if (ack.hostId !== epoch.hostId || ack.epochId !== epoch.epochId) return false;
  if (ack.revision !== epoch.revision) return false;
  if (ack.workerGeneration !== epoch.workerGeneration) return false;
  if (ack.routes.length !== epoch.routeSnapshot.length) return false;
  const acked = new Map(ack.routes.map((entry) => [entry.routeId, entry.routeGeneration]));
  return epoch.routeSnapshot.every((entry) => acked.get(entry.routeId) === entry.routeGeneration);
}

/**
 * Legal phase transitions. `recovery_required` is terminal for the epoch:
 * remote presentations stay shielded until authoritative cleanup and a fresh
 * post-secret frame succeed, which is a new epoch rather than a rollback.
 */
export function isRemoteDesktopPrivacyTransitionAllowed(
  from: RemoteDesktopPrivacyPhase,
  to: RemoteDesktopPrivacyPhase,
): boolean {
  if (from === REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED) return false;
  if (to === REMOTE_DESKTOP_PRIVACY_PHASE.RECOVERY_REQUIRED) return true;
  if (from === REMOTE_DESKTOP_PRIVACY_PHASE.STARTING) return to === REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE;
  if (from === REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE) return to === REMOTE_DESKTOP_PRIVACY_PHASE.ENDING;
  return false;
}

/* ------------------------------------------------------------------------ */
/* 2.7 Durable outbox effects, guest audit and redaction                     */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_OUTBOX_EFFECT = {
  TERMINAL: 'terminal',
  DOWNGRADE: 'downgrade',
  DEADLINE_UPDATE: 'deadline_update',
} as const;

export type RemoteDesktopOutboxEffect =
  typeof REMOTE_DESKTOP_OUTBOX_EFFECT[keyof typeof REMOTE_DESKTOP_OUTBOX_EFFECT];

export const REMOTE_DESKTOP_OUTBOX_SCOPE = {
  ROUTE: 'route',
  HOST: 'host',
} as const;

export type RemoteDesktopOutboxScope =
  typeof REMOTE_DESKTOP_OUTBOX_SCOPE[keyof typeof REMOTE_DESKTOP_OUTBOX_SCOPE];

export const REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND = {
  LINK: 'link',
  PASSWORD: 'password',
} as const;

export type RemoteDesktopOutboxAuthorityKind =
  typeof REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND[keyof typeof REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND];

/**
 * One durable row per effect. Route-scoped rows name the internal target
 * `serverId`; host-scoped terminal expiry deliberately does not. In both cases
 * only a pod that currently owns the resolved bridge may apply and acknowledge
 * the effect. Observation alone never counts as delivery.
 */
interface RemoteDesktopOutboxEventBase {
  idempotencyKey: string;
  sequence: number;
  effect: RemoteDesktopOutboxEffect;
  hostId: string;
  actorAuditId: string;
}

interface RemoteDesktopLinkOutboxAuthority {
  authorityKind: typeof REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.LINK;
  authorityGeneration: number;
  expiryRevision: number;
  commitRevision: number;
}

interface RemoteDesktopPasswordOutboxAuthority {
  authorityKind: typeof REMOTE_DESKTOP_OUTBOX_AUTHORITY_KIND.PASSWORD;
  /** Exact durable guest-session identity; never a bearer or route alias. */
  sessionAuditId: string;
  /** New credential generation that invalidated this older live session. */
  passwordGeneration: number;
}

interface RemoteDesktopRouteOutboxTarget {
  scope: typeof REMOTE_DESKTOP_OUTBOX_SCOPE.ROUTE;
  targetServerId: string;
  routeGeneration: number;
}

interface RemoteDesktopLinkRouteOutboxEvent
  extends RemoteDesktopOutboxEventBase, RemoteDesktopLinkOutboxAuthority, RemoteDesktopRouteOutboxTarget {
  /** Only meaningful for `deadline_update`; absolute, never a delta. */
  deadlineAt?: number;
}

/** A route-scoped effect is deliverable only by the pod owning this exact
 * endpoint and route generation. Those routing fields never become optional. */
export interface RemoteDesktopPasswordRouteOutboxEvent
  extends RemoteDesktopOutboxEventBase, RemoteDesktopPasswordOutboxAuthority, RemoteDesktopRouteOutboxTarget {
  effect: typeof REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL;
  deadlineAt?: never;
}

export type RemoteDesktopRouteOutboxEvent =
  | RemoteDesktopLinkRouteOutboxEvent
  | RemoteDesktopPasswordRouteOutboxEvent;

/** Natural expiry can occur while no route exists. It still needs one durable,
 * ordered terminal fact so reconnect cannot revive the expired authority. */
export interface RemoteDesktopHostOutboxEvent
  extends RemoteDesktopOutboxEventBase, RemoteDesktopLinkOutboxAuthority {
  scope: typeof REMOTE_DESKTOP_OUTBOX_SCOPE.HOST;
  effect: typeof REMOTE_DESKTOP_OUTBOX_EFFECT.TERMINAL;
  targetServerId: null;
  routeGeneration: null;
  deadlineAt?: never;
}

export type RemoteDesktopOutboxEvent =
  | RemoteDesktopRouteOutboxEvent
  | RemoteDesktopHostOutboxEvent;

export type RemoteDesktopOutboxEventWithoutSequence =
  RemoteDesktopOutboxEvent extends infer Event
    ? Event extends unknown ? Omit<Event, 'sequence'> : never
    : never;

/** Natural expiry keys on link + expiry revision + expiry, so two workers
 *  racing the same due row cannot emit two semantic expirations. */
export function remoteDesktopExpiryIdempotencyKey(
  linkId: string,
  expiryRevision: number,
  expiresAt: number,
): string {
  return `${linkId}:${expiryRevision}:${expiresAt}`;
}

/** A deadline update may only reduce; renewal takes the minimum of the two. */
export function resolveRemoteDesktopDeadline(routeDeadlineAt: number, authoritativeDeadlineAt: number): number {
  return Math.min(routeDeadlineAt, authoritativeDeadlineAt);
}

export const REMOTE_DESKTOP_GUEST_AUDIT_EVENT = {
  LINK_CLAIMED: 'remote_desktop.guest.link_claimed',
  LINK_ADMITTED: 'remote_desktop.guest.link_admitted',
  PASSWORD_ADMITTED: 'remote_desktop.guest.password_admitted',
  CONSENT_DENIED: 'remote_desktop.guest.consent_denied',
  AUTHORITY_REVOKED: 'remote_desktop.guest.authority_revoked',
  DEADLINE_REDUCED: 'remote_desktop.guest.deadline_reduced',
} as const;

export type RemoteDesktopGuestAuditEvent =
  typeof REMOTE_DESKTOP_GUEST_AUDIT_EVENT[keyof typeof REMOTE_DESKTOP_GUEST_AUDIT_EVENT];

/**
 * Field names that must never be persisted to an audit row or log.
 *
 * Kept as data, not as a code comment, so the redaction test can assert the
 * whole set instead of whichever names its author happened to remember.
 */
export const REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS: readonly string[] = [
  'token',
  'rawToken',
  'linkToken',
  'password',
  'passwordAttempt',
  'verifier',
  'salt',
  'pepper',
  'browserPrivateKey',
  'launchSecret',
];

/**
 * Strips forbidden fields at any depth. Returning a copy rather than mutating
 * matters: the caller usually still needs the original to complete the very
 * operation being audited.
 */
export function redactRemoteDesktopAuditRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactRemoteDesktopAuditRecord(entry));
  if (!isRemoteDesktopRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS.includes(key)) continue;
    out[key] = redactRemoteDesktopAuditRecord(child);
  }
  return out;
}

/**
 * True when a message carries any forbidden secret-shaped field.
 *
 * Node, Worker, consent and privacy messages are checked with this before they
 * are accepted: the design forbids raw bearer or password bytes from ever
 * entering those paths, and a validator that only checks known keys would
 * happily pass a nested `{ payload: { password } }`.
 */
export function containsRemoteDesktopSecretField(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((entry) => containsRemoteDesktopSecretField(entry, depth + 1));
  if (!isRemoteDesktopRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS.includes(key)) return true;
    if (containsRemoteDesktopSecretField(child, depth + 1)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------ */
/* 2.9 Pre-proof disclosure boundary                                         */
/* ------------------------------------------------------------------------ */

/**
 * Fields a public lookup must never reveal before link/password proof.
 *
 * `serverId` leads the list because it is the one field that is genuinely
 * non-secret *after* proof — it is just a routing key — which makes it the
 * easiest to leak by accident into a preview, an error body or a rate-limit
 * response. The rest are the metadata the design withholds so that unknown,
 * retired, disabled, offline, unsupported and unauthorized principals are
 * indistinguishable.
 */
export const REMOTE_DESKTOP_PRE_PROOF_FORBIDDEN_FIELDS: readonly string[] = [
  'serverId',
  'hostId',
  'name',
  'hostname',
  'ownerUserId',
  'ownerLabel',
  'online',
  'os',
  'platform',
  'endpoints',
  'endpointGeneration',
  'capabilities',
  'publicNodeId',
];

/**
 * The single bounded shape every failed or pre-proof lookup returns.
 *
 * One shape for every outcome is the whole point: a different body, key set or
 * length for "retired" versus "unknown" would re-create the enumeration oracle
 * the constant-work schedule exists to remove.
 */
export interface RemoteDesktopPublicLookupResult {
  status: 'unavailable';
}

export const REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE: RemoteDesktopPublicLookupResult = { status: 'unavailable' };

/**
 * True when a body destined for a pre-proof response carries anything the
 * boundary forbids, at any depth.
 *
 * Depth-exhaustion returns true rather than false: a body nested deeper than
 * the scanner can see is itself a reason to refuse, not a reason to trust.
 */
export function containsRemoteDesktopPreProofDisclosure(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsRemoteDesktopPreProofDisclosure(entry, depth + 1));
  }
  if (!isRemoteDesktopRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    if (REMOTE_DESKTOP_PRE_PROOF_FORBIDDEN_FIELDS.includes(key)) return true;
    if (containsRemoteDesktopPreProofDisclosure(child, depth + 1)) return true;
  }
  return false;
}

/**
 * Fails closed: pre-proof responses are either the exact generic unavailable
 * body or a content-free browser-claim challenge. A challenge is returned for
 * every canonical bearer request, including unresolved ones, so its presence
 * is not an existence oracle.
 */
export function isRemoteDesktopPreProofResponseSafe(value: unknown): boolean {
  const unavailable = isRemoteDesktopRecord(value)
    && hasExactRemoteDesktopKeys(value, ['status'])
    && value.status === REMOTE_DESKTOP_PUBLIC_LOOKUP_UNAVAILABLE.status
    && !containsRemoteDesktopPreProofDisclosure(value);
  if (unavailable) return true;
  return validateRemoteDesktopClaimChallenge(value).ok
    && !containsRemoteDesktopPreProofDisclosure(value);
}

/* ------------------------------------------------------------------------ */
/* 2.5 + 2.9 Strict request validators and rejection rules                   */
/* ------------------------------------------------------------------------ */

export const REMOTE_DESKTOP_ACCESS_LIMITS = {
  STEP_UP_DIGEST_LENGTH: 64,
  PASSWORD_MIN_BYTES: 12,
  PASSWORD_MAX_BYTES: 256,
  WALL_MAX_HOSTS: 16,
} as const;

/**
 * Frozen browser-claim wire format.
 *
 * WebCrypto keeps the private key non-exportable. The exported P-256 SPKI is
 * public and has one canonical 91-byte DER representation; its SHA-256 digest
 * is the browser-key thumbprint. WebCrypto ECDSA signatures use the raw
 * IEEE-P1363 `r || s` representation, not ASN.1 DER.
 */
export const REMOTE_DESKTOP_BROWSER_CLAIM = {
  KEY_ALGORITHM: 'ECDSA_P256_SHA256',
  PUBLIC_KEY_SPKI_BYTES: 91,
  PUBLIC_KEY_SPKI_ENCODED_LENGTH: 122,
  THUMBPRINT_BYTES: 32,
  THUMBPRINT_ENCODED_LENGTH: 43,
  CHALLENGE_ID_BYTES: 32,
  CHALLENGE_ID_ENCODED_LENGTH: 43,
  CHALLENGE_BYTES: 32,
  CHALLENGE_ENCODED_LENGTH: 43,
  SIGNATURE_BYTES: 64,
  SIGNATURE_ENCODED_LENGTH: 86,
  CHALLENGE_TTL_MS: 60_000,
  SIGNATURE_DOMAIN: 'imcodes.remote-desktop.browser-claim.v1',
  SIGNATURE_DOMAIN_SEPARATOR_BYTE: 0x00,
} as const;

function isCanonicalFixedRemoteDesktopBase64url(value: unknown, encodedLength: number): value is string {
  return typeof value === 'string'
    && value.length === encodedLength
    && BASE64URL_NO_PADDING_RE.test(value);
}

export function isCanonicalRemoteDesktopBrowserKeyThumbprint(value: unknown): value is string {
  return isCanonicalFixedRemoteDesktopBase64url(
    value,
    REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_ENCODED_LENGTH,
  );
}

export function isCanonicalRemoteDesktopBrowserPublicKeySpki(value: unknown): value is string {
  return isCanonicalFixedRemoteDesktopBase64url(
    value,
    REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_ENCODED_LENGTH,
  );
}

/**
 * Returned for every canonical challenge request, including an unresolved
 * bearer. Whether a link exists remains server-side until signature proof.
 */
export interface RemoteDesktopClaimChallenge {
  keyAlgorithm: typeof REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM;
  challengeId: string;
  challenge: string;
  expiresAt: number;
}

export function validateRemoteDesktopClaimChallenge(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopClaimChallenge> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, ['keyAlgorithm', 'challengeId', 'challenge', 'expiresAt'])
    || value.keyAlgorithm !== REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.challengeId,
      REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_ENCODED_LENGTH,
    )
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.challenge,
      REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ENCODED_LENGTH,
    )
    || !isSafeNonNegativeRemoteDesktopInteger(value.expiresAt)) return invalid();
  return ok<RemoteDesktopClaimChallenge>(value);
}

/** Browser proves possession without learning or sending an internal link ID. */
export interface RemoteDesktopClaimProof {
  keyAlgorithm: typeof REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM;
  challengeId: string;
  challenge: string;
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
  signature: string;
}

export function validateRemoteDesktopClaimProof(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopClaimProof> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, [
      'keyAlgorithm', 'challengeId', 'challenge', 'browserPublicKeySpki', 'browserKeyThumbprint', 'signature',
    ])
    || value.keyAlgorithm !== REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.challengeId,
      REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_ENCODED_LENGTH,
    )
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.challenge,
      REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ENCODED_LENGTH,
    )
    || !isCanonicalRemoteDesktopBrowserPublicKeySpki(value.browserPublicKeySpki)
    || !isCanonicalRemoteDesktopBrowserKeyThumbprint(value.browserKeyThumbprint)
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.signature,
      REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_ENCODED_LENGTH,
    )
    || containsRemoteDesktopSecretField(value)) return invalid();
  return ok<RemoteDesktopClaimProof>(value);
}

/**
 * Exact bytes signed by the browser:
 * UTF8(domain) || 0x00 || challengeId32 || challenge32 || thumbprint32.
 *
 * The Server separately verifies that `thumbprint32 == SHA-256(SPKI)` and
 * imports SPKI as ECDSA P-256 before checking the raw 64-byte signature.
 */
export function remoteDesktopBrowserClaimSignaturePreimage(
  challengeId: Uint8Array,
  challenge: Uint8Array,
  browserKeyThumbprint: Uint8Array,
): Uint8Array {
  if (challengeId.byteLength !== REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_BYTES
    || challenge.byteLength !== REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_BYTES
    || browserKeyThumbprint.byteLength !== REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES) {
    throw new Error('remote_desktop_browser_claim_preimage_length');
  }
  const domain = new TextEncoder().encode(REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_DOMAIN);
  const out = new Uint8Array(domain.byteLength + 1
    + challengeId.byteLength + challenge.byteLength + browserKeyThumbprint.byteLength);
  let offset = 0;
  out.set(domain, offset);
  offset += domain.byteLength;
  out[offset] = REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_DOMAIN_SEPARATOR_BYTE;
  offset += 1;
  out.set(challengeId, offset);
  offset += challengeId.byteLength;
  out.set(challenge, offset);
  offset += challenge.byteLength;
  out.set(browserKeyThumbprint, offset);
  return out;
}

/** A stolen bootstrap ticket is unusable without the browser private key. */
export const REMOTE_DESKTOP_BOOTSTRAP_PROOF = {
  TICKET_BYTES: 32,
  TICKET_ENCODED_LENGTH: 43,
  SIGNATURE_BYTES: REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_BYTES,
  SIGNATURE_ENCODED_LENGTH: REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_ENCODED_LENGTH,
  SIGNATURE_DOMAIN: 'imcodes.remote-desktop.bootstrap-redemption.v1',
  SIGNATURE_DOMAIN_SEPARATOR_BYTE: 0x00,
} as const;

export interface RemoteDesktopBootstrapProof {
  ticket: string;
  browserKeyThumbprint: string;
  signature: string;
}

export function validateRemoteDesktopBootstrapProof(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopBootstrapProof> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, ['ticket', 'browserKeyThumbprint', 'signature'])
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.ticket,
      REMOTE_DESKTOP_BOOTSTRAP_PROOF.TICKET_ENCODED_LENGTH,
    )
    || !isCanonicalRemoteDesktopBrowserKeyThumbprint(value.browserKeyThumbprint)
    || !isCanonicalFixedRemoteDesktopBase64url(
      value.signature,
      REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_ENCODED_LENGTH,
    )
    || containsRemoteDesktopSecretField(value)) return invalid();
  return ok<RemoteDesktopBootstrapProof>(value);
}

/**
 * Exact bootstrap possession proof:
 * UTF8(domain) || 0x00 || ticket32 || thumbprint32.
 * Ticket single-use supplies replay resistance; its durable row supplies the
 * exact host, target endpoint, actor and authority-generation binding.
 */
export function remoteDesktopBootstrapSignaturePreimage(
  ticket: Uint8Array,
  browserKeyThumbprint: Uint8Array,
): Uint8Array {
  if (ticket.byteLength !== REMOTE_DESKTOP_BOOTSTRAP_PROOF.TICKET_BYTES
    || browserKeyThumbprint.byteLength !== REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_BYTES) {
    throw new Error('remote_desktop_bootstrap_preimage_length');
  }
  const domain = new TextEncoder().encode(REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_DOMAIN);
  const out = new Uint8Array(domain.byteLength + 1 + ticket.byteLength + browserKeyThumbprint.byteLength);
  let offset = 0;
  out.set(domain, offset);
  offset += domain.byteLength;
  out[offset] = REMOTE_DESKTOP_BOOTSTRAP_PROOF.SIGNATURE_DOMAIN_SEPARATOR_BYTE;
  offset += 1;
  out.set(ticket, offset);
  offset += ticket.byteLength;
  out.set(browserKeyThumbprint, offset);
  return out;
}

/**
 * Bootstrap redemption is hash-only, short-lived and single-use.
 *
 * `serverId` may appear here because redemption happens after proof; it is a
 * routing key and never authorization. Before proof it must not be disclosed
 * at all, which is why no pre-proof contract in this module carries it.
 */
export interface RemoteDesktopBootstrapRedemption {
  ticketId: string;
  hostId: string;
  serverId: string;
  source: RemoteDesktopActorSource;
  mode: RemoteDesktopAccessMode;
  credentialGeneration: number;
  browserPublicKeySpki: string;
  browserKeyThumbprint: string;
  expiresAt: number;
}

const ACTOR_SOURCES = new Set<string>(Object.values(REMOTE_DESKTOP_ACTOR_SOURCE));

export function validateRemoteDesktopBootstrapRedemption(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopBootstrapRedemption> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, [
      'ticketId', 'hostId', 'serverId', 'source', 'mode',
      'credentialGeneration', 'browserPublicKeySpki', 'browserKeyThumbprint', 'expiresAt',
    ])
    || !isRemoteDesktopId(value.ticketId)
    || !isRemoteDesktopId(value.hostId)
    || !isRemoteDesktopId(value.serverId)
    || typeof value.source !== 'string' || !ACTOR_SOURCES.has(value.source)
    || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)
    || !isSafeNonNegativeRemoteDesktopInteger(value.credentialGeneration)
    || !isCanonicalRemoteDesktopBrowserPublicKeySpki(value.browserPublicKeySpki)
    || !isCanonicalRemoteDesktopBrowserKeyThumbprint(value.browserKeyThumbprint)
    || !isSafeNonNegativeRemoteDesktopInteger(value.expiresAt)
    || containsRemoteDesktopSecretField(value)) return invalid();
  return ok<RemoteDesktopBootstrapRedemption>(value);
}

/**
 * Single-use step-up grant. Bound to account session, canonical host, the
 * complete normalized action digest, the request ID and a deadline, so a grant
 * minted for one action cannot authorize a different retry.
 */
export interface RemoteDesktopStepUpGrant {
  grantId: string;
  accountSessionId: string;
  hostId: string;
  actionDigest: string;
  requestId: string;
  expiresAt: number;
}

export function validateRemoteDesktopStepUpGrant(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopStepUpGrant> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, ['grantId', 'accountSessionId', 'hostId', 'actionDigest', 'requestId', 'expiresAt'])
    || !isRemoteDesktopId(value.grantId)
    || !isRemoteDesktopId(value.accountSessionId)
    || !isRemoteDesktopId(value.hostId)
    || !isRemoteDesktopLinkTokenHash(value.actionDigest)
    || !isCanonicalRemoteDesktopCreationRequestId(value.requestId)
    || !isSafeNonNegativeRemoteDesktopInteger(value.expiresAt)) return invalid();
  return ok<RemoteDesktopStepUpGrant>(value);
}

export function isRemoteDesktopStepUpGrantUsable(
  grant: RemoteDesktopStepUpGrant,
  expected: Omit<RemoteDesktopStepUpGrant, 'grantId' | 'expiresAt'>,
  nowMs: number,
): boolean {
  return grant.accountSessionId === expected.accountSessionId
    && grant.hostId === expected.hostId
    && grant.actionDigest === expected.actionDigest
    && grant.requestId === expected.requestId
    && nowMs < grant.expiresAt;
}

/** Owner link creation request: hash only, never the raw bearer. */
export interface RemoteDesktopLinkCreateRequest {
  hostId: string;
  creationRequestId: string;
  tokenHashVersion: typeof REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION;
  tokenHash: string;
  kind: RemoteDesktopLinkKind;
  mode: RemoteDesktopAccessMode;
  label: string;
  durationMs?: number;
}

const LINK_KINDS = new Set<string>(Object.values(REMOTE_DESKTOP_LINK_KIND));

export function validateRemoteDesktopLinkCreateRequest(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopLinkCreateRequest> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(
      value,
      ['hostId', 'creationRequestId', 'tokenHashVersion', 'tokenHash', 'kind', 'mode', 'label'],
      ['durationMs'],
    )
    || !isRemoteDesktopId(value.hostId)
    || !isCanonicalRemoteDesktopCreationRequestId(value.creationRequestId)
    || value.tokenHashVersion !== REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION
    || !isRemoteDesktopLinkTokenHash(value.tokenHash)
    || typeof value.kind !== 'string' || !LINK_KINDS.has(value.kind)
    || typeof value.mode !== 'string' || !ACCESS_MODES.has(value.mode)
    || !isBoundedRemoteDesktopString(value.label, REMOTE_DESKTOP_LINK_LIMITS.LABEL_BYTES)
    || containsRemoteDesktopSecretField(value)) return invalid();
  // Attended links never expire; unattended links require one exact duration.
  if (value.kind === REMOTE_DESKTOP_LINK_KIND.UNATTENDED) {
    if (!isRemoteDesktopLinkDurationMs(value.durationMs)) return invalid();
  } else if (value.durationMs !== undefined) {
    return invalid();
  }
  return ok<RemoteDesktopLinkCreateRequest>(value);
}

export interface RemoteDesktopPasswordMutation {
  hostId: string;
  action: 'set' | 'change' | 'disable';
  requestId: string;
  /** Absent for `disable`; never persisted or echoed. */
  password?: string;
}

export function validateRemoteDesktopPasswordMutation(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopPasswordMutation> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, ['hostId', 'action', 'requestId'], ['password'])
    || !isRemoteDesktopId(value.hostId)
    || !isCanonicalRemoteDesktopCreationRequestId(value.requestId)
    || (value.action !== 'set' && value.action !== 'change' && value.action !== 'disable')) return invalid();
  if (value.action === 'disable') {
    if (value.password !== undefined) return invalid();
  } else {
    if (typeof value.password !== 'string') return invalid();
    const bytes = remoteDesktopUtf8Bytes(value.password);
    if (bytes < REMOTE_DESKTOP_ACCESS_LIMITS.PASSWORD_MIN_BYTES
      || bytes > REMOTE_DESKTOP_ACCESS_LIMITS.PASSWORD_MAX_BYTES) return invalid();
  }
  return ok<RemoteDesktopPasswordMutation>(value);
}

/** CAS wall mutation. Every operation carries the revision it expects. */
export const REMOTE_DESKTOP_WALL_OPERATION = {
  ADD: 'add',
  REMOVE: 'remove',
  REORDER: 'reorder',
} as const;

export type RemoteDesktopWallOperation =
  typeof REMOTE_DESKTOP_WALL_OPERATION[keyof typeof REMOTE_DESKTOP_WALL_OPERATION];

export interface RemoteDesktopWallMutation {
  operation: RemoteDesktopWallOperation;
  expectedRevision: number;
  hostIds: readonly string[];
}

const WALL_OPERATIONS = new Set<string>(Object.values(REMOTE_DESKTOP_WALL_OPERATION));

export function validateRemoteDesktopWallMutation(
  value: unknown,
): RemoteDesktopValidationResult<RemoteDesktopWallMutation> {
  if (!isRemoteDesktopRecord(value)
    || !hasExactRemoteDesktopKeys(value, ['operation', 'expectedRevision', 'hostIds'])
    || typeof value.operation !== 'string' || !WALL_OPERATIONS.has(value.operation)
    || !isSafeNonNegativeRemoteDesktopInteger(value.expectedRevision)
    || !Array.isArray(value.hostIds)
    || value.hostIds.length > REMOTE_DESKTOP_ACCESS_LIMITS.WALL_MAX_HOSTS
    || !value.hostIds.every((entry) => isRemoteDesktopId(entry))
    // Duplicate memberships would make one tile's revoke ambiguous.
    || new Set(value.hostIds as string[]).size !== value.hostIds.length) return invalid();
  return ok<RemoteDesktopWallMutation>(value);
}

/**
 * Secret-bearing operations must present a current epoch at commit, so a
 * direct API call cannot bypass the on-screen barrier.
 */
export function isRemoteDesktopPrivacyEpochCurrent(
  epoch: RemoteDesktopPrivacyEpoch,
  presented: { epochId: string; revision: number },
): boolean {
  return epoch.phase === REMOTE_DESKTOP_PRIVACY_PHASE.ACTIVE
    && epoch.admission === REMOTE_DESKTOP_PRIVACY_ADMISSION.CLOSED
    && presented.epochId === epoch.epochId
    && presented.revision === epoch.revision;
}
