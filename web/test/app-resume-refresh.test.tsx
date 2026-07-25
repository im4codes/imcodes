/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.hoisted(() => vi.fn());
const fetchTextTailSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({
  fetchTimelineHistoryHttp: fetchSpy,
  fetchTimelineTextTailHttp: fetchTextTailSpy,
}));

import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import type { WsClient } from '../src/ws-client.js';
import { installNativeAppResumeRefresh } from '../src/app-resume-refresh.js';
import {
  __resetTimelineCacheForTests,
  ingestTimelineEventForCache,
  useTimeline,
} from '../src/hooks/useTimeline.js';

describe('native app resume refresh chain', () => {
  beforeEach(() => {
    __resetTimelineCacheForTests();
    cleanup();
    fetchSpy.mockReset();
    fetchTextTailSpy.mockReset();
    fetchTextTailSpy.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('appStateChange -> active timeline refresh -> HTTP backfill fires for the mounted session', async () => {
    const sessionName = `deck_resume_chain_${Date.now()}`;
    const serverId = `srv-${Date.now()}`;
    const reconnectNow = vi.fn();
    const removeSpy = vi.fn();
    let appStateListener: ((state: { isActive: boolean }) => void) | null = null;

    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });

    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineHistoryRequest: vi.fn(() => 'history-resume-chain'),
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, String(events.length));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(h(Probe));

    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });

    // Consume the mount-time backfill so the assertion below only counts
    // the native resume path.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fetchSpy.mockClear();

    const removeListener = await installNativeAppResumeRefresh(
      true,
      reconnectNow,
      {
        addListener: async (_eventName, listener) => {
          appStateListener = listener;
          return { remove: removeSpy };
        },
      },
    );

    expect(appStateListener).not.toBeNull();

    await act(async () => {
      appStateListener?.({ isActive: true });
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(reconnectNow).toHaveBeenCalledWith(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Resume MUST drop the lower bound. While the app was backgrounded it had no
    // session subscription, so the server discarded its timeline events outright
    // (no queue, no replay). Those events sit BELOW the local tail, so the old
    // `afterTs: <localTail>` request could never reach them — that is exactly the
    // "notification arrived but the chat is empty until I press ↻" bug. This test
    // asserts the resume chain fires; the cursor value it used to pin was just
    // whatever the tail-anchored implementation produced.
    expect(fetchSpy).toHaveBeenCalledWith(
      serverId,
      sessionName,
      expect.objectContaining({ afterTs: undefined }),
    );

    removeListener();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('native resume still refreshes after the timeline remounts in the same resume window', async () => {
    const sessionName = `deck_resume_remount_${Date.now()}`;
    const serverId = `srv-remount-${Date.now()}`;
    const reconnectNow = vi.fn();
    let appStateListener: ((state: { isActive: boolean }) => void) | null = null;

    fetchSpy.mockResolvedValue({ events: [], epoch: 1, hasMore: false, nextCursor: null });

    ingestTimelineEventForCache({
      eventId: `${sessionName}-seed`,
      sessionId: sessionName,
      ts: 1000,
      epoch: 1,
      seq: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: 'seed' },
    }, serverId);

    const ws: WsClient = {
      connected: true,
      onMessage: () => () => {},
      sendTimelineHistoryRequest: vi.fn(() => 'history-resume-remount'),
    } as unknown as WsClient;

    function Probe() {
      const { events } = useTimeline(sessionName, ws, serverId);
      return h('div', { 'data-testid': 'probe' }, String(events.length));
    }

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    first.unmount();
    fetchSpy.mockClear();

    await installNativeAppResumeRefresh(
      true,
      reconnectNow,
      {
        addListener: async (_eventName, listener) => {
          appStateListener = listener;
          return { remove: vi.fn() };
        },
      },
    );

    await act(async () => {
      appStateListener?.({ isActive: true });
    });

    render(h(Probe));
    await waitFor(() => {
      expect(screen.getByTestId('probe').textContent).toBe('1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(reconnectNow).toHaveBeenCalledWith(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Same contract as above: a resume backfill carries no lower bound.
    expect(fetchSpy).toHaveBeenCalledWith(
      serverId,
      sessionName,
      expect.objectContaining({ afterTs: undefined }),
    );
  });
});
