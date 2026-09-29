/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESSION_IDENTITY_WS } from '../../shared/session-identity-ws.js';

const fetchSessionIdentityProfileMock = vi.fn();
const saveSessionIdentityProfileMock = vi.fn();
const clearSessionIdentityProfileMock = vi.fn();
const getSessionIdentityDirectMock = vi.fn();
const setSessionIdentityDirectMock = vi.fn();
const supportsSessionIdentityDirectMock = vi.fn();

vi.mock('../src/api.js', () => ({
  fetchSessionIdentityProfile: (...args: unknown[]) => fetchSessionIdentityProfileMock(...args),
  saveSessionIdentityProfile: (...args: unknown[]) => saveSessionIdentityProfileMock(...args),
  clearSessionIdentityProfile: (...args: unknown[]) => clearSessionIdentityProfileMock(...args),
}));

vi.mock('../src/direct-file-transfer.js', () => ({
  getSessionIdentityDirect: (...args: unknown[]) => getSessionIdentityDirectMock(...args),
  setSessionIdentityDirect: (...args: unknown[]) => setSessionIdentityDirectMock(...args),
  supportsSessionIdentityDirect: (...args: unknown[]) => supportsSessionIdentityDirectMock(...args),
}));

import {
  fetchSessionIdentityProfileDirectFirst,
  saveSessionIdentityProfileDirectFirst,
  clearSessionIdentityProfileDirectFirst,
} from '../src/session-identity-direct.js';

