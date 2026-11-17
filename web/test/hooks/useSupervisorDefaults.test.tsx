import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/preact';
import { normalizeSupervisorDefaultConfig } from '@shared/supervision-config.js';
import { useSupervisorDefaults } from '../../src/hooks/useSupervisorDefaults.js';
const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), catalog: vi.fn(async () => []) }));
vi.mock('../../src/api.js', () => ({
  fetchSessionSupervisorDefaults: api.get,
  saveSessionSupervisorDefaults: api.save,
  fetchSessionSupervisorExecutionPoolCatalog: api.catalog,
}));
const defaults = (model: string) => normalizeSupervisorDefaultConfig({ model });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('scoped supervisor preference authority', () => {
  it('does not let a late initial read replace a successful save', async () => {
    const old = deferred<ReturnType<typeof defaults>>();
    api.get.mockReturnValueOnce(old.promise);
    api.save.mockResolvedValue(defaults('new'));
    const { result } = renderHook(() => useSupervisorDefaults(true, { serverId: 's', sessionName: 'brain' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledOnce());
    await act(async () => { await result.current.save(defaults('new')); });
    await act(async () => { old.resolve(defaults('old')); });
    expect(result.current.value?.model).toBe('new');
  });
  it('ignores an older save acknowledgment and a reload completed after switching owner', async () => {
    api.get.mockResolvedValue(defaults('initial'));
    const { result, rerender } = renderHook(({ serverId }) => useSupervisorDefaults(true, { serverId, sessionName: 'brain' }), { initialProps: { serverId: 'a' } });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    const old = deferred<ReturnType<typeof defaults>>();
    api.save.mockReturnValueOnce(old.promise).mockResolvedValueOnce(defaults('new'));
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.save(defaults('old')); });
    await act(async () => { await result.current.save(defaults('new')); });
    await act(async () => { old.resolve(defaults('old')); await pending; });
    expect(result.current.value?.model).toBe('new');
    const read = deferred<ReturnType<typeof defaults>>();
    api.get.mockReturnValueOnce(read.promise);
    act(() => { pending = result.current.reload(); });
    api.get.mockResolvedValue(defaults('owner-b'));
    rerender({ serverId: 'b' });
    await waitFor(() => expect(result.current.value?.model).toBe('owner-b'));
    await act(async () => { read.resolve(defaults('owner-a')); await pending; });
    expect(result.current.value?.model).toBe('owner-b');
  });
  it('propagates failed saves and retains the authoritative preference', async () => {
    api.get.mockResolvedValue(defaults('saved'));
    const { result } = renderHook(() => useSupervisorDefaults(true, { serverId: 's', sessionName: 'brain' }));
    await waitFor(() => expect(result.current.loaded).toBe(true));
    api.save.mockRejectedValue(new Error('persist failed'));
    await expect(result.current.save(defaults('unsaved'))).rejects.toThrow('persist failed');
    expect(result.current.value?.model).toBe('saved');
  });
});
