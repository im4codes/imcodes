import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';
import { sameShapeMemoryLookupEnvelope } from '../src/memory/scope-policy.js';

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { req: { header: (name: string) => string | undefined }; set: (key: string, value: string) => void }, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'user-member');
    c.set('role', 'member');
    await next();
  },
  resolveServerRole: vi.fn().mockResolvedValue('owner'),
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

const randomHexMock = vi.hoisted(() => vi.fn());

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  return { ...real, randomHex: randomHexMock };
});

type TeamRole = 'owner' | 'admin' | 'member';
type BindingMode = 'required' | 'advisory';

type VersionRow = {
  id: string;
  document_id: string;
  status: 'active' | 'draft' | 'superseded';
  content: string;
};

type BindingRow = {
  id: string;
  enterprise_id: string;
  workspace_id: string | null;
  enrollment_id: string | null;
  document_id: string;
  version_id: string;
  binding_mode: BindingMode;
  applicability_repo_id: string | null;
  applicability_language: string | null;
  applicability_path_pattern: string | null;
  status: 'active' | 'inactive';
};

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'test',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

function normalize(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeMockDb() {
  const teamMembers = new Map<string, Map<string, { role: TeamRole }>>([
    ['team-1', new Map([
      ['user-owner', { role: 'owner' }],
      ['user-admin', { role: 'admin' }],
      ['user-member', { role: 'member' }],
    ])],
    ['team-2', new Map([
      ['user-other-admin', { role: 'admin' }],
    ])],
  ]);
  const versions = new Map<string, VersionRow>([
    ['ver-project', { id: 'ver-project', document_id: 'doc-project', status: 'active', content: 'Project required rules' }],
    ['ver-workspace', { id: 'ver-workspace', document_id: 'doc-workspace', status: 'active', content: 'Workspace advisory rules' }],
    ['ver-org', { id: 'ver-org', document_id: 'doc-org', status: 'active', content: 'Org required rules' }],
    ['ver-org-other', { id: 'ver-org-other', document_id: 'doc-org-other', status: 'active', content: 'Other repo org rules' }],
  ]);
  const bindings = new Map<string, BindingRow>([
    ['bind-project', {
      id: 'bind-project',
      enterprise_id: 'team-1',
      workspace_id: null,
      enrollment_id: 'enr-1',
      document_id: 'doc-project',
      version_id: 'ver-project',
      binding_mode: 'required',
      applicability_repo_id: 'github.com/acme/repo',
      applicability_language: 'typescript',
      applicability_path_pattern: 'src/**',
      status: 'active',
    }],
    ['bind-workspace', {
      id: 'bind-workspace',
      enterprise_id: 'team-1',
      workspace_id: 'ws-1',
      enrollment_id: null,
      document_id: 'doc-workspace',
      version_id: 'ver-workspace',
      binding_mode: 'advisory',
      applicability_repo_id: null,
      applicability_language: 'typescript',
      applicability_path_pattern: null,
      status: 'active',
    }],
    ['bind-org', {
      id: 'bind-org',
      enterprise_id: 'team-1',
      workspace_id: null,
      enrollment_id: null,
      document_id: 'doc-org',
      version_id: 'ver-org',
      binding_mode: 'required',
      applicability_repo_id: null,
      applicability_language: 'typescript',
      applicability_path_pattern: 'src/**',
      status: 'active',
    }],
    ['bind-org-other-repo', {
      id: 'bind-org-other-repo',
      enterprise_id: 'team-1',
      workspace_id: null,
      enrollment_id: null,
      document_id: 'doc-org-other',
      version_id: 'ver-org-other',
      binding_mode: 'advisory',
      applicability_repo_id: 'github.com/acme/other',
      applicability_language: 'typescript',
      applicability_path_pattern: null,
      status: 'active',
    }],
  ]);
  const executeLog: Array<{ sql: string; params: unknown[] }> = [];

  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = normalize(sql);
      if (s.includes('select role from team_members where team_id = $1 and user_id = $2')) {
        const member = teamMembers.get(params[0] as string)?.get(params[1] as string);
        return member ? ({ role: member.role } as T) : null;
      }
      if (s.includes('select enterprise_id, workspace_id, enrollment_id from shared_context_document_bindings where id = $1')) {
        const binding = bindings.get(params[0] as string);
        return binding ? ({
          enterprise_id: binding.enterprise_id,
          workspace_id: binding.workspace_id,
          enrollment_id: binding.enrollment_id,
        } as T) : null;
      }
      return null;
    },
    query: async <T = unknown>(sql: string, params: unknown[] = []) => {
      const s = normalize(sql);
      if (s.includes('from shared_context_document_bindings b join shared_context_document_versions v on v.id = b.version_id')) {
        return [...bindings.values()]
          .filter((binding) => binding.enterprise_id === params[0])
          .filter((binding) => binding.status === 'active')
          .map((binding) => {
            const version = versions.get(binding.version_id);
            if (!version || version.status !== 'active') return null;
            return {
              binding_id: binding.id,
              binding_mode: binding.binding_mode,
              workspace_id: binding.workspace_id,
              enrollment_id: binding.enrollment_id,
              applicability_repo_id: binding.applicability_repo_id,
              applicability_language: binding.applicability_language,
              applicability_path_pattern: binding.applicability_path_pattern,
              version_id: version.id,
              content: version.content,
            };
          })
          .filter(Boolean) as T[];
      }
      return [] as T[];
    },
    execute: async (sql: string, params: unknown[] = []) => {
      executeLog.push({ sql, params });
      const s = normalize(sql);
      if (s.includes('insert into shared_context_document_bindings')) {
        bindings.set(params[0] as string, {
          id: params[0] as string,
          enterprise_id: params[1] as string,
          workspace_id: params[2] as string | null,
          enrollment_id: params[3] as string | null,
          document_id: params[4] as string,
          version_id: params[5] as string,
          binding_mode: params[6] as BindingMode,
          applicability_repo_id: params[7] as string | null,
          applicability_language: params[8] as string | null,
          applicability_path_pattern: params[9] as string | null,
          status: 'active',
        });
        return { changes: 1 };
      }
      if (s.includes("update shared_context_document_bindings set status = 'inactive'")) {
        const binding = bindings.get(params[1] as string);
        if (binding) binding.status = 'inactive';
        return { changes: binding ? 1 : 0 };
      }
      return { changes: 1 };
    },
    exec: async () => {},
    close: async () => {},
  } as Database;
  return { db, bindings, executeLog };
}

