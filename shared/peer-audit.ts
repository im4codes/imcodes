import { redactSensitiveText } from './redact-secrets.js';

// Single shared source of truth for the lightweight peer-supervision-audit
// contract (design "One shared peer-audit contract"). Owns contract/reply
// versions, trigger/selection/disposition/verdict enums, the exact v1 byte/count
// limits, the LAYERED stable reason/error/outcome constants, the candidate /
// reply / result / dispatch / baseline types, the command payload types, and the
// strict inbound parsers (unknown-key / UTF-8 byte size / base64url / bounded
// list rejection).
//
// Isolation rule: peer-audit reasons/errors NEVER extend or overload ordinary
// agent-delegation schemas; everything here is namespaced and self-contained.
// Zero-hardcoded-protocol-string rule: every wire string lives in a const here
// and is referenced elsewhere — never re-typed in daemon/Web modules.

// ── Contract versions ────────────────────────────────────────────────────────

/** Brief/prompt contract version emitted on a new snapshot. */
export const PEER_AUDIT_PROMPT_VERSION = 'supervision_peer_audit_v1' as const;
/** Structured reply envelope version (the auditor's one reply). */
export const PEER_AUDIT_REPLY_VERSION = 'peer_audit_reply_v1' as const;
/** Umbrella contract version for candidate/result/command payloads. */
export const PEER_AUDIT_CONTRACT_VERSION = 'peer_audit_v1' as const;
export const PEER_AUDIT_COMPLETED_TURN_PAYLOAD_FIELD = 'peerAuditCompletedTurn' as const;
export const PEER_AUDIT_MESSAGES = {
  CANDIDATES: 'peer_audit.candidates',
  QUICK_RESULT: 'peer_audit.quick_result',
  CANCEL_RESULT: 'peer_audit.cancel_result',
} as const;

/** Control-plane and command validation errors shared by daemon/server/Web. */
export const PEER_AUDIT_COMMAND_ERRORS = {
  DAEMON_UNAVAILABLE: 'daemon_unavailable',
  ROUTE_RESERVATION_FAILED: 'peer_audit_route_reservation_failed',
  AUDITED_SESSION_UNAVAILABLE: 'audited_session_unavailable',
  AUDITED_IDENTITY_CHANGED: 'audited_identity_changed',
  AUDITED_SESSION_NOT_ORDINARY: 'audited_session_not_ordinary',
  AUDITED_IDENTITY_UNAVAILABLE: 'audited_identity_unavailable',
  MALFORMED_COMMAND: 'malformed_command',
  INVALID_COMMAND_ID: 'invalid_command_id',
  INVALID_AUDITED_SESSION_NAME: 'invalid_audited_session_name',
  INVALID_AUDITED_SESSION_INSTANCE_ID: 'invalid_audited_session_instance_id',
  INVALID_CANDIDATE_REVISION: 'invalid_candidate_revision',
  INVALID_TARGET_CONFIG_REVISION: 'invalid_target_config_revision',
  INVALID_SELECTION_INTENT: 'invalid_selection_intent',
  INVALID_TARGET: 'invalid_target',
  INVALID_ATTEMPT_ID: 'invalid_attempt_id',
  INVALID_REVISION: 'invalid_revision',
  INVALID_CANDIDATES: 'invalid_candidates',
} as const;
export type PeerAuditCommandError = (typeof PEER_AUDIT_COMMAND_ERRORS)[keyof typeof PEER_AUDIT_COMMAND_ERRORS];

export type PeerAuditPromptVersion = typeof PEER_AUDIT_PROMPT_VERSION;
export type PeerAuditReplyVersion = typeof PEER_AUDIT_REPLY_VERSION;

// ── Enums (tuple + type + guard) ─────────────────────────────────────────────

export const PEER_AUDIT_TRIGGERS = ['automatic', 'quick'] as const;
export type PeerAuditTrigger = (typeof PEER_AUDIT_TRIGGERS)[number];
export function isPeerAuditTrigger(v: unknown): v is PeerAuditTrigger {
  return typeof v === 'string' && (PEER_AUDIT_TRIGGERS as readonly string[]).includes(v);
}

export const PEER_AUDIT_SELECTION_INTENTS = ['remembered_fast_path', 'explicit_picker'] as const;
export type PeerAuditSelectionIntent = (typeof PEER_AUDIT_SELECTION_INTENTS)[number];
export function isPeerAuditSelectionIntent(v: unknown): v is PeerAuditSelectionIntent {
  return typeof v === 'string' && (PEER_AUDIT_SELECTION_INTENTS as readonly string[]).includes(v);
}

export const PEER_AUDIT_RUNTIME_DISPOSITIONS = ['sent', 'queued', 'sent_unrevocable'] as const;
export type PeerAuditRuntimeDisposition = (typeof PEER_AUDIT_RUNTIME_DISPOSITIONS)[number];
export function isPeerAuditRuntimeDisposition(v: unknown): v is PeerAuditRuntimeDisposition {
  return typeof v === 'string' && (PEER_AUDIT_RUNTIME_DISPOSITIONS as readonly string[]).includes(v);
}

