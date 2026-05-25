import { describe, expect, it, vi, beforeEach } from 'vitest';

const getPersonalCloudMemory = vi.hoisted(() => vi.fn());

vi.mock('../src/api.js', () => ({
  getPersonalCloudMemory,
}));

import { buildMemorySummarySyncMessage } from '../src/memory-summary-sync.js';

const t = (key: string) => ({
  'chat.memory_summary_sync_instruction': 'SYNC ONLY',
  'chat.memory_summary_sync_heading': 'Recent summaries:',
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
    expect(message).toContain('1. [ref: proj:aaaaaaaaaa] [repo-1] Newest summary');
    expect(message).toContain('2. [ref: proj:1111111111] [repo-1] Older summary');
    expect(message).toContain('"tool":"get_memory_sources"');
    expect(message).toContain('"kind":"projection"');
    expect(message).toContain('"projectionId":"aaaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
    expect(message).not.toContain('Durable fact');
  });

  it('falls back to global recent summaries when the project has no records', async () => {
    getPersonalCloudMemory
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({
        records: [
          { id: 'zzzzzzzzzz-yyyy', projectId: 'repo-2', projectionClass: 'recent_summary', summary: 'Global summary', updatedAt: 200 },
        ],
      });

    const message = await buildMemorySummarySyncMessage(t, 'repo-1', 3);

    expect(getPersonalCloudMemory).toHaveBeenNthCalledWith(2, {
      projectionClass: 'recent_summary',
      limit: 3,
    });
    expect(message).toContain('Global summary');
    expect(message).toContain('[ref: proj:zzzzzzzzzz]');
  });
});
