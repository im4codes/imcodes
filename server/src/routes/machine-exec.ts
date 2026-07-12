import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import { registerPendingExec } from '../ws/machine-exec-registry.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import {
  NODE_ROLE,
  validateMachineExecFrame,
  REMOTE_EXEC_DEFAULT_TIMEOUT_MS,
  REMOTE_EXEC_MAX_TIMEOUT_MS,
  type MachineExecFrame,
  type RemoteExecOutcome,
  type RemoteExecResult,
} from '../../../shared/remote-exec.js';

/** Extra time the relay waits beyond the node's own timeout before giving up (F: deadline ≥ node timeout). */
const RELAY_DEADLINE_BUFFER_MS = 30_000;

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

/** Default dispatcher: live WsBridge push + per-pod pending-RPC (bound to connection generation). */
const defaultDispatcher: ExecDispatcher = async (targetServerId, frame, deadlineMs) => {
  const bridge = WsBridge.get(targetServerId);
  if (!bridge.isDaemonConnected()) return { online: false };
  const generation = bridge.daemonConnectionGeneration();
  bridge.sendToDaemon(JSON.stringify({ type: DAEMON_COMMAND_TYPES.MACHINE_EXEC, ...frame }));
  const result = await registerPendingExec(targetServerId, frame.correlationId, generation, deadlineMs);
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

/**
 * `POST /api/machine/exec?serverId=<target>` — the source (a FULL daemon) runs a
 * one-shot command on a CONTROLLED target it owns. `?serverId=` is the target /
 * pod-routing key; `X-Server-Id`+Bearer (enforced by requireAuth) is the source.
 */
export function createMachineExecRoutes(dispatcher: ExecDispatcher = defaultDispatcher) {
  const routes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

  // requireAuth already default-denies a `controlled` source (10.2) → 403.
  routes.post('/', requireAuth(), async (c) => {
    const userId = c.get('userId' as never) as string;
    const sourceServerId = c.get('authServerId' as never) as string | undefined;
    if (!sourceServerId) return c.json({ error: 'source_must_be_daemon' }, 401);

    const targetId = c.req.query('serverId');
    if (!targetId) return c.json({ error: 'missing_target' }, 400);
    if (targetId === sourceServerId) return c.json({ error: 'forbidden', reason: 'source_equals_target' }, 403);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const correlationId = randomBytes(16).toString('hex');
    const idempotencyKey = typeof body?.idempotencyKey === 'string' && body.idempotencyKey ? body.idempotencyKey : correlationId;
    const v = validateMachineExecFrame({ ...(body ?? {}), correlationId, idempotencyKey });
    if (!v.ok) return c.json({ error: 'invalid_exec', reason: v.error }, 400);

    const target = await c.env.DB.queryOne<{ user_id: string; node_role: string; exec_enabled: boolean; revoked_at: number | null }>(
      'SELECT user_id, node_role, exec_enabled, revoked_at FROM servers WHERE id = $1',
      [targetId],
    );
    // Return 403 (not 404) for cross-account to avoid existence enumeration.
    if (!target || target.user_id !== userId) return c.json({ error: 'forbidden', reason: 'target_not_owned' }, 403);
    if (target.node_role !== NODE_ROLE.CONTROLLED) return c.json({ error: 'forbidden', reason: 'target_not_controlled' }, 403);
    if (target.revoked_at != null) return c.json({ error: 'forbidden', reason: 'target_revoked' }, 403);
    if (!target.exec_enabled) return c.json({ error: 'forbidden', reason: 'exec_disabled' }, 403);

    const nodeTimeout = Math.min(v.value.timeoutMs ?? REMOTE_EXEC_DEFAULT_TIMEOUT_MS, REMOTE_EXEC_MAX_TIMEOUT_MS);
    const dispatch = await dispatcher(targetId, v.value, nodeTimeout + RELAY_DEADLINE_BUFFER_MS);
    const outcome = outcomeFor(dispatch);
    const result = dispatch.result;

    const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
    logAudit({
      userId,
      action: 'machine.exec',
      ip,
      details: {
        sourceServerId, targetServerId: targetId, shell: v.value.shell ?? 'default',
        commandSha256: sha256Hex(v.value.command), commandLength: v.value.command.length,
        correlationId, outcome, exitCode: result?.exitCode ?? null,
        timedOut: result?.timedOut ?? false, durationMs: result?.durationMs ?? 0,
      },
    }, c.env.DB).catch(() => {});

    return c.json({
      outcome,
      ...(result
        ? {
            ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
            timedOut: result.timedOut ?? false, truncated: result.truncated ?? false, durationMs: result.durationMs,
            ...(result.error ? { error: result.error } : {}),
          }
        : {}),
    });
  });

  return routes;
}

export const machineExecRoutes = createMachineExecRoutes();
