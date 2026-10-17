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
  computerUseMaxTimeoutMs,
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
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../../shared/shared-machine-authority.js';
import { admitMachineAction } from '../share/shared-machine-authority.js';
import { describeActionPayload, gateMachineAction } from '../security/machine-action-gate.js';
import { recordMachineActionAuthorized } from '../security/machine-exec-audit.js';
import {
  MACHINE_ACTION_RATE_LIMIT,
  MACHINE_DENIAL_REASON,
  machineActionForComputerUseTool,
  machineActionRequiresExecute,
} from '../../../shared/machine-access-policy.js';
import logger from '../util/logger.js';

const DEFAULT_RELAY_DEADLINE_BUFFER_MS = 30_000;
const ALLOWED_BODY_KEYS = new Set(['tool', 'arguments', 'timeoutMs', 'resourceOwner']);

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

export function computerUseRelayDeadlineMs(frame: Pick<ComputerUseFrame, 'tool' | 'timeoutMs'>): number {
  const nodeTimeout = Math.min(
    frame.timeoutMs ?? COMPUTER_USE_DEFAULT_TIMEOUT_MS,
    computerUseMaxTimeoutMs(frame.tool),
  );
  return nodeTimeout + DEFAULT_RELAY_DEADLINE_BUFFER_MS;
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

    const now = Date.now();
    // The verb decides: reading the screen is VIEW; a shell, a click, a keystroke, a navigation is EXECUTE-class
    // (shared/machine-access-policy.ts). What is typed or run is never logged: a hash and a length.
    const action = machineActionForComputerUseTool(v.value.tool);
    const admissionInput = {
      token: c.req.header(SHARED_MACHINE_AUTHORITY_HEADER),
      signingKey: c.env.JWT_SIGNING_KEY,
      authenticatedSourceServerId: sourceServerId,
      sourceOwnerUserId: auth.userId,
      targetServerId: targetId,
      action,
      now,
    };
    const gate = await gateMachineAction(c.env.DB, {
      ...admissionInput,
      payload: describeActionPayload(JSON.stringify({ tool: v.value.tool, arguments: v.value.arguments ?? null })),
    });
    if (!gate.ok) {
      if (gate.status === 429) c.header('Retry-After', String(MACHINE_ACTION_RATE_LIMIT.WINDOW_MS / 1000));
      return c.json(
        pre(gate.wireReason === 'exec_disabled' ? COMPUTER_USE_HTTP_REASON.EXEC_DISABLED
          : gate.wireReason === 'target_unavailable' ? COMPUTER_USE_HTTP_REASON.TARGET_UNAVAILABLE
            : COMPUTER_USE_HTTP_REASON.TARGET_FORBIDDEN),
        gate.status,
      );
    }
    const operational = gate.admission;
    if (machineActionRequiresExecute(action)) {
      // Recorded BEFORE it runs and fail closed, like exec: an action that cannot be audited does not run.
      try {
        await recordMachineActionAuthorized(c.env.DB, {
          correlationId,
          userId: auth.userId,
          sourceServerId,
          targetServerId: targetId,
          ...describeActionPayload(JSON.stringify({ tool: v.value.tool, arguments: v.value.arguments ?? null })),
          shell: action,
          now,
          action,
          ...(operational.delegatedActorUserId ? { delegatedActorUserId: operational.delegatedActorUserId } : {}),
          accessSource: operational.target.access_source,
        });
      } catch (err) {
        logger.error({ serverId: targetId, err }, 'Refusing computer use — durable audit could not be persisted');
        return c.json(pre(COMPUTER_USE_HTTP_REASON.TARGET_UNAVAILABLE), 503);
      }
      // Kill switch: access is read again immediately before the dispatch.
      const recheck = await admitMachineAction(c.env.DB, { ...admissionInput, now: Date.now() });
      if (!recheck.ok) {
        return c.json(pre(recheck.reason === MACHINE_DENIAL_REASON.EXEC_DISABLED
          ? COMPUTER_USE_HTTP_REASON.EXEC_DISABLED : COMPUTER_USE_HTTP_REASON.TARGET_FORBIDDEN), 403);
      }
    }

    let dispatch: { online: boolean; result?: ComputerUseResult };
    try {
      dispatch = await dispatcher(targetId, v.value, computerUseRelayDeadlineMs(v.value));
    } catch {
      return c.json(encodeComputerUseHttpEnvelope('dispatched_no_result', undefined, COMPUTER_USE_HTTP_REASON.INVALID_RESULT));
    }

    if (dispatch.result) {
      const normalized = validateComputerUseResultFrame({ type: DAEMON_MSG.COMPUTER_USE_RESULT, ...dispatch.result });
      if (!normalized.ok) return c.json(encodeComputerUseHttpEnvelope('dispatched_no_result', undefined, COMPUTER_USE_HTTP_REASON.INVALID_RESULT));
    }
    const outcome = outcomeFor(dispatch);
    return c.json(encodeComputerUseHttpEnvelope(
      outcome,
      dispatch.result,
      outcome === 'not_dispatched' ? COMPUTER_USE_HTTP_REASON.TARGET_UNAVAILABLE : undefined,
    ));
  });

  return routes;
}

export const machineComputerUseRoutes = createMachineComputerUseRoutes();
