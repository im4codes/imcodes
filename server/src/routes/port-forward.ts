import { Hono } from 'hono';
import type { Database } from '../db/client.js';
import type { Env } from '../env.js';
import { resolveAuth } from '../security/authorization.js';
import { describeActionPayload, gateMachineAction } from '../security/machine-action-gate.js';
import { isSharedOrContributedServer, isWholeServerShareUser } from '../security/server-share-boundary.js';
import {
  listAccessibleControlledMachines,
  resolveMachineTargetServerId,
} from '../share/machine-access.js';
import { resolveMachineOperationalUser } from '../share/shared-machine-authority.js';
import { MACHINE_ACTION, MACHINE_DENIAL_REASON } from '../../../shared/machine-access-policy.js';
import { classifyMachineTarget } from '../../../shared/machine-reference.js';
import {
  PORT_FORWARD_ERRORS,
  PORT_FORWARD_LIMITS,
  isPortForwardSelfAlias,
  validatePortForwardNodeRef,
  validatePortForwardOpenRequest,
  type PortForwardErrorCode,
} from '../../../shared/port-forward.js';
import { MACHINE_LIST_MAX_ITEMS, NODE_ROLE } from '../../../shared/remote-exec.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../../shared/shared-machine-authority.js';
import { isUserStatusActive } from '../../../shared/user-status.js';
import { createTurnIceServerAuthority } from '../ws/turn-credentials.js';
import { defaultPortForwardRouter, type PortForwardRouter } from '../ws/port-forward-router.js';

interface ServerRow {
  id: string;
  user_id: string;
  node_role: string | null;
  node_id: string | null;
  revoked_at: number | null;
}

type EndpointResolveResult =
  | { ok: true; serverId: string; nodeId?: string; nodeRole: string }
  | { ok: false; status: 400 | 403 | 404 | 409 | 429; reason: PortForwardErrorCode; error: string };

