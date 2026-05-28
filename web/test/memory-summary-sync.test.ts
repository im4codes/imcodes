import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MEMORY_WS } from '@shared/memory-ws.js';

const getPersonalCloudMemory = vi.hoisted(() => vi.fn());

vi.mock('../src/api.js', () => ({
  getPersonalCloudMemory,
}));

import { buildMemorySummarySyncMessage, localPersonalMemorySummarySource } from '../src/memory-summary-sync.js';

const t = (key: string, options?: Record<string, unknown>) => ({
  'chat.memory_summary_sync_instruction': 'SYNC ONLY',
  'chat.memory_summary_sync_heading': `Recent summaries (${options?.count}/${options?.limit}, max ${options?.maxChars} chars):`,
}[key] ?? key);

describe('memory summary sync message', () => {
  beforeEach(() => {
    getPersonalCloudMemory.mockReset();
  });

  it('uses project recent summaries and formats a sync-only prompt', async () => {
    getPersonalCloudMemory.mockResolvedValueOnce({
      records: [
        { id: '1111111111-2222-3333-4444-555555555555', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Older summary', updatedAt: 100 },
        { id: 'aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Newest summary', updatedAt: 300 },
        { id: 'other-project', projectId: 'repo-2', projectionClass: 'recent_summary', summary: 'Wrong project summary', updatedAt: 500 },
        { id: 'durable', projectId: 'repo-1', projectionClass: 'durable_memory_candidate', summary: 'Durable fact', updatedAt: 400 },
      ],
    });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1', 5);

    expect(getPersonalCloudMemory).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 5,
    });
    expect(message).toContain('SYNC ONLY');
    expect(message).toContain('Recent summaries (2/5, max 3600 chars):');
    expect(message).toContain('1. [ref: proj:aaaaaaaaaa] [repo-1] Newest summary');
    expect(message).toContain('2. [ref: proj:1111111111] [repo-1] Older summary');
    expect(message).toContain('"tool":"get_memory_sources"');
    expect(message).toContain('"kind":"projection"');
    expect(message).toContain('"projectionId":"aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
    expect(message).not.toContain('Durable fact');
    expect(message).not.toContain('Wrong project summary');
  });

  it('does not fall back to global recent summaries when the project has no records', async () => {
    getPersonalCloudMemory.mockResolvedValueOnce({ records: [] });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1', 3);

    expect(getPersonalCloudMemory).toHaveBeenCalledTimes(1);
    expect(getPersonalCloudMemory).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 3,
    });
    expect(message).toBeNull();
  });

  it('merges cloud and local summaries while keeping cloud records first for duplicates', async () => {
    const localSource = vi.fn().mockResolvedValue({
      records: [
        { id: 'duplicate-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Local duplicate summary', updatedAt: 700 },
        { id: 'local-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Local only summary', updatedAt: 600 },
      ],
    });
    getPersonalCloudMemory.mockResolvedValueOnce({
      records: [
        { id: 'duplicate-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Cloud duplicate summary', updatedAt: 500 },
        { id: 'cloud-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Cloud only summary', updatedAt: 400 },
      ],
    });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1', 3, {
      sources: [localSource],
    });

    expect(localSource).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 3,
    });
    expect(getPersonalCloudMemory).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 3,
    });
    expect(message).toContain('Local only summary');
    expect(message).toContain('Cloud duplicate summary');
    expect(message).toContain('Cloud only summary');
    expect(message).not.toContain('Local duplicate summary');
  });

  it('uses local summaries when cloud memory has no project summaries', async () => {
    const localSource = vi.fn().mockResolvedValue({
      records: [
        { id: 'local-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Local summary', updatedAt: 600 },
      ],
    });
    getPersonalCloudMemory.mockResolvedValueOnce({ records: [] });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1', 3, {
      sources: [localSource],
    });

    expect(localSource).toHaveBeenCalledTimes(1);
    expect(getPersonalCloudMemory).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 3,
    });
    expect(message).toContain('Local summary');
  });

  it('continues to local summaries when cloud memory cannot be queried', async () => {
    const localSource = vi.fn().mockResolvedValue({
      records: [
        { id: 'local-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Local summary', updatedAt: 600 },
      ],
    });
    getPersonalCloudMemory.mockRejectedValueOnce(new Error('cloud unavailable'));

    const message = await buildMemorySummarySyncMessage(t, 'repo-1', 3, {
      sources: [localSource],
    });

    expect(getPersonalCloudMemory).toHaveBeenCalledTimes(1);
    expect(localSource).toHaveBeenCalledTimes(1);
    expect(message).toContain('Local summary');
  });

  it('queries daemon local personal memory over ws', async () => {
    const handlers = new Set<(message: any) => void>();
    const ws = {
      send: vi.fn((message: any) => {
        queueMicrotask(() => {
          for (const handler of handlers) {
            handler({
              type: MEMORY_WS.PERSONAL_RESPONSE,
              requestId: message.requestId,
              stats: {},
              records: [
                { id: 'local-ws-summary', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Local ws summary', updatedAt: 700 },
              ],
            });
          }
        });
      }),
      onMessage: vi.fn((handler: (message: any) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
    };

    const view = await localPersonalMemorySummarySource(ws as any, 1000)({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 4,
    });

    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.PERSONAL_QUERY,
      canonicalRepoId: 'repo-1',
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 4,
    }));
    expect(view?.records[0].summary).toBe('Local ws summary');
    expect(handlers.size).toBe(0);
  });

  it('does not fetch summaries without a canonical project id', async () => {
    await expect(buildMemorySummarySyncMessage(t, null, 3)).resolves.toBeNull();
    await expect(buildMemorySummarySyncMessage(t, '   ', 3)).resolves.toBeNull();
    expect(getPersonalCloudMemory).not.toHaveBeenCalled();
  });

  it('defaults to syncing 10 recent summaries', async () => {
    getPersonalCloudMemory.mockResolvedValueOnce({
      records: Array.from({ length: 12 }, (_, index) => ({
        id: `summary-${index + 1}`,
        projectId: 'repo-1',
        projectionClass: 'recent_summary',
        summary: `Summary ${index + 1}`,
        updatedAt: index + 1,
      })),
    });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1');

    expect(getPersonalCloudMemory).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 10,
    });
    expect(message).toContain('Recent summaries (10/10, max 3600 chars):');
    expect(message).toContain('1. [ref: proj:a12] [repo-1] Summary 12');
    expect(message).toContain('10. [ref: proj:a3] [repo-1] Summary 3');
    expect(message).not.toContain('Summary 2');
  });

  it('keeps the default sync bounded and truncates oversized summaries', async () => {
    const hugeSummary = `${'A'.repeat(2_000)}\nSHOULD_NOT_APPEAR`;
    getPersonalCloudMemory.mockResolvedValueOnce({
      records: [
        { id: 'oldest', projectId: 'repo-1', projectionClass: 'recent_summary', summary: 'Oldest summary', updatedAt: 100 },
        { id: 'newest', projectId: 'repo-1', projectionClass: 'recent_summary', summary: hugeSummary, updatedAt: 400 },
        { id: 'middle-2', projectId: 'repo-1', projectionClass: 'recent_summary', summary: hugeSummary, updatedAt: 300 },
        { id: 'middle-1', projectId: 'repo-1', projectionClass: 'recent_summary', summary: hugeSummary, updatedAt: 200 },
      ],
    });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1');

    expect(getPersonalCloudMemory).toHaveBeenCalledWith({
      projectId: 'repo-1',
      projectionClass: 'recent_summary',
      limit: 10,
    });
    expect(message).toContain('Recent summaries (3/10, max 3600 chars):');
    expect(message).toContain('[truncated for token budget; use get_memory_sources with the sourceLookup below for exact details]');
    expect(message).not.toContain('Oldest summary');
    expect(message).not.toContain('SHOULD_NOT_APPEAR');
    expect(message!.length).toBeLessThan(5_000);
  });
});
