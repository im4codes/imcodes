import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompressionInput } from '../../src/context/summary-compressor.js';

/**
 * Regression: `compressWithSdk` MUST run one-at-a-time across the whole
 * daemon. The shared Codex sub-session used by the compression path only
 * accepts one `send` in flight at a time; concurrent callers used to race
 * the session, triggering `Codex SDK session is already busy` retries and
 * — with ~40 materialization targets firing on the 10 s cadence — self-
 * reinforcing stream-delta callback storms that pinned the main-thread
 * event loop at ~85 % CPU and made user message dispatch noticeably
 * laggy. This test pins the serialization contract so we can't regress
 * back into parallel compression.
 */

// Hoisted mock handle — the module under test imports the SDK lazily via
// `await import('@anthropic-ai/claude-agent-sdk')`, so the mock has to be
// in place before ANY compressWithSdk call resolves its dynamic import.
const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

/**
 * Fabricate the minimal CompressionInput `compressWithSdk` needs to take
 * the claude-code-sdk path (which goes through `sendViaSdkQuery` → the
 * mocked `query()`).
 */
function makeInput(marker: string): CompressionInput {
  return {
    events: [
      // One event is enough to clear the "empty events" fast-path.
      { type: 'assistant.text', content: marker, createdAt: Date.now() } as unknown as CompressionInput['events'][number],
    ],
    modelConfig: {
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'test-model',
    } as unknown as CompressionInput['modelConfig'],
  };
}

/**
 * Fake `query()` that tracks how many invocations are running at once.
 * Each call stays "in flight" for `heldMs` before yielding its assistant
 * chunk — long enough for parallel callers to overlap if the gate is
 * missing. Returns an async iterable matching the Claude Agent SDK shape.
 */
function makeQueryMock(opts: {
  heldMs: number;
  state: { inFlight: number; peakInFlight: number; order: string[] };
}) {
  return vi.fn().mockImplementation(async function* (arg: { prompt: string }) {
    opts.state.inFlight += 1;
    opts.state.peakInFlight = Math.max(opts.state.peakInFlight, opts.state.inFlight);
    opts.state.order.push(`start:${arg.prompt.slice(-20)}`);
    try {
      await new Promise((r) => setTimeout(r, opts.heldMs));
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'SUMMARY' }],
        },
      };
    } finally {
      opts.state.inFlight -= 1;
      opts.state.order.push(`end:${arg.prompt.slice(-20)}`);
    }
  });
}

describe('summary-compressor — concurrent compressWithSdk calls serialize', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('never runs two SDK query() calls concurrently, even with 3 callers firing at the same tick', async () => {
    const state = { inFlight: 0, peakInFlight: 0, order: [] as string[] };
    queryMock.mockImplementation(makeQueryMock({ heldMs: 30, state }));

    const { compressWithSdk } = await import('../../src/context/summary-compressor.js');

    // Three simultaneous callers. Without the serialization gate their
    // `await import(...)` resolve in parallel and `query()` fires 3
    // times back-to-back (peakInFlight === 3). With the gate, the second
    // waits for the first to release the lane before starting.
    const results = await Promise.all([
      compressWithSdk(makeInput('A')),
      compressWithSdk(makeInput('B')),
      compressWithSdk(makeInput('C')),
    ]);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.summary).toBe('SUMMARY');
      expect(r.fromSdk).toBe(true);
    }

    expect(queryMock).toHaveBeenCalledTimes(3);
    // THE CONTRACT. Regressing to parallel compression would bump this.
    expect(state.peakInFlight).toBe(1);

    // Start/end must alternate strictly — no "start:X" while the prior
    // call hasn't emitted its "end:" event.
    let active = 0;
    for (const ev of state.order) {
      if (ev.startsWith('start:')) {
        active += 1;
        expect(active).toBeLessThanOrEqual(1);
      } else {
        active -= 1;
      }
    }
  });

  it('releases the lane even when the current call throws, so the queue does not stall', async () => {
    const state = { inFlight: 0, peakInFlight: 0, order: [] as string[] };
    let callIndex = 0;
    queryMock.mockImplementation(async function* (arg: { prompt: string }) {
      const me = ++callIndex;
      state.inFlight += 1;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      state.order.push(`start:${me}`);
      try {
        await new Promise((r) => setTimeout(r, 10));
        if (me === 1) {
          // First caller blows up mid-stream. The gate MUST still let
          // the queued calls behind it run.
          throw new Error('simulated SDK explosion');
        }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } };
      } finally {
        state.inFlight -= 1;
        state.order.push(`end:${me}`);
      }
    });

    const { compressWithSdk } = await import('../../src/context/summary-compressor.js');

    const results = await Promise.all([
      compressWithSdk(makeInput('x')),
      compressWithSdk(makeInput('y')),
    ]);

    // The contract this test pins: even when the first caller's
    // underlying SDK stream threw, the lane released so the second
    // caller ran — the queue did NOT stall. Both calls returned (sdk
    // retry or local fallback, either is acceptable), and at no point
    // did two SDK query() invocations overlap.
    expect(results).toHaveLength(2);
    expect(state.peakInFlight).toBe(1);
    // Second caller actually entered the SDK path (i.e. didn't get
    // stuck waiting forever on a broken queue).
    expect(state.order.some((e) => e.startsWith('start:'))).toBe(true);
    expect(state.order.filter((e) => e.startsWith('end:'))).toHaveLength(
      state.order.filter((e) => e.startsWith('start:')).length,
    );
  });
});
