import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

const logAuditMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/security/authorization.js', () => ({
  requireAuth: () => async (c: { req: { header: (name: string) => string | undefined }; set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'user-owner');
    c.set('role', 'member');
    await next();
  },
}));

vi.mock('../src/security/audit.js', () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

vi.mock('../src/security/crypto.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/security/crypto.js')>();
  let counter = 0;
  return {
    ...real,
    randomHex: (_n: number) => `shared-id-${++counter}`,
  };
});

type TeamRole = 'owner' | 'admin' | 'member';

function makeMockDb() {
  const teams = new Map<string, { id: string; name: string; owner_id: string }>();
  const teamMembers = new Map<string, Map<string, { role: TeamRole; joined_at: number }>>();
  const userProfiles = new Map<string, { username: string | null; display_name: string | null }>([
    ['user-owner', { username: 'owner', display_name: 'Owner User' }],
    ['user-admin', { username: 'admin', display_name: 'Admin User' }],
    ['user-member', { username: 'member', display_name: 'Member User' }],
    ['user-other', { username: null, display_name: null }],
  ]);
  const invites = new Map<string, { id: string; team_id: string; role: string; token: string; used_at: number | null; expires_at: number }>();
  const workspaces = new Map<string, { id: string; enterprise_id: string; name: string }>();
  const aliases = new Map<string, { id: string; enterprise_id: string; canonical_repo_id: string; alias_repo_id: string; reason: string }>();
  const enrollments = new Map<string, {
    id: string;
    enterprise_id: string;
    workspace_id: string | null;
    canonical_repo_id: string;
    display_name: string | null;
    scope: string;
    status: string;
  }>();
  const policyOverrides = new Map<string, {
    id: string;
    enterprise_id: string;
    enrollment_id: string;
    allow_degraded_provider_support: boolean;
    allow_local_fallback: boolean;
    require_full_provider_support: boolean;
  }>();
  const projections = new Map<string, { id: string; enterprise_id: string; project_id: string; updated_at?: number }>();
  const documents = new Map<string, { id: string; enterprise_id: string; kind: string; title: string }>();
  const versions = new Map<string, { id: string; document_id: string; version_number: number; status: string; content: string }>();
  const bindings = new Map<string, {
    id: string;
    enterprise_id: string;
    workspace_id: string | null;
    enrollment_id: string | null;
    document_id: string;
    version_id: string;
    status: string;
    binding_mode: string;
    applicability_repo_id: string | null;
    applicability_language: string | null;
    applicability_path_pattern: string | null;
  }>();

  teams.set('team-1', { id: 'team-1', name: 'Acme', owner_id: 'user-owner' });
  teamMembers.set('team-1', new Map([
    ['user-owner', { role: 'owner', joined_at: 1 }],
    ['user-admin', { role: 'admin', joined_at: 2 }],
    ['user-member', { role: 'member', joined_at: 3 }],
    ['user-other', { role: 'member', joined_at: 4 }],
  ]));

  function normalize(sql: string): string {
    return sql.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = normalize(sql);
      if (s.includes('select role from team_members where team_id = $1 and user_id = $2')) {
        const member = teamMembers.get(params[0] as string)?.get(params[1] as string);
        return member ? ({ role: member.role } as T) : null;
      }
      if (s.includes('select * from teams where id = $1')) {
        return (teams.get(params[0] as string) ?? null) as T | null;
      }
      if (s.includes('select * from team_invites where token = $1')) {
        const invite = [...invites.values()].find((entry) => entry.token === params[0]);
        if (!invite) return null;
        if (invite.used_at != null) return null;
        if (invite.expires_at <= Number(params[1])) return null;
        return invite as T;
      }
      if (s.includes('select * from team_invites where token = $1 and team_id = $2')) {
        const invite = [...invites.values()].find((entry) => entry.token === params[0] && entry.team_id === params[1]);
        if (!invite) return null;
        if (invite.used_at != null) return null;
        if (invite.expires_at <= Number(params[2])) return null;
        return invite as T;
      }
      if (s.includes('select enterprise_id from shared_project_enrollments where id = $1')) {
        const enrollment = enrollments.get(params[0] as string);
        return enrollment ? ({ enterprise_id: enrollment.enterprise_id } as T) : null;
      }
      if (s.includes('select allow_degraded_provider_support, allow_local_fallback, require_full_provider_support from shared_scope_policy_overrides where enrollment_id = $1')) {
        const override = policyOverrides.get(params[0] as string);
        return override ? ({
          allow_degraded_provider_support: override.allow_degraded_provider_support,
          allow_local_fallback: override.allow_local_fallback,
          require_full_provider_support: override.require_full_provider_support,
        } as T) : null;
      }
      if (s.includes('select id, status from shared_project_enrollments where enterprise_id = $1 and canonical_repo_id = $2')) {
        const enrollment = [...enrollments.values()].find((entry) => entry.enterprise_id === params[0] && entry.canonical_repo_id === params[1]);
        return enrollment ? ({ id: enrollment.id, status: enrollment.status } as T) : null;
      }
      if (s.includes('select id from shared_context_projections where enterprise_id = $1 and project_id = $2 limit 1')) {
        const projection = [...projections.values()].find((entry) => entry.enterprise_id === params[0] && entry.project_id === params[1]);
        return projection ? ({ id: projection.id } as T) : null;
      }
      if (s.includes('select id, updated_at from shared_context_projections where enterprise_id = $1 and project_id = $2 order by updated_at desc limit 1')) {
        const projection = [...projections.values()].find((entry) => entry.enterprise_id === params[0] && entry.project_id === params[1]);
        return projection ? ({ id: projection.id, updated_at: projection.updated_at ?? Date.now() } as T) : null;
      }
      if (s.includes('select enterprise_id from shared_context_documents where id = $1')) {
        const document = documents.get(params[0] as string);
        return document ? ({ enterprise_id: document.enterprise_id } as T) : null;
      }
      if (s.includes('select v.document_id, d.enterprise_id from shared_context_document_versions v join shared_context_documents d on d.id = v.document_id where v.id = $1')) {
        const version = versions.get(params[0] as string);
        if (!version) return null;
        const document = documents.get(version.document_id);
        return document ? ({ document_id: version.document_id, enterprise_id: document.enterprise_id } as T) : null;
      }
      if (s.includes('select enterprise_id from shared_context_document_bindings where id = $1')) {
        const binding = bindings.get(params[0] as string);
        return binding ? ({ enterprise_id: binding.enterprise_id } as T) : null;
      }
      if (s.includes('select role from team_members where team_id = $1 and user_id = $2 and role in')) {
        const member = teamMembers.get(params[0] as string)?.get(params[1] as string);
        if (!member) return null;
        return ['owner', 'admin'].includes(member.role) ? ({ role: member.role } as T) : null;
      }
      return null;
    },

    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = normalize(sql);
      if (s.includes('select tm.user_id, tm.role, tm.joined_at, u.username, u.display_name from team_members tm left join users u on u.id = tm.user_id where tm.team_id = $1')) {
        return [...(teamMembers.get(params[0] as string)?.entries() ?? [])].map(([user_id, value]) => ({
          user_id,
          role: value.role,
          joined_at: value.joined_at,
          username: userProfiles.get(user_id)?.username ?? null,
          display_name: userProfiles.get(user_id)?.display_name ?? null,
        })) as T[];
      }
      if (s.includes('select t.id, t.name, tm.role from teams t join team_members tm on tm.team_id = t.id where tm.user_id = $1')) {
        const userId = params[0] as string;
        return [...teams.values()]
          .map((team) => {
            const member = teamMembers.get(team.id)?.get(userId);
            if (!member) return null;
            return { id: team.id, name: team.name, role: member.role };
          })
          .filter(Boolean) as T[];
      }
      if (s.includes('select id, enterprise_id, name from shared_context_workspaces where enterprise_id = $1')) {
        return [...workspaces.values()].filter((entry) => entry.enterprise_id === params[0]) as T[];
      }
      if (s.includes('select id, workspace_id, canonical_repo_id, display_name, scope, status from shared_project_enrollments where enterprise_id = $1')) {
        return [...enrollments.values()].filter((entry) => entry.enterprise_id === params[0]).map((entry) => ({
          id: entry.id,
          workspace_id: entry.workspace_id,
          canonical_repo_id: entry.canonical_repo_id,
          display_name: entry.display_name,
          scope: entry.scope,
          status: entry.status,
        })) as T[];
      }
      if (s.includes('select id, kind, title from shared_context_documents where enterprise_id = $1')) {
        return [...documents.values()].filter((entry) => entry.enterprise_id === params[0]).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          title: entry.title,
        })) as T[];
      }
      if (s.includes('select id, version_number, status from shared_context_document_versions where document_id = $1')) {
        return [...versions.values()]
          .filter((entry) => entry.document_id === params[0])
          .map((entry) => ({ id: entry.id, version_number: entry.version_number, status: entry.status })) as T[];
      }
      if (s.includes('select id, workspace_id, enrollment_id, document_id, version_id, binding_mode, applicability_repo_id, applicability_language, applicability_path_pattern, status from shared_context_document_bindings where enterprise_id = $1')) {
        return [...bindings.values()].filter((entry) => entry.enterprise_id === params[0]).map((entry) => ({
          id: entry.id,
          workspace_id: entry.workspace_id,
          enrollment_id: entry.enrollment_id,
          document_id: entry.document_id,
          version_id: entry.version_id,
          binding_mode: entry.binding_mode,
          applicability_repo_id: entry.applicability_repo_id,
          applicability_language: entry.applicability_language,
          applicability_path_pattern: entry.applicability_path_pattern,
          status: entry.status,
        })) as T[];
      }
      if (s.includes('from shared_context_document_bindings b join shared_context_document_versions v on v.id = b.version_id where b.enterprise_id = $1 and b.status = \'active\' and v.status = \'active\'')) {
        return [...bindings.values()]
          .filter((entry) => entry.enterprise_id === params[0] && entry.status === 'active')
          .map((entry) => {
            const version = versions.get(entry.version_id);
            if (!version || version.status !== 'active') return null;
            return {
              binding_id: entry.id,
              binding_mode: entry.binding_mode,
              workspace_id: entry.workspace_id,
              enrollment_id: entry.enrollment_id,
              applicability_repo_id: entry.applicability_repo_id,
              applicability_language: entry.applicability_language,
              applicability_path_pattern: entry.applicability_path_pattern,
              version_id: entry.version_id,
              content: version.content,
            };
          })
          .filter(Boolean) as T[];
      }
      return [] as T[];
    },

    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = normalize(sql);
      if (s.includes('insert into team_invites')) {
        invites.set(params[0] as string, {
          id: params[0] as string,
          team_id: params[1] as string,
          role: params[4] as string,
          token: params[3] as string,
          used_at: null,
          expires_at: params[6] as number,
        });
        return { changes: 1 };
      }
      if (s.includes('insert into team_members')) {
        const members = teamMembers.get(params[0] as string) ?? new Map<string, { role: TeamRole; joined_at: number }>();
        members.set(params[1] as string, { role: params[2] as TeamRole, joined_at: params[3] as number });
        teamMembers.set(params[0] as string, members);
        return { changes: 1 };
      }
      if (s.includes('update team_invites set used_at = $1 where id = $2')) {
        const invite = invites.get(params[1] as string);
        if (invite) invite.used_at = params[0] as number;
        return { changes: 1 };
      }
      if (s.includes('update team_members set role = $1 where team_id = $2 and user_id = $3')) {
        const members = teamMembers.get(params[1] as string);
        const member = members?.get(params[2] as string);
        if (member) member.role = params[0] as TeamRole;
        return { changes: member ? 1 : 0 };
      }
      if (s.includes('delete from team_members where team_id = $1 and user_id = $2')) {
        return { changes: teamMembers.get(params[0] as string)?.delete(params[1] as string) ? 1 : 0 };
      }
      if (s.includes('insert into shared_context_workspaces')) {
        workspaces.set(params[0] as string, { id: params[0] as string, enterprise_id: params[1] as string, name: params[2] as string });
        return { changes: 1 };
      }
      if (s.includes('insert into shared_context_repository_aliases')) {
        aliases.set(params[0] as string, {
          id: params[0] as string,
          enterprise_id: params[1] as string,
          canonical_repo_id: params[2] as string,
          alias_repo_id: params[3] as string,
          reason: params[4] as string,
        });
        return { changes: 1 };
      }
      if (s.includes('insert into shared_project_enrollments')) {
        enrollments.set(params[0] as string, {
          id: params[0] as string,
          enterprise_id: params[1] as string,
          workspace_id: params[2] as string | null,
          canonical_repo_id: params[3] as string,
          display_name: params[4] as string | null,
          scope: params[5] as string,
          status: params[6] as string,
        });
        return { changes: 1 };
      }
      if (s.includes("update shared_project_enrollments set status = 'pending_removal'")) {
        const enrollment = enrollments.get(params[1] as string);
        if (enrollment) enrollment.status = 'pending_removal';
        return { changes: enrollment ? 1 : 0 };
      }
      if (s.includes("update shared_project_enrollments set status = 'removed'")) {
        const enrollment = enrollments.get(params[1] as string);
        if (enrollment) enrollment.status = 'removed';
        return { changes: enrollment ? 1 : 0 };
      }
      if (s.includes('insert into shared_scope_policy_overrides')) {
        policyOverrides.set(params[2] as string, {
          id: params[0] as string,
          enterprise_id: params[1] as string,
          enrollment_id: params[2] as string,
          allow_degraded_provider_support: !!params[3],
          allow_local_fallback: !!params[4],
          require_full_provider_support: !!params[5],
        });
        return { changes: 1 };
      }
      if (s.includes('insert into shared_context_documents')) {
        documents.set(params[0] as string, {
          id: params[0] as string,
          enterprise_id: params[1] as string,
          kind: params[2] as string,
          title: params[3] as string,
        });
        return { changes: 1 };
      }
      if (s.includes('insert into shared_context_document_versions')) {
        versions.set(params[0] as string, {
          id: params[0] as string,
          document_id: params[1] as string,
          version_number: params[2] as number,
          status: 'draft',
          content: params[4] as string,
        });
        return { changes: 1 };
      }
      if (s.includes("update shared_context_document_versions set status = case when id = $1 then 'active'")) {
        for (const version of versions.values()) {
          if (version.document_id !== params[1]) continue;
          version.status = version.id === params[0] ? 'active' : (version.status === 'active' ? 'superseded' : version.status);
        }
        return { changes: 1 };
      }
      if (s.includes('insert into shared_context_document_bindings')) {
        bindings.set(params[0] as string, {
          id: params[0] as string,
          enterprise_id: params[1] as string,
          workspace_id: params[2] as string | null,
          enrollment_id: params[3] as string | null,
          document_id: params[4] as string,
          version_id: params[5] as string,
          binding_mode: params[6] as string,
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
      if (s.includes('insert into audit_log')) {
        return { changes: 1 };
      }
      return { changes: 0 };
    },
    exec: async () => {},
    close: async () => {},
  } as unknown as Database;

  return { db, teamMembers, invites, workspaces, aliases, enrollments, policyOverrides, projections, documents, versions, bindings };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'http://localhost:3000',
    ALLOWED_ORIGINS: '',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'development',
    GITHUB_CLIENT_ID: '',
    GITHUB_CLIENT_SECRET: '',
    DATABASE_URL: '',
  } as Env;
}

