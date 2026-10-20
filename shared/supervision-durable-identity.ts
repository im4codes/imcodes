/**
 * Canonical supervision identity + snapshot/attestation contracts (V1).
 *
 * V1 is the AUTHORITY MODEL only: identity minting, snapshot/attestation shape,
 * promotion rules and recovery vocabulary. It deliberately performs no Git,
 * filesystem or CAS work -- those mechanisms are V2/V3 and must be replaceable
 * without renegotiating this contract.
 *
 * Two properties this file exists to guarantee:
 *
 *  1. A model never controls identity. It may PROPOSE a semantic key for human
 *     legibility; the daemon supplies the uniqueness suffix and mints the
 *     canonical id. Minting is a pure function of (kind, key, suffix) so an
 *     idempotent retry with the same suffix returns the same id, and so this
 *     module needs no entropy source of its own.
 *  2. Audited bytes and promoted bytes are the same bytes. Promotion compares
 *     the attested manifest hash against the snapshot's own hash; any drift is
 *     surfaced as re-audit, never silently absorbed.
 */
import { stableJson } from './memory-content-hash.js';
import { PEER_AUDIT_VERDICTS, type PeerAuditVerdict } from './peer-audit.js';

// ── canonical identity ──────────────────────────────────────────────────────

/** Typed prefixes. Short on purpose: these ids appear in logs and prompts. */
export const SUPERVISION_ID_PREFIXES = Object.freeze({
  task: 'tsk',
  assignment: 'asg',
  auditAttempt: 'aud',
  snapshot: 'snp',
  attestation: 'att',
  workspace: 'wsp',
  lease: 'lse',
} as const);
export type SupervisionIdKind = keyof typeof SUPERVISION_ID_PREFIXES;

export const SUPERVISION_SEMANTIC_KEY_MIN_LENGTH = 3;
export const SUPERVISION_SEMANTIC_KEY_MAX_LENGTH = 64;

/**
 * Reserved keys. A semantic key is a human handle that shows up in task lists;
 * `test`/`tmp`/`default` carry no objective and would collide across unrelated
 * work, which is exactly the silent-reuse this contract forbids.
 */
export const SUPERVISION_SEMANTIC_KEY_RESERVED: readonly string[] = Object.freeze([
  'new', 'test', 'tests', 'tmp', 'temp', 'null', 'undefined', 'none',
  'default', 'system', 'admin', 'internal', 'task', 'assignment', 'todo',
]);

/** Strict kebab-case: no leading/trailing/double dash, lowercase alnum only. */
const SEMANTIC_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type SupervisionSemanticKeyRefusal =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'not_kebab_case'
  | 'reserved';

