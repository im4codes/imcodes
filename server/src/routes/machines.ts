import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { requireAuth } from '../security/authorization.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import { abandonAllForTarget } from '../ws/machine-exec-registry.js';
import {
  NODE_ROLE,
  MACHINE_LIST_MAX_ITEMS,
  MACHINE_PRESENCE_STALENESS_MS,
  canonicalMachineOs,
  type MachineSummary,
} from '../../../shared/remote-exec.js';
import {
  MACHINE_REASONS,
  normalizeMachineDisplayName,
} from '../../../shared/machine-reference.js';

export const machinesRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

interface ControlledRow {
  id: string;
  ref_name: string | null;
  display_name: string | null;
  status: string | null;
  last_heartbeat_at: number | null;
  exec_enabled: boolean;
  os: string | null;
}

/**
 * Shared owner-scoped controlled-machine query + DTO mapping (F1: presence is
 * read from the DB `status`/`last_heartbeat_at`, NOT per-pod WsBridge). Both the
 * MCP `list_machines` tool and this HTTP route use this — they do not call each other.
 */
export async function listControlledMachines(
  db: Database,
  userId: string,
  nowMs: number,
): Promise<{ machines: (MachineSummary & { refName: string; displayName: string; execEnabled: boolean })[]; overLimit: boolean }> {
  const rows = await db.query<ControlledRow>(
    `SELECT id, ref_name, display_name, status, last_heartbeat_at, exec_enabled,
            os
       FROM servers
      WHERE user_id = $1 AND node_role = $2 AND revoked_at IS NULL
      ORDER BY display_name NULLS LAST, id
      LIMIT $3`,
    [userId, NODE_ROLE.CONTROLLED, MACHINE_LIST_MAX_ITEMS + 1],
  );
  const overLimit = rows.length > MACHINE_LIST_MAX_ITEMS;
  const machines = rows.slice(0, MACHINE_LIST_MAX_ITEMS).map((r) => {
    const online = r.status === 'online'
      && typeof r.last_heartbeat_at === 'number'
      && nowMs - r.last_heartbeat_at < MACHINE_PRESENCE_STALENESS_MS;
    return {
      serverId: r.id,
      name: r.display_name ?? r.ref_name ?? r.id,
      refName: r.ref_name ?? r.id,
      displayName: r.display_name ?? r.ref_name ?? r.id,
      online,
      nodeRole: NODE_ROLE.CONTROLLED,
      execEnabled: r.exec_enabled === true,
      ...(canonicalMachineOs(r.os) ? { os: canonicalMachineOs(r.os) } : {}),
      ...(typeof r.last_heartbeat_at === 'number' ? { lastSeenMs: r.last_heartbeat_at } : {}),
    };
  });
  return { machines, overLimit };
}

// GET /api/machines — owner-scoped controlled machine list with DB-backed presence.
machinesRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const { machines, overLimit } = await listControlledMachines(c.env.DB, userId, Date.now());
  if (overLimit) {
    return c.json({ error: 'machine_list_over_limit', maxItems: MACHINE_LIST_MAX_ITEMS }, 413);
  }
  return c.json({ machines });
});

// POST /api/machines/:serverId/display-name — owner-controlled render name.
// `ref_name` remains immutable so existing ^^(refName) markers stay valid.
machinesRoutes.post('/:serverId/display-name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ displayName: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const displayName = normalizeMachineDisplayName(parsed.data.displayName);
  if (!displayName) return c.json({ error: MACHINE_REASONS.INVALID_DISPLAY_NAME }, 400);

  const row = await c.env.DB.queryOne<{ previous_name: string | null }>(
    `UPDATE servers SET display_name = $3
       FROM (SELECT display_name AS previous_name FROM servers WHERE id = $1) prev
      WHERE servers.id = $1 AND servers.user_id = $2 AND servers.node_role = $4 AND servers.revoked_at IS NULL
      RETURNING prev.previous_name`,
    [serverId, userId, displayName, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.rename',
    ip,
    details: { serverId, from: row.previous_name, to: displayName },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, displayName });
});

// POST /api/machines/:serverId/revoke — owner kill-switch (10.3).
machinesRoutes.post('/:serverId/revoke', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const now = Date.now();
  const row = await c.env.DB.queryOne<{ id: string }>(
    `UPDATE servers SET revoked_at = $3
      WHERE id = $1 AND user_id = $2 AND node_role = $4 AND revoked_at IS NULL
      RETURNING id`,
    [serverId, userId, now, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  // Drop the live connection immediately (the `:serverId` path is ingress
  // pod-sticky, so this request lands on the pod holding the WS). A reconnect is
  // rejected by the revoked_at check in WebSocket auth. Any in-flight exec is
  // abandoned to `null` → the source sees an indeterminate outcome (the command
  // may already have run on the node), never a fabricated success/failure.
  try {
    WsBridge.get(serverId).kickDaemon();
    abandonAllForTarget(serverId);
  } catch { /* offline / other pod */ }
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({ userId, action: 'machine.revoke', ip, details: { serverId } }, c.env.DB).catch(() => {});
  return c.json({ ok: true });
});

// POST /api/machines/:serverId/exec-enabled — owner toggles D-E exec gate.
machinesRoutes.post('/:serverId/exec-enabled', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  // Capture the prior value so the audit records from → to (enabling exec is a
  // high-privilege action that gates SYSTEM/root RCE and MUST be attributable).
  const row = await c.env.DB.queryOne<{ was: boolean }>(
    `UPDATE servers SET exec_enabled = $3
       FROM (SELECT exec_enabled AS was FROM servers WHERE id = $1) prev
      WHERE servers.id = $1 AND servers.user_id = $2 AND servers.node_role = $4 AND servers.revoked_at IS NULL
      RETURNING prev.was`,
    [serverId, userId, parsed.data.enabled, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.exec_enabled',
    ip,
    details: { serverId, from: row.was === true, to: parsed.data.enabled },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, execEnabled: parsed.data.enabled });
});
