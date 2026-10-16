import { getContextStoreClient } from '../../src/store/context-store-worker-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { mcpToolPayload } from '../helpers/mcp-tool-result.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSessionTextMessages, readSessionSummaries } from '../../src/daemon/session-history.js';
import { timelineStore } from '../../src/daemon/timeline-store.js';
import { createMemoryMcpToolHandlers } from '../../src/daemon/memory-mcp-tools.js';
import { MEMORY_MCP_TOOL_NAMES as N } from '../../shared/memory-mcp-contracts.js';
import { MEMORY_MCP_DAEMON_TOOL_NAMES } from '../../shared/memory-mcp-daemon-rpc.js';
import { SESSION_TEXT_HISTORY_MAX_CHARS, SESSION_TEXT_HISTORY_MAX_LIMIT } from '../../shared/session-history.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';
import type { SessionRecord } from '../../src/store/session-store.js';
const name = 'deck_history_brain';
const session = { name, projectName: 'history', projectDir: '/scoped-test', agentType: 'codex-sdk', role: 'brain', state: 'idle' } as SessionRecord;
const caller = { userId: 'user-1', namespace: { scope: 'user_private' as const, userId: 'user-1', projectId: 'history' }, sessionName: name, projectName: 'history', projectRoot: '/scoped-test', serverId: 'srv-test', providerId: 'codex-sdk', transport: 'in_process' as const };
const event = (seq: number, text: string, type: TimelineEvent['type'] = 'assistant.text', extra = {}): TimelineEvent => ({ eventId: `e-${seq}`, sessionId: name, epoch: 1, seq, ts: seq, source: 'daemon', confidence: 'high', type, payload: { text, ...extra } });
afterEach(() => vi.restoreAllMocks());
describe('provider-independent current-session text history', () => {
  it('filters non-text/stream/hidden events and preserves text ordering', async () => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([event(1, 'USER原文', 'user.message'), event(2, 'partial', 'assistant.text', { streaming: true }), event(3, 'tool', 'tool.result'), event(4, 'hidden', 'assistant.text', { hidden: true }), event(5, '答案')]);
    expect(await readSessionTextMessages(name, 5)).toEqual([
      { eventId: 'e-1', role: 'user', text: 'USER原文', ts: 1, truncated: false },
      { eventId: 'e-5', role: 'assistant', text: '答案', ts: 5, truncated: false },
    ]);
    expect(read).toHaveBeenCalledWith(name, 5, { visibleOnly: true });
  });
  it('bounds output, marks truncation, and redacts before truncating', async () => {
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue(Array.from({ length: SESSION_TEXT_HISTORY_MAX_LIMIT }, (_, i) => event(i, 'password=hunter2 ' + '。'.repeat(2000))));
    const messages = await readSessionTextMessages(name, SESSION_TEXT_HISTORY_MAX_LIMIT);
    expect(messages.every((m) => m.truncated && !m.text.includes('hunter2'))).toBe(true);
    expect(messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(SESSION_TEXT_HISTORY_MAX_CHARS);
  });
  it.each([0, -1, 201, 1.5, Number.NaN])('refuses invalid limit %s before touching history', async (limit) => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail');
    await expect(readSessionTextMessages(name, limit)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it('binds MCP to the current session, defaults to 20 and never accepts another target', async () => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([event(1, 'remember')]);
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session] } });
    expect(await handlers[N.SESSION_TEXT_HISTORY]({})).toMatchObject({ status: 'ok', requested: 20, count: 1 });
    expect(read).toHaveBeenCalledWith(name, 20, { visibleOnly: true });
    expect(await handlers[N.SESSION_TEXT_HISTORY]({ limit: 1 })).toMatchObject({ status: 'ok', requested: 1 });
    for (const args of [{ sessionName: 'other' }, { target: 'other' }, { limit: 201 }]) expect(await handlers[N.SESSION_TEXT_HISTORY](args)).toMatchObject({ status: 'error' });
  });
  it('proxies all three new live-state operations from stdio into the daemon', async () => {
    const invokeDaemonMemoryTool = vi.fn(async () => ({ status: 'ok' }));
    const handlers = createMemoryMcpToolHandlers({ ...caller, transport: 'stdio' }, { invokeDaemonMemoryTool });
    for (const tool of [N.SESSION_TEXT_HISTORY, N.PAIR_PAUSE, N.PAIR_RESUME]) {
      expect(MEMORY_MCP_DAEMON_TOOL_NAMES).toContain(tool);
      await handlers[tool]({ limit: 3 }); expect(invokeDaemonMemoryTool).toHaveBeenLastCalledWith(tool, { limit: 3 });
    }
  });
  it('reports unavailable distinctly from genuinely empty history', async () => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([]);
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [session] } });
    expect(await handlers[N.SESSION_TEXT_HISTORY]({})).toMatchObject({ status: 'ok', count: 0 });
    read.mockRejectedValueOnce(new Error('projection busy'));
    expect(await handlers[N.SESSION_TEXT_HISTORY]({})).toMatchObject({ status: 'error' });
  });
});


