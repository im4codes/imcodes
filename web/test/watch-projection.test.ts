import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWatchProjectionStore, type WatchApplicationContext } from '../src/watch-projection.js';

function makeSnapshotStore(now = 1_000) {
  const pushes: WatchApplicationContext[] = [];
  const durableEvents: unknown[] = [];
  const store = createWatchProjectionStore({
    now: () => now,
    syncSnapshot: async (snapshot) => {
      pushes.push(snapshot);
    },
    pushDurableEvent: async (event) => {
      durableEvents.push(event);
    },
  });
  return { store, pushes, durableEvents, setNow: (next: number) => { now = next; } };
}

describe('watch projection store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a versioned snapshot with servers, sub-sessions, badges, and sorted session rows', async () => {
    const { store } = makeSnapshotStore(1_000);
    store.setApiKey('watch-key');
    store.setServers([
      { id: 'srv-2', name: 'Other', baseUrl: 'https://other.test' },
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
    ]);

    store.updateFromSessionList(
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      [
        { name: 'deck_proj_idle', project: 'Project', role: 'brain', agentType: 'claude-code', state: 'idle' },
        { name: 'deck_proj_working', project: 'Project', role: 'brain', agentType: 'codex', state: 'running' },
        { name: 'deck_proj_error', project: 'Project', role: 'brain', agentType: 'opencode', state: 'error' },
        { name: 'deck_proj_stopped', project: 'Project', role: 'brain', agentType: 'shell', state: 'stopped' },
        { name: 'deck_sub_alpha', project: 'Project', role: 'w1', agentType: 'gemini', state: 'running', label: 'Alpha', parentSession: 'deck_proj_working' },
      ],
    );

    const snapshot = store.getSnapshot();
    expect(snapshot).toMatchObject({
      v: 1,
      snapshotStatus: 'fresh',
      currentServerId: 'srv-1',
      apiKey: 'watch-key',
      servers: [
        { id: 'srv-2', name: 'Other', baseUrl: 'https://other.test' },
        { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      ],
    });
    expect(snapshot.sessions.map((row) => row.sessionName)).toEqual([
      'deck_sub_alpha',
      'deck_proj_working',
      'deck_proj_idle',
      'deck_proj_error',
      'deck_proj_stopped',
    ]);
    expect(snapshot.sessions.find((row) => row.sessionName === 'deck_sub_alpha')).toMatchObject({
      serverId: 'srv-1',
      title: 'Alpha',
      state: 'working',
      agentBadge: 'gm',
      isSubSession: true,
      parentTitle: 'Project',
    });
  });

  it('keeps auth/routing fields explicit even when apiKey is unavailable', () => {
    const { store } = makeSnapshotStore(1_500);
    store.setApiKey(null);
    store.setServers([{ id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' }]);
    store.setCurrentServerId('srv-1');
    store.updateFromSessionList(
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      [{ name: 'deck_proj_brain', project: 'Project', role: 'brain', agentType: 'claude-code', state: 'idle' }],
    );

    expect(store.getSnapshot()).toMatchObject({
      currentServerId: 'srv-1',
      apiKey: null,
      servers: [{ id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' }],
    });
  });

  it('debounces semantic snapshot pushes and skips identical projections', async () => {
    const { store, pushes } = makeSnapshotStore(2_000);
    store.updateFromSessionList(
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      [
        { name: 'deck_proj_brain', project: 'Project', role: 'brain', agentType: 'claude-code', state: 'running' },
      ],
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushes).toHaveLength(1);

    store.updateFromSessionList(
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      [
        { name: 'deck_proj_brain', project: 'Project', role: 'brain', agentType: 'claude-code', state: 'running' },
      ],
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushes).toHaveLength(1);

    store.updateSessionState('deck_proj_brain', 'idle');
    await vi.advanceTimersByTimeAsync(400);
    store.updateSessionState('deck_proj_brain', 'working');
    await vi.advanceTimersByTimeAsync(400);
    store.updateSessionState('deck_proj_brain', 'error');
    await vi.advanceTimersByTimeAsync(999);
    expect(pushes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pushes).toHaveLength(2);
    expect(pushes.at(-1)?.sessions[0]?.state).toBe('error');
  });

  it('tracks assistant text, derives preview text on idle, and keeps the previous preview when text is noisy or short', async () => {
    const { store } = makeSnapshotStore(3_000);
    store.updateFromSessionList(
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      [
        { name: 'deck_proj_brain', project: 'Project', role: 'brain', agentType: 'claude-code', state: 'running' },
      ],
    );

    store.trackAssistantText('deck_proj_brain', 'Completed refactoring src/api.ts and added tests');
    store.onSessionIdle('deck_proj_brain', 3_111);

    const first = store.getSnapshot().sessions[0];
    expect(first).toMatchObject({
      previewText: 'Completed refactoring src/api.ts and added tests',
      previewUpdatedAt: 3_111,
      state: 'idle',
    });

    const longText = `This is a very long preview sentence that should be truncated to one hundred and twenty characters exactly for the watch display because the watch cannot show a wall of text.`;
    store.trackAssistantText('deck_proj_brain', longText);
    store.onSessionIdle('deck_proj_brain', 3_222);
    const second = store.getSnapshot().sessions[0];
    expect(second.previewText).toHaveLength(120);
    expect(second.previewUpdatedAt).toBe(3_222);

    store.trackAssistantText('deck_proj_brain', 'Let me check that for you');
    store.onSessionIdle('deck_proj_brain', 3_333);
    const third = store.getSnapshot().sessions[0];
    expect(third.previewText).toHaveLength(120);
    expect(third.previewUpdatedAt).toBe(3_222);

    store.trackAssistantText('deck_proj_brain', 'OK');
    store.onSessionIdle('deck_proj_brain', 3_444);
    const fourth = store.getSnapshot().sessions[0];
    expect(fourth.previewText).toHaveLength(120);
    expect(fourth.previewUpdatedAt).toBe(3_222);
  });

  it('switches status correctly and leaves session.error as a durable-event-only path', async () => {
    const { store, pushes, durableEvents } = makeSnapshotStore(4_000);
    store.updateFromSessionList(
      { id: 'srv-1', name: 'Main', baseUrl: 'https://main.test' },
      [
        { name: 'deck_proj_brain', project: 'Project', role: 'brain', agentType: 'claude-code', state: 'running' },
      ],
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pushes).toHaveLength(1);

    store.setSnapshotStatus('stale');
    expect(store.getSnapshot().snapshotStatus).toBe('stale');
    expect(store.getSnapshot().sessions).toHaveLength(1);

    store.setSnapshotStatus('switching');
    expect(store.getSnapshot().snapshotStatus).toBe('switching');
    expect(store.getSnapshot().sessions).toHaveLength(0);

    const before = store.getSnapshot();
    await store.pushDurableEvent({ type: 'session.error', project: 'Project', message: 'boom' });
    expect(durableEvents).toEqual([{ type: 'session.error', project: 'Project', message: 'boom' }]);
    const after = store.getSnapshot();
    const { generatedAt: beforeGeneratedAt, ...beforeRest } = before;
    const { generatedAt: afterGeneratedAt, ...afterRest } = after;
    expect(afterGeneratedAt).not.toBe(beforeGeneratedAt);
    expect(afterRest).toEqual(beforeRest);
  });
});
