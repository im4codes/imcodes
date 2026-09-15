import { createHash } from 'node:crypto';
import {
  PEER_AUDIT_CANDIDATE_REASONS,
  PEER_AUDIT_PREFLIGHT_ERRORS,
  PEER_AUDIT_UNKNOWN_IDENTITY,
  resolvePeerAuditNormalizedModelId as resolveSharedPeerAuditNormalizedModelId,
  resolvePeerAuditProviderFamily as resolveSharedPeerAuditProviderFamily,
  type PeerAuditCandidate,
  type PeerAuditCandidateList,
  type PeerAuditCandidateReason,
  type PeerAuditRuntimeDisposition,
} from '../../shared/peer-audit.js';
import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { readSupervisionSnapshotFromTransportConfig } from '../../shared/supervision-config.js';
import { resolveExactDelegationTarget } from './session-dispatch.js';
import type { SessionRecord } from '../store/session-store.js';
import { CODEBUDDY_PROVIDER_IDS } from '../../shared/codebuddy.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';
import { DELEGATION_AVAILABILITY, type DelegationTargetAvailability } from '../../shared/delegation-availability.js';
import type { SupervisionAuditDegradedReason } from '../../shared/supervision-execution-pool.js';

const UNKNOWN_DIMENSION = PEER_AUDIT_UNKNOWN_IDENTITY;

/** CAS revision covering only the remembered auditor fields. */
export function resolvePeerAuditTargetConfigRevision(record: SessionRecord): string {
  const snapshot = readSupervisionSnapshotFromTransportConfig(record.transportConfig);
  return createHash('sha256').update(JSON.stringify({
    name: snapshot.auditTargetSessionName ?? null,
    fingerprint: snapshot.auditTargetFingerprint ?? null,
    promptVersion: snapshot.peerAuditPromptVersion ?? null,
  })).digest('base64url');
}

export interface PeerAuditCandidateMetadataResolver {
  normalizedModelId(session: SessionRecord): string;
  providerFamily(session: SessionRecord): string;
}

export interface ResolvePeerAuditCandidateInput {
  auditedSessionName: string;
  targetSessionName: string;
  allSessions: readonly SessionRecord[];
}

export type PeerAuditCandidateResolution =
  | { ok: true; owningMain: SessionRecord; audited: SessionRecord; candidate: PeerAuditCandidate }
  | { ok: false; error: 'audited_session_unavailable' | 'audited_session_not_ordinary' };

export type PeerAuditCandidateListResolution =
  | { ok: true; list: PeerAuditCandidateList }
  | { ok: false; error: 'audited_session_unavailable' | 'audited_session_not_ordinary' | 'audited_identity_unavailable' };

export type PeerAuditCandidateSelectionResolution =
  | { ok: true; list: PeerAuditCandidateList; candidate: PeerAuditCandidate }
  | { ok: false; error: typeof PEER_AUDIT_PREFLIGHT_ERRORS.CANDIDATE_REFRESH_REQUIRED | typeof PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE; list?: PeerAuditCandidateList; reason?: PeerAuditCandidateReason };

/**
 * Exact, non-fuzzy model normalization. Authoritative active model wins, then
 * requested/configured display fallbacks. A shared alias resolver can be
 * injected through `PeerAuditCandidateMetadataResolver` as aliases evolve.
 */
export function resolvePeerAuditNormalizedModelId(session: SessionRecord): string {
  const configuredModel = session.modelDisplay ?? session.qwenModel;
  const knownModelIds = [session.requestedModel, configuredModel]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return resolveSharedPeerAuditNormalizedModelId({
    activeModel: session.activeModel,
    requestedModel: session.requestedModel,
    configuredModel,
  }, { knownModelIds });
}

/** Resolve only the explicit requested/configured identity, deliberately
 * excluding live active-model metadata. This lets callers distinguish a
 * harmless metadata enrichment (for example `opus` -> a live
 * `claude-opus-4-8`) from an actual user-selected model change. */
