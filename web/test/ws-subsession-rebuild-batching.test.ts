import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient, chunkSubSessionRebuildBatches } from '../src/ws-client.js';

/**
 * `subsession.rebuild_all` used to go out as one message holding every
 * sub-session. Past ~150 entries that crosses the 60 KB outbound cap and
 * `send` throws, which escaped the effect that calls it and aborted the rest
 * of that effect flush — including the effect right after it that opens the
 * transport chat subscriptions for those sub-sessions. With no subscriber the
 * server discards their live timeline events, so sub-session replies only
 * came back through history backfill and stopped rendering progressively,
 * while main sessions (subscribed in an earlier flush) kept typing normally.
 *
 * These pin the batching, not the symptom: no batch may reach the cap.
 */
const OUTBOUND_CAP_BYTES = 60_000;

function serializedBytes(batch: unknown[]): number {
  return new TextEncoder().encode(
    JSON.stringify({ type: 'subsession.rebuild_all', subSessions: batch }),
  ).byteLength;
}

function makeSub(i: number, transportConfigChars = 0) {
  return {
    id: `sub-${i}`,
    type: 'claude-code-sdk',
    runtimeType: 'transport' as const,
    providerId: 'claude-code-sdk',
    providerSessionId: `provider-session-${i}-${'x'.repeat(24)}`,
    cwd: `/Users/someone/code/project-${i}`,
    parentSession: 'deck_alpha_brain',
    label: `worker ${i}`,
    ...(transportConfigChars > 0
      ? { transportConfig: { systemPrompt: 'y'.repeat(transportConfigChars) } }
      : {}),
  };
}

describe('chunkSubSessionRebuildBatches', () => {
  it('keeps a realistic 178-session list under the outbound cap', () => {
    // 178 is the count from the report that produced "Message too large".
    const subs = Array.from({ length: 178 }, (_, i) => makeSub(i));
    expect(serializedBytes(subs)).toBeGreaterThan(OUTBOUND_CAP_BYTES / 3);

    const batches = chunkSubSessionRebuildBatches(subs);
    expect(batches.length).toBeGreaterThan(0);
    for (const batch of batches) {
      expect(serializedBytes(batch)).toBeLessThan(OUTBOUND_CAP_BYTES);
    }
  });

  it('loses nothing and preserves order across batches', () => {
    const subs = Array.from({ length: 400 }, (_, i) => makeSub(i));
    const flattened = chunkSubSessionRebuildBatches(subs).flat();
    expect(flattened).toEqual(subs);
  });

  it('sends a small list as a single message', () => {
    const subs = Array.from({ length: 5 }, (_, i) => makeSub(i));
    expect(chunkSubSessionRebuildBatches(subs)).toEqual([subs]);
  });

  it('splits by measured size, not by a fixed count', () => {
    // Entries vary by more than an order of magnitude; a fixed count would
    // either waste most of the budget or still overflow on the fat ones.
    const fat = Array.from({ length: 40 }, (_, i) => makeSub(i, 4_000));
    const batches = chunkSubSessionRebuildBatches(fat);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(serializedBytes(batch)).toBeLessThan(OUTBOUND_CAP_BYTES);
    }
  });

  it('gives an entry too large to ever fit its own batch rather than dropping it', () => {
    const subs = [makeSub(0), makeSub(1, 90_000), makeSub(2)];
    const batches = chunkSubSessionRebuildBatches(subs);
    expect(batches.flat()).toEqual(subs);
    expect(batches.some((batch) => batch.length === 1 && batch[0] === subs[1])).toBe(true);
  });

  it('returns nothing for an empty list so no pointless message is sent', () => {
    expect(chunkSubSessionRebuildBatches([])).toEqual([]);
  });
});

/**
 * The chunker being correct proves nothing if the caller still sends one
 * message — reverting `subSessionRebuildAll` to a single `send` leaves every
 * test above green. These drive the real client instead.
 */
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  send = vi.fn();

  constructor(public url: string) {}
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  close(): void { this.readyState = MockWebSocket.CLOSED; }
  emit(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = MockWebSocket.OPEN;
    for (const fn of this.listeners[type] ?? []) fn(data);
  }
}

describe('WsClient.subSessionRebuildAll', () => {
  let lastWs: MockWebSocket | null = null;

  beforeEach(() => {
    lastWs = null;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url: string) { super(url); lastWs = this; }
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ticket: 't' }) }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  async function connected(): Promise<{ client: WsClient; socket: MockWebSocket }> {
    const client = new WsClient('http://localhost:8787', 'srv-1');
    client.connect();
    await new Promise<void>((r) => setTimeout(r, 0));
    lastWs!.emit('open');
    return { client, socket: lastWs! };
  }

  it('sends an over-cap rebuild without throwing, split across messages', async () => {
    const { client, socket } = await connected();
    socket.send.mockClear();

    // 178 is the count from the report. Entries carry a transportConfig so the
    // list actually crosses the cap, which is the premise of the test.
    const subs = Array.from({ length: 178 }, (_, i) => makeSub(i, 300));
    expect(serializedBytes(subs)).toBeGreaterThan(OUTBOUND_CAP_BYTES);
    // The whole point: this used to throw "Message too large" and take the
    // rest of the effect flush — the transport chat subscriptions — with it.
    expect(() => client.subSessionRebuildAll(subs as never)).not.toThrow();

    const payloads = socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as { type: string; subSessions?: unknown[] })
      .filter((m) => m.type === 'subsession.rebuild_all');
    expect(payloads.length).toBeGreaterThan(1);
    for (const [raw] of socket.send.mock.calls) {
      expect(new TextEncoder().encode(raw as string).byteLength).toBeLessThan(OUTBOUND_CAP_BYTES);
    }
    expect(payloads.flatMap((m) => m.subSessions ?? [])).toEqual(subs);
  });

  it('still sends a small list as exactly one message', async () => {
    const { client, socket } = await connected();
    socket.send.mockClear();

    client.subSessionRebuildAll(Array.from({ length: 3 }, (_, i) => makeSub(i)) as never);

    const payloads = socket.send.mock.calls
      .map(([raw]) => JSON.parse(raw as string) as { type: string })
      .filter((m) => m.type === 'subsession.rebuild_all');
    expect(payloads).toHaveLength(1);
  });
});
