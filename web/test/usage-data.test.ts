import { describe, expect, it } from 'vitest';
import { extractLatestUsage, mergeUsageUpdate } from '../src/usage-data.js';
import type { TimelineEvent } from '../src/ws-client.js';
import { mergeTimelineEvents } from '../../src/shared/timeline/merge.js';

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

  it('skips impossible historical cumulative ctx usage snapshots', () => {
    const usage = extractLatestUsage([
      makeEvent({ inputTokens: 120_000, cacheTokens: 30_000, contextWindow: 1_000_000, model: 'gpt-5.5' }),
      makeEvent({ inputTokens: 23_593_691, cacheTokens: 721_072_000, contextWindow: 258_400, contextWindowSource: 'provider' }),
      makeEvent({ model: 'gpt-5.5' }),
    ]);

    expect(usage).toMatchObject({
      inputTokens: 120_000,
      cacheTokens: 30_000,
      contextWindow: 1_000_000,
      model: 'gpt-5.5',
    });
  });

  it('skips over-window snapshots that look like cumulative provider totals', () => {
    const usage = extractLatestUsage([
      makeEvent({ inputTokens: 120_000, cacheTokens: 30_000, contextWindow: 1_000_000, model: 'Auto' }),
      makeEvent({ inputTokens: 186_606, cacheTokens: 1_080_320, contextWindow: 1_000_000, model: 'Auto' }),
    ]);

    expect(usage).toMatchObject({
      inputTokens: 120_000,
      cacheTokens: 30_000,
      contextWindow: 1_000_000,
      model: 'Auto',
    });
  });

  it('uses the effective model window before rejecting over-window snapshots', () => {
    const usage = extractLatestUsage([
      makeEvent({ inputTokens: 300_000, cacheTokens: 0, contextWindow: 258_400, model: 'gpt-5.5' }),
    ]);

    expect(usage).toMatchObject({
      inputTokens: 300_000,
      cacheTokens: 0,
      contextWindow: 258_400,
      model: 'gpt-5.5',
    });
  });

  it('accepts MiniMax cached-input occupancy when the preset supplies a 1M window', () => {
    const usage = extractLatestUsage([
      makeEvent({
        inputTokens: 12_000,
        cacheTokens: 700_000,
        contextWindow: 1_000_000,
        model: 'MiniMax-M3',
      }),
    ]);

    expect(usage).toMatchObject({
      inputTokens: 12_000,
      cacheTokens: 700_000,
      contextWindow: 1_000_000,
      model: 'MiniMax-M3',
    });
  });

  it('applies a newer preset window to an older token snapshot', () => {
    const usage = extractLatestUsage([
      makeEvent({
        inputTokens: 12_000,
        cacheTokens: 700_000,
        contextWindow: 200_000,
        model: 'MiniMax-M3',
      }),
      makeEvent({
        contextWindow: 1_000_000,
        contextWindowSource: 'preset',
        model: 'MiniMax-M3',
      }),
    ]);

    expect(usage).toMatchObject({
      inputTokens: 12_000,
      cacheTokens: 700_000,
      contextWindow: 1_000_000,
      contextWindowSource: 'preset',
      model: 'MiniMax-M3',
    });
  });

  it('merges a live metadata-only preset update without losing current tokens', () => {
    const usage = mergeUsageUpdate(
      {
        inputTokens: 12_000,
        cacheTokens: 700_000,
        contextWindow: 200_000,
        model: 'MiniMax-M3',
      },
      {
        contextWindow: 1_000_000,
        contextWindowSource: 'preset',
        model: 'MiniMax-M3',
      },
    );

    expect(usage).toMatchObject({
      inputTokens: 12_000,
      cacheTokens: 700_000,
      contextWindow: 1_000_000,
      contextWindowSource: 'preset',
      model: 'MiniMax-M3',
    });
  });

  it('renders tokens after same-event OpenCode terminal metadata replaces the live frame', () => {
    const eventId = 'transport:deck_sub_0m081z0m:msg-opencode:usage';
    const tokenEvent = {
      ...makeEvent({
        inputTokens: 22,
        cacheTokens: 36_608,
        outputTokens: 10,
        model: 'opencode/deepseek-v4-flash-free',
        contextWindow: 200_000,
        contextWindowSource: 'provider',
        streaming: false,
      }),
      eventId,
      seq: 8,
    };
    const metadataEvent = {
      ...makeEvent({
        model: 'opencode/deepseek-v4-flash-free',
        contextWindow: 1_000_000,
      }),
      eventId,
      seq: 14,
    };

    const usage = extractLatestUsage(mergeTimelineEvents([tokenEvent], [metadataEvent]));

    expect(usage).toMatchObject({
      inputTokens: 22,
      cacheTokens: 36_608,
      contextWindow: 1_000_000,
      model: 'opencode/deepseek-v4-flash-free',
    });
  });
});
