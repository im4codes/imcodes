import {
  PEER_AUDIT_CONFIG_ERRORS,
  PEER_AUDIT_COMMAND_ERRORS,
  PEER_AUDIT_MESSAGES,
  PEER_AUDIT_PREFLIGHT_ERRORS,
  decodePeerAuditCandidateList,
} from '@shared/peer-audit.js';
import { DAEMON_COMMAND_TYPES } from '@shared/daemon-command-types.js';
import { TIMELINE_MESSAGES } from '@shared/timeline-protocol.js';
import type { ServerMessage, WsClient } from '../ws-client.js';
import type { PeerAuditAdapter, PeerAuditErrorReason, PeerAuditState } from './types.js';

const REQUEST_TIMEOUT_MS = 12_000;

function commandId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function mapError(error: unknown): PeerAuditErrorReason {
  const value = String(error ?? 'daemon_reject');
  switch (value) {
    case PEER_AUDIT_PREFLIGHT_ERRORS.CANDIDATE_REFRESH_REQUIRED:
      return 'candidate_refresh_required';
    case PEER_AUDIT_CONFIG_ERRORS.CONFIG_CONFLICT:
      return 'config_conflict';
    case PEER_AUDIT_PREFLIGHT_ERRORS.PEER_AUDIT_BUSY:
    case PEER_AUDIT_PREFLIGHT_ERRORS.AWAITING_PEER_AUDIT_SLOT:
      return 'already_pending';
    case PEER_AUDIT_PREFLIGHT_ERRORS.BASELINE_ACTIVE:
    case PEER_AUDIT_PREFLIGHT_ERRORS.BASELINE_PARTIAL:
    case PEER_AUDIT_PREFLIGHT_ERRORS.BASELINE_NO_RESULT:
    case PEER_AUDIT_PREFLIGHT_ERRORS.BASELINE_STALE:
    case PEER_AUDIT_PREFLIGHT_ERRORS.BASELINE_UNRELATED:
      return 'no_baseline';
    case PEER_AUDIT_PREFLIGHT_ERRORS.MODEL_NOT_DIFFERENT:
    case PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE:
    case PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_RUNTIME_BUSY_UNCANCELLABLE:
    case PEER_AUDIT_PREFLIGHT_ERRORS.ATTEMPT_NOT_FOUND:
    case PEER_AUDIT_COMMAND_ERRORS.AUDITED_SESSION_UNAVAILABLE:
    case PEER_AUDIT_COMMAND_ERRORS.AUDITED_IDENTITY_CHANGED:
      return 'target_unavailable';
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_COMMAND_ID:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_AUDITED_SESSION_NAME:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_AUDITED_SESSION_INSTANCE_ID:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_CANDIDATE_REVISION:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_TARGET_CONFIG_REVISION:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_SELECTION_INTENT:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_TARGET:
    case PEER_AUDIT_COMMAND_ERRORS.INVALID_ATTEMPT_ID:
    case PEER_AUDIT_COMMAND_ERRORS.DAEMON_UNAVAILABLE:
    case PEER_AUDIT_COMMAND_ERRORS.ROUTE_RESERVATION_FAILED:
      return 'preflight_failed';
    default:
      return 'daemon_reject';
  }
}

function waitForMessage<T extends ServerMessage>(
  ws: WsClient,
  id: string,
  type: T['type'],
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      reject(new Error('peer_audit_command_timeout'));
    }, REQUEST_TIMEOUT_MS);
    const unsubscribe = ws.onMessage((message) => {
      const record = message as ServerMessage & { commandId?: string };
      if (record.type !== type || record.commandId !== id) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(record as T);
    });
  });
}

