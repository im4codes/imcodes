import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { resolveAuth } from '../security/authorization.js';
import { createMachineExecAuditIntent, updateMachineExecAuditResult } from '../security/machine-exec-audit.js';
import logger from '../util/logger.js';
import { WsBridge } from '../ws/bridge.js';
import { registerPendingExec, cancelPendingExec } from '../ws/machine-exec-registry.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../../shared/daemon-events.js';
import {
  NODE_ROLE,
  encodeMachineExecHttpEnvelope,
  MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
  MACHINE_EXEC_HTTP_PROTOCOL,
  MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES,
  utf8ByteLength,
  validateMachineExecFrame,
  validateMachineExecResultFrame,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  type MachineExecFrame,
  type MachineExecHttpEnvelope,
  type MachineExecHttpReason,
  type RemoteExecOutcome,
  type RemoteExecResult,
} from '../../../shared/remote-exec.js';

/** Extra time the relay waits beyond the node's own timeout before giving up (F: deadline ≥ node timeout). */
const DEFAULT_RELAY_DEADLINE_BUFFER_MS = 30_000;
let relayDeadlineBufferMs = DEFAULT_RELAY_DEADLINE_BUFFER_MS;

/** Test-only deadline seam; production retains the 30s post-node buffer. */
export function __setMachineExecRelayDeadlineBufferMsForTests(value?: number): void {
  if (value === undefined) {
    relayDeadlineBufferMs = DEFAULT_RELAY_DEADLINE_BUFFER_MS;
    return;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_relay_deadline_buffer');
  relayDeadlineBufferMs = value;
}

/**
 * Dispatch a validated exec frame to the target. Returns `{online:false}` when the
 * target is not connected (→ `not_dispatched`), or `{online:true, result?}` where a
 * missing result means the relay deadline elapsed (→ `dispatched_no_result`).
 * Injectable so the authz/outcome logic is testable without a live daemon.
 */
export type ExecDispatcher = (
  targetServerId: string,
  frame: MachineExecFrame,
  deadlineMs: number,
) => Promise<{ online: boolean; result?: RemoteExecResult }>;

/** Body fields a source may supply. Identity/target/correlation are server-owned and rejected if present. */
const ALLOWED_EXEC_BODY_KEYS = new Set(['command', 'shell', 'cwd', 'timeoutMs']);

/**
 * Durable exec-intent store (audit-checklist invariant): the dispatch intent is
 * persisted BEFORE the MACHINE_EXEC send, and the SAME `correlationId` record is
 * later updated with the truthful terminal outcome. This is a HARD, fail-closed
 * gate — NOT best-effort `logAudit`: if `record()` cannot durably persist, the
 * route STOPS before dispatch (503) and the command is never sent.
 *
 * Injectable so the invariant is enforced/tested without coupling this slice to a
 * schema. When no store is wired, the gate is dormant (see the export at the
 * bottom) — the durable table + production wiring are integrated separately.
 */
export interface ExecIntentStore {
  /** Persist a `pending` intent. MUST reject if it cannot durably persist (→ 503, no dispatch). */
  record(db: Database, intent: {
    correlationId: string;
    userId: string;
    sourceServerId: string;
    targetServerId: string;
    shell: string;
    commandSha256: string;
    commandLengthBytes: number;
  }): Promise<void>;
  /** Update the SAME `correlationId` record with the truthful terminal outcome after dispatch. */
  settle(db: Database, correlationId: string, outcome: RemoteExecOutcome, result: {
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
  }): Promise<void>;
}

/** Default dispatcher: live WsBridge push + per-pod pending-RPC (bound to connection generation). */
const defaultDispatcher: ExecDispatcher = async (targetServerId, frame, deadlineMs) => {
  const bridge = WsBridge.get(targetServerId);
  if (!bridge.isDaemonConnected()) return { online: false };
  const generation = bridge.daemonConnectionGeneration();
  // Register the pending entry BEFORE sending: a fast result must not arrive
  // before the correlation exists (the registry would drop it). The send is
  // non-queueing + generation-bound — if it doesn't land on this exact live
  // generation the pending is cancelled and the outcome is `not_dispatched`
  // (the command definitely did not execute), never a queued late replay.
  const pending = registerPendingExec(targetServerId, frame.correlationId, generation, deadlineMs);
  const sent = bridge.trySendMachineExec(
    JSON.stringify({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, ...frame }),
    generation,
  );
  if (sent !== 'sent') {
    cancelPendingExec(frame.correlationId);
    return { online: false };
  }
  const result = await pending;
  return { online: true, ...(result ? { result } : {}) };
};

function outcomeFor(dispatch: { online: boolean; result?: RemoteExecResult }): RemoteExecOutcome {
  if (!dispatch.online) return 'not_dispatched';
  const r = dispatch.result;
  if (!r) return 'dispatched_no_result';
  if (r.timedOut) return 'node_timeout';
  if (!r.ok && r.exitCode == null) return 'spawn_error';
  return 'completed';
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');

function preDispatchEnvelope(reason: MachineExecHttpReason) {
  return encodeMachineExecHttpEnvelope('not_dispatched', undefined, reason);
}

/**
 * A dependency-free current-protocol fallback for the post-dispatch uncertainty
 * boundary. Once dispatch has been attempted, an exception cannot prove that the
 * command did not run, so callers must never receive a generic 500 or a retry-safe
 * `not_dispatched` response — even if the normal result encoder itself rejects an
 * anomalous dispatcher value.
 */
function postDispatchIndeterminateEnvelope(reason: 'relay_deadline' | 'invalid_result'): MachineExecHttpEnvelope {
  return {
    protocol: MACHINE_EXEC_HTTP_PROTOCOL,
    version: MACHINE_EXEC_HTTP_ENVELOPE_VERSION,
    outcome: 'dispatched_no_result',
    reason,
  };
}

function assertHttpEnvelopeWithinCap(envelope: unknown): void {
  if (utf8ByteLength(JSON.stringify(envelope)) > MACHINE_EXEC_HTTP_RESPONSE_MAX_BYTES) {
    throw new Error('machine_exec_http_response_too_large');
  }
}

/**
 * `POST /api/machine/exec?serverId=<target>` — the source (a FULL daemon) runs a
 * one-shot command on a CONTROLLED target it owns. `?serverId=` is the target /
 * pod-routing key; `X-Server-Id`+Bearer (resolved route-locally) is the source.
 */
export function createMachineExecRoutes(
  dispatcher: ExecDispatcher = defaultDispatcher,
  intentStore?: ExecIntentStore,
) {
  const routes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

  routes.post('/', async (c) => {
    const auth = await resolveAuth(c);
    if (!auth) return c.json(preDispatchEnvelope('scoped_auth'), 401);
    const userId = auth.userId;
    const sourceServerId = auth.serverId;
    if (auth.nodeRole !== NODE_ROLE.FULL || !sourceServerId) return c.json(preDispatchEnvelope('scoped_auth'), 403);

    const targetId = c.req.query('serverId');
    if (!targetId) return c.json(preDispatchEnvelope('invalid_request'), 400);
    if (targetId === sourceServerId) return c.json(preDispatchEnvelope('scoped_auth'), 403);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    // Strict HTTP identity/target validation: the target is the `?serverId=` query
    // key and the source is `X-Server-Id`+Bearer. The body carries ONLY exec
    // parameters — any identity/target/correlation field (or unknown field) in the
    // body is a mismatch/injection attempt and is rejected, never silently ignored.
    if (body) {
      for (const k of Object.keys(body)) {
        if (!ALLOWED_EXEC_BODY_KEYS.has(k)) {
          return c.json(preDispatchEnvelope('invalid_request'), 400);
        }
      }
    }
    const correlationId = randomBytes(16).toString('hex');
    // Reserved wire compatibility only: the relay owns this nonce and binds it
    // to the unpredictable correlation id. It is not a caller-controlled
    // deduplication key and carries no retry/exactly-once guarantee.
    const idempotencyKey = correlationId;
    const v = validateMachineExecFrame({
      type: DAEMON_COMMAND_TYPES.MACHINE_EXEC,
      ...(body ?? {}),
      correlationId,
      idempotencyKey,
    });
    if (!v.ok) return c.json(preDispatchEnvelope('invalid_request'), 400);

    const target = await c.env.DB.queryOne<{ user_id: string; node_role: string; exec_enabled: boolean; revoked_at: number | null }>(
      'SELECT user_id, node_role, exec_enabled, revoked_at FROM servers WHERE id = $1',
      [targetId],
    );
    // Return 403 (not 404) for cross-account to avoid existence enumeration.
    if (!target || target.user_id !== userId) return c.json(preDispatchEnvelope('target_forbidden'), 403);
    if (target.node_role !== NODE_ROLE.CONTROLLED) return c.json(preDispatchEnvelope('target_forbidden'), 403);
    if (target.revoked_at != null) return c.json(preDispatchEnvelope('target_forbidden'), 403);
    if (!target.exec_enabled) return c.json(preDispatchEnvelope('exec_disabled'), 403);

    const commandSha256 = sha256Hex(v.value.command);
    // Byte length matches the validator's UTF-8 byte cap (a JS string `.length`
    // would under-count multibyte commands and break audit-vs-limit comparisons).
    const commandLengthBytes = utf8ByteLength(v.value.command);

    // Audit-checklist invariant: persist the dispatch intent BEFORE the send. This
    // is fail-closed — if the durable record cannot be written we refuse to run a
    // SYSTEM/root command at all (a crash after this leaves a `pending` row that is
    // itself truthful evidence of an indeterminate exec).
    if (intentStore) {
      try {
        await intentStore.record(c.env.DB, {
          correlationId, userId, sourceServerId, targetServerId: targetId,
          shell: v.value.shell ?? 'default', commandSha256, commandLengthBytes,
        });
      } catch (err) {
        logger.error({ serverId: targetId, err }, 'Refusing exec — durable intent could not be persisted');
        return c.json(preDispatchEnvelope('intent_unavailable'), 503);
      }
    }

    const nodeTimeout = Math.min(v.value.timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT_MS, REMOTE_EXEC_MAX_TIMEOUT_MS);
    let outcome: RemoteExecOutcome = 'dispatched_no_result';
    let result: RemoteExecResult | undefined;
    let envelope: MachineExecHttpEnvelope = postDispatchIndeterminateEnvelope('invalid_result');
    try {
      let dispatch = await dispatcher(targetId, v.value, nodeTimeout + relayDeadlineBufferMs);
      let invalidResult = false;
      if (dispatch.result) {
        const normalized = validateMachineExecResultFrame({
          type: DAEMON_MSG.MACHINE_EXEC_RESULT,
          correlationId: v.value.correlationId,
          ok: dispatch.result.ok,
          exitCode: dispatch.result.exitCode,
          stdout: dispatch.result.stdout,
          stderr: dispatch.result.stderr,
          truncated: dispatch.result.truncated,
          timedOut: dispatch.result.timedOut,
          durationMs: dispatch.result.durationMs,
          error: dispatch.result.error,
        });
        if (!normalized.ok) {
          invalidResult = true;
          dispatch = { online: dispatch.online };
        }
      }
      outcome = invalidResult ? 'dispatched_no_result' : outcomeFor(dispatch);
      result = dispatch.result;
      envelope = encodeMachineExecHttpEnvelope(outcome, result, invalidResult ? 'invalid_result' : undefined);
      assertHttpEnvelopeWithinCap(envelope);
    } catch (err) {
      // The dispatcher may have sent before throwing, and an invalid/oversized
      // result may fail during normalization or encoding. All such paths are
      // conservatively indeterminate and remain on the current versioned wire.
      logger.error({ serverId: targetId, correlationId, err }, 'Exec post-dispatch processing failed; returning indeterminate outcome');
      outcome = 'dispatched_no_result';
      result = undefined;
      envelope = postDispatchIndeterminateEnvelope('invalid_result');
    }

    // Update the SAME correlationId record with the truthful terminal outcome.
    // A settle failure after dispatch cannot un-run the command and MUST NOT turn a
    // completed exec into a 5xx (that would induce a retry of a non-idempotent
    // command); the `pending` row remains as indeterminate evidence.
    if (intentStore) {
      await intentStore.settle(c.env.DB, correlationId, outcome, {
        exitCode: result?.exitCode ?? null,
        timedOut: result?.timedOut ?? false,
        durationMs: result?.durationMs ?? 0,
      }).catch((err) => logger.error({ serverId: targetId, correlationId, err }, 'Failed to settle exec intent'));
    }
    // NOTE: no separate `logAudit('machine.exec')` here — the durable
    // `machine_exec_audit` row (record → settle) is the single semantic record.

    return c.json(envelope);
  });

  return routes;
}

/**
 * Production intent store — the durable `machine_exec_audit` row IS the single
 * semantic audit record for an exec. `record` (fail-closed, throws) runs before
 * the socket send; `settle` updates the SAME correlation row with the truthful
 * outcome (a missing row on update is surfaced so the route logs it, but never
 * turns an already-dispatched command into a retry-safe 5xx).
 */
export const machineExecAuditIntentStore: ExecIntentStore = {
  record: (db, intent) => createMachineExecAuditIntent(db, {
    correlationId: intent.correlationId,
    userId: intent.userId,
    sourceServerId: intent.sourceServerId,
    targetServerId: intent.targetServerId,
    commandSha256: intent.commandSha256,
    commandLength: intent.commandLengthBytes,
    shell: intent.shell,
    now: Date.now(),
  }),
  settle: async (db, correlationId, outcome, result) => {
    const updated = await updateMachineExecAuditResult(db, correlationId, {
      outcome,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      now: Date.now(),
    });
    if (!updated) throw new Error('machine_exec_audit_result_not_updated');
  },
};

export const machineExecRoutes = createMachineExecRoutes(defaultDispatcher, machineExecAuditIntentStore);
