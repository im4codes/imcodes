import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { MEMORY_MCP_TOOL_NAMES } from '../../shared/memory-mcp-contracts.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { SHARED_MACHINE_AUTHORITY_HEADER, SHARED_MACHINE_AUTHORITY_TYPE } from '../../shared/shared-machine-authority.js';
import {
  createMemoryMcpServer,
  createMemoryMcpServerFromEnv,
} from '../../src/daemon/memory-mcp-server.js';
import {
  createMemoryMcpToolHandlers,
} from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import { createDaemonCloudDocsToolDeps } from '../../src/daemon/cloud-docs-mcp-deps.js';
import { buildApp } from '../../server/src/index.js';
import type { Database } from '../../server/src/db/client.js';
import type { Env } from '../../server/src/env.js';
import { sha256Hex } from '../../server/src/security/crypto.js';
import { issueSharedMachineAuthority } from '../../server/src/share/shared-machine-authority.js';
import { LocalCloudDocStorage } from '../../server/src/storage/cloud-doc-storage.js';
import type {
  CloudDocFolderRow,
  CloudDocRow,
  CloudDocShareRow,
  RecentDocumentRow,
} from '../../server/src/db/cloud-docs.js';

const JWT_KEY = 'cloud-docs-mcp-test-signing-key-32chars!';
const SERVER_URL = 'https://app.im.codes';

function makeCaller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'owner-1', projectId: 'repo-1' };
  return {
    userId: 'owner-1',
    namespace,
    sessionName: 'deck_proj_brain',
    projectName: 'proj',
    projectRoot: '/tmp/proj',
    serverId: 'srv-1',
    transport: 'in_process',
    ...overrides,
  };
}