async function buildApp(db: Database) {
  const { sharedContextRoutes } = await import('../src/routes/shared-context.js');
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/shared-context', sharedContextRoutes);
  return { app, env: makeEnv(db) };
}

function req(path: string, method: string, body: unknown | undefined, userId: string) {
  return [path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: body === undefined ? undefined : JSON.stringify(body),
  }] as const;
}

describe('org_shared authored context standards', () => {
  beforeEach(() => {
    let counter = 0;
    randomHexMock.mockImplementation(() => `generated-${++counter}`);
  });

  afterEach(() => {
    delete process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS;
    randomHexMock.mockReset();
  });

  it('blocks org-wide mutation when disabled while leaving workspace binding mutation available', async () => {
    process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS = 'false';
    const { db, bindings, executeLog } = makeMockDb();
    const { app, env } = await buildApp(db);

    const disabledOrg = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      documentId: 'doc-org',
      versionId: 'ver-org',
      mode: 'required',
    }, 'user-admin'), env);
    const workspace = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      documentId: 'doc-workspace',
      versionId: 'ver-workspace',
      workspaceId: 'ws-1',
      mode: 'advisory',
    }, 'user-admin'), env);

    expect(disabledOrg.status).toBe(404);
    expect(await disabledOrg.json()).toEqual(sameShapeMemoryLookupEnvelope());
    expect(workspace.status).toBe(201);
    expect(await workspace.json()).toMatchObject({ scope: 'workspace_shared', workspaceId: 'ws-1' });
    expect(bindings.get('generated-1')?.workspace_id).toBe('ws-1');
    expect(executeLog).toHaveLength(1);
  });

  it('enforces admin-only org mutation without role diagnostics and gates deactivation when disabled', async () => {
    process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS = 'true';
    const { db, bindings } = makeMockDb();
    const { app, env } = await buildApp(db);

    const memberMutation = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      documentId: 'doc-org',
      versionId: 'ver-org',
      mode: 'required',
    }, 'user-member'), env);
    const adminMutation = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      documentId: 'doc-org',
      versionId: 'ver-org',
      mode: 'required',
    }, 'user-admin'), env);

    expect(memberMutation.status).toBe(403);
    expect(await memberMutation.json()).toEqual({ error: 'forbidden' });
    expect(adminMutation.status).toBe(201);
    expect(await adminMutation.json()).toMatchObject({ id: 'generated-1', scope: 'org_shared' });
    expect(bindings.get('generated-1')?.workspace_id).toBeNull();
    expect(bindings.get('generated-1')?.enrollment_id).toBeNull();

    process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS = 'false';
    const disabledDeactivate = await app.request(...req('/api/shared-context/document-bindings/generated-1/deactivate', 'POST', {}, 'user-admin'), env);
    expect(disabledDeactivate.status).toBe(404);
    expect(await disabledDeactivate.json()).toEqual(sameShapeMemoryLookupEnvelope());
    expect(bindings.get('generated-1')?.status).toBe('active');
  });

  it('selects member-visible project, workspace, then org bindings with filter narrowing and no cross-enterprise leakage', async () => {
    process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS = 'true';
    const { db } = makeMockDb();
    const { app, env } = await buildApp(db);

    const runtime = await app.request(
      '/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo&workspaceId=ws-1&enrollmentId=enr-1&language=typescript&filePath=src/index.ts',
      { method: 'GET', headers: { 'x-test-user': 'user-member' } },
      env,
    );
    expect(runtime.status).toBe(200);
    const json = await runtime.json() as { bindings: Array<{ bindingId: string; scope: string; mode: string; content: string }> };
    expect(json.bindings.map((binding) => binding.bindingId)).toEqual(['bind-project', 'bind-workspace', 'bind-org']);
    expect(json.bindings.map((binding) => binding.scope)).toEqual(['project_shared', 'workspace_shared', 'org_shared']);
    expect(json.bindings.find((binding) => binding.bindingId === 'bind-org')?.mode).toBe('required');
    expect(json.bindings.map((binding) => binding.bindingId)).not.toContain('bind-org-other-repo');

    const narrowedByPath = await app.request(
      '/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo&workspaceId=ws-1&enrollmentId=enr-1&language=typescript&filePath=docs/readme.md',
      { method: 'GET', headers: { 'x-test-user': 'user-member' } },
      env,
    );
    expect((await narrowedByPath.json() as { bindings: Array<{ bindingId: string }> }).bindings.map((binding) => binding.bindingId)).toEqual(['bind-workspace']);

    const advisoryTrimmed = await app.request(
      '/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo&workspaceId=ws-1&enrollmentId=enr-1&language=typescript&filePath=src/index.ts&budgetBytes=45',
      { method: 'GET', headers: { 'x-test-user': 'user-member' } },
      env,
    );
    expect(advisoryTrimmed.status).toBe(200);
    const advisoryJson = await advisoryTrimmed.json() as { bindings: Array<{ bindingId: string }>; diagnostics: Array<{ bindingId: string; reason: string }> };
    expect(advisoryJson.bindings.map((binding) => binding.bindingId)).toEqual(['bind-project', 'bind-org']);
    expect(advisoryJson.diagnostics).toEqual([{ bindingId: 'bind-workspace', mode: 'advisory', reason: 'advisory_trimmed', bytes: 24 }]);

    const requiredOverBudget = await app.request(
      '/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo&workspaceId=ws-1&enrollmentId=enr-1&language=typescript&filePath=src/index.ts&budgetBytes=30',
      { method: 'GET', headers: { 'x-test-user': 'user-member' } },
      env,
    );
    expect(requiredOverBudget.status).toBe(409);
    expect(await requiredOverBudget.json()).toMatchObject({
      error: 'required_context_over_budget',
      diagnostics: [{ bindingId: 'bind-workspace', mode: 'advisory', reason: 'advisory_trimmed', bytes: 24 }, { bindingId: 'bind-org', mode: 'required', reason: 'required_over_budget', bytes: 18 }],
    });

    process.env.IMCODES_MEM_FEATURE_ORG_SHARED_AUTHORED_STANDARDS = 'false';
    const disabled = await app.request(
      '/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo&workspaceId=ws-1&enrollmentId=enr-1&language=typescript&filePath=src/index.ts',
      { method: 'GET', headers: { 'x-test-user': 'user-member' } },
      env,
    );
    expect((await disabled.json() as { bindings: Array<{ bindingId: string }> }).bindings.map((binding) => binding.bindingId)).toEqual(['bind-project', 'bind-workspace']);

    const nonMember = await app.request(
      '/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo',
      { method: 'GET', headers: { 'x-test-user': 'user-outsider' } },
      env,
    );
    const otherEnterprise = await app.request(
      '/api/shared-context/enterprises/team-2/runtime-authored-context?canonicalRepoId=github.com/acme/repo',
      { method: 'GET', headers: { 'x-test-user': 'user-member' } },
      env,
    );
    expect(nonMember.status).toBe(404);
    expect(otherEnterprise.status).toBe(404);
    expect(await nonMember.json()).toEqual(sameShapeMemoryLookupEnvelope());
    expect(await otherEnterprise.json()).toEqual(sameShapeMemoryLookupEnvelope());
  });
});
