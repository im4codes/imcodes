import { Hono, type Context } from 'hono';
import type { Env } from '../env.js';
import { requireAuth } from '../security/authorization.js';
import { randomHex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { parseRemoteUrl } from '../../../src/repo/detector.js';
import { parseCanonicalRepositoryKey } from '../../../src/agent/repository-identity-service.js';
import { classifyTimestampFreshness } from '../../../shared/context-freshness.js';
import type { ContextMemoryRecordView, ContextMemoryStatsView } from '../../../shared/context-types.js';

type EnterpriseRole = 'owner' | 'admin' | 'member';
type BindingMode = 'required' | 'advisory';
type DocumentKind = 'coding_standard' | 'architecture_guideline' | 'repo_playbook' | 'knowledge_doc';
type RepositoryAliasReason = 'ssh-https-equivalent' | 'explicit-migration';

export const sharedContextRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();
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
  if (!role) return c.json({ error: 'forbidden', reason: 'not_a_team_member' }, 403);
  const rank: Record<EnterpriseRole, number> = { owner: 3, admin: 2, member: 1 };
  if (rank[role] < rank[minRole]) {
    return c.json({ error: 'forbidden', required: minRole, actual: role }, 403);
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

function buildSharedMemoryResponse(
  rows: Array<{
    id: string;
    scope: 'project_shared' | 'workspace_shared' | 'org_shared';
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
  }>,
  query?: string,
  limit = 20,
): { stats: ContextMemoryStatsView; records: ContextMemoryRecordView[] } {
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
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
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

function matchesPathPattern(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPattern.endsWith('/**')) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -3));
  }
  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(normalizedPath);
  }
  return normalizedPattern === normalizedPath;
}

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
    if (!matchesPathPattern(row.applicability_path_pattern, filter.filePath)) return false;
  }
  return true;
}

sharedContextRoutes.use('*', requireAuth());

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
    scope: 'project_shared' | 'workspace_shared' | 'org_shared';
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
  return c.json({
    enterpriseId,
    bindings: rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      enrollmentId: row.enrollment_id,
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
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
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
      v.content
    FROM shared_context_document_bindings b
    JOIN shared_context_document_versions v ON v.id = b.version_id
    WHERE b.enterprise_id = $1 AND b.status = 'active' AND v.status = 'active'
    ORDER BY b.id ASC`,
    [enterpriseId],
  );

  const bindings = rows.filter((row) => matchesRuntimeAuthoredContextRow(row, {
    canonicalRepoId,
    workspaceId,
    enrollmentId,
    language,
    filePath,
  }));

  return c.json({
    enterpriseId,
    bindings: bindings.map((row) => ({
      bindingId: row.binding_id,
      documentVersionId: row.version_id,
      mode: row.binding_mode,
      scope: row.enrollment_id ? 'project_shared' : (row.workspace_id ? 'workspace_shared' : 'org_shared'),
      repository: row.applicability_repo_id ?? undefined,
      language: row.applicability_language ?? undefined,
      pathPattern: row.applicability_path_pattern ?? undefined,
      content: row.content,
      active: true,
      superseded: false,
    })),
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
      v.content
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
  const matchingBindings = bindings.filter((row) => matchesRuntimeAuthoredContextRow(row, {
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
    scope?: 'project_shared' | 'workspace_shared' | 'org_shared';
  }>(c);
  const canonicalRepoId = body?.canonicalRepoId?.trim();
  if (!canonicalRepoId) return c.json({ error: 'canonical_repo_id_required' }, 400);
  const scope = body?.scope ?? 'project_shared';
  if (!['project_shared', 'workspace_shared', 'org_shared'].includes(scope)) return c.json({ error: 'invalid_scope' }, 400);

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

sharedContextRoutes.get('/enterprises/:enterpriseId/memory', async (c) => {
  const enterpriseId = c.req.param('enterpriseId');
  const auth = await requireEnterpriseRole(c, enterpriseId, 'member');
  if (auth instanceof Response) return auth;
  const canonicalRepoId = c.req.query('canonicalRepoId')?.trim();
  const projectionClass = c.req.query('projectionClass')?.trim();
  const query = c.req.query('query')?.trim();
  const limit = Math.max(1, Math.min(100, Number.parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const rows = await c.env.DB.query<{
    id: string;
    scope: 'project_shared' | 'workspace_shared' | 'org_shared';
    project_id: string;
    projection_class: 'recent_summary' | 'durable_memory_candidate';
    source_event_ids_json: string | string[];
    summary: string;
    content_json: string | Record<string, unknown> | null;
    updated_at: number;
  }>(
    `SELECT id, scope, project_id, projection_class, source_event_ids_json, summary, content_json, updated_at
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
    documentId: body.documentId,
    versionId: body.versionId,
    mode: body.mode,
    status: 'active',
  }, 201);
});

sharedContextRoutes.post('/document-bindings/:bindingId/deactivate', async (c) => {
  const bindingId = c.req.param('bindingId');
  const binding = await c.env.DB.queryOne<{ enterprise_id: string }>(
    'SELECT enterprise_id FROM shared_context_document_bindings WHERE id = $1',
    [bindingId],
  );
  if (!binding) return c.json({ error: 'not_found' }, 404);
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
