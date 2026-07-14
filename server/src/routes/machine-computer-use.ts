import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import type { Env } from '../env.js';
import { resolveAuth } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { registerPendingComputerUse, cancelPendingComputerUse } from '../ws/computer-use-registry.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import {
  COMPUTER_USE_DEFAULT_TIMEOUT_MS,
  COMPUTER_USE_HTTP_REASON,
  COMPUTER_USE_MAX_TIMEOUT_MS,
  encodeComputerUseHttpEnvelope,
  validateComputerUseFrame,
  validateComputerUseResultFrame,
  type ComputerUseFrame,
  type ComputerUseHttpEnvelope,
  type ComputerUseOutcome,
  type ComputerUseResult,
} from '../../../shared/computer-use.js';
import { DAEMON_MSG } from '../../../shared/daemon-events.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';

const DEFAULT_RELAY_DEADLINE_BUFFER_MS = 30_000;
const ALLOWED_BODY_KEYS = new Set(['tool', 'arguments', 'timeoutMs']);

export type ComputerUseDispatcher = (
  targetServerId: string,
  frame: ComputerUseFrame,
  deadlineMs: number,
) => Promise<{ online: boolean; result?: ComputerUseResult }>;

const defaultDispatcher: ComputerUseDispatcher = async (targetServerId, frame, deadlineMs) => {
  const bridge = WsBridge.get(targetServerId);
  if (!bridge.isDaemonConnected()) return { online: false };
  const generation = bridge.daemonConnectionGeneration();
  const pending = registerPendingComputerUse(targetServerId, frame.correlationId, generation, deadlineMs);
  const sent = bridge.trySendComputerUse(JSON.stringify(frame), generation);
  if (sent !== 'sent') {
    cancelPendingComputerUse(frame.correlationId);
    return { online: false };
  }
  const result = await pending;
  return { online: true, ...(result ? { result } : {}) };
};

function pre(reason: NonNullable<ComputerUseHttpEnvelope['reason']>) {
  return encodeComputerUseHttpEnvelope('not_dispatched', undefined, reason);
}

function outcomeFor(dispatch: { online: boolean; result?: ComputerUseResult }): ComputerUseOutcome {
  if (!dispatch.online) return 'not_dispatched';
  if (!dispatch.result) return 'dispatched_no_result';
  return dispatch.result.ok ? 'completed' : 'tool_error';
}

export function createMachineComputerUseRoutes(dispatcher: ComputerUseDispatcher = defaultDispatcher) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/', async (c) => {
    const auth = await resolveAuth(c);
    if (!auth) return c.json(pre(COMPUTER_USE_HTTP_REASON.SCOPED_AUTH), 401);
    const sourceServerId = auth.serverId;
    if (auth.nodeRole !== NODE_ROLE.FULL || !sourceServerId) return c.json(pre(COMPUTER_USE_HTTP_REASON.SCOPED_AUTH), 403);

    const targetId = c.req.query('serverId');
    if (!targetId) return c.json(pre(COMPUTER_USE_HTTP_REASON.INVALID_REQUEST), 400);
    if (targetId === sourceServerId) return c.json(pre(COMPUTER_USE_HTTP_REASON.SCOPED_AUTH), 403);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body) {
      for (const key of Object.keys(body)) {
        if (!ALLOWED_BODY_KEYS.has(key)) return c.json(pre(COMPUTER_USE_HTTP_REASON.INVALID_REQUEST), 400);
      }
    }

    const correlationId = randomBytes(16).toString('hex');
    const v = validateComputerUseFrame({ type: DAEMON_COMMAND_TYPES.COMPUTER_USE, ...(body ?? {}), correlationId });
    if (!v.ok) return c.json(pre(COMPUTER_USE_HTTP_REASON.INVALID_REQUEST), 400);

    const target = await c.env.DB.queryOne<{ user_id: string; node_role: string; exec_enabled: boolean; revoked_at: number | null }>(
      'SELECT user_id, node_role, exec_enabled, revoked_at FROM servers WHERE id = $1',
      [targetId],
    );
    if (!target || target.user_id !== auth.userId) return c.json(pre(COMPUTER_USE_HTTP_REASON.TARGET_FORBIDDEN), 403);
    if (target.node_role !== NODE_ROLE.CONTROLLED) return c.json(pre(COMPUTER_USE_HTTP_REASON.TARGET_FORBIDDEN), 403);
    if (target.revoked_at != null) return c.json(pre(COMPUTER_USE_HTTP_REASON.TARGET_FORBIDDEN), 403);
    if (!target.exec_enabled) return c.json(pre(COMPUTER_USE_HTTP_REASON.EXEC_DISABLED), 403);

    const nodeTimeout = Math.min(v.value.timeoutMs ?? COMPUTER_USE_DEFAULT_TIMEOUT_MS, COMPUTER_USE_MAX_TIMEOUT_MS);
    let dispatch: { online: boolean; result?: ComputerUseResult };
    try {
      dispatch = await dispatcher(targetId, v.value, nodeTimeout + DEFAULT_RELAY_DEADLINE_BUFFER_MS);
    } catch {
      return c.json(encodeComputerUseHttpEnvelope('dispatched_no_result', undefined, COMPUTER_USE_HTTP_REASON.INVALID_RESULT));
    }

    if (dispatch.result) {
      const normalized = validateComputerUseResultFrame({ type: DAEMON_MSG.COMPUTER_USE_RESULT, ...dispatch.result });
      if (!normalized.ok) return c.json(encodeComputerUseHttpEnvelope('dispatched_no_result', undefined, COMPUTER_USE_HTTP_REASON.INVALID_RESULT));
    }
    return c.json(encodeComputerUseHttpEnvelope(outcomeFor(dispatch), dispatch.result));
  });

  return routes;
}

export const machineComputerUseRoutes = createMachineComputerUseRoutes();
