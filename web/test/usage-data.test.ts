import { describe, expect, it } from 'vitest';
import { extractLatestUsage } from '../src/usage-data.js';
import type { TimelineEvent } from '../src/ws-client.js';

function makeEvent(payload: Record<string, unknown>): TimelineEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId: 'deck_proj_brain',
    ts: Date.now(),
    seq: 1,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'usage.update',
    payload,
  };
}

describe('extractLatestUsage', () => {
  it('merges token usage and codex status from separate events', () => {
    const usage = extractLatestUsage([
      makeEvent({ inputTokens: 120, cacheTokens: 30, contextWindow: 200_000, contextWindowSource: 'provider', model: 'gpt-5.2-codex' }),
      makeEvent({ codexStatus: { capturedAt: 1, fiveHourLeftPercent: 43, weeklyLeftPercent: 34 } }),
    ]);

    expect(usage).toMatchObject({
      inputTokens: 120,
      cacheTokens: 30,
      contextWindow: 200_000,
      contextWindowSource: 'provider',
      model: 'gpt-5.2-codex',
      codexStatus: {
        fiveHourLeftPercent: 43,
        weeklyLeftPercent: 34,
      },
    });
  });
});
