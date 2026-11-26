/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { render, cleanup, act, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RESOURCE_EVENT_MSG, RESOURCE_TOPICS } from '@shared/resource-events.js';
import type { WsClient } from '../src/ws-client.js';
import {
  CRON_SCOPE_CHANGE_EVENT,
  CRON_SHOW_ALL_STORAGE_KEY,
  buildCronListUrl,
  useCronJobCount,
} from '../src/hooks/useCronJobCount.js';

const apiFetch = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function makeMockWs() {
  const listeners = new Set<(msg: any) => void>();
  const ws = {
    onMessage: (fn: (msg: any) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (msg: any) => {
      for (const fn of [...listeners]) fn(msg);
    },
  };
  return ws as unknown as WsClient & { emit: (msg: any) => void };
}

function Probe(props: Parameters<typeof useCronJobCount>[0]) {
  const count = useCronJobCount(props);
  return <span data-testid="cron-count">{count}</span>;
}

describe('buildCronListUrl', () => {
  it('matches CronManager scoping across server, project, showAllServers, and shared session scopes', () => {
    expect(buildCronListUrl({ serverId: null, projectName: 'cd' })).toBeNull();
    expect(buildCronListUrl({ serverId: 'srv-1', projectName: null })).toBeNull();
    expect(buildCronListUrl({ serverId: 'srv-1', projectName: 'cd' })).toBe('/api/cron?serverId=srv-1&projectName=cd');
    expect(buildCronListUrl({ serverId: 'srv-1', projectName: 'cd', showAllServers: true })).toBe('/api/cron?');
    expect(buildCronListUrl({ serverId: 'srv-1', projectName: null, showAllServers: true })).toBe('/api/cron?');
    expect(buildCronListUrl({
      serverId: 'srv-1',
      projectName: 'cd',
      sharedScope: true,
      showAllServers: true,
    })).toBe('/api/cron?serverId=srv-1');
    expect(buildCronListUrl({
      serverId: 'srv-1',
      projectName: 'cd',
      sharedSessionName: 'deck_cd_brain',
      sharedScope: true,
      showAllServers: true,
    })).toBe('/api/cron?serverId=srv-1&projectName=cd&sessionName=deck_cd_brain');
  });
});

describe('useCronJobCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const store: Record<string, string> = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() { return Object.keys(store).length; },
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('skips fetching when unauthenticated/disabled or missing serverId', () => {
    const view = render(<Probe enabled={false} serverId="srv-1" projectName="cd" ws={null} connected />);
    expect(view.getByTestId('cron-count').textContent).toBe('0');
    expect(apiFetch).not.toHaveBeenCalled();

    view.rerender(<Probe enabled serverId={null} projectName="cd" ws={null} connected />);
    expect(view.getByTestId('cron-count').textContent).toBe('0');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('loads scoped cron count, updates live on RESOURCE_TOPICS.cron, and ignores background errors', async () => {
    const ws = makeMockWs();
    apiFetch
      .mockResolvedValueOnce({ jobs: [{ id: '1' }, { id: '2' }, { id: '3' }] })
      .mockResolvedValueOnce({ jobs: [{ id: '1' }, { id: '2' }, { id: '3' }, { id: '4' }, { id: '5' }] })
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ jobs: [] });

    const view = render(<Probe enabled serverId="srv-1" projectName="cd" ws={ws} connected />);
    await waitFor(() => expect(view.getByTestId('cron-count').textContent).toBe('3'));
    expect(apiFetch).toHaveBeenCalledWith('/api/cron?serverId=srv-1&projectName=cd');

    act(() => {
      ws.emit({ type: RESOURCE_EVENT_MSG.CHANGED, topic: RESOURCE_TOPICS.cron });
    });
    await waitFor(() => expect(view.getByTestId('cron-count').textContent).toBe('5'));

    // Background failure must fail silently without zeroing out or throwing
    act(() => {
      ws.emit({ type: RESOURCE_EVENT_MSG.CHANGED, topic: RESOURCE_TOPICS.cron });
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(view.getByTestId('cron-count').textContent).toBe('5');

    // Subsequent update settles to 0
    act(() => {
      ws.emit({ type: RESOURCE_EVENT_MSG.CHANGED, topic: RESOURCE_TOPICS.cron });
    });
    await waitFor(() => expect(view.getByTestId('cron-count').textContent).toBe('0'));
  });

  it('tracks rcc_cron_show_all changes, reconnects, and ignores stale in-flight responses on server switch', async () => {
    const ws = makeMockWs();
    let resolveSlowSrv1!: (v: { jobs: unknown[] }) => void;
    apiFetch
      .mockImplementationOnce(() => new Promise((r) => { resolveSlowSrv1 = r; }))
      .mockResolvedValueOnce({ jobs: [{ id: 's2-1' }] })
      .mockResolvedValueOnce({ jobs: [{ id: 'all-1' }, { id: 'all-2' }] })
      .mockResolvedValueOnce({ jobs: [{ id: 'all-1' }, { id: 'all-2' }, { id: 'all-3' }] });

    const view = render(<Probe enabled serverId="srv-1" projectName="cd" ws={ws} connected={false} />);
    expect(apiFetch).toHaveBeenCalledWith('/api/cron?serverId=srv-1&projectName=cd');

    // Switch to srv-2 before srv-1 resolves
    view.rerender(<Probe enabled serverId="srv-2" projectName="proj2" ws={ws} connected={false} />);
    await waitFor(() => expect(view.getByTestId('cron-count').textContent).toBe('1'));

    // Late srv-1 completion must be discarded
    await act(async () => {
      resolveSlowSrv1({ jobs: Array.from({ length: 9 }, (_, i) => ({ id: String(i) })) });
    });
    expect(view.getByTestId('cron-count').textContent).toBe('1');

    // Toggle showAllServers in localStorage + custom scope event
    act(() => {
      localStorage.setItem(CRON_SHOW_ALL_STORAGE_KEY, '1');
      window.dispatchEvent(new Event(CRON_SCOPE_CHANGE_EVENT));
    });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/cron?'));
    await waitFor(() => expect(view.getByTestId('cron-count').textContent).toBe('2'));

    // WS reconnect triggers silent refresh
    view.rerender(<Probe enabled serverId="srv-2" projectName="proj2" ws={ws} connected={true} />);
    await waitFor(() => expect(view.getByTestId('cron-count').textContent).toBe('3'));
  });
});
