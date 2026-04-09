/**
 * Integration test: OC streaming pipeline end-to-end.
 *
 * Tests the full path: OpenClawProvider delta → transport-relay → timelineEmitter
 * → lifecycle sentEventIds bypass → all cumulative deltas reach browsers.
 *
 * This test does NOT mock the timeline emitter or transport-relay — it uses the
 * real modules and verifies that the provider's cumulative deltas flow through
 * the relay and emitter correctly, and that lifecycle's sentEventIds dedup does
 * not block streaming updates.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock WebSocket (same pattern as openclaw-provider.test.ts) ───────────────

const wsMeta: { last: any } = { last: null };

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    send(data: string) { this.sent.push(data); }
    close() {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from(''));
    }
    removeAllListeners() { super.removeAllListeners(); return this; }
    constructor(_url?: string) {
      super();
      wsMeta.last = this;
    }
  }

  return { default: MockWebSocket, __esModule: true };
});

function lastWs(): any { return wsMeta.last; }

// Mock session-manager to pass through providerSid as sessionName
vi.mock('../../src/agent/session-manager.js', () => ({
  resolveSessionName: (providerSid: string) => providerSid,
}));

// Mock transport-history (file writes)
vi.mock('../../src/daemon/transport-history.js', () => ({
  appendTransportEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { OpenClawProvider } from '../../src/agent/providers/openclaw.js';
import { wireProviderToRelay } from '../../src/daemon/transport-relay.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import type { TimelineEvent } from '../../src/daemon/timeline-event.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function simulateHandshake(): void {
  const ws = lastWs();
  ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n' } }));
  ws.emit('message', JSON.stringify({ type: 'event', event: 'hello-ok' }));
}

async function connectProvider(provider: OpenClawProvider): Promise<void> {
  const p = provider.connect({ url: 'ws://test', token: 'tok' });
  simulateHandshake();
  await p;
}

function emitAgentEvent(payload: Record<string, unknown>): void {
  lastWs().emit('message', JSON.stringify({ type: 'event', event: 'agent', payload }));
}

function advanceStreamWindow(): void {
  vi.advanceTimersByTime(250);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OC streaming integration: provider → relay → emitter', () => {
  let provider: OpenClawProvider;
  let emittedEvents: TimelineEvent[];
  let unsubEmitter: (() => void) | null;

  beforeEach(async () => {
    vi.useFakeTimers();
    provider = new OpenClawProvider();

    // Capture ALL events emitted by the real timelineEmitter
    emittedEvents = [];
    unsubEmitter = timelineEmitter.on((e) => emittedEvents.push(e));

    // Connect and wire up the relay
    await connectProvider(provider);
    wireProviderToRelay(provider);
  });

  afterEach(async () => {
    unsubEmitter?.();
    await provider.disconnect();
    vi.useRealTimers();
  });

  it('incremental deltas → cumulative text events reach emitter with same eventId', () => {
    const runId = 'int-run-1';

    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'test:sess' });
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: '你' }, key: 'test:sess' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: '好' }, key: 'test:sess' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: '世' }, key: 'test:sess' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: '界' }, key: 'test:sess' });
    advanceStreamWindow();

    // Filter to assistant.text events for the sanitized session
    const textEvents = emittedEvents.filter(
      (e) => e.type === 'assistant.text' && e.sessionId === 'test___sess',
    );

    expect(textEvents).toHaveLength(4);

    // Each event has cumulative (growing) text
    expect(textEvents[0].payload.text).toBe('你');
    expect(textEvents[1].payload.text).toBe('你好');
    expect(textEvents[2].payload.text).toBe('你好世');
    expect(textEvents[3].payload.text).toBe('你好世界');

    // All share the same stable eventId
    const ids = new Set(textEvents.map((e) => e.eventId));
    expect(ids.size).toBe(1);

    // All marked as streaming
    expect(textEvents.every((e) => e.payload.streaming === true)).toBe(true);
  });

  it('lifecycle end emits final non-streaming event with full text and same eventId', () => {
    const runId = 'int-run-2';

    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'test:s2' });
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'Hello ' }, key: 'test:s2' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'World' }, key: 'test:s2' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'test:s2' });

    const textEvents = emittedEvents.filter(
      (e) => e.type === 'assistant.text' && e.sessionId === 'test___s2',
    );

    // 2 streaming + 1 final
    expect(textEvents).toHaveLength(3);

    // Final event: streaming=false, full text
    const final = textEvents[2];
    expect(final.payload.streaming).toBe(false);
    expect(final.payload.text).toBe('Hello World');

    // Same eventId as streaming events
    expect(final.eventId).toBe(textEvents[0].eventId);
  });

  it('non-cumulative text field from OC → still produces cumulative output', () => {
    const runId = 'int-run-nc';

    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'test:nc' });

    // OC sends text=delta (both incremental, text field NOT cumulative)
    emitAgentEvent({ runId, stream: 'assistant', data: { text: '收到', delta: '收到' }, key: 'test:nc' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { text: '主人', delta: '主人' }, key: 'test:nc' });
    advanceStreamWindow();

    const textEvents = emittedEvents.filter(
      (e) => e.type === 'assistant.text' && e.sessionId === 'test___nc',
    );

    expect(textEvents).toHaveLength(2);
    // First delta: "收到" (initial)
    expect(textEvents[0].payload.text).toBe('收到');
    // Second delta: cumulative despite non-cumulative text field
    expect(textEvents[1].payload.text).toBe('收到主人');

    // Verify onComplete also has full text
    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'test:nc' });

    const finalEvents = emittedEvents.filter(
      (e) => e.type === 'assistant.text' && e.sessionId === 'test___nc' && e.payload.streaming === false,
    );
    expect(finalEvents).toHaveLength(1);
    expect(finalEvents[0].payload.text).toBe('收到主人');
  });

  it('sentEventIds dedup does NOT block streaming deltas (all reach handlers)', () => {
    // This test verifies the lifecycle.ts fix: streaming events with the same eventId
    // must not be deduped by sentEventIds because they carry updated cumulative text.
    //
    // We simulate what lifecycle.ts does: maintain a sentEventIds set and check each
    // event. Streaming events (payload.streaming === true) must bypass the dedup.

    const sentEventIds = new Set<string>();

    function shouldSend(event: TimelineEvent): boolean {
      const isTransportStream = event.eventId?.startsWith('transport:') ?? false;
      if (event.eventId && sentEventIds.has(event.eventId) && !isTransportStream) return false;
      if (event.eventId) sentEventIds.add(event.eventId);
      return true;
    }

    const runId = 'int-run-dedup';

    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'test:dd' });
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'A' }, key: 'test:dd' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'B' }, key: 'test:dd' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'C' }, key: 'test:dd' });
    advanceStreamWindow();
    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'test:dd' });

    const textEvents = emittedEvents.filter(
      (e) => e.type === 'assistant.text' && e.sessionId === 'test___dd',
    );

    // Apply the dedup logic to each event
    const forwarded = textEvents.filter(shouldSend);

    // ALL events should pass through (3 streaming + 1 final)
    expect(forwarded).toHaveLength(4);
    expect(forwarded[0].payload.text).toBe('A');
    expect(forwarded[1].payload.text).toBe('AB');
    expect(forwarded[2].payload.text).toBe('ABC');
    expect(forwarded[3].payload.text).toBe('ABC');
    expect(forwarded[3].payload.streaming).toBe(false);
  });

  it('session.state idle is emitted after final assistant.text', () => {
    const runId = 'int-run-idle';

    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'test:idle' });
    emitAgentEvent({ runId, stream: 'assistant', data: { delta: 'done' }, key: 'test:idle' });
    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'end' }, key: 'test:idle' });

    const sessEvents = emittedEvents.filter((e) => e.sessionId === 'test___idle');
    const finalTextIdx = sessEvents.findIndex(
      (e) => e.type === 'assistant.text' && e.payload.streaming === false,
    );
    const idleIdx = sessEvents.findIndex(
      (e) => e.type === 'session.state' && e.payload.state === 'idle',
    );

    expect(finalTextIdx).toBeGreaterThanOrEqual(0);
    expect(idleIdx).toBeGreaterThan(finalTextIdx);
  });

  it('tool stream emits transport tool.call + tool.result timeline events', () => {
    const runId = 'int-run-tool';

    emitAgentEvent({ runId, stream: 'lifecycle', data: { phase: 'start' }, key: 'test:tool' });
    emitAgentEvent({
      runId,
      stream: 'tool',
      key: 'test:tool',
      data: {
        phase: 'start',
        name: 'bash',
        toolCallId: 'tc-1',
        args: { command: 'pwd' },
      },
    });
    emitAgentEvent({
      runId,
      stream: 'tool',
      key: 'test:tool',
      data: {
        phase: 'result',
        name: 'bash',
        toolCallId: 'tc-1',
        result: { stdout: '/tmp/project\n' },
        meta: { exitCode: 0 },
      },
    });

    const toolEvents = emittedEvents.filter(
      (e) => (e.type === 'tool.call' || e.type === 'tool.result') && e.sessionId === 'test___tool',
    );

    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[0].type).toBe('tool.call');
    expect(toolEvents[0].payload.tool).toBe('bash');
    expect(toolEvents[0].payload.input).toEqual({ command: 'pwd' });
    expect(toolEvents[1].type).toBe('tool.result');
    expect(toolEvents[1].payload.output).toBe(JSON.stringify({ stdout: '/tmp/project\n' }));
    expect(toolEvents[1].payload.detail).toMatchObject({
      kind: 'openclaw.tool',
      meta: { exitCode: 0 },
    });
  });
});
