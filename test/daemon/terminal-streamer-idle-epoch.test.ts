import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/agent/tmux.js', () => ({
  BACKEND: 'tmux',
  capturePaneVisible: vi.fn().mockResolvedValue('a\nb\nc\nd'),
  capturePaneHistory: vi.fn().mockResolvedValue(''),
  getPaneId: vi.fn().mockResolvedValue('%1'),
  getPaneIdentity: vi.fn().mockResolvedValue(undefined),
  getPaneSize: vi.fn().mockResolvedValue({ cols: 80, rows: 24 }),
  paneExists: vi.fn().mockResolvedValue(true),
  sessionExists: vi.fn().mockResolvedValue(true),
  startPipePaneStream: vi.fn(),
  stopPipePaneStream: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/store/session-store.js', () => {
  const sessions = new Map<string, any>();
  return {
    getSession: vi.fn((name: string) => sessions.get(name) ?? null),
    listSessions: vi.fn(() => [...sessions.values()]),
    upsertSession: vi.fn((rec: any) => { sessions.set(rec.name, rec); }),
  };
});

vi.mock('../../src/daemon/codex-watcher.js', () => ({
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/daemon/jsonl-watcher.js', () => ({
  isWatching: vi.fn().mockReturnValue(false),
}));

import { startPipePaneStream } from '../../src/agent/tmux.js';
import { getSession, upsertSession } from '../../src/store/session-store.js';
import { TerminalStreamer } from '../../src/daemon/terminal-streamer.js';
import { timelineEmitter } from '../../src/daemon/timeline-emitter.js';
import { readTimelineEventActivityEpoch } from '../../src/daemon/shared-machine-authority-context.js';
import {
  bindProcessSharedMachineActivity,
  clearProcessSharedMachineAuthoritiesForTests,
  readActiveTreeAuthorityForSession,
  readProcessSharedMachineActivityEpoch,
  releaseProcessSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';
import { SHARED_MACHINE_ACTIVITY_KIND } from '../../shared/shared-machine-authority.js';

describe('TerminalStreamer — empty-window null epoch and newer window isolation', () => {
  let streamer: TerminalStreamer;
  let dataHandler: ((chunk: Buffer) => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    clearProcessSharedMachineAuthoritiesForTests();
    dataHandler = undefined;
    const mockStream = {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') dataHandler = cb;
      }),
      destroy: vi.fn(),
    };
    vi.mocked(startPipePaneStream).mockReset().mockResolvedValue({
      stream: mockStream as any,
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    upsertSession({
      name: 'deck_term_epoch',
      projectName: 'term',
      role: 'brain',
      agentType: 'shell',
      runtimeType: 'process',
      paneId: '%1',
      state: 'running',
      sessionInstanceId: 'inst-term',
      runtimeEpoch: 'epoch-term',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
    streamer = new TerminalStreamer();
  });

  afterEach(() => {
    streamer.destroy();
    clearProcessSharedMachineAuthoritiesForTests();
    vi.useRealTimers();
  });

  it('drops stale null-epoch idle timer when a new participant window binds before timeout', async () => {
    const emittedStates: Array<{ state?: unknown; epoch?: number | null }> = [];
    const unsub = timelineEmitter.on((e) => {
      if (e.sessionId === 'deck_term_epoch' && e.type === 'session.state') {
        emittedStates.push({
          state: (e.payload as { state?: unknown }).state,
          epoch: readTimelineEventActivityEpoch(e),
        });
      }
    });

    try {
      streamer.subscribe({ sessionName: 'deck_term_epoch', send: vi.fn() });
      await vi.advanceTimersByTimeAsync(200);
      expect(dataHandler).toBeDefined();

      // Raw data triggers resetIdleTimer while NO process window exists (`capturedEpoch = null`).
      expect(readProcessSharedMachineActivityEpoch('deck_term_epoch')).toBeNull();
      dataHandler!(Buffer.from('prompt> '));

      // Before IDLE_THRESHOLD_MS (3s) elapses, participant P1 binds a new process window (`epoch > 0`).
      bindProcessSharedMachineActivity(
        'deck_term_epoch',
        { sessionInstanceId: 'inst-term', runtimeEpoch: 'epoch-term' },
        {
          kind: SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT,
          actorUserId: 'user-p1',
          authority: 'trg_term_new_turn_1111111111111',
        },
        { now: Date.now(), sessionRunning: true },
      ).typed(Date.now());
      const activeEpoch = readProcessSharedMachineActivityEpoch('deck_term_epoch');
      expect(typeof activeEpoch).toBe('number');

      // Advance past IDLE_THRESHOLD_MS (5s): the stale null-epoch timer MUST NOT emit idle or overwrite session state!
      await vi.advanceTimersByTimeAsync(6_000);
      expect(emittedStates.some((entry) => entry.state === 'idle')).toBe(false);
      expect(getSession('deck_term_epoch')?.state).toBe('running');
      expect(readProcessSharedMachineActivityEpoch('deck_term_epoch')).toBe(activeEpoch);
      expect(readActiveTreeAuthorityForSession('deck_term_epoch')?.authority).toBe('trg_term_new_turn_1111111111111');

      // Even if a release with explicit `expectedActivityEpoch: null` reaches lifecycle directly, it cannot settle the active window!
      releaseProcessSharedMachineAuthority('deck_term_epoch', { expectedActivityEpoch: null });
      expect(readActiveTreeAuthorityForSession('deck_term_epoch')?.authority).toBe('trg_term_new_turn_1111111111111');
      expect(readProcessSharedMachineActivityEpoch('deck_term_epoch')).toBe(activeEpoch);
    } finally {
      unsub();
    }
  });

  it('tags explicit null activityEpoch when timer completes cleanly without any newer window', async () => {
    const emitted: Array<{ state?: unknown; epoch?: number | null }> = [];
    const unsub = timelineEmitter.on((e) => {
      if (e.sessionId === 'deck_term_epoch' && e.type === 'session.state') {
        emitted.push({
          state: (e.payload as { state?: unknown }).state,
          epoch: readTimelineEventActivityEpoch(e),
        });
      }
    });

    try {
      streamer.subscribe({ sessionName: 'deck_term_epoch', send: vi.fn() });
      await vi.advanceTimersByTimeAsync(200);
      expect(readProcessSharedMachineActivityEpoch('deck_term_epoch')).toBeNull();
      dataHandler!(Buffer.from('done\n'));
      await vi.advanceTimersByTimeAsync(6_000);

      expect(emitted).toContainEqual({ state: 'idle', epoch: null });
    } finally {
      unsub();
    }
  });
});
