import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { useSyncedPreference } from '../../src/hooks/useSyncedPreference.js';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../../src/api.js', () => ({
  getUserPref: (...args: unknown[]) => api.get(...args),
  saveUserPref: (...args: unknown[]) => api.save(...args),
}));
let update: (next: string[] | ((previous: string[]) => string[])) => void;
function Probe({ scope = 'alice', delay = 0 }: { scope?: string; delay?: number }) {
  const [value, set, ready] = useSyncedPreference<string[]>('server_pinned', [], delay, scope);
  update = set;
  return <div data-testid="pins">{JSON.stringify(value)}:{String(ready)}</div>;
}
const key = (scope = 'alice') => `rcc_sync_${scope}:server_pinned`;
const payload = (v: string[], t: number) => JSON.stringify({ v, t });
const deferred = () => {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  return { promise, resolve };
};
beforeEach(() => {
  localStorage.clear();
  api.get.mockReset().mockResolvedValue(null);
  api.save.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ready = () => waitFor(() => expect(screen.getByTestId('pins').textContent).toContain(':true'));

describe('useSyncedPreference durable intent', () => {
  it('keeps a newer local edit when an old hydration GET arrives late', async () => {
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise);
    render(<Probe />);
    act(() => update(['new-pin']));
    await act(async () => { pending.resolve(payload([], 10)); });
    await ready();
    expect(screen.getByTestId('pins').textContent).toBe('["new-pin"]:true');
    expect(JSON.parse(localStorage.getItem(key())!).v).toEqual(['new-pin']);
  });

  it('uses strict reads: network failure is not an authoritative missing value', async () => {
    localStorage.setItem(key(), payload(['cached'], 100));
    api.get.mockImplementation((_key, options) => options?.strict ? Promise.reject(new Error('offline')) : Promise.resolve(null));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Probe />);
    await ready();
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('pins').textContent).toBe('["cached"]:true');
  });

  it.each(['focus', 'online', 'visibilitychange'])('reconciles newer remote intent on %s without polling or a local reset', async (event) => {
    api.get.mockResolvedValueOnce(payload(['first'], 10)).mockResolvedValue(payload(['second'], 20));
    render(<Probe />);
    await ready();
    expect(screen.getByTestId('pins').textContent).toBe('["first"]:true');
    act(() => (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event)));
    await waitFor(() => expect(screen.getByTestId('pins').textContent).toBe('["second"]:true'));
  });

  it('does not let a delayed debounce or GET from an old account write the new owner', async () => {
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise).mockResolvedValue(payload(['bob-pin'], 40));
    const view = render(<Probe delay={40} />);
    const staleSetter = update;
    act(() => update(['alice-pin']));
    view.rerender(<Probe scope="bob" delay={40} />);
    await ready();
    act(() => staleSetter(['stale-alice']));
    await act(async () => { pending.resolve(payload(['old-alice'], 30)); await new Promise((r) => setTimeout(r, 80)); });
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.getByTestId('pins').textContent).toBe('["bob-pin"]:true');
    expect(localStorage.getItem(key('bob'))).toBe(payload(['bob-pin'], 40));
  });

  it('uses the latest same-owner local cache for functional updates after another tab writes', async () => {
    render(<Probe />);
    await ready();
    localStorage.setItem(key(), payload(['other-tab'], Date.now()));
    act(() => update((previous) => [...previous, 'this-tab']));
    expect(JSON.parse(localStorage.getItem(key())!).v).toEqual(['other-tab', 'this-tab']);
  });

  it('propagates only matching storage keys and ignores older same-owner events', async () => {
    localStorage.setItem(key(), payload(['alice'], 20));
    const view = render(<Probe />);
    await ready();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: key('bob'), newValue: payload(['bob'], 50) })));
    expect(screen.getByTestId('pins').textContent).toBe('["alice"]:true');
    localStorage.setItem(key(), payload(['cross-tab'], 30));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: key(), newValue: payload(['cross-tab'], 30) })));
    await waitFor(() => expect(screen.getByTestId('pins').textContent).toBe('["cross-tab"]:true'));
    localStorage.setItem(key(), payload([], 10));
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: key(), newValue: payload([], 10) })));
    expect(screen.getByTestId('pins').textContent).toBe('["cross-tab"]:true');
    expect(localStorage.getItem(key())).toBe(payload(['cross-tab'], 30));
    view.unmount();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.get.mockRejectedValue(new Error('offline reload'));
    render(<Probe />);
    await ready();
    expect(screen.getByTestId('pins').textContent).toBe('["cross-tab"]:true');
  });

  it('retains an offline edit and uploads it only after a successful reconnect read', async () => {
    api.get.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(payload([], 1));
    api.save.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Probe />);
    await ready();
    act(() => update(['offline-pin']));
    await act(async () => { await Promise.resolve(); });
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(JSON.parse(api.save.mock.calls[1]![1]).v).toEqual(['offline-pin']);
  });

  it('serializes overlapping wakeups and does not replay an old GET over a new edit', async () => {
    const pending = deferred();
    api.get.mockReturnValueOnce(pending.promise).mockResolvedValue(payload([], 1));
    render(<Probe />);
    act(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
    expect(api.get).toHaveBeenCalledTimes(1);
    act(() => update(['during-read']));
    await act(async () => { pending.resolve(payload([], 1)); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('pins').textContent).toBe('["during-read"]:true');
    expect(JSON.parse(localStorage.getItem(key())!).v).toEqual(['during-read']);
  });

  it('retains null as a valid value for existing non-pin callers', async () => {
    function Nullable() {
      const [value] = useSyncedPreference<string | null>('nullable', 'fallback', 0, 'alice');
      return <div data-testid="nullable">{value === null ? 'null' : value}</div>;
    }
    localStorage.setItem('rcc_sync_alice:nullable', JSON.stringify({ v: null, t: 1 }));
    render(<Nullable />);
    await waitFor(() => expect(screen.getByTestId('nullable').textContent).toBe('null'));
  });

  it('does not read storage or refetch on unrelated app renders', async () => {
    const view = render(<Probe />);
    await ready();
    const get = vi.spyOn(localStorage, 'getItem');
    get.mockClear();
    const requests = api.get.mock.calls.length;
    for (let index = 0; index < 100; index++) view.rerender(<Probe />);
    expect(get).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(requests);
  });

  it('rejects malformed envelopes rather than resetting pins', async () => {
    localStorage.setItem(key(), payload(['valid'], 20));
    api.get.mockResolvedValue({ t: 100 });
    render(<Probe />);
    await ready();
    expect(screen.getByTestId('pins').textContent).toBe('["valid"]:true');
  });
});