export function resolvePeerAuditConfiguredModelId(session: SessionRecord): string {
  const configuredModel = session.modelDisplay ?? session.qwenModel;
  const knownModelIds = [session.requestedModel, configuredModel]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return resolveSharedPeerAuditNormalizedModelId({
    requestedModel: session.requestedModel,
    configuredModel,
  }, { knownModelIds });
}

export function resolvePeerAuditProviderFamily(session: SessionRecord): string {
  return resolveSharedPeerAuditProviderFamily({ providerId: session.providerId, agentType: session.agentType });
}

const DEFAULT_METADATA_RESOLVER: PeerAuditCandidateMetadataResolver = {
  normalizedModelId: resolvePeerAuditNormalizedModelId,
  providerFamily: resolvePeerAuditProviderFamily,
};

function resolveOwningMain(audited: SessionRecord, allSessions: readonly SessionRecord[]): SessionRecord | undefined {
  if (audited.parentSession) {
    const parent = allSessions.find((session) => session.name === audited.parentSession);
    return parent && parent.role === 'brain' && !parent.parentSession ? parent : undefined;
  }
  return audited.role === 'brain' ? audited : undefined;
}

function dispositionFor(session: SessionRecord): PeerAuditRuntimeDisposition {
  const runtimeType = session.runtimeType ?? getSessionRuntimeType(session.agentType);
  if (runtimeType === 'process') return 'sent_unrevocable';
  return session.state === 'idle' ? 'sent' : 'queued';
}

function peerAuditTypeLabel(agentType: string): string {
  switch (agentType) {
    case 'claude-code':
    case 'claude-code-sdk':
      return 'CC';
    case 'codex':
    case 'codex-sdk':
      return 'CX';
    case 'cursor-headless':
      return 'Cu';
    case 'opencode-sdk':
    case 'opencode':
      return 'Op';
    case 'gemini':
    case 'gemini-sdk':
      return 'Gm';
    case 'grok-sdk':
      return 'Gx';
    case 'qwen':
      return 'Qw';
    case 'kimi-sdk':
      return 'Km';
    case HERMES_AGENT_PROVIDER_ID:
      return 'He';
    case 'copilot-sdk':
      return 'Cp';
    case 'openclaw':
      return 'OC';
    case 'deepseek-harness':
      return 'Ds';
    case 'pi':
      return 'Pi';
    case CODEBUDDY_PROVIDER_IDS.CHINA:
    case CODEBUDDY_PROVIDER_IDS.INTERNATIONAL:
      return 'CB';
    default:
      return 'AI';
  }
}

function candidateShape(
  target: SessionRecord,
  eligible: boolean,
  reason: PeerAuditCandidateReason,
  metadata: PeerAuditCandidateMetadataResolver,
): PeerAuditCandidate {
  return {
    name: target.name,
    // `name` is protocol-only (`deck_*`) and must never become user-visible.
    // An absent user label falls back to a type badge, not the internal id.
    label: target.label?.trim() || peerAuditTypeLabel(target.agentType),
    sessionInstanceId: target.sessionInstanceId?.trim() || UNKNOWN_DIMENSION,
    runtimeEpoch: target.runtimeEpoch?.trim() || UNKNOWN_DIMENSION,
    normalizedModelId: metadata.normalizedModelId(target),
    providerFamily: metadata.providerFamily(target),
    liveState: target.state,
    dispositionCapability: dispositionFor(target),
    eligible,
    reason,
  };
}

function ineligible(
  target: SessionRecord,
  reason: PeerAuditCandidateReason,
  metadata: PeerAuditCandidateMetadataResolver,
): PeerAuditCandidate {
  return candidateShape(target, false, reason, metadata);
}

