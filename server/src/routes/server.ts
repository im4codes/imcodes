import { Hono } from 'hono';
import type { Env } from '../env.js';
import {
  getServersByUserId,
  updateServerHeartbeat,
  updateServerName,
  deleteServer,
  upsertChannelBinding,
  getServerById,
  getServerSharedContextRuntimeConfig,
  updateServerSharedContextRuntimeConfig,
} from '../db/queries.js';
import { WsBridge } from '../ws/bridge.js';
import { sha256Hex, randomHex } from '../security/crypto.js';
import { requireAuth } from '../security/authorization.js';
import { z } from 'zod';
import type {
  ProcessedContextReplicationBody,
  RuntimeAuthoredContextBinding,
  SharedContextNamespaceResolution,
} from '../../../shared/context-types.js';
import { classifyTimestampFreshness } from '../../../shared/context-freshness.js';
import {
  buildSharedContextRuntimeConfigSnapshot,
  defaultSharedContextRuntimeConfig,
  normalizeSharedContextRuntimeConfig,
  SHARED_CONTEXT_RUNTIME_CONFIG_MSG,
} from '../../../shared/shared-context-runtime-config.js';

export const serverRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

const processedProjectionSchema = z.object({
  id: z.string().min(1),
  namespace: z.object({
    scope: z.enum(['personal', 'project_shared', 'workspace_shared', 'org_shared']),
    projectId: z.string().min(1),
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    enterpriseId: z.string().optional(),
  }),
  class: z.enum(['recent_summary', 'durable_memory_candidate']),
  sourceEventIds: z.array(z.string()),
  summary: z.string(),
  content: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const processedReplicationSchema = z.object({
  namespace: processedProjectionSchema.shape.namespace,
  projections: z.array(processedProjectionSchema).min(1),
});

const authoredContextQuerySchema = z.object({
  namespace: processedProjectionSchema.shape.namespace.refine((namespace) => namespace.scope !== 'personal', {
    message: 'shared_scope_required',
  }),
  language: z.string().min(1).optional(),
  filePath: z.string().min(1).optional(),
});

const namespaceResolutionSchema = z.object({
  canonicalRepoId: z.string().min(1),
});

const runtimeConfigSchema = z.object({
  primaryContextBackend: z.enum(['claude-code-sdk', 'codex-sdk', 'qwen', 'openclaw']).optional().nullable(),
  primaryContextModel: z.string().trim().min(1),
  backupContextBackend: z.enum(['claude-code-sdk', 'codex-sdk', 'qwen', 'openclaw']).optional().nullable(),
  backupContextModel: z.string().trim().optional().nullable(),
  enablePersonalMemorySync: z.boolean().optional().nullable(),
});

const DEFAULT_REMOTE_PROCESSED_FRESH_MS = 6 * 60 * 60 * 1000;

type RemoteMemoryRecordView = {
  id: string;
  scope: 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared';
  projectId: string;
  summary: string;
  projectionClass: 'recent_summary' | 'durable_memory_candidate';
  sourceEventCount: number;
  updatedAt: number;
};

type RemoteMemoryStatsView = {
  totalRecords: number;
  matchedRecords: number;
  recentSummaryCount: number;
  durableCandidateCount: number;
  projectCount: number;
};

function getRemoteProcessedFreshMs(): number {
  const raw = process.env.IMCODES_REMOTE_PROCESSED_FRESH_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REMOTE_PROCESSED_FRESH_MS;
}

function matchesMemoryQuery(summary: string, content: unknown, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${summary}\n${JSON.stringify(content ?? {})}`.toLowerCase().includes(normalized);
}

function buildRemoteMemoryResponse(
  rows: Array<{
    id: string;
    scope: 'personal' | 'project_shared' | 'workspace_shared' | 'org_shared';
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
  }>,
  query?: string,
  limit = 20,
): { stats: RemoteMemoryStatsView; records: RemoteMemoryRecordView[] } {
  const normalizedQuery = query?.trim() ?? '';
  const filtered = rows.filter((row) => matchesMemoryQuery(
    row.summary,
    typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json,
    normalizedQuery,
  ));
  const projectIds = new Set(rows.map((row) => row.project_id));
  return {
    stats: {
      totalRecords: rows.length,
      matchedRecords: filtered.length,
      recentSummaryCount: rows.filter((row) => row.projection_class === 'recent_summary').length,
      durableCandidateCount: rows.filter((row) => row.projection_class === 'durable_memory_candidate').length,
      projectCount: projectIds.size,
    },
    records: filtered.slice(0, limit).map((row) => ({
      id: row.id,
      scope: row.scope,
      projectId: row.project_id,
      summary: row.summary,
      projectionClass: row.projection_class,
      sourceEventCount: Array.isArray(row.source_event_ids_json)
        ? row.source_event_ids_json.length
        : JSON.parse(row.source_event_ids_json || '[]').length,
      updatedAt: row.updated_at,
    })),
  };
}

// GET /api/server — list all servers accessible to the authenticated user
serverRoutes.get('/', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const dbServers = await getServersByUserId(c.env.DB, userId);

  const servers = dbServers.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    lastHeartbeatAt: s.last_heartbeat_at,
    createdAt: s.created_at,
  }));

  return c.json({ servers });
});

// PATCH /api/server/:id/name — rename a server (authenticated user must own the server)
serverRoutes.patch('/:id/name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const updated = await updateServerName(c.env.DB, serverId, userId, parsed.data.name.trim());
  if (!updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// DELETE /api/server/:id — delete a server (user must own it); notifies daemon to self-destruct first
serverRoutes.delete('/:id', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';

  // Notify daemon to self-destruct (best-effort — daemon may be offline)
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({ type: 'server.delete' }));
  } catch { /* daemon may be offline, continue with DB deletion */ }

  const deleted = await deleteServer(c.env.DB, serverId, userId);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /api/server/:id/upgrade — tell daemon to upgrade itself and restart
serverRoutes.post('/:id/upgrade', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const dbServers = await getServersByUserId(c.env.DB, userId);
  if (!dbServers.find((s) => s.id === serverId)) return c.json({ error: 'not_found' }, 404);
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({
      type: 'daemon.upgrade',
      ...(process.env.APP_VERSION ? { targetVersion: process.env.APP_VERSION } : {}),
    }));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'daemon_offline' }, 503);
  }
});

// POST /api/server/:id/heartbeat — authenticated via Bearer server token
serverRoutes.post('/:id/heartbeat', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);
  const tokenHash = sha256Hex(token);

  const serverId = c.req.param('id');
  const server = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM servers WHERE id = $1 AND token_hash = $2',
    [serverId, tokenHash],
  );
  if (!server) return c.json({ error: 'unauthorized' }, 401);

  await updateServerHeartbeat(c.env.DB, serverId);
  return c.json({ ok: true });
});

serverRoutes.get('/:id/shared-context/runtime-config', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const server = await getServerById(c.env.DB, serverId);
  if (!server || server.user_id !== userId) return c.json({ error: 'not_found' }, 404);
  const persisted = await getServerSharedContextRuntimeConfig(c.env.DB, serverId);
  return c.json({ snapshot: buildSharedContextRuntimeConfigSnapshot(persisted ?? defaultSharedContextRuntimeConfig()) });
});

serverRoutes.put('/:id/shared-context/runtime-config', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => null);
  const parsed = runtimeConfigSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const normalized = normalizeSharedContextRuntimeConfig({
    primaryContextBackend: parsed.data.primaryContextBackend ?? undefined,
    primaryContextModel: parsed.data.primaryContextModel,
    backupContextBackend: parsed.data.backupContextBackend ?? undefined,
    backupContextModel: parsed.data.backupContextModel ?? undefined,
    enablePersonalMemorySync: parsed.data.enablePersonalMemorySync ?? undefined,
  });
  const updated = await updateServerSharedContextRuntimeConfig(c.env.DB, serverId, userId, normalized);
  if (!updated) return c.json({ error: 'not_found' }, 404);
  try {
    WsBridge.get(serverId).sendToDaemon(JSON.stringify({
      type: SHARED_CONTEXT_RUNTIME_CONFIG_MSG.APPLY,
      config: normalized,
    }));
  } catch {
    // daemon may be offline; it will pull the saved config on startup
  }
  return c.json({ snapshot: buildSharedContextRuntimeConfigSnapshot(normalized) });
});

serverRoutes.get('/:id/shared-context/runtime-config/daemon', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const tokenHash = sha256Hex(auth.slice(7));
  const serverId = c.req.param('id');
  const server = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM servers WHERE id = $1 AND token_hash = $2',
    [serverId, tokenHash],
  );
  if (!server) return c.json({ error: 'unauthorized' }, 401);
  const persisted = await getServerSharedContextRuntimeConfig(c.env.DB, serverId);
  return c.json({ config: persisted ?? defaultSharedContextRuntimeConfig() });
});

/**
 * POST /api/server/:id/bindings — persist a channel binding from the daemon.
 * Authenticated via Bearer server token. The token identifies the server (and thus the owner user).
 * Body: { platform, channelId, botId, bindingType, target }
 *
 * This is the write path that makes inbound webhook routing deterministic.
 * The daemon calls this after processing a /bind command from a user in chat.
 */
serverRoutes.post('/:id/bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);

  const tokenHash = sha256Hex(token);
  const serverRow = await c.env.DB.queryOne<{ id: string; user_id: string }>(
    'SELECT id, user_id FROM servers WHERE token_hash = $1 AND id = $2',
    [tokenHash, c.req.param('id')],
  );

  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    platform: z.string(),
    channelId: z.string(),
    botId: z.string(),
    bindingType: z.string(),
    target: z.string(),
  }).safeParse(body);

  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { platform, channelId, botId, bindingType, target } = parsed.data;
  const id = randomHex(16);
  await upsertChannelBinding(c.env.DB, id, serverRow.id, platform, channelId, bindingType, target, botId);

  return c.json({ ok: true });
});

/**
 * DELETE /api/server/:id/bindings — remove a channel binding.
 * Body: { platform, channelId, botId }
 */
serverRoutes.delete('/:id/bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);

  const tokenHash = sha256Hex(token);
  const serverRow = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM servers WHERE token_hash = $1 AND id = $2',
    [tokenHash, c.req.param('id')],
  );

  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ platform: z.string(), channelId: z.string(), botId: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { platform, channelId, botId } = parsed.data;
  // Scope to server_id to prevent cross-server deletion races
  await c.env.DB.execute(
    'DELETE FROM channel_bindings WHERE platform = $1 AND channel_id = $2 AND bot_id = $3 AND server_id = $4',
    [platform, channelId, botId, serverRow.id],
  );

  return c.json({ ok: true });
});

serverRoutes.post('/:id/shared-context/processed', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);
  const tokenHash = sha256Hex(token);

  const serverRow = await c.env.DB.queryOne<{ id: string; team_id: string | null; user_id: string }>(
    'SELECT id, team_id, user_id FROM servers WHERE token_hash = $1 AND id = $2',
    [tokenHash, c.req.param('id')],
  );
  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null) as ProcessedContextReplicationBody | null;
  const parsed = processedReplicationSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const now = Date.now();
  for (const projection of parsed.data.projections) {
    const isPersonal = projection.namespace.scope === 'personal';
    if (isPersonal && projection.namespace.userId && projection.namespace.userId !== serverRow.user_id) {
      return c.json({ error: 'namespace_user_mismatch', projectionId: projection.id }, 403);
    }
    if (!isPersonal && projection.namespace.enterpriseId && projection.namespace.enterpriseId !== serverRow.team_id) {
      return c.json({ error: 'namespace_enterprise_mismatch', projectionId: projection.id }, 403);
    }
    const safeEnterpriseId = isPersonal ? null : (serverRow.team_id ?? projection.namespace.enterpriseId ?? null);
    const safeWorkspaceId = isPersonal ? null : (projection.namespace.workspaceId ?? null);
    const safeUserId = isPersonal ? serverRow.user_id : (projection.namespace.userId ?? null);
    await c.env.DB.execute(
      `INSERT INTO shared_context_projections (
        id, server_id, scope, enterprise_id, workspace_id, user_id, project_id,
        projection_class, source_event_ids_json, summary, content_json,
        created_at, updated_at, replicated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        scope = excluded.scope,
        enterprise_id = excluded.enterprise_id,
        workspace_id = excluded.workspace_id,
        user_id = excluded.user_id,
        project_id = excluded.project_id,
        projection_class = excluded.projection_class,
        source_event_ids_json = excluded.source_event_ids_json,
        summary = excluded.summary,
        content_json = excluded.content_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        replicated_at = excluded.replicated_at`,
      [
        projection.id,
        serverRow.id,
        projection.namespace.scope,
        safeEnterpriseId,
        safeWorkspaceId,
        safeUserId,
        projection.namespace.projectId,
        projection.class,
        JSON.stringify(projection.sourceEventIds),
        projection.summary,
        JSON.stringify(projection.content),
        projection.createdAt,
        projection.updatedAt,
        now,
      ],
    );

    if (projection.class === 'durable_memory_candidate') {
      await c.env.DB.execute(
        `INSERT INTO shared_context_records (
          id, projection_id, server_id, scope, enterprise_id, workspace_id, user_id, project_id,
          record_class, summary, content_json, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'candidate', $12, $13)
        ON CONFLICT (projection_id) DO UPDATE SET
          scope = excluded.scope,
          enterprise_id = excluded.enterprise_id,
          workspace_id = excluded.workspace_id,
          user_id = excluded.user_id,
          project_id = excluded.project_id,
          record_class = excluded.record_class,
          summary = excluded.summary,
          content_json = excluded.content_json,
          updated_at = excluded.updated_at`,
        [
          `record:${projection.id}`,
          projection.id,
          serverRow.id,
          projection.namespace.scope,
          safeEnterpriseId,
          safeWorkspaceId,
          safeUserId,
          projection.namespace.projectId,
          projection.class,
          projection.summary,
          JSON.stringify(projection.content),
          projection.createdAt,
          projection.updatedAt,
        ],
      );
    }
  }

  return c.json({
    ok: true,
    replicatedAt: now,
    projectionCount: parsed.data.projections.length,
  });
});

serverRoutes.get('/:id/shared-context/personal-memory', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id') ?? '';
  const server = await getServerById(c.env.DB, serverId);
  if (!server || server.user_id !== userId) return c.json({ error: 'not_found' }, 404);
  const projectId = c.req.query('projectId')?.trim();
  const projectionClass = c.req.query('projectionClass')?.trim();
  const query = c.req.query('query')?.trim();
  const limit = Math.max(1, Math.min(100, Number.parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const rows = await c.env.DB.query<{
    id: string;
    scope: 'personal';
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
  }>(
    `SELECT id, scope, project_id, projection_class, source_event_ids_json, summary, content_json, updated_at
     FROM shared_context_projections
     WHERE server_id = $1
       AND user_id = $2
       AND scope = 'personal'
       ${projectId ? 'AND project_id = $3' : ''}
       ${projectionClass ? `AND projection_class = $${projectId ? 4 : 3}` : ''}
     ORDER BY updated_at DESC`,
    [serverId, userId, ...(projectId ? [projectId] : []), ...(projectionClass ? [projectionClass] : [])],
  );
  return c.json(buildRemoteMemoryResponse(rows, query, limit));
});

serverRoutes.post('/:id/shared-context/authored-bindings', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);
  const tokenHash = sha256Hex(token);

  const serverRow = await c.env.DB.queryOne<{ id: string; team_id: string | null }>(
    'SELECT id, team_id FROM servers WHERE token_hash = $1 AND id = $2',
    [tokenHash, c.req.param('id')],
  );
  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  // Cross-tenant security: use serverRow.team_id as authoritative enterprise binding
  const enterpriseId = serverRow.team_id;
  if (!enterpriseId) return c.json({ bindings: [] });

  const body = await c.req.json().catch(() => null);
  const parsed = authoredContextQuerySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { namespace, language, filePath } = parsed.data;

  type BindingRow = {
    binding_id: string;
    version_id: string;
    binding_mode: RuntimeAuthoredContextBinding['mode'];
    scope: RuntimeAuthoredContextBinding['scope'];
    applicability_repo_id: string | null;
    applicability_language: string | null;
    applicability_path_pattern: string | null;
    content_md: string;
  };

  const rows = await c.env.DB.query<BindingRow>(
    `SELECT
        b.id AS binding_id,
        v.id AS version_id,
        b.binding_mode,
        CASE
          WHEN b.enrollment_id IS NOT NULL THEN 'project_shared'
          WHEN b.workspace_id IS NOT NULL THEN 'workspace_shared'
          ELSE 'org_shared'
        END AS scope,
        b.applicability_repo_id,
        b.applicability_language,
        b.applicability_path_pattern,
        v.content_md
      FROM shared_context_document_bindings b
      JOIN shared_context_document_versions v ON v.id = b.version_id
      WHERE b.enterprise_id = $1
        AND b.status = 'active'
        AND v.status = 'active'
        AND (b.workspace_id IS NULL OR b.workspace_id = $2)
        AND (
          b.enrollment_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM shared_project_enrollments e
            WHERE e.id = b.enrollment_id
              AND e.canonical_repo_id = $3
              AND e.status = 'active'
          )
        )`,
    [enterpriseId, namespace.workspaceId ?? null, namespace.projectId],
  );

  const bindings: RuntimeAuthoredContextBinding[] = rows
    .map((row) => ({
      bindingId: row.binding_id,
      documentVersionId: row.version_id,
      mode: row.binding_mode,
      scope: row.scope,
      repository: row.applicability_repo_id ?? undefined,
      language: row.applicability_language ?? undefined,
      pathPattern: row.applicability_path_pattern ?? undefined,
      content: row.content_md,
      active: true,
    }))
    .filter((binding) => !binding.language || binding.language === language)
    .filter((binding) => !binding.pathPattern || !!filePath);

  return c.json({ bindings });
});

serverRoutes.post('/:id/shared-context/resolve-namespace', async (c) => {
  const auth = c.req.header('Authorization');
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
  const token = auth.slice(7);
  const tokenHash = sha256Hex(token);

  const serverRow = await c.env.DB.queryOne<{ id: string; team_id: string | null; user_id: string }>(
    'SELECT id, team_id, user_id FROM servers WHERE token_hash = $1 AND id = $2',
    [tokenHash, c.req.param('id')],
  );
  if (!serverRow) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = namespaceResolutionSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const canonicalRepoId = parsed.data.canonicalRepoId.trim();
  const enterpriseId = serverRow.team_id;
  const personalRemoteProjection = await c.env.DB.queryOne<{ id: string; updated_at: number }>(
    "SELECT id, updated_at FROM shared_context_projections WHERE scope = 'personal' AND user_id = $1 AND project_id = $2 ORDER BY updated_at DESC LIMIT 1",
    [serverRow.user_id, canonicalRepoId],
  );
  const personalRemoteFreshness = classifyTimestampFreshness(
    personalRemoteProjection?.updated_at,
    Date.now(),
    getRemoteProcessedFreshMs(),
  );
  if (!enterpriseId) {
    const result: SharedContextNamespaceResolution = {
      namespace: null,
      canonicalRepoId,
      visibilityState: 'unenrolled',
      remoteProcessedFreshness: personalRemoteFreshness,
      retryExhausted: true,
      diagnostics: ['server-no-enterprise', `remote-processed:${personalRemoteFreshness}`, 'remote-source:personal'],
    };
    return c.json(result);
  }

  const enrollment = await c.env.DB.queryOne<{
    id: string;
    enterprise_id: string;
    workspace_id: string | null;
    scope: 'project_shared' | 'workspace_shared' | 'org_shared';
    status: 'active' | 'pending_removal' | 'removed';
  }>(
    'SELECT id, enterprise_id, workspace_id, scope, status FROM shared_project_enrollments WHERE enterprise_id = $1 AND canonical_repo_id = $2',
    [enterpriseId, canonicalRepoId],
  );
  const remoteProjection = await c.env.DB.queryOne<{ id: string; updated_at: number }>(
    'SELECT id, updated_at FROM shared_context_projections WHERE enterprise_id = $1 AND project_id = $2 ORDER BY updated_at DESC LIMIT 1',
    [enterpriseId, canonicalRepoId],
  );
  const remoteProcessedFreshness = classifyTimestampFreshness(
    remoteProjection?.updated_at,
    Date.now(),
    getRemoteProcessedFreshMs(),
  );
  const policy = enrollment
    ? await c.env.DB.queryOne<{
      allow_degraded_provider_support: boolean;
      allow_local_fallback: boolean;
      require_full_provider_support: boolean;
    }>(
      'SELECT allow_degraded_provider_support, allow_local_fallback, require_full_provider_support FROM shared_scope_policy_overrides WHERE enrollment_id = $1',
      [enrollment.id],
    )
    : null;

  const isActive = enrollment?.status === 'active';
  const effectiveRemoteFreshness = isActive ? remoteProcessedFreshness : personalRemoteFreshness;
  const result: SharedContextNamespaceResolution = {
    namespace: isActive ? {
      scope: enrollment.scope,
      projectId: canonicalRepoId,
      enterpriseId: enrollment.enterprise_id,
      ...(enrollment.workspace_id ? { workspaceId: enrollment.workspace_id } : {}),
    } : null,
    canonicalRepoId,
    visibilityState: enrollment?.status ?? 'unenrolled',
    remoteProcessedFreshness: effectiveRemoteFreshness,
    // Return false when enrollment is active but remote is missing/stale (enables retry)
    // Return true when enrollment is inactive (no point retrying)
    retryExhausted: !isActive,
    ...(policy ? {
      sharedPolicyOverride: {
        allowDegradedProvider: !!policy.allow_degraded_provider_support,
        allowLocalProcessedFallback: !!policy.allow_local_fallback,
        requireFullProviderSupport: !!policy.require_full_provider_support,
      },
    } : {}),
    diagnostics: [
      `visibility:${enrollment?.status ?? 'unenrolled'}`,
      `remote-processed:${effectiveRemoteFreshness}`,
      `remote-source:${isActive ? 'shared' : 'personal'}`,
    ],
  };
  return c.json(result);
});
