import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { requireAuth } from '../security/authorization.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import { NODE_ROLE, MACHINE_PRESENCE_STALENESS_MS, type MachineSummary } from '../../../shared/remote-exec.js';

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
): Promise<(MachineSummary & { refName: string; displayName: string; execEnabled: boolean })[]> {
  const rows = await db.query<ControlledRow>(
    `SELECT id, ref_name, display_name, status, last_heartbeat_at, exec_enabled,
            NULL::text AS os
       FROM servers
      WHERE user_id = $1 AND node_role = $2 AND revoked_at IS NULL
      ORDER BY display_name NULLS LAST`,
    [userId, NODE_ROLE.CONTROLLED],
  );
  return rows.map((r) => {
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
      ...(typeof r.last_heartbeat_at === 'number' ? { lastSeenMs: r.last_heartbeat_at } : {}),
    };
  });
}

// GET /api/machines — owner-scoped controlled machine list with DB-backed presence.
machinesRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const machines = await listControlledMachines(c.env.DB, userId, Date.now());
  return c.json({ machines });
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
  // Best-effort: drop the live connection immediately if it is on this pod.
  try { WsBridge.get(serverId).sendToDaemon(JSON.stringify({ type: 'server.revoked' })); } catch { /* offline / other pod */ }
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
  const row = await c.env.DB.queryOne<{ id: string }>(
    `UPDATE servers SET exec_enabled = $3
      WHERE id = $1 AND user_id = $2 AND node_role = $4 AND revoked_at IS NULL
      RETURNING id`,
    [serverId, userId, parsed.data.enabled, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, execEnabled: parsed.data.enabled });
});
