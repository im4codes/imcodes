import { timingSafeEqual } from 'node:crypto';
import {
  PEER_AUDIT_REPLY_ERRORS,
  PEER_AUDIT_REPLY_VERSION,
  decodePeerAuditReplyEnvelopeStructure,
  decodePeerAuditReplyTextStructure,
  sanitizePeerAuditUntrustedText,
  validatePeerAuditPassEvidence,
  type PeerAuditParse,
  type PeerAuditReplyEnvelope,
  type PeerAuditReplyError,
  type PeerAuditValidationItem,
  type PeerAuditVerdict,
} from '../../shared/peer-audit.js';
import { isValidImcodesSessionName } from '../../shared/session-scope.js';
import { getSession, type SessionRecord } from '../store/session-store.js';

export const PEER_AUDIT_REPLY_RATE_LIMIT_WINDOW_MS = 60_000;
export const PEER_AUDIT_REPLY_RATE_LIMIT_MAX = 12;
export const PEER_AUDIT_REPLY_RATE_LIMIT_TTL_MS = 5 * 60_000;
export const PEER_AUDIT_REPLY_RATE_LIMIT_CAPACITY = 1_024;

export interface PeerAuditReplyRateIdentity {
  sessionInstanceId: string;
  runtimeEpoch: string;
}

interface PeerAuditReplyRateEntry {
  arrivals: number[];
  lastSeenAt: number;
}

export interface PeerAuditReplyRateLimiterOptions {
  windowMs?: number;
  maxArrivals?: number;
  ttlMs?: number;
  capacity?: number;
}

/** Bounded TTL/LRU limiter keyed by logical session instance plus runtime authority. */
export class PeerAuditReplyRateLimiter {
  readonly #windowMs: number;
  readonly #maxArrivals: number;
  readonly #ttlMs: number;
  readonly #capacity: number;
  readonly #entries = new Map<string, PeerAuditReplyRateEntry>();

  constructor(options: PeerAuditReplyRateLimiterOptions = {}) {
    this.#windowMs = Math.max(1, options.windowMs ?? PEER_AUDIT_REPLY_RATE_LIMIT_WINDOW_MS);
    this.#maxArrivals = Math.max(1, options.maxArrivals ?? PEER_AUDIT_REPLY_RATE_LIMIT_MAX);
    this.#ttlMs = Math.max(this.#windowMs, options.ttlMs ?? PEER_AUDIT_REPLY_RATE_LIMIT_TTL_MS);
    this.#capacity = Math.max(1, options.capacity ?? PEER_AUDIT_REPLY_RATE_LIMIT_CAPACITY);
  }

