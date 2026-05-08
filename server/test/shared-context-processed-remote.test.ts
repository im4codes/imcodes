import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sha256Hex } from '../src/security/crypto.js';
import { serverRoutes } from '../src/routes/server.js';
import { sharedContextRoutes } from '../src/routes/shared-context.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

const generateEmbeddingMock = vi.hoisted(() => vi.fn());

vi.mock('../src/util/embedding.js', () => ({
  generateEmbedding: generateEmbeddingMock,
  embeddingToSql: (embedding: Float32Array) => `[${Array.from(embedding).join(',')}]`,
}));

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('role', 'owner');
    await next();
  },
}));

beforeEach(() => {
  generateEmbeddingMock.mockReset();
  generateEmbeddingMock.mockResolvedValue(null);
  process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS = 'true';
});

afterEach(() => {
  delete process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS;
});

function makeMockDb() {
  const projectionRows: Array<Record<string, unknown>> = [];
  const recordRows: Array<Record<string, unknown>> = [];
  const aliasRows: Array<Record<string, unknown>> = [];
  const executeSql: string[] = [];
  const authoredBindingRows = [
    {
      binding_id: 'binding-project',
      version_id: 'doc-v2',
      binding_mode: 'required',
      scope: 'project_shared',
      workspace_id: null,
      enrollment_id: 'enr-1',
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
      workspace_id: null,
      enrollment_id: null,
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
      if (normalized.includes("select id from shared_context_projections where id = $1 and scope = 'personal' and user_id = $2")) {
        if (params[0] === 'personal-projection-1' && params[1] === 'user-1') {
          return { id: 'personal-projection-1' } as T;
        }
        return null;
      }
      if (normalized.includes("select id from shared_context_projections where id = $1 and enterprise_id = $2 and scope in ('project_shared', 'workspace_shared', 'org_shared')")) {
        if (params[0] === 'shared-projection-1' && params[1] === 'ent-1') {
          return { id: 'shared-projection-1' } as T;
        }
        return null;
      }
      if (normalized.includes('select role from team_members where team_id = $1 and user_id = $2')) {
        if (params[0] === 'ent-1' && params[1] === 'user-1') {
          return { role: 'owner' } as T;
        }
        return null;
      }
      if (normalized.includes('select count(*)::int as total_records') && normalized.includes('from shared_context_projections')) {
        if (normalized.includes("scope = 'personal'")) {
          return {
            total_records: 1,
            recent_summary_count: 1,
            durable_candidate_count: 0,
            project_count: 1,
          } as T;
        }
        if (
          normalized.includes("scope in ('project_shared', 'workspace_shared', 'org_shared')")
          || normalized.includes('scope in ($')
        ) {
          return {
            total_records: 1,
            recent_summary_count: 0,
            durable_candidate_count: 1,
            project_count: 1,
          } as T;
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
      if (normalized.includes("join shared_context_embeddings e on e.source_id = p.id and e.source_kind = 'projection'")) {
        if (normalized.includes("p.scope = 'personal'")) {
          return [
            {
              id: 'personal-projection-1',
              scope: 'personal',
              project_id: 'github.com/acme/repo',
              projection_class: 'recent_summary',
              source_event_ids_json: ['evt-1', 'evt-2'],
              summary: 'Cloud personal summary',
              updated_at: 1700000000000,
              hit_count: 4,
              last_used_at: 1700000001000,
              status: 'active',
              enterprise_id: null,
              similarity: 0.91,
            },
          ] as T[];
        }
        if (
          normalized.includes("p.scope in ('project_shared', 'workspace_shared', 'org_shared')")
          || normalized.includes('p.scope in ($')
          || normalized.includes('p.scope = any(')
        ) {
          return [
            {
              id: 'shared-projection-1',
              scope: 'project_shared',
              project_id: 'github.com/acme/repo',
              projection_class: 'durable_memory_candidate',
              source_event_ids_json: ['evt-9'],
              summary: 'Shared deployment guidance',
              updated_at: 1700000002000,
              hit_count: 7,
              last_used_at: 1700000003000,
              status: 'active',
              enterprise_id: 'ent-1',
              similarity: 0.88,
            },
          ] as T[];
        }
      }
      if (normalized.includes('group by project_id') && normalized.includes("scope = 'personal'")) {
        return [
          {
            project_id: 'github.com/acme/repo',
            total_records: 1,
            recent_summary_count: 1,
            durable_candidate_count: 0,
            updated_at: 1700000000000,
          },
        ] as T[];
      }
      if (normalized.includes('group by project_id') && normalized.includes('enterprise_id =')) {
        return [
          {
            project_id: 'github.com/acme/repo',
            total_records: 1,
            recent_summary_count: 0,
            durable_candidate_count: 1,
            updated_at: 1700000002000,
          },
        ] as T[];
      }
      if (normalized.includes("from shared_context_projections where user_id = $1 and scope = 'personal'")) {
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
      if (normalized.includes('from shared_context_projections where enterprise_id = $1')) {
        return [
          {
            id: 'shared-projection-1',
            scope: 'project_shared',
            project_id: 'github.com/acme/repo',
            projection_class: 'durable_memory_candidate',
            source_event_ids_json: ['evt-9'],
            summary: 'Shared deployment guidance',
            content_json: { note: 'enterprise shared memory' },
            updated_at: 1700000002000,
          },
        ] as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executeSql.push(sql);
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
          origin: params[12],
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
          origin: params[11],
        });
        return { changes: 1 };
      }
      if (normalized.includes('insert into shared_context_repository_aliases')) {
        aliasRows.push({ id: params[0] });
        return { changes: 1 };
      }
      if (normalized.includes('delete from shared_context_embeddings')) {
        return { changes: 1 };
      }
      if (normalized.includes('delete from shared_context_projections where id = $1')) {
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db),
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  return { db, projectionRows, recordRows, aliasRows, executeSql };
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
            origin: 'chat_compacted',
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
            origin: 'chat_compacted',
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
        origin: 'chat_compacted',
      }),
    ]);
    expect(aliasRows).toHaveLength(0);
  });


  it('skips noisy API error projections during remote replication', async () => {
    const { db, projectionRows, recordRows } = makeMockDb();
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
            id: 'bad-proj',
            namespace: {
              scope: 'project_shared',
              projectId: 'github.com/acme/repo',
              enterpriseId: 'ent-1',
            },
            class: 'recent_summary',
            origin: 'chat_compacted',
            sourceEventIds: ['evt-bad'],
            summary: '**Assistant:** [API Error: Connection error. (cause: fetch failed)]',
            content: {},
            createdAt: 100,
            updatedAt: 101,
          },
          {
            id: 'good-proj',
            namespace: {
              scope: 'project_shared',
              projectId: 'github.com/acme/repo',
              enterpriseId: 'ent-1',
            },
            class: 'recent_summary',
            origin: 'chat_compacted',
            sourceEventIds: ['evt-good'],
            summary: 'useful summary',
            content: {},
            createdAt: 110,
            updatedAt: 111,
          },
        ],
      }),
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true, projectionCount: 1 }));
    expect(projectionRows).toEqual([
      expect.objectContaining({ id: 'good-proj' }),
    ]);
    expect(recordRows).toEqual([]);
  });

  it('rejects processed projection writes without an emit-safe explicit origin', async () => {
    const { db, projectionRows, recordRows } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    for (const projection of [
      {
        id: 'missing-origin',
        namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1' },
        class: 'recent_summary',
        sourceEventIds: ['evt-missing'],
        summary: 'missing origin',
        content: {},
        createdAt: 100,
        updatedAt: 101,
      },
      {
        id: 'reserved-origin',
        namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1' },
        class: 'recent_summary',
        origin: 'quick_search_cache',
        sourceEventIds: ['evt-reserved'],
        summary: 'reserved origin',
        content: {},
        createdAt: 100,
        updatedAt: 101,
      },
    ]) {
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
          projections: [projection],
        }),
      }, makeEnv(db));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_body' });
    }
    expect(projectionRows).toEqual([]);
    expect(recordRows).toEqual([]);
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
            origin: 'chat_compacted',
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
      origin: 'chat_compacted',
    }));
    expect(recordRows).toContainEqual(expect.objectContaining({
      projection_id: 'personal-proj-1',
      scope: 'personal',
      enterprise_id: null,
      workspace_id: null,
      user_id: 'user-1',
      origin: 'chat_compacted',
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
            origin: 'chat_compacted',
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
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
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
          hitCount: 0,
          status: 'active',
        },
      ],
      projects: [
        {
          projectId: 'github.com/acme/repo',
          displayName: 'github.com/acme/repo',
          totalRecords: 1,
          recentSummaryCount: 1,
          durableCandidateCount: 0,
          updatedAt: 1700000000000,
        },
      ],
    });
  });

  it('returns global personal cloud memory stats from the shared-context route', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/shared-context', sharedContextRoutes);

    const response = await app.request('/api/shared-context/personal-memory?query=summary&limit=10', {
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
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
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
          hitCount: 0,
          status: 'active',
        },
      ],
      projects: [
        {
          projectId: 'github.com/acme/repo',
          displayName: 'github.com/acme/repo',
          totalRecords: 1,
          recentSummaryCount: 1,
          durableCandidateCount: 0,
          updatedAt: 1700000000000,
        },
      ],
    });
  });

  it('returns personal cloud counts quickly on the no-query path', async () => {
    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/shared-context', sharedContextRoutes);

    const response = await app.request('/api/shared-context/personal-memory?limit=10', {
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
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
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
          hitCount: 0,
          status: 'active',
        },
      ],
      projects: [
        {
          projectId: 'github.com/acme/repo',
          displayName: 'github.com/acme/repo',
          totalRecords: 1,
          recentSummaryCount: 1,
          durableCandidateCount: 0,
          updatedAt: 1700000000000,
        },
      ],
    });
  });


  it('does not treat personal-memory query routes as recall events', async () => {
    const { db, executeSql } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const first = await app.request('/api/server/srv-1/shared-context/personal-memory?query=summary&limit=10', {
      method: 'GET',
    }, makeEnv(db));
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await app.request('/api/server/srv-1/shared-context/personal-memory?query=summary&limit=10', {
      method: 'GET',
    }, makeEnv(db));
    expect(second.status).toBe(200);
    const secondBody = await second.json();

    expect(firstBody).toEqual(secondBody);
    expect(executeSql.some((sql) => sql.toLowerCase().includes('hit_count = hit_count + 1'))).toBe(false);
  });


  it('uses semantic/vector search for server-scoped personal memory queries when embeddings are available', async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));

    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/personal-memory?query=deploy%20fix&limit=10', {
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
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
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
          hitCount: 4,
          lastUsedAt: 1700000001000,
          status: 'active',
        },
      ],
      projects: [
        {
          projectId: 'github.com/acme/repo',
          displayName: 'github.com/acme/repo',
          totalRecords: 1,
          recentSummaryCount: 1,
          durableCandidateCount: 0,
          updatedAt: 1700000000000,
        },
      ],
    });
  });

  it('uses semantic/vector search for enterprise shared memory queries when embeddings are available', async () => {
    generateEmbeddingMock.mockResolvedValue(new Float32Array([0.3, 0.2, 0.1]));

    const { db } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/shared-context', sharedContextRoutes);

    const response = await app.request('/api/shared-context/enterprises/ent-1/memory?query=deployment&limit=10', {
      method: 'GET',
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 0,
        durableCandidateCount: 1,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
      records: [
        {
          id: 'shared-projection-1',
          scope: 'project_shared',
          projectId: 'github.com/acme/repo',
          summary: 'Shared deployment guidance',
          projectionClass: 'durable_memory_candidate',
          sourceEventCount: 1,
          updatedAt: 1700000002000,
          hitCount: 7,
          lastUsedAt: 1700000003000,
          status: 'active',
        },
      ],
      projects: [
        {
          projectId: 'github.com/acme/repo',
          displayName: 'github.com/acme/repo',
          totalRecords: 1,
          recentSummaryCount: 0,
          durableCandidateCount: 1,
          updatedAt: 1700000002000,
        },
      ],
    });
  });

  it('deletes server-scoped personal memory for the owning user', async () => {
    const { db, executeSql } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/server', serverRoutes);

    const response = await app.request('/api/server/srv-1/shared-context/personal-memory/personal-projection-1', {
      method: 'DELETE',
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: 'personal-projection-1' });
    expect(executeSql.some((sql) => sql.toLowerCase().includes('delete from shared_context_embeddings'))).toBe(true);
    expect(executeSql.some((sql) => sql.toLowerCase().includes('delete from shared_context_projections where id = $1'))).toBe(true);
  });

  it('deletes enterprise shared memory for admins', async () => {
    const { db, executeSql } = makeMockDb();
    const app = new Hono<{ Bindings: Env }>();
    app.route('/api/shared-context', sharedContextRoutes);

    const response = await app.request('/api/shared-context/enterprises/ent-1/memory/shared-projection-1', {
      method: 'DELETE',
    }, makeEnv(db));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, id: 'shared-projection-1' });
    expect(executeSql.some((sql) => sql.toLowerCase().includes('delete from shared_context_embeddings'))).toBe(true);
    expect(executeSql.some((sql) => sql.toLowerCase().includes('delete from shared_context_projections where id = $1'))).toBe(true);
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