export function validateSupervisionSemanticKey(
  value: unknown,
): { ok: true; key: string } | { ok: false; reason: SupervisionSemanticKeyRefusal } {
  if (typeof value !== 'string') return { ok: false, reason: 'empty' };
  const key = value.trim();
  if (!key) return { ok: false, reason: 'empty' };
  // Length is checked before shape so an over-long slug reports the useful
  // reason rather than a generic pattern failure.
  if (key.length < SUPERVISION_SEMANTIC_KEY_MIN_LENGTH) return { ok: false, reason: 'too_short' };
  if (key.length > SUPERVISION_SEMANTIC_KEY_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (!SEMANTIC_KEY_PATTERN.test(key)) return { ok: false, reason: 'not_kebab_case' };
  if (SUPERVISION_SEMANTIC_KEY_RESERVED.includes(key)) return { ok: false, reason: 'reserved' };
  return { ok: true, key };
}

/** Uniqueness suffix supplied by the daemon. Never model-provided. */
const LEGACY_UNIQUE_SUFFIX_PATTERN = /^[0-9A-Za-z-]{8,64}$/u;
/** SQLite INTEGER is at most 13 base36 digits; `-1`..`-7` are bounded
 * collision escapes for caller-supplied historical ids occupying a candidate. */
const DURABLE_SEQUENCE_SUFFIX_PATTERN = /^[0-9a-z]{1,13}(?:-[1-7])?$/u;

function isValidUniqueSuffix(value: string): boolean {
  return LEGACY_UNIQUE_SUFFIX_PATTERN.test(value)
    || DURABLE_SEQUENCE_SUFFIX_PATTERN.test(value);
}
/** Audit rounds are daemon-counted; `r0` would imply an attempt that never ran. */
const ROUND_PATTERN = /^r[1-9][0-9]{0,2}$/u;

export interface SupervisionCanonicalIdInput {
  kind: SupervisionIdKind;
  semanticKey: string;
  /** Daemon-supplied unique value. Same suffix ⇒ same id, which is what makes an
   *  idempotent retry return the identical canonical id. */
  uniqueSuffix: string;
  /** Audit attempts only, e.g. `r2`. */
  round?: string;
}

export function mintSupervisionCanonicalId(
  input: SupervisionCanonicalIdInput,
): { ok: true; id: string } | { ok: false; reason: SupervisionSemanticKeyRefusal | 'invalid_suffix' | 'invalid_round' } {
  const key = validateSupervisionSemanticKey(input.semanticKey);
  if (!key.ok) return key;
  if (!isValidUniqueSuffix(input.uniqueSuffix)) return { ok: false, reason: 'invalid_suffix' };
  if (input.round !== undefined && !ROUND_PATTERN.test(input.round)) return { ok: false, reason: 'invalid_round' };
  const prefix = SUPERVISION_ID_PREFIXES[input.kind];
  const round = input.round ? `${input.round}_` : '';
  return { ok: true, id: `${prefix}_${key.key}_${round}${input.uniqueSuffix}` };
}

export interface SupervisionParsedCanonicalId {
  kind: SupervisionIdKind;
  semanticKey: string;
  round?: string;
  uniqueSuffix: string;
}

export type SupervisionOpaqueIdKind = Extract<SupervisionIdKind, 'task' | 'assignment' | 'lease'>;

export interface SupervisionParsedOpaqueId {
  kind: SupervisionOpaqueIdKind;
  sequence: string;
}

/** Parse new local registry ids; semantic ids continue through the canonical parser. */
export function parseSupervisionOpaqueId(value: unknown): SupervisionParsedOpaqueId | undefined {
  if (typeof value !== 'string') return undefined;
  for (const kind of ['task', 'assignment', 'lease'] as const) {
    const prefix = `${SUPERVISION_ID_PREFIXES[kind]}_`;
    if (!value.startsWith(prefix)) continue;
    const sequence = value.slice(prefix.length);
    return DURABLE_SEQUENCE_SUFFIX_PATTERN.test(sequence) ? { kind, sequence } : undefined;
  }
  return undefined;
}

export function parseSupervisionCanonicalId(value: unknown): SupervisionParsedCanonicalId | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.indexOf('_');
  if (separator <= 0) return undefined;
  const prefix = value.slice(0, separator);
  const kind = (Object.keys(SUPERVISION_ID_PREFIXES) as SupervisionIdKind[])
    .find((candidate) => SUPERVISION_ID_PREFIXES[candidate] === prefix);
  if (!kind) return undefined;
  const parts = value.slice(separator + 1).split('_');
  if (parts.length < 2) return undefined;
  const uniqueSuffix = parts[parts.length - 1]!;
  const maybeRound = parts.length >= 3 ? parts[parts.length - 2]! : undefined;
  const round = maybeRound && ROUND_PATTERN.test(maybeRound) ? maybeRound : undefined;
  const key = parts.slice(0, parts.length - (round ? 2 : 1)).join('_');
  if (!isValidUniqueSuffix(uniqueSuffix)) return undefined;
  if (!validateSupervisionSemanticKey(key).ok) return undefined;
  return round ? { kind, semanticKey: key, round, uniqueSuffix } : { kind, semanticKey: key, uniqueSuffix };
}

// ── snapshot + attestation ──────────────────────────────────────────────────

export const SUPERVISION_SNAPSHOT_OPERATIONS = ['created', 'modified', 'deleted'] as const;
export type SupervisionSnapshotOperation = typeof SUPERVISION_SNAPSHOT_OPERATIONS[number];

/** `draft` accumulates edits; `frozen` is immutable and is the only thing an
 *  auditor may be shown; `attested` carries a verdict; `superseded` was replaced
 *  by a child snapshot (REWORK never rewrites history). */
export const SUPERVISION_SNAPSHOT_STATES = ['draft', 'frozen', 'attested', 'superseded'] as const;
export type SupervisionSnapshotState = typeof SUPERVISION_SNAPSHOT_STATES[number];

export const SUPERVISION_CLAIM_MODES = ['exclusive', 'shared', 'read_only'] as const;
export type SupervisionClaimMode = typeof SUPERVISION_CLAIM_MODES[number];

export interface SupervisionSnapshotManifestEntry {
  path: string;
  operation: SupervisionSnapshotOperation;
  /** Absent for `created`. */
  beforeBlob?: string;
  /** Absent for `deleted`. */
  afterBlob?: string;
  claimMode: SupervisionClaimMode;
  ownerAssignmentId: string;
}

/**
 * Deterministic manifest hash.
 *
 * Entries are sorted by path so two assignments that touched the same files in
 * a different order produce the same hash; `stableJson` (reused, not restated)
 * makes key order irrelevant.
 */
export function buildSupervisionManifestHash(
  entries: readonly SupervisionSnapshotManifestEntry[],
  digest: (canonical: string) => string,
): string {
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return digest(stableJson(sorted));
}

export interface SupervisionSnapshotRecord {
  snapshotId: string;
  taskId: string;
  assignmentId: string;
  /** Immutable base the assignment started from. */
  baseSha: string;
  /** Set when this snapshot is a REWORK child; the parent stays intact. */
  parentSnapshotId?: string;
  manifestHash: string;
  entries: readonly SupervisionSnapshotManifestEntry[];
  state: SupervisionSnapshotState;
  createdAt: number;
}

