/**
 * @vitest-environment jsdom
 */
import { render, cleanup, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSubSessions } from '../src/hooks/useSubSessions.js';

const listSubSessions = vi.fn();

vi.mock('../src/api.js', () => ({
  listSubSessions: (...args: any[]) => listSubSessions(...args),
  createSubSession: vi.fn(),
  patchSubSession: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('useSubSessions rebuild gating', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not rebuild stale sub-sessions before a fresh reconnect load completes', async () => {
    const ws = { subSessionRebuildAll: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const stale = [{ id: 'old1', type: 'shell', shellBin: null, cwd: null, label: null, parentSession: 'deck_reconntest8e1ile_w10', createdAt: Date.now(), updatedAt: Date.now() }];
    listSubSessions.mockResolvedValueOnce(stale);

    function Harness(props: { connected: boolean }) {
      useSubSessions('srv1', ws, props.connected, null);
      return null;
    }

    const view = render(<Harness connected={true} />);
    await waitFor(() => expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1));

    view.rerender(<Harness connected={false} />);

    const fresh = deferred<any[]>();
    listSubSessions.mockReturnValueOnce(fresh.promise);
    view.rerender(<Harness connected={true} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);

    fresh.resolve([]);
    await waitFor(() => expect(listSubSessions).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.subSessionRebuildAll).toHaveBeenCalledTimes(1);
  });
});