export function resolvePeerAuditCandidate(
  input: ResolvePeerAuditCandidateInput,
  metadata: PeerAuditCandidateMetadataResolver = DEFAULT_METADATA_RESOLVER,
): PeerAuditCandidateResolution {
  const audited = input.allSessions.find((session) => session.name === input.auditedSessionName);
  if (!audited) return { ok: false, error: 'audited_session_unavailable' };
  const owningMain = resolveOwningMain(audited, input.allSessions);
  if (!owningMain || audited.executionCloneMetadata) return { ok: false, error: 'audited_session_not_ordinary' };
  const target = input.allSessions.find((session) => session.name === input.targetSessionName);
  if (!target) return { ok: false, error: 'audited_session_unavailable' };

  const exact = resolveExactDelegationTarget({
    caller: {
      userId: 'peer-audit-daemon',
      sessionName: audited.name,
      projectName: audited.projectName,
      projectRoot: audited.projectDir,
    },
    targetSession: target.name,
    allSessions: [...input.allSessions],
  });
  if (!exact.ok) {
    if (exact.error === 'delegation_self_target') {
      return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.SELF, metadata) };
    }
    if (target.executionCloneMetadata) {
      return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.EXECUTION_CLONE, metadata) };
    }
    if (exact.error === 'delegation_target_not_reply_capable') {
      return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.NOT_REPLY_CAPABLE, metadata) };
    }
    if (target.state === 'stopped' || target.state === 'error') {
      return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.BUSY_STATE, metadata) };
    }
    return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.CROSS_PROJECT, metadata) };
  }

  if (target.parentSession !== owningMain.name || target.role === 'brain') {
    return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.NOT_DIRECT_CHILD, metadata) };
  }
  if (!target.sessionInstanceId || !target.runtimeEpoch) {
    return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.UNKNOWN_IDENTITY, metadata) };
  }
  const runtimeType = target.runtimeType ?? getSessionRuntimeType(target.agentType);
  if (runtimeType === 'process' && target.state !== 'idle') {
    return { ok: true, owningMain, audited, candidate: ineligible(target, PEER_AUDIT_CANDIDATE_REASONS.BUSY_STATE, metadata) };
  }
  return { ok: true, owningMain, audited, candidate: candidateShape(target, true, PEER_AUDIT_CANDIDATE_REASONS.ELIGIBLE, metadata) };
}

function revisionFor(
  audited: SessionRecord,
  owningMain: SessionRecord,
  candidates: readonly PeerAuditCandidate[],
  metadata: PeerAuditCandidateMetadataResolver,
): string {
  const authority = {
    audited: {
      name: audited.name,
      sessionInstanceId: audited.sessionInstanceId,
      runtimeEpoch: audited.runtimeEpoch,
      state: audited.state,
      model: metadata.normalizedModelId(audited),
      provider: metadata.providerFamily(audited),
      parentSession: audited.parentSession ?? null,
    },
    owningMain: {
      name: owningMain.name,
      sessionInstanceId: owningMain.sessionInstanceId,
      projectName: owningMain.projectName,
    },
    candidates: [...candidates]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((candidate) => ({
        name: candidate.name,
        sessionInstanceId: candidate.sessionInstanceId,
        runtimeEpoch: candidate.runtimeEpoch,
        state: candidate.liveState,
        model: candidate.normalizedModelId,
        provider: candidate.providerFamily,
        disposition: candidate.dispositionCapability,
        eligible: candidate.eligible,
        reason: candidate.reason,
      })),
  };
  return createHash('sha256').update(JSON.stringify(authority)).digest('base64url');
}

/**
 * Ordering is NEUTRAL on purpose.
 *
 * This used to rank cross-provider candidates first, then cross-model. That is
 * the daemon choosing a vendor, and vendor choice belongs to the Supervisor
 * Brain alone. Enumeration may only state who is ELIGIBLE; a ranked list is a
 * recommendation, and a recommendation is a choice. Eligible-before-ineligible
 * plus the label/name tiebreak keeps the order deterministic without expressing
 * a preference the Brain never stated.
 */
function candidateRank(candidate: PeerAuditCandidate): number {
  return candidate.eligible ? 0 : 1;
}

