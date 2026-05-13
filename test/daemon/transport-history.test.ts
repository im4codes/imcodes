/**
 * Tests for transport session JSONL history cache.
 */
import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  TRANSPORT_HISTORY_REPLAY_BUDGET_BYTES,
  TRANSPORT_HISTORY_TOOL_RESULT_PREVIEW_BYTES,
  appendTransportEvent,
  replayTransportHistory,
  trimTransportHistoryEventsToReplayBudget,
} from '../../src/daemon/transport-history.js';

// Use a unique session ID per test run to avoid cross-test file system collisions.
const TS = `test-transport-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function transportSessionFile(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(homedir(), '.imcodes', 'transport', `${safe}.jsonl`);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(String(value), 'utf8');
}

describe('transport-history', () => {
  it('appendTransportEvent writes JSONL line', async () => {
    const event = { type: 'assistant.text', sessionId: TS, text: 'hello' };
    await appendTransportEvent(TS, event);

    const events = await replayTransportHistory(TS);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last['type']).toBe('assistant.text');
    expect(last['text']).toBe('hello');
    expect(last['_ts']).toBeTypeOf('number');
  });

  it('replayTransportHistory returns empty for nonexistent session', async () => {
    const events = await replayTransportHistory('nonexistent-session-xyz');
    expect(events).toEqual([]);
  });

  it('multiple appends create multiple lines', async () => {
    const session = `${TS}-multi`;
    await appendTransportEvent(session, { type: 'user.message', text: 'a' });
    await appendTransportEvent(session, { type: 'tool.call', input: { command: 'x'.repeat(10_000) } });
    await appendTransportEvent(session, { type: 'assistant.text', text: 'b' });
    await appendTransportEvent(session, { type: 'chat.complete', messageId: 'm1' });
    await appendTransportEvent(session, { type: 'tool.result', output: 'ok' });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(3);
    expect(events[0]['text']).toBe('a');
    expect(events[1]['text']).toBe('b');
    expect(events[2]['type']).toBe('tool.result');
  });

  it('replay preserves event structure', async () => {
    const session = `${TS}-struct`;
    const event = {
      type: 'user.message',
      sessionId: session,
      text: 'retry this',
      commandId: 'cmd-1',
    };
    await appendTransportEvent(session, event);

    const events = await replayTransportHistory(session);
    expect(events[0]['type']).toBe('user.message');
    expect(events[0]['text']).toBe('retry this');
    expect(events[0]['commandId']).toBe('cmd-1');
  });

  it('skips non-rendered or hidden transport history events', async () => {
    const session = `${TS}-skip-noise`;
    await appendTransportEvent(session, { type: 'tool.call', input: { command: 'x'.repeat(10_000) } });
    await appendTransportEvent(session, { type: 'chat.delta', delta: 'ignored' });
    await appendTransportEvent(session, { type: 'session.error', error: 'ignored by chat.history hydration' });
    await appendTransportEvent(session, { type: 'tool.result', output: 'hidden', hidden: true });
    await appendTransportEvent(session, { type: 'assistant.text', text: 'kept' });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    expect(events[0]['type']).toBe('assistant.text');
    expect(events[0]['text']).toBe('kept');
  });

  it('stores tool.result output as a 1KB replay preview', async () => {
    const session = `${TS}-tool-result-preview`;
    const output = 'x'.repeat(10_000);
    const raw = 'z'.repeat(10_000);

    await appendTransportEvent(session, {
      type: 'tool.result',
      sessionId: session,
      tool: 'Bash',
      output,
      detail: { kind: 'tool_result', output, raw },
    });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event['type']).toBe('tool.result');
    expect(byteLength(event['output'])).toBeLessThanOrEqual(TRANSPORT_HISTORY_TOOL_RESULT_PREVIEW_BYTES);
    expect(String(event['output'])).toContain('transport result truncated');
    expect(event['detail']).toBeUndefined();
    expect(event['tool']).toBeUndefined();
    expect(event['transportHistoryTruncated']).toBe(true);
  });

  it('truncates legacy oversized detail.output lines during replay without keeping detail', async () => {
    const session = `${TS}-legacy-tool-result`;
    const output = 'o'.repeat(12_000);
    const file = transportSessionFile(session);
    await mkdir(join(homedir(), '.imcodes', 'transport'), { recursive: true });
    await writeFile(file, `${JSON.stringify({
      type: 'tool.result',
      sessionId: session,
      detail: { output, raw: output },
      _ts: Date.now(),
    })}\n`, 'utf8');

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(byteLength(event['output'])).toBeLessThanOrEqual(TRANSPORT_HISTORY_TOOL_RESULT_PREVIEW_BYTES);
    expect(String(event['output'])).toContain('transport result truncated');
    expect(event['transportHistoryTruncated']).toBe(true);
    expect(event['detail']).toBeUndefined();
  });

  it('omits non-string tool.result payloads without serializing nested objects', async () => {
    const session = `${TS}-object-tool-result`;
    const circular: Record<string, unknown> = { payload: 'x'.repeat(10_000) };
    circular.self = circular;

    await appendTransportEvent(session, {
      type: 'tool.result',
      sessionId: session,
      output: circular,
      detail: { raw: circular },
    });

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event['output']).toBe('[non-string result omitted from transport history]');
    expect(event['detail']).toBeUndefined();
    expect(event['transportHistoryTruncated']).toBe(true);
  });

  it('skips legacy non-rendered transport history rows during replay', async () => {
    const session = `${TS}-legacy-noise`;
    const file = transportSessionFile(session);
    await mkdir(join(homedir(), '.imcodes', 'transport'), { recursive: true });
    await writeFile(file, [
      JSON.stringify({ type: 'tool.call', input: { command: 'x'.repeat(10_000) }, _ts: 1 }),
      JSON.stringify({ type: 'chat.delta', delta: 'ignored', _ts: 2 }),
      JSON.stringify({ type: 'tool.result', output: 'hidden', hidden: true, _ts: 3 }),
      JSON.stringify({ type: 'assistant.text', text: 'kept', _ts: 4 }),
      '',
    ].join('\n'), 'utf8');

    const events = await replayTransportHistory(session);
    expect(events).toHaveLength(1);
    expect(events[0]['type']).toBe('assistant.text');
    expect(events[0]['text']).toBe('kept');
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

  it('returns exactly MAX_REPLAY_LINES entries even when each line is large (reverse-chunk scans back as far as needed)', async () => {
    // Synthetic-only JSONL: never copy real user transport logs into tests.
    // Adversarial shape: fewer lines, but each line is 6 KB. 200 tail
    // lines therefore need ~1.2 MB of file window — greater than any
    // fixed-byte "read last 1 MiB" strategy would cover. A simple
    // fixed-window tail-read would silently return fewer than 200 here;
    // the reverse-chunk scan keeps walking back until it has 201
    // newlines (or hits MAX_TAIL_BYTES).
    const session = `${TS}-fat-lines`;
    const FAT = 'y'.repeat(6000);
    for (let i = 0; i < 250; i++) {
      await appendTransportEvent(session, { type: 'assistant.text', idx: i, text: FAT });
    }

    const events = await replayTransportHistory(session);

    // Must return exactly the cap, and must be the tail slice [50..249].
    expect(events).toHaveLength(200);
    expect(events[0]['idx']).toBe(50);
    expect(events[events.length - 1]['idx']).toBe(249);
  });

  it('replay stays bounded on multi-megabyte JSONL files (tail-read only)', async () => {
    // Regression: before tail-reading, replay loaded the full file into a
    // JS string then sliced — a single 170MB session on 211 caused ~340MB
    // V8 heap spikes per browser subscribe, and concurrent subscribes
    // compounded that into multi-GB transient allocations and 80MB/min
    // sustained RSS growth. The rewritten impl opens the file, reads only
    // the trailing ~1 MiB, and returns the last 200 parsed entries.
    const session = `${TS}-large-jsonl`;

    // Write synthetic entries only: 5000 rows, each with ~5KB of payload → ~25 MB file — well
    // above the old "small fixture" but small enough to keep the test
    // itself fast. Each entry encodes its index so we can verify the tail.
    const BIG_PAYLOAD = 'x'.repeat(5000);
    for (let i = 0; i < 5000; i++) {
      await appendTransportEvent(session, {
        type: 'assistant.text',
        sessionId: session,
        idx: i,
        text: BIG_PAYLOAD,
      });
    }

    const events = await replayTransportHistory(session);

    // The cap is 200 — regardless of file size.
    expect(events).toHaveLength(200);

    // The returned slice MUST be the tail of the file (last 200 of 5000).
    // If the implementation silently returned the HEAD we'd see idx=0.
    const firstIdx = events[0]['idx'] as number;
    const lastIdx = events[events.length - 1]['idx'] as number;
    expect(lastIdx).toBe(4999);
    expect(firstIdx).toBe(4800);
  });

  it('keeps default chat.history replay under 128KiB for subscribe bursts', async () => {
    // Synthetic subscribe burst. This intentionally avoids real transcripts.
    const session = `${TS}-bounded-chat-history`;
    const output = 'x'.repeat(5_000);
    for (let i = 0; i < 220; i++) {
      await appendTransportEvent(session, {
        type: 'assistant.text',
        sessionId: session,
        idx: i,
        text: output,
      });
    }

    const replayed = await replayTransportHistory(session);
    expect(replayed).toHaveLength(200);

    const events = trimTransportHistoryEventsToReplayBudget(session, replayed);
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ type: 'chat.history', sessionId: session, events }), 'utf8');

    expect(envelopeBytes).toBeLessThanOrEqual(TRANSPORT_HISTORY_REPLAY_BUDGET_BYTES);
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]['idx']).toBe(219);
    expect(events[0]['idx']).toBeGreaterThan(19);
    expect(events.every((event) => event.type === 'assistant.text')).toBe(true);
    expect(events.every((event) => event.detail === undefined)).toBe(true);
  });
});
