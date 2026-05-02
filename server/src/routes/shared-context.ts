import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { requireAuth, resolveServerRole } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { parseRemoteUrl } from '../../../src/repo/detector.js';
import { parseCanonicalRepositoryKey } from '../../../src/agent/repository-identity-service.js';
import { classifyTimestampFreshness } from '../../../shared/context-freshness.js';
import type { ContextMemoryProjectView, ContextMemoryRecordView, ContextMemoryStatsView, ContextMemoryView } from '../../../shared/context-types.js';
import { computeRelevanceScore, applyRecallCapRule, type ProjectionClass } from '../../../shared/memory-scoring.js';
import { normalizeSharedContextRuntimeConfig } from '../../../shared/shared-context-runtime-config.js';
import { isTemplatePrompt, isTemplateOriginSummary, isImperativeCommand } from '../../../shared/template-prompt-patterns.js';
import { isMemoryNoiseSummary } from '../../../shared/memory-noise-patterns.js';
import { normalizeSummaryForFingerprint } from '../../../shared/memory-fingerprint.js';
import { isMemoryOrigin, type MemoryOrigin } from '../../../shared/memory-origin.js';
import { REPLICABLE_SHARED_PROJECTION_SCOPES } from '../../../shared/memory-scope.js';
import { searchSemanticMemoryView } from '../util/semantic-memory-view.js';
import { applyRuntimeAuthoredContextBudget } from '../memory/authored-context-runtime.js';
import { deleteEnterpriseMemoryProjection, deletePersonalMemoryProjection } from '../util/memory-delete.js';
import {
  authoredContextScopeForBinding,
  compareRuntimeAuthoredContextBindings,
  expandSearchRequestScope,
  isMemoryFeatureEnabled,
  isSearchRequestScope,
  isAuthoredContextScope,
  isSharedProjectionScope,
  matchesAuthoredContextPathPattern,
  MEMORY_FEATURES,
  sameShapeMemoryLookupEnvelope,
  sameShapeSearchEnvelope,
  type AuthoredContextScope,
  type MemoryScope,
  type SearchRequestScope,
  type SharedProjectionScope,
} from '../memory/scope-policy.js';
import {
  computeProjectionContentHash,
  consumeCitationCountRateLimit,
  deriveCitationIdempotencyKey,
} from '../memory/citation.js';

type EnterpriseRole = 'owner' | 'admin' | 'member';
type BindingMode = 'required' | 'advisory';
type DocumentKind = 'coding_standard' | 'architecture_guideline' | 'repo_playbook' | 'knowledge_doc';
type RepositoryAliasReason = 'ssh-https-equivalent' | 'explicit-migration';

export const sharedContextRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();
sharedContextRoutes.use('*', requireAuth());
type SharedContextRouteContext = Context<{ Bindings: Env; Variables: { userId: string; role: string } }>;

async function getEnterpriseRole(db: Env['DB'], enterpriseId: string, userId: string): Promise<EnterpriseRole | null> {
  const row = await db.queryOne<{ role: EnterpriseRole }>(
    'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
    [enterpriseId, userId],
  );
  return row?.role ?? null;
}

async function requireEnterpriseRole(
  c: SharedContextRouteContext,
  enterpriseId: string,
  minRole: EnterpriseRole,
): Promise<{ userId: string; role: EnterpriseRole } | Response> {
  const userId = c.get('userId' as never) as string;
  const role = await getEnterpriseRole(c.env.DB, enterpriseId, userId);
  if (!role) return sameShapeNotFound(c);
  const rank: Record<EnterpriseRole, number> = { owner: 3, admin: 2, member: 1 };
  if (rank[role] < rank[minRole]) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return { userId, role };
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return value === 'coding_standard' || value === 'architecture_guideline' || value === 'repo_playbook' || value === 'knowledge_doc';
}

function isBindingMode(value: unknown): value is BindingMode {
  return value === 'required' || value === 'advisory';
}

function isRepositoryAliasReason(value: unknown): value is RepositoryAliasReason {
  return value === 'ssh-https-equivalent' || value === 'explicit-migration';
}

function validateRepositoryAliasMutation(
  canonicalRepoId: string,
  aliasRepoId: string,
  reason: RepositoryAliasReason,
): { ok: true } | { ok: false; error: string } {
  const canonical = parseCanonicalRepositoryKey(canonicalRepoId);
  if (!canonical) return { ok: false, error: 'invalid_canonical_repo_id' };

  const aliasCanonical = parseCanonicalRepositoryKey(aliasRepoId);
  const aliasRemote = aliasCanonical ? null : parseRemoteUrl(aliasRepoId);
  const aliasHost = aliasCanonical?.host ?? aliasRemote?.host?.toLowerCase();
  const aliasOwner = aliasCanonical?.owner ?? aliasRemote?.owner;
  const aliasRepo = aliasCanonical?.repo ?? aliasRemote?.repo;
  if (!aliasHost || !aliasOwner || !aliasRepo) return { ok: false, error: 'invalid_alias' };
  if (canonical.owner !== aliasOwner || canonical.repo !== aliasRepo) {
    return { ok: false, error: 'invalid_alias_target' };
  }
  if (canonical.host !== aliasHost && reason !== 'explicit-migration') {
    return { ok: false, error: 'explicit_migration_required' };
  }
  if (canonical.host === aliasHost && reason === 'explicit-migration') {
    return { ok: false, error: 'redundant_migration_reason' };
  }
  return { ok: true };
}

async function readJsonBody<T>(c: SharedContextRouteContext): Promise<T | null> {
  return await c.req.json().catch(() => null) as T | null;
}

function sameShapeNotFound(c: SharedContextRouteContext): Response {
  return c.json(sameShapeMemoryLookupEnvelope(), 404);
}

type EnrollmentVisibilityState =
  | 'unenrolled'
  | 'active'
  | 'pending_removal'
  | 'removed';

type RetrievalMode =
  | 'personal_only'
  | 'shared_active'
  | 'policy_bound_default_deny'
  | 'cleanup_only';

function computeVisibility(state: EnrollmentVisibilityState, remoteProcessedPresent: boolean): {
  visibilityState: EnrollmentVisibilityState;
  retrievalMode: RetrievalMode;
} {
  if (state === 'active') {
    return { visibilityState: state, retrievalMode: 'shared_active' };
  }
  if (state === 'pending_removal') {
    return { visibilityState: state, retrievalMode: 'policy_bound_default_deny' };
  }
  if (state === 'removed') {
    return {
      visibilityState: state,
      retrievalMode: remoteProcessedPresent ? 'cleanup_only' : 'personal_only',
    };
  }
  return { visibilityState: 'unenrolled', retrievalMode: 'personal_only' };
}

type RuntimeAuthoredContextRow = {
  binding_id: string;
  binding_mode: BindingMode;
  workspace_id: string | null;
  enrollment_id: string | null;
  applicability_repo_id: string | null;
  applicability_language: string | null;
  applicability_path_pattern: string | null;
  version_id: string;
  content: string;
};

type RuntimeAuthoredContextFilter = {
  canonicalRepoId: string | null;
  workspaceId: string | null;
  enrollmentId: string | null;
  language: string | null;
  filePath: string | null;
};

const DEFAULT_REMOTE_PROCESSED_FRESH_MS = 6 * 60 * 60 * 1000;

function getRemoteProcessedFreshMs(): number {
  const raw = process.env.IMCODES_REMOTE_PROCESSED_FRESH_MS;
  if (!raw) return DEFAULT_REMOTE_PROCESSED_FRESH_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REMOTE_PROCESSED_FRESH_MS;
}

