/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { act, cleanup, render } from '@testing-library/preact';
import { parseSyncedPreference } from '@shared/synced-preference.js';

const getUserPrefMock = vi.fn().mockResolvedValue(null);
const saveUserPrefMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => getUserPrefMock(...args),
  saveUserPref: (...args: unknown[]) => saveUserPrefMock(...args),
}));

import { useSyncedPreference } from '../src/hooks/useSyncedPreference.js';

describe('synced preference wire envelope', () => {
  it.each([{ v: [], t: 0 }, { v: null, t: 1 }, { v: ['pin'], t: Number.MAX_SAFE_INTEGER }])('accepts object/string legacy shapes: %j', (value) => {
    expect(parseSyncedPreference(value)).toEqual(value);
    expect(parseSyncedPreference(JSON.stringify(value))).toEqual(value);
  });
  it.each([null, undefined, 'not-json', [], { t: 10 }, { v: [] }, { v: [], t: '10' }, { v: [], t: NaN }, { v: [], t: Infinity }, { v: [], t: -1 }, { v: [], t: 0.1 }])('rejects malformed envelopes %j without manufacturing an empty list', (value) => {
    expect(parseSyncedPreference(value)).toBeNull();
  });
});

describe('useSyncedPreference render/write deduplication', () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
      const store: Record<string, string> = {};
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: (k: string) => store[k] ?? null,
          setItem: (k: string, v: string) => { store[k] = v; },
          removeItem: (k: string) => { delete store[k]; },
          clear: () => { for (const k of Object.keys(store)) delete store[k]; },
          get length() { return Object.keys(store).length; },
          key: (i: number) => Object.keys(store)[i] ?? null,
        },
        writable: true,
        configurable: true,
      });
    }
    localStorage.clear();
    getUserPrefMock.mockReset().mockResolvedValue(null);
    saveUserPrefMock.mockReset().mockResolvedValue(undefined);
    setItemSpy = vi.spyOn(localStorage, 'setItem');
  });

  afterEach(() => {
    cleanup();
    setItemSpy.mockRestore();
  });

  it('skips setState and writeLocal when incoming storage/remote payload has same value and newer timestamp', async () => {
    localStorage.setItem('rcc_sync_tab_order', JSON.stringify({ v: ['a', 'b'], t: 10 }));
    getUserPrefMock.mockResolvedValue(JSON.stringify({ v: ['a', 'b'], t: 20 }));

    let renders = 0;
    let latestValue: string[] = [];
    let latestSet!: (v: string[] | ((p: string[]) => string[])) => void;

    function Probe() {
      renders += 1;
      const [val, setVal, hydrated] = useSyncedPreference<string[]>('tab_order', [], 0);
      latestValue = val;
      latestSet = setVal;
      return h('div', { 'data-hydrated': String(hydrated) }, JSON.stringify(val));
    }

    render(h(Probe, {}));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendersAfterHydrate = renders;
    expect(latestValue).toEqual(['a', 'b']);
    setItemSpy.mockClear();
    saveUserPrefMock.mockClear();

    // Same value, newer timestamp via storage event -> no render, no writeLocal
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'rcc_sync_tab_order',
        newValue: JSON.stringify({ v: ['a', 'b'], t: 30 }),
      }));
    });
    expect(renders).toBe(rendersAfterHydrate);
    expect(setItemSpy).not.toHaveBeenCalled();

    // Same value, newer timestamp via focus reconcile -> no render, no writeLocal
    getUserPrefMock.mockResolvedValueOnce(JSON.stringify({ v: ['a', 'b'], t: 40 }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renders).toBe(rendersAfterHydrate);
    expect(setItemSpy).not.toHaveBeenCalled();

    // No-op setValue(['a', 'b']) -> no writeLocal, no saveUserPref, no render
    await act(async () => {
      latestSet(['a', 'b']);
    });
    expect(renders).toBe(rendersAfterHydrate);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(saveUserPrefMock).not.toHaveBeenCalled();

    // Actually changed value from storage event DOES update state
    const changed = JSON.stringify({ v: ['b', 'a'], t: 50 });
    await act(async () => {
      localStorage.setItem('rcc_sync_tab_order', changed);
      setItemSpy.mockClear();
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'rcc_sync_tab_order',
        newValue: changed,
      }));
    });
    expect(latestValue).toEqual(['b', 'a']);
    expect(renders).toBe(rendersAfterHydrate + 1);
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
