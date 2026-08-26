import { useEffect, useRef, useCallback, useState } from 'preact/hooks';
import { useCoalescedFrame } from '../hooks/useCoalescedFrame.js';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import { TERMINAL_MAX_ROWS } from '@shared/terminal-limits.js';
import { IOS_MAC_TERMINAL_FONT_SIZE, shouldUseIosMacTextScale } from '../native-platform.js';

interface Props {
  sessionName: string;
  ws: WsClient | null;
  connected?: boolean;
  /** When false, keep the terminal mounted but pause expensive live work. */
  active?: boolean;
  /** Optimize for embedded preview cards: coalesce raw writes and reduce idle work. */
  preview?: boolean;
  onDiff?: (applyDiff: (diff: TerminalDiff) => void) => void;
  onHistory?: (applyHistory: (content: string) => void) => void;
  /** Receives a function that focuses the xterm terminal — call it to restore keyboard to xterm. */
  onFocusFn?: (fn: () => void) => void;
  /** Receives a function that fits the terminal to its container and syncs size to tmux. */
  onFitFn?: (fn: () => void) => void;
  /** Receives a function that forces the terminal to scroll to the bottom. */
  onScrollBottomFn?: (fn: () => void) => void;
  /** When true, allow keyboard input on mobile (for shell/ssh sessions). */
  mobileInput?: boolean;
}

const PREVIEW_RAW_FLUSH_MS = 32;
const PREVIEW_RAW_MAX_BYTES = 16 * 1024;
const PREVIEW_DIFF_SUPPRESS_AFTER_RAW_MS = 1000;

/**
 * Resolves the row bounds for one diff frame.
 *
 * `declaredRows` is what the frame actually claims, or `null` when it claims
 * nothing usable; `rows` is the bound to test line indices against. They differ
 * on purpose: a frame with no usable `rows` must still paint its lines, because
 * the original code sized the buffer with `lines.slice(0, diff.rows)` and
 * `slice(0, undefined)` keeps everything. Collapsing an absent `rows` to 0 made
 * every line fail the bounds test and blanked the buffer, so incremental frames
 * stopped rendering and output only appeared when the next full frame redrew
 * the whole screen at once.
 */
export function resolveDiffRows(rawRows: unknown): { declaredRows: number | null; rows: number } {
  const declaredRows = Number.isFinite(rawRows)
    ? Math.max(0, Math.min(Math.floor(rawRows as number), TERMINAL_MAX_ROWS))
    : null;
  return { declaredRows, rows: declaredRows ?? TERMINAL_MAX_ROWS };
}

/**
 * The single rule for "is this a row this frame may describe".
 *
 * Both the line-array path and the ANSI cursor-addressing path must agree; when
 * they did not, a frame with rows=1 and lines=[[1000, …]] dropped the line from
 * the array but still emitted `\x1b[1001;1H` to the terminal.
 */
export function isRenderableLineIndex(lineIdx: unknown, rows: number): lineIdx is number {
  return Number.isInteger(lineIdx)
    && (lineIdx as number) >= 0
    && (lineIdx as number) < rows
    && (lineIdx as number) < TERMINAL_MAX_ROWS;
}