export function createWsPeerAuditAdapter(ws: WsClient): PeerAuditAdapter {
  return {
    async listCandidates(input) {
      const id = commandId('peer_list');
      const response = waitForMessage<any>(ws, id, PEER_AUDIT_MESSAGES.CANDIDATES);
      ws.send({
        type: DAEMON_COMMAND_TYPES.PEER_AUDIT_LIST_CANDIDATES,
        commandId: id,
        auditedSessionName: input.auditedSessionName,
        auditedSessionInstanceId: input.auditedSessionIdentity.sessionInstanceId,
      });
      const message = await response;
      if (message.ok !== true) throw new Error(String(message.error ?? 'candidate_list_failed'));
      const decoded = decodePeerAuditCandidateList(message.list);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.value;
    },

    async patchAuditorTarget() {
      // Target-only CAS and persistence are performed atomically by quick_start
      // after candidate revision revalidation. No whole-config Web write occurs.
      return { ok: true };
    },

    async startQuickAudit(input) {
      const response = waitForMessage<any>(ws, input.commandId, PEER_AUDIT_MESSAGES.QUICK_RESULT);
      ws.send({
        type: DAEMON_COMMAND_TYPES.PEER_AUDIT_QUICK_START,
        commandId: input.commandId,
        auditedSessionName: input.auditedSessionName,
        auditedSessionInstanceId: input.auditedSessionIdentity.sessionInstanceId,
        candidateRevision: input.candidateListRevision,
        targetConfigRevision: input.targetConfigRevision,
        selectionIntent: input.selectionIntent,
        target: {
          auditorSessionName: input.auditor.sessionName,
          auditorSessionInstanceId: input.auditor.sessionInstanceId,
          auditorRuntimeEpoch: input.auditor.runtimeEpoch,
        },
      });
      const message = await response;
      if (message.ok === true && typeof message.attemptId === 'string' && typeof message.resultEventId === 'string') {
        return { ok: true, attemptId: message.attemptId, resultEventId: message.resultEventId };
      }
      return {
        ok: false,
        reason: mapError(message.error),
        message: String(message.error ?? 'peer audit start rejected'),
      };
    },

    async cancelAttempt(input) {
      const id = commandId('peer_cancel');
      const response = waitForMessage<any>(ws, id, PEER_AUDIT_MESSAGES.CANCEL_RESULT);
      ws.send({
        type: DAEMON_COMMAND_TYPES.PEER_AUDIT_CANCEL,
        commandId: id,
        auditedSessionName: input.auditedSessionName,
        auditedSessionInstanceId: input.auditedSessionIdentity.sessionInstanceId,
        attemptId: input.attemptId,
      });
      const message = await response;
      return message.ok === true
        ? { ok: true }
        : {
            ok: false,
            reason: mapError(message.error),
            message: String(message.error ?? 'peer audit cancellation rejected'),
          };
    },

    subscribeResults(input) {
      const seen = new Set<string>();
      return ws.onMessage((message) => {
        if (message.type !== TIMELINE_MESSAGES.EVENT) return;
        const event = message.event;
        if (event.sessionId !== input.auditedSessionName) return;
        if (event.type === 'peer_audit.status') {
          const resultEventId = typeof event.payload.resultEventId === 'string' ? event.payload.resultEventId : '';
          const phase = String(event.payload.phase ?? '');
          if (resultEventId && ['preparing', 'sent', 'queued', 'sent_unrevocable', 'waiting_reply'].includes(phase)) {
            input.onStatus({ resultEventId, phase: phase as any });
          }
          return;
        }
        if (event.type !== 'peer_audit.result') return;
        if (seen.has(event.eventId)) return;
        seen.add(event.eventId);
        const outcome = String(event.payload.outcome ?? 'target_unavailable');
        const attempt: Extract<PeerAuditState, { kind: 'result' }> = {
          kind: 'result',
          attemptId: event.eventId,
          verdict: outcome === 'pass' ? 'PASS' : outcome === 'rework' ? 'REWORK' : outcome === 'cancelled' ? 'cancelled' : outcome === 'timeout' ? 'timeout' : 'unavailable',
          auditorLabel: String(event.payload.auditorLabel ?? event.payload.auditorSessionName ?? '—'),
          elapsedMs: typeof event.payload.elapsedMs === 'number' ? event.payload.elapsedMs : 0,
          ...(typeof event.payload.findingsPreview === 'string' ? { findingsPreview: event.payload.findingsPreview } : {}),
        };
        input.onResult(attempt);
      });
    },
  };
}
