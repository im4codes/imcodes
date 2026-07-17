/**
 * Peer audit — Web-side adapter boundaries.
 *
 * All wire-level enums, types, parsers, and limits live in
 * `@shared/peer-audit.js` (CLAUDE.md ZERO TOLERANCE). This module only
 * re-exports what the Web needs and adds UI-only state machine types
 * (PeerAuditState, PeerAuditControllerApi, PeerAuditAdapter) that have no
 * equivalent in shared.
 */

import type {
  PeerAuditCandidate,
  PeerAuditCandidateList,
  PeerAuditRuntimeDisposition,
  PeerAuditPhase,
  PeerAuditSelectionIntent,
  PeerAuditTrigger,
  PeerAuditVerdict,
} from '@shared/peer-audit.js';
import {
  PEER_AUDIT_CANDIDATE_REASONS,
  PEER_AUDIT_PROMPT_VERSION,
  PEER_AUDIT_RUNTIME_DISPOSITIONS,
  PEER_AUDIT_SELECTION_INTENTS,
  PEER_AUDIT_TERMINAL_OUTCOMES,
  PEER_AUDIT_TRIGGERS,
} from '@shared/peer-audit.js';

export type {
  PeerAuditCandidate,
  PeerAuditCandidateList,
  PeerAuditRuntimeDisposition,
  PeerAuditPhase,
  PeerAuditSelectionIntent,
  PeerAuditTrigger,
  PeerAuditVerdict,
};

const PEER_AUDIT_PROVIDER_TYPE_LABELS: Readonly<Record<string, string>> = {
  anthropic: 'CC',
  openai: 'CX',
  cursor: 'Cu',
  google: 'Gm',
  alibaba: 'Qw',
  xai: 'Gx',
  moonshot: 'Km',
  github: 'Cp',
  openclaw: 'OC',
  unknown: 'AI',
};

export function peerAuditProviderTypeLabel(providerFamily: string): string {
  return PEER_AUDIT_PROVIDER_TYPE_LABELS[providerFamily] ?? PEER_AUDIT_PROVIDER_TYPE_LABELS.unknown;
}

/** User-visible auditor attribution. Protocol names (`deck_*`) are authority
 * identifiers only and must never leak into chooser/result UI. */
export function peerAuditCandidateDisplayLabel(candidate: Pick<PeerAuditCandidate, 'label' | 'providerFamily'>): string {
  const label = candidate.label.trim();
  return label && !label.startsWith('deck_')
    ? label
    : peerAuditProviderTypeLabel(candidate.providerFamily);
}

/**
 * Authoritative identity required to enable Peer Audit on a session. Every
 * field MUST come from daemon-authoritative session_list / subsession.sync —
 * never derived from session name. Until this shape is populated, the UI
 * MUST NOT offer Peer Audit (icon hidden, chooser closed, settings picker
 * disabled).
 */
export interface PeerAuditAuditedSessionIdentity {
  /** Daemon-issued, monotonically-recreated session instance id. */
  sessionInstanceId: string;
  /** Daemon-issued runtime epoch; changes on authority / runtime replacement. */
  runtimeEpoch: string;
}

export type PeerAuditChooserReason =
  | 'missing_target'
  | 'self_target'
  | 'stale_target'
  | 'same_model_remembered'
  | 'unknown_model_remembered'
  | 'no_candidate'
  | 'model_changed_since_click'
  | 'config_repair';

export type PeerAuditErrorReason =
  | 'already_pending'
  | 'no_baseline'
  | 'target_unavailable'
  | 'candidate_refresh_required'
  | 'config_conflict'
  | 'preflight_failed'
  | 'daemon_reject'
  | 'identity_missing';

