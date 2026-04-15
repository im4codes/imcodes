import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sha256Hex } from '../src/security/crypto.js';
import { serverRoutes } from '../src/routes/server.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
}));

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
      if (normalized.includes('select id, team_id, user_id from servers where token_hash = $1 and id = $2')) {
        if (params[0] === validTokenHash && params[1] === 'srv-1') {
          return { id: 'srv-1', team_id: 'ent-1', user_id: 'user-1' } as T;
        }
        return null;
      }
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
      if (normalized.includes('select * from servers where id = $1')) {
        if (params[0] === 'srv-1') {
          return { id: 'srv-1', user_id: 'user-1', team_id: 'ent-1' } as T;
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
      if (normalized.includes("select id, updated_at from shared_context_projections where scope = 'personal' and user_id = $1 and project_id = $2 order by updated_at desc limit 1")) {
        if (params[0] === 'user-1' && params[1] === 'github.com/acme/repo') {
          return { id: 'personal-projection-1', updated_at: Date.now() } as T;
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
      if (normalized.includes("from shared_context_projections where server_id = $1 and user_id = $2 and scope = 'personal'")) {
        return [
          {
            id: 'personal-projection-1',
            scope: 'personal',
            project_id: 'github.com/acme/repo',
            projection_class: 'recent_summary',
            source_event_ids_json: ['evt-1', 'evt-2'],
            summary: 'Cloud personal summary',
            content_json: { note: 'personal cloud memory' },
            updated_at: 1700000000000,
          },
        ] as T[];
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
          scope: params[3],
          enterprise_id: params[4],
          workspace_id: params[5],
          user_id: params[6],
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

  it('sanitizes personal projections to the daemon owner and rejects mismatched namespace users', async () => {
    const { db, projectionRows, recordRows } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const okResponse = await app.request('/api/server/srv-1/shared-context/processed', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          userId: 'user-1',
        },
        projections: [
          {
            id: 'personal-proj-1',
            namespace: {
              scope: 'personal',
              projectId: 'github.com/acme/repo',
              userId: 'user-1',
              enterpriseId: 'wrong-ent',
              workspaceId: 'wrong-ws',
            },
            class: 'durable_memory_candidate',
            sourceEventIds: ['evt-1'],
            summary: 'personal summary',
            content: { foo: 'bar' },
            createdAt: 100,
            updatedAt: 110,
          },
        ],
      }),
    }, makeEnv(db));

    expect(okResponse.status).toBe(200);
    expect(projectionRows).toContainEqual(expect.objectContaining({
      id: 'personal-proj-1',
      scope: 'personal',
      enterprise_id: null,
      workspace_id: null,
      user_id: 'user-1',
      project_id: 'github.com/acme/repo',
    }));
    expect(recordRows).toContainEqual(expect.objectContaining({
      projection_id: 'personal-proj-1',
      scope: 'personal',
      enterprise_id: null,
      workspace_id: null,
      user_id: 'user-1',
    }));

    const forbidden = await app.request('/api/server/srv-1/shared-context/processed', {
      method: 'POST',
      headers: {
        authorization: 'Bearer daemon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        namespace: {
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          userId: 'user-other',
        },
        projections: [
          {
            id: 'personal-proj-2',
            namespace: {
              scope: 'personal',
              projectId: 'github.com/acme/repo',
              userId: 'user-other',
            },
            class: 'recent_summary',
            sourceEventIds: ['evt-2'],
            summary: 'mismatch',
            content: { foo: 'bar' },
            createdAt: 120,
            updatedAt: 130,
          },
        ],
      }),
    }, makeEnv(db));

    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({
      error: 'namespace_user_mismatch',
      projectionId: 'personal-proj-2',
    });
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
      retryExhausted: false,
      sharedPolicyOverride: {
        allowDegradedProvider: true,
        allowLocalProcessedFallback: false,
        requireFullProviderSupport: false,
      },
      diagnostics: ['visibility:active', 'remote-processed:fresh', 'remote-source:shared'],
    });
  });

  it('returns personal remote freshness and personal source diagnostics when the server has no enterprise enrollment', async () => {
    const { db } = makeMockDb();
    const personalDb: Database = {
      ...db,
      queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
        const normalized = sql.toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.includes('select id, team_id, user_id from servers where token_hash = $1 and id = $2')) {
          if (params[0] === sha256Hex('daemon-token') && params[1] === 'srv-1') {
            return { id: 'srv-1', team_id: null, user_id: 'user-1' } as T;
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
    }, makeEnv(personalDb));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      namespace: null,
      canonicalRepoId: 'github.com/acme/repo',
      visibilityState: 'unenrolled',
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      diagnostics: ['server-no-enterprise', 'remote-processed:fresh', 'remote-source:personal'],
    });
  });

  it('returns cloud personal memory stats for the owning server user', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/personal-memory?query=summary&limit=10', {
      method: 'GET',
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 0,
        projectCount: 1,
      },
      records: [
        {
          id: 'personal-projection-1',
          scope: 'personal',
          projectId: 'github.com/acme/repo',
          summary: 'Cloud personal summary',
          projectionClass: 'recent_summary',
          sourceEventCount: 2,
          updatedAt: 1700000000000,
        },
      ],
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
      diagnostics: ['visibility:active', 'remote-processed:stale', 'remote-source:shared'],
    }));
  });
});
