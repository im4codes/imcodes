/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/api.js', () => ({ fetchTimelineHistoryHttp: fetchSpy }));

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
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(reconnectNow).toHaveBeenCalledWith(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      serverId,
      sessionName,
      expect.objectContaining({ afterTs: 1000 }),
    );

    removeListener();
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
