/**
 * Tests for transport session JSONL history cache.
 */
import { describe, it, expect } from 'vitest';
import { appendTransportEvent, replayTransportHistory } from '../../src/daemon/transport-history.js';

// Use a unique session ID per test run to avoid cross-test file system collisions.
const TS = `test-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('transport-history', () => {
  it('appendTransportEvent writes JSONL line', async () => {
    const event = { type: 'chat.delta', sessionId: TS, delta: 'hello' };
    await appendTransportEvent(TS, event);

    const events = await replayTransportHistory(TS);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last['type']).toBe('chat.delta');
    expect(last['delta']).toBe('hello');
    expect(last['_ts']).toBeTypeOf('number');
  });

  it('replayTransportHistory returns empty for nonexistent session', async () => {
    const events = await replayTransportHistory('nonexistent-session-xyz');
    expect(events).toEqual([]);
  });

  it('multiple appends create multiple lines', async () => {
    const session = `${TS}-multi`;
    await appendTransportEvent(session, { type: 'chat.delta', delta: 'a' });
    await appendTransportEvent(session, { type: 'chat.delta', delta: 'b' });
    await appendTransportEvent(session, { type: 'chat.complete', messageId: 'm1' });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(3);
    expect(events[0]['delta']).toBe('a');
    expect(events[1]['delta']).toBe('b');
    expect(events[2]['type']).toBe('chat.complete');
  });

  it('replay preserves event structure', async () => {
    const session = `${TS}-struct`;
    const event = {
      type: 'chat.error',
      sessionId: session,
      error: 'provider timeout',
      code: 'PROVIDER_ERROR',
    };
    await appendTransportEvent(session, event);

    const events = await replayTransportHistory(session);
    expect(events[0]['type']).toBe('chat.error');
    expect(events[0]['error']).toBe('provider timeout');
    expect(events[0]['code']).toBe('PROVIDER_ERROR');
  });

  // ── New tests ──────────────────────────────────────────────────────────────

  it('replay only returns complete messages (no streaming deltas)', async () => {
    // The transport-relay caches ONLY the final assistant.text (not each delta),
    // so a replayed history should contain completed messages, not intermediate fragments.
    const session = `${TS}-complete-only`;

    // Simulate what transport-relay does: cache only on onComplete, not on onDelta
    await appendTransportEvent(session, {
      type: 'assistant.text',
      sessionId: session,
      text: 'full response here',
    });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    const msg = events[0];
    // The cached event is the final assistant.text — it carries the full text
    expect(msg['type']).toBe('assistant.text');
    expect(msg['text']).toBe('full response here');
    // There should be no streaming: true flag — only finalized events are stored
    expect(msg['streaming']).toBeUndefined();
  });

  it('user messages are cached and replayed', async () => {
    const session = `${TS}-user-msgs`;

    // Simulate what emitTransportUserMessage caches
    await appendTransportEvent(session, {
      type: 'user.message',
      sessionId: session,
      text: 'first question',
    });
    await appendTransportEvent(session, {
      type: 'assistant.text',
      sessionId: session,
      text: 'first answer',
    });
    await appendTransportEvent(session, {
      type: 'user.message',
      sessionId: session,
      text: 'follow-up question',
    });
    await appendTransportEvent(session, {
      type: 'assistant.text',
      sessionId: session,
      text: 'follow-up answer',
    });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(4);

    // Verify interleaved user + assistant messages are preserved in order
    expect(events[0]['type']).toBe('user.message');
    expect(events[0]['text']).toBe('first question');
    expect(events[1]['type']).toBe('assistant.text');
    expect(events[1]['text']).toBe('first answer');
    expect(events[2]['type']).toBe('user.message');
    expect(events[2]['text']).toBe('follow-up question');
    expect(events[3]['type']).toBe('assistant.text');
    expect(events[3]['text']).toBe('follow-up answer');
  });

  it('each cached event has a _ts timestamp added automatically', async () => {
    const session = `${TS}-timestamps`;
    const before = Date.now();
    await appendTransportEvent(session, { type: 'user.message', sessionId: session, text: 'hi' });
    const after = Date.now();

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    const ts = events[0]['_ts'] as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('session ID is sanitized to safe filesystem characters', async () => {
    // Session IDs with slashes or colons should not cause path traversal or errors
    const session = `${TS}-sanitize:with:colons/and/slashes`;
    await appendTransportEvent(session, { type: 'user.message', text: 'safe' });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    expect(events[0]['text']).toBe('safe');
  });
});