  admit(identity: PeerAuditReplyRateIdentity, now: number): boolean {
    this.#prune(now);
    const key = JSON.stringify([identity.sessionInstanceId, identity.runtimeEpoch]);
    const threshold = now - this.#windowMs;
    const existing = this.#entries.get(key);
    const entry: PeerAuditReplyRateEntry = {
      arrivals: (existing?.arrivals ?? []).filter((arrival) => arrival > threshold),
      lastSeenAt: now,
    };
    const admitted = entry.arrivals.length < this.#maxArrivals;
    if (admitted) entry.arrivals.push(now);

    // Delete/set makes the Map insertion order the LRU order, including denied
    // callers, while preserving a hard capacity bound.
    if (existing) this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return admitted;
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(now: number): void {
    const oldestAllowed = now - this.#ttlMs;
    for (const [key, entry] of this.#entries) {
      if (entry.lastSeenAt <= oldestAllowed) this.#entries.delete(key);
    }
  }
}

export type PeerAuditReplyIngressResult =
  | { ok: true }
  | { ok: false; error: PeerAuditReplyError | 'sender_unavailable' | 'ingress_unavailable' };

export type PeerAuditReplyInternalReason =
  | 'accepted'
  | 'capability_rejected'
  | 'sender_identity_rejected'
  | 'destination_identity_rejected'
  | 'baseline_rejected'
  | 'revision_rejected'
  | 'deadline_expired'
  | 'evidence_rejected'
  | 'reducer_rejected';

type PeerAuditReplyIngressHandlerResult = PeerAuditReplyIngressResult
  | { ok: false; error: PeerAuditReplyError | 'sender_unavailable' | 'ingress_unavailable'; internalReason: PeerAuditReplyInternalReason };

export type PeerAuditReplyIngressHandler = (input: {
  envelope: PeerAuditReplyEnvelope;
  sender: SessionRecord;
  receivedAt: number;
}) => PeerAuditReplyIngressHandlerResult | Promise<PeerAuditReplyIngressHandlerResult>;

export interface PeerAuditReplyBoundIdentity {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
}

/** Immutable authority captured when the attempt is installed. */
export interface PeerAuditReplyAuthority {
  attemptId: string;
  sender: PeerAuditReplyBoundIdentity;
  destination: PeerAuditReplyBoundIdentity;
  baselineId: string;
  targetRevision: string;
  configRevision: string;
  controllerRevision: number;
  deadlineAt: number;
}

/** Current daemon-authoritative bindings checked immediately before reduction. */
export interface PeerAuditReplyCurrentBindings {
  sender?: PeerAuditReplyBoundIdentity;
  destination?: PeerAuditReplyBoundIdentity;
  baselineId?: string;
  baselineValid: boolean;
  targetRevision?: string;
  configRevision?: string;
  controllerRevision?: number;
}

export interface PeerAuditAcceptedReply {
  attemptId: string;
  verdict: PeerAuditVerdict;
  findings: string;
  validations: PeerAuditValidationItem[];
  receivedAt: number;
  controllerRevision: number;
}

export type PeerAuditReplyReducerDecision<T> =
  | { accepted: true; value: T }
  | { accepted: false };

export type PeerAuditReplyAuthorityResult<T> =
  | { ok: true; value: T; internalReason: 'accepted' }
  | { ok: false; error: PeerAuditReplyError; internalReason: Exclude<PeerAuditReplyInternalReason, 'accepted'> };

export interface PeerAuditReplyAuthorityPipelineInput<T> {
  envelope: PeerAuditReplyEnvelope;
  receivedAt: number;
  authority?: PeerAuditReplyAuthority;
  current: PeerAuditReplyCurrentBindings;
  capabilityMatches: (providedCapability: string) => boolean;
  onInvalidReply?: (reason: Exclude<PeerAuditReplyInternalReason, 'accepted' | 'deadline_expired' | 'reducer_rejected'>) => void;
  onDeadline: () => void;
  reduce: (reply: PeerAuditAcceptedReply) => PeerAuditReplyReducerDecision<T>;
}

let activeHandler: PeerAuditReplyIngressHandler | null = null;
const ingressRateLimiter = new PeerAuditReplyRateLimiter();

export function registerPeerAuditReplyIngressHandler(handler: PeerAuditReplyIngressHandler | null): void {
  activeHandler = handler;
}

export function clearPeerAuditReplyIngressRateLimits(): void {
  ingressRateLimiter.clear();
}

/** CLI accepts a versioned envelope; MCP supplies the same fields without version. */
export function decodePeerAuditReplyCommandStructure(raw: unknown): PeerAuditParse<PeerAuditReplyEnvelope> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED };
  }
  const object = raw as Record<string, unknown>;
  return decodePeerAuditReplyEnvelopeStructure(
    Object.prototype.hasOwnProperty.call(object, 'version')
      ? object
      : { ...object, version: PEER_AUDIT_REPLY_VERSION },
  );
}

