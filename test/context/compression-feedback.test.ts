import { describe, expect, it } from 'vitest';
import { summarizeManualCompaction } from '../../src/context/compression-feedback.js';

describe('manual compaction feedback payload', () => {
  it('returns the locked phase-1 shape with optional dedup fields undefined', () => {
    expect(summarizeManualCompaction({ eventCount: 2, inputTokens: 1234, summaryTokens: 345, sourceEventIds: ['a', 'b'], elapsed: 12.4 })).toEqual({
      headline: 'Compressed 2 events into one summary',
      tokenLine: '~1,234 → ~345 tokens in 12ms',
      provenanceLine: '2 source events retrievable via chat_get_event',
      sourceEventIds: ['a', 'b'],
      class: undefined,
      dedupedIntoProjectionId: undefined,
      cosineToDedup: undefined,
    });
  });
});