async function resolveEndpointServer(
  db: Database,
  rawRef: string,
  auth: {
    userId: string;
    sourceServerId: string;
    signingKey: string;
    sharedMachineAuthorityHeader: string | undefined;
    operational: { userId: string; delegatedActorUserId?: string; authorityKind: 'absent' | 'owner' | 'participant' };
    now: number;
  },
  auditDescription: string,
): Promise<EndpointResolveResult> {
  const isSelf = isPortForwardSelfAlias(rawRef);
  let serverId: string | null = isSelf
    ? auth.sourceServerId
    : await resolveMachineTargetServerId(db, rawRef);

  if (!serverId && !isSelf) {
    // Support deprecated noncanonical ref_name aliases cleanly and fail closed on ambiguity.
    const classified = classifyMachineTarget(rawRef);
    if (classified?.kind === 'legacy_ref_name') {
      const actorId = auth.operational.delegatedActorUserId ?? auth.operational.userId;
      const accessible = await listAccessibleControlledMachines(db, actorId, auth.now, MACHINE_LIST_MAX_ITEMS + 1);
      const matches = accessible.filter((row) => row.ref_name === classified.value);
      if (matches.length > 1) {
        return {
          ok: false,
          status: 409,
          reason: PORT_FORWARD_ERRORS.NODE_AMBIGUOUS,
          error: `more than one machine matches "${rawRef}"`,
        };
      }
      if (matches.length === 1) {
        serverId = matches[0]!.id;
      }
    }
  }

  if (!serverId) {
    return {
      ok: false,
      status: 404,
      reason: PORT_FORWARD_ERRORS.NODE_NOT_FOUND,
      error: `node "${rawRef}" not found`,
    };
  }

  const row = await db.queryOne<ServerRow>(
    `SELECT id, user_id, node_role, node_id, revoked_at
       FROM servers
      WHERE id = $1
      LIMIT 1`,
    [serverId],
  );
  if (!row || row.revoked_at != null) {
    return {
      ok: false,
      status: 404,
      reason: PORT_FORWARD_ERRORS.NODE_NOT_FOUND,
      error: `node "${rawRef}" not found or revoked`,
    };
  }

  const nodeRole = row.node_role ?? NODE_ROLE.FULL;
  if (nodeRole === NODE_ROLE.CONTROLLED) {
    const gate = await gateMachineAction(db, {
      token: auth.sharedMachineAuthorityHeader,
      signingKey: auth.signingKey,
      authenticatedSourceServerId: auth.sourceServerId,
      sourceOwnerUserId: auth.userId,
      targetServerId: row.id,
      action: MACHINE_ACTION.EXEC,
      now: auth.now,
      payload: describeActionPayload(auditDescription),
    });
    if (!gate.ok) {
      const reason = gate.status === 429
        ? PORT_FORWARD_ERRORS.RATE_LIMITED
        : gate.reason === MACHINE_DENIAL_REASON.EXEC_DISABLED
          ? PORT_FORWARD_ERRORS.EXEC_DISABLED
          : PORT_FORWARD_ERRORS.TARGET_FORBIDDEN;
      return {
        ok: false,
        status: gate.status,
        reason,
        error: `access denied for controlled node "${rawRef}": ${gate.reason}`,
      };
    }
    return {
      ok: true,
      serverId: row.id,
      ...(row.node_id ? { nodeId: row.node_id } : {}),
      nodeRole,
    };
  }

  // FULL daemon endpoint: strictly owner-only; never allow a shared participant turn
  // or a shared/contributed host without owner authority to bridge a FULL daemon.
  if (auth.operational.authorityKind === 'participant' || auth.operational.delegatedActorUserId) {
    return {
      ok: false,
      status: 403,
      reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
      error: 'shared session participant cannot port-forward a FULL daemon',
    };
  }
  if (auth.operational.authorityKind === 'absent'
    && await isSharedOrContributedServer(db, auth.sourceServerId, auth.now)) {
    return {
      ok: false,
      status: 403,
      reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
      error: 'shared host requires per-turn owner authority',
    };
  }
  if (row.user_id !== auth.userId || await isWholeServerShareUser(db, row.id, auth.userId, auth.now)) {
    return {
      ok: false,
      status: 403,
      reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
      error: `access denied for node "${rawRef}"`,
    };
  }
  const ownerRow = await db.queryOne<{ status: string | null }>(
    'SELECT status FROM users WHERE id = $1 LIMIT 1',
    [row.user_id],
  );
  if (!isUserStatusActive(ownerRow?.status)) {
    return {
      ok: false,
      status: 403,
      reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
      error: 'node owner account is not active',
    };
  }

  return { ok: true, serverId: row.id, nodeRole };
}

