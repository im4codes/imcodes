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
import { requireAuth } from '../security/authorization.js';
import { resolveServerMemberAccessOrShareDeny } from './share-http-auth.js';
import { WsBridge } from '../ws/bridge.js';
import { FS_GENERIC_ERROR_CODES } from '../../../shared/fs-error-codes.js';
import { buildMemoryProjectionFallbackSource } from '../../../shared/memory-projection-source-fallback.js';
import { cleanMemoryProjectId } from '../../../shared/memory-project-scope.js';
import logger from '../util/logger.js';

export const memoryRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const SOURCES_REQUEST_TIMEOUT_MS = 8_000;

type MemorySourcesPayload = Record<string, unknown> & {
  status?: string;
  projectionId?: string;
  sourceEventCount?: number;
  sources?: Array<Record<string, unknown>>;
  projectionSource?: Record<string, unknown>;
  partial?: boolean;
  originServerId?: string;
};

interface SharedProjectionSourceFallbackRow {
  id: string;
  server_id: string;
  source_event_ids_json: unknown;
  summary: string | null;
  content_json: unknown;
  origin?: string | null;
  created_at?: number | string | null;
}

async function loadAuthorizedProjectionSourceRow(
  db: Env['DB'],
  input: { projectionId: string; userId: string; originServerId?: string; projectId: string },
): Promise<SharedProjectionSourceFallbackRow | undefined> {
  const params: unknown[] = [input.projectionId, input.userId];
  let serverClause = '';
  if (input.originServerId) {
    params.push(input.originServerId);
    serverClause = `AND server_id = $${params.length}`;
  }
  params.push(input.projectId);
  const projectClause = `AND project_id = $${params.length}`;
  const row = await db.queryOne<SharedProjectionSourceFallbackRow>(
    `SELECT id, server_id, source_event_ids_json, summary, content_json, origin, created_at
       FROM shared_context_projections
      WHERE id = $1
        ${serverClause}
        ${projectClause}
        AND ((scope = 'personal' AND user_id = $2)
             OR (scope <> 'personal' AND EXISTS (
               SELECT 1
                 FROM team_members tm
                WHERE tm.team_id = shared_context_projections.enterprise_id
                  AND tm.user_id = $2
             )))
      LIMIT 1`,
    params,
  );
  return row?.id ? row : undefined;
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseSourceEventIds(value: unknown): string[] {
  const parsed = parseJsonish(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function hasUsableSource(payload: MemorySourcesPayload): boolean {
  return Array.isArray(payload.sources)
    && payload.sources.some((source) => typeof source.content === 'string' && source.content.trim().length > 0);
}

function canUseProjectionFallback(payload: MemorySourcesPayload): boolean {
  if (!Array.isArray(payload.sources) || payload.sources.length === 0) return true;
  return payload.sources.every((source) => source.content == null && source.status === 'missing');
}

function buildProjectionFallbackPayload(
  projectionId: string,
  row: SharedProjectionSourceFallbackRow,
  originServerId: string,
): MemorySourcesPayload | undefined {
  const sourceEventIds = parseSourceEventIds(row.source_event_ids_json);
  const content = parseJsonish(row.content_json);
  const createdAt = typeof row.created_at === 'number'
    ? row.created_at
    : typeof row.created_at === 'string'
      ? Number(row.created_at)
      : undefined;
  const fallback = buildMemoryProjectionFallbackSource({
    id: row.id,
    sourceEventIds,
    summary: row.summary ?? '',
    content,
    origin: row.origin,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : undefined,
  });
  if (!fallback) return undefined;
  return {
    status: 'ok',
    projectionId,
    sourceEventCount: Math.max(sourceEventIds.length, 1),
    sources: [fallback],
    projectionSource: fallback,
    partial: false,
    originServerId: row.server_id || originServerId,
  };
}

async function withProjectionFallback(
  input: { payload: MemorySourcesPayload; projectionId: string; originServerId: string; row: SharedProjectionSourceFallbackRow },
): Promise<MemorySourcesPayload> {
  if (input.payload.partial === true) return input.payload;
  if (input.payload.status !== 'ok' || hasUsableSource(input.payload) || !canUseProjectionFallback(input.payload)) return input.payload;
  const fallback = buildProjectionFallbackPayload(input.projectionId, input.row, input.originServerId);
  if (!fallback) return input.payload;
  return {
    ...input.payload,
    sourceEventCount: Math.max(
      typeof input.payload.sourceEventCount === 'number' ? input.payload.sourceEventCount : 0,
      typeof fallback.sourceEventCount === 'number' ? fallback.sourceEventCount : 0,
    ),
    sources: fallback.sources,
    projectionSource: input.payload.projectionSource || fallback.projectionSource,
    partial: false,
    originServerId: input.payload.originServerId || fallback.originServerId,
  };
}

// ── projection-owner resolver ───────────────────────────────────────────
//
// Cheap lookup. Caller passes `projectionId`; we return the originating
// `server_id` for the row scoped to the authenticated user. Used by the
// daemon orchestrator when its in-process cache misses (e.g. cold start or
// projection arrived through a non-MCP code path).

memoryRoutes.get('/memory/projection-owner', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const projectionId = c.req.query('projectionId')?.trim();
  const projectId = cleanMemoryProjectId(c.req.query('projectId'));
  if (!projectionId) {
    return c.json({ error: 'projection_id_required' }, 400);
  }
  if (!projectId) {
    return c.json({ error: 'not_found' }, 404);
  }
  const params: unknown[] = [projectionId, userId];
  params.push(projectId);
  const projectClause = `AND project_id = $${params.length}`;

  // Single row lookup gated on user ownership. 404 vs 200-with-empty is
  // intentional — see the spec scenario "caller cannot probe foreign
  // projections": leaking existence creates an oracle for cross-user enum.
  const row = await c.env.DB.queryOne<{ server_id: string }>(
    `SELECT server_id
       FROM shared_context_projections
      WHERE id = $1
        ${projectClause}
        AND ((scope = 'personal' AND user_id = $2)
             OR (scope <> 'personal' AND EXISTS (
               SELECT 1
                 FROM team_members tm
                WHERE tm.team_id = shared_context_projections.enterprise_id
                  AND tm.user_id = $2
             )))
      LIMIT 1`,
    params,
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
  const projectId = cleanMemoryProjectId(c.req.query('projectId'));

  if (!serverId) return c.json({ error: 'server_id_required' }, 400);
  if (!projectionId) return c.json({ error: 'projection_id_required' }, 400);
  if (!projectId) return c.json({ error: 'not_found' }, 404);

  const access = await resolveServerMemberAccessOrShareDeny(c.env.DB, { serverId, userId });
  if (!access.ok) return c.json({ error: 'forbidden', reason: access.reason }, 403);

  const projectionRow = await loadAuthorizedProjectionSourceRow(c.env.DB, {
    projectionId,
    userId,
    originServerId: serverId,
    projectId,
  });
  if (!projectionRow) return c.json({ error: 'not_found' }, 404);

  const bridge = WsBridge.get(serverId);
  if (!bridge.isDaemonConnected()) {
    const fallback = buildProjectionFallbackPayload(projectionId, projectionRow, serverId);
    if (fallback) return c.json(fallback);
    // Match the daemon-offline contract the file-transfer / Watch API
    // routes return so the MCP error mapping on the caller side stays
    // uniform.
    return c.json({ error: 'daemon_offline' }, 409);
  }

  const requestId = `mem-src-${randomUUID()}`;
  try {
    const reply = await bridge.sendMemorySourcesRequest(requestId, projectionId, projectId, SOURCES_REQUEST_TIMEOUT_MS);
    // Strip our internal correlation field before returning. The reply
    // already carries `status` / `projectionId` / `sourceEventCount` /
    // `sources` / `partial` / `originServerId` from the daemon handler.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requestId: _r, type: _t, ...payload } = reply as Record<string, unknown>;
    // Stamp serverId on the reply when daemon didn't include it. The
    // route's serverId IS the canonical origin (pod-sticky-routed here).
    payload.originServerId = serverId;
    payload.projectionId = projectionId;
    const hydrated = await withProjectionFallback({ payload, projectionId, originServerId: serverId, row: projectionRow });
    return c.json(hydrated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'timeout') {
      // Treat timeout the same as daemon offline so the MCP caller can
      // surface a recoverable error and try again later.
      logger.warn({ serverId, projectionId }, 'memory.get_sources timed out');
      const fallback = buildProjectionFallbackPayload(projectionId, projectionRow, serverId);
      return fallback ? c.json(fallback) : c.json({ error: 'daemon_offline' }, 409);
    }
    if (message === 'daemon_offline' || message === 'daemon_disconnected' || message === 'daemon_error') {
      const fallback = buildProjectionFallbackPayload(projectionId, projectionRow, serverId);
      return fallback ? c.json(fallback) : c.json({ error: 'daemon_offline' }, 409);
    }
    logger.warn({ serverId, projectionId, err: message }, 'memory.get_sources failed');
    return c.json({ error: FS_GENERIC_ERROR_CODES.INTERNAL_ERROR, message }, 500);
  }
});