function matchesMemoryQuery(summary: string, content: unknown, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${summary}\n${JSON.stringify(content ?? {})}`.toLowerCase().includes(normalized);
}

type MemoryStatsRow = {
  total_records?: number | null;
  recent_summary_count?: number | null;
  durable_candidate_count?: number | null;
  project_count?: number | null;
};

type MemoryProjectStatsRow = {
  project_id: string;
  total_records?: number | null;
  recent_summary_count?: number | null;
  durable_candidate_count?: number | null;
  updated_at?: number | null;
};

type MemoryRecordRow = {
  id: string;
  scope: SharedProjectionScope;
  project_id: string;
  projection_class: 'recent_summary' | 'durable_memory_candidate';
  source_event_ids_json: string | string[];
  summary: string;
  updated_at: number;
  hit_count?: number | null;
  last_used_at?: number | null;
  status?: 'active' | 'archived' | null;
};

function buildMemoryStatsView(
  row: MemoryStatsRow | null | undefined,
  matchedRecords: number,
): ContextMemoryStatsView {
  return {
    totalRecords: row?.total_records ?? 0,
    matchedRecords,
    recentSummaryCount: row?.recent_summary_count ?? 0,
    durableCandidateCount: row?.durable_candidate_count ?? 0,
    projectCount: row?.project_count ?? 0,
    stagedEventCount: 0,
    dirtyTargetCount: 0,
    pendingJobCount: 0,
  };
}

function mapMemoryRecordRows(rows: MemoryRecordRow[]): ContextMemoryRecordView[] {
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    summary: row.summary,
    projectionClass: row.projection_class,
    sourceEventCount: Array.isArray(row.source_event_ids_json)
      ? row.source_event_ids_json.length
      : JSON.parse(row.source_event_ids_json || '[]').length,
    updatedAt: row.updated_at,
    hitCount: row.hit_count ?? 0,
    lastUsedAt: row.last_used_at ?? undefined,
    status: row.status ?? 'active',
  }));
}

function mapMemoryProjectRows(rows: MemoryProjectStatsRow[]): ContextMemoryProjectView[] {
  return rows
    .filter((row) => row.project_id)
    .map((row) => ({
      projectId: row.project_id,
      displayName: row.project_id,
      totalRecords: row.total_records ?? 0,
      recentSummaryCount: row.recent_summary_count ?? 0,
      durableCandidateCount: row.durable_candidate_count ?? 0,
      updatedAt: row.updated_at ?? undefined,
    }));
}

function buildMemoryProjectsFromRows(rows: Array<Pick<MemoryProjectStatsRow, 'project_id'> & {
  projection_class: 'recent_summary' | 'durable_memory_candidate';
  updated_at: number;
}>): ContextMemoryProjectView[] {
  const projects = new Map<string, ContextMemoryProjectView>();
  for (const row of rows) {
    if (!row.project_id) continue;
    const current = projects.get(row.project_id) ?? {
      projectId: row.project_id,
      displayName: row.project_id,
      totalRecords: 0,
      recentSummaryCount: 0,
      durableCandidateCount: 0,
      updatedAt: row.updated_at,
    };
    current.totalRecords += 1;
    if (row.projection_class === 'recent_summary') current.recentSummaryCount += 1;
    if (row.projection_class === 'durable_memory_candidate') current.durableCandidateCount += 1;
    current.updatedAt = Math.max(current.updatedAt ?? 0, row.updated_at ?? 0) || undefined;
    projects.set(row.project_id, current);
  }
  return Array.from(projects.values())
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.totalRecords - a.totalRecords || a.projectId.localeCompare(b.projectId))
    .slice(0, 200);
}

function buildSharedMemoryResponse(
  rows: Array<{
    id: string;
    scope: SharedProjectionScope;
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
    hit_count?: number | null;
    last_used_at?: number | null;
    status?: 'active' | 'archived' | null;
  }>,
  query?: string,
  limit = 20,
): ContextMemoryView {
  const normalizedQuery = query?.trim() ?? '';
  const cleanRows = rows.filter((row) => !isMemoryNoiseSummary(row.summary));
  const filtered = cleanRows.filter((row) => matchesMemoryQuery(
    row.summary,
    typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json,
    normalizedQuery,
  ));
  const projectIds = new Set(cleanRows.map((row) => row.project_id));
  return {
    stats: buildMemoryStatsView({
      total_records: cleanRows.length,
      recent_summary_count: cleanRows.filter((row) => row.projection_class === 'recent_summary').length,
      durable_candidate_count: cleanRows.filter((row) => row.projection_class === 'durable_memory_candidate').length,
      project_count: projectIds.size,
    }, filtered.length),
    records: mapMemoryRecordRows(filtered.slice(0, limit)),
    projects: buildMemoryProjectsFromRows(cleanRows),
  };
}

sharedContextRoutes.delete('/personal-memory/:memoryId', async (c) => {
  const userId = c.get('userId' as never) as string;
  const memoryId = c.req.param('memoryId');
  if (!memoryId) return c.json({ error: 'missing_memory_id' }, 400);
  const deleted = await deletePersonalMemoryProjection(c.env.DB, userId, memoryId);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  await logAudit({ userId, action: 'shared_context.personal_memory_deleted', details: { memoryId } }, c.env.DB);
  return c.json({ ok: true, id: memoryId });
});

sharedContextRoutes.get('/personal-memory', async (c) => {
  const userId = c.get('userId' as never) as string;
  const projectId = c.req.query('projectId')?.trim();
  const projectionClass = c.req.query('projectionClass') === 'recent_summary' || c.req.query('projectionClass') === 'durable_memory_candidate'
    ? c.req.query('projectionClass') as 'recent_summary' | 'durable_memory_candidate'
    : undefined;
  const query = c.req.query('query')?.trim();
  const limit = Math.max(1, Math.min(100, Number.parseInt(c.req.query('limit') ?? '20', 10) || 20));

  if (query) {
    const semanticView = await searchSemanticMemoryView({
      db: c.env.DB,
      userId,
      scope: 'personal',
      query,
      projectId: projectId || undefined,
      projectionClass,
      limit,
    });
    if (semanticView) return c.json(semanticView);
  }

  if (!query) {
    const stats = await c.env.DB.queryOne<MemoryStatsRow>(
      `SELECT COUNT(*)::int AS total_records,
              COUNT(*) FILTER (WHERE projection_class = 'recent_summary')::int AS recent_summary_count,
              COUNT(*) FILTER (WHERE projection_class = 'durable_memory_candidate')::int AS durable_candidate_count,
              COUNT(DISTINCT project_id)::int AS project_count
       FROM shared_context_projections
       WHERE user_id = $1
         AND scope = 'personal'
         ${projectId ? 'AND project_id = $2' : ''}
         ${projectionClass ? `AND projection_class = $${projectId ? 3 : 2}` : ''}`,
      [userId, ...(projectId ? [projectId] : []), ...(projectionClass ? [projectionClass] : [])],
    );
    const rows = await c.env.DB.query<MemoryRecordRow>(
      `SELECT id, scope, project_id, projection_class, source_event_ids_json, summary, updated_at, hit_count, last_used_at, status
       FROM shared_context_projections
       WHERE user_id = $1
         AND scope = 'personal'
         ${projectId ? 'AND project_id = $2' : ''}
         ${projectionClass ? `AND projection_class = $${projectId ? 3 : 2}` : ''}
       ORDER BY updated_at DESC
       LIMIT $${projectId ? (projectionClass ? 4 : 3) : (projectionClass ? 3 : 2)}`,
      [userId, ...(projectId ? [projectId] : []), ...(projectionClass ? [projectionClass] : []), limit],
    );
    const projectRows = await c.env.DB.query<MemoryProjectStatsRow>(
      `SELECT project_id,
              COUNT(*)::int AS total_records,
              COUNT(*) FILTER (WHERE projection_class = 'recent_summary')::int AS recent_summary_count,
              COUNT(*) FILTER (WHERE projection_class = 'durable_memory_candidate')::int AS durable_candidate_count,
              MAX(updated_at) AS updated_at
       FROM shared_context_projections
       WHERE user_id = $1
         AND scope = 'personal'
         ${projectId ? 'AND project_id = $2' : ''}
         ${projectionClass ? `AND projection_class = $${projectId ? 3 : 2}` : ''}
       GROUP BY project_id
       ORDER BY MAX(updated_at) DESC
       LIMIT 200`,
      [userId, ...(projectId ? [projectId] : []), ...(projectionClass ? [projectionClass] : [])],
    );
    return c.json({
      stats: buildMemoryStatsView(stats, stats?.total_records ?? 0),
      records: mapMemoryRecordRows(rows.filter((row) => !isMemoryNoiseSummary(row.summary))),
      projects: mapMemoryProjectRows(projectRows),
    });
  }

  const rows = await c.env.DB.query<{
    id: string;
    scope: 'personal';
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
    hit_count?: number | null;
    last_used_at?: number | null;
    status?: 'active' | 'archived' | null;
  }>(
    `SELECT id, scope, project_id, projection_class, source_event_ids_json, summary, content_json, updated_at, hit_count, last_used_at, status
     FROM shared_context_projections
     WHERE user_id = $1
       AND scope = 'personal'
       ${projectId ? 'AND project_id = $2' : ''}
       ${projectionClass ? `AND projection_class = $${projectId ? 3 : 2}` : ''}
     ORDER BY updated_at DESC`,
    [userId, ...(projectId ? [projectId] : []), ...(projectionClass ? [projectionClass] : [])],
  );
  return c.json(buildSharedMemoryResponse(rows, query, limit));
});

sharedContextRoutes.post('/memory/search', async (c) => {
  if (!isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.quickSearch)) {
    return c.json(sameShapeSearchEnvelope());
  }
  const userId = c.get('userId' as never) as string;
  const body = await readJsonBody<{
    query?: string;
    scope?: SearchRequestScope;
    projectId?: string;
    limit?: number;
  }>(c);
  const query = body?.query?.trim() ?? '';
  const requestedScope = isSearchRequestScope(body?.scope) ? body.scope : 'all_authorized';
  const limit = Math.max(1, Math.min(50, typeof body?.limit === 'number' ? body.limit : 20));
  const userPrivateSyncEnabled = isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.userPrivateSync);
  const scopes = expandSearchRequestScope(requestedScope, { includeOwnerPrivate: userPrivateSyncEnabled });
  if (scopes.length === 0) return c.json(sameShapeSearchEnvelope());

  type SearchProjectionRow = {
    id: string;
    scope: Exclude<MemoryScope, 'user_private'>;
    project_id: string;
    projection_class: ProjectionClass;
    summary: string;
    updated_at: number;
    hit_count: number | null;
    cite_count: number | null;
    origin: MemoryOrigin | null;
  };
  type OwnerPrivateRow = {
    id: string;
    kind: string;
    origin: MemoryOrigin | null;
    text: string;
    updated_at: number;
  };

  const includeUserPrivate = userPrivateSyncEnabled && scopes.includes('user_private');
  const sharedScopes = scopes.filter((scope) => scope !== 'user_private' && isSharedProjectionScope(scope));
  const results: Array<{
    id: string;
    scope: MemoryScope;
    class: string;
    preview: string;
    origin?: MemoryOrigin;
    projectId?: string;
    updatedAt: number;
    score: number;
  }> = [];

  if (includeUserPrivate) {
    const ownerRows = await c.env.DB.query<OwnerPrivateRow>(
      `SELECT id, kind, origin, text, updated_at
       FROM owner_private_memories
       WHERE owner_user_id = $1
         ${query ? 'AND text ILIKE $2' : ''}
       ORDER BY updated_at DESC
       LIMIT $${query ? 3 : 2}`,
      [userId, ...(query ? [`%${query}%`] : []), limit],
    );
    for (const row of ownerRows) {
      results.push({
        id: row.id,
        scope: 'user_private',
        class: row.kind,
        preview: row.text.slice(0, 240),
        origin: isMemoryOrigin(row.origin) ? row.origin : undefined,
        updatedAt: row.updated_at,
        score: row.updated_at,
      });
    }
  }

  if (sharedScopes.length > 0) {
    const citeCountEnabled = isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.citeCount);
    const rows = await c.env.DB.query<SearchProjectionRow>(
      `SELECT p.id, p.scope, p.project_id, p.projection_class, p.summary, p.updated_at, p.origin,
              p.hit_count, COALESCE(cc.cite_count, 0) AS cite_count
       FROM shared_context_projections p
       LEFT JOIN shared_context_projection_cite_counts cc ON cc.projection_id = p.id
       WHERE COALESCE(p.status, 'active') = 'active'
         AND ($1::text IS NULL OR p.project_id = $1)
         AND ($2::text = '' OR p.summary ILIKE $3)
         AND (
           (p.scope = 'personal' AND p.user_id = $4 AND p.scope = ANY($5::text[]))
	           OR (
	            p.scope <> 'personal'
	            AND p.scope = ANY($5::text[])
	            AND EXISTS (
	               SELECT 1 FROM team_members tm
	               WHERE tm.team_id = p.enterprise_id AND tm.user_id = $4
             )
           )
         )
       ORDER BY (p.updated_at + CASE WHEN $7::boolean THEN LEAST(COALESCE(cc.cite_count, 0), 100) ELSE 0 END) DESC
       LIMIT $6`,
      [body?.projectId?.trim() || null, query, `%${query}%`, userId, sharedScopes, limit, citeCountEnabled],
    );
    for (const row of rows.filter((entry) => !isMemoryNoiseSummary(entry.summary))) {
      results.push({
        id: row.id,
        scope: row.scope,
        class: row.projection_class,
        preview: row.summary.slice(0, 240),
        origin: isMemoryOrigin(row.origin) ? row.origin : undefined,
        projectId: row.project_id,
        updatedAt: row.updated_at,
        score: row.updated_at + (citeCountEnabled ? Math.min(row.cite_count ?? 0, 100) : 0),
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.updatedAt - a.updatedAt;
  });

  return c.json({
    results: results.slice(0, limit).map((result) => ({
      id: result.id,
      scope: result.scope,
      class: result.class,
      preview: result.preview,
      origin: result.origin,
      projectId: result.projectId,
      updatedAt: result.updatedAt,
    })),
    nextCursor: null,
  });
});

type CitationProjectionRow = {
  id: string;
  scope: SharedProjectionScope;
  enterprise_id: string | null;
  user_id: string | null;
  project_id: string;
  summary: string;
  content_json: string | Record<string, unknown> | null;
  content_hash: string | null;
};

async function getAuthorizedCitationProjection(
  c: SharedContextRouteContext,
  projectionId: string,
  userId: string,
): Promise<CitationProjectionRow | null> {
  const row = await c.env.DB.queryOne<CitationProjectionRow>(
    `SELECT id, scope, enterprise_id, user_id, project_id, summary, content_json, content_hash
     FROM shared_context_projections
     WHERE id = $1 AND COALESCE(status, 'active') = 'active'`,
    [projectionId],
  );
  if (!row) return null;
  if (row.scope === 'personal') return row.user_id === userId ? row : null;
  if (!isSharedProjectionScope(row.scope)) return null;
  if (!row.enterprise_id) return null;
  const member = await c.env.DB.queryOne<{ role: EnterpriseRole }>(
    'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
    [row.enterprise_id, userId],
  );
  return member ? row : null;
}

function parseProjectionContent(contentJson: CitationProjectionRow['content_json']): Record<string, unknown> {
  if (typeof contentJson !== 'string') return contentJson ?? {};
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function getOrRepairProjectionContentHash(
  c: SharedContextRouteContext,
  projection: CitationProjectionRow,
): Promise<string> {
  const persisted = projection.content_hash?.trim();
  if (persisted) return persisted;
  const computed = computeProjectionContentHash({
    summary: projection.summary,
    content: parseProjectionContent(projection.content_json),
  });
  await c.env.DB.execute(
    `UPDATE shared_context_projections
     SET content_hash = $1
     WHERE id = $2 AND (content_hash IS NULL OR content_hash = '')`,
    [computed, projection.id],
  ).catch(() => { /* best-effort repair; caller still uses the computed hash */ });
  return computed;
}

sharedContextRoutes.post('/memory/citations', async (c) => {
  if (!isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.citation)) return sameShapeNotFound(c);
  const userId = c.get('userId' as never) as string;
  const body = await readJsonBody<{ projectionId?: string; citingMessageId?: string }>(c);
  const projectionId = body?.projectionId?.trim();
  const citingMessageId = body?.citingMessageId?.trim();
  if (!projectionId || !citingMessageId) return c.json({ error: 'invalid_body' }, 400);

  const projection = await getAuthorizedCitationProjection(c, projectionId, userId);
  if (!projection) return sameShapeNotFound(c);
  const contentHash = await getOrRepairProjectionContentHash(c, projection);
  const scopeNamespace = `${projection.scope}:${projection.enterprise_id ?? projection.user_id ?? ''}:${projection.project_id}`;
  const idempotencyKey = deriveCitationIdempotencyKey({ scopeNamespace, projectionId, citingMessageId });
  const citationId = randomHex(16);
  const now = Date.now();
  const insert = await c.env.DB.execute(
    `INSERT INTO shared_context_citations (
      id, projection_id, user_id, citing_message_id, idempotency_key, projection_content_hash, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (idempotency_key) DO NOTHING`,
    [citationId, projectionId, userId, citingMessageId, idempotencyKey, contentHash, now],
  );
  const inserted = insert.changes > 0;
  const existingCitation = inserted
    ? null
    : await c.env.DB.queryOne<{
        id: string;
        projection_id: string;
        projection_content_hash: string;
        created_at: number;
      }>(
        'SELECT id, projection_id, projection_content_hash, created_at FROM shared_context_citations WHERE idempotency_key = $1 AND user_id = $2',
        [idempotencyKey, userId],
      );
  if (!inserted && !existingCitation) return sameShapeNotFound(c);
  const countAllowed = inserted && isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.citeCount)
    ? consumeCitationCountRateLimit({ env: c.env, userId, projectionId, now }).allowed
    : false;
  if (countAllowed) {
    await c.env.DB.execute(
      `INSERT INTO shared_context_projection_cite_counts (projection_id, cite_count, updated_at)
       VALUES ($1, 1, $2)
       ON CONFLICT (projection_id) DO UPDATE SET
         cite_count = shared_context_projection_cite_counts.cite_count + 1,
         updated_at = excluded.updated_at`,
      [projectionId, now],
    );
  }
  const drift = existingCitation ? existingCitation.projection_content_hash !== contentHash : false;
  const driftVisible = isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.citeDriftBadge);

  return c.json({
    ok: true,
    citation: {
      id: existingCitation?.id ?? citationId,
      projectionId,
      createdAt: existingCitation?.created_at ?? now,
      drift: driftVisible ? drift : false,
    },
    deduped: !inserted,
  }, inserted ? 201 : 200);
});

sharedContextRoutes.get('/memory/citations/:citationId', async (c) => {
  if (!isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.citation)) return sameShapeNotFound(c);
  const userId = c.get('userId' as never) as string;
  const citationId = c.req.param('citationId');
  const row = await c.env.DB.queryOne<{
    id: string;
    projection_id: string;
    projection_content_hash: string;
    created_at: number;
  }>(
    'SELECT id, projection_id, projection_content_hash, created_at FROM shared_context_citations WHERE id = $1 AND user_id = $2',
    [citationId, userId],
  );
  if (!row) return sameShapeNotFound(c);
  const projection = await getAuthorizedCitationProjection(c, row.projection_id, userId);
  if (!projection) return sameShapeNotFound(c);
  const currentHash = await getOrRepairProjectionContentHash(c, projection);
  const driftVisible = isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.citeDriftBadge);
  return c.json({
    ok: true,
    citation: {
      id: row.id,
      projectionId: row.projection_id,
      createdAt: row.created_at,
      drift: driftVisible ? currentHash !== row.projection_content_hash : false,
    },
  });
});

function matchesRuntimeAuthoredContextRow(
  row: RuntimeAuthoredContextRow,
  filter: RuntimeAuthoredContextFilter,
): boolean {
  if (row.workspace_id) {
    if (!filter.workspaceId) return false;
    if (row.workspace_id !== filter.workspaceId) return false;
  }
  if (row.enrollment_id) {
    if (!filter.enrollmentId) return false;
    if (row.enrollment_id !== filter.enrollmentId) return false;
  }
  if (row.applicability_repo_id) {
    if (!filter.canonicalRepoId) return false;
    if (row.applicability_repo_id !== filter.canonicalRepoId) return false;
  }
  if (row.applicability_language) {
    if (!filter.language) return false;
    if (row.applicability_language !== filter.language) return false;
  }
  if (row.applicability_path_pattern) {
    if (!filter.filePath) return false;
    if (!matchesAuthoredContextPathPattern(row.applicability_path_pattern, filter.filePath)) return false;
  }
  return true;
}

sharedContextRoutes.get('/enterprises/:enterpriseId/workspaces', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const rows = await c.env.DB.query<{ id: string; enterprise_id: string; name: string }>(
    'SELECT id, enterprise_id, name FROM shared_context_workspaces WHERE enterprise_id = $1 ORDER BY name ASC',
    [enterpriseId],
  );
  return c.json({
    enterpriseId,
    workspaces: rows.map((row) => ({
      id: row.id,
      enterpriseId: row.enterprise_id,
      name: row.name,
    })),
  });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/projects', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const rows = await c.env.DB.query<{
    id: string;
    workspace_id: string | null;
    canonical_repo_id: string;
    display_name: string | null;
    scope: AuthoredContextScope;
    status: EnrollmentVisibilityState;
  }>(
    'SELECT id, workspace_id, canonical_repo_id, display_name, scope, status FROM shared_project_enrollments WHERE enterprise_id = $1 ORDER BY id ASC',
    [enterpriseId],
  );
  return c.json({
    enterpriseId,
    projects: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      canonicalRepoId: row.canonical_repo_id,
      displayName: row.display_name,
      scope: row.scope,
      status: row.status,
    })),
  });
});

sharedContextRoutes.get('/projects/:enrollmentId/policy', async (c) => {
  const enrollmentId = c.req.param('enrollmentId');
  const enrollment = await c.env.DB.queryOne<{ enterprise_id: string }>(
    'SELECT enterprise_id FROM shared_project_enrollments WHERE id = $1',
    [enrollmentId],
  );
  if (!enrollment) return c.json({ error: 'not_found' }, 404);
  const auth = await requireEnterpriseRole(c, enrollment.enterprise_id, 'member');
  if (auth instanceof Response) return auth;
  const row = await c.env.DB.queryOne<{
    allow_degraded_provider_support: boolean;
    allow_local_fallback: boolean;
    require_full_provider_support: boolean;
  }>(
    'SELECT allow_degraded_provider_support, allow_local_fallback, require_full_provider_support FROM shared_scope_policy_overrides WHERE enrollment_id = $1',
    [enrollmentId],
  );
  return c.json({
    enrollmentId,
    enterpriseId: enrollment.enterprise_id,
    allowDegradedProviderSupport: row?.require_full_provider_support
      ? false
      : (row?.allow_degraded_provider_support ?? true),
    allowLocalFallback: row?.allow_local_fallback ?? false,
    requireFullProviderSupport: row?.require_full_provider_support ?? false,
  });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/documents', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const docs = await c.env.DB.query<{ id: string; kind: DocumentKind; title: string }>(
    'SELECT id, kind, title FROM shared_context_documents WHERE enterprise_id = $1 ORDER BY title ASC',
    [enterpriseId],
  );
  const result = [];
  for (const doc of docs) {
    const versions = await c.env.DB.query<{ id: string; version_number: number; status: string }>(
      'SELECT id, version_number, status FROM shared_context_document_versions WHERE document_id = $1 ORDER BY version_number DESC',
      [doc.id],
    );
    result.push({
      id: doc.id,
      enterpriseId,
      kind: doc.kind,
      title: doc.title,
      versions: versions.map((version) => ({
        id: version.id,
        versionNumber: version.version_number,
        status: version.status,
      })),
    });
  }
  return c.json({ enterpriseId, documents: result });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/document-bindings', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const rows = await c.env.DB.query<{
    id: string;
    workspace_id: string | null;
    enrollment_id: string | null;
    document_id: string;
    version_id: string;
    binding_mode: BindingMode;
    applicability_repo_id: string | null;
    applicability_language: string | null;
    applicability_path_pattern: string | null;
    status: string;
  }>(
    'SELECT id, workspace_id, enrollment_id, document_id, version_id, binding_mode, applicability_repo_id, applicability_language, applicability_path_pattern, status FROM shared_context_document_bindings WHERE enterprise_id = $1 ORDER BY id ASC',
    [enterpriseId],
  );
  const orgAuthoredEnabled = isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.orgSharedAuthoredStandards);
  const visibleRows = rows.filter((row) => {
    const scope = authoredContextScopeForBinding({
      workspaceId: row.workspace_id,
      enrollmentId: row.enrollment_id,
    });
    return scope !== 'org_shared' || orgAuthoredEnabled;
  });
  return c.json({
    enterpriseId,
    bindings: visibleRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      enrollmentId: row.enrollment_id,
      scope: authoredContextScopeForBinding({
        workspaceId: row.workspace_id,
        enrollmentId: row.enrollment_id,
      }),
      documentId: row.document_id,
      versionId: row.version_id,
      mode: row.binding_mode,
      applicabilityRepoId: row.applicability_repo_id,
      applicabilityLanguage: row.applicability_language,
      applicabilityPathPattern: row.applicability_path_pattern,
      status: row.status,
    })),
  });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/runtime-authored-context', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const userId = c.get('userId' as never) as string;
  const role = await getEnterpriseRole(c.env.DB, enterpriseId, userId);
  if (!role) return sameShapeNotFound(c);
  const canonicalRepoId = c.req.query('canonicalRepoId')?.trim() ?? null;
  const workspaceId = c.req.query('workspaceId')?.trim() ?? null;
  const enrollmentId = c.req.query('enrollmentId')?.trim() ?? null;
  const language = c.req.query('language')?.trim() ?? null;
  const filePath = c.req.query('filePath')?.trim() ?? null;
  const rows = await c.env.DB.query<RuntimeAuthoredContextRow>(
    `SELECT
      b.id AS binding_id,
      b.binding_mode,
      b.workspace_id,
      b.enrollment_id,
      b.applicability_repo_id,
      b.applicability_language,
      b.applicability_path_pattern,
      v.id AS version_id,
      v.content_md AS content
    FROM shared_context_document_bindings b
    JOIN shared_context_document_versions v ON v.id = b.version_id
    WHERE b.enterprise_id = $1 AND b.status = 'active' AND v.status = 'active'
    ORDER BY b.id ASC`,
    [enterpriseId],
  );

  const bindings = rows
    .filter((row) => row.enrollment_id || row.workspace_id || isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.orgSharedAuthoredStandards))
    .filter((row) => matchesRuntimeAuthoredContextRow(row, {
      canonicalRepoId,
      workspaceId,
      enrollmentId,
      language,
      filePath,
    }))
    .map((row) => ({
      bindingId: row.binding_id,
      documentVersionId: row.version_id,
      mode: row.binding_mode,
      scope: authoredContextScopeForBinding({
        workspaceId: row.workspace_id,
        enrollmentId: row.enrollment_id,
      }),
      repository: row.applicability_repo_id ?? undefined,
      language: row.applicability_language ?? undefined,
      pathPattern: row.applicability_path_pattern ?? undefined,
      content: row.content,
      active: true,
      superseded: false,
    }))
    .sort(compareRuntimeAuthoredContextBindings);
  const budgetBytesRaw = c.req.query('budgetBytes')?.trim();
  const budgetBytes = budgetBytesRaw ? Number(budgetBytesRaw) : undefined;
  const budgeted = applyRuntimeAuthoredContextBudget(bindings, budgetBytes);
  if (!budgeted.ok) {
    return c.json({
      error: budgeted.error,
      enterpriseId,
      bindings: budgeted.bindings,
      diagnostics: budgeted.diagnostics,
    }, 409);
  }

  return c.json({
    enterpriseId,
    bindings: budgeted.bindings,
    ...(budgeted.diagnostics.length > 0 ? { diagnostics: budgeted.diagnostics } : {}),
  });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/diagnostics', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const canonicalRepoId = c.req.query('canonicalRepoId')?.trim();
  if (!canonicalRepoId) return c.json({ error: 'canonical_repo_id_required' }, 400);
  const workspaceId = c.req.query('workspaceId')?.trim() ?? null;
  const enrollmentId = c.req.query('enrollmentId')?.trim() ?? null;
  const language = c.req.query('language')?.trim() ?? null;
  const filePath = c.req.query('filePath')?.trim() ?? null;

  const enrollment = await c.env.DB.queryOne<{ id: string; status: EnrollmentVisibilityState }>(
    'SELECT id, status FROM shared_project_enrollments WHERE enterprise_id = $1 AND canonical_repo_id = $2',
    [enterpriseId, canonicalRepoId],
  );
  const remoteProjection = await c.env.DB.queryOne<{ id: string; updated_at: number }>(
    'SELECT id, updated_at FROM shared_context_projections WHERE enterprise_id = $1 AND project_id = $2 ORDER BY updated_at DESC LIMIT 1',
    [enterpriseId, canonicalRepoId],
  );
  const policy = enrollment
    ? await c.env.DB.queryOne<{
        allow_degraded_provider_support: boolean;
        allow_local_fallback: boolean;
        require_full_provider_support: boolean;
      }>('SELECT allow_degraded_provider_support, allow_local_fallback, require_full_provider_support FROM shared_scope_policy_overrides WHERE enrollment_id = $1', [enrollment.id])
    : null;
  const bindings = await c.env.DB.query<RuntimeAuthoredContextRow>(
    `SELECT
      b.id AS binding_id,
      b.binding_mode,
      b.workspace_id,
      b.enrollment_id,
      b.applicability_repo_id,
      b.applicability_language,
      b.applicability_path_pattern,
      v.id AS version_id,
      v.content_md AS content
    FROM shared_context_document_bindings b
    JOIN shared_context_document_versions v ON v.id = b.version_id
    WHERE b.enterprise_id = $1 AND b.status = 'active' AND v.status = 'active'
    ORDER BY b.id ASC`,
    [enterpriseId],
  );
  const visibility = computeVisibility(enrollment?.status ?? 'unenrolled', !!remoteProjection);
  const remoteProcessedFreshness = classifyTimestampFreshness(
    remoteProjection?.updated_at,
    Date.now(),
    getRemoteProcessedFreshMs(),
  );
  const matchingBindings = bindings
    .filter((row) => row.enrollment_id || row.workspace_id || isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.orgSharedAuthoredStandards))
    .filter((row) => matchesRuntimeAuthoredContextRow(row, {
      canonicalRepoId,
      workspaceId,
      enrollmentId,
      language,
      filePath,
    }));
  return c.json({
    enterpriseId,
    canonicalRepoId,
    enrollmentId: enrollment?.id ?? null,
    remoteProcessedFreshness,
    visibilityState: visibility.visibilityState,
    retrievalMode: visibility.retrievalMode,
    policy: {
      allowDegradedProviderSupport: policy?.require_full_provider_support
        ? false
        : (policy?.allow_degraded_provider_support ?? true),
      allowLocalFallback: policy?.allow_local_fallback ?? false,
      requireFullProviderSupport: policy?.require_full_provider_support ?? false,
    },
    diagnostics: {
      derivedOnDemand: true,
      persistedSnapshotAvailable: false,
      activeBindingCount: matchingBindings.length,
      appliedDocumentVersionIds: matchingBindings.map((row) => row.version_id),
    },
  });
});

sharedContextRoutes.post('/enterprises/:enterpriseId/workspaces', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{ name?: string }>(c);
  const name = body?.name?.trim();
  if (!name) return c.json({ error: 'name_required' }, 400);

  const workspaceId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO shared_context_workspaces (id, enterprise_id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)',
    [workspaceId, enterpriseId, name, auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.workspace_created', details: { enterpriseId, workspaceId, name } }, c.env.DB);
  return c.json({ id: workspaceId, enterpriseId, name }, 201);
});

sharedContextRoutes.post('/enterprises/:enterpriseId/repository-aliases', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{ canonicalRepoId?: string; aliasRepoId?: string; reason?: RepositoryAliasReason }>(c);
  const canonicalRepoId = body?.canonicalRepoId?.trim();
  const aliasRepoId = body?.aliasRepoId?.trim();
  const reason = body?.reason ?? 'ssh-https-equivalent';
  if (!canonicalRepoId || !aliasRepoId) return c.json({ error: 'invalid_alias' }, 400);
  if (!isRepositoryAliasReason(reason)) return c.json({ error: 'invalid_alias_reason' }, 400);
  const validation = validateRepositoryAliasMutation(canonicalRepoId, aliasRepoId, reason);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const aliasId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO shared_context_repository_aliases (id, enterprise_id, canonical_repo_id, alias_repo_id, reason, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [aliasId, enterpriseId, canonicalRepoId, aliasRepoId, reason, auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.repository_alias_created', details: { enterpriseId, canonicalRepoId, aliasRepoId, reason } }, c.env.DB);
  return c.json({ id: aliasId, enterpriseId, canonicalRepoId, aliasRepoId, reason }, 201);
});

sharedContextRoutes.post('/enterprises/:enterpriseId/projects/enroll', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{
    canonicalRepoId?: string;
    displayName?: string;
    workspaceId?: string | null;
    scope?: AuthoredContextScope;
  }>(c);
  const canonicalRepoId = body?.canonicalRepoId?.trim();
  if (!canonicalRepoId) return c.json({ error: 'canonical_repo_id_required' }, 400);
  const scope = body?.scope ?? 'project_shared';
  if (!isAuthoredContextScope(scope)) return c.json({ error: 'invalid_scope' }, 400);

  const enrollmentId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO shared_project_enrollments (id, enterprise_id, workspace_id, canonical_repo_id, display_name, scope, status, auto_enabled_for_members, member_opt_out_allowed, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, FALSE, $8, $9, $9)',
    [enrollmentId, enterpriseId, body?.workspaceId ?? null, canonicalRepoId, body?.displayName?.trim() ?? null, scope, 'active', auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.project_enrolled', details: { enterpriseId, enrollmentId, canonicalRepoId, scope } }, c.env.DB);
  return c.json({
    id: enrollmentId,
    enterpriseId,
    workspaceId: body?.workspaceId ?? null,
    canonicalRepoId,
    displayName: body?.displayName?.trim() ?? null,
    scope,
    status: 'active',
    memberPolicy: { autoEnabledForMembers: true, memberOptOutAllowed: false },
  }, 201);
});

sharedContextRoutes.post('/projects/:enrollmentId/pending-removal', async (c) => {
  const enrollmentId = c.req.param('enrollmentId');
  const enrollment = await c.env.DB.queryOne<{ enterprise_id: string }>(
    'SELECT enterprise_id FROM shared_project_enrollments WHERE id = $1',
    [enrollmentId],
  );
  if (!enrollment) return c.json({ error: 'not_found' }, 404);
  const auth = await requireEnterpriseRole(c, enrollment.enterprise_id, 'admin');
  if (auth instanceof Response) return auth;
  const now = Date.now();
  await c.env.DB.execute(
    "UPDATE shared_project_enrollments SET status = 'pending_removal', updated_at = $1 WHERE id = $2",
    [now, enrollmentId],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.project_pending_removal', details: { enterpriseId: enrollment.enterprise_id, enrollmentId } }, c.env.DB);
  return c.json({ ok: true, enrollmentId, status: 'pending_removal' });
});

sharedContextRoutes.post('/projects/:enrollmentId/remove', async (c) => {
  const enrollmentId = c.req.param('enrollmentId');
  const enrollment = await c.env.DB.queryOne<{ enterprise_id: string }>(
    'SELECT enterprise_id FROM shared_project_enrollments WHERE id = $1',
    [enrollmentId],
  );
  if (!enrollment) return c.json({ error: 'not_found' }, 404);
  const auth = await requireEnterpriseRole(c, enrollment.enterprise_id, 'admin');
  if (auth instanceof Response) return auth;
  const now = Date.now();
  await c.env.DB.execute(
    "UPDATE shared_project_enrollments SET status = 'removed', updated_at = $1 WHERE id = $2",
    [now, enrollmentId],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.project_removed', details: { enterpriseId: enrollment.enterprise_id, enrollmentId } }, c.env.DB);
  return c.json({ ok: true, enrollmentId, status: 'removed' });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/projects/visibility', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const canonicalRepoId = c.req.query('canonicalRepoId')?.trim();
  if (!canonicalRepoId) return c.json({ error: 'canonical_repo_id_required' }, 400);

  const enrollment = await c.env.DB.queryOne<{ id: string; status: EnrollmentVisibilityState }>(
    'SELECT id, status FROM shared_project_enrollments WHERE enterprise_id = $1 AND canonical_repo_id = $2',
    [enterpriseId, canonicalRepoId],
  );
  const remoteProjection = await c.env.DB.queryOne<{ id: string }>(
    'SELECT id FROM shared_context_projections WHERE enterprise_id = $1 AND project_id = $2 LIMIT 1',
    [enterpriseId, canonicalRepoId],
  );
  const visibility = computeVisibility(enrollment?.status ?? 'unenrolled', !!remoteProjection);

  return c.json({
    enterpriseId,
    canonicalRepoId,
    enrollmentId: enrollment?.id ?? null,
    remoteProcessedPresent: !!remoteProjection,
    ...visibility,
  });
});

sharedContextRoutes.delete('/enterprises/:enterpriseId/memory/:memoryId', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const memoryId = c.req.param('memoryId');
  if (!memoryId) return c.json({ error: 'missing_memory_id' }, 400);
  const auth = await requireEnterpriseRole(c, enterpriseId, 'admin');
  if (auth instanceof Response) return auth;
  const deleted = await deleteEnterpriseMemoryProjection(c.env.DB, enterpriseId, memoryId);
  if (!deleted) return c.json({ error: 'not_found' }, 404);
  await logAudit({ userId: auth.userId, action: 'shared_context.enterprise_memory_deleted', details: { enterpriseId, memoryId } }, c.env.DB);
  return c.json({ ok: true, id: memoryId });
});

sharedContextRoutes.get('/enterprises/:enterpriseId/memory', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const canonicalRepoId = c.req.query('canonicalRepoId')?.trim();
  const projectionClass = c.req.query('projectionClass') === 'recent_summary' || c.req.query('projectionClass') === 'durable_memory_candidate'
    ? c.req.query('projectionClass') as 'recent_summary' | 'durable_memory_candidate'
    : undefined;
  const query = c.req.query('query')?.trim();
  const limit = Math.max(1, Math.min(100, Number.parseInt(c.req.query('limit') ?? '20', 10) || 20));

  if (query) {
    const semanticView = await searchSemanticMemoryView({
      db: c.env.DB,
      userId: auth.userId,
      scope: 'enterprise',
      enterpriseId,
      query,
      projectId: canonicalRepoId || undefined,
      projectionClass,
      limit,
    });
    if (semanticView) return c.json(semanticView);
  }

  if (!query) {
    const stats = await c.env.DB.queryOne<MemoryStatsRow>(
      `SELECT COUNT(*)::int AS total_records,
              COUNT(*) FILTER (WHERE projection_class = 'recent_summary')::int AS recent_summary_count,
              COUNT(*) FILTER (WHERE projection_class = 'durable_memory_candidate')::int AS durable_candidate_count,
              COUNT(DISTINCT project_id)::int AS project_count
       FROM shared_context_projections
       WHERE enterprise_id = $1
         ${canonicalRepoId ? 'AND project_id = $2' : ''}
         ${projectionClass ? `AND projection_class = $${canonicalRepoId ? 3 : 2}` : ''}`,
      [enterpriseId, ...(canonicalRepoId ? [canonicalRepoId] : []), ...(projectionClass ? [projectionClass] : [])],
    );
    const rows = await c.env.DB.query<MemoryRecordRow>(
      `SELECT id, scope, project_id, projection_class, source_event_ids_json, summary, updated_at, hit_count, last_used_at, status
       FROM shared_context_projections
       WHERE enterprise_id = $1
         ${canonicalRepoId ? 'AND project_id = $2' : ''}
         ${projectionClass ? `AND projection_class = $${canonicalRepoId ? 3 : 2}` : ''}
       ORDER BY updated_at DESC
       LIMIT $${canonicalRepoId ? (projectionClass ? 4 : 3) : (projectionClass ? 3 : 2)}`,
      [enterpriseId, ...(canonicalRepoId ? [canonicalRepoId] : []), ...(projectionClass ? [projectionClass] : []), limit],
    );
    const projectRows = await c.env.DB.query<MemoryProjectStatsRow>(
      `SELECT project_id,
              COUNT(*)::int AS total_records,
              COUNT(*) FILTER (WHERE projection_class = 'recent_summary')::int AS recent_summary_count,
              COUNT(*) FILTER (WHERE projection_class = 'durable_memory_candidate')::int AS durable_candidate_count,
              MAX(updated_at) AS updated_at
       FROM shared_context_projections
       WHERE enterprise_id = $1
         ${canonicalRepoId ? 'AND project_id = $2' : ''}
         ${projectionClass ? `AND projection_class = $${canonicalRepoId ? 3 : 2}` : ''}
       GROUP BY project_id
       ORDER BY MAX(updated_at) DESC
       LIMIT 200`,
      [enterpriseId, ...(canonicalRepoId ? [canonicalRepoId] : []), ...(projectionClass ? [projectionClass] : [])],
    );
    return c.json({
      stats: buildMemoryStatsView(stats, stats?.total_records ?? 0),
      records: mapMemoryRecordRows(rows.filter((row) => !isMemoryNoiseSummary(row.summary))),
      projects: mapMemoryProjectRows(projectRows),
    });
  }

  const rows = await c.env.DB.query<{
    id: string;
    scope: AuthoredContextScope;
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
    hit_count?: number | null;
    last_used_at?: number | null;
    status?: 'active' | 'archived' | null;
  }>(
    `SELECT id, scope, project_id, projection_class, source_event_ids_json, summary, content_json, updated_at, hit_count, last_used_at, status
     FROM shared_context_projections
     WHERE enterprise_id = $1
       ${canonicalRepoId ? 'AND project_id = $2' : ''}
       ${projectionClass ? `AND projection_class = $${canonicalRepoId ? 3 : 2}` : ''}
     ORDER BY updated_at DESC`,
    [enterpriseId, ...(canonicalRepoId ? [canonicalRepoId] : []), ...(projectionClass ? [projectionClass] : [])],
  );
  return c.json(buildSharedMemoryResponse(rows, query, limit));
});

sharedContextRoutes.put('/projects/:enrollmentId/policy', async (c) => {
  const enrollmentId = c.req.param('enrollmentId');
  const enrollment = await c.env.DB.queryOne<{ enterprise_id: string }>(
    'SELECT enterprise_id FROM shared_project_enrollments WHERE id = $1',
    [enrollmentId],
  );
  if (!enrollment) return c.json({ error: 'not_found' }, 404);
  const auth = await requireEnterpriseRole(c, enrollment.enterprise_id, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{
    allowDegradedProviderSupport?: boolean;
    allowLocalFallback?: boolean;
    requireFullProviderSupport?: boolean;
  }>(c);
  const overrideId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO shared_scope_policy_overrides (id, enterprise_id, enrollment_id, allow_degraded_provider_support, allow_local_fallback, require_full_provider_support, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) ON CONFLICT (enrollment_id) DO UPDATE SET allow_degraded_provider_support = excluded.allow_degraded_provider_support, allow_local_fallback = excluded.allow_local_fallback, require_full_provider_support = excluded.require_full_provider_support, updated_at = excluded.updated_at, created_by = excluded.created_by',
    [overrideId, enrollment.enterprise_id, enrollmentId, !!body?.allowDegradedProviderSupport, !!body?.allowLocalFallback, !!body?.requireFullProviderSupport, auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.policy_override_upserted', details: { enterpriseId: enrollment.enterprise_id, enrollmentId } }, c.env.DB);
  return c.json({
    enterpriseId: enrollment.enterprise_id,
    enrollmentId,
    allowDegradedProviderSupport: !!body?.allowDegradedProviderSupport,
    allowLocalFallback: !!body?.allowLocalFallback,
    requireFullProviderSupport: !!body?.requireFullProviderSupport,
  });
});

sharedContextRoutes.post('/enterprises/:enterpriseId/documents', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{ kind?: DocumentKind; title?: string }>(c);
  const title = body?.title?.trim();
  if (!title || !isDocumentKind(body?.kind)) return c.json({ error: 'invalid_document' }, 400);

  const documentId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO shared_context_documents (id, enterprise_id, kind, title, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
    [documentId, enterpriseId, body.kind, title, auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.document_created', details: { enterpriseId, documentId, kind: body.kind } }, c.env.DB);
  return c.json({ id: documentId, enterpriseId, kind: body.kind, title }, 201);
});

sharedContextRoutes.post('/documents/:documentId/versions', async (c) => {
  const documentId = c.req.param('documentId');
  const document = await c.env.DB.queryOne<{ enterprise_id: string }>(
    'SELECT enterprise_id FROM shared_context_documents WHERE id = $1',
    [documentId],
  );
  if (!document) return c.json({ error: 'not_found' }, 404);
  const auth = await requireEnterpriseRole(c, document.enterprise_id, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{ contentMd?: string; label?: string }>(c);
  const contentMd = body?.contentMd?.trim();
  if (!contentMd) return c.json({ error: 'content_required' }, 400);

  const versionId = randomHex(16);
  const now = Date.now();
  const count = await c.env.DB.query<{ id: string }>(
    'SELECT id FROM shared_context_document_versions WHERE document_id = $1',
    [documentId],
  );
  const versionNumber = count.length + 1;
  await c.env.DB.execute(
    "INSERT INTO shared_context_document_versions (id, document_id, version_number, label, content_md, status, created_by, created_at) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)",
    [versionId, documentId, versionNumber, body?.label?.trim() ?? null, contentMd, auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.document_version_created', details: { documentId, versionId, versionNumber } }, c.env.DB);
  return c.json({ id: versionId, documentId, versionNumber, status: 'draft' }, 201);
});

sharedContextRoutes.post('/document-versions/:versionId/activate', async (c) => {
  const versionId = c.req.param('versionId');
  const version = await c.env.DB.queryOne<{ document_id: string; enterprise_id: string }>(
    'SELECT v.document_id, d.enterprise_id FROM shared_context_document_versions v JOIN shared_context_documents d ON d.id = v.document_id WHERE v.id = $1',
    [versionId],
  );
  if (!version) return c.json({ error: 'not_found' }, 404);
  const auth = await requireEnterpriseRole(c, version.enterprise_id, 'admin');
  if (auth instanceof Response) return auth;
  const now = Date.now();
  await c.env.DB.execute(
    "UPDATE shared_context_document_versions SET status = CASE WHEN id = $1 THEN 'active' ELSE CASE WHEN document_id = $2 AND status = 'active' THEN 'superseded' ELSE status END END, activated_at = CASE WHEN id = $1 THEN $3 ELSE activated_at END WHERE document_id = $2",
    [versionId, version.document_id, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.document_version_activated', details: { documentId: version.document_id, versionId } }, c.env.DB);
  return c.json({ ok: true, versionId, status: 'active' });
});

sharedContextRoutes.post('/enterprises/:enterpriseId/document-bindings', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'admin');
  if (auth instanceof Response) return auth;
  const body = await readJsonBody<{
    documentId?: string;
    versionId?: string;
    workspaceId?: string | null;
    enrollmentId?: string | null;
    mode?: BindingMode;
    applicabilityRepoId?: string | null;
    applicabilityLanguage?: string | null;
    applicabilityPathPattern?: string | null;
  }>(c);
  if (!body?.documentId || !body?.versionId || !isBindingMode(body?.mode)) return c.json({ error: 'invalid_binding' }, 400);
  const bindingScope = authoredContextScopeForBinding({
    workspaceId: body.workspaceId,
    enrollmentId: body.enrollmentId,
  });
  if (bindingScope === 'org_shared' && !isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.orgSharedAuthoredStandards)) {
    return sameShapeNotFound(c);
  }
  const bindingId = randomHex(16);
  const now = Date.now();
  await c.env.DB.execute(
    "INSERT INTO shared_context_document_bindings (id, enterprise_id, workspace_id, enrollment_id, document_id, version_id, binding_mode, applicability_repo_id, applicability_language, applicability_path_pattern, status, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12)",
    [bindingId, enterpriseId, body.workspaceId ?? null, body.enrollmentId ?? null, body.documentId, body.versionId, body.mode, body.applicabilityRepoId ?? null, body.applicabilityLanguage ?? null, body.applicabilityPathPattern ?? null, auth.userId, now],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.document_binding_created', details: { enterpriseId, bindingId, documentId: body.documentId, versionId: body.versionId } }, c.env.DB);
  return c.json({
    id: bindingId,
    enterpriseId,
    workspaceId: body.workspaceId ?? null,
    enrollmentId: body.enrollmentId ?? null,
    scope: bindingScope,
    documentId: body.documentId,
    versionId: body.versionId,
    mode: body.mode,
    status: 'active',
  }, 201);
});

sharedContextRoutes.post('/document-bindings/:bindingId/deactivate', async (c) => {
  const bindingId = c.req.param('bindingId');
  const binding = await c.env.DB.queryOne<{
    enterprise_id: string;
    workspace_id: string | null;
    enrollment_id: string | null;
  }>(
    'SELECT enterprise_id, workspace_id, enrollment_id FROM shared_context_document_bindings WHERE id = $1',
    [bindingId],
  );
  if (!binding) return sameShapeNotFound(c);
  const bindingScope = authoredContextScopeForBinding({
    workspaceId: binding.workspace_id,
    enrollmentId: binding.enrollment_id,
  });
  if (bindingScope === 'org_shared' && !isMemoryFeatureEnabled(c.env, MEMORY_FEATURES.orgSharedAuthoredStandards)) {
    return sameShapeNotFound(c);
  }
  const auth = await requireEnterpriseRole(c, binding.enterprise_id, 'admin');
  if (auth instanceof Response) return auth;
  const now = Date.now();
  await c.env.DB.execute(
    "UPDATE shared_context_document_bindings SET status = 'inactive', deactivated_at = $1 WHERE id = $2",
    [now, bindingId],
  );
  await logAudit({ userId: auth.userId, action: 'shared_context.document_binding_deactivated', details: { enterpriseId: binding.enterprise_id, bindingId } }, c.env.DB);
  return c.json({ ok: true, bindingId, status: 'inactive' });
});

// ── Memory recall — pgvector cosine search with pg_trgm fallback ────────────

/**
 * POST /:id/shared-context/memory/recall
 * Searches personal + enterprise memory using pgvector embedding similarity.
 * Falls back to pg_trgm when embedding model is unavailable.
 * Used by daemon send path to auto-inject relevant memories into agent prompts.
 */
sharedContextRoutes.post('/:id/shared-context/memory/recall', async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('id')!;
  const role = await resolveServerRole(c.env.DB, serverId, userId);
  if (role === 'none') return c.json({ error: 'forbidden' }, 403);
  const runtimeConfigRow = await c.env.DB.queryOne<{ shared_context_runtime_config: Record<string, unknown> | string | null }>(
    'SELECT shared_context_runtime_config FROM servers WHERE id = $1',
    [serverId],
  );
  const runtimeConfig = normalizeSharedContextRuntimeConfig(
    typeof runtimeConfigRow?.shared_context_runtime_config === 'string'
      ? JSON.parse(runtimeConfigRow.shared_context_runtime_config)
      : runtimeConfigRow?.shared_context_runtime_config,
  );

  let body: { query: string; projectId?: string; limit?: number };
  try {
    body = await c.req.json() as typeof body;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { query, projectId, limit: rawLimit } = body;
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return c.json({ error: 'query_required' }, 400);
  }
  // Template-prompt skip: OpenSpec / slash-command / skill-template queries
  // are not natural-language requests; a recall over them returns noise.
  // See shared/template-prompt-patterns.ts.
  if (isTemplatePrompt(query)) {
    return c.json({ results: [], vectorSearch: false, skipped: 'template_prompt' });
  }
  // Imperative-command skip: short ops directives ("commit&push", "redeploy",
  // "continue") are task-control verbs, not semantic queries. Running recall
  // on them wastes candidates on the current task's own logs.
  if (isImperativeCommand(query)) {
    return c.json({ results: [], vectorSearch: false, skipped: 'imperative_command' });
  }
  const limit = typeof rawLimit === 'number' && rawLimit > 0 ? Math.min(rawLimit, 20) : 5;
  const candidateLimit = Math.max(limit * 4, 20);

  // Try vector search first, fall back to pg_trgm
  const { generateEmbedding, embeddingToSql } = await import('../util/embedding.js');
  const queryEmbedding = await generateEmbedding(query);

  type RecallRow = {
    id: string;
    project_id: string;
    projection_class: ProjectionClass;
    summary: string;
    updated_at: number;
    score: number;
    hit_count?: number | null;
    last_used_at?: number | null;
    enterprise_id?: string | null;
  };

  let currentEnterpriseId: string | undefined;
  if (projectId) {
    const enterpriseRow = await c.env.DB.queryOne<{ enterprise_id: string }>(
      `SELECT e.enterprise_id
       FROM shared_project_enrollments e
       JOIN team_members tm ON tm.team_id = e.enterprise_id AND tm.user_id = $1
       WHERE e.canonical_repo_id = $2
         AND e.status = 'active'
       LIMIT 1`,
      [userId, projectId],
    );
    currentEnterpriseId = enterpriseRow?.enterprise_id;
  }

  let personalRows: RecallRow[];
  let enterpriseRows: RecallRow[];

  if (queryEmbedding) {
    const vecSql = embeddingToSql(queryEmbedding);

    // pgvector cosine distance: <=> returns distance (0 = identical), convert to similarity
    personalRows = await c.env.DB.query<RecallRow>(
      `SELECT p.id, p.project_id, p.projection_class, p.summary, p.updated_at,
              p.hit_count, p.last_used_at, p.enterprise_id,
              1 - (e.embedding <=> $1::vector) AS score
       FROM shared_context_projections p
       JOIN shared_context_embeddings e ON e.source_id = p.id AND e.source_kind = 'projection'
       WHERE p.scope = 'personal' AND p.user_id = $2
         AND COALESCE(p.status, 'active') = 'active'
         ${projectId ? 'AND p.project_id = $3' : ''}
       ORDER BY e.embedding <=> $1::vector
       LIMIT $${projectId ? 4 : 3}`,
      [vecSql, userId, ...(projectId ? [projectId] : []), candidateLimit],
    );

    enterpriseRows = await c.env.DB.query<RecallRow>(
      `SELECT p.id, p.project_id, p.projection_class, p.summary, p.updated_at,
              p.hit_count, p.last_used_at,
              1 - (e.embedding <=> $1::vector) AS score, p.enterprise_id
       FROM shared_context_projections p
       JOIN shared_context_embeddings e ON e.source_id = p.id AND e.source_kind = 'projection'
       JOIN team_members tm ON tm.team_id = p.enterprise_id AND tm.user_id = $2
       JOIN unnest($3::text[]) AS allowed_scope(scope) ON allowed_scope.scope = p.scope
       WHERE COALESCE(p.status, 'active') = 'active'
         ${projectId ? 'AND p.project_id = $4' : ''}
       ORDER BY e.embedding <=> $1::vector
       LIMIT $${projectId ? 5 : 4}`,
      [vecSql, userId, [...REPLICABLE_SHARED_PROJECTION_SCOPES], ...(projectId ? [projectId] : []), candidateLimit],
    );
  } else {
    // Fallback: pg_trgm text similarity (for when embedding model is unavailable)
    personalRows = await c.env.DB.query<RecallRow>(
      `SELECT id, project_id, projection_class, summary, updated_at,
              hit_count, last_used_at, enterprise_id,
              similarity(summary, $1) AS score
       FROM shared_context_projections
       WHERE scope = 'personal' AND user_id = $2
         AND COALESCE(status, 'active') = 'active'
         ${projectId ? 'AND project_id = $3' : ''}
         AND summary % $1
       ORDER BY score DESC
       LIMIT $${projectId ? 4 : 3}`,
      [query, userId, ...(projectId ? [projectId] : []), candidateLimit],
    );

    enterpriseRows = await c.env.DB.query<RecallRow>(
      `SELECT p.id, p.project_id, p.projection_class, p.summary, p.updated_at,
              p.hit_count, p.last_used_at,
              similarity(p.summary, $1) AS score, p.enterprise_id
       FROM shared_context_projections p
       JOIN team_members tm ON tm.team_id = p.enterprise_id AND tm.user_id = $2
       JOIN unnest($3::text[]) AS allowed_scope(scope) ON allowed_scope.scope = p.scope
       WHERE COALESCE(p.status, 'active') = 'active'
         ${projectId ? 'AND p.project_id = $4' : ''}
         AND p.summary % $1
       ORDER BY score DESC
       LIMIT $${projectId ? 5 : 4}`,
      [query, userId, [...REPLICABLE_SHARED_PROJECTION_SCOPES], ...(projectId ? [projectId] : []), candidateLimit],
    );
  }

  // Merge, deduplicate by id, sort by composite relevance score.
  // Result-side template filter: legacy projections whose summary reflects
  // a templated workflow origin must not leak back through recall.
  const seen = new Set<string>();
  const currentProjectId = projectId ?? '__unknown_current_project__';
  const results: Array<{ id: string; projectId: string; class: string; summary: string; updatedAt: number; score: number; source: 'personal' | 'enterprise' }> = [];
  for (const row of personalRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (isTemplateOriginSummary(row.summary) || isMemoryNoiseSummary(row.summary)) continue;
    results.push({
      id: row.id,
      projectId: row.project_id,
      class: row.projection_class,
      summary: row.summary,
      updatedAt: row.updated_at,
      score: computeRelevanceScore({
        similarity: row.score,
        lastUsedAt: row.last_used_at ?? row.updated_at,
        hitCount: row.hit_count ?? 0,
        projectionClass: row.projection_class,
        memoryProjectId: row.project_id,
        currentProjectId,
      }, runtimeConfig.memoryScoringWeights),
      source: 'personal',
    });
  }
  for (const row of enterpriseRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (isTemplateOriginSummary(row.summary) || isMemoryNoiseSummary(row.summary)) continue;
    results.push({
      id: row.id,
      projectId: row.project_id,
      class: row.projection_class,
      summary: row.summary,
      updatedAt: row.updated_at,
      score: computeRelevanceScore({
        similarity: row.score,
        lastUsedAt: row.last_used_at ?? row.updated_at,
        hitCount: row.hit_count ?? 0,
        projectionClass: row.projection_class,
        memoryProjectId: row.project_id,
        currentProjectId,
        memoryEnterpriseId: row.enterprise_id ?? undefined,
        currentEnterpriseId,
      }, runtimeConfig.memoryScoringWeights),
      source: 'enterprise',
    });
  }
  // Content-level dedup: projections stored before the writer's store-time
  // dedup landed (or from historical daemons) can produce multiple rows with
  // the same (class, normalized-summary) but different IDs. ID-based dedup
  // above cannot merge them, so they'd surface as three identical
  // Related-history cards at the same score. Collapse by normalized summary
  // here — keep the highest-scoring representative, then prefer personal
  // over enterprise on ties (personal is closer to the current user's work).
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.source !== b.source) return a.source === 'personal' ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
  const seenFingerprints = new Set<string>();
  const dedupedResults: typeof results = [];
  for (const entry of results) {
    const fp = `${entry.class}\u0000${normalizeSummaryForFingerprint(entry.summary)}`;
    if (seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    dedupedResults.push(entry);
  }

  // Cap rule: configurable floor (default 0.4), top 3, extend to 5 iff all >= 0.6.
  // See shared/memory-scoring.ts. The client-supplied `limit` is an upper
  // bound on the extend cap — a client asking for <=3 shrinks defaultCap;
  // a client asking for >=5 keeps the default extend cap.
  const cappedDefault = Math.min(limit, 3);
  const cappedExtend = Math.min(Math.max(limit, cappedDefault), 5);
  const topResults = applyRecallCapRule(dedupedResults, {
    minFloor: runtimeConfig.memoryRecallMinScore,
    defaultCap: cappedDefault,
    extendCap: cappedExtend,
  });

  // Record hits only for projections that actually survived the cap rule —
  // items dropped by floor or session-side filtering never reached the
  // user's prompt and should not receive a spaced-repetition credit.
  const hitIds = topResults.map((r) => r.id);
  if (hitIds.length > 0) {
    const now = Date.now();
    const placeholders = hitIds.map((_, i) => `$${i + 2}`).join(', ');
    c.env.DB.execute(
      `UPDATE shared_context_projections SET hit_count = hit_count + 1, last_used_at = $1 WHERE id IN (${placeholders})`,
      [now, ...hitIds],
    ).catch(() => { /* non-fatal */ });
  }

  return c.json({ results: topResults, vectorSearch: !!queryEmbedding });
});
