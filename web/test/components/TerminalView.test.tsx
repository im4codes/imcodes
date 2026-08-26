/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen } from '@testing-library/preact';

vi.mock('xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    write: vi.fn(),
    reset: vi.fn(),
    loadAddon: vi.fn(),
    dispose: vi.fn(),
    options: {},
    attachCustomKeyEventHandler: vi.fn(),
    hasSelection: vi.fn().mockReturnValue(false),
    getSelection: vi.fn().mockReturnValue(''),
    onData: vi.fn(),
    onResize: vi.fn(),
    onScroll: vi.fn(),
    focus: vi.fn(),
    scrollToBottom: vi.fn(),
    buffer: { active: { baseY: 0, viewportY: 0 } },
    cols: 80,
    rows: 24,
  })),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

// Mock ResizeObserver which is not available in jsdom
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

import { TerminalView } from '../../src/components/TerminalView.js';
import { Terminal as TerminalMock } from 'xterm';
import type { TerminalDiff } from '../../src/types.js';

describe('TerminalView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a container div with terminal-container class', () => {
    const { container } = render(
      <TerminalView sessionName="test-session" />,
    );
    const div = container.querySelector('.terminal-container');
    expect(div).toBeDefined();
    expect(div).not.toBeNull();
  });

  it('calls onDiff with the applyDiff callback on mount', async () => {
    const onDiff = vi.fn();
    render(
      <TerminalView sessionName="test-session" onDiff={onDiff} />,
    );
    expect(onDiff).toHaveBeenCalledOnce();
    expect(typeof onDiff.mock.calls[0][0]).toBe('function');
  });

  it('applyDiff callback calls term.write with joined lines', async () => {
    const { Terminal } = await import('xterm');
    const mockWrite = vi.fn();
    const mockReset = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: mockWrite,
      reset: mockReset,
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(''),
      onData: vi.fn(),
      onResize: vi.fn(),
      onScroll: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      buffer: { active: { baseY: 0, viewportY: 0 } },
      cols: 80,
      rows: 24,
    }));

    let capturedApplyDiff: ((diff: TerminalDiff) => void) | undefined;
    const onDiff = vi.fn((fn) => { capturedApplyDiff = fn; });

    render(
      <TerminalView sessionName="my-session" onDiff={onDiff} />,
    );

    expect(capturedApplyDiff).toBeDefined();

    // Partial update (no fullFrame flag): component uses cursor-addressed write
    const diff: TerminalDiff = {
      rows: 2,
      lines: [[0, 'line one'], [1, 'line two']],
    };
    capturedApplyDiff!(diff);

    // Component writes cursor-positioned escape sequences for partial updates
    expect(mockWrite).toHaveBeenCalledWith(
      '\x1b[1;1Hline one\x1b[K\x1b[2;1Hline two\x1b[K',
    );
  });

  it('mounts and unmounts without throwing', () => {
    expect(() => {
      const { unmount } = render(
        <TerminalView sessionName="cleanup-session" />,
      );
      unmount();
    }).not.toThrow();
  });

  it('calls Terminal dispose on unmount', async () => {
    const { Terminal } = await import('xterm');
    const mockDispose = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: vi.fn(),
      reset: vi.fn(),
      loadAddon: vi.fn(),
      dispose: mockDispose,
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(''),
      onData: vi.fn(),
      onResize: vi.fn(),
      onScroll: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      buffer: { active: { baseY: 0, viewportY: 0 } },
      cols: 80,
      rows: 24,
    }));

    const { unmount } = render(
      <TerminalView sessionName="dispose-session" />,
    );
    unmount();
    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it('does not subscribe to raw terminal bytes while inactive', async () => {
    const onTerminalRaw = vi.fn();
    render(
      <TerminalView sessionName="inactive-session" ws={{ onTerminalRaw } as any} active={false} />,
    );
    expect(onTerminalRaw).not.toHaveBeenCalled();
  });

  it('does not apply diffs while inactive', async () => {
    const { Terminal } = await import('xterm');
    const mockWrite = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: mockWrite,
      reset: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(''),
      onData: vi.fn(),
      onResize: vi.fn(),
      onScroll: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: vi.fn(),
      buffer: { active: { baseY: 0, viewportY: 0 } },
      cols: 80,
      rows: 24,
    }));

    let capturedApplyDiff: ((diff: TerminalDiff) => void) | undefined;
    render(
      <TerminalView
        sessionName="inactive-diff"
        active={false}
        onDiff={(fn) => { capturedApplyDiff = fn; }}
      />,
    );

    capturedApplyDiff?.({
      rows: 1,
      lines: [[0, 'hidden update']],
    });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('batches raw PTY writes while rendering a preview terminal', async () => {
    vi.useFakeTimers();
    const { Terminal } = await import('xterm');
    const mockWrite = vi.fn((_data: Uint8Array, cb?: () => void) => cb?.());
    const mockScrollToBottom = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: mockWrite,
      reset: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(''),
      onData: vi.fn(),
      onResize: vi.fn(),
      onScroll: vi.fn(),
      focus: vi.fn(),
      scrollToBottom: mockScrollToBottom,
      buffer: { active: { baseY: 0, viewportY: 0 } },
      cols: 80,
      rows: 24,
    }));

    let rawHandler: ((data: Uint8Array) => void) | undefined;
    const ws = {
      onTerminalRaw: vi.fn((_session: string, handler: (data: Uint8Array) => void) => {
        rawHandler = handler;
        return vi.fn();
      }),
      onMessage: vi.fn(() => vi.fn()),
    };

    render(
      <TerminalView sessionName="preview-raw" ws={ws as any} preview />,
    );

    expect(rawHandler).toBeDefined();
    rawHandler!(new Uint8Array([65]));
    rawHandler!(new Uint8Array([66]));

    expect(mockWrite).not.toHaveBeenCalled();
    vi.advanceTimersByTime(31);
    expect(mockWrite).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(mockWrite).toHaveBeenCalledOnce();
    expect(Array.from(mockWrite.mock.calls[0][0] as Uint8Array)).toEqual([65, 66]);
    expect(mockScrollToBottom).toHaveBeenCalledOnce();
  });

  it('sends clipboard text to the session when pasting into the terminal', async () => {
    const { Terminal } = await import('xterm');
    const mockFocus = vi.fn();
    (Terminal as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      open: vi.fn(),
      write: vi.fn(),
      reset: vi.fn(),
      loadAddon: vi.fn(),
      dispose: vi.fn(),
      options: {},
      attachCustomKeyEventHandler: vi.fn(),
      hasSelection: vi.fn().mockReturnValue(false),
      getSelection: vi.fn().mockReturnValue(''),
      onData: vi.fn(),
      onResize: vi.fn(),
      onScroll: vi.fn(),
      focus: mockFocus,
      scrollToBottom: vi.fn(),
      buffer: { active: { baseY: 0, viewportY: 0 } },
      cols: 80,
      rows: 24,
    }));
    const sendInput = vi.fn();

    const { container } = render(
      <TerminalView
        sessionName="paste-session"
        ws={{
          sendInput,
          onTerminalRaw: vi.fn(() => vi.fn()),
          onMessage: vi.fn(() => vi.fn()),
        } as any}
      />,
    );
    const terminal = container.querySelector('.terminal-container') as HTMLElement;
    Object.defineProperty(terminal, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(terminal, 'clientHeight', { value: 360, configurable: true });
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: vi.fn(() => 'echo pasted\n') },
    });
    terminal.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mockFocus).toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledWith('paste-session', 'echo pasted\n');
  });
});