export function resolvePeerAuditCandidateList(
  input: { auditedSessionName: string; allSessions: readonly SessionRecord[] },
  metadata: PeerAuditCandidateMetadataResolver = DEFAULT_METADATA_RESOLVER,
): PeerAuditCandidateListResolution {
  const audited = input.allSessions.find((session) => session.name === input.auditedSessionName);
  if (!audited) return { ok: false, error: 'audited_session_unavailable' };
  const owningMain = resolveOwningMain(audited, input.allSessions);
  if (!owningMain || audited.executionCloneMetadata) return { ok: false, error: 'audited_session_not_ordinary' };
  if (!audited.sessionInstanceId) return { ok: false, error: 'audited_identity_unavailable' };

  const candidates = input.allSessions
    .filter((session) => session.name !== audited.name
      && session.parentSession === owningMain.name
      && session.role !== 'brain'
      && !session.executionCloneMetadata)
    .map((session) => resolvePeerAuditCandidate({
      auditedSessionName: audited.name,
      targetSessionName: session.name,
      allSessions: input.allSessions,
    }, metadata))
    .filter((result): result is Extract<PeerAuditCandidateResolution, { ok: true }> => result.ok)
    .map((result) => result.candidate);
  candidates.sort((a, b) => candidateRank(a) - candidateRank(b)
    || a.label.localeCompare(b.label)
    || a.name.localeCompare(b.name));

  return {
    ok: true,
    list: {
      revision: revisionFor(audited, owningMain, candidates, metadata),
      targetConfigRevision: resolvePeerAuditTargetConfigRevision(audited),
      auditedSessionName: audited.name,
      auditedSessionInstanceId: audited.sessionInstanceId,
      candidates,
    },
  };
}

/** Atomic Quick-start preflight: recompute authority before comparing revision. */
export function revalidatePeerAuditCandidateSelection(input: {
  auditedSessionName: string;
  targetSessionName: string;
  targetSessionInstanceId: string;
  targetRuntimeEpoch: string;
  expectedRevision: string;
  allSessions: readonly SessionRecord[];
}, metadata: PeerAuditCandidateMetadataResolver = DEFAULT_METADATA_RESOLVER): PeerAuditCandidateSelectionResolution {
  const resolvedList = resolvePeerAuditCandidateList(input, metadata);
  if (!resolvedList.ok) return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE };
  if (resolvedList.list.revision !== input.expectedRevision) {
    return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.CANDIDATE_REFRESH_REQUIRED, list: resolvedList.list };
  }
  const candidate = resolvedList.list.candidates.find((item) => item.name === input.targetSessionName);
  if (!candidate || !candidate.eligible
    || candidate.sessionInstanceId !== input.targetSessionInstanceId
    || candidate.runtimeEpoch !== input.targetRuntimeEpoch) {
    return {
      ok: false,
      error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE,
      list: resolvedList.list,
      ...(candidate ? { reason: candidate.reason } : {}),
    };
  }
  return { ok: true, list: resolvedList.list, candidate };
}

/**
 * Why a Brain-supplied audit route was refused.
 *
 * Neutral vocabulary on purpose: this is the ONE authoritative eligibility
 * decision, and each boundary maps it to its own surface (MCP error reason at
 * the send tool, invalid_configuration + terminal needs-input in the
 * automation). Duplicating "approximate rules" at a second boundary is how a
 * target that one path refuses gets silently accepted by the other.
 */
export type BrainAuditRouteRefusal =
  | 'missing_audited_session'
  | 'self_audit'
  | 'audited_session_unresolvable'
  | 'target_not_candidate'
  | 'target_ineligible';

export type BrainAuditRouteResult =
  | { ok: true }
  | { ok: false; refusal: BrainAuditRouteRefusal; detail: string };

export type BrainAuditRoutePolicyResult =
  | { ok: true; auditRoutingReason: 'cross_vendor_preferred' }
  | { ok: true; auditRoutingReason: 'same_family_degraded'; degradedReason: SupervisionAuditDegradedReason }
  | { ok: true; auditRoutingReason: 'brain_selected_same_family' }
  | { ok: false; detail: string; degradedReason: SupervisionAuditDegradedReason };

function unavailableCrossVendorReason(
  candidates: readonly { name: string }[],
  availability: ReadonlyMap<string, DelegationTargetAvailability>,
): SupervisionAuditDegradedReason {
  if (candidates.length === 0) return 'no_cross_vendor_configured';
  const states = candidates.map((candidate) => availability.get(candidate.name)?.availability ?? DELEGATION_AVAILABILITY.UNKNOWN);
  if (states.every((state) => state === DELEGATION_AVAILABILITY.LIMITED)) return 'cross_vendor_limited';
  if (states.every((state) => state === DELEGATION_AVAILABILITY.OFFLINE)) return 'cross_vendor_offline';
  return 'cross_vendor_unavailable';
}