describe('recent current-session summaries', () => {
  it('reads the session stored namespace without reclassifying legacy user_private summaries as personal', async () => {
    const storedNamespace = caller.namespace;
    const run = vi.spyOn(getContextStoreClient(), 'run').mockImplementation(async (_method, args) => {
      const [namespace, kind] = args as unknown[];
      return JSON.stringify(namespace) === JSON.stringify(storedNamespace) && kind === 'recent_summary'
        ? [{ id: 'stored-summary', summary: 'existing decision', content: { sessionName: name }, updatedAt: 10 }]
        : [];
    });
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [{ ...session, contextNamespace: storedNamespace }] } });
    expect(await handlers[N.SESSION_TEXT_HISTORY]({ kind: 'summary', limit: 1 })).toMatchObject({ status: 'ok', count: 1, items: [{ id: 'stored-summary' }] });
    expect(run).toHaveBeenCalledWith('listProcessedProjections', [storedNamespace, 'recent_summary', { sessionName: name, excludeArchived: true, limit: 1 }]);
  });
  it('reuses namespace/session indexed summary queries, merges recent/master newest-first and excludes archived/other sessions', async () => {
    const row = (id: string, sessionName: string, updatedAt: number, status?: string) => ({ id, namespace: caller.namespace, summary: `summary-${id}`, content: { sessionName }, updatedAt, status });
    const run = vi.spyOn(getContextStoreClient(), 'run').mockResolvedValueOnce([row('older', name, 1), row('foreign', 'another-session', 999), row('archived', name, 100, 'archived')]).mockResolvedValueOnce([row('newer', name, 2)]);
    expect((await readSessionSummaries(name, caller.namespace, 2)).map((item) => item.id)).toEqual(['newer', 'older']);
    for (const kind of ['recent_summary', 'master_summary']) expect(run).toHaveBeenCalledWith('listProcessedProjections', [caller.namespace, kind, { sessionName: name, excludeArchived: true, limit: 2 }]);
  });
  it.each([false, true])('real MCP SDK exposes text and summary reads with strict current-session binding (fallback=%s)', async (fallback) => {
    vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([event(1, 'prior chat')]);
    vi.spyOn(getContextStoreClient(), 'run').mockResolvedValue([{ id: 'summary-1', summary: 'prior decision', content: { sessionName: name }, updatedAt: 10 }]);
    const server = createMemoryMcpServer(caller, { sendDeps: { listSessions: () => [session] } });
    const client = new Client({ name: 'history-sdk-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(N.SESSION_TEXT_HISTORY);
      const call = async (args: Record<string, unknown>) => mcpToolPayload(await client.callTool(fallback
        ? { name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.SESSION_TEXT_HISTORY, fallbackCall: { name: N.SESSION_TEXT_HISTORY, arguments: args } } }
        : { name: N.SESSION_TEXT_HISTORY, arguments: args }));
      expect(await call({ kind: 'text', limit: 1 })).toMatchObject({ status: 'ok', kind: 'text', messages: [{ text: 'prior chat' }] });
      expect(await call({ kind: 'summary', limit: 1 })).toMatchObject({ status: 'ok', kind: 'summary', items: [{ summary: 'prior decision' }] });
      // Invalid authority/limits may be rejected by the SDK or returned as a registered-tool error, never reach the reader.
      const result = await client.callTool({ name: N.SESSION_TEXT_HISTORY, arguments: { target: 'other', limit: 1 } });
      expect(result.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
