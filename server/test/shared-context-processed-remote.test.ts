import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sha256Hex } from '../src/security/crypto.js';
import { serverRoutes } from '../src/routes/server.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

function makeMockDb() {
  const projectionRows: Array<Record<string, unknown>> = [];
  const recordRows: Array<Record<string, unknown>> = [];
  const aliasRows: Array<Record<string, unknown>> = [];
  const authoredBindingRows = [
    {
      binding_id: 'binding-project',
      version_id: 'doc-v2',
      binding_mode: 'required',
      scope: 'project_shared',
      applicability_repo_id: 'github.com/acme/repo',
      applicability_language: 'typescript',
      applicability_path_pattern: 'src/**',
      content_md: 'Project coding standard',
    },
    {
      binding_id: 'binding-org',
      version_id: 'doc-v1',
      binding_mode: 'advisory',
      scope: 'org_shared',
      applicability_repo_id: null,
      applicability_language: null,
      applicability_path_pattern: null,
      content_md: 'Org architecture guideline',
    },
  ];
  const validTokenHash = sha256Hex('daemon-token');

  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('select id, team_id from servers where token_hash = $1 and id = $2')) {
        if (params[0] === validTokenHash && params[1] === 'srv-1') {
          return { id: 'srv-1', team_id: 'ent-1' } as T;
        }
        return null;
      }
      if (normalized.includes('select id from servers where token_hash = $1 and id = $2')) {
        if (params[0] === validTokenHash && params[1] === 'srv-1') {
          return { id: 'srv-1' } as T;
        }
        return null;
      }
      if (normalized.includes('select id, enterprise_id, workspace_id, scope, status from shared_project_enrollments where enterprise_id = $1 and canonical_repo_id = $2')) {
        if (params[0] === 'ent-1' && params[1] === 'github.com/acme/repo') {
          return {
            id: 'enr-1',
            enterprise_id: 'ent-1',
            workspace_id: 'ws-1',
            scope: 'project_shared',
            status: 'active',
          } as T;
        }
        return null;
      }
      if (normalized.includes('select allow_degraded_provider_support, allow_local_fallback, require_full_provider_support from shared_scope_policy_overrides where enrollment_id = $1')) {
        if (params[0] === 'enr-1') {
          return {
            allow_degraded_provider_support: true,
            allow_local_fallback: false,
            require_full_provider_support: false,
          } as T;
        }
        return null;
      }
      if (normalized.includes('select id, updated_at from shared_context_projections where enterprise_id = $1 and project_id = $2 order by updated_at desc limit 1')) {
        if (params[0] === 'ent-1' && params[1] === 'github.com/acme/repo') {
          return { id: 'projection-1', updated_at: Date.now() } as T;
        }
        return null;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('from shared_context_document_bindings b join shared_context_document_versions v on v.id = b.version_id')) {
        if (params[0] !== 'ent-1' || params[2] !== 'github.com/acme/repo') return [] as T[];
        return authoredBindingRows as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalized.includes('insert into shared_context_projections')) {
        projectionRows.push({
          id: params[0],
          server_id: params[1],
          scope: params[2],
          enterprise_id: params[3],
          workspace_id: params[4],
          user_id: params[5],
          project_id: params[6],
          projection_class: params[7],
        });
        return { changes: 1 };
      }
      if (normalized.includes('insert into shared_context_records')) {
        recordRows.push({
          id: params[0],
          projection_id: params[1],
          server_id: params[2],
          project_id: params[7],
          record_class: params[8],
        });
        return { changes: 1 };
      }
      if (normalized.includes('insert into shared_context_repository_aliases')) {
        aliasRows.push({ id: params[0] });
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  return { db, projectionRows, recordRows, aliasRows };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    SERVER_URL: 'http://localhost:3000',
    NODE_ENV: 'test',
  } as Env;
}

