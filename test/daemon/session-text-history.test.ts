import { getContextStoreClient } from '../../src/store/context-store-worker-client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMemoryMcpServer } from '../../src/daemon/memory-mcp-server.js';
import { MCP_TOOL_DISCOVERY_NAME } from '../../shared/mcp-tool-discovery.js';
import { mcpToolPayload } from '../helpers/mcp-tool-result.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSessionTextMessages, readSessionSummaries, readSessionToolEvents, resolveHistorySession, canReadSessionHistory } from '../../src/daemon/session-history.js';
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


describe('explicit local session history within one main-session tree', () => {
  const child = { ...session, name: 'deck_sub_history_a', parentSession: name, sessionInstanceId: 'instance-a', providerResumeId: 'native-a', contextNamespace: { scope: 'personal' as const, userId: 'target-user' } };
  const sibling = { ...session, name: 'deck_sub_history_b', parentSession: name };
  const nested = { ...session, name: 'deck_sub_history_nested', parentSession: child.name };
  // Same project is NOT enough to grant access to another main session.
  const foreign = { ...session, name: 'deck_other_brain' };
  const directory = [session, child, sibling, nested, foreign];
  const deps = { sendDeps: { listSessions: () => directory } };
  it.each([child.name, 'instance-a', 'native-a'])('reads an exact target %s without redacting stored text', async (sessionId) => {
    const read = vi.spyOn(timelineStore, 'readCompletedTextTail').mockResolvedValue([event(1, 'password=example-only')]);
    const result = await createMemoryMcpToolHandlers(caller, deps)[N.SESSION_TEXT_HISTORY]({ sessionId, limit: 100 });
    expect(result).toMatchObject({ status: 'ok', count: 1, messages: [{ text: 'password=example-only' }] });
    expect(read).toHaveBeenCalledWith(child.name, 100, { visibleOnly: true });
  });
  it('permits main, sibling and nested descendants in both directions', () => {
    for (const from of directory.slice(0, 4)) for (const to of directory.slice(0, 4)) {
      expect(canReadSessionHistory(from.name, to.name, directory)).toBe(true);
    }
    for (const from of directory.slice(0, 4)) {
      expect(canReadSessionHistory(from.name, foreign.name, directory)).toBe(false);
      expect(canReadSessionHistory(foreign.name, from.name, directory)).toBe(false);
    }
  });
  it('rejects cross-main reads for every kind before touching stores', async () => {
    const text = vi.spyOn(timelineStore, 'readCompletedTextTail');
    const tools = vi.spyOn(timelineStore, 'readByTypesPreferred');
    const summary = vi.spyOn(getContextStoreClient(), 'run');
    for (const kind of ['text', 'summary', 'tool']) {
      expect(await createMemoryMcpToolHandlers({ ...caller, sessionName: child.name }, deps)[N.SESSION_TEXT_HISTORY]({ kind, sessionId: foreign.name })).toMatchObject({ status: 'error', reason: 'scope_forbidden' });
    }
    expect(text).not.toHaveBeenCalled(); expect(tools).not.toHaveBeenCalled(); expect(summary).not.toHaveBeenCalled();
  });
  it('uses the target namespace for raw summaries and lets siblings read each other', async () => {
    const run = vi.spyOn(getContextStoreClient(), 'run').mockResolvedValue([{ id: 'raw', summary: 'password=example-only', content: { sessionName: child.name }, updatedAt: 10 }]);
    const result = await createMemoryMcpToolHandlers({ ...caller, sessionName: sibling.name }, deps)[N.SESSION_TEXT_HISTORY]({ kind: 'summary', sessionId: child.name, limit: 1 });
    expect(result).toMatchObject({ status: 'ok', items: [{ summary: 'password=example-only' }] });
    expect(run).toHaveBeenCalledWith('listProcessedProjections', [child.contextNamespace, 'recent_summary', { sessionName: child.name, excludeArchived: true, limit: 1 }]);
  });
  it('rejects missing, blank, wrong-type and ambiguous IDs without guessing', async () => {
    const handlers = createMemoryMcpToolHandlers(caller, { sendDeps: { listSessions: () => [...directory, { ...sibling, providerResumeId: 'native-a' }] } });
    for (const sessionId of ['', '  ', 123, 'missing', 'native-a', '../timeline']) {
      expect(await handlers[N.SESSION_TEXT_HISTORY]({ sessionId })).toMatchObject({ status: 'error', reason: 'validation_failed' });
    }
    expect(await createMemoryMcpToolHandlers({ ...caller, sessionName: null }, deps)[N.SESSION_TEXT_HISTORY]({ sessionId: child.name })).toMatchObject({ status: 'error', reason: 'identity_rejected' });
  });
  it('canonical names win over conflicting backend IDs, never display labels', () => {
    const sameId = { ...sibling, providerSessionId: child.name, label: 'visible-name' };
    expect(resolveHistorySession([child, sameId], child.name)).toEqual([child]);
    expect(resolveHistorySession([child, sameId], 'visible-name')).toEqual([]);
  });
  it('fails closed for broken/cyclic parent chains, while preserving self reads', () => {
    const broken = { ...child, parentSession: 'missing' };
    expect(canReadSessionHistory(broken.name, sibling.name, [session, broken, sibling])).toBe(false);
    const cycle = [{ ...child, parentSession: sibling.name }, { ...sibling, parentSession: child.name }];
    expect(canReadSessionHistory(child.name, sibling.name, cycle)).toBe(false);
    expect(canReadSessionHistory(child.name, child.name, cycle)).toBe(true);
  });
  it.each([false, true])('exposes target + tool mode through real MCP schemas (fallback=%s)', async (fallback) => {
    const read = vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([event(1, 'tool raw', 'tool.call', { toolCallId: 'call-1', input: { password: 'example-only' } }), event(2, 'result', 'tool.result', { toolCallId: 'call-1' })]);
    const server = createMemoryMcpServer({ ...caller, sessionName: sibling.name }, deps);
    const client = new Client({ name: 'tree-history-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const args = { kind: 'tool', sessionId: child.name, limit: 100 };
      const result = mcpToolPayload(await client.callTool(fallback
        ? { name: MCP_TOOL_DISCOVERY_NAME, arguments: { query: N.SESSION_TEXT_HISTORY, fallbackCall: { name: N.SESSION_TEXT_HISTORY, arguments: args } } }
        : { name: N.SESSION_TEXT_HISTORY, arguments: args }));
      expect(result).toMatchObject({ status: 'ok', kind: 'tool', count: 2, events: [{ type: 'tool.call', toolCallId: 'call-1' }, { type: 'tool.result', toolCallId: 'call-1' }] });
      expect(JSON.stringify(result)).toContain('example-only');
      expect(read).toHaveBeenCalledWith(child.name, ['tool.call', 'tool.result'], { limit: 100 });
    } finally { await client.close(); await server.close(); }
  });
  it('bounds raw tool payloads, preserves correlation and excludes hidden/non-tool events', async () => {
    vi.spyOn(timelineStore, 'readByTypesPreferred').mockResolvedValue([event(1, 'x'.repeat(140000), 'tool.call', { toolCallId: 'large-call' }), event(2, 'ok', 'tool.result', { toolCallId: 'large-call' }), event(3, 'hidden', 'tool.call', { hidden: true }), event(4, 'text')]);
    const result = await readSessionToolEvents(child.name, 100);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ toolCallId: 'large-call', truncated: true });
    expect(result.reduce((sum, item) => sum + item.payload.length, 0)).toBeLessThanOrEqual(SESSION_TEXT_HISTORY_MAX_CHARS);
    for (const limit of [0, -1, 201, 1.5]) await expect(readSessionToolEvents(child.name, limit)).rejects.toThrow();
  });
});
