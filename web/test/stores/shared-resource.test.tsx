/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { h } from 'preact';
import { act, cleanup, render, screen, waitFor } from '@testing-library/preact';
import { createSharedResource, __resetSharedResourcesForTests, type SharedResource } from '../../src/stores/shared-resource.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function Probe({ resource, label = 'value' }: { resource: SharedResource<string>; label?: string }) {
  const snapshot = resource.use();
  return <div data-testid={label}>{JSON.stringify(snapshot)}</div>;
}

afterEach(() => {
  cleanup();
  __resetSharedResourcesForTests();
});

describe('createSharedResource', () => {
  it('coalesces first subscribers into one fetch and caches across remounts', async () => {
    const fetcher = vi.fn().mockResolvedValue('server');
    const resource = createSharedResource<string>({ fetcher });
    const rendered = render(<><Probe resource={resource} label="a" /><Probe resource={resource} label="b" /></>);
    await screen.findAllByText(/server/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    rendered.unmount();
    render(<Probe resource={resource} label="c" />);
    expect(screen.getByTestId('c').textContent).toContain('server');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('peek is passive and set/mutate update subscribers without fetching', () => {
    const fetcher = vi.fn().mockResolvedValue('server');
    const resource = createSharedResource<string>({ fetcher });
    expect(resource.peek()).toMatchObject({ value: null, loaded: false, loading: false, stale: false });
    expect(fetcher).not.toHaveBeenCalled();
    render(<Probe resource={resource} />);
    act(() => resource.set('local'));
    expect(screen.getByTestId('value').textContent).toContain('local');
    act(() => resource.mutate('event'));
    expect(screen.getByTestId('value').textContent).toContain('event');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not let stale fetch completions overwrite newer mutations', async () => {
    const gate = deferred<string>();
    const resource = createSharedResource<string>({ fetcher: () => gate.promise });
    render(<Probe resource={resource} />);
    act(() => resource.set('local'));
    await act(async () => { gate.resolve('server'); await gate.promise; });
    expect(resource.peek().value).toBe('local');
  });

  it('invalidates warm resources with stale-while-revalidate semantics', async () => {
    const gate = deferred<string>();
    const fetcher = vi.fn().mockResolvedValueOnce('initial').mockReturnValueOnce(gate.promise);
    const resource = createSharedResource<string>({ fetcher });
    render(<Probe resource={resource} />);
    await screen.findByText(/initial/);
    act(() => resource.invalidate());
    expect(resource.peek()).toMatchObject({ value: 'initial', loaded: true, loading: true, stale: true });
    await act(async () => { gate.resolve('fresh'); await gate.promise; });
    expect(resource.peek()).toMatchObject({ value: 'fresh', loaded: true, loading: false, stale: false });
  });

  it('keeps warm value on refresh failure and can retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('initial').mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce('retry');
    const resource = createSharedResource<string>({ fetcher });
    render(<Probe resource={resource} />);
    await screen.findByText(/initial/);
    act(() => resource.invalidate());
    await waitFor(() => expect(resource.peek()).toMatchObject({ value: 'initial', loaded: true, loading: false, stale: true }));
    await act(async () => { await resource.reload(); });
    expect(resource.peek().value).toBe('retry');
  });

  it('does not automatically retry a cold fetch failure until explicit reload', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce('retry');
    const resource = createSharedResource<string>({ fetcher });
    render(<Probe resource={resource} />);
    await waitFor(() => expect(resource.peek().error).toBeInstanceOf(Error));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await resource.reload(); });
    expect(resource.peek().value).toBe('retry');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('publishes subscribed invalidation as stale and loading in one observable snapshot', async () => {
    const gate = deferred<string>();
    const fetcher = vi.fn().mockResolvedValueOnce('initial').mockReturnValueOnce(gate.promise);
    const resource = createSharedResource<string>({ fetcher });
    const snapshots: Array<ReturnType<typeof resource.peek>> = [];
    const unsubscribe = resource.subscribe(() => snapshots.push(resource.peek()));
    await act(async () => { await resource.reload(); });
    act(() => resource.invalidate());
    expect(snapshots.at(-1)).toMatchObject({ value: 'initial', loaded: true, loading: true, stale: true });
    unsubscribe();
  });

  it('defers no-subscriber warm invalidation until the next hook subscription', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('initial').mockResolvedValueOnce('fresh');
    const resource = createSharedResource<string>({ fetcher });
    const rendered = render(<Probe resource={resource} />);
    await screen.findByText(/initial/);
    rendered.unmount();

    act(() => resource.invalidate());
    expect(resource.peek()).toMatchObject({ value: 'initial', loaded: true, loading: false, stale: true });
    expect(fetcher).toHaveBeenCalledTimes(1);

    render(<Probe resource={resource} />);
    await screen.findByText(/fresh/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('keeps existing resources registered across repeated global test resets', () => {
    const resource = createSharedResource<string>({ fetcher: async () => 'server' });
    act(() => resource.set('first'));
    __resetSharedResourcesForTests();
    expect(resource.peek().value).toBeNull();

    act(() => resource.set('second'));
    __resetSharedResourcesForTests();
    expect(resource.peek().value).toBeNull();
  });

  it('does not notify repeatedly for no-op re-entrant mutations', () => {
    const resource = createSharedResource<string>({ fetcher: async () => 'server' });
    let calls = 0;
    resource.subscribe(() => {
      calls += 1;
      resource.set((prev) => prev ?? 'x');
    });
    act(() => resource.set('x'));
    expect(resource.peek().value).toBe('x');
    expect(calls).toBe(1);
  });

  it('supports external invalidation and ignores pending completion after reset', async () => {
    let api!: { mutate: (value: string) => void; invalidate: () => void };
    const gate = deferred<string>();
    const resource = createSharedResource<string>({
      fetcher: () => gate.promise,
      subscribeInvalidation: (nextApi) => { api = nextApi; return () => undefined; },
    });
    render(<Probe resource={resource} />);
    act(() => api.mutate('event'));
    expect(resource.peek().value).toBe('event');
    resource.disposeForTests();
    await act(async () => { gate.resolve('old'); await gate.promise; });
    expect(resource.peek().value).toBeNull();
  });

  it('exposes reload and peek to external invalidation and detaches the listener on reset', async () => {
    let api!: { reload: () => Promise<string | null>; peek: () => ReturnType<SharedResource<string>['peek']> };
    const unsubscribe = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce('server').mockResolvedValueOnce('fresh');
    const resource = createSharedResource<string>({
      fetcher,
      subscribeInvalidation: (nextApi) => {
        api = nextApi;
        return unsubscribe;
      },
    });

    const off = resource.subscribe(() => undefined);
    expect(api.peek()).toMatchObject({ value: null, loaded: false, loading: false });

    await act(async () => {
      await api.reload();
    });
    expect(api.peek()).toMatchObject({ value: 'server', loaded: true, loading: false });

    await act(async () => {
      await api.reload();
    });
    expect(resource.peek().value).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(2);

    __resetSharedResourcesForTests();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    off();
  });

  it('handles re-entrant subscriber mutation', () => {
    const resource = createSharedResource<string>({ fetcher: async () => 'server' });
    let didReenter = false;
    resource.subscribe(() => {
      if (!didReenter && resource.peek().value === 'a') {
        didReenter = true;
        resource.set('b');
      }
    });
    act(() => resource.set('a'));
    expect(resource.peek().value).toBe('b');
  });
});