export const PEER_AUDIT_VERDICTS = ['PASS', 'REWORK'] as const;
export type PeerAuditVerdict = (typeof PEER_AUDIT_VERDICTS)[number];
export function isPeerAuditVerdict(v: unknown): v is PeerAuditVerdict {
  return typeof v === 'string' && (PEER_AUDIT_VERDICTS as readonly string[]).includes(v);
}

export const PEER_AUDIT_VALIDATION_KINDS = ['test', 'typecheck', 'lint', 'build', 'tool', 'device', 'environment'] as const;
export type PeerAuditValidationKind = (typeof PEER_AUDIT_VALIDATION_KINDS)[number];
export function isPeerAuditValidationKind(v: unknown): v is PeerAuditValidationKind {
  return typeof v === 'string' && (PEER_AUDIT_VALIDATION_KINDS as readonly string[]).includes(v);
}

export const PEER_AUDIT_VALIDATION_OUTCOMES = ['passed', 'failed', 'unavailable'] as const;
export type PeerAuditValidationOutcome = (typeof PEER_AUDIT_VALIDATION_OUTCOMES)[number];
export function isPeerAuditValidationOutcome(v: unknown): v is PeerAuditValidationOutcome {
  return typeof v === 'string' && (PEER_AUDIT_VALIDATION_OUTCOMES as readonly string[]).includes(v);
}

/** Controller phase for a single serialized attempt. */
export const PEER_AUDIT_PHASES = ['preparing', 'sent', 'queued', 'sent_unrevocable', 'waiting_reply'] as const;
export type PeerAuditPhase = (typeof PEER_AUDIT_PHASES)[number];
export function isPeerAuditPhase(v: unknown): v is PeerAuditPhase {
  return typeof v === 'string' && (PEER_AUDIT_PHASES as readonly string[]).includes(v);
}

// ── Exact v1 limits (all UTF-8 bytes unless a *_COUNT) ────────────────────────

export const PEER_AUDIT_DEADLINE_MS = 360_000;
export const PEER_AUDIT_BRIEF_TOTAL_BYTES = 32 * 1024;
export const PEER_AUDIT_BRIEF_REQUEST_BYTES = 8 * 1024;
export const PEER_AUDIT_BRIEF_RESULT_BYTES = 8 * 1024;
export const PEER_AUDIT_PATH_COUNT = 128;
export const PEER_AUDIT_PATH_ITEM_BYTES = 512;
export const PEER_AUDIT_VALIDATION_COUNT = 32;
export const PEER_AUDIT_VALIDATION_ITEM_BYTES = 512;
export const PEER_AUDIT_REPLY_TOTAL_BYTES = 24 * 1024;
export const PEER_AUDIT_FINDINGS_BYTES = 16 * 1024;
export const PEER_AUDIT_TIMELINE_PREVIEW_BYTES = 4 * 1024;
export const PEER_AUDIT_REWORK_INPUT_BYTES = 8 * 1024;
export const PEER_AUDIT_TOMBSTONE_CAPACITY = 1024;
export const PEER_AUDIT_TOMBSTONE_TTL_MS = 30 * 60_000;

/** Minimum reply-capability entropy: ≥ 192 random bits (base64url, 6 bits/char → 32 chars). */
export const PEER_AUDIT_CAPABILITY_MIN_BITS = 192;
export const PEER_AUDIT_CAPABILITY_MIN_CHARS = Math.ceil(PEER_AUDIT_CAPABILITY_MIN_BITS / 6); // 32
/** Upper bound so a decoder never accepts an unbounded "capability" string. */
export const PEER_AUDIT_CAPABILITY_MAX_CHARS = 512;
/** Defensive cap on the daemon→Web candidate list (not a peer-controlled inbound frame). */
export const PEER_AUDIT_CANDIDATE_COUNT = 256;
/** Bound for identity strings (names/instances/epochs/ids) inside inbound frames. */
export const PEER_AUDIT_ID_MAX_BYTES = 256;

// ── Layered stable reason / error / outcome constants ────────────────────────
// Separated by layer so a caller cannot confuse a candidate reason with a reply
// error or a terminal outcome (design "Stable errors are separated by layer").

/** Snapshot / configuration layer (target repair, fingerprint, CAS). */
export const PEER_AUDIT_CONFIG_ERRORS = {
  MISSING_TARGET_FINGERPRINT: 'missing_target_fingerprint',
  REPAIR_REQUIRED: 'repair_required',
  CONFIG_CONFLICT: 'config_conflict',
  NOT_AUTHORIZED: 'not_authorized',
  SUPERVISED_AUDIT_UNRUNNABLE: 'supervised_audit_unrunnable',
} as const;
export type PeerAuditConfigError = (typeof PEER_AUDIT_CONFIG_ERRORS)[keyof typeof PEER_AUDIT_CONFIG_ERRORS];

