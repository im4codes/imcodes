import type {
  SupervisionCiSmokeStatus,
  SupervisionTaskLifecycleStatus,
} from './supervision-config.js';
import { sha256Text } from './memory-content-hash.js';

/**
 * Pure policy shared by integration preflight and finalization.
 *
 * The daemon owns all filesystem, Git and registry reads.  This module only
 * normalizes one already-authoritative snapshot and explains every rejection
 * in field-level terms.  Keeping the decision pure lets preflight and the
 * transaction's locked re-check use exactly the same predicate.
 */

export const SUPERVISION_INTEGRATION_OPERATIONS = ['preflight', 'finalize'] as const;
export type SupervisionIntegrationOperation = typeof SUPERVISION_INTEGRATION_OPERATIONS[number];

export const SUPERVISION_INTEGRATION_OWNER_PREPARABLE_STATUSES = [
  'delegated', 'implementing', 'ready_for_integration',
] as const satisfies readonly SupervisionTaskLifecycleStatus[];

export const SUPERVISION_INTEGRATION_PUSH_RESULTS = ['pushed', 'already_present'] as const;
export type SupervisionIntegrationPushResult = typeof SUPERVISION_INTEGRATION_PUSH_RESULTS[number];

export const SUPERVISION_INTEGRATION_REFUSAL_CODES = [
  'missing_field',
  'invalid_format',
  'incompatible_field',
  'identity_mismatch',
  'role_mismatch',
  'task_status_mismatch',
  'assignment_status_mismatch',
  'revision_mismatch',
  'attempt_mismatch',
  'verdict_mismatch',
  'bundle_mismatch',
  'remote_drift',
  'stale_preflight',
  'conflicting_replay',
  'ambiguous_authority',
  /**
   * The daemon could not complete its own remote observation (timeout, auth,
   * network, fetch/rev-parse/merge-base failure). This is operational and
   * retryable; it is never evidence that the destination drifted.
   */
  'observation_unavailable',
] as const;
export type SupervisionIntegrationRefusalCode =
  typeof SUPERVISION_INTEGRATION_REFUSAL_CODES[number];

export const SUPERVISION_INTEGRATION_FIELDS = [
  'assignmentId', 'revision', 'auditAttemptId', 'auditRevision', 'verdict',
  'ownedFiles', 'integrationManifest', 'integrationOwner', 'commitSha',
  'pushResult', 'pushRemoteRef', 'stagedPaths', 'conflictedPaths',
  'untrackedOtherOwnerPaths', 'externalRunId', 'externalHeadSha',
  'externalTaskId', 'ciResult', 'taskStatus', 'assignmentStatus',
  'ownerRole', 'ownerIdentity', 'integrationOwnerAssignmentId',
  'bundle', 'remoteRef', 'remoteCommit', 'preflightToken',
] as const;
export type SupervisionIntegrationField = typeof SUPERVISION_INTEGRATION_FIELDS[number];

/** Where a daemon remote observation failed. */
export const SUPERVISION_INTEGRATION_OBSERVATION_STAGES = [
  'remote_config', 'fetch', 'rev_parse', 'merge_base', 'not_observed',
] as const;
export type SupervisionIntegrationObservationStage =
  typeof SUPERVISION_INTEGRATION_OBSERVATION_STAGES[number];

/** Why a daemon remote observation failed (operational, not provenance). */
export const SUPERVISION_INTEGRATION_OBSERVATION_CAUSES = [
  'timeout', 'auth', 'network', 'unconfigured_remote', 'git_error',
] as const;
export type SupervisionIntegrationObservationCause =
  typeof SUPERVISION_INTEGRATION_OBSERVATION_CAUSES[number];

/**
 * One daemon observation of the requested destination ref. `observed` is a
 * proof (the ref's current tip and whether it contains the commit, or that the
 * ref is absent); `unavailable` means no proof either way.
 */
export type SupervisionIntegrationRemoteObservation =
  | {
    status: 'observed';
    ref: string;
    /** Null when the remote proved the requested ref does not exist. */
    commitSha: string | null;
    containsRequestedCommit: boolean;
  }
  | {
    status: 'unavailable';
    stage: SupervisionIntegrationObservationStage;
    cause: SupervisionIntegrationObservationCause;
  };

