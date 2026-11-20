/**
 * Regression tests for the shared git-status cache. In particular, the
 * `force=true` path must always fire a fresh WS request even when an
 * earlier request's response never arrived (e.g. WS reconnect, daemon
 * restart, serverLink.send throw) — otherwise the Files→Changes refresh
 * button silently does nothing and users see stale pre-commit state.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  requestSharedChanges,
  requestSharedChangesCount,
  forceRefreshSharedChangesForCheckout,
  settleSharedChangesRequest,
  subscribeSharedChanges,
  subscribeSharedChangesMeta,
  subscribeSharedChangesStatus,
  useSharedGitChangesCount,
  getSharedChangesKey,
  clearSharedChangesCache,
  SHARED_CHANGES_MAX_ENTRIES,
  __resetSharedChangesForTests,
  SHARED_CHANGES_INFLIGHT_TIMEOUT_MS,
  type ChangeFile,
} from '../src/git-status-store.js';
import type { WsClient, ServerMessage } from '../src/ws-client.js';
import { FS_SESSION_ROOT_PATH } from '../../src/shared/transport/fs.js';

function makeFakeWs() {
  const requestIds: string[] = [];
  const handlers = new Set<(msg: ServerMessage) => void>();
  let nextId = 1;
  const ws = {
    fsGitStatus: vi.fn((_path: string, _opts?: { includeStats?: boolean; summaryOnly?: boolean }) => {
      const id = `req-${nextId++}`;
      requestIds.push(id);
      return id;
    }),
    onMessage: vi.fn((h: (msg: ServerMessage) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    }),
  } as unknown as WsClient;
  return { ws, requestIds, emit: (msg: ServerMessage) => { for (const h of handlers) h(msg); } };
}

function filesResponse(requestId: string, files: ChangeFile[]): ServerMessage {
  return { type: 'fs.git_status_response', requestId, status: 'ok', files } as unknown as ServerMessage;
}

describe('git-status-store — refresh resilience', () => {
  beforeEach(() => {
    __resetSharedChangesForTests();
    vi.useRealTimers();
  });

  it('force=true fires a new request even when a prior one never settled', () => {
    const { ws } = makeFakeWs();
    const repo = '/repo/a';

    // First call fires request-1. No response ever comes back (dropped).
    requestSharedChanges(ws, repo, false);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(1);

    // Before the fix: this was silently queued behind the stuck request and
    // the refresh button appeared to do nothing. After the fix: force=true
    // abandons the stuck request and fires a brand-new WS call.
    requestSharedChanges(ws, repo, true);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(2);
  });

  it('skips shared git status refresh without throwing while websocket is disconnected', () => {
    const { ws } = makeFakeWs();
    const repo = '/repo/disconnected';
    vi.mocked(ws.fsGitStatus).mockImplementationOnce(() => {
      throw new Error('WebSocket not connected');
    });

    expect(() => requestSharedChanges(ws, repo, false)).not.toThrow();
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(1);

    requestSharedChanges(ws, repo, false);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(2);
  });

  it('non-force request also breaks through once the in-flight timeout elapses', () => {
    vi.useFakeTimers();
    const { ws } = makeFakeWs();
    const repo = '/repo/b';

    requestSharedChanges(ws, repo, false);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(1);

    // Just before the timeout, a non-force poll still defers to the in-flight
    // request (expected — no signal yet that it's stuck).
    vi.advanceTimersByTime(SHARED_CHANGES_INFLIGHT_TIMEOUT_MS - 1);
    requestSharedChanges(ws, repo, false);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(1);

    // Once we're past the timeout, a non-force request also fires fresh so
    // the periodic 30s poll can self-heal after a dropped response.
    vi.advanceTimersByTime(2);
    requestSharedChanges(ws, repo, false);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(2);
  });

  it('late-arriving response from an abandoned request is dropped, newer in-flight id is preserved', () => {
    const { ws, requestIds, emit } = makeFakeWs();
    const repo = '/repo/c';
    const listener = vi.fn();
    subscribeSharedChanges(getSharedChangesKey(ws, repo), listener);

    requestSharedChanges(ws, repo, false);                // → req-1
    requestSharedChanges(ws, repo, true);                 // force → req-2 (abandons req-1)
    expect(requestIds).toEqual(['req-1', 'req-2']);

    // req-1's response arrives late. It was taken BEFORE the user commit that
    // triggered the force-refresh — that's exactly the stale state we're
    // trying to escape. Dropping it (rather than publishing it only to have
    // req-2 overwrite milliseconds later) avoids a brief flash of the wrong
    // file list.
    emit(filesResponse('req-1', [{ path: '/repo/c/a.txt', code: 'M' }]));
    expect(listener).not.toHaveBeenCalled();

    // req-2 is still in flight — a concurrent non-force request must NOT
    // fire a duplicate.
    requestSharedChanges(ws, repo, false);
    expect(requestIds).toEqual(['req-1', 'req-2']);

    // req-2 arrives and publishes normally.
    emit(filesResponse('req-2', []));
    expect(listener).toHaveBeenCalledWith([]);
  });

  it('fresh response publishes and allows next request to proceed', () => {
    const { ws, emit } = makeFakeWs();
    const repo = '/repo/d';
    const listener = vi.fn();
    subscribeSharedChanges(getSharedChangesKey(ws, repo), listener);

    requestSharedChanges(ws, repo, false);
    emit(filesResponse('req-1', [{ path: '/repo/d/x.ts', code: 'A' }]));
    expect(listener).toHaveBeenCalledWith([{ path: '/repo/d/x.ts', code: 'A' }]);

    // After the response settled, a follow-up force=true should bypass the
    // 5s TTL and fire again (user explicitly asking for fresh data).
    requestSharedChanges(ws, repo, true);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(2);
  });

  it('reports refreshing, success, and error states from real request settlement', () => {
    const { ws, emit } = makeFakeWs();
    const repo = '/repo/status';
    const listener = vi.fn();
    subscribeSharedChangesStatus(getSharedChangesKey(ws, repo), listener);

    requestSharedChanges(ws, repo, true);
    expect(listener).toHaveBeenLastCalledWith('refreshing');

    emit(filesResponse('req-1', []));
    expect(listener).toHaveBeenLastCalledWith('success');

    requestSharedChanges(ws, repo, true);
    expect(listener).toHaveBeenLastCalledWith('refreshing');
    emit({ type: 'fs.git_status_response', requestId: 'req-2', status: 'error', error: 'git failed' } as unknown as ServerMessage);
    expect(listener).toHaveBeenLastCalledWith('error');
    expect(listener.mock.calls.map(([status]) => status)).toEqual([
      'refreshing',
      'success',
      'refreshing',
      'error',
    ]);
  });

  it('reports a disconnected manual refresh as an error', () => {
    const { ws } = makeFakeWs();
    const repo = '/repo/status-disconnected';
    const listener = vi.fn();
    subscribeSharedChangesStatus(getSharedChangesKey(ws, repo), listener);
    vi.mocked(ws.fsGitStatus).mockImplementationOnce(() => {
      throw new Error('WebSocket not connected');
    });

    requestSharedChanges(ws, repo, true);
    expect(listener).toHaveBeenCalledWith('error');
  });

  it('checkout force refresh bypasses TTL once per generation and drops stale in-flight responses', () => {
    const { ws, requestIds, emit } = makeFakeWs();
    const repo = '/repo/e';
    const listener = vi.fn();
    subscribeSharedChanges(getSharedChangesKey(ws, repo), listener);

    requestSharedChanges(ws, repo, false);
    emit(filesResponse('req-1', [{ path: '/repo/e/old.ts', code: 'M' }]));
    expect(listener).toHaveBeenCalledWith([{ path: '/repo/e/old.ts', code: 'M' }]);

    requestSharedChanges(ws, repo, false);
    expect(requestIds).toEqual(['req-1']);

    forceRefreshSharedChangesForCheckout(ws, repo, 2);
    expect(requestIds).toEqual(['req-1', 'req-2']);
    forceRefreshSharedChangesForCheckout(ws, repo, 2);
    expect(requestIds).toEqual(['req-1', 'req-2']);

    forceRefreshSharedChangesForCheckout(ws, repo, 3);
    expect(requestIds).toEqual(['req-1', 'req-2', 'req-3']);
    emit(filesResponse('req-2', [{ path: '/repo/e/stale.ts', code: 'A' }]));
    expect(listener).not.toHaveBeenLastCalledWith([{ path: '/repo/e/stale.ts', code: 'A' }]);
    emit(filesResponse('req-3', []));
    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it('keeps a shared checkout refresh bound to the covered session root', () => {
    const { ws } = makeFakeWs();

    forceRefreshSharedChangesForCheckout(ws, FS_SESSION_ROOT_PATH, 1, 'deck_proj_brain');

    expect(ws.fsGitStatus).toHaveBeenCalledWith(FS_SESSION_ROOT_PATH, {
      includeStats: true,
      sessionName: 'deck_proj_brain',
    });
  });

  it('queues requests made while ws.connected is false and flushes on connected event', () => {
    const { ws, emit } = makeFakeWs();
    Object.defineProperty(ws, 'connected', { value: false, configurable: true, writable: true });
    const listener = vi.fn();
    subscribeSharedChanges(getSharedChangesKey(ws, '/srv/alpha'), listener);

    requestSharedChanges(ws, '/srv/alpha', false);
    expect(ws.fsGitStatus).not.toHaveBeenCalled();

    Object.defineProperty(ws, 'connected', { value: true, configurable: true, writable: true });
    emit({ type: 'session.event', event: 'connected', session: '', state: 'connected' } as unknown as ServerMessage);
    expect(ws.fsGitStatus).toHaveBeenCalledTimes(1);
    expect(ws.fsGitStatus).toHaveBeenCalledWith('/srv/alpha', { includeStats: true });
  });

  it('requestSharedChangesCount sends summaryOnly and isolates meta from full file lists', () => {
    const { ws, emit } = makeFakeWs();
    const fullFiles: ChangeFile[] = [{ path: '/srv/alpha/a.ts', code: 'M', additions: 1, deletions: 0 }];

    // 1. Prime full-list cache
    requestSharedChanges(ws, '/srv/alpha');
    expect(ws.fsGitStatus).toHaveBeenLastCalledWith('/srv/alpha', { includeStats: true });
    emit({
      type: 'fs.git_status_response',
      requestId: 'req-1',
      path: '/srv/alpha',
      resolvedPath: '/srv/alpha',
      status: 'ok',
      files: fullFiles,
      totalCount: 1,
      truncated: false,
    } as ServerMessage);

    const filesListener = vi.fn();
    const metaListener = vi.fn();
    const unsubFiles = subscribeSharedChanges(getSharedChangesKey(ws, '/srv/alpha'), filesListener);
    const unsubMeta = subscribeSharedChangesMeta(getSharedChangesKey(ws, '/srv/alpha'), metaListener);
    expect(filesListener).toHaveBeenCalledWith(fullFiles);
    expect(metaListener).toHaveBeenCalledWith({ totalCount: 1, truncated: false });

    // Unsubscribe list listener (now badge-only), force a summaryOnly count refresh
    unsubFiles();
    requestSharedChangesCount(ws, '/srv/alpha', true);
    expect(ws.fsGitStatus).toHaveBeenLastCalledWith('/srv/alpha', { summaryOnly: true });

    emit({
      type: 'fs.git_status_response',
      requestId: 'req-2',
      path: '/srv/alpha',
      resolvedPath: '/srv/alpha',
      status: 'ok',
      files: [],
      totalCount: 40824,
      truncated: true,
    } as ServerMessage);

    expect(metaListener).toHaveBeenLastCalledWith({ totalCount: 40824, truncated: true });

    // Re-subscribing to full list preserves earlier cached files (was NOT wiped to [])
    const filesListener2 = vi.fn();
    const unsubFiles2 = subscribeSharedChanges(getSharedChangesKey(ws, '/srv/alpha'), filesListener2);
    expect(filesListener2).toHaveBeenCalledWith(fullFiles);

    // Calling requestSharedChangesCount while a list listener IS active upgrades to full list
    requestSharedChangesCount(ws, '/srv/alpha', true);
    expect(ws.fsGitStatus).toHaveBeenLastCalledWith('/srv/alpha', { includeStats: true });

    unsubFiles2();
    unsubMeta();
  });

  it('prevents an in-flight summaryOnly response from clobbering a newer full-list request', () => {
    const { ws, emit } = makeFakeWs();
    const key = getSharedChangesKey(ws, '/srv/alpha');
    const filesListener = vi.fn();
    const metaListener = vi.fn();
    const unsubMeta = subscribeSharedChangesMeta(key, metaListener);

    requestSharedChangesCount(ws, '/srv/alpha', true);
    expect(ws.fsGitStatus).toHaveBeenNthCalledWith(1, '/srv/alpha', { summaryOnly: true });

    const unsubFiles = subscribeSharedChanges(key, filesListener);
    requestSharedChanges(ws, '/srv/alpha');
    expect(ws.fsGitStatus).toHaveBeenNthCalledWith(2, '/srv/alpha', { includeStats: true });

    // Full response arrives first (req-2), then stale summary response arrives (req-1)
    const realFiles: ChangeFile[] = [{ path: '/srv/alpha/b.ts', code: 'M' }];
    emit({
      type: 'fs.git_status_response',
      requestId: 'req-2',
      path: '/srv/alpha',
      resolvedPath: '/srv/alpha',
      status: 'ok',
      files: realFiles,
      totalCount: 1200,
      truncated: true,
    } as ServerMessage);
    emit({
      type: 'fs.git_status_response',
      requestId: 'req-1',
      path: '/srv/alpha',
      resolvedPath: '/srv/alpha',
      status: 'ok',
      files: [],
      totalCount: 999,
      truncated: true,
    } as ServerMessage);

    expect(filesListener).toHaveBeenLastCalledWith(realFiles);
    expect(metaListener).toHaveBeenLastCalledWith({ totalCount: 1200, truncated: true });

    unsubFiles();
    unsubMeta();
  });

  it('falls back to files.length and truncated=false for older daemon responses', () => {
    const { ws, emit } = makeFakeWs();
    const key = getSharedChangesKey(ws, '/srv/alpha');
    const metaListener = vi.fn();
    const unsubMeta = subscribeSharedChangesMeta(key, metaListener);

    requestSharedChanges(ws, '/srv/alpha');
    emit({
      type: 'fs.git_status_response',
      requestId: 'req-1',
      path: '/srv/alpha',
      resolvedPath: '/srv/alpha',
      status: 'ok',
      files: [
        { path: '/srv/alpha/a.ts', code: 'M' },
        { path: '/srv/alpha/b.ts', code: 'A' },
      ],
    } as ServerMessage);

    expect(metaListener).toHaveBeenLastCalledWith({ totalCount: 2, truncated: false });
    unsubMeta();
  });

  it('exposes useSharedGitChangesCount helper', () => {
    expect(typeof useSharedGitChangesCount).toBe('function');
  });

  it('preserves cached files/meta across WsClient instances by serverId, enforces bounded LRU, and clears cleanly', () => {
    const first = makeFakeWs();
    const key1 = getSharedChangesKey(first.ws, '/srv/shared-path', 'srv-1');
    const listener1 = vi.fn();
    const unsub1 = subscribeSharedChanges(key1, listener1);
    requestSharedChanges(first.ws, '/srv/shared-path', false, undefined, 'srv-1');
    first.emit({
      type: 'fs.git_status_response',
      requestId: 'req-1',
      path: '/srv/shared-path',
      resolvedPath: '/srv/shared-path',
      status: 'ok',
      files: [{ path: '/srv/shared-path/a.ts', code: 'M' }],
      totalCount: 1,
      truncated: false,
    } as ServerMessage);
    expect(listener1).toHaveBeenLastCalledWith([{ path: '/srv/shared-path/a.ts', code: 'M' }]);
    unsub1();

    // New WsClient for same serverId + repoPath receives cached list immediately
    const second = makeFakeWs();
    const key1Rebound = getSharedChangesKey(second.ws, '/srv/shared-path', 'srv-1');
    expect(key1Rebound).toBe(key1);
    const listener2 = vi.fn();
    const unsub2 = subscribeSharedChanges(key1Rebound, listener2);
    expect(listener2).toHaveBeenCalledWith([{ path: '/srv/shared-path/a.ts', code: 'M' }]);
    unsub2();

    // Different serverId with identical path is strictly isolated
    const otherServerKey = getSharedChangesKey(second.ws, '/srv/shared-path', 'srv-2');
    expect(otherServerKey).not.toBe(key1);
    const otherListener = vi.fn();
    const unsubOther = subscribeSharedChanges(otherServerKey, otherListener);
    expect(otherListener).not.toHaveBeenCalled();
    unsubOther();

    // Tab-share sessionName scopes are strictly isolated
    const shareAKey = getSharedChangesKey(second.ws, FS_SESSION_ROOT_PATH, 'srv-1', 'sess-a');
    const shareBKey = getSharedChangesKey(second.ws, FS_SESSION_ROOT_PATH, 'srv-1', 'sess-b');
    expect(shareAKey).not.toBe(shareBKey);

    // Bounded LRU eviction beyond SHARED_CHANGES_MAX_ENTRIES (30)
    for (let i = 0; i <= SHARED_CHANGES_MAX_ENTRIES + 2; i++) {
      const repoPath = `/srv/lru-${i}`;
      const k = getSharedChangesKey(second.ws, repoPath, 'srv-lru');
      const unsub = subscribeSharedChanges(k, vi.fn());
      requestSharedChanges(second.ws, repoPath, true, undefined, 'srv-lru');
      second.emit({
        type: 'fs.git_status_response',
        requestId: `req-${i + 1}`,
        path: repoPath,
        resolvedPath: repoPath,
        status: 'ok',
        files: [{ path: `${repoPath}/f.ts`, code: 'A' }],
        totalCount: 1,
        truncated: false,
      } as ServerMessage);
      unsub();
    }
    const oldestEvicted = vi.fn();
    const unsubOldest = subscribeSharedChanges(getSharedChangesKey(second.ws, '/srv/lru-0', 'srv-lru'), oldestEvicted);
    expect(oldestEvicted).not.toHaveBeenCalled();
    unsubOldest();

    const newestRetained = vi.fn();
    const unsubNewest = subscribeSharedChanges(
      getSharedChangesKey(second.ws, `/srv/lru-${SHARED_CHANGES_MAX_ENTRIES + 2}`, 'srv-lru'),
      newestRetained,
    );
    expect(newestRetained).toHaveBeenCalledTimes(1);
    unsubNewest();

    // clearSharedChangesCache wipes all cached entries
    clearSharedChangesCache();
    const afterClear = vi.fn();
    const unsubAfterClear = subscribeSharedChanges(
      getSharedChangesKey(second.ws, `/srv/lru-${SHARED_CHANGES_MAX_ENTRIES + 2}`, 'srv-lru'),
      afterClear,
    );
    expect(afterClear).not.toHaveBeenCalled();
    unsubAfterClear();
  });
});