/** Candidate eligibility layer — the single stable reason attached to each candidate. */
export const PEER_AUDIT_CANDIDATE_REASONS = {
  ELIGIBLE: 'eligible',
  SELF: 'self',
  NOT_DIRECT_CHILD: 'not_direct_child',
  CROSS_PROJECT: 'cross_project',
  NOT_REPLY_CAPABLE: 'not_reply_capable',
  EXECUTION_CLONE: 'execution_clone',
  BUSY_STATE: 'busy_state',
  UNKNOWN_IDENTITY: 'unknown_identity',
} as const;
export type PeerAuditCandidateReason = (typeof PEER_AUDIT_CANDIDATE_REASONS)[keyof typeof PEER_AUDIT_CANDIDATE_REASONS];
export function isPeerAuditCandidateReason(v: unknown): v is PeerAuditCandidateReason {
  return typeof v === 'string' && (Object.values(PEER_AUDIT_CANDIDATE_REASONS) as string[]).includes(v);
}

/** Command / preflight layer (list_candidates / quick_start / cancel). */
export const PEER_AUDIT_PREFLIGHT_ERRORS = {
  CANDIDATE_REFRESH_REQUIRED: 'candidate_refresh_required',
  PEER_AUDIT_BUSY: 'peer_audit_busy',
  AWAITING_PEER_AUDIT_SLOT: 'awaiting_peer_audit_slot',
  BASELINE_ACTIVE: 'baseline_active',
  BASELINE_PARTIAL: 'baseline_partial',
  BASELINE_NO_RESULT: 'baseline_no_result',
  BASELINE_STALE: 'baseline_stale',
  BASELINE_UNRELATED: 'baseline_unrelated',
  MODEL_NOT_DIFFERENT: 'model_not_different',
  TARGET_INELIGIBLE: 'target_ineligible',
  TARGET_RUNTIME_BUSY_UNCANCELLABLE: 'target_runtime_busy_uncancellable',
  ATTEMPT_NOT_FOUND: 'attempt_not_found',
} as const;
export type PeerAuditPreflightError = (typeof PEER_AUDIT_PREFLIGHT_ERRORS)[keyof typeof PEER_AUDIT_PREFLIGHT_ERRORS];

/** Reply layer (the daemon-only structured reply command). */
export const PEER_AUDIT_REPLY_ERRORS = {
  OVERSIZE: 'oversize',
  MALFORMED: 'malformed',
  INVALID_VERSION: 'invalid_version',
  UNKNOWN_FIELD: 'unknown_field',
  INVALID_ATTEMPT_ID: 'invalid_attempt_id',
  INVALID_CAPABILITY: 'invalid_capability',
  INVALID_VERDICT: 'invalid_verdict',
  INVALID_FINDINGS: 'invalid_findings',
  INVALID_VALIDATIONS: 'invalid_validations',
  INSUFFICIENT_VALIDATION_EVIDENCE: 'insufficient_validation_evidence',
  IDENTITY_MISMATCH: 'identity_mismatch',
  DEADLINE_EXPIRED: 'deadline_expired',
  RATE_LIMITED: 'rate_limited',
} as const;
export type PeerAuditReplyError = (typeof PEER_AUDIT_REPLY_ERRORS)[keyof typeof PEER_AUDIT_REPLY_ERRORS];

/** Terminal outcome layer (result event). */
export const PEER_AUDIT_TERMINAL_OUTCOMES = {
  PASS: 'pass',
  REWORK: 'rework',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  TARGET_UNAVAILABLE: 'target_unavailable',
  INVALID_CONFIGURATION: 'invalid_configuration',
} as const;
export type PeerAuditTerminalOutcome = (typeof PEER_AUDIT_TERMINAL_OUTCOMES)[keyof typeof PEER_AUDIT_TERMINAL_OUTCOMES];
export function isPeerAuditTerminalOutcome(v: unknown): v is PeerAuditTerminalOutcome {
  return typeof v === 'string' && (Object.values(PEER_AUDIT_TERMINAL_OUTCOMES) as string[]).includes(v);
}

// ── Core contract types ──────────────────────────────────────────────────────

/** Two-layer target fingerprint saved on the audited-session snapshot. */
export interface PeerAuditTargetFingerprint {
  sessionInstanceId: string;
  normalizedModelId: string;
  providerFamily: string;
}

export const PEER_AUDIT_UNKNOWN_IDENTITY = 'unknown' as const;

export interface PeerAuditModelMetadata {
  /** Authoritative live/effective model; accepted exactly after canonical trim/case normalization. */
  activeModel?: string | null;
  /** Explicit persisted/requested model; accepted only through known ids or aliases. */
  requestedModel?: string | null;
  configuredModel?: string | null;
}