export interface ParsedSupervisionIntegrationRemoteRef {
  /** Remote name passed to `git fetch` (already allowlist-shaped). */
  remote: string;
  /** Fully qualified branch ref on that remote. */
  branchRef: string;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const REF_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/;

/**
 * Strictly parse a destination ref into a remote name and branch ref.
 *
 * Accepts `refs/heads/<branch>` (remote `origin`) or
 * `refs/remotes/<remote>/<branch>`. The remote name and every branch segment
 * must be allowlist-shaped: no leading `-` or `.`, no whitespace, shell or
 * revision metacharacters, `..`, empty segments, or `.lock` suffixes. Nothing
 * that could be read as a Git option or revision expression ever reaches a
 * subprocess.
 */
export function parseSupervisionIntegrationRemoteRef(
  value: unknown,
): { ok: true; value: ParsedSupervisionIntegrationRemoteRef } | { ok: false; expected: string } {
  const expected = 'refs/heads/<branch> or refs/remotes/<remote>/<branch> with [A-Za-z0-9._+-] segments';
  if (typeof value !== 'string' || value !== value.trim()) return { ok: false, expected };
  let remote = 'origin';
  let branchPath: string;
  if (value.startsWith('refs/heads/')) {
    branchPath = value.slice('refs/heads/'.length);
  } else if (value.startsWith('refs/remotes/')) {
    const rest = value.slice('refs/remotes/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return { ok: false, expected };
    remote = rest.slice(0, slash);
    branchPath = rest.slice(slash + 1);
  } else {
    return { ok: false, expected };
  }
  if (!REMOTE_NAME_RE.test(remote) || remote.endsWith('.lock') || remote.includes('..')) {
    return { ok: false, expected };
  }
  const segments = branchPath.split('/');
  if (segments.some((segment) => (
    !REF_SEGMENT_RE.test(segment) || segment.endsWith('.lock') || segment.includes('..')
  ))) {
    return { ok: false, expected };
  }
  return { ok: true, value: { remote, branchRef: `refs/heads/${branchPath}` } };
}

export interface SupervisionIntegrationRefusal {
  code: SupervisionIntegrationRefusalCode;
  field: SupervisionIntegrationField;
  expected?: string;
  actual?: string;
}

export interface SupervisionIntegrationManifestEntry {
  path: string;
  sha256: string;
}

export interface SupervisionIntegrationEvidenceInput {
  assignmentId?: unknown;
  revision?: unknown;
  auditAttemptId?: unknown;
  auditRevision?: unknown;
  verdict?: unknown;
  ownedFiles?: unknown;
  integrationManifest?: unknown;
  integrationOwner?: unknown;
  commitSha?: unknown;
  pushResult?: unknown;
  pushRemoteRef?: unknown;
  stagedPaths?: unknown;
  conflictedPaths?: unknown;
  untrackedOtherOwnerPaths?: unknown;
  externalRunId?: unknown;
  externalHeadSha?: unknown;
  externalTaskId?: unknown;
  ciResult?: unknown;
}

export interface NormalizedSupervisionIntegrationEvidence {
  assignmentId: string;
  revision: string;
  auditAttemptId: string;
  auditRevision: string;
  verdict: 'PASS';
  ownedFiles: readonly string[];
  integrationManifest: readonly SupervisionIntegrationManifestEntry[];
  integrationOwner: string;
  commitSha?: string;
  pushResult?: SupervisionIntegrationPushResult;
  pushRemoteRef: string;
  stagedPaths: readonly string[];
  conflictedPaths: readonly string[];
  untrackedOtherOwnerPaths: readonly string[];
  externalRunId?: string;
  externalHeadSha?: string;
  externalTaskId?: string;
  ciResult?: SupervisionCiSmokeStatus;
}

export interface SupervisionIntegrationAuthoritySnapshot {
  taskId: string;
  taskStatus: SupervisionTaskLifecycleStatus;
  currentRevision?: string;
  integrationOwnerAssignmentId?: string;
  ownerAssignmentId: string;
  ownerRole: string;
  ownerStatus: SupervisionTaskLifecycleStatus;
  ownerSessionName: string;
  callerSessionName: string;
  ownerAuditRevision?: string;
  ownerAuditAttemptId?: string;
  ownerVerdict?: string;
  ownerCrossVendorAuditPassed?: boolean;
  /** Exact non-terminal integration owners eligible for this revision. */
  eligibleIntegrationOwnerCount: number;
  exactPassReceiptCount: number;
  exactPassAuditorCount: number;
  exactPassAuditorFinalized: boolean;
  exactPassAuditorIndependent: boolean;
  /** Required source implementers (the integration owner itself is excluded). */
  eligibleRequiredLineageCount: number;
  requiredLineageExactPass: boolean;
  bundle?: {
    taskId: string;
    revision: string;
    headSha: string;
    manifestSha256: string;
    /** Every changed path, including deletions. */
    ownedFiles?: readonly string[];
    /** Content-bearing manifest rows; deleted paths intentionally have no hash row. */
    files: readonly SupervisionIntegrationManifestEntry[];
  };
  inspectedHeadSha: string;
  expectedPushRemoteRef: string;
  observedRemoteRef?: string;
  observedRemoteCommitSha?: string;
  /** Daemon-derived exact destination-ref match; never caller supplied. */
  observedPushMatchesRequestedRemote?: boolean;
  /** Daemon-derived proof that the exact bundle commit is reachable from the destination-ref tip. */
  observedPushContainsRequestedCommit?: boolean;
  /**
   * Daemon-derived outcome of the remote observation. `unavailable` is an
   * operational failure and must never be reported as drift.
   */
  remoteObservation?: SupervisionIntegrationRemoteObservation;
  /** The committed finalization row, used to attribute a conflicting replay to its real field. */
  persistedFinalization?: Partial<Pick<NormalizedSupervisionIntegrationEvidence,
    'revision' | 'auditAttemptId' | 'auditRevision' | 'integrationOwner' | 'commitSha' | 'pushResult'
    | 'pushRemoteRef' | 'ciResult' | 'externalRunId' | 'externalHeadSha' | 'externalTaskId'
    | 'ownedFiles' | 'integrationManifest'>>;
  persistedCommitSha?: string;
  persistedPushRemoteRef?: string;
  persistedPreflightToken?: string;
  persistedFinalizationFingerprint?: string;
  generation: number;
  updatedAt: number;
}

export type SupervisionIntegrationPolicyResult =
  | {
    ok: true;
    evidence: NormalizedSupervisionIntegrationEvidence;
    /** Owner lifecycle needs one daemon-owned atomic preparation edge. */
    ownerPreparation: 'none' | 'bind_exact_pass' | 'bind_owner_pointer'
      | 'bind_exact_pass_and_owner_pointer';
    authorityToken: string;
    finalizationFingerprint: string;
    replay: boolean;
    backfill: boolean;
  }
  | { ok: false; refusals: readonly SupervisionIntegrationRefusal[] };

const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OBSERVED_CI_RESULTS = new Set<SupervisionCiSmokeStatus>(['success', 'pending', 'failure']);
const NO_RUN_CI_RESULTS = new Set<SupervisionCiSmokeStatus>(['ci_not_configured', 'ci_unavailable']);

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return undefined;
  }
  return [...new Set(value.map((entry) => entry.trim()))].sort();
}

