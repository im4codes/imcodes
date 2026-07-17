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
    case 'gemini':
    case 'gemini-sdk':
      return 'Gm';
    case 'grok-sdk':
      return 'Gx';
    case 'qwen':
      return 'Qw';
    case 'kimi-sdk':
      return 'Km';
    case 'copilot-sdk':
      return 'Cp';
    case 'openclaw':
      return 'OC';
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

function candidateRank(candidate: PeerAuditCandidate, auditedModel: string, auditedProvider: string): number {
  if (!candidate.eligible) return 100;
  const differentProvider = candidate.providerFamily !== UNKNOWN_DIMENSION
    && auditedProvider !== UNKNOWN_DIMENSION
    && candidate.providerFamily !== auditedProvider;
  if (differentProvider) return 0;
  const differentModel = candidate.normalizedModelId !== UNKNOWN_DIMENSION
    && auditedModel !== UNKNOWN_DIMENSION
    && candidate.normalizedModelId !== auditedModel;
  return differentModel ? 1 : 2;
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
  const auditedModel = metadata.normalizedModelId(audited);
  const auditedProvider = metadata.providerFamily(audited);
  candidates.sort((a, b) => candidateRank(a, auditedModel, auditedProvider) - candidateRank(b, auditedModel, auditedProvider)
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