const PEER_AUDIT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'opus[1m]',
  'opus[1m]': 'opus[1m]',
  fable: 'fable',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

function canonicalExactModelToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || peerAuditByteLength(trimmed) > PEER_AUDIT_ID_MAX_BYTES) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  return trimmed;
}

/** Resolve model equality without family substring/fuzzy inference. Live model
 * metadata wins; configured fallbacks require an explicit known id or alias. */
export function resolvePeerAuditNormalizedModelId(
  metadata: PeerAuditModelMetadata,
  options: { knownModelIds?: readonly string[]; aliases?: Readonly<Record<string, string>> } = {},
): string {
  const active = canonicalExactModelToken(metadata.activeModel);
  if (active) return options.aliases?.[active] ?? PEER_AUDIT_MODEL_ALIASES[active] ?? active;
  const aliases = { ...PEER_AUDIT_MODEL_ALIASES, ...(options.aliases ?? {}) };
  const known = new Map<string, string>(
    (options.knownModelIds ?? [])
      .map((id) => canonicalExactModelToken(id))
      .filter((canonical): canonical is string => canonical !== null)
      .map((canonical) => [canonical, canonical] as [string, string]),
  );
  for (const raw of [metadata.requestedModel, metadata.configuredModel]) {
    const candidate = canonicalExactModelToken(raw);
    if (!candidate) continue;
    const alias = aliases[candidate];
    if (alias) return alias;
    const exact = known.get(candidate);
    if (exact) return exact;
  }
  return PEER_AUDIT_UNKNOWN_IDENTITY;
}

const PEER_AUDIT_PROVIDER_FAMILY_BY_ID: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  'claude-code-sdk': 'anthropic',
  'claude-code': 'anthropic',
  openai: 'openai',
  'codex-sdk': 'openai',
  codex: 'openai',
  google: 'google',
  'gemini-sdk': 'google',
  gemini: 'google',
  xai: 'xai',
  'grok-sdk': 'xai',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  moonshot: 'moonshot',
  'kimi-sdk': 'moonshot',
  github: 'github',
  'copilot-sdk': 'github',
  cursor: 'cursor',
  'cursor-headless': 'cursor',
  qoder: 'qoder',
  'qoder-sdk': 'qoder',
  openclaw: 'openclaw',
};

/** Provider family is independent of model normalization. Authoritative
 * providerId wins; agent type is only an explicit fallback mapping. */
export function resolvePeerAuditProviderFamily(input: {
  providerId?: string | null;
  agentType?: string | null;
}): string {
  const providerId = input.providerId?.trim().toLowerCase();
  if (providerId) return PEER_AUDIT_PROVIDER_FAMILY_BY_ID[providerId] ?? PEER_AUDIT_UNKNOWN_IDENTITY;
  const agentType = input.agentType?.trim().toLowerCase();
  return (agentType && PEER_AUDIT_PROVIDER_FAMILY_BY_ID[agentType]) || PEER_AUDIT_UNKNOWN_IDENTITY;
}

export interface PeerAuditCandidate {
  name: string;
  label: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
  normalizedModelId: string;
  providerFamily: string;
  liveState: string;
  dispositionCapability: PeerAuditRuntimeDisposition;
  eligible: boolean;
  reason: PeerAuditCandidateReason;
}

export interface PeerAuditCandidateList {
  revision: string;
  targetConfigRevision: string;
  auditedSessionName: string;
  auditedSessionInstanceId: string;
  candidates: PeerAuditCandidate[];
}

export interface PeerAuditValidationItem {
  kind: PeerAuditValidationKind;
  label: string;
  outcome: PeerAuditValidationOutcome;
  summary: string;
}

/** The auditor's one strict reply envelope. */
export interface PeerAuditReplyEnvelope {
  version: PeerAuditReplyVersion;
  attemptId: string;
  replyCapability: string;
  verdict: PeerAuditVerdict;
  findings: string;
  validations: PeerAuditValidationItem[];
}

export interface PeerAuditDispatchReceipt {
  disposition: PeerAuditRuntimeDisposition;
  dispatchId: string;
  messageId: string;
  targetSessionInstanceId: string;
  targetRuntimeEpoch: string;
  queueEpoch?: string;
}

/** Structured, memory-excluded terminal event (not assistant text). */
export interface PeerAuditResultEvent {
  eventId: string;
  auditedSessionName: string;
  trigger: PeerAuditTrigger;
  outcome: PeerAuditTerminalOutcome;
  auditorSessionName: string;
  auditorLabel?: string;
  elapsedMs: number;
  disposition?: PeerAuditRuntimeDisposition;
  findingsPreview?: string;
  reason?: string;
}

/** Daemon-internal authority evidence emitted only at a clean transport idle
 * boundary. A merged multi-message dispatch intentionally produces no record. */
export interface PeerAuditCompletedTurnEvidence {
  taskCommandId: string;
  assistantText: string;
  completedEventId: string;
  completedAt: number;
  generationOrEpoch: number;
}

