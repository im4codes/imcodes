import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  McpToolCatalog,
  type McpToolCatalogClient,
  type McpToolCatalogSnapshot,
} from '../../src/agent/mcp-tool-catalog.js';

function tool(name: string, marker = name): Tool {
  return {
    name,
    description: marker,
    inputSchema: {
      type: 'object',
      properties: { [marker]: { type: 'string' } },
      additionalProperties: false,
    },
  };
}

function fakeClient(options: {
  listChanged?: boolean;
  list: (cursor?: string) => Promise<{ tools: Tool[]; nextCursor?: string }>;
}) {
  let changed: (() => void | Promise<void>) | undefined;
  const listTools = vi.fn((params?: { cursor?: string }) => options.list(params?.cursor));
  const client: McpToolCatalogClient = {
    listTools,
    getServerCapabilities: () => ({ tools: { listChanged: options.listChanged } }),
    setNotificationHandler: (_schema, handler) => { changed = handler; },
  };
  return { client, listTools, notify: () => changed?.() };
}

describe('MCP tool catalog hydration', () => {
  it('cold-hydrates every page and manually replaces add/remove/rename atomically when listChanged is absent', async () => {
    let version = 1;
    const seen: McpToolCatalogSnapshot[] = [];
    const remote = fakeClient({
      list: async (cursor) => {
        if (version === 1) {
          return cursor === undefined
            ? { tools: [tool('alpha')], nextCursor: 'page-2' }
            : { tools: [tool('beta')] };
        }
        return { tools: [tool('gamma')] };
      },
    });
    const catalog = new McpToolCatalog({ publish: (snapshot) => seen.push(snapshot) });

    await catalog.connect(remote.client);
    expect(remote.listTools).toHaveBeenNthCalledWith(1, undefined);
    expect(remote.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
    expect(catalog.ready).toBe(true);
    expect(seen.filter((snapshot) => snapshot.ready).map((snapshot) => snapshot.tools.map(({ name }) => name)))
      .toEqual([['alpha', 'beta']]);

    version = 2;
    await catalog.refresh('manual');
    const replacement = seen.at(-1)!;
    expect(replacement).toMatchObject({
      ready: true,
      added: ['gamma'],
      removed: ['alpha', 'beta'],
      schemaChanged: [],
    });
    expect(replacement.tools.map(({ name }) => name)).toEqual(['gamma']);
    expect(catalog.getTool('alpha')).toBeUndefined();
    expect(catalog.getTool('gamma')).toBeDefined();
  });

  it('treats 2025 list_changed as invalidation, coalesces bursts, and resets changed-schema permission state', async () => {
    let tools = [tool('alpha', 'v1'), tool('removed')];
    const seen: McpToolCatalogSnapshot[] = [];
    const remote = fakeClient({ listChanged: true, list: async () => ({ tools }) });
    const catalog = new McpToolCatalog({ publish: (snapshot) => seen.push(snapshot) });
    await catalog.connect(remote.client);

    tools = [tool('alpha', 'v2'), tool('renamed')];
    await Promise.all([remote.notify(), remote.notify(), remote.notify()]);

    expect(seen).toContainEqual(expect.objectContaining({ ready: false, reason: 'tools/list_changed' }));
    const replacement = [...seen].reverse().find((snapshot) => snapshot.ready)!;
    expect(replacement.tools.map(({ name }) => name)).toEqual(['alpha', 'renamed']);
    expect(replacement.schemaChanged).toEqual(['alpha']);
    expect(replacement.added).toEqual(['renamed']);
    expect(replacement.removed).toEqual(['removed']);
    // Initial hydration + one burst refresh + at most one coalesced follow-up.
    expect(remote.listTools.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('never publishes an in-flight generation invalidated before pagination completes', async () => {
    let call = 0;
    let resolveStale: ((value: { tools: Tool[] }) => void) | undefined;
    const stalePage = new Promise<{ tools: Tool[] }>((resolve) => { resolveStale = resolve; });
    const seen: McpToolCatalogSnapshot[] = [];
    const remote = fakeClient({
      listChanged: true,
      list: async () => {
        call += 1;
        if (call === 1) return { tools: [tool('initial')] };
        if (call === 2) return stalePage;
        return { tools: [tool('fresh')] };
      },
    });
    const catalog = new McpToolCatalog({ publish: (snapshot) => seen.push(snapshot) });
    await catalog.connect(remote.client);

    const manual = catalog.refresh('manual-in-flight');
    await vi.waitFor(() => expect(remote.listTools).toHaveBeenCalledTimes(2));
    const invalidation = remote.notify();
    resolveStale?.({ tools: [tool('must-not-publish')] });
    await Promise.all([manual, invalidation]);

    const readyNames = seen
      .filter((snapshot) => snapshot.ready)
      .map((snapshot) => snapshot.tools.map(({ name }) => name));
    expect(readyNames).toEqual([['initial'], ['fresh']]);
    expect(catalog.getTool('must-not-publish')).toBeUndefined();
    expect(catalog.getTool('fresh')).toBeDefined();
  });

  it('fails closed on incomplete pagination, repeated cursors, duplicates, and oversize catalogs without partial publication', async () => {
    let invalid: 'cursor' | 'duplicate' | 'oversize' | null = null;
    const readySnapshots: McpToolCatalogSnapshot[] = [];
    const remote = fakeClient({
      list: async (cursor) => {
        if (invalid === 'cursor') return { tools: [tool(cursor ? 'partial-2' : 'partial-1')], nextCursor: 'loop' };
        if (invalid === 'duplicate') {
          return cursor ? { tools: [tool('duplicate')] } : { tools: [tool('duplicate')], nextCursor: 'page-2' };
        }
        if (invalid === 'oversize') {
          return { tools: Array.from({ length: 1_025 }, (_, index) => tool(`tool-${index}`)) };
        }
        return { tools: [tool('stable')] };
      },
    });
    const catalog = new McpToolCatalog({
      publish: (snapshot) => { if (snapshot.ready) readySnapshots.push(snapshot); },
    });
    await catalog.connect(remote.client);

    for (const mode of ['cursor', 'duplicate', 'oversize'] as const) {
      invalid = mode;
      await expect(catalog.refresh(mode)).rejects.toThrow();
      expect(catalog.ready).toBe(false);
      expect(catalog.getTool('stable')).toBeUndefined();
    }
    expect(readySnapshots).toHaveLength(1);
    expect(readySnapshots[0].tools.map(({ name }) => name)).toEqual(['stable']);
  });

  it('publishes before 2026 subscription/listen, rehydrates reconnects, and refetches a resumed transport missing generation proof', async () => {
    const order: string[] = [];
    let onSubscriptionInvalidated: (() => void) | undefined;
    const subscriptionCallbacks: Array<() => void> = [];
    const first = fakeClient({ list: async () => ({ tools: [tool('first')] }) });
    const second = fakeClient({ list: async () => ({ tools: [tool('second')] }) });
    const catalog = new McpToolCatalog({
      publish: (snapshot) => { if (snapshot.ready) order.push(`publish:${snapshot.tools[0]?.name}`); },
      subscription: {
        listen: (onInvalidated) => {
          order.push('listen');
          onSubscriptionInvalidated = onInvalidated;
          subscriptionCallbacks.push(onInvalidated);
          return () => { order.push('stop'); };
        },
      },
    });

    await catalog.connect(first.client);
    expect(order.slice(0, 2)).toEqual(['publish:first', 'listen']);
    const firstGeneration = catalog.generation;
    await catalog.resume(catalog.generationProof);
    expect(first.listTools).toHaveBeenCalledTimes(1);
    await catalog.resume({ connectionGeneration: 1, catalogGeneration: 0 });
    expect(first.listTools).toHaveBeenCalledTimes(2);
    await catalog.resume();
    expect(first.listTools).toHaveBeenCalledTimes(3);
    expect(catalog.generation).toBeGreaterThan(firstGeneration!);

    onSubscriptionInvalidated?.();
    await vi.waitFor(() => expect(first.listTools.mock.calls.length).toBeGreaterThanOrEqual(4));
    await catalog.connect(second.client);
    expect(order).toContain('stop');
    expect(order.slice(-2)).toEqual(['publish:second', 'listen']);
    expect(catalog.getTool('first')).toBeUndefined();
    expect(catalog.getTool('second')).toBeDefined();

    subscriptionCallbacks[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.listTools).toHaveBeenCalledTimes(1);
    subscriptionCallbacks[1]?.();
    await vi.waitFor(() => expect(second.listTools).toHaveBeenCalledTimes(2));
  });
});
