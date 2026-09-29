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

/** A WsClient the resolve call never answers -- used to force the direct path past its budget. */
function makeSilentWs() {
  return { connected: true, onMessage: () => () => undefined, send: () => undefined };
}

const CONTEXT = { serverId: 'srv-1', sessionName: 'deck_test_brain' };

beforeEach(() => {
  vi.clearAllMocks();
  supportsSessionIdentityDirectMock.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchSessionIdentityProfileDirectFirst', () => {
  it('falls back to the HTTP path with zero extra ticks when ws is missing', async () => {
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'x', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, null);
    expect(result?.content).toBe('x');
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP path when the capability check fails', async () => {
    supportsSessionIdentityDirectMock.mockReturnValue(false);
    fetchSessionIdentityProfileMock.mockResolvedValue(null);
    const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
    await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', CONTEXT);
  });

  it('resolves the canonical key then fetches over the direct lease on success', async () => {
    const ws = makeWs(() => ({ scopeKey: 'resolved-key', contentHash: 'abc', revision: 3, updatedAt: 42 }));
    getSessionIdentityDirectMock.mockResolvedValue({ content: 'hello world' });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    expect(result).toEqual({ scope: 'project', scopeKey: 'resolved-key', source: 'web', content: 'hello world', contentHash: 'abc', revision: 3, updatedAt: 42 });
    expect(getSessionIdentityDirectMock).toHaveBeenCalledWith(ws, 'srv-1', 'project', 'resolved-key');
    expect(fetchSessionIdentityProfileMock).not.toHaveBeenCalled();
  });

  it('returns null without a direct fetch when the resolved hash is empty (never-saved key)', async () => {
    const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    expect(result).toBeNull();
    expect(getSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('serves a cached hit without a second direct fetch when the hash is unchanged', async () => {
    const ws = makeWs(() => ({ scopeKey: 'resolved-key', contentHash: 'abc', revision: 1, updatedAt: 0 }));
    getSessionIdentityDirectMock.mockResolvedValue({ content: 'first' });
    await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    expect(getSessionIdentityDirectMock).toHaveBeenCalledTimes(1);

    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    expect(result?.content).toBe('first');
    expect(getSessionIdentityDirectMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the HTTP path when the direct fetch throws', async () => {
    // A scopeKey/hash distinct from the "cached hit" test above -- the
    // identity cache is module-level state shared across cases.
    const ws = makeWs(() => ({ scopeKey: 'resolved-key-throws', contentHash: 'throws-hash', revision: 1, updatedAt: 0 }));
    getSessionIdentityDirectMock.mockRejectedValue(new Error('lease_failed'));
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'fallback', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    expect(result?.content).toBe('fallback');
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', CONTEXT);
  });

  it('falls back to the HTTP path once the direct attempt exceeds its budget, without waiting for it to settle', async () => {
    vi.useFakeTimers();
    // The WS resolve call answers promptly (distinct key/hash so it isn't a
    // cache hit); it's the SUBSEQUENT getSessionIdentityDirect call that
    // hangs forever, so only the outer NEGOTIATION_TIMEOUT_MS (8s) budget --
    // not resolveIdentityDirect's own inner 4s timeout -- can be what ends it.
    const ws = makeWs(() => ({ scopeKey: 'resolved-key-hang', contentHash: 'hang-hash', revision: 1, updatedAt: 0 }));
    getSessionIdentityDirectMock.mockReturnValue(new Promise(() => { /* never resolves */ }));
    fetchSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'via-fallback', contentHash: 'h', revision: 1, updatedAt: 0 });

    const pending = fetchSessionIdentityProfileDirectFirst('project', 'p', CONTEXT, ws as never);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result?.content).toBe('via-fallback');
    expect(fetchSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', CONTEXT);
  });
});

describe('saveSessionIdentityProfileDirectFirst', () => {
  const INPUT = { scope: 'project' as const, scopeKey: 'p', content: 'new content' };

  it('falls back to the HTTP path with zero extra ticks when ws is missing', async () => {
    saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await saveSessionIdentityProfileDirectFirst(INPUT, CONTEXT, null);
    expect(result.content).toBe('new content');
    expect(setSessionIdentityDirectMock).not.toHaveBeenCalled();
  });

  it('resolves the canonical key then saves over the direct lease on success', async () => {
    const ws = makeWs(() => ({ scopeKey: 'resolved-key' }));
    setSessionIdentityDirectMock.mockResolvedValue({ contentHash: 'newhash', revision: 2, updatedAt: 99 });
    const result = await saveSessionIdentityProfileDirectFirst(INPUT, CONTEXT, ws as never);
    expect(result).toEqual({ scope: 'project', scopeKey: 'resolved-key', source: 'web', content: 'new content', contentHash: 'newhash', revision: 2, updatedAt: 99 });
    expect(setSessionIdentityDirectMock).toHaveBeenCalledWith(ws, 'srv-1', 'project', 'resolved-key', 'new content');
    expect(saveSessionIdentityProfileMock).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP path when the key cannot be resolved at all', async () => {
    const ws = makeWs(() => null);
    saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });
    const result = await saveSessionIdentityProfileDirectFirst(INPUT, CONTEXT, ws as never);
    expect(result.content).toBe('new content');
    expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(INPUT, CONTEXT);
  });

  it('falls back to the HTTP path once the direct attempt exceeds its budget, without waiting for it to settle', async () => {
    vi.useFakeTimers();
    // The WS resolve call answers promptly; it's the subsequent
    // setSessionIdentityDirect call that hangs forever, so only the outer
    // NEGOTIATION_TIMEOUT_MS (8s) budget -- not resolveIdentityDirect's own
    // inner 4s timeout -- can be what ends it.
    const ws = makeWs(() => ({ scopeKey: 'resolved-key-hang-save' }));
    setSessionIdentityDirectMock.mockReturnValue(new Promise(() => { /* never resolves */ }));
    saveSessionIdentityProfileMock.mockResolvedValue({ scope: 'project', scopeKey: 'p', source: 'web', content: 'new content', contentHash: 'h', revision: 1, updatedAt: 0 });

    const pending = saveSessionIdentityProfileDirectFirst(INPUT, CONTEXT, ws as never);
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result.content).toBe('new content');
    expect(saveSessionIdentityProfileMock).toHaveBeenCalledWith(INPUT, CONTEXT);
  });
});

describe('clearSessionIdentityProfileDirectFirst', () => {
  it('always uses the HTTP relay path, never the direct lease', async () => {
    clearSessionIdentityProfileMock.mockResolvedValue(true);
    const result = await clearSessionIdentityProfileDirectFirst('project', 'p', CONTEXT);
    expect(result).toBe(true);
    expect(clearSessionIdentityProfileMock).toHaveBeenCalledWith('project', 'p', CONTEXT);
  });
});