// ── Command payload types (daemon commands) ──────────────────────────────────

/** Target identity the daemon recomputes eligibility against before dispatch. */
export interface PeerAuditTargetIdentity {
  auditorSessionName: string;
  auditorSessionInstanceId: string;
  auditorRuntimeEpoch: string;
}

export interface PeerAuditListCandidatesCommand {
  /** Idempotent command id (dedupes retries). */
  commandId: string;
  auditedSessionName: string;
  auditedSessionInstanceId: string;
}

export interface PeerAuditQuickStartCommand {
  commandId: string;
  auditedSessionName: string;
  auditedSessionInstanceId: string;
  /** Candidate-list revision the Web view chose against (daemon rejects on mismatch). */
  candidateRevision: string;
  targetConfigRevision: string;
  selectionIntent: PeerAuditSelectionIntent;
  target: PeerAuditTargetIdentity;
}

export interface PeerAuditCancelCommand {
  commandId: string;
  auditedSessionName: string;
  auditedSessionInstanceId: string;
  attemptId: string;
}

// ── Strict parsing helpers ───────────────────────────────────────────────────

/** Discriminated parse result (isolated from ordinary delegation validators). */
export type PeerAuditParse<T> = { ok: true; value: T } | { ok: false; error: string };

/** UTF-8 byte length (all limits are bytes). Web-safe: uses TextEncoder, not Node Buffer. */
export function peerAuditByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** A reply capability must be base64url with ≥ 192 bits of entropy and bounded length. */
export function isPeerAuditCapability(v: unknown): v is string {
  return typeof v === 'string'
    && v.length >= PEER_AUDIT_CAPABILITY_MIN_CHARS
    && v.length <= PEER_AUDIT_CAPABILITY_MAX_CHARS
    && BASE64URL_RE.test(v);
}

/** A human-readable identifier/name of nonzero, bounded byte length. */
export function isPeerAuditIdString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && peerAuditByteLength(v) <= PEER_AUDIT_ID_MAX_BYTES;
}

/** Opaque identities, epochs, revisions, and attempt ids are strict unpadded
 * base64url. Keep this separate from human session names and labels. */
export function isPeerAuditOpaqueId(v: unknown): v is string {
  return isPeerAuditIdString(v) && BASE64URL_RE.test(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  for (const key of Object.keys(obj)) if (!allowed.has(key)) return `${PEER_AUDIT_REPLY_ERRORS.UNKNOWN_FIELD}:${key}`;
  return null;
}

const LIST_COMMAND_KEYS = new Set(['commandId', 'auditedSessionName', 'auditedSessionInstanceId']);
const QUICK_COMMAND_KEYS = new Set([
  'commandId', 'auditedSessionName', 'auditedSessionInstanceId', 'candidateRevision', 'targetConfigRevision', 'selectionIntent', 'target',
]);
const CANCEL_COMMAND_KEYS = new Set(['commandId', 'auditedSessionName', 'auditedSessionInstanceId', 'attemptId']);
const TARGET_IDENTITY_KEYS = new Set(['auditorSessionName', 'auditorSessionInstanceId', 'auditorRuntimeEpoch']);

function decodeAuditedCommandBase(raw: Record<string, unknown>): PeerAuditParse<{
  commandId: string;
  auditedSessionName: string;
  auditedSessionInstanceId: string;
}> {
  if (!isPeerAuditOpaqueId(raw.commandId)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_COMMAND_ID };
  if (!isPeerAuditIdString(raw.auditedSessionName)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_AUDITED_SESSION_NAME };
  if (!isPeerAuditOpaqueId(raw.auditedSessionInstanceId)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_AUDITED_SESSION_INSTANCE_ID };
  return {
    ok: true,
    value: {
      commandId: raw.commandId,
      auditedSessionName: raw.auditedSessionName,
      auditedSessionInstanceId: raw.auditedSessionInstanceId,
    },
  };
}

export function decodePeerAuditListCandidatesCommand(raw: unknown): PeerAuditParse<PeerAuditListCandidatesCommand> {
  if (!isPlainObject(raw)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.MALFORMED_COMMAND };
  const unknown = rejectUnknownKeys(raw, LIST_COMMAND_KEYS);
  if (unknown) return { ok: false, error: unknown };
  return decodeAuditedCommandBase(raw);
}

export function decodePeerAuditQuickStartCommand(raw: unknown): PeerAuditParse<PeerAuditQuickStartCommand> {
  if (!isPlainObject(raw)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.MALFORMED_COMMAND };
  const unknown = rejectUnknownKeys(raw, QUICK_COMMAND_KEYS);
  if (unknown) return { ok: false, error: unknown };
  const base = decodeAuditedCommandBase(raw);
  if (!base.ok) return base;
  if (!isPeerAuditOpaqueId(raw.candidateRevision)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_CANDIDATE_REVISION };
  if (!isPeerAuditOpaqueId(raw.targetConfigRevision)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_TARGET_CONFIG_REVISION };
  if (!isPeerAuditSelectionIntent(raw.selectionIntent)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_SELECTION_INTENT };
  if (!isPlainObject(raw.target)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_TARGET };
  const targetUnknown = rejectUnknownKeys(raw.target, TARGET_IDENTITY_KEYS);
  if (targetUnknown) return { ok: false, error: targetUnknown };
  if (!isPeerAuditIdString(raw.target.auditorSessionName)
    || !isPeerAuditOpaqueId(raw.target.auditorSessionInstanceId)
    || !isPeerAuditOpaqueId(raw.target.auditorRuntimeEpoch)) {
    return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_TARGET };
  }
  return {
    ok: true,
    value: {
      ...base.value,
      candidateRevision: raw.candidateRevision,
      targetConfigRevision: raw.targetConfigRevision,
      selectionIntent: raw.selectionIntent,
      target: {
        auditorSessionName: raw.target.auditorSessionName,
        auditorSessionInstanceId: raw.target.auditorSessionInstanceId,
        auditorRuntimeEpoch: raw.target.auditorRuntimeEpoch,
      },
    },
  };
}