describe('shared-context processed remote route', () => {
  it('accepts daemon-authenticated processed projections and mirrors durable candidates into records', async () => {
    const { db, projectionRows, recordRows, aliasRows } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/processed', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
        },
        projections: [
          {
            id: 'proj-1',
            namespace: {
              scope: 'project_shared',
              projectId: 'github.com/acme/repo',
              enterpriseId: 'ent-1',
            },
            class: 'recent_summary',
            sourceEventIds: ['evt-1'],
            summary: 'summary',
            content: { foo: 'bar' },
            createdAt: 100,
            updatedAt: 110,
          },
          {
            id: 'proj-2',
            namespace: {
              scope: 'project_shared',
              projectId: 'github.com/acme/repo',
              enterpriseId: 'ent-1',
            },
            class: 'durable_memory_candidate',
            sourceEventIds: ['evt-2'],
            summary: 'decision',
            content: { kind: 'decision' },
            createdAt: 120,
            updatedAt: 130,
          },
        ],
      }),
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      projectionCount: 2,
    }));
    expect(projectionRows).toHaveLength(2);
    expect(recordRows).toEqual([
      expect.objectContaining({
        projection_id: 'proj-2',
        record_class: 'durable_memory_candidate',
      }),
    ]);
    expect(aliasRows).toHaveLength(0);
  });

  it('rejects invalid daemon token or malformed payload', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const unauthorized = await app.request('/api/server/srv-1/shared-context/processed', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    }, makeEnv(db));
    expect(unauthorized.status).toBe(401);

    const invalid = await app.request('/api/server/srv-1/shared-context/processed', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ namespace: { scope: 'personal', projectId: 'repo' }, projections: [] }),
    }, makeEnv(db));
    expect(invalid.status).toBe(400);
  });

  it('returns backend-managed authored bindings for shared namespaces only', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/authored-bindings', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        namespace: {
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          enterpriseId: 'ent-1',
          workspaceId: 'ws-1',
        },
        language: 'typescript',
        filePath: 'src/runtime.ts',
      }),
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bindings: [
        expect.objectContaining({
          bindingId: 'binding-project',
          documentVersionId: 'doc-v2',
          mode: 'required',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          language: 'typescript',
          pathPattern: 'src/**',
          content: 'Project coding standard',
          active: true,
        }),
        expect.objectContaining({
          bindingId: 'binding-org',
          documentVersionId: 'doc-v1',
          mode: 'advisory',
          scope: 'org_shared',
          content: 'Org architecture guideline',
          active: true,
        }),
      ],
    });
  });

  it('resolves daemon-authenticated shared namespace from active enrollment state', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/resolve-namespace', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ canonicalRepoId: 'github.com/acme/repo' }),
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
        workspaceId: 'ws-1',
      },
      canonicalRepoId: 'github.com/acme/repo',
      visibilityState: 'active',
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: {
        allowDegradedProvider: true,
        allowLocalProcessedFallback: false,
        requireFullProviderSupport: false,
      },
      diagnostics: ['visibility:active', 'remote-processed:fresh'],
    });
  });

  it('marks daemon-authenticated shared namespace as stale when the latest remote projection is older than the freshness cutoff', async () => {
    const now = Date.now();
    const { db } = makeMockDb();
    const staleDb: Database = {
      ...db,
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.includes('select id, updated_at from shared_context_projections where enterprise_id = $1 and project_id = $2 order by updated_at desc limit 1')) {
          if (params[0] === 'ent-1' && params[1] === 'github.com/acme/repo') {
            return { id: 'projection-1', updated_at: now - (7 * 60 * 60 * 1000) } as T;
          }
        }
        return db.queryOne<T>(sql, params);
      },
    } as Database;
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/resolve-namespace', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ canonicalRepoId: 'github.com/acme/repo' }),
    }, makeEnv(staleDb));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      remoteProcessedFreshness: 'stale',
      diagnostics: ['visibility:active', 'remote-processed:stale'],
    }));
  });
});
