import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/preact';
import type { WsClient } from '../src/ws-client.js';
import { useTerminalRawHold } from '../src/hooks/useTerminalRawHold.js';

afterEach(() => cleanup());

/** Minimal ws stub exposing only the terminal-subscription surface the hook uses. */
function makeWs(withHold: boolean) {
  const release = vi.fn();
  const holdTerminalRaw = vi.fn(() => release);
  const subscribeTerminal = vi.fn();
  const unsubscribeTerminal = vi.fn();
  const ws = { subscribeTerminal, unsubscribeTerminal } as Record<string, unknown>;
  if (withHold) ws.holdTerminalRaw = holdTerminalRaw;
  return { ws: ws as unknown as WsClient, release, holdTerminalRaw, subscribeTerminal, unsubscribeTerminal };
}

describe('useTerminalRawHold', () => {
  it('holds the raw stream while mounted and releases the ref-counted hold on unmount', () => {
    const h = makeWs(true);
    const { unmount } = renderHook(() => useTerminalRawHold(h.ws, true, true, 'deck_x_s1'));
    expect(h.holdTerminalRaw).toHaveBeenCalledTimes(1);
    expect(h.holdTerminalRaw).toHaveBeenCalledWith('deck_x_s1');
    expect(h.release).not.toHaveBeenCalled();
    unmount();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled (non-shell) — the focus-gating fix only arms for shell', () => {
    const h = makeWs(true);
    const { unmount } = renderHook(() => useTerminalRawHold(h.ws, true, false, 'deck_x_s1'));
    expect(h.holdTerminalRaw).not.toHaveBeenCalled();
    unmount();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('does nothing while disconnected, then holds once connected', () => {
    const h = makeWs(true);
    const { rerender, unmount } = renderHook(
      ({ connected }: { connected: boolean }) => useTerminalRawHold(h.ws, connected, true, 'deck_x_s1'),
      { initialProps: { connected: false } },
    );
    expect(h.holdTerminalRaw).not.toHaveBeenCalled();
    rerender({ connected: true });
    expect(h.holdTerminalRaw).toHaveBeenCalledTimes(1);
    unmount();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('falls back to a plain raw subscribe/unsubscribe when holdTerminalRaw is unavailable', () => {
    const h = makeWs(false); // older ws-client without the hold API
    const { unmount } = renderHook(() => useTerminalRawHold(h.ws, true, true, 'deck_x_s1'));
    expect(h.subscribeTerminal).toHaveBeenCalledWith('deck_x_s1', true);
    expect(h.unsubscribeTerminal).not.toHaveBeenCalled();
    unmount();
    expect(h.unsubscribeTerminal).toHaveBeenCalledWith('deck_x_s1');
  });

  it('is a no-op when ws is null', () => {
    expect(() => {
      const { unmount } = renderHook(() => useTerminalRawHold(null, true, true, 'deck_x_s1'));
      unmount();
    }).not.toThrow();
  });
});