export function decodePeerAuditCancelCommand(raw: unknown): PeerAuditParse<PeerAuditCancelCommand> {
  if (!isPlainObject(raw)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.MALFORMED_COMMAND };
  const unknown = rejectUnknownKeys(raw, CANCEL_COMMAND_KEYS);
  if (unknown) return { ok: false, error: unknown };
  const base = decodeAuditedCommandBase(raw);
  if (!base.ok) return base;
  if (!isPeerAuditOpaqueId(raw.attemptId)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_ATTEMPT_ID };
  return { ok: true, value: { ...base.value, attemptId: raw.attemptId } };
}

/**
 * Parse a bounded string list under exact count + per-item byte limits.
 * Rejects non-arrays, over-count, and any non-string or over-size item.
 */
export function parsePeerAuditStringList(
  raw: unknown,
  maxCount: number,
  maxItemBytes: number,
): PeerAuditParse<string[]> {
  if (!Array.isArray(raw)) return { ok: false, error: 'not_a_list' };
  if (raw.length > maxCount) return { ok: false, error: 'too_many_items' };
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'string') return { ok: false, error: `invalid_item:${i}` };
    if (peerAuditByteLength(item) > maxItemBytes) return { ok: false, error: `item_too_large:${i}` };
    out.push(item);
  }
  return { ok: true, value: out };
}

/** Parse the validation-summary list (bounded count + strict per-item shape/size). */
export function parsePeerAuditValidationList(raw: unknown): PeerAuditParse<PeerAuditValidationItem[]> {
  if (!Array.isArray(raw)) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS };
  if (raw.length > PEER_AUDIT_VALIDATION_COUNT) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS };
  const allowed = new Set(['kind', 'label', 'outcome', 'summary']);
  const out: PeerAuditValidationItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isPlainObject(item)) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS}:${i}` };
    for (const key of Object.keys(item)) if (!allowed.has(key)) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.UNKNOWN_FIELD}:validations.${i}.${key}` };
    if (!isPeerAuditValidationKind(item.kind)) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS}:${i}.kind` };
    if (!isPeerAuditValidationOutcome(item.outcome)) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS}:${i}.outcome` };
    if (typeof item.label !== 'string' || peerAuditByteLength(item.label) > PEER_AUDIT_VALIDATION_ITEM_BYTES) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS}:${i}.label` };
    if (typeof item.summary !== 'string' || peerAuditByteLength(item.summary) > PEER_AUDIT_VALIDATION_ITEM_BYTES) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.INVALID_VALIDATIONS}:${i}.summary` };
    out.push({ kind: item.kind, label: item.label, outcome: item.outcome, summary: item.summary });
  }
  return { ok: true, value: out };
}

/**
 * Evidence-shape policy (NOT truthfulness): a PASS verdict must carry evidence —
 * at least one `passed` item, OR (when nothing executable could run) all items
 * `unavailable`. An empty or static-only PASS is `insufficient_validation_evidence`.
 * REWORK has no evidence requirement.
 */
export function validatePeerAuditPassEvidence(
  verdict: PeerAuditVerdict,
  validations: readonly PeerAuditValidationItem[],
): PeerAuditParse<true> {
  if (verdict !== 'PASS') return { ok: true, value: true };
  if (validations.length === 0) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INSUFFICIENT_VALIDATION_EVIDENCE };
  const hasPassed = validations.some((v) => v.outcome === 'passed');
  const allUnavailable = validations.every((v) => v.outcome === 'unavailable');
  if (!hasPassed && !allUnavailable) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INSUFFICIENT_VALIDATION_EVIDENCE };
  return { ok: true, value: true };
}