/**
 * Automatic audit delivery has a narrower runtime boundary than manual peer
 * audit selection, but it does not depend on the legacy `replyCapable` product
 * flag. Every live, started transport adapter has the daemon-authenticated
 * peer_audit_reply ingress. Process/CLI runtimes remain manual-only.
 */
function automaticAuditTransportCandidates(
  audited: SessionRecord,
  allSessions: readonly SessionRecord[],
): SessionRecord[] {
  const owningMain = resolveOwningMain(audited, allSessions);
  if (!owningMain || audited.executionCloneMetadata) return [];
  return allSessions.filter((target) => (
    target.name !== audited.name
    && target.parentSession === owningMain.name
    && target.role !== 'brain'
    && !target.executionCloneMetadata
    && Boolean(target.sessionInstanceId?.trim())
    && Boolean(target.runtimeEpoch?.trim())
    && (target.runtimeType ?? getSessionRuntimeType(target.agentType)) === 'transport'
    && target.state !== 'stopped'
    && target.state !== 'error'
  ));
}

/** Automatic-only authority check; manual exact routes retain their legacy
 * reply-capability/process behavior through {@link validateBrainAuditRoute}. */
export function validateAutomaticAuditTransportRoute(input: {
  auditedSessionName: string | undefined | null;
  targetName: string;
  allSessions: readonly SessionRecord[];
}): BrainAuditRouteResult {
  const auditedSessionName = typeof input.auditedSessionName === 'string'
    ? input.auditedSessionName.trim()
    : '';
  if (!auditedSessionName) {
    return {
      ok: false, refusal: 'missing_audited_session',
      detail: 'audit.auditedSessionName is required and is never inferred',
    };
  }
  if (auditedSessionName === input.targetName) {
    return { ok: false, refusal: 'self_audit', detail: 'a session cannot audit itself' };
  }
  const audited = input.allSessions.find((session) => session.name === auditedSessionName);
  if (!audited || !resolveOwningMain(audited, input.allSessions) || audited.executionCloneMetadata) {
    return {
      ok: false, refusal: 'audited_session_unresolvable',
      detail: 'audit route rejected: audited_session_unavailable',
    };
  }
  const target = input.allSessions.find((session) => session.name === input.targetName);
  if (!target) {
    return {
      ok: false, refusal: 'target_not_candidate',
      detail: 'audit target is not a peer-audit candidate for the audited session',
    };
  }
  if (!automaticAuditTransportCandidates(audited, input.allSessions).some((candidate) => (
    candidate.name === target.name
    && candidate.sessionInstanceId === target.sessionInstanceId
    && candidate.runtimeEpoch === target.runtimeEpoch
  ))) {
    return {
      ok: false, refusal: 'target_ineligible',
      detail: 'automatic audit target must be a live started authorized transport with exact identity',
    };
  }
  return { ok: true };
}

/**
 * Classify the exact Brain-selected route without selecting a target.
 * Cross-vendor is preferred; same-family is accepted only when every eligible
 * cross-vendor session is unavailable. The decision is returned for durable
 * task/receipt projection and is never rendered into ordinary chat.
 */
