/**
 * @vitest-environment jsdom
 *
 * tsk_f2a967730b: a view that dropped bytes discards everything until a full
 * frame arrives. These tests pin that it can never be left waiting for good, and
 * that the full frame restores the state the following raw bytes assume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render } from '@testing-library/preact';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn().mockImplementation(() => ({})) }));
global.ResizeObserver = vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }));

import { Terminal } from 'xterm';
import { TerminalView } from '../../src/components/TerminalView.js';
import type { TerminalDiff } from '../../src/types.js';
import { TERMINAL_CONTROL } from '@shared/terminal-protocol.js';

interface Harness {
  writes: Array<{ data: Uint8Array | string; done?: () => void }>;
  rawHandler: () => (data: Uint8Array) => void;
  applyDiff: () => (diff: TerminalDiff) => void;
  messageHandler: () => (msg: Record<string, unknown>) => void;
  sendSnapshotRequest: ReturnType<typeof vi.fn>;
  sendResize: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  unmount: () => void;
}

function mount(options: { holdWrites?: boolean; active?: boolean; connected?: boolean } = {}): Harness {
  const writes: Harness['writes'] = [];
  const reset = vi.fn();
  (Terminal as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn((data: Uint8Array | string, done?: () => void) => {
      writes.push({ data, done });
      if (!options.holdWrites) done?.();
    }),
    reset, loadAddon: vi.fn(), dispose: vi.fn(), options: {}, attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn().mockReturnValue(false), getSelection: vi.fn().mockReturnValue(''),
    onData: vi.fn(), onResize: vi.fn(), onScroll: vi.fn(), focus: vi.fn(), scrollToBottom: vi.fn(),
    buffer: { active: { baseY: 0, viewportY: 0 } }, cols: 80, rows: 24,
  }));
  let rawHandler: ((data: Uint8Array) => void) | undefined;
  let applyDiff: ((diff: TerminalDiff) => void) | undefined;
  let messageHandler: ((msg: Record<string, unknown>) => void) | undefined;
  const sendSnapshotRequest = vi.fn();
  const sendResize = vi.fn();
  const ws = {
    onTerminalRaw: vi.fn((_session: string, handler: (data: Uint8Array) => void) => { rawHandler = handler; return vi.fn(); }),
    onMessage: vi.fn((handler: (msg: Record<string, unknown>) => void) => { messageHandler = handler; return vi.fn(); }),
    sendSnapshotRequest,
    sendResize,
    sendInput: vi.fn(),
  };
  const view = render(
    <TerminalView sessionName="resync-shell" ws={ws as never} active={options.active ?? true} connected={options.connected} onDiff={(fn) => { applyDiff = fn; }} />,
  );
  return {
    writes, sendSnapshotRequest, sendResize, reset,
    rawHandler: () => rawHandler!, applyDiff: () => applyDiff!, messageHandler: () => messageHandler!,
    unmount: () => view.unmount(),
  };
}

const text = (data: Uint8Array | string) => (typeof data === 'string' ? data : new TextDecoder().decode(data));

describe('TerminalView — a pending resync is never left unanswered', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps asking for the snapshot (with backoff) until a full frame arrives, then stops', () => {
    const view = mount({ holdWrites: true });
    view.rawHandler()(new Uint8Array([65]));
    vi.advanceTimersByTime(16);
    view.rawHandler()(new Uint8Array(64 * 1024 + 1)); // overflows behind the held write
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);

    // The snapshot never comes (dropped on the way): the view asks again.
    vi.advanceTimersByTime(1_500);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(6_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(4);
    // Backoff is capped: from here on, one request per 10 s - never given up.
    vi.advanceTimersByTime(10_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(10_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(6);

    // The full frame lands: recovery is over and no further requests are made.
    view.applyDiff()({ rows: 1, lines: [[0, 'fresh']], fullFrame: true });
    vi.advanceTimersByTime(60_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(6);
  });

  it('a stream_reset from the server also waits for the snapshot (and keeps asking), instead of painting mid-stream bytes', () => {
    const view = mount();
    view.rawHandler()(new Uint8Array([65]));
    vi.advanceTimersByTime(16);
    expect(view.writes).toHaveLength(1);

    view.messageHandler()({ type: TERMINAL_CONTROL.STREAM_RESET, session: 'resync-shell', reason: 'backpressure' });
    expect(view.reset).toHaveBeenCalled();
    // Bytes that keep arriving mid-sequence are not painted onto the blank screen.
    view.rawHandler()(new Uint8Array([66, 67]));
    vi.advanceTimersByTime(16);
    expect(view.writes).toHaveLength(1);

    // The socket client requests the snapshot itself; if that request is lost
    // the view's own watchdog does.
    expect(view.sendSnapshotRequest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_500);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);

    // The snapshot arrives; live bytes flow again.
    view.applyDiff()({ rows: 1, lines: [[0, 'snap']], fullFrame: true });
    view.rawHandler()(new Uint8Array([68]));
    vi.advanceTimersByTime(16);
    expect(text(view.writes.at(-1)!.data)).toBe('D');
    vi.advanceTimersByTime(30_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);
  });

  it('unmounting cancels the watchdog', () => {
    const view = mount({ holdWrites: true });
    view.rawHandler()(new Uint8Array([65]));
    vi.advanceTimersByTime(16);
    view.rawHandler()(new Uint8Array(64 * 1024 + 1));
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.advanceTimersByTime(60_000);
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);
  });

  it('one large chunk into an IDLE writer is written, not mistaken for congestion', () => {
    const view = mount();
    view.rawHandler()(new Uint8Array(100 * 1024).fill(0x61));
    expect(view.sendSnapshotRequest).not.toHaveBeenCalled();
    expect(view.writes).toHaveLength(1);
    expect((view.writes[0]!.data as Uint8Array).byteLength).toBe(100 * 1024);
  });
});

describe('TerminalView — a (re)mounted view is repainted even while its container is hidden', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks for a snapshot but does not pin a 0x0 size on the pane', () => {
    // jsdom lays nothing out: the container reports 0x0, i.e. hidden (chat mode).
    const view = mount({ connected: true });
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);
    expect(view.sendResize).not.toHaveBeenCalled();
    view.unmount();
  });

  it('a view that is not connected asks for nothing', () => {
    const view = mount({ connected: false });
    expect(view.sendSnapshotRequest).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe('TerminalView — returning to a hidden tab verifies the screen', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  const setVisibility = (state: 'hidden' | 'visible') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('requests a snapshot after a long absence, not after a quick tab flip', () => {
    const view = mount();
    setVisibility('hidden');
    vi.advanceTimersByTime(1_000);
    setVisibility('visible');
    expect(view.sendSnapshotRequest).not.toHaveBeenCalled();

    setVisibility('hidden');
    vi.advanceTimersByTime(4_000);
    setVisibility('visible');
    expect(view.sendSnapshotRequest).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('an inactive (parked) view does not poke the daemon', () => {
    const view = mount({ active: false });
    setVisibility('hidden');
    vi.advanceTimersByTime(10_000);
    setVisibility('visible');
    expect(view.sendSnapshotRequest).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe('TerminalView — the full frame restores what the following raw bytes assume', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('places the cursor and repaints the alternate screen with the normal screen behind it', () => {
    const view = mount();
    view.applyDiff()({
      rows: 3, cols: 40, fullFrame: true,
      lines: [[0, 'ALT'], [1, ''], [2, '']],
      cursor: { x: 4, y: 2, visible: true },
      altScreen: true,
      normalLines: [[0, 'NORMAL'], [1, '$ vim'], [2, '']],
    });
    const frame = text(view.writes.at(-1)!.data);
    expect(frame).toContain('\x1b[?1049h');
    expect(frame.indexOf('NORMAL')).toBeLessThan(frame.indexOf('\x1b[?1049h'));
    expect(frame.indexOf('\x1b[?1049h')).toBeLessThan(frame.indexOf('ALT'));
    expect(frame.endsWith('\x1b[3;5H\x1b[?25h')).toBe(true);
  });

  it('a frame from an older daemon (no cursor, no alternate screen) is painted as before', () => {
    const view = mount();
    view.applyDiff()({ rows: 2, lines: [[0, 'one'], [1, 'two']], fullFrame: true });
    const frame = text(view.writes.at(-1)!.data);
    expect(frame).toContain('one\x1b[K\r\ntwo\x1b[K\x1b[J');
    expect(frame).not.toContain('?25');
    expect(frame).not.toContain('?1049h');
  });

  it('bounds a hostile cursor instead of trusting it', () => {
    const view = mount();
    view.applyDiff()({ rows: 2, lines: [[0, 'a'], [1, 'b']], fullFrame: true, cursor: { x: 9e9, y: 9e9, visible: true } });
    expect(text(view.writes.at(-1)!.data)).toMatch(/\x1b\[2;2049H/);
  });
});