export function createPortForwardRoutes(
  router: PortForwardRouter = defaultPortForwardRouter,
) {
  router.configure({
    getIceServers: (userId) => createTurnIceServerAuthority(userId).iceServers,
  });

  const routes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

  const authenticateCaller = async (c: Parameters<typeof resolveAuth>[0]) => {
    const auth = await resolveAuth(c);
    if (!auth) {
      return { ok: false as const, status: 401 as const, reason: PORT_FORWARD_ERRORS.SCOPED_AUTH, error: 'unauthorized' };
    }
    if (auth.nodeRole !== NODE_ROLE.FULL || !auth.serverId) {
      return {
        ok: false as const,
        status: 403 as const,
        reason: PORT_FORWARD_ERRORS.SCOPED_AUTH,
        error: 'FULL daemon credential is required',
      };
    }
    const now = Date.now();
    const sharedMachineAuthorityHeader = c.req.header(SHARED_MACHINE_AUTHORITY_HEADER);
    const operational = await resolveMachineOperationalUser(c.env.DB, {
      token: sharedMachineAuthorityHeader,
      signingKey: c.env.JWT_SIGNING_KEY,
      authenticatedSourceServerId: auth.serverId,
      sourceOwnerUserId: auth.userId,
      now,
    });
    if (!operational) {
      return {
        ok: false as const,
        status: 403 as const,
        reason: PORT_FORWARD_ERRORS.SCOPED_AUTH,
        error: 'invalid shared machine authority',
      };
    }
    return {
      ok: true as const,
      userId: auth.userId,
      sourceServerId: auth.serverId,
      signingKey: c.env.JWT_SIGNING_KEY,
      sharedMachineAuthorityHeader,
      operational,
      now,
    };
  };

  const requireOwnerSourceAuthority = async (
    db: Database,
    caller: {
      sourceServerId: string;
      operational: { delegatedActorUserId?: string; authorityKind: 'absent' | 'owner' | 'participant' };
      now: number;
    },
    actionLabel: string,
  ): Promise<{ ok: true } | { ok: false; status: 403; reason: PortForwardErrorCode; error: string }> => {
    if (caller.operational.authorityKind === 'participant' || caller.operational.delegatedActorUserId) {
      return {
        ok: false,
        status: 403,
        reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
        error: `shared session participant cannot ${actionLabel}`,
      };
    }
    if (caller.operational.authorityKind === 'absent'
      && await isSharedOrContributedServer(db, caller.sourceServerId, caller.now)) {
      return {
        ok: false,
        status: 403,
        reason: PORT_FORWARD_ERRORS.TARGET_FORBIDDEN,
        error: `shared host requires per-turn owner authority to ${actionLabel}`,
      };
    }
    return { ok: true };
  };

  routes.post('/', async (c) => {
    const caller = await authenticateCaller(c);
    if (!caller.ok) return c.json({ ok: false, reason: caller.reason, error: caller.error }, caller.status);
    const sourceAuth = await requireOwnerSourceAuthority(c.env.DB, caller, 'open tunnels');
    if (!sourceAuth.ok) {
      return c.json({ ok: false, reason: sourceAuth.reason, error: sourceAuth.error }, sourceAuth.status);
    }

    const rawBody = await c.req.text().catch(() => '');
    if (Buffer.byteLength(rawBody, 'utf8') > PORT_FORWARD_LIMITS.MAX_CONTROL_BYTES) {
      return c.json({ ok: false, reason: PORT_FORWARD_ERRORS.INVALID_REQUEST, error: 'request body too large' }, 413);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return c.json({ ok: false, reason: PORT_FORWARD_ERRORS.INVALID_REQUEST, error: 'invalid JSON body' }, 400);
    }
    const validated = validatePortForwardOpenRequest(parsedJson);
    if (!validated.ok) {
      return c.json({ ok: false, reason: PORT_FORWARD_ERRORS.INVALID_REQUEST, error: validated.error }, 400);
    }
    const req = validated.value;
    const auditDesc = `port_forward:${req.listenNode}:${req.listenPort}->${req.targetNode}:${req.targetHost}:${req.targetPort}`;

    const [listenResolved, targetResolved] = await Promise.all([
      resolveEndpointServer(c.env.DB, req.listenNode, caller, auditDesc),
      resolveEndpointServer(c.env.DB, req.targetNode, caller, auditDesc),
    ]);
    if (!listenResolved.ok) {
      return c.json({ ok: false, reason: listenResolved.reason, error: listenResolved.error }, listenResolved.status);
    }
    if (!targetResolved.ok) {
      return c.json({ ok: false, reason: targetResolved.reason, error: targetResolved.error }, targetResolved.status);
    }
    if (listenResolved.serverId === targetResolved.serverId) {
      return c.json({
        ok: false,
        reason: PORT_FORWARD_ERRORS.INVALID_REQUEST,
        error: 'listenNode and targetNode must be different nodes',
      }, 400);
    }

    const result = await router.openTunnel({
      userId: caller.userId,
      listenNode: listenResolved.nodeId ?? req.listenNode,
      listenServerId: listenResolved.serverId,
      ...(listenResolved.nodeId ? { listenNodeId: listenResolved.nodeId } : {}),
      listenPort: req.listenPort,
      targetNode: targetResolved.nodeId ?? req.targetNode,
      targetServerId: targetResolved.serverId,
      ...(targetResolved.nodeId ? { targetNodeId: targetResolved.nodeId } : {}),
      targetHost: req.targetHost,
      targetPort: req.targetPort,
      ttlSeconds: req.ttlSeconds,
      transport: req.transport,
      ...(req.label ? { label: req.label } : {}),
    });

    if (!result.ok) {
      return c.json(
        { ok: false, reason: result.reason, error: result.error },
        result.status as 400 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504,
      );
    }
    return c.json({ ok: true, tunnel: result.tunnel });
  });

  routes.get('/', async (c) => {
    const caller = await authenticateCaller(c);
    if (!caller.ok) return c.json({ ok: false, reason: caller.reason, error: caller.error }, caller.status);
    const sourceAuth = await requireOwnerSourceAuthority(c.env.DB, caller, 'list tunnels');
    if (!sourceAuth.ok) {
      return c.json({ ok: false, reason: sourceAuth.reason, error: sourceAuth.error }, sourceAuth.status);
    }
    const rawNode = c.req.query('node');
    let filterServerId: string | undefined;
    if (rawNode) {
      const ref = validatePortForwardNodeRef(rawNode);
      if (!ref) {
        return c.json({ ok: false, reason: PORT_FORWARD_ERRORS.INVALID_REQUEST, error: 'invalid node filter' }, 400);
      }
      if (isPortForwardSelfAlias(ref)) {
        filterServerId = caller.sourceServerId;
      } else {
        filterServerId = (await resolveMachineTargetServerId(c.env.DB, ref)) ?? ref;
      }
    }
    const tunnels = await router.listTunnels(caller.userId, filterServerId);
    return c.json({ ok: true, tunnels });
  });

  routes.delete('/:tunnelId', async (c) => {
    const caller = await authenticateCaller(c);
    if (!caller.ok) return c.json({ ok: false, reason: caller.reason, error: caller.error }, caller.status);
    const sourceAuth = await requireOwnerSourceAuthority(c.env.DB, caller, 'close tunnels');
    if (!sourceAuth.ok) {
      return c.json({ ok: false, reason: sourceAuth.reason, error: sourceAuth.error }, sourceAuth.status);
    }
    const tunnelId = c.req.param('tunnelId');
    if (!tunnelId) {
      return c.json({ ok: false, reason: PORT_FORWARD_ERRORS.INVALID_REQUEST, error: 'tunnelId is required' }, 400);
    }
    const res = await router.closeTunnelForUser(caller.userId, tunnelId);
    if (!res.ok) {
      return c.json({ ok: false, reason: res.reason, error: res.error }, res.status as 403 | 404);
    }
    return c.json({ ok: true, closedCount: res.closedTunnelIds.length, closedTunnelIds: res.closedTunnelIds });
  });

  routes.delete('/', async (c) => {
    const caller = await authenticateCaller(c);
    if (!caller.ok) return c.json({ ok: false, reason: caller.reason, error: caller.error }, caller.status);
    const sourceAuth = await requireOwnerSourceAuthority(c.env.DB, caller, 'close tunnels');
    if (!sourceAuth.ok) {
      return c.json({ ok: false, reason: sourceAuth.reason, error: sourceAuth.error }, sourceAuth.status);
    }
    const rawNode = c.req.query('node');
    let filterServerId: string | undefined;
    if (rawNode) {
      const ref = validatePortForwardNodeRef(rawNode);
      if (!ref) {
        return c.json({ ok: false, reason: PORT_FORWARD_ERRORS.INVALID_REQUEST, error: 'invalid node filter' }, 400);
      }
      filterServerId = isPortForwardSelfAlias(ref)
        ? caller.sourceServerId
        : ((await resolveMachineTargetServerId(c.env.DB, ref)) ?? ref);
    }
    const closedTunnelIds = await router.closeAllForUser(caller.userId, filterServerId);
    return c.json({ ok: true, closedCount: closedTunnelIds.length, closedTunnelIds });
  });

  return routes;
}

export const portForwardRoutes = createPortForwardRoutes(defaultPortForwardRouter);