async function buildTestApp(env: Env) {
  const { teamRoutes } = await import('../src/routes/team.js');
  const { sharedContextRoutes } = await import('../src/routes/shared-context.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env);
    await next();
  });
  app.route('/api/team', teamRoutes);
  app.route('/api/shared-context', sharedContextRoutes);
  return app;
}

function req(path: string, method: string, body?: unknown, user = 'user-owner'): [string, RequestInit] {
  return [path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Test-User': user },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }];
}

describe('shared-agent-context server control plane', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDb = makeMockDb();
    app = await buildTestApp(makeEnv(mockDb.db));
  });

  it('owner can appoint and revoke admins, but admin cannot appoint another admin', async () => {
    let res = await app.request(...req('/api/team/team-1/member/user-other/role', 'PUT', { role: 'admin' }, 'user-owner'));
    expect(res.status).toBe(200);
    expect(mockDb.teamMembers.get('team-1')?.get('user-other')?.role).toBe('admin');

    res = await app.request(...req('/api/team/team-1/member/user-member/role', 'PUT', { role: 'admin' }, 'user-admin'));
    expect(res.status).toBe(403);

    res = await app.request(...req('/api/team/team-1/member/user-admin/role', 'PUT', { role: 'member' }, 'user-owner'));
    expect(res.status).toBe(200);
    expect(mockDb.teamMembers.get('team-1')?.get('user-admin')?.role).toBe('member');
  });

  it('lists enterprises visible to the current member', async () => {
    const res = await app.request(...req('/api/team', 'GET', undefined, 'user-member'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      teams: [
        { id: 'team-1', name: 'Acme', role: 'member' },
      ],
    });
  });

  it('returns readable member profile fields in team detail responses', async () => {
    const res = await app.request(...req('/api/team/team-1', 'GET', undefined, 'user-owner'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          user_id: 'user-owner',
          username: 'owner',
          display_name: 'Owner User',
          role: 'owner',
        }),
        expect.objectContaining({
          user_id: 'user-member',
          username: 'member',
          display_name: 'Member User',
          role: 'member',
        }),
      ]),
    });
  });

  it('admin can manage member invites but cannot create admin invites', async () => {
    let res = await app.request(...req('/api/team/team-1/invite', 'POST', { role: 'member' }, 'user-admin'));
    expect(res.status).toBe(200);
    expect(mockDb.invites.size).toBe(1);

    res = await app.request(...req('/api/team/team-1/invite', 'POST', { role: 'admin' }, 'user-admin'));
    expect(res.status).toBe(403);
  });

  it('admin can manage workspaces, aliases, enrollments, policy overrides, and authored documents', async () => {
    let res = await app.request(...req('/api/shared-context/enterprises/team-1/workspaces', 'POST', { name: 'Platform' }, 'user-admin'));
    expect(res.status).toBe(201);
    const workspace = await res.json() as { id: string };

    res = await app.request(...req('/api/shared-context/enterprises/team-1/repository-aliases', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      aliasRepoId: 'git@github.com:acme/repo.git',
      reason: 'ssh-https-equivalent',
    }, 'user-admin'));
    expect(res.status).toBe(201);
    expect(mockDb.aliases.size).toBe(1);
    expect([...mockDb.aliases.values()][0]?.reason).toBe('ssh-https-equivalent');

    res = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      workspaceId: workspace.id,
      displayName: 'Repo',
      scope: 'project_shared',
    }, 'user-admin'));
    expect(res.status).toBe(201);
    const enrollment = await res.json() as { id: string; memberPolicy: { autoEnabledForMembers: boolean; memberOptOutAllowed: boolean } };
    expect(enrollment.memberPolicy).toEqual({ autoEnabledForMembers: true, memberOptOutAllowed: false });

    res = await app.request(...req(`/api/shared-context/projects/${enrollment.id}/policy`, 'PUT', {
      allowDegradedProviderSupport: true,
      allowLocalFallback: false,
      requireFullProviderSupport: false,
    }, 'user-admin'));
    expect(res.status).toBe(200);
    expect(mockDb.policyOverrides.get(enrollment.id)?.allow_degraded_provider_support).toBe(true);

    res = await app.request(...req('/api/shared-context/enterprises/team-1/documents', 'POST', {
      kind: 'coding_standard',
      title: 'TypeScript rules',
    }, 'user-admin'));
    expect(res.status).toBe(201);
    const document = await res.json() as { id: string };

    res = await app.request(...req(`/api/shared-context/documents/${document.id}/versions`, 'POST', {
      label: 'v1',
      contentMd: '# Rules',
    }, 'user-admin'));
    expect(res.status).toBe(201);
    const version = await res.json() as { id: string };

    res = await app.request(...req(`/api/shared-context/document-versions/${version.id}/activate`, 'POST', {}, 'user-admin'));
    expect(res.status).toBe(200);
    expect(mockDb.versions.get(version.id)?.status).toBe('active');

    res = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      documentId: document.id,
      versionId: version.id,
      enrollmentId: enrollment.id,
      mode: 'required',
      applicabilityRepoId: 'github.com/acme/repo',
    }, 'user-admin'));
    expect(res.status).toBe(201);
    const binding = await res.json() as { id: string };
    expect(mockDb.bindings.get(binding.id)?.binding_mode).toBe('required');

    res = await app.request(...req(`/api/shared-context/document-bindings/${binding.id}/deactivate`, 'POST', {}, 'user-admin'));
    expect(res.status).toBe(200);
    expect(mockDb.bindings.get(binding.id)?.status).toBe('inactive');
  });

  it('lists workspaces, projects, documents, bindings, policy, and runtime authored context for members', async () => {
    let res = await app.request(...req('/api/shared-context/enterprises/team-1/workspaces', 'POST', { name: 'Platform' }, 'user-owner'));
    const workspace = await res.json() as { id: string };
    res = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      displayName: 'Acme Repo',
      workspaceId: workspace.id,
      scope: 'workspace_shared',
    }, 'user-owner'));
    const enrollment = await res.json() as { id: string };
    await app.request(...req(`/api/shared-context/projects/${enrollment.id}/policy`, 'PUT', {
      allowDegradedProviderSupport: true,
      allowLocalFallback: false,
      requireFullProviderSupport: false,
    }, 'user-owner'));
    res = await app.request(...req('/api/shared-context/enterprises/team-1/documents', 'POST', {
      kind: 'coding_standard',
      title: 'TypeScript rules',
    }, 'user-owner'));
    const document = await res.json() as { id: string };
    res = await app.request(...req(`/api/shared-context/documents/${document.id}/versions`, 'POST', {
      versionNumber: 1,
      contentMd: 'Use strict types.',
    }, 'user-owner'));
    const version = await res.json() as { id: string };
    await app.request(...req(`/api/shared-context/document-versions/${version.id}/activate`, 'POST', {}, 'user-owner'));
    res = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      workspaceId: workspace.id,
      enrollmentId: enrollment.id,
      documentId: document.id,
      versionId: version.id,
      mode: 'required',
      applicabilityRepoId: 'github.com/acme/repo',
      applicabilityLanguage: 'typescript',
      applicabilityPathPattern: 'src/**',
    }, 'user-owner'));
    const binding = await res.json() as { id: string };

    res = await app.request(...req('/api/shared-context/enterprises/team-1/workspaces', 'GET', undefined, 'user-member'));
    expect(res.status).toBe(200);
    expect((await res.json() as { workspaces: Array<{ id: string }> }).workspaces.map((entry) => entry.id)).toContain(workspace.id);

    res = await app.request(...req('/api/shared-context/enterprises/team-1/projects', 'GET', undefined, 'user-member'));
    expect((await res.json() as { projects: Array<{ id: string }> }).projects.map((entry) => entry.id)).toContain(enrollment.id);

    res = await app.request(...req('/api/shared-context/enterprises/team-1/documents', 'GET', undefined, 'user-member'));
    const docs = await res.json() as { documents: Array<{ id: string; versions: Array<{ id: string }> }> };
    expect(docs.documents.find((entry) => entry.id === document.id)?.versions[0]?.id).toBe(version.id);

    res = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'GET', undefined, 'user-member'));
    expect((await res.json() as { bindings: Array<{ id: string }> }).bindings.map((entry) => entry.id)).toContain(binding.id);

    res = await app.request(...req(`/api/shared-context/projects/${enrollment.id}/policy`, 'GET', undefined, 'user-member'));
    expect(await res.json()).toMatchObject({ allowDegradedProviderSupport: true });

    res = await app.request(...req('/api/shared-context/enterprises/team-1/runtime-authored-context?canonicalRepoId=github.com/acme/repo&workspaceId=' + workspace.id + '&enrollmentId=' + enrollment.id + '&language=typescript&filePath=src/index.ts', 'GET', undefined, 'user-member'));
    expect((await res.json() as { bindings: Array<{ documentVersionId: string; content: string }> }).bindings).toEqual([
      expect.objectContaining({ documentVersionId: version.id, content: 'Use strict types.' }),
    ]);

    mockDb.projections.set('proj-3', { id: 'proj-3', enterprise_id: 'team-1', project_id: 'github.com/acme/repo', updated_at: Date.now() });
    res = await app.request(...req('/api/shared-context/enterprises/team-1/diagnostics?canonicalRepoId=github.com/acme/repo', 'GET', undefined, 'user-member'));
    expect(await res.json()).toMatchObject({
      enterpriseId: 'team-1',
      canonicalRepoId: 'github.com/acme/repo',
      remoteProcessedFreshness: 'fresh',
      diagnostics: expect.objectContaining({
        derivedOnDemand: true,
        persistedSnapshotAvailable: false,
      }),
    });
  });

  it('ordinary members cannot mutate shared-context bindings or policy overrides', async () => {
    const workspaceRes = await app.request(...req('/api/shared-context/enterprises/team-1/workspaces', 'POST', { name: 'Platform' }, 'user-owner'));
    const workspace = await workspaceRes.json() as { id: string };
    const enrollmentRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      workspaceId: workspace.id,
      scope: 'project_shared',
    }, 'user-owner'));
    const enrollment = await enrollmentRes.json() as { id: string };
    const docRes = await app.request(...req('/api/shared-context/enterprises/team-1/documents', 'POST', {
      kind: 'knowledge_doc',
      title: 'Playbook',
    }, 'user-owner'));
    const document = await docRes.json() as { id: string };
    const versionRes = await app.request(...req(`/api/shared-context/documents/${document.id}/versions`, 'POST', {
      contentMd: 'body',
    }, 'user-owner'));
    const version = await versionRes.json() as { id: string };

    let res = await app.request(...req(`/api/shared-context/projects/${enrollment.id}/policy`, 'PUT', {
      allowDegradedProviderSupport: true,
    }, 'user-member'));
    expect(res.status).toBe(403);

    res = await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      documentId: document.id,
      versionId: version.id,
      enrollmentId: enrollment.id,
      mode: 'advisory',
    }, 'user-member'));
    expect(res.status).toBe(403);
  });

  it('reports architecture-default shared policy when no explicit override exists', async () => {
    const enrollmentRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      scope: 'project_shared',
    }, 'user-owner'));
    const enrollment = await enrollmentRes.json() as { id: string };

    const res = await app.request(...req(`/api/shared-context/projects/${enrollment.id}/policy`, 'GET', undefined, 'user-member'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enrollmentId: enrollment.id,
      enterpriseId: 'team-1',
      allowDegradedProviderSupport: true,
      allowLocalFallback: false,
      requireFullProviderSupport: false,
    });
  });

  it('does not return repo-bound authored context when canonical repo id is omitted', async () => {
    const workspaceRes = await app.request(...req('/api/shared-context/enterprises/team-1/workspaces', 'POST', { name: 'Platform' }, 'user-owner'));
    const workspace = await workspaceRes.json() as { id: string };
    const enrollmentRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      workspaceId: workspace.id,
      scope: 'project_shared',
    }, 'user-owner'));
    const enrollment = await enrollmentRes.json() as { id: string };
    const docRes = await app.request(...req('/api/shared-context/enterprises/team-1/documents', 'POST', {
      kind: 'coding_standard',
      title: 'TypeScript',
    }, 'user-owner'));
    const document = await docRes.json() as { id: string };
    const versionRes = await app.request(...req(`/api/shared-context/documents/${document.id}/versions`, 'POST', {
      contentMd: 'Use strict types.',
    }, 'user-owner'));
    const version = await versionRes.json() as { id: string };
    await app.request(...req(`/api/shared-context/document-versions/${version.id}/activate`, 'POST', {}, 'user-owner'));
    await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      workspaceId: workspace.id,
      enrollmentId: enrollment.id,
      documentId: document.id,
      versionId: version.id,
      mode: 'required',
      applicabilityRepoId: 'github.com/acme/repo',
    }, 'user-owner'));

    const res = await app.request(...req(`/api/shared-context/enterprises/team-1/runtime-authored-context?workspaceId=${workspace.id}&enrollmentId=${enrollment.id}`, 'GET', undefined, 'user-member'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enterpriseId: 'team-1', bindings: [] });
  });

  it('requires explicit migration reason for host-change aliases and rejects unrelated repo aliases', async () => {
    let res = await app.request(...req('/api/shared-context/enterprises/team-1/repository-aliases', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      aliasRepoId: 'https://gitlab.com/acme/repo.git',
    }, 'user-admin'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'explicit_migration_required' });

    res = await app.request(...req('/api/shared-context/enterprises/team-1/repository-aliases', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      aliasRepoId: 'https://gitlab.com/acme/repo.git',
      reason: 'explicit-migration',
    }, 'user-admin'));
    expect(res.status).toBe(201);

    res = await app.request(...req('/api/shared-context/enterprises/team-1/repository-aliases', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      aliasRepoId: 'https://github.com/acme/other.git',
      reason: 'ssh-https-equivalent',
    }, 'user-admin'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_alias_target' });
  });

  it('returns personal-only visibility when a member has no project enrollment', async () => {
    const res = await app.request(...req('/api/shared-context/enterprises/team-1/projects/visibility?canonicalRepoId=github.com/acme/repo', 'GET', undefined, 'user-member'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enterpriseId: 'team-1',
      canonicalRepoId: 'github.com/acme/repo',
      enrollmentId: null,
      remoteProcessedPresent: false,
      visibilityState: 'unenrolled',
      retrievalMode: 'personal_only',
    });
  });

  it('treats pending-removal enrollments as default-deny for shared retrieval', async () => {
    const enrollRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      scope: 'project_shared',
    }, 'user-owner'));
    const enrollment = await enrollRes.json() as { id: string };
    mockDb.projections.set('proj-1', { id: 'proj-1', enterprise_id: 'team-1', project_id: 'github.com/acme/repo', updated_at: Date.now() });

    const markRes = await app.request(...req(`/api/shared-context/projects/${enrollment.id}/pending-removal`, 'POST', {}, 'user-admin'));
    expect(markRes.status).toBe(200);

    const visibilityRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/visibility?canonicalRepoId=github.com/acme/repo', 'GET', undefined, 'user-member'));
    expect(visibilityRes.status).toBe(200);
    expect(await visibilityRes.json()).toEqual({
      enterpriseId: 'team-1',
      canonicalRepoId: 'github.com/acme/repo',
      enrollmentId: enrollment.id,
      remoteProcessedPresent: true,
      visibilityState: 'pending_removal',
      retrievalMode: 'policy_bound_default_deny',
    });
  });

  it('treats removed enrollments with lingering remote data as cleanup-only', async () => {
    const enrollRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      scope: 'project_shared',
    }, 'user-owner'));
    const enrollment = await enrollRes.json() as { id: string };
    mockDb.projections.set('proj-2', { id: 'proj-2', enterprise_id: 'team-1', project_id: 'github.com/acme/repo', updated_at: Date.now() });

    const removeRes = await app.request(...req(`/api/shared-context/projects/${enrollment.id}/remove`, 'POST', {}, 'user-owner'));
    expect(removeRes.status).toBe(200);

    const visibilityRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/visibility?canonicalRepoId=github.com/acme/repo', 'GET', undefined, 'user-member'));
    expect(visibilityRes.status).toBe(200);
    expect(await visibilityRes.json()).toEqual({
      enterpriseId: 'team-1',
      canonicalRepoId: 'github.com/acme/repo',
      enrollmentId: enrollment.id,
      remoteProcessedPresent: true,
      visibilityState: 'removed',
      retrievalMode: 'cleanup_only',
    });
  });

  it('derives diagnostics bindings using the same applicability filters as runtime retrieval', async () => {
    const workspaceRes = await app.request(...req('/api/shared-context/enterprises/team-1/workspaces', 'POST', { name: 'Platform' }, 'user-owner'));
    const workspace = await workspaceRes.json() as { id: string };
    const enrollmentRes = await app.request(...req('/api/shared-context/enterprises/team-1/projects/enroll', 'POST', {
      canonicalRepoId: 'github.com/acme/repo',
      workspaceId: workspace.id,
      scope: 'project_shared',
    }, 'user-owner'));
    const enrollment = await enrollmentRes.json() as { id: string };
    const docRes = await app.request(...req('/api/shared-context/enterprises/team-1/documents', 'POST', {
      kind: 'coding_standard',
      title: 'TypeScript',
    }, 'user-owner'));
    const document = await docRes.json() as { id: string };
    const versionRes = await app.request(...req(`/api/shared-context/documents/${document.id}/versions`, 'POST', {
      contentMd: 'Use strict types.',
    }, 'user-owner'));
    const version = await versionRes.json() as { id: string };
    await app.request(...req(`/api/shared-context/document-versions/${version.id}/activate`, 'POST', {}, 'user-owner'));
    await app.request(...req('/api/shared-context/enterprises/team-1/document-bindings', 'POST', {
      workspaceId: workspace.id,
      enrollmentId: enrollment.id,
      documentId: document.id,
      versionId: version.id,
      mode: 'required',
      applicabilityRepoId: 'github.com/acme/repo',
      applicabilityLanguage: 'typescript',
      applicabilityPathPattern: 'src/**',
    }, 'user-owner'));
    mockDb.projections.set('proj-4', {
      id: 'proj-4',
      enterprise_id: 'team-1',
      project_id: 'github.com/acme/repo',
      updated_at: Date.now() - 7 * 60 * 60 * 1000,
    });

    const res = await app.request(...req(
      `/api/shared-context/enterprises/team-1/diagnostics?canonicalRepoId=github.com/acme/repo&workspaceId=${workspace.id}&enrollmentId=${enrollment.id}&language=typescript&filePath=src/index.ts`,
      'GET',
      undefined,
      'user-member',
    ));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      enterpriseId: 'team-1',
      canonicalRepoId: 'github.com/acme/repo',
      remoteProcessedFreshness: 'stale',
      diagnostics: {
        activeBindingCount: 1,
        appliedDocumentVersionIds: [version.id],
      },
    });
  });
});