function requestFrame(callback: FrameRequestCallback): number | ReturnType<typeof setTimeout> {
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === 'function') return raf.call(globalThis, callback);
  return setTimeout(() => callback(Date.now()), 0);
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function TerminalView({ sessionName, ws, connected, active = true, preview = false, onDiff, onHistory, onFocusFn, onFitFn, onScrollBottomFn, mobileInput }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const linesRef = useRef<string[]>([]);
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const activeRef = useRef(active);
  activeRef.current = active;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const pendingRawChunksRef = useRef<Uint8Array[]>([]);
  const pendingRawBytesRef = useRef(0);
  const rawFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRawWriteAtRef = useRef(0);

  // Touch scroll tracking: suppress auto-scroll for 1s after user releases touch
  const lastTouchEndRef = useRef<number>(0);
  const isTouchingRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // User intent: true = auto-follow bottom (State 2), false = user scrolled up (State 1).
  // Only changed by real user scroll actions (onScroll), NOT by onLineFeed/writes.
  // This prevents intermediate xterm write states from corrupting the follow flag.
  const autoFollowRef = useRef(true);
  // NOTE: two write-only refs used to live here. Nothing ever READ them, so
  // they suppressed nothing while their comments claimed otherwise — which
  // repeatedly misled freeze investigations. They are removed rather than
  // "restored": rebuilding a scroll-intent guard from a stale comment risks
  // swallowing real user scrolls, and that belongs in its own change with its
  // own acceptance criteria.

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Coalesced scroll-to-bottom for the diff data path. Repeat requests replace
  // the pending frame instead of appending a new one, and the frame is
  // cancelled on unmount. See useCoalescedFrame for the lock-screen rationale.
  const scheduleFrame = useCoalescedFrame();
  const scheduleScrollToBottom = useCallback(() => {
    scheduleFrame(() => {
      const term = termRef.current;
      if (!term) return;
      term.scrollToBottom();
    });
  }, [scheduleFrame]);

  // Scroll state: show button + progress bar when scrolled up
  const [scrolledUp, setScrolledUp] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(1); // 0..1, 1 = bottom
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showScrollbar, setShowScrollbar] = useState(false);
  const useIosMacTextScale = shouldUseIosMacTextScale();

  const clearRawFlushTimer = useCallback(() => {
    if (rawFlushTimerRef.current) {
      clearTimeout(rawFlushTimerRef.current);
      rawFlushTimerRef.current = null;
    }
  }, []);

  const discardPendingRaw = useCallback(() => {
    clearRawFlushTimer();
    pendingRawChunksRef.current = [];
    pendingRawBytesRef.current = 0;
  }, [clearRawFlushTimer]);

  const writeRawToTerminal = useCallback((data: Uint8Array) => {
    const term = termRef.current;
    if (!term) return;
    lastRawWriteAtRef.current = Date.now();
    term.write(data, () => {
      // Snap to bottom after each PTY write. CC redraws its UI from cursor-home
      // (\x1b[H) which makes xterm follow the cursor to the top; snapping here
      // ensures the viewport stays at the bottom showing the latest output.
      term.scrollToBottom();
    });
  }, []);

  const flushPendingRaw = useCallback(() => {
    clearRawFlushTimer();
    const chunks = pendingRawChunksRef.current;
    const totalBytes = pendingRawBytesRef.current;
    if (chunks.length === 0 || totalBytes === 0) return;
    pendingRawChunksRef.current = [];
    pendingRawBytesRef.current = 0;
    writeRawToTerminal(concatChunks(chunks, totalBytes));
  }, [clearRawFlushTimer, writeRawToTerminal]);

  const enqueueRawWrite = useCallback((data: Uint8Array) => {
    if (!previewRef.current) {
      writeRawToTerminal(data);
      return;
    }
    pendingRawChunksRef.current.push(data);
    pendingRawBytesRef.current += data.byteLength;
    if (pendingRawBytesRef.current >= PREVIEW_RAW_MAX_BYTES) {
      flushPendingRaw();
      return;
    }
    if (!rawFlushTimerRef.current) {
      rawFlushTimerRef.current = setTimeout(flushPendingRaw, PREVIEW_RAW_FLUSH_MS);
    }
  }, [flushPendingRaw, writeRawToTerminal]);

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#0f0f13',
        foreground: '#e2e8f0',
        cursor: '#3b82f6',
        selectionBackground: '#1d4ed860',
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', monospace",
      fontSize: useIosMacTextScale ? IOS_MAC_TERMINAL_FONT_SIZE : 13,
      lineHeight: useIosMacTextScale ? 1.45 : 1.4,
      convertEol: true,
      scrollback: preview ? 2000 : 5000,
      allowTransparency: false,
      cursorBlink: !preview,
      // On mobile: disable xterm stdin unless mobileInput is set (shell sessions
      // need keyboard for interactive SSH-like input).
      disableStdin: isMobile && !mobileInput,
    });

    // Copy selected text to clipboard on Ctrl+C / Cmd+C when selection exists
    term.attachCustomKeyEventHandler((ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false; // prevent sending ^C to tmux when we're copying
      }
      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    let fitTimer: ReturnType<typeof setTimeout> | null = null;

    if (containerRef.current) {
      term.open(containerRef.current);
      // Defer fit until container has non-zero dimensions (mobile needs a frame to lay out)
      let fitDone = false;
      const doFit = () => {
        if (!activeRef.current) return;
        const el = containerRef.current;
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          fitAddon.fit();
          fitDone = true;
        }
      };
      requestFrame(() => {
        doFit();
        if (!fitDone) requestFrame(() => { doFit(); });
      });
      // Fallback: force a fit after 400ms for slow mobile renders
      fitTimer = setTimeout(() => {
        if (!activeRef.current) return;
        if (!fitDone) {
          fitAddon.fit();
          fitDone = true;
        }
      }, 400);
      // Auto-focus terminal on mount for desktop keyboard input
      if (!isMobile) {
        requestFrame(() => term.focus());
      }
    }

    // Forward all keyboard input to the tmux session — but skip when terminal
    // is hidden (display:none on ancestor sets clientWidth/Height to 0).
    // This prevents keys from going to the terminal in chat mode even if
    // xterm's hidden textarea still has focus.
    term.onData((data) => {
      const el = containerRef.current;
      if (el && el.clientWidth === 0 && el.clientHeight === 0) return;
      wsRef.current?.sendInput(sessionName, data);
    });

    const handlePaste = (ev: ClipboardEvent) => {
      const el = containerRef.current;
      if (!el || (el.clientWidth === 0 && el.clientHeight === 0)) return;
      const text = ev.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      term.focus();
      wsRef.current?.sendInput(sessionName, text);
    };
    containerRef.current?.addEventListener('paste', handlePaste, { capture: true });

    // Sync terminal dimensions to tmux on every resize — but only when visible.
    // When hidden (chat mode), the parent sends a large fallback size (200x50)
    // to keep tmux uncramped. Sending xterm's tiny hidden-container dimensions
    // would override that and shrink the tmux session.
    term.onResize(({ cols, rows }) => {
      const el = containerRef.current;
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return; // hidden
      wsRef.current?.sendResize(sessionName, cols, rows);
    });

    // Track scroll position for "scroll to bottom" button + progress bar.
    // onScroll = real user scroll action → update autoFollowRef (sticky intent).
    // onLineFeed = xterm write in progress → only update UI, NOT autoFollowRef.
    const onScrollEvent = () => {
      const buf = term.buffer.active;
      const baseY = buf.baseY;
      const viewportY = buf.viewportY;
      // Nuclear guard: viewportY=0 with scrollback content is always a bug, never user intent.
      // Nobody deliberately scrolls to the absolute top — snap back immediately.
      if (viewportY === 0 && baseY > 0) {
        autoFollowRef.current = true;
        term.scrollToBottom();
        return;
      }
      const atBottom = viewportY >= baseY || baseY === 0;
      // Always keep auto-follow on — terminal always snaps to bottom on new content.
      autoFollowRef.current = true;
      setScrolledUp(!atBottom);
      setScrollProgress(baseY > 0 ? viewportY / baseY : 1);
      setShowScrollbar(true);
      if (scrollHideTimerRef.current) clearTimeout(scrollHideTimerRef.current);
      scrollHideTimerRef.current = setTimeout(() => setShowScrollbar(false), 1500);
    };
    term.onScroll(onScrollEvent);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Expose focus function so parent can restore keyboard to xterm after button clicks
    onFocusFn?.(() => term.focus());

    // Expose scroll-to-bottom function so parent can force-snap after sending a message
    onScrollBottomFn?.(() => { autoFollowRef.current = true; term.scrollToBottom(); });

    // Expose fit function so parent can trigger resize on send / focus
    // Applies a fit only when xterm's own proposed dimensions actually change.
    // Comparing the container rect is not enough: font loading, zoom and DPR
    // changes move the cell metrics while the rect stays identical, and the two
    // observed elements report different rects for the same layout.
    // `force` bypasses the equality check for resume/refocus, where one explicit
    // fit is wanted even if the dimensions look unchanged.
    const applyFit = (force = false): boolean => {
      if (!activeRef.current) return false;
      const el = containerRef.current;
      // display:none ancestors report 0x0; fitting against that yields garbage
      // dimensions, so skip entirely until the element is laid out again.
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return false;
      if (!force) {
        const proposed = fitAddon.proposeDimensions();
        if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return false;
        if (proposed.cols === term.cols && proposed.rows === term.rows) return false;
      }
      fitAddon.fit();
      return true;
    };

    // At most one pending fit frame. A ResizeObserver can fire many times per
    // frame (two observed targets, layout settling after unlock) and focus can
    // fire repeatedly on unlock; queueing one callback per event is what turns a
    // resume into a burst of forced layouts.
    let pendingFitFrame: ReturnType<typeof requestFrame> | null = null;
    let pendingFitForce = false;
    const cancelPendingFit = () => {
      if (pendingFitFrame === null) return;
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingFitFrame as number);
      else clearTimeout(pendingFitFrame as ReturnType<typeof setTimeout>);
      pendingFitFrame = null;
    };
    const scheduleFit = (force = false) => {
      pendingFitForce = pendingFitForce || force;
      if (pendingFitFrame !== null) return;
      pendingFitFrame = requestFrame(() => {
        pendingFitFrame = null;
        const forceThisPass = pendingFitForce;
        pendingFitForce = false;
        if (applyFit(forceThisPass)) {
          // Snap to bottom after fit (reflow can reset viewportY to 0)
          term.scrollToBottom();
          autoFollowRef.current = true;
        }
      });
    };

    const doFitAndSnap = () => { scheduleFit(true); };
    onFitFn?.(doFitAndSnap);

    // Re-fit when window regains focus or tab becomes visible.
    const onWindowFocus = () => { doFitAndSnap(); };
    const onVisibilityChange = () => {
      if (activeRef.current && document.visibilityState === 'visible') { doFitAndSnap(); }
    };
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    // NOTE: do NOT repaint linesRef.current on resize — xterm reflows natively,
    // and repainting with a stale diff buffer clobbers live PTY output (especially
    // on mobile where the viewport resizes on address bar / keyboard show/hide).
    const observer = new ResizeObserver((entries) => {
      if (!activeRef.current) return;
      // Every entry in the batch is considered, not just entries[0]: two targets
      // are observed and the interesting one is not always first. An all-zero
      // batch means a hidden ancestor — nothing to fit against.
      const laidOut = entries.some((e) => e.contentRect.width > 0 && e.contentRect.height > 0);
      if (!laidOut) return;
      scheduleFit(false);
    });
    const containerEl = containerRef.current;
    if (containerEl) {
      observer.observe(containerEl);
      // Also observe the immediate wrapper so late layout changes (for example when the
      // sub-session bar mounts after a tab switch) still trigger a fit/snap cycle.
      if (containerEl.parentElement) observer.observe(containerEl.parentElement);
    }

    return () => {
      if (fitTimer) clearTimeout(fitTimer);
      cancelPendingFit();
      discardPendingRaw();
      containerRef.current?.removeEventListener('paste', handlePaste, { capture: true });
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionName, useIosMacTextScale]); // eslint-disable-line react-hooks/exhaustive-deps

  // When WS reconnects (connected → true), re-send terminal dimensions so tmux
  // always matches xterm — prevents garbled/corrupted display (花屏).
  // Skip when hidden (chat mode) — parent handles that with 200x50.
  useEffect(() => {
    if (!connected || !active) return;
    const el = containerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return; // hidden (chat mode)
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws) {
      ws.sendResize(sessionName, term.cols, term.rows);
      try { ws.sendSnapshotRequest(sessionName); } catch { /* ignore */ }
    }
  }, [active, connected, sessionName]);

  // Raw PTY bytes: feed directly into xterm.js.
  // Use useEffect so cleanup properly unsubscribes this specific handler instance,
  // allowing multiple TerminalViews for the same session (e.g. preview card + window).
  useEffect(() => {
    if (!ws || !active) return;
    const unsub = ws.onTerminalRaw(sessionName, enqueueRawWrite);
    return () => {
      unsub();
      discardPendingRaw();
    };
  }, [active, discardPendingRaw, enqueueRawWrite, ws, sessionName]);

  // Handle terminal.stream_reset — reset xterm state so stale ANSI doesn't corrupt (Task 5.4)
  useEffect(() => {
    if (!ws || !active) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'terminal.stream_reset' && msg.session === sessionName) {
        discardPendingRaw();
        termRef.current?.reset();
        linesRef.current = [];
      }
    });
    return unsub;
  }, [active, discardPendingRaw, ws, sessionName]);

  const applyDiff = useCallback((diff: TerminalDiff) => {
    if (!activeRef.current) return;
    const term = termRef.current;
    if (!term) return;
    if (
      previewRef.current
      && lastRawWriteAtRef.current > 0
      && Date.now() - lastRawWriteAtRef.current < PREVIEW_DIFF_SUPPRESS_AFTER_RAW_MS
    ) {
      return;
    }

    // `rows` and every `lineIdx` arrive over the wire. Clamp before growing the
    // array: the loops below are synchronous, so a single bad value would lock
    // the main thread hard enough that the tab cannot even process a reload.
    //
    // See resolveDiffRows: an absent `rows` bounds allocation but must not be
    // read as "zero rows", or incremental frames stop painting entirely.
    const { declaredRows, rows } = resolveDiffRows(diff.rows);
    const lines = linesRef.current;
    for (const [lineIdx, content] of diff.lines) {
      if (!isRenderableLineIndex(lineIdx, rows)) continue;
      while (lines.length <= lineIdx) lines.push('');
      lines[lineIdx] = content;
    }
    if (declaredRows !== null) {
      while (lines.length < declaredRows) lines.push('');
      linesRef.current = lines.slice(0, declaredRows);
    } else {
      linesRef.current = lines;
    }

    if (diff.fullFrame) {
      // Full frame: rewrite entire screen from cursor home
      let buf = '\x1b[H';
      for (let i = 0; i < linesRef.current.length; i++) {
        buf += (linesRef.current[i] ?? '') + '\x1b[K';
        if (i < linesRef.current.length - 1) buf += '\r\n';
      }
      buf += '\x1b[J';
      term.write(buf, () => {
        autoFollowRef.current = true;
        term.scrollToBottom();
      });
    } else if (diff.lines.length > 0) {
      // Partial update: only write changed lines using cursor addressing
      let buf = '';
      for (const [lineIdx, content] of diff.lines) {
        // Same predicate as the line-array path above. Bounding only by
        // TERMINAL_MAX_ROWS was not enough: the array path additionally slices
        // to `rows`, so a lineIdx between rows and the max was dropped from the
        // array yet still written to xterm — the two disagreed about which rows
        // exist, and the write addressed a row outside the declared screen.
        if (!isRenderableLineIndex(lineIdx, rows)) continue;
        // CSI row;col H — 1-based row addressing
        buf += `\x1b[${lineIdx + 1};1H${content}\x1b[K`;
      }
      term.write(buf);
    }

    // Always scroll to bottom on new content (fullFrame handles its own scroll internally).
    //
    // Single-flight. This is the highest-frequency frame scheduler in the
    // component: one `terminal.diff` arrives per PTY update, and diffs keep
    // arriving while the display is asleep because WebSocket messages are I/O,
    // not throttled timers. `requestAnimationFrame` on the other hand does not
    // run at all with no frames being produced, so a naive rAF-per-diff builds
    // an unbounded backlog for the whole lock and the browser executes every
    // one of them inside the first frame after unlock.
    if (!diff.fullFrame) scheduleScrollToBottom();
  }, [scheduleScrollToBottom]);

  const applyHistory = useCallback((content: string) => {
    if (!activeRef.current) return;
    const term = termRef.current;
    if (!term || !content) return;
    // Write history into scrollback as a single batched write to reduce main-thread churn.
    // We use the normal buffer — history goes above current viewport.
    const historyLines = content.split('\n');
    const batch = historyLines.map((l) => l + '\r\n').join('');
    term.write(batch);
  }, []);

  useEffect(() => {
    onDiff?.(applyDiff);
  }, [applyDiff, onDiff]);

  useEffect(() => {
    onHistory?.(applyHistory);
  }, [applyHistory, onHistory]);

  useEffect(() => {
    if (active) return;
    if (scrollHideTimerRef.current) {
      clearTimeout(scrollHideTimerRef.current);
      scrollHideTimerRef.current = null;
    }
    setShowScrollbar(false);
    setScrolledUp(false);
    setScrollProgress(1);
  }, [active]);

  const scrollToBottom = () => {
    // Re-enter auto-follow mode (State 2) before scrolling
    autoFollowRef.current = true;
    termRef.current?.scrollToBottom();
  };

  return (
    <div class="terminal-wrap" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <div
        ref={containerRef}
        class="terminal-container"
        style={{ width: '100%', height: '100%', overflow: 'hidden' }}
        onClick={isMobile ? undefined : () => {
          fitRef.current?.fit();
          termRef.current?.focus();
        }}
        onTouchStart={isMobile ? (e) => {
          isTouchingRef.current = true;
          const t = e.touches[0];
          touchStartPosRef.current = { x: t.clientX, y: t.clientY };
          if (!mobileInput) e.preventDefault(); // block keyboard popup — except for shell sessions
        } : undefined}
        onTouchEnd={isMobile ? (e) => {
          isTouchingRef.current = false;
          lastTouchEndRef.current = Date.now();
          const startPos = touchStartPosRef.current;
          touchStartPosRef.current = null;
          // For shell sessions: focus xterm textarea to trigger keyboard (tap only, not scroll)
          if (mobileInput && termRef.current && startPos) {
            const t = e.changedTouches[0];
            const dx = Math.abs(t.clientX - startPos.x);
            const dy = Math.abs(t.clientY - startPos.y);
            if (dx < 10 && dy < 10) termRef.current.focus();
          }
        } : undefined}
        onTouchCancel={isMobile ? () => {
          isTouchingRef.current = false;
          lastTouchEndRef.current = Date.now();
          touchStartPosRef.current = null;
        } : undefined}
      />

      {/* Scroll progress bar — right edge, only visible while scrolling */}
      {showScrollbar && (
        <div class="term-scroll-track">
          <div class="term-scroll-thumb" style={{ top: `${scrollProgress * 100}%` }} />
        </div>
      )}

      {/* Scroll to bottom button */}
      {scrolledUp && (
        <button class="term-scroll-bottom" onClick={scrollToBottom} title="Scroll to bottom">
          ↓
        </button>
      )}
    </div>
  );
}