export function evaluateBrainAuditRoutePolicy(input: {
  auditedSessionName: string;
  targetName: string;
  allSessions: readonly SessionRecord[];
  availability: ReadonlyMap<string, DelegationTargetAvailability>;
  strictCrossVendor?: boolean;
  automaticSupervision?: boolean;
}): BrainAuditRoutePolicyResult {
  const audited = input.allSessions.find((session) => session.name === input.auditedSessionName);
  const target = input.allSessions.find((session) => session.name === input.targetName);
  if (!audited || !target || audited.name === target.name) {
    return { ok: false, detail: 'no independent auditor session is available', degradedReason: 'no_independent_session' };
  }
  const auditedFamily = resolvePeerAuditProviderFamily(audited);
  if (resolvePeerAuditProviderFamily(target) !== auditedFamily) {
    return { ok: true, auditRoutingReason: 'cross_vendor_preferred' };
  }

  const listed = input.automaticSupervision
    ? undefined
    : resolvePeerAuditCandidateList({ auditedSessionName: audited.name, allSessions: input.allSessions });
  if (listed && !listed.ok) {
    return { ok: false, detail: 'audit candidate authority is unavailable', degradedReason: 'cross_vendor_unavailable' };
  }
  const crossVendor = input.automaticSupervision
    ? automaticAuditTransportCandidates(audited, input.allSessions)
      .filter((candidate) => resolvePeerAuditProviderFamily(candidate) !== auditedFamily)
    : listed!.list.candidates.filter((candidate) => (
      candidate.eligible && candidate.providerFamily !== auditedFamily
    ));
  const usableCrossVendor = crossVendor.filter((candidate) => {
    const state = input.availability.get(candidate.name)?.availability;
    return state === DELEGATION_AVAILABILITY.READY
      || (!input.automaticSupervision && state === DELEGATION_AVAILABILITY.BUSY);
  });
  const degradedReason = unavailableCrossVendorReason(crossVendor, input.availability);
  if (input.strictCrossVendor) {
    return { ok: false, detail: 'the user required a cross-vendor auditor', degradedReason };
  }
  if (usableCrossVendor.length > 0) {
    // The daemon may never substitute the target the Brain named. An explicit
    // same-family route remains deliverable for manual/Quick audit, but it is
    // projected distinctly so it cannot masquerade as an availability-driven
    // degradation. Pool auto-routing never takes this branch: it selects the
    // usable cross-vendor target before calling the exact-route validator.
    return { ok: true, auditRoutingReason: 'brain_selected_same_family' };
  }
  return { ok: true, auditRoutingReason: 'same_family_degraded', degradedReason };
}

/**
 * Validate the EXACT audit route the Supervisor Brain supplied.
 *
 * The daemon does not choose auditors, vendors or models. Its entire role here
 * is to confirm that the route the Brain STATED is one the audited session may
 * actually use, and to refuse when it is not.
 *
 * There is deliberately no fallback, no ranking, and no first-eligible pick: a
 * missing or ineligible route is an error to REPORT, never a gap for the daemon
 * to fill. The target is matched BY NAME against the candidate set -- never by
 * position, provider family, or model -- so no substitution can hide here.
 */
export function validateBrainAuditRoute(input: {
  auditedSessionName: string | undefined | null;
  targetName: string;
  allSessions: readonly SessionRecord[];
}): BrainAuditRouteResult {
  // Defensive read: `audit` crosses a process boundary from MCP callers, and
  // test sources are not typechecked, so an absent field must reach the
  // fail-closed refusal rather than throw.
  const auditedSessionName = typeof input.auditedSessionName === 'string'
    ? input.auditedSessionName.trim()
    : '';
  if (!auditedSessionName) {
    return {
      ok: false, refusal: 'missing_audited_session',
      detail: 'audit.auditedSessionName is required and is never inferred',
    };
  }
  // A session reviewing its own work is not an audit, whoever dispatched it.
  if (auditedSessionName === input.targetName) {
    return { ok: false, refusal: 'self_audit', detail: 'a session cannot audit itself' };
  }
  const resolved = resolvePeerAuditCandidateList({ auditedSessionName, allSessions: input.allSessions });
  if (!resolved.ok) {
    return {
      ok: false, refusal: 'audited_session_unresolvable',
      detail: `audit route rejected: ${resolved.error}`,
    };
  }
  const stated = resolved.list.candidates.find((candidate) => candidate.name === input.targetName);
  if (!stated) {
    return {
      ok: false, refusal: 'target_not_candidate',
      detail: 'audit target is not a peer-audit candidate for the audited session',
    };
  }
  if (!stated.eligible) {
    return {
      ok: false, refusal: 'target_ineligible',
      detail: `audit target is ineligible: ${stated.reason}`,
    };
  }
  return { ok: true };
}