function createInMemoryMcpCloudDocsDb() {
  const users = new Map<string, { id: string; username: string; display_name: string; status: string; sessions_valid_after: number; is_admin: boolean }>([
    ['owner-1', { id: 'owner-1', username: 'alice', display_name: 'Alice', status: 'active', sessions_valid_after: 0, is_admin: false }],
    ['user-bob', { id: 'user-bob', username: 'bob', display_name: 'Bob', status: 'active', sessions_valid_after: 0, is_admin: false }],
  ]);
  const teams = new Map<string, { id: string; name: string; owner_id: string }>([
    ['team-1', { id: 'team-1', name: 'Docs Team', owner_id: 'owner-1' }],
  ]);
  const servers = new Map<string, { id: string; name: string; user_id: string; team_id: string | null; token_hash: string; node_role: string; revoked_at: number | null }>([
    ['srv-1', { id: 'srv-1', name: 'Full Node', user_id: 'owner-1', team_id: 'team-1', token_hash: sha256Hex('srv-1-token'), node_role: NODE_ROLE.FULL, revoked_at: null }],
    ['srv-ctrl', { id: 'srv-ctrl', name: 'Controlled Node', user_id: 'owner-1', team_id: 'team-1', token_hash: sha256Hex('srv-ctrl-token'), node_role: NODE_ROLE.CONTROLLED, revoked_at: null }],
  ]);
  const teamMembers = new Map<string, string>([
    ['team-1:owner-1', 'owner'],
    ['team-1:user-bob', 'member'],
  ]);
  const sessions = new Map<string, { server_id: string; name: string; project_name: string }>([
    ['srv-1:main-shared', { server_id: 'srv-1', name: 'main-shared', project_name: 'proj' }],
  ]);
  const sessionShares: Array<{
    id: string;
    server_id: string;
    session_name: string;
    target_user_id: string;
    role: 'viewer' | 'participant';
    created_by: string;
    created_at: number;
    updated_at: number;
    expires_at: number | null;
    revoked_at: number | null;
  }> = [];
  const folders = new Map<string, CloudDocFolderRow>();
  const docs = new Map<string, CloudDocRow>();
  const recents = new Map<string, RecentDocumentRow>();
  const shares = new Map<string, CloudDocShareRow>();

  const db: Database = {
    query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = $1')) {
        const userId = params[0] as string;
        const result: Array<{ id: string; name: string; role: string }> = [];
        for (const [key, role] of teamMembers.entries()) {
          const [tid, uid] = key.split(':');
          if (uid === userId && tid && teams.has(tid)) {
            result.push({ id: tid, name: teams.get(tid)!.name, role });
          }
        }
        return result as unknown as T[];
      }
      if (s.includes('FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND revoked_at IS NULL')) {
        const [targetKind, targetId] = params as [string, string];
        return [...shares.values()]
          .filter((r) => r.target_kind === targetKind && r.target_id === targetId && r.revoked_at === null) as unknown as T[];
      }
      if (s.includes("FROM cloud_doc_shares WHERE revoked_at IS NULL AND share_mode = 'user' AND target_user_id = $1")) {
        const userId = params[0] as string;
        return [...shares.values()]
          .filter((r) => r.revoked_at === null && r.share_mode === 'user' && r.target_user_id === userId) as unknown as T[];
      }
      if (s.includes("FROM cloud_doc_shares WHERE revoked_at IS NULL AND share_mode = 'team' AND target_team_id = $1")) {
        const teamId = params[0] as string;
        return [...shares.values()]
          .filter((r) => r.revoked_at === null && r.share_mode === 'team' && r.target_team_id === teamId) as unknown as T[];
      }
      if (s.includes('FROM cloud_doc_folders WHERE user_id = $1')) {
        const userId = params[0] as string;
        return [...folders.values()].filter((f) => f.user_id === userId) as unknown as T[];
      }
      if (s.includes('FROM cloud_docs WHERE user_id = $1')) {
        const userId = params[0] as string;
        return [...docs.values()].filter((d) => d.user_id === userId) as unknown as T[];
      }
      if (s.includes('FROM recent_documents WHERE user_id = $1')) {
        const [userId, limit] = params as [string, number];
        return [...recents.values()]
          .filter((r) => r.user_id === userId)
          .slice(0, limit ?? 50) as unknown as T[];
      }
      if (s.includes('FROM session_shares')) {
        const [now, userId, serverId, sessionName] = params as [number, string, string, string];
        return sessionShares
          .filter((r) =>
            r.revoked_at === null &&
            (r.expires_at === null || r.expires_at > now) &&
            r.target_user_id === userId &&
            r.server_id === serverId &&
            r.session_name === sessionName,
          )
          .map((r) => ({ target_kind: 'main', ...r })) as unknown as T[];
      }
      if (s.includes('FROM server_shares') || s.includes('FROM sub_session_shares')) {
        return [] as T[];
      }
      return [] as T[];
    },

    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('WHERE id = $1 OR lower(username) = lower($1)')) {
        const ident = String(params[0] ?? '').toLowerCase();
        const byId = users.get(params[0] as string);
        if (byId) return byId as unknown as T;
        return ([...users.values()].find((r) => r.username.toLowerCase() === ident) ?? null) as unknown as T | null;
      }
      if (s.includes('FROM users WHERE id = $1')) {
        return (users.get(params[0] as string) ?? null) as unknown as T | null;
      }
      if (s === 'SELECT name FROM teams WHERE id = $1') {
        const t = teams.get(params[0] as string);
        return (t ? { name: t.name } : null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_doc_shares WHERE id = $1')) {
        return (shares.get(params[0] as string) ?? null) as unknown as T | null;
      }
      if (s.includes("FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND share_mode = 'team'")) {
        const [targetKind, targetId, teamId] = params as [string, string, string];
        return ([...shares.values()].find(
          (r) => r.revoked_at === null && r.target_kind === targetKind && r.target_id === targetId && r.share_mode === 'team' && r.target_team_id === teamId,
        ) ?? null) as unknown as T | null;
      }
      if (s.includes("FROM cloud_doc_shares WHERE target_kind = $1 AND target_id = $2 AND share_mode = 'user'")) {
        const [targetKind, targetId, userId] = params as [string, string, string];
        return ([...shares.values()].find(
          (r) => r.revoked_at === null && r.target_kind === targetKind && r.target_id === targetId && r.share_mode === 'user' && r.target_user_id === userId,
        ) ?? null) as unknown as T | null;
      }
      if (s.includes('token_hash') && s.includes('node_role') && s.includes('FROM servers WHERE id = $1')) {
        const srv = servers.get(params[0] as string);
        if (!srv) return null;
        return {
          token_hash: srv.token_hash,
          user_id: srv.user_id,
          node_role: srv.node_role,
          revoked_at: srv.revoked_at,
          owner_status: users.get(srv.user_id)?.status ?? null,
        } as unknown as T;
      }
      if (s.includes('SELECT EXISTS (SELECT 1 FROM sessions WHERE server_id = $1 AND name = $2)')) {
        const [serverId, name] = params as [string, string];
        return { exists: sessions.has(`${serverId}:${name}`) } as unknown as T;
      }
      if (s === 'SELECT project_name FROM sessions WHERE server_id = $1 AND name = $2 LIMIT 1') {
        const [serverId, name] = params as [string, string];
        const sess = sessions.get(`${serverId}:${name}`);
        return (sess ? { project_name: sess.project_name } : null) as unknown as T | null;
      }
      if (s.includes('AS actor_status') && s.includes('AS owner_status') && !s.includes('FROM servers WHERE id = $1')) {
        const [actorId, serverId] = params as [string, string];
        const srv = servers.get(serverId);
        return {
          actor_status: users.get(actorId)?.status ?? null,
          owner_status: srv ? (users.get(srv.user_id)?.status ?? null) : null,
        } as unknown as T;
      }
      if (s.includes('FROM cloud_doc_folders WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const f = folders.get(id);
        return (f && f.user_id === userId ? { ...f } : null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_doc_folders WHERE id = $1') && !s.includes('user_id = $2')) {
        const f = folders.get(params[0] as string);
        return (f ? { ...f } : null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_docs WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const d = docs.get(id);
        return (d && d.user_id === userId ? { ...d } : null) as unknown as T | null;
      }
      if (s.includes('FROM cloud_docs WHERE id = $1') && !s.includes('user_id = $2')) {
        const d = docs.get(params[0] as string);
        return (d ? { ...d } : null) as unknown as T | null;
      }
      if (s.startsWith('INSERT INTO cloud_docs')) {
        const [id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at, last_opened_at] =
          params as [string, string, string | null, string, string, string, number, string, string, number, number, number, number | null];
        const row: CloudDocRow = { id, user_id, folder_id, name, ext, mime_type, size_bytes, content_sha256, storage_key, doc_version, created_at, updated_at, last_opened_at };
        docs.set(id, row);
        return { ...row } as unknown as T;
      }
      if (s.startsWith('UPDATE cloud_docs SET storage_key = $1')) {
        const [storage_key, size_bytes, content_sha256, doc_version, updated_at, id, userId, expectedVersion] =
          params as [string, number, string, number, number, string, string, number];
        const row = docs.get(id);
        if (!row || row.user_id !== userId || Number(row.doc_version) !== expectedVersion) return null;
        row.storage_key = storage_key;
        row.size_bytes = size_bytes;
        row.content_sha256 = content_sha256;
        row.doc_version = doc_version;
        row.updated_at = updated_at;
        return { ...row } as unknown as T;
      }
      if (s.includes('FROM recent_documents WHERE user_id = $1 AND source_key = $2')) {
        const [userId, sourceKey] = params as [string, string];
        return (recents.get(`${userId}:${sourceKey}`) ?? null) as unknown as T | null;
      }
      return null;
    },

    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO cloud_doc_folders')) {
        const [id, user_id, parent_id, name, created_at, updated_at] = params as [string, string, string | null, string, number, number];
        folders.set(id, { id, user_id, parent_id, name, created_at, updated_at });
        return { changes: 1 };
      }
      if (s.startsWith('UPDATE cloud_doc_folders')) {
        const [name, parent_id, updated_at, id, userId] = params as [string, string | null, number, string, string];
        const row = folders.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        row.name = name;
        row.parent_id = parent_id;
        row.updated_at = updated_at;
        return { changes: 1 };
      }
      if (s.startsWith('DELETE FROM cloud_doc_folders WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const row = folders.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        folders.delete(id);
        return { changes: 1 };
      }
      if (s.startsWith('UPDATE cloud_docs SET name = $1')) {
        const [name, ext, mime_type, folder_id, updated_at, id, userId] =
          params as [string, string, string, string | null, number, string, string];
        const row = docs.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        row.name = name;
        row.ext = ext;
        row.mime_type = mime_type;
        row.folder_id = folder_id;
        row.updated_at = updated_at;
        return { changes: 1 };
      }
      if (s.startsWith('DELETE FROM cloud_docs WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        const row = docs.get(id);
        if (!row || row.user_id !== userId) return { changes: 0 };
        docs.delete(id);
        return { changes: 1 };
      }
      if (s.startsWith('DELETE FROM recent_documents WHERE cloud_doc_id = $1')) {
        const [docId] = params as [string];
        let changes = 0;
        for (const [k, r] of recents.entries()) {
          if (r.cloud_doc_id === docId) { recents.delete(k); changes += 1; }
        }
        return { changes };
      }
      if (s.startsWith('DELETE FROM cloud_doc_shares WHERE target_kind =')) {
        const targetKind = s.includes("'doc'") ? 'doc' : 'folder';
        const targetId = params[0] as string;
        let changes = 0;
        for (const [k, row] of shares.entries()) {
          if (row.target_kind === targetKind && row.target_id === targetId) { shares.delete(k); changes += 1; }
        }
        return { changes };
      }
      if (s.startsWith('INSERT INTO cloud_doc_shares')) {
        const [id, target_kind, target_id, share_mode, target_team_id, target_user_id, role, allow_download, created_by, created_at, updated_at] =
          params as [string, 'doc' | 'folder', string, 'team' | 'user', string | null, string | null, 'viewer' | 'editor', boolean, string, number, number];
        shares.set(id, { id, target_kind, target_id, share_mode, target_team_id, target_user_id, role, allow_download, created_by, created_at, updated_at, revoked_at: null });
        return { changes: 1 };
      }
      if (s.startsWith('UPDATE cloud_doc_shares SET revoked_at = $1, updated_at = $2 WHERE id = $3 AND created_by = $4')) {
        const [revoked_at, updated_at, id, created_by] = params as [number, number, string, string];
        const row = shares.get(id);
        if (!row || row.created_by !== created_by || row.revoked_at !== null) return { changes: 0 };
        row.revoked_at = revoked_at;
        row.updated_at = updated_at;
        return { changes: 1 };
      }
      return { changes: 0 };
    },

    exec: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(db),
  } as unknown as Database;

  return { db, users, teams, servers, teamMembers, sessions, sessionShares, folders, docs, recents, shares };
}

describe('cloud docs MCP tools', () => {
  let tmpDir: string;
  let storage: LocalCloudDocStorage;
  let memDb: ReturnType<typeof createInMemoryMcpCloudDocsDb>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imcodes-cloud-docs-mcp-test-'));
    storage = new LocalCloudDocStorage(tmpDir);
    memDb = createInMemoryMcpCloudDocsDb();
    const env: Env = {
      DB: memDb.db,
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SIGNING_KEY: JWT_KEY,
      BOT_ENCRYPTION_KEY: 'test-bot-key',
      SERVER_URL,
      ONLYOFFICE_ENABLED: 'false',
      NODE_ENV: 'test',
    };
    app = buildApp(env, { cloudDocStorage: storage });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function appFetchAdapter(): typeof fetch {
    return (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(app.request(url, init));
    };
  }

  function mintBobParticipantToken() {
    const now = Date.now();
    memDb.sessionShares.push({
      id: `ss-${now}`,
      server_id: 'srv-1',
      session_name: 'main-shared',
      target_user_id: 'user-bob',
      role: 'participant',
      created_by: 'owner-1',
      created_at: now - 1000,
      updated_at: now - 1000,
      expires_at: now + 3600_000,
      revoked_at: null,
    });
    return issueSharedMachineAuthority(
      {
        type: SHARED_MACHINE_AUTHORITY_TYPE,
        sub: 'user-bob',
        sourceServerId: 'srv-1',
        sessionName: 'main-shared',
        projectName: 'proj',
        shareTarget: { kind: 'main', serverId: 'srv-1', sessionName: 'main-shared' },
        actionId: `act-${now}`,
      },
      JWT_KEY,
    );
  }

  it('registers Cloud Docs tools lazily behind mcp_tool_search on FULL nodes and excludes them on CONTROLLED nodes', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createMemoryMcpServer(makeCaller(), { nodeRole: NODE_ROLE.FULL });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const initialTools = (await client.listTools()).tools.map((t) => t.name);
    expect(initialTools).not.toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_LIST);

    await client.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:cloud-docs' } });
    const expandedTools = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of [
      MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_LIST,
      MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_READ,
      MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_CREATE,
      MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_EDIT,
      MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_DELETE,
      MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE,
    ]) {
      expect(expandedTools).toContain(tool);
    }
    await Promise.all([client.close(), server.close()]);

    // Controlled node excludes all 6 tools even after group:cloud-docs search
    const [ctrlClientT, ctrlServerT] = InMemoryTransport.createLinkedPair();
    const ctrlServer = createMemoryMcpServer(makeCaller(), { nodeRole: NODE_ROLE.CONTROLLED });
    const ctrlClient = new Client({ name: 'ctrl-client', version: '1.0.0' });
    await Promise.all([ctrlServer.connect(ctrlServerT), ctrlClient.connect(ctrlClientT)]);
    await ctrlClient.callTool({ name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: 'group:cloud-docs' } });
    const ctrlTools = (await ctrlClient.listTools()).tools.map((t) => t.name);
    expect(ctrlTools).not.toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_LIST);
    expect(ctrlTools).not.toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_CREATE);
    expect(ctrlTools).not.toContain(MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE);
    await Promise.all([ctrlClient.close(), ctrlServer.close()]);
  });

  it('fails closed in createDaemonCloudDocsToolDeps when unbound, on authority-lookup errors, and maps HTTP statuses', async () => {
    const fetchSpy = vi.fn<typeof fetch>();

    // 1. Unbound daemon -> feature_disabled without network call
    const unboundDeps = createDaemonCloudDocsToolDeps({
      loadCredential: async () => null,
      fetchImpl: fetchSpy,
    });
    expect(await unboundDeps.listDocs({})).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.FEATURE_DISABLED,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Shared turn authority hook throws -> fails closed control_plane_unavailable without fallback
    const brokenAuthDeps = createDaemonCloudDocsToolDeps({
      loadCredential: async () => ({ serverUrl: SERVER_URL, serverId: 'srv-1', token: 'srv-1-token' }),
      loadSharedMachineAuthority: async () => { throw new Error('hook_unreachable'); },
      fetchImpl: fetchSpy,
    });
    expect(await brokenAuthDeps.readDoc({ docId: 'd1' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.CONTROL_PLANE_UNAVAILABLE,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    // 3. Per-call turn authority header forwarding + status code mapping
    let currentAuthority: string | null = 'turn-token-1';
    const dynamicDeps = createDaemonCloudDocsToolDeps({
      loadCredential: async () => ({ serverUrl: SERVER_URL, serverId: 'srv-1', token: 'srv-1-token' }),
      loadSharedMachineAuthority: async () => currentAuthority,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get(SERVER_ID_HEADER)).toBe('srv-1');
        expect(headers.get('Authorization')).toBe('Bearer srv-1-token');
        if (currentAuthority) {
          expect(headers.get(SHARED_MACHINE_AUTHORITY_HEADER)).toBe(currentAuthority);
        } else {
          expect(headers.has(SHARED_MACHINE_AUTHORITY_HEADER)).toBe(false);
        }
        return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 });
      },
    });
    expect(await dynamicDeps.editDoc({ docId: 'd1', content: 'x' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.REVISION_CONFLICT,
    });
    currentAuthority = null;
    expect(await dynamicDeps.deleteDoc({ id: 'd1' })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.REVISION_CONFLICT,
    });
  });

  it('executes full end-to-end owner and shared participant workflows across all 6 MCP tools against server routes', async () => {
    let activeTurnAuthority: string | null = null;
    const cloudDocsDeps = createDaemonCloudDocsToolDeps({
      loadCredential: async () => ({ serverUrl: SERVER_URL, serverId: 'srv-1', token: 'srv-1-token' }),
      loadSharedMachineAuthority: async () => activeTurnAuthority,
      fetchImpl: appFetchAdapter(),
    });
    const handlers = createMemoryMcpToolHandlers(makeCaller(), {
      nodeRole: NODE_ROLE.FULL,
      cloudDocsDeps,
    });

    // Owner creates private doc, shared folder, and viewer doc
    const privateCreate = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_CREATE]({
      type: 'docx',
      name: 'OwnerRoadmap',
      content: 'Q4 Launch Plan',
    });
    expect(privateCreate).toMatchObject({ status: 'ok', doc: { name: 'OwnerRoadmap.docx', docVersion: 1 } });
    const privateDocId = (privateCreate as { doc: { id: string } }).doc.id;

    const folderCreate = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_CREATE]({
      kind: 'folder',
      name: 'TeamWorkspace',
    });
    expect(folderCreate).toMatchObject({ status: 'ok', folder: { name: 'TeamWorkspace' } });
    const folderId = (folderCreate as { folder: { id: string } }).folder.id;

    const viewerDocCreate = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_CREATE]({
      type: 'md',
      name: 'Handbook',
      content: 'Readonly Policy',
    });
    const viewerDocId = (viewerDocCreate as { doc: { id: string } }).doc.id;

    // Owner reads teams, grants editor share on folder + viewer share on doc, lists shares
    const teamsRes = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE]({ action: 'list_teams' });
    expect(teamsRes).toMatchObject({ status: 'ok', teams: [{ id: 'team-1', name: 'Docs Team' }] });

    const grantFolderShare = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE]({
      action: 'grant',
      targetKind: 'folder',
      targetId: folderId,
      shareMode: 'user',
      targetUsername: 'bob',
      role: 'editor',
      allowDownload: true,
    });
    expect(grantFolderShare).toMatchObject({ status: 'ok', share: { role: 'editor', targetKind: 'folder' } });

    const grantViewerShare = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE]({
      action: 'grant',
      targetKind: 'doc',
      targetId: viewerDocId,
      shareMode: 'user',
      targetUsername: 'bob',
      role: 'viewer',
      allowDownload: true,
    });
    expect(grantViewerShare).toMatchObject({ status: 'ok', share: { role: 'viewer' } });
    const viewerShareId = (grantViewerShare as { share: { id: string } }).share.id;

    // Switch turn to participant bob
    activeTurnAuthority = mintBobParticipantToken();

    const bobList = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_LIST]({});
    expect(bobList).toMatchObject({ status: 'ok' });
    const bobListPayload = bobList as { docs: Array<{ id: string }>; sharedDocs: Array<{ id: string }>; sharedFolders: Array<{ id: string }> };
    expect(bobListPayload.docs.map((d) => d.id)).not.toContain(privateDocId);
    expect(bobListPayload.sharedFolders.map((f) => f.id)).toContain(folderId);
    expect(bobListPayload.sharedDocs.map((d) => d.id)).toContain(viewerDocId);

    // Participant bob reads viewer doc cleanly, but edit/delete/share fail closed with scope_forbidden
    const bobReadViewer = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_READ]({ docId: viewerDocId });
    expect(bobReadViewer).toMatchObject({ status: 'ok', content: 'Readonly Policy', role: 'viewer' });

    const bobEditViewer = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_EDIT]({
      docId: viewerDocId,
      content: 'Tamper',
      mode: 'replace',
    });
    expect(bobEditViewer).toMatchObject({ status: 'error', reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN });

    // Participant bob creates + reads + appends .xlsx inside shared editor folder
    const bobCreateXlsx = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_CREATE]({
      type: 'xlsx',
      name: 'Metrics',
      folderId,
      content: 'KPI\tValue\nLatency\t12',
    });
    expect(bobCreateXlsx).toMatchObject({ status: 'ok', doc: { name: 'Metrics.xlsx', folderId, docVersion: 1 } });
    const metricsDocId = (bobCreateXlsx as { doc: { id: string } }).doc.id;

    const bobEditMetrics = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_EDIT]({
      docId: metricsDocId,
      content: 'Throughput\t450',
      mode: 'append',
      expectedVersion: 1,
    });
    expect(bobEditMetrics).toMatchObject({ status: 'ok', doc: { docVersion: 2 }, role: 'editor' });

    const bobReadMetrics = await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_READ]({ docId: metricsDocId });
    expect(bobReadMetrics).toMatchObject({
      status: 'ok',
      format: 'xlsx',
      sheets: [{ name: 'Sheet1', rows: [['KPI', 'Value'], ['Latency', '12'], ['Throughput', '450']] }],
    });

    // Participant bob cannot delete or manage shares on shared doc
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_DELETE]({ id: metricsDocId })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE]({ action: 'list', targetKind: 'doc', targetId: metricsDocId })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });

    // Tampered authority fails closed (never falls back to host owner)
    activeTurnAuthority = 'tampered.authority.jwt';
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_READ]({ docId: privateDocId })).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });

    // Return to host owner turn -> can revoke share and delete private doc
    activeTurnAuthority = null;
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_SHARE]({ action: 'revoke', shareId: viewerShareId })).toMatchObject({
      status: 'ok',
      ok: true,
    });
    expect(await handlers[MEMORY_MCP_TOOL_NAMES.CLOUD_DOC_DELETE]({ id: privateDocId })).toMatchObject({
      status: 'ok',
      ok: true,
    });

    // Controlled node credentials are still rejected at the server boundary
    const ctrlDeps = createDaemonCloudDocsToolDeps({
      loadCredential: async () => ({ serverUrl: SERVER_URL, serverId: 'srv-ctrl', token: 'srv-ctrl-token' }),
      fetchImpl: appFetchAdapter(),
    });
    expect(await ctrlDeps.listDocs({})).toMatchObject({
      status: 'error',
      reason: MCP_ERROR_REASONS.SCOPE_FORBIDDEN,
    });
    expect(createMemoryMcpServerFromEnv).toBeTypeOf('function');
  });
});