export type PeerAuditState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'chooser'; reason: PeerAuditChooserReason; candidates: PeerAuditCandidateList | null }
  | { kind: 'consent'; providerFamily: string; normalizedModelId: string; auditorLabel: string }
  | { kind: 'starting'; attemptId: string; auditorLabel: string }
  | { kind: 'pending'; attemptId: string; resultEventId: string; auditorLabel: string; elapsedMs: number; phase: PeerAuditPhase }
  | {
      kind: 'result';
      attemptId: string;
      verdict: 'PASS' | 'REWORK' | 'timeout' | 'unavailable' | 'cancelled';
      auditorLabel: string;
      elapsedMs: number;
      findingsPreview?: string;
    }
  | { kind: 'error'; reason: PeerAuditErrorReason; message: string };

export interface PeerAuditControllerApi {
  state: PeerAuditState;
  start: (input: {
    auditedSessionName: string;
    auditedSessionIdentity: PeerAuditAuditedSessionIdentity;
    rememberedTarget: PeerAuditRememberedTarget | null;
    auditedModel: { normalizedModelId: string; providerFamily: string } | null;
  }) => void;
  confirmConsent: () => void;
  cancelConsent: () => void;
  selectCandidate: (candidate: PeerAuditCandidate) => void;
  cancelChooser: () => void;
  acknowledgeResult: () => void;
  cancelPending: () => void;
}

export interface PeerAuditRememberedTarget {
  sessionName: string;
  sessionInstanceId: string;
  runtimeEpoch: string;
  normalizedModelId: string;
  providerFamily: string;
  fingerprint: string;
}

export interface PeerAuditAdapter {
  listCandidates(input: {
    auditedSessionName: string;
    auditedSessionIdentity: PeerAuditAuditedSessionIdentity;
  }): Promise<PeerAuditCandidateList>;
  patchAuditorTarget(input: {
    auditedSessionName: string;
    auditedSessionIdentity: PeerAuditAuditedSessionIdentity;
    target: { sessionName: string; sessionInstanceId: string; runtimeEpoch: string };
    candidateListRevision: string;
  }): Promise<{ ok: true } | { ok: false; reason: 'config_conflict' | 'target_unavailable' | 'preflight_failed' }>;
  startQuickAudit(input: {
    auditedSessionName: string;
    auditedSessionIdentity: PeerAuditAuditedSessionIdentity;
    auditor: { sessionName: string; sessionInstanceId: string; runtimeEpoch: string };
    selectionIntent: PeerAuditSelectionIntent;
    candidateListRevision: string;
    targetConfigRevision: string;
    commandId: string;
  }): Promise<
    | { ok: true; attemptId: string; resultEventId: string }
    | { ok: false; reason: PeerAuditErrorReason; message: string }
  >;
  cancelAttempt(input: {
    auditedSessionName: string;
    auditedSessionIdentity: PeerAuditAuditedSessionIdentity;
    attemptId: string;
  }): Promise<{ ok: true } | { ok: false; reason: PeerAuditErrorReason; message: string }>;
  subscribeResults(input: {
    auditedSessionName: string;
    onResult: (event: Extract<PeerAuditState, { kind: 'result' }>) => void;
    onStatus: (event: { resultEventId: string; phase: PeerAuditPhase }) => void;
    onError: (reason: PeerAuditErrorReason, message: string) => void;
  }): () => void;
}

/**
 * Stable enums re-exported from shared for downstream UI/test imports. UI code
 * should consume these rather than reaching into shared directly.
 */
export const PeerAuditTriggers = PEER_AUDIT_TRIGGERS;
export const PeerAuditSelectionIntents = PEER_AUDIT_SELECTION_INTENTS;
export const PeerAuditRuntimeDispositions = PEER_AUDIT_RUNTIME_DISPOSITIONS;
export const PeerAuditCandidateReasons = PEER_AUDIT_CANDIDATE_REASONS;
export const PeerAuditTerminalOutcomes = PEER_AUDIT_TERMINAL_OUTCOMES;
export const PeerAuditPromptVersion = PEER_AUDIT_PROMPT_VERSION;
