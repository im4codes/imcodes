import { describe, expect, it, vi, beforeEach } from 'vitest';

const getPersonalCloudMemory = vi.hoisted(() => vi.fn());

vi.mock('../src/api.js', () => ({
  getPersonalCloudMemory,
}));

import { buildMemorySummarySyncMessage } from '../src/memory-summary-sync.js';

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

  it('defaults to a small bounded sync and truncates oversized summaries', async () => {
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
      limit: 3,
    });
    expect(message).toContain('Recent summaries (3/3, max 3600 chars):');
    expect(message).toContain('[truncated for token budget; use get_memory_sources with the sourceLookup below for exact details]');
    expect(message).not.toContain('Oldest summary');
    expect(message).not.toContain('SHOULD_NOT_APPEAR');
    expect(message!.length).toBeLessThan(5_000);
  });
});
