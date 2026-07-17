import { getSessionRuntimeType } from '../../shared/agent-types.js';
import { PEER_AUDIT_PREFLIGHT_ERRORS } from '../../shared/peer-audit.js';
import { getSession } from '../store/session-store.js';
import type { SessionRecord } from '../store/session-store.js';

/**
 * Process-private peer-audit injection.
 *
 * A process runtime cannot revoke a terminal injection once it is written, so
 * everything that could make the injection wrong must be decided *before* the
 * write, and nothing may change in between. Two properties are load-bearing:
 *
 *  1. Privacy. The brief carries a one-time reply capability. It is injected as
 *     raw agent input and never travels through the ordinary send path, which
 *     would persist it as a user.message timeline event, into history, and into
 *     memory recall for later sessions.
 *  2. Atomicity. Identity, authoritative idle state, and effect currency are
 *     re-read inside the same per-session stdin lock that serializes the write,
 *     so a caller's earlier snapshot can never authorize a stale injection.
 *     Every barrier (cancel, timeout, busy, delete/recreate, runtime
 *     replacement) therefore results in zero send, not a late one.
 */

export type PeerAuditProcessInjectError =
  | typeof PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE
  | typeof PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_RUNTIME_BUSY_UNCANCELLABLE
  | typeof PEER_AUDIT_PREFLIGHT_ERRORS.ATTEMPT_NOT_FOUND;

export type PeerAuditProcessInjectResult =
  | { ok: true }
  | { ok: false; error: PeerAuditProcessInjectError };

export interface PeerAuditProcessInjectorDeps {
  /** Authoritative live record lookup, re-read inside the lock. */
  getSession: (sessionName: string) => SessionRecord | undefined;
  /** Holds the same mutex that serializes ordinary process stdin writes. */
  withProcessSendLock: <T>(sessionName: string, fn: () => Promise<T>) => Promise<T>;
  /** Completes all asynchronous backend setup, then returns an atomic writer. */
  preparePrivateWriter: (sessionName: string) => Promise<(text: string) => void>;
}

export interface PeerAuditProcessInjectInput {
  targetSessionName: string;
  /** Identity the attempt was authorized against; a mismatch means delete/recreate. */
  expectedSessionInstanceId: string;
  /** Runtime authority the attempt was authorized against; a mismatch means replacement. */
  expectedRuntimeEpoch: string;
  brief: string;
  /**
   * Final effect-revision barrier, evaluated synchronously immediately before
   * the write. Returning false (cancelled, timed out, superseded revision)
   * guarantees zero send.
   */
  isEffectCurrent?: () => boolean;
}

async function loadCommandHandlerSeam(): Promise<Pick<PeerAuditProcessInjectorDeps, 'withProcessSendLock' | 'preparePrivateWriter'>> {
  // Lazily imported for the same reason the ordinary dispatch path does it:
  // command-handler pulls in the whole daemon command surface.
  const mod = await import('./command-handler.js');
  return {
    withProcessSendLock: mod.runWithProcessSessionSendLock,
    preparePrivateWriter: mod.prepareProcessSessionPrivateWriter,
  };
}

function ineligible(): PeerAuditProcessInjectResult {
  return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_INELIGIBLE };
}

/**
 * Validate at the final boundary and inject, or send nothing.
 *
 * Resolving `{ ok: true }` means the write was actually issued and is now
 * unrevocable; every other outcome guarantees no bytes reached the runtime.
 */
export async function injectPeerAuditBriefIntoProcessSession(
  input: PeerAuditProcessInjectInput,
  overrides: Partial<PeerAuditProcessInjectorDeps> = {},
): Promise<PeerAuditProcessInjectResult> {
  const seam = overrides.withProcessSendLock && overrides.preparePrivateWriter
    ? { withProcessSendLock: overrides.withProcessSendLock, preparePrivateWriter: overrides.preparePrivateWriter }
    : await loadCommandHandlerSeam();
  const withProcessSendLock = overrides.withProcessSendLock ?? seam.withProcessSendLock;
  const preparePrivateWriter = overrides.preparePrivateWriter ?? seam.preparePrivateWriter;
  const readSession = overrides.getSession ?? getSession;
  const isEffectCurrent = input.isEffectCurrent ?? (() => true);
  // Backend setup may await dynamic imports or process probes. Finish it before
  // entering the serialized final boundary; no capability material is written.
  const writePrivateText = await preparePrivateWriter(input.targetSessionName);

  return withProcessSendLock(input.targetSessionName, async () => {
    // Everything below re-reads authoritative state. The caller's snapshot is
    // deliberately not trusted: it was taken before this lock was acquired.
    const live = readSession(input.targetSessionName);
    if (!live) return ineligible();
    if (!live.sessionInstanceId || live.sessionInstanceId !== input.expectedSessionInstanceId) return ineligible();
    if (!live.runtimeEpoch || live.runtimeEpoch !== input.expectedRuntimeEpoch) return ineligible();
    if ((live.runtimeType ?? getSessionRuntimeType(live.agentType)) !== 'process') return ineligible();
    if (live.state !== 'idle') {
      return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.TARGET_RUNTIME_BUSY_UNCANCELLABLE };
    }
    // Last gate before the unrevocable write: synchronous, no await between
    // this check and the injection.
    if (!isEffectCurrent()) {
      return { ok: false, error: PEER_AUDIT_PREFLIGHT_ERRORS.ATTEMPT_NOT_FOUND };
    }
    writePrivateText(input.brief);
    return { ok: true };
  });
}
