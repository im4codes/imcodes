/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/preact';
import { LOCAL_PREVIEW_HISTORY_MAX } from '@shared/preview-types.js';
import { stripPreviewAccessTokenFromUpstreamPath } from '@shared/preview-policy.js';
import {
  useLocalPreviewInputHistory,
  mergeMru,
  type PreviewInputValidator,
} from '../src/hooks/useLocalPreviewInputHistory.js';

// Mirror of the panel's validators (kept local to the test so the hook is
// exercised exactly as production wires it).
function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

const portValidator: PreviewInputValidator = (raw) => {
  const port = parsePort(raw);
  return port === null ? null : String(port);
};

// Path validator: normalize (collapse whitespace -> '/'), strip token. Uses the
// real shared strip so the test pins the actual production contract.
const pathValidator: PreviewInputValidator = (raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const stripped = stripPreviewAccessTokenFromUpstreamPath(withSlash);
  return stripped || null;
};

const PORT_KEY = 'test_port_history';
const PATH_KEY = 'test_path_history';

describe('useLocalPreviewInputHistory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('orders entries MRU and dedups on the validated output', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    act(() => { result.current.commit('3000'); });
    act(() => { result.current.commit('8080'); });
    act(() => { result.current.commit('3000'); }); // duplicate -> refreshed to front

    expect(result.current.history).toEqual(['3000', '8080']);
    expect(result.current.mostRecent).toBe('3000');
  });

  it('caps the list at LOCAL_PREVIEW_HISTORY_MAX, dropping the oldest', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    const total = LOCAL_PREVIEW_HISTORY_MAX + 5;
    for (let i = 0; i < total; i++) {
      // ports 1000..1000+total-1, all distinct
      const port = String(1000 + i);
      act(() => { result.current.commit(port); });
    }

    expect(result.current.history).toHaveLength(LOCAL_PREVIEW_HISTORY_MAX);
    // Most recent is the last committed; oldest committed are dropped.
    const newest = String(1000 + total - 1);
    const oldestKept = String(1000 + total - LOCAL_PREVIEW_HISTORY_MAX);
    expect(result.current.history[0]).toBe(newest);
    expect(result.current.history[result.current.history.length - 1]).toBe(oldestKept);
    expect(result.current.history).not.toContain('1000');
  });

  it('does not store invalid values (validator rejects)', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    act(() => { result.current.commit('not-a-port'); });
    act(() => { result.current.commit(''); });
    act(() => { result.current.commit('70000'); }); // out of range
    act(() => { result.current.commit('3000'); });

    expect(result.current.history).toEqual(['3000']);
  });

  it('dedups on the parsePort numeric output (whitespace-insensitive)', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    act(() => { result.current.commit('  3000 '); });
    act(() => { result.current.commit('3000'); });

    expect(result.current.history).toEqual(['3000']);
  });

  it('strips preview_access_token from path before writing history', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PATH_KEY, pathValidator));

    act(() => { result.current.commit('/app?preview_access_token=secret&page=2'); });

    expect(result.current.history).toEqual(['/app?page=2']);
    // The raw secret never lands in localStorage.
    expect(localStorage.getItem(PATH_KEY) ?? '').not.toContain('secret');
    expect(localStorage.getItem(PATH_KEY) ?? '').not.toContain('preview_access_token');
  });

  it('strips repeated / empty / value-less token forms while keeping other query order', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PATH_KEY, pathValidator));

    act(() => {
      result.current.commit('/x?a=1&preview_access_token=one&b=2&preview_access_token=&c=3&preview_access_token');
    });

    expect(result.current.history).toEqual(['/x?a=1&b=2&c=3']);
  });

  it('degrades silently when localStorage.setItem throws (quota / private mode)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    // commit must not throw even though persistence fails.
    expect(() => act(() => { result.current.commit('3000'); })).not.toThrow();
    // In-memory state still updates so the dropdown remains usable this session.
    expect(result.current.history).toEqual(['3000']);

    setItem.mockRestore();
  });

  it('degrades silently when localStorage.getItem throws on read', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });

    expect(() => renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator))).not.toThrow();
    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));
    expect(result.current.history).toEqual([]);

    getItem.mockRestore();
  });

  it('rehydrates and re-validates an existing persisted list', () => {
    localStorage.setItem(PORT_KEY, JSON.stringify(['3000', 'garbage', '8080', '3000']));

    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    // 'garbage' filtered out, duplicate '3000' collapsed, order preserved.
    expect(result.current.history).toEqual(['3000', '8080']);
  });

  it('migrates a legacy single-value key into history[0] and removes it', () => {
    const LEGACY = 'legacy_port';
    localStorage.setItem(LEGACY, '4321');

    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator, LEGACY));

    expect(result.current.history).toEqual(['4321']);
    expect(result.current.mostRecent).toBe('4321');
    // Legacy key is removed so single-value and history never coexist.
    expect(localStorage.getItem(LEGACY)).toBeNull();
    // And the migration is persisted to the history key.
    expect(JSON.parse(localStorage.getItem(PORT_KEY) ?? '[]')).toEqual(['4321']);
  });

  it('folds a legacy value in front of an existing history list (validated)', () => {
    const LEGACY = 'legacy_port';
    localStorage.setItem(PORT_KEY, JSON.stringify(['8080', '9090']));
    localStorage.setItem(LEGACY, '4321');

    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator, LEGACY));

    expect(result.current.history).toEqual(['4321', '8080', '9090']);
    expect(localStorage.getItem(LEGACY)).toBeNull();
  });

  it('ignores a legacy value that fails validation but still removes the key', () => {
    const LEGACY = 'legacy_port';
    localStorage.setItem(PORT_KEY, JSON.stringify(['8080']));
    localStorage.setItem(LEGACY, 'not-a-port');

    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator, LEGACY));

    expect(result.current.history).toEqual(['8080']);
    expect(localStorage.getItem(LEGACY)).toBeNull();
  });

  it('keeps /app and /app/ as distinct entries (no implicit trailing-slash folding)', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PATH_KEY, pathValidator));

    act(() => { result.current.commit('/app'); });
    act(() => { result.current.commit('/app/'); });

    // pathValidator here does not collapse trailing slashes, so they are two items.
    expect(result.current.history).toEqual(['/app/', '/app']);
  });

  it('persists committed entries to localStorage', () => {
    const { result } = renderHook(() => useLocalPreviewInputHistory(PORT_KEY, portValidator));

    act(() => { result.current.commit('3000'); });
    act(() => { result.current.commit('8080'); });

    expect(JSON.parse(localStorage.getItem(PORT_KEY) ?? '[]')).toEqual(['8080', '3000']);
  });
});

describe('mergeMru', () => {
  it('returns the same reference when the value is already first', () => {
    const list = ['a', 'b', 'c'];
    expect(mergeMru(list, 'a')).toBe(list);
  });

  it('moves an existing value to the front without duplicating', () => {
    expect(mergeMru(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('truncates to LOCAL_PREVIEW_HISTORY_MAX', () => {
    const full = Array.from({ length: LOCAL_PREVIEW_HISTORY_MAX }, (_, i) => `v${i}`);
    const next = mergeMru(full, 'new');
    expect(next).toHaveLength(LOCAL_PREVIEW_HISTORY_MAX);
    expect(next[0]).toBe('new');
    expect(next).not.toContain(`v${LOCAL_PREVIEW_HISTORY_MAX - 1}`);
  });
});
