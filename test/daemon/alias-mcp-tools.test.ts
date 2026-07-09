import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ContextNamespace } from '../../shared/context-types.js';
import { ALIAS_MCP_TOOLS, ALIAS_REASONS, type AliasEntry } from '../../shared/alias-types.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import {
  createAliasMcpToolHandlers,
  type AliasMcpToolDeps,
} from '../../src/daemon/memory-mcp-tools.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';
import {
  aliasMcpList,
  aliasMcpResolve,
  aliasMcpUpsert,
  aliasMcpDelete,
  type AliasServerEndpoint,
} from '../../src/daemon/alias-mcp-client.js';

function caller(overrides: Partial<McpRuntimeCaller> = {}): McpRuntimeCaller {
  const namespace: ContextNamespace = { scope: 'user_private', userId: 'user-1', projectId: 'repo-1' };
  return {
    userId: 'user-1',
    namespace,
    sessionName: 'deck_proj_brain',
    projectName: 'proj',
    projectRoot: '/tmp/proj',
    serverId: 'srv-1',
    transport: 'in_process',
    ...overrides,
  };
}

function aliasEntry(overrides: Partial<AliasEntry> = {}): AliasEntry {
  return {
    name: 'deploy',
    value: 'ssh root@host "deploy"',
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    source: 'web',
    ...overrides,
  };
}

const OWNER_ENDPOINT: AliasServerEndpoint = {
  serverId: 'srv-1',
  workerUrl: 'https://example.test',
  token: 'owner-token',
};

