import { beforeEach, describe, expect, it, vi } from 'vitest';
const { sessions, append, read, run } = vi.hoisted(() => ({
  sessions: new Map<string, { incognito?: boolean; sessionInstanceId?: string; runtimeEpoch?: string }>(),
  append: vi.fn(), read: vi.fn(() => []), run: vi.fn(async () => undefined),
}));
vi.mock('../../src/store/session-store.js', () => ({ getSession: (name: string) => sessions.get(name) }));
vi.mock('../../src/daemon/timeline-store.js', () => ({ timelineStore: { append, read } }));
vi.mock('../../src/store/context-store-worker-client.js', () => ({ getContextStoreClient: () => ({ run }) }));
import { TimelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { SESSION_INCOGNITO_MAX_BUFFER } from '../../shared/session-incognito-types.js';

describe('incognito timeline', () => {
  beforeEach(() => { sessions.clear(); vi.clearAllMocks(); });
  it('keeps live data, forces exclusion on every kind, and never schedules timeline or usage disk writes', () => {
    sessions.set('private', { incognito: true });
    const emitter = new TimelineEmitter(), observed: unknown[] = [];
    emitter.on(event => observed.push(event));
    for (const type of ['user.message', 'assistant.text', 'tool.call', 'tool.result', 'usage.update', 'session.state'] as const) {
      const event = emitter.emit('private', type, { text: 'private sentinel', memoryExcluded: false, state: 'idle' });
      expect(event?.payload).toMatchObject({ incognito: true, memoryExcluded: true });
    }
    expect(observed).toHaveLength(6);
    expect(emitter.getBufferedEvents('private')).toHaveLength(6);
    expect(append).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    const synthetic = emitter.emit('private', 'session.state', { state: 'idle' });
    expect(synthetic?.payload).toMatchObject({ incognito: true, memoryExcluded: true });
  });
  it('caps at 500, never reads historical disk, forgets the ring, and does not survive restart', () => {
    sessions.set('private', { incognito: true });
    const emitter = new TimelineEmitter();
    for (let i = 0; i < 650; i++) emitter.emit('private', 'assistant.text', { text: String(i) });
    expect(emitter.getBufferedEvents('private')).toHaveLength(SESSION_INCOGNITO_MAX_BUFFER);
    expect(emitter.replay('private', 0)).toMatchObject({ truncated: true });
    expect(read).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    expect(new TimelineEmitter().replay('private', 0).events).toEqual([]);
    emitter.forgetSession('private');
    expect(emitter.getBufferedEvents('private')).toEqual([]);
  });
  it('keeps ordinary session persistence, memory and usage behavior unchanged', () => {
    const emitter = new TimelineEmitter();
    const event = emitter.emit('normal', 'assistant.text', { text: 'ordinary' });
    expect(event?.payload.memoryExcluded).toBeUndefined();
    emitter.emit('normal', 'usage.update', { inputTokens: 1 });
    expect(append).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledWith('recordTurnUsage', [expect.any(Object)]);
  });
  it('propagates per-session sessionInstanceId and runtimeEpoch onto emitted TimelineEvent without conflating daemon epoch', () => {
    sessions.set('private', { incognito: true, sessionInstanceId: 'inst-p', runtimeEpoch: 'rt-p' });
    sessions.set('normal', { incognito: false, sessionInstanceId: 'inst-n', runtimeEpoch: 'rt-n' });
    const emitter = new TimelineEmitter();
    const privEvent = emitter.emit('private', 'assistant.text', { text: 'priv' });
    const normEvent = emitter.emit('normal', 'assistant.text', { text: 'norm' });
    expect(privEvent?.sessionInstanceId).toBe('inst-p');
    expect(privEvent?.runtimeEpoch).toBe('rt-p');
    expect(privEvent?.epoch).toBe(emitter.epoch);
    expect(normEvent?.sessionInstanceId).toBe('inst-n');
    expect(normEvent?.runtimeEpoch).toBe('rt-n');
    expect(normEvent?.epoch).toBe(emitter.epoch);
  });
});
