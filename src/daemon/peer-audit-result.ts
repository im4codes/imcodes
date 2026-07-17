import { createHash } from 'node:crypto';
import {
  PEER_AUDIT_CONTRACT_VERSION,
  PEER_AUDIT_TIMELINE_PREVIEW_BYTES,
  sanitizePeerAuditUntrustedText,
  type PeerAuditPhase,
  type PeerAuditRuntimeDisposition,
  type PeerAuditTerminalOutcome,
  type PeerAuditTrigger,
} from '../../shared/peer-audit.js';
import { timelineEmitter } from './timeline-emitter.js';
import { incrementCounter } from '../util/metrics.js';

const PEER_AUDIT_METRIC_REASONS = new Set([
  'none',
  'automatic_mode_unrunnable',
  'automatic_waiter_invalidated',
  'audited_identity_changed',
  'audited_session_error',
  'audited_session_stopped',
  'audited_session_stopping',
  'auditor_identity_or_state_changed',
  'baseline_invalidated',
  'cancel',
  'cancelled',
  'configuration_invalidated',
  'deadline_expired',
  'dispatch_failed',
  'new_intent',
  'new_task_intent_replaced_existing_audit',
  'queued_edit',
  'queued_target_identity_changed',
  'session_supervision_cancelled',
  'shutdown',
  'target_identity_changed',
  'target_ineligible',
  'target_invalidated',
  'target_runtime_busy_uncancellable',
  'target_unavailable',
  'user_cancelled',
]);

function metricReason(reason: string | undefined): string {
  if (!reason) return 'none';
  return PEER_AUDIT_METRIC_REASONS.has(reason) ? reason : 'other';
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  let result = '';
  let used = 0;
  for (const char of value) {
    const size = new TextEncoder().encode(char).length;
    if (used + size > Math.max(0, maxBytes - 3)) break;
    result += char;
    used += size;
  }
  return `${result}…`;
}

export function emitPeerAuditResult(input: {
  auditedSessionName: string;
  attemptId: string;
  trigger: PeerAuditTrigger;
  outcome: PeerAuditTerminalOutcome;
  auditorSessionName: string;
  auditorLabel?: string;
  elapsedMs: number;
  disposition?: PeerAuditRuntimeDisposition;
  findings?: string;
  reason?: string;
}): string {
  const eventId = peerAuditResultEventId(input.attemptId);
  const findingsPreview = input.findings
    ? truncateUtf8(sanitizePeerAuditUntrustedText(input.findings), PEER_AUDIT_TIMELINE_PREVIEW_BYTES)
    : undefined;
  const reason = input.reason
    ? truncateUtf8(sanitizePeerAuditUntrustedText(input.reason), 256)
    : undefined;
  timelineEmitter.emit(input.auditedSessionName, 'peer_audit.result', {
    memoryExcluded: true,
    trigger: input.trigger,
    outcome: input.outcome,
    auditorSessionName: input.auditorSessionName,
    ...(input.auditorLabel ? { auditorLabel: input.auditorLabel } : {}),
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(findingsPreview ? { findingsPreview } : {}),
    ...(reason ? { reason } : {}),
  }, { source: 'daemon', confidence: 'high', eventId });
  incrementCounter('peer_audit.terminal', {
    contractVersion: PEER_AUDIT_CONTRACT_VERSION,
    trigger: input.trigger,
    disposition: input.disposition ?? 'none',
    outcome: input.outcome,
    reason: metricReason(input.reason),
  });
  return eventId;
}

/** Public correlation id for the reconnect-safe result event.
 * This is safe to expose to Web clients: it is a one-way digest and is
 * already the persisted timeline event id. The opaque attempt id and reply
 * capability remain daemon-only. */
export function peerAuditResultEventId(attemptId: string): string {
  return `peer-audit-result:${createHash('sha256').update(attemptId).digest('base64url')}`;
}

export function emitPeerAuditStatus(input: {
  auditedSessionName: string;
  attemptId: string;
  revision: number;
  trigger: PeerAuditTrigger;
  phase: PeerAuditPhase;
  auditorSessionName: string;
  auditorLabel?: string;
  disposition?: PeerAuditRuntimeDisposition;
  reason?: string;
}): string {
  const resultEventId = peerAuditResultEventId(input.attemptId);
  const eventId = `${resultEventId}:status:${input.revision}:${input.phase}`;
  const reason = input.reason
    ? truncateUtf8(sanitizePeerAuditUntrustedText(input.reason), 256)
    : undefined;
  timelineEmitter.emit(input.auditedSessionName, 'peer_audit.status', {
    memoryExcluded: true,
    resultEventId,
    trigger: input.trigger,
    phase: input.phase,
    auditorSessionName: input.auditorSessionName,
    ...(input.auditorLabel ? { auditorLabel: input.auditorLabel } : {}),
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(reason ? { reason } : {}),
  }, { source: 'daemon', confidence: 'high', eventId });
  incrementCounter('peer_audit.status', {
    contractVersion: PEER_AUDIT_CONTRACT_VERSION,
    trigger: input.trigger,
    disposition: input.disposition ?? 'none',
    outcome: 'pending',
    reason: input.phase,
  });
  return eventId;
}
