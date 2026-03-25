/**
 * Tests for transport session JSONL history cache.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendTransportEvent, replayTransportHistory } from '../../src/daemon/transport-history.js';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Override TRANSPORT_DIR for tests by patching the module's internal path
// Since the module uses homedir()/.imcodes/transport, we test with a real temp dir
// and a unique session ID to avoid collision.

const TEST_SESSION = `test-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe('transport-history', () => {
  it('appendTransportEvent writes JSONL line', async () => {
    const event = { type: 'chat.delta', sessionId: TEST_SESSION, delta: 'hello' };
    await appendTransportEvent(TEST_SESSION, event);

    const events = await replayTransportHistory(TEST_SESSION);
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
    const session = `${TEST_SESSION}-multi`;
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
    const session = `${TEST_SESSION}-struct`;
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
});