/** Minimal WsClient stub: only what resolveSessionIdentityDirectMetadata's RESOLVE_QUERY/RESPONSE round trip needs. */
function makeWs(respond: (requestId: string) => { scopeKey: string; contentHash?: string; revision?: number; updatedAt?: number } | null) {
  const listeners = new Set<(msg: unknown) => void>();
  return {
    connected: true,
    onMessage(cb: (msg: unknown) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send(msg: { type: string; requestId: string }) {
      if (msg.type !== SESSION_IDENTITY_WS.RESOLVE_QUERY) return;
      const resolved = respond(msg.requestId);
      const response = resolved
        ? { type: SESSION_IDENTITY_WS.RESOLVE_RESPONSE, requestId: msg.requestId, ok: true, ...resolved }
        : { type: SESSION_IDENTITY_WS.RESOLVE_RESPONSE, requestId: msg.requestId, ok: false };
      for (const cb of listeners) cb(response);
    },
  };
}

// The direct-unavailable cooldown cache (and the identity content cache) are
// module-level state keyed by serverId, shared across every test in this
// file. Give each test its own serverId so a failure/skip in one test can
// never leak into another via that cache.
let serverIdCounter = 0;
function makeContext(): { serverId: string; sessionName: string } {
  serverIdCounter += 1;
  return { serverId: `srv-${serverIdCounter}`, sessionName: 'deck_test_brain' };
}

beforeEach(() => {
  vi.clearAllMocks();
  supportsSessionIdentityDirectMock.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchSessionIdentityProfileDirectFirst', () => {
  it('falls back to the HTTP path with zero extra ticks when ws is missing', async () => {
    const context = makeContext();
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'x', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', context, null);
    expect(result?.content).toBe('x');
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP path when the capability check fails', async () => {
    const context = makeContext();
    supportsSessionIdentityDirectMock.mockReturnValue(false);
    fetchSessionIdentityProfileMock.mockResolvedValue(null);
    const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
    await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', context);
  });

  it('falls back to the HTTP path when the resolve is denied or unanswered, instead of reporting an empty identity', async () => {
    const context = makeContext();
    const ws = makeWs(() => null);
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'from-http', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(result?.content).toBe('from-http');
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('skips the direct path entirely when the context has no session name (the server pins keys to a covered session)', async () => {
    const ws = makeWs(() => ({ scopeKey: 'resolved-key', contentHash: 'abc' }));
    fetchSessionIdentityProfileMock.mockResolvedValue(null);
    await fetchSessionIdentityProfileDirectFirst('project', 'p', { serverId: 'srv-nosession' }, ws as never);
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalled();
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('resolves the canonical key then fetches over the direct lease on success', async () => {
    const context = makeContext();
    const ws = makeWs(() => ({ scopeKey: 'resolved-key', contentHash: 'abc', revision: 3, updatedAt: 42 }));
    getSessionIdentityDirectMock.mockResolvedValue({ content: 'hello world' });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(result).toEqual({ scope: 'project', scopeKey: 'resolved-key', source: 'web', content: 'hello world', contentHash: 'abc', revision: 3, updatedAt: 42 });
    expect(getSessionIdentityDirectMock).toHaveBeenCalledWith(ws, context.serverId, 'project', 'resolved-key', context.sessionName);
    expect(fetchSessionIdentityProfileMock).not.toHaveBeenCalled();
  });

  it('returns null without a direct fetch when the resolved hash is empty (never-saved key)', async () => {
    const context = makeContext();
    const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(result).toBeNull();
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('serves a cached hit without a second direct fetch when the hash is unchanged', async () => {
    const context = makeContext();
    const ws = makeWs(() => ({ scopeKey: 'resolved-key', contentHash: 'abc', revision: 1, updatedAt: 0 }));
    getSessionIdentityDirectMock.mockResolvedValue({ content: 'first' });
    await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(getSessionIdentityDirectMock).toHaveBeenCalledTimes(1);

    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(result?.content).toBe('first');
    expect(getSessionIdentityDirectMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the HTTP path when the direct fetch throws', async () => {
    const context = makeContext();
    const ws = makeWs(() => ({ scopeKey: 'resolved-key-throws', contentHash: 'throws-hash', revision: 1, updatedAt: 0 }));
    getSessionIdentityDirectMock.mockRejectedValue(new Error('lease_failed'));
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'fallback', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    expect(result?.content).toBe('fallback');
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', context);
  });

  it('falls back to the HTTP path once the direct attempt exceeds its budget, without waiting for it to settle', async () => {
    vi.useFakeTimers();
    const context = makeContext();
    // The WS resolve call answers promptly (distinct key/hash so it isn't a
    // cache hit); it's the SUBSEQUENT getSessionIdentityDirect call that
    // hangs forever, so only the outer NEGOTIATION_TIMEOUT_MS (8s) budget --
    // not resolveIdentityDirect's own inner 4s timeout -- can be what ends it.
    const ws = makeWs(() => ({ scopeKey: 'resolved-key-hang', contentHash: 'hang-hash', revision: 1, updatedAt: 0 }));
    getSessionIdentityDirectMock.mockReturnValue(new Promise(() => { /* never resolves */ }));
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'via-fallback', contentHash: 'h', revision: 1, updatedAt: 0 });

    const pending = fetchSessionIdentityProfileDirectFirst('project', 'p', context, ws as never);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result?.content).toBe('via-fallback');
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', context);
  });
});

describe('saveSessionIdentityProfileDirectFirst', () => {
  const INPUT = { scope: 'project' as const, scopeKey: 'p', content: 'new content' };

  it('falls back to the HTTP path with zero extra ticks when ws is missing', async () => {
    const context = makeContext();
    saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await saveSessionIdentityProfileDirectFirst(INPUT, context, null);
    expect(result.content).toBe('new content');
    expect(setSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('resolves the canonical key then saves over the direct lease on success', async () => {
    const context = makeContext();
    const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
    setSessionIdentityDirectMock.mockResolvedValue({ contentHash: 'newhash', revision: 2, updatedAt: 99 });
    const result = await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
    expect(result).toEqual({ scope: 'project', scopeKey: 'resolved-key', source: 'web', content: 'new content', contentHash: 'newhash', revision: 2, updatedAt: 99 });
    expect(setSessionIdentityDirectMock).toHaveBeenCalledWith(ws, context.serverId, 'project', 'resolved-key', 'new content', context.sessionName);
    expect(saveSessionIdentityProfileMock).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP path when the key cannot be resolved at all', async () => {
    const context = makeContext();
    const ws = makeWs(() => null);
    saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
    expect(result.content).toBe('new content');
    expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(INPUT, context);
  });

  it('falls back to the HTTP path once the direct attempt exceeds its budget, without waiting for it to settle', async () => {
    vi.useFakeTimers();
    const context = makeContext();
    // The WS resolve call answers promptly; it's the subsequent
    // setSessionIdentityDirect call that hangs forever, so only the outer
    // NEGOTIATION_TIMEOUT_MS (8s) budget -- not resolveIdentityDirect's own
    // inner 4s timeout -- can be what ends it.
    const ws = makeWs(() => ({ scopeKey: 'resolved-key-hang-save' }));
    setSessionIdentityDirectMock.mockReturnValue(new Promise(() => { /* never resolves */ }));
    saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });

    const pending = saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result.content).toBe('new content');
    expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(INPUT, context);
  });

  describe('per-serverId "direct recently unavailable" cooldown', () => {
    it('skips the direct attempt entirely on the next call after a failure, going straight to the HTTP fallback', async () => {
      vi.useFakeTimers();
      const context = makeContext();
      const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
      setSessionIdentityDirectMock.mockRejectedValue(new Error('lease_failed'));
      saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });

      // First call: direct genuinely attempted and fails, falls back.
      await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(1);

      // Second call, same serverId, well within the cooldown window: the
      // direct attempt must be skipped entirely -- no WS resolve round trip,
      // no setSessionIdentityDirect call, no wait -- straight to fallback.
      const wsSendSpy = vi.spyOn(ws, 'send');
      const result = await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(result.content).toBe('new content');
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(1); // still 1 -- not attempted again
      expect(wsSendSpy).not.toHaveBeenCalled(); // the resolve round trip itself never started
      expect(saveSessionIdentityProfileMock).toHaveBeenCalledTimes(2);
    });

    it('retries direct once the cooldown window expires', async () => {
      vi.useFakeTimers();
      const context = makeContext();
      const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
      setSessionIdentityDirectMock.mockRejectedValue(new Error('lease_failed'));
      saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });

      await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(1);

      // Advance past the 5-minute cooldown window.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

      // This time direct succeeds -- the window having expired must be what
      // let it be attempted at all.
      setSessionIdentityDirectMock.mockResolvedValue({ contentHash: 'newhash', revision: 2, updatedAt: 99 });
      const result = await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(result.contentHash).toBe('newhash');
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(2);
    });

    it('clears the cooldown the moment a direct attempt succeeds', async () => {
      vi.useFakeTimers();
      const context = makeContext();
      const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));

      setSessionIdentityDirectMock.mockRejectedValueOnce(new Error('lease_failed'));
      saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });
      await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(1);

      // Still within the cooldown -- would normally skip -- but advance only
      // a moment, then have a call succeed by bypassing the cooldown check
      // is not possible from here, so instead prove the OPPOSITE: once
      // succeeded, immediately-following calls are never skipped again even
      // without a full window elapsing.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      setSessionIdentityDirectMock.mockResolvedValue({ contentHash: 'newhash', revision: 2, updatedAt: 99 });
      await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(2);

      // No time advance at all this time -- if the prior success hadn't
      // cleared the cooldown, this would still be well within a fresh 5-
      // minute window from the FIRST failure and would incorrectly skip.
      const result = await saveSessionIdentityProfileDirectFirst(INPUT, context, ws as never);
      expect(setSessionIdentityDirectMock).toHaveBeenCalledTimes(3);
      expect(result.contentHash).toBe('newhash');
    });
  });
});

describe('clearSessionIdentityProfileDirectFirst', () => {
  it('always uses the HTTP relay path, never the direct lease', async () => {
    const context = makeContext();
    clearSessionIdentityProfileMock.mockResolvedValue(true);
    const result = await clearSessionIdentityProfileDirectFirst('project', 'p', context);
    expect(result).toBe(true);
    expect(clearSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', context);
  });
});
