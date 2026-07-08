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

describe('alias MCP read tools', () => {
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
  });

  describe('tool registration', () => {
    it('registers only the read-only alias tools; no save_alias/delete_alias', async () => {
      const server = createMemoryMcpServer(caller());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'alias-mcp-test', version: '0.1.0' });
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name);

        expect(names).toContain(ALIAS_MCP_TOOLS.RESOLVE);
        expect(names).toContain(ALIAS_MCP_TOOLS.LIST);
        expect(names).not.toContain('save_alias');
        expect(names).not.toContain('delete_alias');

        // Descriptions must state aliases are a distinct server store with user-only writes.
        const resolveTool = listed.tools.find((tool) => tool.name === ALIAS_MCP_TOOLS.RESOLVE);
        expect(resolveTool?.description ?? '').toMatch(/web app/i);
        const listTool = listed.tools.find((tool) => tool.name === ALIAS_MCP_TOOLS.LIST);
        expect(listTool?.description ?? '').toMatch(/web app/i);
        // list_aliases must advertise it returns metadata only and points to resolve_alias for values.
        expect(listTool?.description ?? '').toMatch(/metadata only/i);
        expect(listTool?.description ?? '').toMatch(/resolve_alias/);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe('alias-mcp-client (daemon → server read channel)', () => {
    function fetchReturning(body: unknown, init: { status?: number } = {}): {
      fetchImpl: typeof fetch;
      calls: Array<{ url: string; headers: Record<string, string> }>;
    } {
      const calls: Array<{ url: string; headers: Record<string, string> }> = [];
      const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
        calls.push({ url, headers: options.headers as Record<string, string> });
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
  });
});