export interface SupervisionAuditAttestation {
  attestationId: string;
  taskId: string;
  assignmentId: string;
  snapshotId: string;
  /** Frozen tree identity when V2/V3 materializes one; absent in V1. */
  treeSha?: string;
  /** The manifest hash the auditor actually saw. */
  manifestHash: string;
  evidenceHash: string;
  attemptId: string;
  auditorSessionName: string;
  auditorSessionInstanceId: string;
  auditorRuntimeEpoch: string;
  auditorProvider: string;
  auditorModel: string;
  verdict: PeerAuditVerdict;
  createdAt: number;
}

export function isSupervisionPassVerdict(value: unknown): value is 'PASS' {
  return value === PEER_AUDIT_VERDICTS[0];
}

// ── promotion rules ─────────────────────────────────────────────────────────

export type SupervisionPromotionRefusal =
  | 'snapshot_not_frozen'
  | 'no_attestation'
  | 'attestation_snapshot_mismatch'
  | 'attestation_attempt_mismatch'
  | 'verdict_not_pass'
  | 'manifest_drift'
  | 'shared_claim_unattested'
  | 'integration_signoff_required';

export interface SupervisionSharedClaimState {
  path: string;
  assignmentId: string;
  /** Whether THAT claim has its own matching PASS. */
  attested: boolean;
}

export interface SupervisionPromotionInput {
  snapshot: SupervisionSnapshotRecord;
  attestation?: SupervisionAuditAttestation;
  /** The attempt the promotion is being requested against. */
  attemptId: string;
  /** Every active claim on the shared paths inside this snapshot. */
  sharedClaims?: readonly SupervisionSharedClaimState[];
  integrationOwnerSignoff?: boolean;
}

/**
 * May this snapshot become merge-eligible (V2+) / checkpointed?
 *
 * Fail-closed at every step. In particular an exclusive file promotes on its own
 * PASS, while a shared file requires that EVERY active claim included in that
 * blob is itself attested AND the integration owner signed off -- otherwise the
 * promotion defers rather than shipping another owner's unaudited hunk.
 */
export function canPromoteSupervisionSnapshot(
  input: SupervisionPromotionInput,
): { ok: true } | { ok: false; reason: SupervisionPromotionRefusal } {
  const { snapshot, attestation } = input;
  if (snapshot.state !== 'frozen' && snapshot.state !== 'attested') {
    return { ok: false, reason: 'snapshot_not_frozen' };
  }
  if (!attestation) return { ok: false, reason: 'no_attestation' };
  if (attestation.snapshotId !== snapshot.snapshotId) {
    return { ok: false, reason: 'attestation_snapshot_mismatch' };
  }
  if (attestation.attemptId !== input.attemptId) {
    return { ok: false, reason: 'attestation_attempt_mismatch' };
  }
  if (!isSupervisionPassVerdict(attestation.verdict)) return { ok: false, reason: 'verdict_not_pass' };
  // The audited bytes and the promoted bytes must be the same bytes.
  if (attestation.manifestHash !== snapshot.manifestHash) return { ok: false, reason: 'manifest_drift' };

  const sharedPaths = snapshot.entries.filter((entry) => entry.claimMode === 'shared');
  if (sharedPaths.length > 0) {
    const claims = input.sharedClaims ?? [];
    for (const entry of sharedPaths) {
      const relevant = claims.filter((claim) => claim.path === entry.path);
      // No recorded claim state is not evidence of absence -- refuse.
      if (relevant.length === 0 || relevant.some((claim) => !claim.attested)) {
        return { ok: false, reason: 'shared_claim_unattested' };
      }
    }
    if (!input.integrationOwnerSignoff) return { ok: false, reason: 'integration_signoff_required' };
  }
  return { ok: true };
}

// ── drift + recovery vocabulary ─────────────────────────────────────────────

export const SUPERVISION_RECOVERY_STATES = [
  'clean',
  'reconciling',
  'needs_reassignment',
  're_audit_required',
  'orphan_reaped',
  'upgrade_fenced',
] as const;
export type SupervisionRecoveryState = typeof SUPERVISION_RECOVERY_STATES[number];

/**
 * Compare live blobs against the attested snapshot.
 *
 * Returns `re_audit_required` on ANY divergence. It deliberately does not offer
 * an "update the snapshot" path: silently re-pointing a checkpoint at newer
 * bytes would break the one guarantee the attestation exists to make.
 */
export function detectSupervisionSnapshotDrift(input: {
  snapshot: SupervisionSnapshotRecord;
  liveBlobs: Readonly<Record<string, string | undefined>>;
}): { drifted: false } | { drifted: true; recoveryState: SupervisionRecoveryState; paths: string[] } {
  const paths: string[] = [];
  for (const entry of input.snapshot.entries) {
    const live = input.liveBlobs[entry.path];
    const expected = entry.operation === 'deleted' ? undefined : entry.afterBlob;
    if (live !== expected) paths.push(entry.path);
  }
  return paths.length === 0
    ? { drifted: false }
    : { drifted: true, recoveryState: 're_audit_required', paths: paths.sort() };
}