describe('TerminalView — diff scroll backlog while frames are stalled', () => {
  /** rAF that only ENQUEUES. Reproduces a sleeping display: no frames are
   *  produced, but WebSocket diffs keep arriving because they are I/O, not
   *  throttled timers. The shared fake-timer config keeps rAF real for the rest
   *  of the suite, so the stall is installed locally and restored after. */
  function installStalledRaf() {
    const queue: FrameRequestCallback[] = [];
    const cancelled = new Set<number>();
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCancel = globalThis.cancelAnimationFrame;
    let nextId = 1;
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (cb: FrameRequestCallback) => {
        const id = nextId++;
        queue.push(((t: number) => { if (!cancelled.has(id)) cb(t); }) as FrameRequestCallback);
        return id;
      },
      configurable: true, writable: true,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      value: (id: number) => { cancelled.add(id); },
      configurable: true, writable: true,
    });
    return {
      get queued() { return queue.length; },
      flush() {
        const batch = queue.splice(0, queue.length);
        for (const cb of batch) cb(0);
      },
      restore() {
        Object.defineProperty(globalThis, 'requestAnimationFrame', { value: prevRaf, configurable: true, writable: true });
        Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: prevCancel, configurable: true, writable: true });
      },
    };
  }

  it('coalesces the scroll frame across a burst of partial diffs', async () => {
    const raf = installStalledRaf();
    try {
      let applyDiff!: (d: unknown) => void;
      render(
        h(TerminalView, {
          sessionName: 'stalled-session',
          onDiff: (fn: (d: unknown) => void) => { applyDiff = fn; },
        } as never),
      );
      await new Promise((r) => setTimeout(r, 60));
      const baseline = raf.queued;

      // 200 PTY updates arriving while the display is asleep. A naive
      // rAF-per-diff queued 200 scroll callbacks, all executed inside the first
      // frame after unlock.
      for (let i = 0; i < 200; i++) {
        applyDiff({
          sessionName: 'stalled-session',
          lines: [[0, `line ${i}`]],
          cols: 80,
          rows: 24,
          fullFrame: false,
        });
      }

      expect(raf.queued - baseline).toBe(1);

      // And the coalesced frame must still actually scroll once frames resume —
      // dropping the work instead of merging it would leave the terminal stuck
      // off-bottom.
      const term = (TerminalMock as unknown as { mock: { results: Array<{ value: { scrollToBottom: ReturnType<typeof vi.fn> } }> } }).mock;
      const instance = term.results[term.results.length - 1]?.value;
      instance?.scrollToBottom?.mockClear?.();
      raf.flush();
      expect(instance?.scrollToBottom).toHaveBeenCalledTimes(1);
    } finally {
      raf.restore();
    }
  });
});
