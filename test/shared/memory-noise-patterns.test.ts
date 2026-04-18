import { describe, expect, it } from 'vitest';
import { isMemoryNoiseSummary, isMemoryNoiseTurn } from '../../shared/memory-noise-patterns.js';

describe('memory-noise-patterns', () => {
  it('detects raw API connection failure turns', () => {
    expect(isMemoryNoiseTurn('[API Error: Connection error. (cause: fetch failed)]')).toBe(true);
    expect(isMemoryNoiseTurn('Fixed bug where users saw [API Error: Connection error. (cause: fetch failed)]')).toBe(false);
  });

  it('detects summaries whose assistant output is only API failure noise', () => {
    expect(isMemoryNoiseSummary('**Assistant:** [API Error: Connection error. (cause: fetch failed)]')).toBe(true);
    expect(isMemoryNoiseSummary('## Conversation\n\n**User:** Continue\n\n**Assistant:** [API Error: Connection error. (cause: fetch failed)]')).toBe(true);
    expect(isMemoryNoiseSummary('## Resolution\nFixed websocket reconnect handling so fetch failed no longer appears.')).toBe(false);
  });
});