describe('alias MCP tools', () => {
  describe('resolve_alias', () => {
    it('returns the current value for a known name', async () => {
      const alias = aliasEntry({ name: 'deploy', value: 'run deploy now' });
      const resolveAlias = vi.fn<typeof aliasMcpResolve>(async () => ({
        status: 'ok',
        found: true,
        name: 'deploy',
        alias,
      }));
      const handlers = createAliasMcpToolHandlers(caller(), { resolveAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.RESOLVE]({ name: 'deploy' });

      expect(resolveAlias).toHaveBeenCalledWith('deploy', {});
      expect(result).toMatchObject({ status: 'ok', found: true, name: 'deploy' });
      expect((result as { alias: AliasEntry }).alias.value).toBe('run deploy now');
    });

    it('returns a not-found result (no error) for a missing name', async () => {
      const resolveAlias = vi.fn<typeof aliasMcpResolve>(async (name) => ({
        status: 'ok',
        found: false,
        name,
        reason: ALIAS_REASONS.NOT_FOUND,
      }));
      const handlers = createAliasMcpToolHandlers(caller(), { resolveAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.RESOLVE]({ name: 'ghost' });

      expect(result).toEqual({
        status: 'ok',
        found: false,
        name: 'ghost',
        reason: ALIAS_REASONS.NOT_FOUND,
      });
      // Not-found is not an error status.
      expect((result as { status: string }).status).not.toBe('error');
    });

    it('rejects a missing name argument with validation_failed', async () => {
      const resolveAlias = vi.fn<typeof aliasMcpResolve>();
      const handlers = createAliasMcpToolHandlers(caller(), { resolveAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.RESOLVE]({});

      expect(resolveAlias).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    });
  });

  describe('list_aliases', () => {
    it('returns the bound owner user aliases (user-scoped) with METADATA ONLY (no value)', async () => {
      const ownerAliases = [
        aliasEntry({ name: 'a', value: 'secret-a', description: 'first', tags: ['t1'] }),
        aliasEntry({ name: 'b', value: 'secret-b' }),
      ];
      const listAliases = vi.fn<typeof aliasMcpList>(async () => ({ status: 'ok', aliases: ownerAliases }));
      const handlers = createAliasMcpToolHandlers(caller(), { listAliases });
      const result = await handlers[ALIAS_MCP_TOOLS.LIST]({});

      expect(listAliases).toHaveBeenCalledTimes(1);
      // A bulk listing must NEVER carry alias plaintext values (disclosure RV-A):
      // every item exposes metadata only, and no item has a `value` field.
      const items = (result as { status: string; aliases: Array<Record<string, unknown>> }).aliases;
      expect((result as { status: string }).status).toBe('ok');
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item).not.toHaveProperty('value');
      }
      expect(items[0]).toMatchObject({
        name: 'a',
        description: 'first',
        tags: ['t1'],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      // No alias value string leaks anywhere in the serialized result.
      expect(JSON.stringify(result)).not.toContain('secret-a');
      expect(JSON.stringify(result)).not.toContain('secret-b');
    });

    it('propagates a client failure as an error result', async () => {
      const listAliases = vi.fn<typeof aliasMcpList>(async () => ({
        status: 'error',
        reason: 'identity_rejected',
        message: 'alias MCP requires a bound daemon server credential',
      }));
      const handlers = createAliasMcpToolHandlers(caller(), { listAliases });
      const result = await handlers[ALIAS_MCP_TOOLS.LIST]({});

      expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    });

    it('passes an optional search query through to the client', async () => {
      const listAliases = vi.fn<typeof aliasMcpList>(async () => ({ status: 'ok', aliases: [] }));
      const handlers = createAliasMcpToolHandlers(caller(), { listAliases });
      await handlers[ALIAS_MCP_TOOLS.LIST]({ query: 'dep' });
      expect(listAliases).toHaveBeenCalledWith({}, 'dep');
    });
  });

  describe('save_alias (create / edit upsert)', () => {
    it('upserts via the client and returns metadata only (never echoes the value)', async () => {
      const saved = aliasEntry({ name: 'deploy', value: 'ssh secret', description: 'prod', tags: ['ops'], source: 'mcp' });
      const upsertAlias = vi.fn<typeof aliasMcpUpsert>(async () => ({ status: 'ok', alias: saved }));
      const handlers = createAliasMcpToolHandlers(caller(), { upsertAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.SAVE]({ name: 'deploy', value: 'ssh secret', description: 'prod', tags: ['ops'] });

      expect(upsertAlias).toHaveBeenCalledWith(
        { name: 'deploy', value: 'ssh secret', description: 'prod', tags: ['ops'] },
        {},
      );
      expect(result).toMatchObject({ status: 'ok', saved: true, alias: { name: 'deploy', description: 'prod', tags: ['ops'] } });
      // The saved value is NEVER echoed back into the agent's context.
      expect(result).not.toHaveProperty('alias.value');
      expect(JSON.stringify(result)).not.toContain('ssh secret');
    });

    it('requires a name argument', async () => {
      const upsertAlias = vi.fn<typeof aliasMcpUpsert>();
      const handlers = createAliasMcpToolHandlers(caller(), { upsertAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.SAVE]({ value: 'x' });
      expect(upsertAlias).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    });

    it('surfaces a server-authoritative validation rejection', async () => {
      const upsertAlias = vi.fn<typeof aliasMcpUpsert>(async () => ({
        status: 'error', reason: 'validation_failed', message: ALIAS_REASONS.VALUE_INVALID,
      }));
      const handlers = createAliasMcpToolHandlers(caller(), { upsertAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.SAVE]({ name: 'deploy', value: '' });
      expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    });

    it('drops non-string tags before sending to the server', async () => {
      const upsertAlias = vi.fn<typeof aliasMcpUpsert>(async () => ({ status: 'ok', alias: aliasEntry({ tags: ['ok'] }) }));
      const handlers = createAliasMcpToolHandlers(caller(), { upsertAlias });
      await handlers[ALIAS_MCP_TOOLS.SAVE]({ name: 'deploy', value: 'v', tags: ['ok', 3, null] });
      expect(upsertAlias).toHaveBeenCalledWith(expect.objectContaining({ tags: ['ok'] }), {});
    });
  });

  describe('delete_alias', () => {
    it('deletes via the client and returns deleted:true', async () => {
      const deleteAlias = vi.fn<typeof aliasMcpDelete>(async (name) => ({ status: 'ok', deleted: true, name }));
      const handlers = createAliasMcpToolHandlers(caller(), { deleteAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.DELETE]({ name: 'deploy' });
      expect(deleteAlias).toHaveBeenCalledWith('deploy', {});
      expect(result).toEqual({ status: 'ok', deleted: true, name: 'deploy' });
    });

    it('returns deleted:false (not an error) for a missing name', async () => {
      const deleteAlias = vi.fn<typeof aliasMcpDelete>(async (name) => ({
        status: 'ok', deleted: false, name, reason: ALIAS_REASONS.NOT_FOUND,
      }));
      const handlers = createAliasMcpToolHandlers(caller(), { deleteAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.DELETE]({ name: 'ghost' });
      expect((result as { status: string }).status).not.toBe('error');
      expect(result).toMatchObject({ deleted: false, reason: ALIAS_REASONS.NOT_FOUND });
    });

    it('requires a name argument', async () => {
      const deleteAlias = vi.fn<typeof aliasMcpDelete>();
      const handlers = createAliasMcpToolHandlers(caller(), { deleteAlias });
      const result = await handlers[ALIAS_MCP_TOOLS.DELETE]({});
      expect(deleteAlias).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    });
  });

  describe('tool registration', () => {
    it('registers the full alias CRUD tool set with agent-usable descriptions', async () => {
      const server = createMemoryMcpServer(caller());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'alias-mcp-test', version: '0.1.0' });
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name);

        expect(names).toContain(ALIAS_MCP_TOOLS.RESOLVE);
        expect(names).toContain(ALIAS_MCP_TOOLS.LIST);
        expect(names).toContain(ALIAS_MCP_TOOLS.SAVE);
        expect(names).toContain(ALIAS_MCP_TOOLS.DELETE);

        const desc = (n: string) => listed.tools.find((tool) => tool.name === n)?.description ?? '';
        // list advertises metadata-only + the search query + points to resolve_alias for values.
        expect(desc(ALIAS_MCP_TOOLS.LIST)).toMatch(/metadata only/i);
        expect(desc(ALIAS_MCP_TOOLS.LIST)).toMatch(/resolve_alias/);
        expect(desc(ALIAS_MCP_TOOLS.LIST)).toMatch(/search/i);
        // save advertises upsert/overwrite semantics + server-authoritative validation.
        expect(desc(ALIAS_MCP_TOOLS.SAVE)).toMatch(/upsert|overwrite/i);
        expect(desc(ALIAS_MCP_TOOLS.SAVE)).toMatch(/valid/i);
        // delete advertises the not-found (deleted:false) non-error shape.
        expect(desc(ALIAS_MCP_TOOLS.DELETE)).toMatch(/deleted:false|not.?found/i);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe('alias-mcp-client (daemon → server channel)', () => {
    function fetchReturning(body: unknown, init: { status?: number } = {}): {
      fetchImpl: typeof fetch;
      calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }>;
    } {
      const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = [];
      const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
        calls.push({
          url,
          method: options.method ?? 'GET',
          headers: options.headers as Record<string, string>,
          body: typeof options.body === 'string' ? JSON.parse(options.body) : undefined,
        });
        return {
          ok: (init.status ?? 200) < 400,
          status: init.status ?? 200,
          json: async () => body,
        } as Response;
      }) as unknown as typeof fetch;
      return { fetchImpl, calls };
    }

    it('lists aliases via an authenticated GET scoped to the bound owner credential', async () => {
      const rows: AliasEntry[] = [aliasEntry({ name: 'deploy' })];
      const { fetchImpl, calls } = fetchReturning({ aliases: rows });
      const result = await aliasMcpList({ endpoint: OWNER_ENDPOINT, fetchImpl });

      expect(result).toMatchObject({ status: 'ok' });
      expect((result as { aliases: AliasEntry[] }).aliases[0].name).toBe('deploy');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/aliases');
      // Owner scoping rides the bound server credential, not a caller-supplied user id.
      expect(calls[0].headers.Authorization).toBe('Bearer owner-token');
      expect(calls[0].headers['X-Server-Id']).toBe('srv-1');
    });

    it('resolve returns the matching entry from the owner list', async () => {
      const rows: AliasEntry[] = [aliasEntry({ name: 'deploy', value: 'x' }), aliasEntry({ name: 'build', value: 'y' })];
      const { fetchImpl } = fetchReturning({ aliases: rows });
      const result = await aliasMcpResolve('build', { endpoint: OWNER_ENDPOINT, fetchImpl });

      expect(result).toMatchObject({ status: 'ok', found: true, name: 'build' });
      expect((result as { alias: AliasEntry }).alias.value).toBe('y');
    });

    it('resolve returns not-found (never throws) for a missing name', async () => {
      const { fetchImpl } = fetchReturning({ aliases: [aliasEntry({ name: 'deploy' })] });
      const result = await aliasMcpResolve('ghost', { endpoint: OWNER_ENDPOINT, fetchImpl });

      expect(result).toEqual({
        status: 'ok',
        found: false,
        name: 'ghost',
        reason: ALIAS_REASONS.NOT_FOUND,
      });
    });

    it('resolve returns not-found for an invalid name without hitting the server', async () => {
      const { fetchImpl, calls } = fetchReturning({ aliases: [] });
      const result = await aliasMcpResolve('bad name!', { endpoint: OWNER_ENDPOINT, fetchImpl });

      expect(calls).toHaveLength(0);
      expect(result).toMatchObject({ status: 'ok', found: false, reason: ALIAS_REASONS.NOT_FOUND });
    });

    it('fails with identity_rejected when no bound credential is available', async () => {
      const result = await aliasMcpList({ endpoint: null });
      expect(result).toMatchObject({ status: 'error', reason: 'identity_rejected' });
    });

    it('maps 403 to scope_forbidden', async () => {
      const { fetchImpl } = fetchReturning({ error: 'forbidden' }, { status: 403 });
      const result = await aliasMcpList({ endpoint: OWNER_ENDPOINT, fetchImpl });
      expect(result).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    });

    it('list passes an optional search query through as ?q=', async () => {
      const { fetchImpl, calls } = fetchReturning({ aliases: [] });
      await aliasMcpList({ endpoint: OWNER_ENDPOINT, fetchImpl }, 'dep');
      expect(calls[0].url).toContain('q=dep');
    });

    it('upserts via an authenticated POST with a JSON body and returns the saved alias', async () => {
      const saved = aliasEntry({ name: 'deploy', value: 'v', source: 'mcp' });
      const { fetchImpl, calls } = fetchReturning({ alias: saved });
      const result = await aliasMcpUpsert(
        { name: 'deploy', value: 'v', description: 'd', tags: ['t'] },
        { endpoint: OWNER_ENDPOINT, fetchImpl },
      );

      expect(result).toMatchObject({ status: 'ok', alias: { name: 'deploy', value: 'v' } });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].url).toContain('/api/aliases');
      expect(calls[0].headers.Authorization).toBe('Bearer owner-token');
      expect(calls[0].headers['X-Server-Id']).toBe('srv-1');
      expect(calls[0].body).toEqual({ name: 'deploy', value: 'v', description: 'd', tags: ['t'] });
    });

    it('maps a 400 upsert rejection to validation_failed (never leaks the value)', async () => {
      const { fetchImpl } = fetchReturning({ error: ALIAS_REASONS.VALUE_INVALID }, { status: 400 });
      const result = await aliasMcpUpsert({ name: 'deploy', value: '' }, { endpoint: OWNER_ENDPOINT, fetchImpl });
      expect(result).toMatchObject({ status: 'error', reason: 'validation_failed' });
    });

    it('deletes via an authenticated DELETE to the /:name path and returns deleted:true', async () => {
      const { fetchImpl, calls } = fetchReturning({ ok: true });
      const result = await aliasMcpDelete('deploy', { endpoint: OWNER_ENDPOINT, fetchImpl });
      expect(result).toEqual({ status: 'ok', deleted: true, name: 'deploy' });
      expect(calls[0].method).toBe('DELETE');
      expect(calls[0].url).toContain('/api/aliases/deploy');
    });

    it('delete returns deleted:false (not an error) on a 404', async () => {
      const { fetchImpl } = fetchReturning({ error: ALIAS_REASONS.NOT_FOUND }, { status: 404 });
      const result = await aliasMcpDelete('ghost', { endpoint: OWNER_ENDPOINT, fetchImpl });
      expect(result).toMatchObject({ status: 'ok', deleted: false, reason: ALIAS_REASONS.NOT_FOUND });
    });

    it('read-after-write round trip: upsert then resolve returns the saved value', async () => {
      // Tiny in-memory server keyed by NFC name: POST stores, GET lists.
      const store = new Map<string, AliasEntry>();
      const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
        const method = options.method ?? 'GET';
        if (method === 'POST') {
          const b = JSON.parse(options.body as string) as { name: string; value: string };
          const entry = aliasEntry({ name: b.name, value: b.value, source: 'mcp' });
          store.set(b.name, entry);
          return { ok: true, status: 200, json: async () => ({ alias: entry }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ aliases: [...store.values()] }) } as Response;
      }) as unknown as typeof fetch;

      const opts = { endpoint: OWNER_ENDPOINT, fetchImpl };
      const saved = await aliasMcpUpsert({ name: 'deploy', value: 'ssh prod' }, opts);
      expect(saved).toMatchObject({ status: 'ok', alias: { name: 'deploy', source: 'mcp' } });

      const resolved = await aliasMcpResolve('deploy', opts);
      expect(resolved).toMatchObject({ status: 'ok', found: true, name: 'deploy' });
      expect((resolved as { alias: AliasEntry }).alias.value).toBe('ssh prod');
    });
  });
});
