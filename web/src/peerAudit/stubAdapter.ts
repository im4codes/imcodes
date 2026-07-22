/**
 * Stub peer-audit adapter. Used only until shared/daemon expose the real
 * commands (peer_audit.list_candidates / peer_audit.quick_start / etc.). This
 * stub never reaches the network — it returns deterministic local data so the
 * Web UI slice can be exercised end-to-end and tests can run without a daemon.
 *
 * The stub REQUIRES an authoritative identity — it refuses to fabricate
 * sessionInstanceId / runtimeEpoch from a session name. If no identity is
 * supplied it returns a fail-closed error.
 *
 * Integration note: this module will be removed when the real adapter is
 * wired. The replacement must call the daemon WS command(s) defined in
 * shared/daemon-command-types.ts (constants PEER_AUDIT_COMMANDS.*).
 */

import type {
  PeerAuditAdapter,
  PeerAuditAuditedSessionIdentity,
  PeerAuditCandidate,
  PeerAuditCandidateList,
  PeerAuditErrorReason,
} from './types.js';

export function createStubPeerAuditAdapter(): PeerAuditAdapter {
  return {
    async listCandidates(input): Promise<PeerAuditCandidateList> {
      if (!input.auditedSessionIdentity.sessionInstanceId || !input.auditedSessionIdentity.runtimeEpoch) {
        throw new Error('identity_missing');
      }
      return {
        revision: `rev-${input.auditedSessionIdentity.sessionInstanceId}-${Date.now()}`,
        targetConfigRevision: `target-rev-${input.auditedSessionIdentity.sessionInstanceId}`,
        auditedSessionName: input.auditedSessionName,
        auditedSessionInstanceId: input.auditedSessionIdentity.sessionInstanceId,
        candidates: [
          {
            name: `${input.auditedSessionName}-stub-peer-a`,
            label: 'Stub Peer A',
            sessionInstanceId: 'stub-instance-a',
            runtimeEpoch: 'stub-epoch-a',
            normalizedModelId: 'claude-opus-4-7',
            providerFamily: 'anthropic',
            liveState: 'idle',
            dispositionCapability: 'sent',
            eligible: true,
            reason: 'eligible',
          },
          {
            name: `${input.auditedSessionName}-stub-peer-b`,
            label: 'Stub Peer B (process)',
            sessionInstanceId: 'stub-instance-b',
            runtimeEpoch: 'stub-epoch-b',
            normalizedModelId: 'gpt-4',
            providerFamily: 'openai',
            liveState: 'idle',
            dispositionCapability: 'sent_unrevocable',
            eligible: true,
            reason: 'eligible',
          },
        ],
      };
    },

    async patchAuditorTarget(): Promise<{ ok: true } | { ok: false; reason: 'config_conflict' | 'target_unavailable' | 'preflight_failed' }> {
      return { ok: true };
    },

    async startQuickAudit(): Promise<{ ok: true; attemptId: string; resultEventId: string } | { ok: false; reason: PeerAuditErrorReason; message: string }> {
      const attemptId = `stub-attempt-${Date.now()}`;
      return { ok: true, attemptId, resultEventId: `stub-result-${attemptId}` };
    },

    async cancelAttempt() {
      return { ok: false as const, reason: 'daemon_reject' as const, message: 'Peer Audit daemon adapter unavailable.' };
    },

    subscribeResults(input): () => void {
      void input;
      return () => {};
    },
  };
}

export type { PeerAuditAdapter, PeerAuditCandidate, PeerAuditCandidateList, PeerAuditAuditedSessionIdentity };