function manifestValue(value: unknown): readonly SupervisionIntegrationManifestEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: SupervisionIntegrationManifestEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const path = stringValue(Reflect.get(entry, 'path'));
    const sha256 = stringValue(Reflect.get(entry, 'sha256'))?.toLowerCase();
    if (!path || !sha256 || !SHA256_RE.test(sha256)) return undefined;
    normalized.push({ path, sha256 });
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function issue(
  refusals: SupervisionIntegrationRefusal[],
  code: SupervisionIntegrationRefusalCode,
  field: SupervisionIntegrationField,
  expected?: string,
  actual?: unknown,
): void {
  refusals.push({
    code, field,
    ...(expected ? { expected } : {}),
    ...(actual !== undefined ? { actual: String(actual) } : {}),
  });
}

function requiredString(
  input: SupervisionIntegrationEvidenceInput,
  field: keyof SupervisionIntegrationEvidenceInput,
  refusals: SupervisionIntegrationRefusal[],
): string {
  const value = stringValue(input[field]);
  if (!value) issue(refusals, 'missing_field', field as SupervisionIntegrationField, 'non-empty string');
  return value ?? '';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const REPLAY_ATTRIBUTION_FIELDS = [
  ['revision', 'revision_mismatch'],
  ['auditRevision', 'revision_mismatch'],
  ['auditAttemptId', 'attempt_mismatch'],
  ['integrationOwner', 'identity_mismatch'],
  ['commitSha', 'conflicting_replay'],
  ['pushResult', 'conflicting_replay'],
  ['pushRemoteRef', 'conflicting_replay'],
  ['ciResult', 'conflicting_replay'],
  ['externalRunId', 'conflicting_replay'],
  ['externalHeadSha', 'conflicting_replay'],
  ['externalTaskId', 'conflicting_replay'],
  ['ownedFiles', 'conflicting_replay'],
  ['integrationManifest', 'conflicting_replay'],
] as const satisfies readonly (readonly [SupervisionIntegrationField, SupervisionIntegrationRefusalCode])[];

/** Name every field in which a replay differs from the committed finalization row. */
export function attributeSupervisionIntegrationReplayConflict(
  persisted: SupervisionIntegrationAuthoritySnapshot['persistedFinalization'],
  evidence: SupervisionIntegrationAuthoritySnapshot['persistedFinalization'] & object,
): SupervisionIntegrationRefusal[] {
  if (!persisted) return [];
  const refusals: SupervisionIntegrationRefusal[] = [];
  for (const [field, code] of REPLAY_ATTRIBUTION_FIELDS) {
    const expected = persisted[field];
    const actual = evidence[field];
    if (canonical(expected ?? null) !== canonical(actual ?? null)) {
      issue(refusals, code, field,
        typeof expected === 'string' ? expected : canonical(expected ?? 'unset'),
        typeof actual === 'string' ? actual : canonical(actual ?? 'unset'));
    }
  }
  return refusals;
}

/** Validate caller evidence without consulting mutable daemon state. */
export function validateSupervisionIntegrationEvidence(input: {
  operation: SupervisionIntegrationOperation;
  evidence: SupervisionIntegrationEvidenceInput;
}): { ok: true; value: NormalizedSupervisionIntegrationEvidence }
  | { ok: false; refusals: readonly SupervisionIntegrationRefusal[] } {
  const { evidence, operation } = input;
  const refusals: SupervisionIntegrationRefusal[] = [];
  const assignmentId = requiredString(evidence, 'assignmentId', refusals);
  const revision = requiredString(evidence, 'revision', refusals);
  const auditAttemptId = requiredString(evidence, 'auditAttemptId', refusals);
  const auditRevision = requiredString(evidence, 'auditRevision', refusals);
  const integrationOwner = requiredString(evidence, 'integrationOwner', refusals);
  const pushRemoteRef = requiredString(evidence, 'pushRemoteRef', refusals);

  if (evidence.verdict !== 'PASS') issue(refusals, 'verdict_mismatch', 'verdict', 'PASS', evidence.verdict);
  if (pushRemoteRef) {
    const parsedRef = parseSupervisionIntegrationRemoteRef(pushRemoteRef);
    if (!parsedRef.ok) issue(refusals, 'invalid_format', 'pushRemoteRef', parsedRef.expected, pushRemoteRef);
  }

  const ownedFiles = stringArray(evidence.ownedFiles);
  const integrationManifest = manifestValue(evidence.integrationManifest);
  const stagedPaths = stringArray(evidence.stagedPaths);
  const conflictedPaths = stringArray(evidence.conflictedPaths);
  const untrackedOtherOwnerPaths = stringArray(evidence.untrackedOtherOwnerPaths);
  if (!ownedFiles) issue(refusals, 'invalid_format', 'ownedFiles', 'array of non-empty paths');
  if (!integrationManifest) issue(refusals, 'invalid_format', 'integrationManifest', 'array of path/sha256 entries');
  if (!stagedPaths) issue(refusals, 'invalid_format', 'stagedPaths', 'array of non-empty paths');
  if (!conflictedPaths) issue(refusals, 'invalid_format', 'conflictedPaths', 'array of non-empty paths');
  if (!untrackedOtherOwnerPaths) {
    issue(refusals, 'invalid_format', 'untrackedOtherOwnerPaths', 'array of non-empty paths');
  }

  const commitSha = stringValue(evidence.commitSha)?.toLowerCase();
  const pushResult = stringValue(evidence.pushResult) as SupervisionIntegrationPushResult | undefined;
  if (operation === 'finalize') {
    if (!commitSha) issue(refusals, 'missing_field', 'commitSha', '40 lowercase hex characters');
    else if (!COMMIT_RE.test(commitSha)) issue(refusals, 'invalid_format', 'commitSha', '40 lowercase hex characters', commitSha);
    if (!pushResult) issue(refusals, 'missing_field', 'pushResult', SUPERVISION_INTEGRATION_PUSH_RESULTS.join('|'));
    else if (!(SUPERVISION_INTEGRATION_PUSH_RESULTS as readonly string[]).includes(pushResult)) {
      issue(refusals, 'invalid_format', 'pushResult', SUPERVISION_INTEGRATION_PUSH_RESULTS.join('|'), pushResult);
    }
  } else {
    if (commitSha && !COMMIT_RE.test(commitSha)) issue(refusals, 'invalid_format', 'commitSha', '40 lowercase hex characters', commitSha);
    if (pushResult !== undefined) {
      issue(refusals, 'incompatible_field', 'pushResult', 'absent before Git push', pushResult);
    }
  }

  const ciResult = stringValue(evidence.ciResult) as SupervisionCiSmokeStatus | undefined;
  const externalRunId = stringValue(evidence.externalRunId);
  const externalHeadSha = stringValue(evidence.externalHeadSha)?.toLowerCase();
  const externalTaskId = stringValue(evidence.externalTaskId);
  const externalFields = [
    ['externalRunId', externalRunId],
    ['externalHeadSha', externalHeadSha],
    ['externalTaskId', externalTaskId],
  ] as const;
  if (!ciResult) {
    for (const [field, value] of externalFields) {
      if (value) issue(refusals, 'incompatible_field', field, 'absent when ciResult is absent', value);
    }
  } else if (OBSERVED_CI_RESULTS.has(ciResult)) {
    for (const [field, value] of externalFields) {
      if (!value) issue(refusals, 'missing_field', field, `required when ciResult=${ciResult}`);
    }
    if (externalHeadSha && !COMMIT_RE.test(externalHeadSha)) {
      issue(refusals, 'invalid_format', 'externalHeadSha', '40 lowercase hex characters', externalHeadSha);
    }
    if (operation === 'finalize' && commitSha && externalHeadSha && externalHeadSha !== commitSha) {
      issue(refusals, 'revision_mismatch', 'externalHeadSha', commitSha, externalHeadSha);
    }
  } else if (NO_RUN_CI_RESULTS.has(ciResult)) {
    for (const [field, value] of externalFields) {
      if (value) issue(refusals, 'incompatible_field', field, `absent when ciResult=${ciResult}`, value);
    }
  } else {
    issue(refusals, 'invalid_format', 'ciResult', 'known CI smoke status', ciResult);
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    value: {
      assignmentId, revision, auditAttemptId, auditRevision, verdict: 'PASS',
      ownedFiles: ownedFiles!, integrationManifest: integrationManifest!, integrationOwner,
      ...(commitSha ? { commitSha } : {}),
      ...(pushResult ? { pushResult } : {}),
      pushRemoteRef,
      stagedPaths: stagedPaths!, conflictedPaths: conflictedPaths!,
      untrackedOtherOwnerPaths: untrackedOtherOwnerPaths!,
      ...(externalRunId ? { externalRunId } : {}),
      ...(externalHeadSha ? { externalHeadSha } : {}),
      ...(externalTaskId ? { externalTaskId } : {}),
      ...(ciResult ? { ciResult } : {}),
    },
  };
}

/**
 * Resolve an authoritative registry/Git snapshot using the same predicate for
 * preflight and the locked finalize re-check.
 */
export function resolveSupervisionIntegrationPolicy(input: {
  operation: SupervisionIntegrationOperation;
  evidence: SupervisionIntegrationEvidenceInput;
  snapshot: SupervisionIntegrationAuthoritySnapshot;
  expectedPreflightToken?: string;
}): SupervisionIntegrationPolicyResult {
  const validated = validateSupervisionIntegrationEvidence(input);
  if (!validated.ok) return validated;
  const evidence = validated.value;
  const { snapshot } = input;
  const refusals: SupervisionIntegrationRefusal[] = [];
  const finalFingerprint = `sha256:${sha256Text(canonical({
    assignmentId: evidence.assignmentId,
    revision: evidence.revision,
    auditAttemptId: evidence.auditAttemptId,
    auditRevision: evidence.auditRevision,
    verdict: evidence.verdict,
    ownedFiles: evidence.ownedFiles,
    integrationManifest: evidence.integrationManifest,
    integrationOwner: evidence.integrationOwner,
    commitSha: evidence.commitSha,
    pushResult: evidence.pushResult,
    pushRemoteRef: evidence.pushRemoteRef,
    externalRunId: evidence.externalRunId,
    externalHeadSha: evidence.externalHeadSha,
    externalTaskId: evidence.externalTaskId,
    ciResult: evidence.ciResult,
  }))}`;

  // A committed ledger row is the authority for an exact retry.  Do not make
  // a harmless client retry re-satisfy pre-finalization lifecycle or remote
  // observations after the task has already become terminal.  Identity and
  // assignment provenance remain mandatory, and a different payload is a
  // field-specific conflicting replay rather than a second finalization.
  if (snapshot.persistedFinalizationFingerprint) {
    if (input.expectedPreflightToken
      && snapshot.persistedPreflightToken !== input.expectedPreflightToken) {
      return {
        ok: false,
        refusals: [{
          code: 'conflicting_replay', field: 'preflightToken',
          expected: snapshot.persistedPreflightToken ?? 'unset', actual: input.expectedPreflightToken,
        }],
      };
    }
    if (snapshot.persistedFinalizationFingerprint !== finalFingerprint) {
      const differing = attributeSupervisionIntegrationReplayConflict(snapshot.persistedFinalization, evidence);
      return {
        ok: false,
        refusals: differing.length > 0 ? differing : [{
          code: 'conflicting_replay', field: 'preflightToken',
          expected: snapshot.persistedFinalizationFingerprint, actual: finalFingerprint,
        }],
      };
    }
    if (snapshot.ownerAssignmentId !== evidence.assignmentId) {
      issue(refusals, 'identity_mismatch', 'assignmentId', snapshot.ownerAssignmentId, evidence.assignmentId);
    }
    if (snapshot.ownerRole !== 'integration_owner') {
      issue(refusals, 'role_mismatch', 'ownerRole', 'integration_owner', snapshot.ownerRole);
    }
    if (snapshot.ownerSessionName !== snapshot.callerSessionName
      || evidence.integrationOwner !== snapshot.ownerSessionName) {
      issue(refusals, 'identity_mismatch', 'ownerIdentity', snapshot.ownerSessionName,
        `${snapshot.callerSessionName}/${evidence.integrationOwner}`);
    }
    if (refusals.length > 0) return { ok: false, refusals };
    return {
      ok: true, evidence, ownerPreparation: 'none',
      authorityToken: `sha256:${sha256Text(canonical({
        taskId: snapshot.taskId,
        ownerAssignmentId: snapshot.ownerAssignmentId,
        persistedFinalizationFingerprint: snapshot.persistedFinalizationFingerprint,
      }))}`,
      finalizationFingerprint: finalFingerprint,
      replay: true,
      backfill: evidence.pushResult === 'already_present',
    };
  }

  if (snapshot.ownerAssignmentId !== evidence.assignmentId) {
    issue(refusals, 'identity_mismatch', 'assignmentId', snapshot.ownerAssignmentId, evidence.assignmentId);
  }
  if (snapshot.ownerRole !== 'integration_owner') {
    issue(refusals, 'role_mismatch', 'ownerRole', 'integration_owner', snapshot.ownerRole);
  }
  if (snapshot.ownerSessionName !== snapshot.callerSessionName
    || evidence.integrationOwner !== snapshot.ownerSessionName) {
    issue(refusals, 'identity_mismatch', 'ownerIdentity', snapshot.ownerSessionName,
      `${snapshot.callerSessionName}/${evidence.integrationOwner}`);
  }
  if (snapshot.taskStatus !== 'ready_for_integration') {
    issue(refusals, 'task_status_mismatch', 'taskStatus', 'ready_for_integration', snapshot.taskStatus);
  }
  if (!(SUPERVISION_INTEGRATION_OWNER_PREPARABLE_STATUSES as readonly string[]).includes(snapshot.ownerStatus)) {
    issue(refusals, 'assignment_status_mismatch', 'assignmentStatus',
      SUPERVISION_INTEGRATION_OWNER_PREPARABLE_STATUSES.join('|'), snapshot.ownerStatus);
  }
  if (snapshot.currentRevision !== evidence.revision || evidence.auditRevision !== evidence.revision
    || snapshot.ownerAuditRevision !== evidence.revision) {
    issue(refusals, 'revision_mismatch', 'revision', snapshot.currentRevision ?? 'unset', evidence.revision);
  }
  if (snapshot.ownerAuditAttemptId !== evidence.auditAttemptId) {
    issue(refusals, 'attempt_mismatch', 'auditAttemptId', snapshot.ownerAuditAttemptId ?? 'unset', evidence.auditAttemptId);
  }
  const ownerHasBoundPass = snapshot.ownerVerdict?.trim().toUpperCase() === 'PASS'
    && snapshot.ownerCrossVendorAuditPassed === true;
  const passCanBeBound = snapshot.exactPassReceiptCount === 1
    && snapshot.exactPassAuditorCount === 1
    && snapshot.exactPassAuditorFinalized
    && snapshot.exactPassAuditorIndependent
    && snapshot.eligibleRequiredLineageCount > 0
    && snapshot.requiredLineageExactPass;
  if (!passCanBeBound) {
    issue(refusals, 'verdict_mismatch', 'verdict', 'one exact PASS receipt and exact required lineage',
      `${snapshot.exactPassReceiptCount}/${snapshot.requiredLineageExactPass}`);
  }
  if (snapshot.eligibleIntegrationOwnerCount !== 1) {
    issue(refusals, 'ambiguous_authority', 'integrationOwnerAssignmentId', 'one eligible integration owner',
      snapshot.eligibleIntegrationOwnerCount);
  }
  if (snapshot.integrationOwnerAssignmentId
    && snapshot.integrationOwnerAssignmentId !== snapshot.ownerAssignmentId) {
    issue(refusals, 'ambiguous_authority', 'integrationOwnerAssignmentId', snapshot.ownerAssignmentId,
      snapshot.integrationOwnerAssignmentId);
  }
  if (!snapshot.bundle || snapshot.bundle.taskId !== snapshot.taskId
    || snapshot.bundle.revision !== evidence.revision
    || JSON.stringify(snapshot.bundle.files) !== JSON.stringify(evidence.integrationManifest)) {
    issue(refusals, 'bundle_mismatch', 'bundle', 'exact task/revision/manifest');
  }
  const bundlePaths = [...(snapshot.bundle?.ownedFiles
    ?? snapshot.bundle?.files.map((entry) => entry.path)
    ?? [])].sort();
  if (bundlePaths && JSON.stringify(bundlePaths) !== JSON.stringify(evidence.ownedFiles)) {
    issue(refusals, 'bundle_mismatch', 'ownedFiles', 'exact bundle path set');
  }
  if (snapshot.expectedPushRemoteRef !== evidence.pushRemoteRef) {
    issue(refusals, 'remote_drift', 'remoteRef', snapshot.expectedPushRemoteRef, evidence.pushRemoteRef);
  }
  if (snapshot.inspectedHeadSha !== snapshot.bundle?.headSha) {
    issue(refusals, 'bundle_mismatch', 'bundle', snapshot.bundle?.headSha ?? 'missing', snapshot.inspectedHeadSha);
  }
  if (input.operation === 'preflight' && evidence.stagedPaths.length > 0) {
    issue(refusals, 'incompatible_field', 'stagedPaths', 'empty before Git side effects',
      evidence.stagedPaths.join(','));
  }
  if (evidence.conflictedPaths.length > 0) {
    issue(refusals, 'incompatible_field', 'conflictedPaths', 'empty', evidence.conflictedPaths.join(','));
  }

  // A prior crash may have persisted only the committed/pushed projection and
  // not the terminal finalization row.  Those durable fields are authority, not
  // hints: an exact already-present retry may complete the missing row, while a
  // caller that supplies different Git provenance must fail closed instead of
  // laundering the conflict through a currently matching remote observation.
  if (snapshot.persistedCommitSha && evidence.commitSha
    && snapshot.persistedCommitSha.toLowerCase() !== evidence.commitSha) {
    issue(refusals, 'conflicting_replay', 'commitSha', snapshot.persistedCommitSha, evidence.commitSha);
  }
  if (snapshot.persistedPushRemoteRef
    && snapshot.persistedPushRemoteRef !== evidence.pushRemoteRef) {
    issue(refusals, 'conflicting_replay', 'pushRemoteRef',
      snapshot.persistedPushRemoteRef, evidence.pushRemoteRef);
  }

  const backfill = input.operation === 'finalize' && evidence.pushResult === 'already_present';
  if (input.operation === 'finalize' && (
    snapshot.observedPushMatchesRequestedRemote !== true
    && snapshot.observedPushContainsRequestedCommit !== true
  )) {
    const expectedRemote = `${evidence.pushRemoteRef}@${evidence.commitSha}`;
    const observation = snapshot.remoteObservation;
    if (observation?.status === 'unavailable') {
      // No proof either way: an operational failure, retryable, never drift.
      issue(refusals, 'observation_unavailable', 'remoteCommit', expectedRemote,
        `${observation.stage}:${observation.cause}`);
    } else if (observation?.status === 'observed') {
      issue(refusals, 'remote_drift', 'remoteCommit', expectedRemote,
        `${observation.ref}@${observation.commitSha ?? 'absent'}`);
    } else if (snapshot.observedRemoteCommitSha) {
      issue(refusals, 'remote_drift', 'remoteCommit', expectedRemote,
        `${snapshot.observedRemoteRef ?? evidence.pushRemoteRef}@${snapshot.observedRemoteCommitSha}`);
    } else {
      // Nothing was observed at all. Do not synthesize an unset@unset drift.
      issue(refusals, 'observation_unavailable', 'remoteCommit', expectedRemote, 'not_observed:git_error');
    }
  }

  const fingerprint = `sha256:${sha256Text(canonical({
    taskId: snapshot.taskId,
    taskStatus: snapshot.taskStatus,
    currentRevision: snapshot.currentRevision,
    ownerAssignmentId: snapshot.ownerAssignmentId,
    ownerRole: snapshot.ownerRole,
    ownerSessionName: snapshot.ownerSessionName,
    ownerAuditRevision: snapshot.ownerAuditRevision,
    ownerAuditAttemptId: snapshot.ownerAuditAttemptId,
    ownerPassAuthority: passCanBeBound,
    exactPassReceiptCount: snapshot.exactPassReceiptCount,
    exactPassAuditorCount: snapshot.exactPassAuditorCount,
    exactPassAuditorFinalized: snapshot.exactPassAuditorFinalized,
    exactPassAuditorIndependent: snapshot.exactPassAuditorIndependent,
    eligibleRequiredLineageCount: snapshot.eligibleRequiredLineageCount,
    requiredLineageExactPass: snapshot.requiredLineageExactPass,
    bundle: snapshot.bundle,
    inspectedHeadSha: snapshot.inspectedHeadSha,
    expectedPushRemoteRef: snapshot.expectedPushRemoteRef,
    persistedCommitSha: snapshot.persistedCommitSha,
    persistedPushRemoteRef: snapshot.persistedPushRemoteRef,
    evidence: {
      assignmentId: evidence.assignmentId,
      revision: evidence.revision,
      auditAttemptId: evidence.auditAttemptId,
      auditRevision: evidence.auditRevision,
      integrationOwner: evidence.integrationOwner,
      ownedFiles: evidence.ownedFiles,
      integrationManifest: evidence.integrationManifest,
      pushRemoteRef: evidence.pushRemoteRef,
      // CI run metadata is deliberately NOT part of the pre-Git authority
      // token: a real CI run only exists after commit/push, so binding it here
      // would make every normal preflight-before-commit token stale. CI stays
      // fail-closed through exact field validation (IDs required for
      // pending/success/failure, externalHeadSha === commitSha) and through the
      // finalization fingerprint, which includes it for exact replay.
    },
  }))}`;
  if (input.expectedPreflightToken && input.expectedPreflightToken !== fingerprint) {
    issue(refusals, 'stale_preflight', 'preflightToken', input.expectedPreflightToken, fingerprint);
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return {
    ok: true,
    evidence,
    ownerPreparation: snapshot.integrationOwnerAssignmentId
      ? (ownerHasBoundPass && snapshot.ownerStatus === 'ready_for_integration' ? 'none' : 'bind_exact_pass')
      : (ownerHasBoundPass && snapshot.ownerStatus === 'ready_for_integration'
        ? 'bind_owner_pointer'
        : 'bind_exact_pass_and_owner_pointer'),
    authorityToken: fingerprint,
    finalizationFingerprint: finalFingerprint,
    replay: false,
    backfill,
  };
}
