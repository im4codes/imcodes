/**
 * Cross-server projection source resolution.
 *
 * Two routes, both reading `serverId` from the query string per the project's
 * pod-sticky convention (the ingress routes `?serverId=` requests to the pod
 * holding that daemon's WebSocket). See
 * openspec/changes/memory-source-server-routing.
 *
 * - `GET /api/memory/projection-owner?projectionId=...` — cloud-only lookup
 *   returning `{ originServerId }` for the projection row in
 *   `shared_context_projections` if it belongs to the authenticated user.
 *   404s otherwise so cross-user probing returns "missing", not "forbidden".
 *
 * - `GET /api/memory/sources?serverId=...&projectionId=...` — pod-sticky.
 *   Validates the caller owns `serverId`, opens a WsBridge for that server,
 *   forwards `memory.get_sources_request` to the daemon, awaits the keyed
 *   reply, and returns it. Mirrors the file-transfer / Watch API patterns.
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import type { Env } from '../env.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { WsBridge } from '../ws/bridge.js';
import { FS_GENERIC_ERROR_CODES } from '../../../shared/fs-error-codes.js';
import logger from '../util/logger.js';

export const memoryRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const SOURCES_REQUEST_TIMEOUT_MS = 8_000;

// ── projection-owner resolver ───────────────────────────────────────────
//
// Cheap lookup. Caller passes `projectionId`; we return the originating
// `server_id` for the row scoped to the authenticated user. Used by the
// daemon orchestrator when its in-process cache misses (e.g. cold start or
// projection arrived through a non-MCP code path).

memoryRoutes.get('/memory/projection-owner', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const projectionId = c.req.query('projectionId')?.trim();
  if (!projectionId) {
    return c.json({ error: 'projection_id_required' }, 400);
  }

  // Single row lookup gated on user ownership. 404 vs 200-with-empty is
  // intentional — see the spec scenario "caller cannot probe foreign
  // projections": leaking existence creates an oracle for cross-user enum.
  const row = await c.env.DB.queryOne<{ server_id: string }>(
    `SELECT server_id
       FROM shared_context_projections
      WHERE id = $1
        AND ((scope = 'personal' AND user_id = $2)
             OR EXISTS (
               SELECT 1
                 FROM team_members tm
                WHERE tm.team_id = shared_context_projections.enterprise_id
                  AND tm.user_id = $2
             ))
      LIMIT 1`,
    [projectionId, userId],
  );

  if (!row?.server_id) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ originServerId: row.server_id });
});

// ── pod-sticky memory/sources proxy ─────────────────────────────────────
//
// Caller passes `serverId` (read by the ingress for pod routing) and
// `projectionId`. The route validates that the authenticated user owns
// `serverId`, then forwards the request to the daemon over its WS and
// awaits the keyed reply.

memoryRoutes.get('/memory/sources', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  const projectionId = c.req.query('projectionId')?.trim();

  if (!serverId) return c.json({ error: 'server_id_required' }, 400);
  if (!projectionId) return c.json({ error: 'projection_id_required' }, 400);

  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);

  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    // Match the daemon-offline contract the file-transfer / Watch API
    // routes return so the MCP error mapping on the caller side stays
    // uniform.
    return c.json({ error: 'daemon_offline' }, 409);
  }

  const requestId = `mem-src-${randomUUID()}`;
  try {
    const reply = await bridge.sendMemorySourcesRequest(requestId, projectionId, SOURCES_REQUEST_TIMEOUT_MS);
    // Strip our internal correlation field before returning. The reply
    // already carries `status` / `projectionId` / `sourceEventCount` /
    // `sources` / `partial` / `originServerId` from the daemon handler.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requestId: _r, type: _t, ...payload } = reply as Record<string, unknown>;
    // Stamp serverId on the reply when daemon didn't include it. The
    // route's serverId IS the canonical origin (pod-sticky-routed here).
    if (!('originServerId' in payload)) {
      (payload as Record<string, unknown>).originServerId = serverId;
    }
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'timeout') {
      // Treat timeout the same as daemon offline so the MCP caller can
      // surface a recoverable error and try again later.
      logger.warn({ serverId, projectionId }, 'memory.get_sources timed out');
      return c.json({ error: 'daemon_offline' }, 409);
    }
    if (message === 'daemon_offline' || message === 'daemon_disconnected' || message === 'daemon_error') {
      return c.json({ error: 'daemon_offline' }, 409);
    }
    logger.warn({ serverId, projectionId, err: message }, 'memory.get_sources failed');
    return c.json({ error: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR, message }, 500);
  }
});