const REPLY_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['version', 'attemptId', 'replyCapability', 'verdict', 'findings', 'validations']);

/** Strict schema decode without applying verdict evidence policy. This is used
 * by daemon ingress so capability/identity checks happen before policy errors
 * are disclosed. */
export function decodePeerAuditReplyEnvelopeStructure(raw: unknown): PeerAuditParse<PeerAuditReplyEnvelope> {
  if (!isPlainObject(raw)) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED };
  const unknown = rejectUnknownKeys(raw, REPLY_ENVELOPE_KEYS);
  if (unknown) return { ok: false, error: unknown };
  if (raw.version !== PEER_AUDIT_REPLY_VERSION) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_VERSION };
  if (!isPeerAuditOpaqueId(raw.attemptId)) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_ATTEMPT_ID };
  if (!isPeerAuditCapability(raw.replyCapability)) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_CAPABILITY };
  if (!isPeerAuditVerdict(raw.verdict)) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_VERDICT };
  if (typeof raw.findings !== 'string' || peerAuditByteLength(raw.findings) > PEER_AUDIT_FINDINGS_BYTES) {
    return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.INVALID_FINDINGS };
  }
  const validations = parsePeerAuditValidationList(raw.validations);
  if (!validations.ok) return { ok: false, error: validations.error };
  return {
    ok: true,
    value: {
      version: PEER_AUDIT_REPLY_VERSION,
      attemptId: raw.attemptId,
      replyCapability: raw.replyCapability,
      verdict: raw.verdict,
      findings: raw.findings,
      validations: validations.value,
    },
  };
}

/** Public full decoder used by trusted callers and tests. */
export function decodePeerAuditReplyEnvelope(raw: unknown): PeerAuditParse<PeerAuditReplyEnvelope> {
  const decoded = decodePeerAuditReplyEnvelopeStructure(raw);
  if (!decoded.ok) return decoded;
  const evidence = validatePeerAuditPassEvidence(decoded.value.verdict, decoded.value.validations);
  if (!evidence.ok) return { ok: false, error: evidence.error };
  return decoded;
}

/**
 * Full inbound path: reject an oversized frame BEFORE JSON parsing (design
 * "Inbound processing rejects an oversized frame before parsing"), then decode.
 */
export function decodePeerAuditReplyText(text: string): PeerAuditParse<PeerAuditReplyEnvelope> {
  if (typeof text !== 'string') return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED };
  if (peerAuditByteLength(text) > PEER_AUDIT_REPLY_TOTAL_BYTES) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.OVERSIZE };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED }; }
  return decodePeerAuditReplyEnvelope(raw);
}

/** Ingress decoder: byte cap + strict schema, with evidence deferred until
 * after capability and identity validation. */
export function decodePeerAuditReplyTextStructure(text: string): PeerAuditParse<PeerAuditReplyEnvelope> {
  if (typeof text !== 'string') return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED };
  if (peerAuditByteLength(text) > PEER_AUDIT_REPLY_TOTAL_BYTES) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.OVERSIZE };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED }; }
  return decodePeerAuditReplyEnvelopeStructure(raw);
}

const CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  'name', 'label', 'sessionInstanceId', 'runtimeEpoch', 'normalizedModelId',
  'providerFamily', 'liveState', 'dispositionCapability', 'eligible', 'reason',
]);
const CANDIDATE_LIST_KEYS: ReadonlySet<string> = new Set(['revision', 'targetConfigRevision', 'auditedSessionName', 'auditedSessionInstanceId', 'candidates']);

