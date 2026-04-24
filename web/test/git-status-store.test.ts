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
  settleSharedChangesRequest,
  subscribeSharedChanges,
  getSharedChangesKey,
  __resetSharedChangesForTests,
  SHARED_CHANGES_INFLIGHT_TIMEOUT_MS,
  type ChangeFile,
} from '../src/git-status-store.js';
import type { WsClient, ServerMessage } from '../src/ws-client.js';

function makeFakeWs() {
  const requestIds: string[] = [];
  const handlers = new Set<(msg: ServerMessage) => void>();
  let nextId = 1;
  const ws = {
    fsGitStatus: vi.fn((_path: string, _opts?: { includeStats?: boolean }) => {
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
});
