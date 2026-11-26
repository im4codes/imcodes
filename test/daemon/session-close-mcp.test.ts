import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE, MCP_TOOL_GROUPS } from '../../shared/mcp-tool-discovery.js';
import { MEMORY_MCP_TOOL_CONTRACTS, MEMORY_MCP_TOOL_NAMES, MEMORY_MCP_SESSION_CLOSE_HOOK_PATH } from '../../shared/memory-mcp-contracts.js';
import type { SessionCloseRequest, SessionCloseResult } from '../../shared/session-close.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { mergeDefaultToolDeps } from '../../src/daemon/memory-mcp-server.js';
import type { McpRuntimeCaller } from '../../src/daemon/memory-mcp-caller.js';

const caller: McpRuntimeCaller = {
  userId: 'user-1',
  namespace: { scope: 'user_private', userId: 'user-1', projectId: 'project-1' },
  sessionName: 'deck_project_brain',
  projectName: 'project',
  projectRoot: '/tmp/project',
  serverId: 'server-1',
  providerId: 'codex-sdk',
  transport: 'in_process',
};
const TOOL = MEMORY_MCP_TOOL_NAMES.SESSION_CLOSE;

describe('session_close tool surface', () => {
  it('is discoverable with the supervision tools and keeps the default catalog small', () => {
    expect(MCP_TOOL_DISCOVERY_DEFAULT_ACTIVE).not.toContain(TOOL);
    expect(MCP_TOOL_GROUPS.find((group) => group.id === 'supervision')?.tools).toContain(TOOL);
  });

  it('publishes an exact-target schema with only the two Brain flags', () => {
    const contract = MEMORY_MCP_TOOL_CONTRACTS[TOOL];
    expect(contract.inputSchema).toMatchObject({
      type: 'object',
      required: ['target'],
      additionalProperties: false,
      properties: { target: { type: 'string' }, force: { type: 'boolean' }, confirmUserCreated: { type: 'boolean' } },
    });
    expect(Object.keys((contract.inputSchema as { properties: object }).properties).sort()).toEqual(['confirmUserCreated', 'force', 'target']);
    expect(contract.description).toMatch(/soft/i);
    expect(contract.description).not.toMatch(/delete/i);
  });
});

describe('session_close MCP handler', () => {
  const handlerWith = (closeSession?: (request: SessionCloseRequest) => Promise<SessionCloseResult> | SessionCloseResult, scoped = caller) => (
    createMemoryMcpToolHandlers(scoped, { sendDeps: { listSessions: () => [] }, ...(closeSession ? { closeSession } : {}) })[TOOL]
  );

  it('forwards the exact target and only literal-true flags, and reports a close', async () => {
    const closeSession = vi.fn(async (): Promise<SessionCloseResult> => ({
      status: 'closed', target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false,
    }));
    await expect(handlerWith(closeSession)({ target: ' deck_sub_a ', force: true, confirmUserCreated: 'yes', extra: 1 })).resolves.toEqual({
      status: 'ok', result: 'closed', target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false,
    });
    expect(closeSession).toHaveBeenCalledWith({ target: 'deck_sub_a', force: true });
  });

  it('reports an already closed session as success (idempotent)', async () => {
    await expect(handlerWith(async () => ({ status: 'already_closed', target: 'deck_sub_a' }))({ target: 'deck_sub_a' }))
      .resolves.toEqual({ status: 'ok', result: 'already_closed', target: 'deck_sub_a' });
  });

  it('explains a refusal with its reason, as a scope error for authority and a validation error for work in flight', async () => {
    const refuse = (reason: string) => handlerWith(async () => ({ status: 'refused', target: 'deck_sub_a', reason, detail: `because ${reason}` } as SessionCloseResult))({ target: 'deck_sub_a' });
    await expect(refuse('not_authorized')).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden', closeReason: 'not_authorized', target: 'deck_sub_a' });
    await expect(refuse('not_a_sub_session')).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden', closeReason: 'not_a_sub_session' });
    await expect(refuse('force_not_permitted')).resolves.toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    await expect(refuse('open_pair')).resolves.toMatchObject({ status: 'error', reason: 'validation_failed', closeReason: 'open_pair' });
    await expect(refuse('queued_messages')).resolves.toMatchObject({ status: 'error', reason: 'validation_failed', closeReason: 'queued_messages' });
    const detail = await refuse('turn_running');
    expect(JSON.stringify(detail)).toContain('because turn_running');
  });

  it('reports a failed stop as an internal error and a missing control plane as unavailable', async () => {
    await expect(handlerWith(async () => ({ status: 'failed', target: 'deck_sub_a', error: 'runtime: still active' }))({ target: 'deck_sub_a' }))
      .resolves.toMatchObject({ status: 'error', reason: 'internal_error', closeReason: 'failed' });
    await expect(handlerWith(undefined)({ target: 'deck_sub_a' })).resolves.toMatchObject({ status: 'error', reason: 'control_plane_unavailable' });
    await expect(handlerWith(async () => { throw new Error('daemon down'); })({ target: 'deck_sub_a' }))
      .resolves.toMatchObject({ status: 'error', reason: 'control_plane_unavailable' });
  });

  it('requires a target and a scoped caller', async () => {
    const closeSession = vi.fn();
    await expect(handlerWith(closeSession as never)({})).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlerWith(closeSession as never)({ target: '   ' })).resolves.toMatchObject({ status: 'error', reason: 'validation_failed' });
    await expect(handlerWith(closeSession as never, { ...caller, sessionName: undefined })({ target: 'deck_sub_a' }))
      .resolves.toMatchObject({ status: 'error', reason: 'identity_rejected' });
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe('session_close forwarding to the daemon hook', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function hook(respond: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
    const seen: Array<{ url: string; sender?: string; body: Record<string, unknown> }> = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url ?? '', sender: req.headers['x-imcodes-session'] as string | undefined, body: raw ? JSON.parse(raw) : {} });
        respond(req, res, raw);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const deps = mergeDefaultToolDeps(caller, {}, null, { resolveHookPort: async () => port });
    return { seen, close: deps.closeSession! };
  }

  it('posts the exact target as the authenticated caller and returns the daemon\'s decision unchanged', async () => {
    const { seen, close } = await hook((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'closed', target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false }));
    });
    await expect(close({ target: 'deck_sub_a', force: true })).resolves.toEqual({
      status: 'closed', target: 'deck_sub_a', authority: 'brain', serverNotified: true, forced: false,
    });
    expect(seen).toEqual([{
      url: MEMORY_MCP_SESSION_CLOSE_HOOK_PATH,
      sender: 'deck_project_brain',
      body: { from: 'deck_project_brain', target: 'deck_sub_a', force: true },
    }]);
  });

  it('says plainly that an older daemon does not support the tool', async () => {
    // An older daemon answers every route it does not know with an empty 404.
    const { close } = await hook((_req, res) => { res.writeHead(404); res.end(); });
    await expect(close({ target: 'deck_sub_a' })).rejects.toThrow(/does not support session_close/u);
    // And through the tool, that is an error result rather than a crash.
    const handler = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [] }, closeSession: close })[TOOL];
    await expect(handler({ target: 'deck_sub_a' })).resolves.toMatchObject({
      status: 'error', reason: 'control_plane_unavailable', message: expect.stringContaining('does not support session_close'),
    });
  });
});