/** Constant-time comparison used by controller/reply validation. */
export function peerAuditCapabilityMatches(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export function foldPeerAuditReplyPublicError(reason: Exclude<PeerAuditReplyInternalReason, 'accepted'>): PeerAuditReplyError {
  switch (reason) {
    case 'capability_rejected':
      return PEER_AUDIT_REPLY_ERRORS.INVALID_CAPABILITY;
    case 'sender_identity_rejected':
    case 'destination_identity_rejected':
    case 'baseline_rejected':
    case 'revision_rejected':
    case 'reducer_rejected':
      return PEER_AUDIT_REPLY_ERRORS.IDENTITY_MISMATCH;
    case 'deadline_expired':
      return PEER_AUDIT_REPLY_ERRORS.DEADLINE_EXPIRED;
    case 'evidence_rejected':
      return PEER_AUDIT_REPLY_ERRORS.INSUFFICIENT_VALIDATION_EVIDENCE;
  }
}

function identityMatches(expected: PeerAuditReplyBoundIdentity, actual: PeerAuditReplyBoundIdentity | undefined): boolean {
  return actual?.sessionName === expected.sessionName
    && actual.sessionInstanceId === expected.sessionInstanceId
    && actual.runtimeEpoch === expected.runtimeEpoch;
}

/**
 * Runs only after raw cap/schema/rate admission. The ordering here is the
 * authority boundary: deadline and evidence are invisible until all bindings
 * are valid, and only sanitized data reaches the reducer.
 */
export function processPeerAuditReplyAuthority<T>(
  input: PeerAuditReplyAuthorityPipelineInput<T>,
): PeerAuditReplyAuthorityResult<T> {
  const reject = (
    internalReason: Exclude<PeerAuditReplyInternalReason, 'accepted' | 'deadline_expired' | 'reducer_rejected'>,
  ): PeerAuditReplyAuthorityResult<T> => {
    input.onInvalidReply?.(internalReason);
    return { ok: false, error: foldPeerAuditReplyPublicError(internalReason), internalReason };
  };

  const authority = input.authority;
  if (!authority || authority.attemptId !== input.envelope.attemptId
    || !input.capabilityMatches(input.envelope.replyCapability)) {
    return reject('capability_rejected');
  }
  if (!identityMatches(authority.sender, input.current.sender)) return reject('sender_identity_rejected');
  if (!identityMatches(authority.destination, input.current.destination)) return reject('destination_identity_rejected');
  if (!input.current.baselineValid || input.current.baselineId !== authority.baselineId) {
    return reject('baseline_rejected');
  }
  if (input.current.targetRevision !== authority.targetRevision
    || input.current.configRevision !== authority.configRevision
    || input.current.controllerRevision !== authority.controllerRevision) {
    return reject('revision_rejected');
  }
  if (input.receivedAt >= authority.deadlineAt) {
    input.onDeadline();
    return {
      ok: false,
      error: foldPeerAuditReplyPublicError('deadline_expired'),
      internalReason: 'deadline_expired',
    };
  }
  const evidence = validatePeerAuditPassEvidence(input.envelope.verdict, input.envelope.validations);
  if (!evidence.ok) return reject('evidence_rejected');

  const decision = input.reduce({
    attemptId: input.envelope.attemptId,
    verdict: input.envelope.verdict,
    findings: sanitizePeerAuditUntrustedText(input.envelope.findings),
    validations: input.envelope.validations.map((validation) => ({
      ...validation,
      label: sanitizePeerAuditUntrustedText(validation.label),
      summary: sanitizePeerAuditUntrustedText(validation.summary),
    })),
    receivedAt: input.receivedAt,
    controllerRevision: authority.controllerRevision,
  });
  if (!decision.accepted) {
    return {
      ok: false,
      error: foldPeerAuditReplyPublicError('reducer_rejected'),
      internalReason: 'reducer_rejected',
    };
  }
  return { ok: true, value: decision.value, internalReason: 'accepted' };
}

export async function submitPeerAuditReply(input: {
  rawBody: string;
  senderSessionName: string | undefined;
  now?: number;
}): Promise<PeerAuditReplyIngressResult> {
  const now = input.now ?? Date.now();
  // Apply the untrusted-body budget and strict schema firewall before any
  // sender lookup or rate-limit state allocation.
  const decoded = decodePeerAuditReplyTextStructure(input.rawBody);
  if (!decoded.ok) return { ok: false, error: decoded.error as PeerAuditReplyError };
  const senderSessionName = input.senderSessionName?.trim();
  if (!senderSessionName || !isValidImcodesSessionName(senderSessionName)) {
    return { ok: false, error: 'sender_unavailable' };
  }
  const sender = getSession(senderSessionName);
  if (!sender || sender.state === 'stopped' || sender.state === 'error'
    || !sender.sessionInstanceId || !sender.runtimeEpoch) {
    return { ok: false, error: 'sender_unavailable' };
  }
  // Admit only an authoritative live logical instance/runtime pair. A same-name
  // recreated session receives a separate bucket and stale names allocate none.
  if (!ingressRateLimiter.admit({
    sessionInstanceId: sender.sessionInstanceId,
    runtimeEpoch: sender.runtimeEpoch,
  }, now)) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.RATE_LIMITED };
  }
  if (!activeHandler) return { ok: false, error: 'ingress_unavailable' };
  const handled = await activeHandler({ envelope: decoded.value, sender, receivedAt: now });
  // Internal reasons are deliberately not part of the public daemon response.
  return handled.ok ? { ok: true } : { ok: false, error: handled.error };
}
