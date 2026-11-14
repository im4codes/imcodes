/** @vitest-environment node */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsBridge } from '../src/ws/bridge.js';
import { TIMELINE_MESSAGES, TIMELINE_SUBSCRIPTION_MODES } from '../../shared/timeline-protocol.js';
import type { ShareScopedSocketState, ShareTarget } from '../src/ws/share-policy.js';

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: (_s: string) => 'valid-hash',
}));

vi.mock('../src/routes/push.js', () => ({
  dispatchPush: vi.fn(),
}));

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  readyState = 1;
  bufferedAmount = 0;

  send(data: string | Buffer, _opts?: unknown, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  get sentStrings(): string[] {
    return this.sent.filter((s): s is string => typeof s === 'string');
  }
}

const SERVER_ID = 'fanout-test-srv';
const SESSION = 'deck_fanout_brain';
const OTHER_SESSION = 'deck_other_brain';

function makeShareState(role: 'viewer' | 'participant', sessionName: string, serverId: string): ShareScopedSocketState {
  const target: ShareTarget = { kind: 'main', serverId, sessionName };
  return {
    shareId: `share-${role}-${sessionName}`,
    serverId,
    userId: `guest-${role}`,
    effectiveRole: role,
    target,
    snapshot: {
      shareId: `share-${role}-${sessionName}`,
      serverId,
      ownerUserId: 'owner-1',
      target,
      effectiveRole: role,
      permission: role === 'participant' ? 'write' : 'read',
      coveringShareIds: [`share-${role}-${sessionName}`],
      primaryShareId: `share-${role}-${sessionName}`,
      nextCoverageRecheckAt: Date.now() + 60_000,
    },
    coveredSubSessions: new Set(),
    coveredProjectDirs: [],
    lastRecheckedAt: Date.now(),
  } as unknown as ShareScopedSocketState;
}

type BridgeInternals = {
  browserSockets: Set<MockWs>;
  browserUserIds: Map<MockWs, string>;
  browserSubscriptions: Map<MockWs, Map<string, boolean>>;
  transportSubscriptions: Map<MockWs, Set<string>>;
  timelineSubscriptions: Map<MockWs, Map<string, string>>;
  timelineProtocolSockets: Set<MockWs>;
  browserShareStates: Map<MockWs, ShareScopedSocketState>;
  timelineQueues: Map<MockWs, { dispose(): void }>;
  deliverTimelineEventToSubscribers(sessionName: string, rawEvent: Record<string, unknown>, envelope: Record<string, unknown>): number;
  sendJsonToSessionSubscribers(sessionName: string, json: string, extraRecipient?: MockWs): number;
  sendJsonToSessionUserDevices(sessionName: string, json: string, preParsedMsg?: Record<string, unknown>): number;
  sendToTransportSubscribers(sessionId: string, data: string): void;
  broadcastToBrowsers(json: string, preParsedMsg?: Record<string, unknown>): void;
};