/** Strictly decode a daemon→Web candidate list (bounded, strict per-candidate). */
export function decodePeerAuditCandidateList(raw: unknown): PeerAuditParse<PeerAuditCandidateList> {
  if (!isPlainObject(raw)) return { ok: false, error: PEER_AUDIT_REPLY_ERRORS.MALFORMED };
  for (const key of Object.keys(raw)) if (!CANDIDATE_LIST_KEYS.has(key)) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.UNKNOWN_FIELD}:${key}` };
  if (!isPeerAuditOpaqueId(raw.revision)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_REVISION };
  if (!isPeerAuditOpaqueId(raw.targetConfigRevision)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_TARGET_CONFIG_REVISION };
  if (!isPeerAuditIdString(raw.auditedSessionName)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_AUDITED_SESSION_NAME };
  if (!isPeerAuditOpaqueId(raw.auditedSessionInstanceId)) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_AUDITED_SESSION_INSTANCE_ID };
  if (!Array.isArray(raw.candidates) || raw.candidates.length > PEER_AUDIT_CANDIDATE_COUNT) return { ok: false, error: PEER_AUDIT_COMMAND_ERRORS.INVALID_CANDIDATES };
  const candidates: PeerAuditCandidate[] = [];
  for (let i = 0; i < raw.candidates.length; i++) {
    const c = raw.candidates[i];
    if (!isPlainObject(c)) return { ok: false, error: `invalid_candidate:${i}` };
    for (const key of Object.keys(c)) if (!CANDIDATE_KEYS.has(key)) return { ok: false, error: `${PEER_AUDIT_REPLY_ERRORS.UNKNOWN_FIELD}:candidates.${i}.${key}` };
    if (!isPeerAuditIdString(c.name) || typeof c.label !== 'string'
      || !isPeerAuditOpaqueId(c.sessionInstanceId) || !isPeerAuditOpaqueId(c.runtimeEpoch)
      || typeof c.normalizedModelId !== 'string' || typeof c.providerFamily !== 'string'
      || typeof c.liveState !== 'string' || typeof c.eligible !== 'boolean') {
      return { ok: false, error: `invalid_candidate:${i}` };
    }
    if (!isPeerAuditRuntimeDisposition(c.dispositionCapability)) return { ok: false, error: `invalid_candidate:${i}.dispositionCapability` };
    if (!isPeerAuditCandidateReason(c.reason)) return { ok: false, error: `invalid_candidate:${i}.reason` };
    candidates.push({
      name: c.name, label: c.label, sessionInstanceId: c.sessionInstanceId, runtimeEpoch: c.runtimeEpoch,
      normalizedModelId: c.normalizedModelId, providerFamily: c.providerFamily, liveState: c.liveState,
      dispositionCapability: c.dispositionCapability, eligible: c.eligible, reason: c.reason,
    });
  }
  return { ok: true, value: { revision: raw.revision, targetConfigRevision: raw.targetConfigRevision, auditedSessionName: raw.auditedSessionName, auditedSessionInstanceId: raw.auditedSessionInstanceId, candidates } };
}

// ── Legacy / control-marker detection for ordinary /send hardening (task 3.8) ─
// Ordinary `/send` MUST reject text carrying a P2P audit-verdict completion marker
// or any peer-audit control/contract prefix BEFORE runtime delivery, so audit
// completion can flow ONLY through the dedicated daemon reply command — never
// through spoofable chat. These are the single source of truth: hook-server /
// send ingress import this helper instead of re-typing regexes/magic strings.

/** Build the canonical legacy P2P audit-verdict marker for a verdict (no re-typed literals). */
export function peerAuditLegacyVerdictMarker(verdict: PeerAuditVerdict): string {
  return `<!-- P2P_VERDICT: ${verdict} -->`;
}

/** Canonical legacy verdict markers retained only for rejection/sanitization and manual P2P compatibility. */
export const PEER_AUDIT_LEGACY_VERDICT_MARKERS = {
  PASS: peerAuditLegacyVerdictMarker('PASS'),
  REWORK: peerAuditLegacyVerdictMarker('REWORK'),
} as const;

/** Matches any legacy P2P_VERDICT completion marker, tolerating whitespace variants. */
export const PEER_AUDIT_LEGACY_VERDICT_PATTERN = /<!--\s*P2P_VERDICT\s*:\s*(?:PASS|REWORK)\s*-->/;

/**
 * Peer-audit control / contract tokens whose presence in ordinary chat text is an
 * audit-control attempt (version markers, the command namespace, the CLI reply verb).
 */
export const PEER_AUDIT_CONTROL_MARKERS = [
  PEER_AUDIT_REPLY_VERSION,    // 'peer_audit_reply_v1'
  PEER_AUDIT_PROMPT_VERSION,   // 'supervision_peer_audit_v1'
  PEER_AUDIT_CONTRACT_VERSION, // 'peer_audit_v1'
  'peer_audit.',               // daemon command namespace (peer_audit.reply / .quick_start / …)
  'imcodes audit-reply',       // the daemon-only CLI reply verb (no terminal-key fallback)
] as const;

/**
 * True when ordinary `/send` text carries a legacy audit-verdict marker or a
 * peer-audit control/contract token. Such text is rejected before runtime
 * delivery (task 3.8); it can never complete or drive an audit.
 */
export function containsLegacyAuditControlMarker(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (PEER_AUDIT_LEGACY_VERDICT_PATTERN.test(text)) return true;
  const trimmed = text.trimStart();
  return PEER_AUDIT_CONTROL_MARKERS.some((marker) => trimmed.startsWith(marker));
}

/** Neutralize credential-shaped and control material supplied by an auditor
 * before it is persisted, displayed, or embedded in a follow-up prompt. */
export function sanitizePeerAuditUntrustedText(text: string): string {
  return redactSensitiveText(text)
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|capability)\s*[:=]\s*(['"]?)[^\s'";,]+\2/gi,
      (_match, key: string) => `${key}=[REDACTED:peer_audit_secret]`,
    )
    .replace(PEER_AUDIT_LEGACY_VERDICT_PATTERN, '[removed audit control]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Exhaustiveness guard for peer-audit unions (compile-time + runtime safety). */
export function assertNeverPeerAudit(x: never): never {
  throw new Error(`unhandled peer-audit case: ${String(x)}`);
}
