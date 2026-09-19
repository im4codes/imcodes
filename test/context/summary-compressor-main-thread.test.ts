import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompressionInput } from '../../src/context/summary-compressor.js';

/**
 * Regression: the memory compressor froze the daemon's main thread for
 * 0.5-1.3 s at a time, several times a minute (profiled live on an 87-session
 * node). `serializeEvents` ran the exact (synchronous WASM) tokenizer over
 * every event twice to enforce what was really a character limit, and
 * `compressWithSdkInner` did all of that serialization even when every
 * backend's circuit breaker was open and the result was discarded for the
 * local fallback.
 */

const countTokensSpy = vi.hoisted(() => vi.fn((text: string) => Math.ceil(text.length / 4)));
vi.mock('../../src/context/tokenizer.js', () => ({
  countTokens: countTokensSpy,
  countMessagesTokens: vi.fn(() => 0),
}));

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

function event(content: string, index: number): CompressionInput['events'][number] {
  return {
    id: `event-${index}`,
    eventType: index % 2 === 0 ? 'user.turn' : 'assistant.turn',
    content,
    createdAt: 1_000 + index,
  } as unknown as CompressionInput['events'][number];
}

describe('summary compressor keeps the main thread free', () => {
  beforeEach(async () => {
    countTokensSpy.mockClear();
    queryMock.mockReset();
    const { resetActiveCompressionRunsForTests, resumeAcceptingCompression } = await import('../../src/context/summary-compressor.js');
    resetActiveCompressionRunsForTests();
    resumeAcceptingCompression();
  });

  it('serializes a long history without running the tokenizer', async () => {
    const { serializeEvents } = await import('../../src/context/summary-compressor.js');
    const prose = 'the build finished and the tests passed '.repeat(48);
    const events = Array.from({ length: 300 }, (_, i) => event(`${prose}#${i}`, i));

    const text = serializeEvents(events, { maxEventChars: 2000 });

    expect(countTokensSpy).not.toHaveBeenCalled();
    expect(text).toContain(`${prose}#299`);
  });

  it('bounds an event by characters, keeping its head and tail', async () => {
    const { __testing__ } = await import('../../src/context/summary-compressor.js');
    const cut = __testing__.truncateEventText(`HEAD-${'x'.repeat(5_000)}-TAIL`, 2000);
    expect(cut.startsWith('HEAD-')).toBe(true);
    expect(cut.endsWith('-TAIL')).toBe(true);
    expect(cut).toContain('\n...[truncated]...\n');
    expect([...cut].length).toBeLessThan(2000 + 32);
    expect(__testing__.truncateEventText('short', 2000)).toBe('short');
    // Never splits a surrogate pair.
    expect(__testing__.truncateEventText('😀'.repeat(3_000), 100)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(countTokensSpy).not.toHaveBeenCalled();
  });

  it('does no serialization at all while every backend is open, and answers locally', async () => {
    const { compressWithSdk, __testing__ } = await import('../../src/context/summary-compressor.js');
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) __testing__.recordFailure('claude-code-sdk', now);
    expect(__testing__.canCall('claude-code-sdk', now)).toBe(false);
    countTokensSpy.mockClear();

    const result = await compressWithSdk({
      events: Array.from({ length: 200 }, (_, i) => event(`turn ${i} ${'y'.repeat(3000)}`, i)),
      modelConfig: {
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'test-model',
      } as unknown as CompressionInput['modelConfig'],
    });

    expect(result).toMatchObject({ backend: 'none', model: 'local-fallback', fromSdk: false });
    expect(queryMock).not.toHaveBeenCalled();
    expect(countTokensSpy).not.toHaveBeenCalled();
  });
});