describe('WsBridge fanout serialization & Share boundary', () => {
  let bridgeSeq = 0;
  let bridge: WsBridge;
  let internals: BridgeInternals;

  beforeEach(() => {
    bridgeSeq += 1;
    bridge = WsBridge.get(`${SERVER_ID}-${bridgeSeq}`);
    internals = bridge as unknown as BridgeInternals;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const q of internals.timelineQueues.values()) q.dispose();
    internals.timelineQueues.clear();
    internals.browserSockets.clear();
    internals.browserUserIds.clear();
    internals.browserSubscriptions.clear();
    internals.transportSubscriptions.clear();
    internals.timelineSubscriptions.clear();
    internals.timelineProtocolSockets.clear();
    internals.browserShareStates.clear();
  });

  it('skips JSON.parse completely when no share sockets are connected', () => {
    const sockets = Array.from({ length: 4 }, () => new MockWs());
    const extra = new MockWs();
    for (const ws of sockets) {
      internals.browserSockets.add(ws);
      internals.browserUserIds.set(ws, 'owner-1');
      internals.browserSubscriptions.set(ws, new Map([[SESSION, false]]));
      internals.transportSubscriptions.set(ws, new Set([SESSION]));
      internals.timelineProtocolSockets.add(ws);
      internals.timelineSubscriptions.set(ws, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.FULL]]));
    }
    const companion = new MockWs();
    internals.browserSockets.add(companion);
    internals.browserUserIds.set(companion, 'owner-1');

    const parseSpy = vi.spyOn(JSON, 'parse');

    const payload = JSON.stringify({ type: 'command.ack', sessionName: SESSION, commandId: 'c1', status: 'accepted' });
    expect(internals.sendJsonToSessionSubscribers(SESSION, payload, extra)).toBe(5);
    expect(internals.sendJsonToSessionUserDevices(SESSION, JSON.stringify({ type: 'timeline.event', event: { sessionId: SESSION } }))).toBe(5);
    internals.sendToTransportSubscribers(SESSION, JSON.stringify({ type: 'transport.event', sessionId: SESSION }));
    internals.broadcastToBrowsers(JSON.stringify({ type: 'daemon.reconnected' }));

    const rawEvent = { eventId: 'e1', sessionId: SESSION, ts: 1, seq: 1, epoch: 1, type: 'assistant.text', payload: { text: 'hi', streaming: false } };
    expect(internals.deliverTimelineEventToSubscribers(SESSION, rawEvent, { type: TIMELINE_MESSAGES.EVENT, event: rawEvent })).toBe(4);

    expect(parseSpy).not.toHaveBeenCalled();
    for (const ws of sockets) expect(ws.sentStrings.length).toBeGreaterThanOrEqual(5);
    expect(extra.sentStrings).toEqual([payload]);
  });

  it('lazily serializes timeline events once per mode and suppresses duplicate summary values before stringify', () => {
    const fullSockets = Array.from({ length: 3 }, () => new MockWs());
    const summarySockets = Array.from({ length: 3 }, () => new MockWs());
    for (const ws of fullSockets) {
      internals.timelineProtocolSockets.add(ws);
      internals.timelineSubscriptions.set(ws, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.FULL]]));
    }
    for (const ws of summarySockets) {
      internals.timelineProtocolSockets.add(ws);
      internals.timelineSubscriptions.set(ws, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.SUMMARY]]));
    }

    const stringifySpy = vi.spyOn(JSON, 'stringify');

    const envelopeStringifyCount = () => stringifySpy.mock.calls.filter(
      ([arg]) => typeof arg === 'object' && arg !== null && 'event' in arg,
    ).length;

    // 1. Streaming text: only full sockets receive it -> envelope stringify called 1 time
    const streamEvent = { eventId: 'e-stream', sessionId: SESSION, ts: 1, seq: 1, epoch: 1, type: 'assistant.text', payload: { text: 'part', streaming: true } };
    expect(internals.deliverTimelineEventToSubscribers(SESSION, streamEvent, { type: TIMELINE_MESSAGES.EVENT, event: streamEvent })).toBe(3);
    expect(envelopeStringifyCount()).toBe(1);
    for (const ws of summarySockets) expect(ws.sent).toHaveLength(0);

    // 2. First agent.status -> 1 envelope stringify for full + 1 for summary; fingerprint runs only once across 3 summary sockets (6 primitive/key JSON.stringify calls)
    stringifySpy.mockClear();
    const status1 = { eventId: 'e-s1', sessionId: SESSION, ts: 2, seq: 2, epoch: 1, type: 'agent.status', payload: { status: 'running', model: 'm1', step: 1 } };
    expect(internals.deliverTimelineEventToSubscribers(SESSION, status1, { type: TIMELINE_MESSAGES.EVENT, event: status1 })).toBe(6);
    expect(envelopeStringifyCount()).toBe(2);
    expect(stringifySpy).toHaveBeenCalledTimes(8);

    // 3. Equivalent agent.status with reordered keys -> suppressed for all 3 summary sockets BEFORE serialization -> only 1 envelope stringify (full), fingerprint still once (6)!
    stringifySpy.mockClear();
    const status2 = { eventId: 'e-s2', sessionId: SESSION, ts: 3, seq: 3, epoch: 1, type: 'agent.status', payload: { step: 1, model: 'm1', status: 'running' } };
    expect(internals.deliverTimelineEventToSubscribers(SESSION, status2, { type: TIMELINE_MESSAGES.EVENT, event: status2 })).toBe(3);
    expect(envelopeStringifyCount()).toBe(1);
    expect(stringifySpy).toHaveBeenCalledTimes(7);
    for (const ws of fullSockets) expect(ws.sent).toHaveLength(3);

    // 4. Terminal session.state is never suppressed even if repeated (flushes queued coalescible status1)
    stringifySpy.mockClear();
    const idle1 = { eventId: 'e-idle1', sessionId: SESSION, ts: 4, seq: 4, epoch: 1, type: 'session.state', payload: { state: 'idle' } };
    const idle2 = { eventId: 'e-idle2', sessionId: SESSION, ts: 5, seq: 5, epoch: 1, type: 'session.state', payload: { state: 'idle' } };
    expect(internals.deliverTimelineEventToSubscribers(SESSION, idle1, { type: TIMELINE_MESSAGES.EVENT, event: idle1 })).toBe(6);
    expect(internals.deliverTimelineEventToSubscribers(SESSION, idle2, { type: TIMELINE_MESSAGES.EVENT, event: idle2 })).toBe(6);
    expect(envelopeStringifyCount()).toBe(4);
    for (const ws of summarySockets) expect(ws.sent).toHaveLength(3); // status1 + idle1 + idle2 (status2 suppressed)
  });

  it('preserves 0/N-share mixed fanout filtering, single-parse behavior, and fail-closed on malformed JSON', () => {
    const ownerFull = new MockWs();
    const ownerSummary = new MockWs();
    const shareViewer = new MockWs();
    const shareOther = new MockWs();

    for (const ws of [ownerFull, ownerSummary, shareViewer, shareOther]) {
      internals.browserSockets.add(ws);
      internals.browserSubscriptions.set(ws, new Map([[SESSION, false]]));
      internals.transportSubscriptions.set(ws, new Set([SESSION]));
      internals.timelineProtocolSockets.add(ws);
    }
    internals.browserUserIds.set(ownerFull, 'owner-1');
    internals.browserUserIds.set(ownerSummary, 'owner-1');
    internals.timelineSubscriptions.set(ownerFull, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.FULL]]));
    internals.timelineSubscriptions.set(ownerSummary, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.SUMMARY]]));
    internals.timelineSubscriptions.set(shareViewer, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.FULL]]));
    internals.timelineSubscriptions.set(shareOther, new Map([[SESSION, TIMELINE_SUBSCRIPTION_MODES.FULL]]));
    const serverId = `${SERVER_ID}-${bridgeSeq}`;
    internals.browserShareStates.set(shareViewer, makeShareState('viewer', SESSION, serverId));
    internals.browserShareStates.set(shareOther, makeShareState('participant', OTHER_SESSION, serverId));

    // A. Mixed timeline delivery of task_pair.event with sensitive title/model:
    // - owner sockets receive full/summary unredacted
    // - covered viewer share socket receives redacted JSON
    // - uncovered shareOther receives nothing
    const parseSpy = vi.spyOn(JSON, 'parse');
    const pairEvent = {
      eventId: 'e-pair',
      sessionId: SESSION,
      ts: 10,
      seq: 10,
      epoch: 1,
      type: 'task_pair.event',
      payload: {
        taskId: 'tsk_secret',
        title: 'SecretTaskTitle',
        executorModel: 'secret-model',
        status: 'working',
      },
    };
    const delivered = internals.deliverTimelineEventToSubscribers(SESSION, pairEvent, { type: TIMELINE_MESSAGES.EVENT, event: pairEvent });
    expect(delivered).toBe(3);
    expect(parseSpy).not.toHaveBeenCalled(); // Timeline path filters the in-memory object directly!
    expect(ownerFull.sentStrings[0]).toContain('SecretTaskTitle');
    expect(ownerSummary.sentStrings[0]).toContain('SecretTaskTitle');
    expect(shareViewer.sentStrings).toHaveLength(1);
    expect(shareViewer.sentStrings[0]).not.toContain('SecretTaskTitle');
    expect(shareViewer.sentStrings[0]).not.toContain('secret-model');
    expect(shareOther.sentStrings).toHaveLength(0);

    // B. Valid JSON fanout parses at most once even with multiple share sockets
    for (const ws of [ownerFull, ownerSummary, shareViewer, shareOther]) ws.sent.length = 0;
    parseSpy.mockClear();
    const ackJson = JSON.stringify({ type: 'command.ack', session: SESSION, commandId: 'cmd-1', status: 'accepted' });
    expect(internals.sendJsonToSessionSubscribers(SESSION, ackJson)).toBe(3);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(ownerFull.sentStrings).toEqual([ackJson]);
    expect(shareViewer.sentStrings).toEqual([ackJson]);
    expect(shareOther.sentStrings).toHaveLength(0);

    parseSpy.mockClear();
    const daemonReconnectedJson = JSON.stringify({ type: 'daemon.reconnected' });
    internals.broadcastToBrowsers(daemonReconnectedJson);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(ownerFull.sentStrings).toHaveLength(2);
    // daemon.reconnected has no session scope -> denied for share sockets
    expect(shareViewer.sentStrings).toHaveLength(1);
    expect(shareOther.sentStrings).toHaveLength(0);

    // C. Malformed JSON fails closed for all share sockets across all 4 fanout paths while reaching normal sockets
    for (const ws of [ownerFull, ownerSummary, shareViewer, shareOther]) ws.sent.length = 0;
    const malformed = '{not-valid-json';
    expect(internals.sendJsonToSessionSubscribers(SESSION, malformed)).toBe(2);
    expect(internals.sendJsonToSessionUserDevices(SESSION, malformed)).toBe(2);
    internals.sendToTransportSubscribers(SESSION, malformed);
    internals.broadcastToBrowsers(malformed);

    expect(ownerFull.sentStrings).toEqual([malformed, malformed, malformed, malformed]);
    expect(ownerSummary.sentStrings).toEqual([malformed, malformed, malformed, malformed]);
    expect(shareViewer.sentStrings).toHaveLength(0);
    expect(shareOther.sentStrings).toHaveLength(0);
  });
});
