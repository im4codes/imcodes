import { useEffect, useRef, useCallback, useState } from 'preact/hooks';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';

interface Props {
  sessionName: string;
  ws: WsClient | null;
  connected?: boolean;
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

export function TerminalView({ sessionName, ws, connected, onDiff, onHistory, onFocusFn, onFitFn, onScrollBottomFn, mobileInput }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const linesRef = useRef<string[]>([]);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  // Touch scroll tracking: suppress auto-scroll for 1s after user releases touch
  const lastTouchEndRef = useRef<number>(0);
  const isTouchingRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // User intent: true = auto-follow bottom (State 2), false = user scrolled up (State 1).
  // Only changed by real user scroll actions (onScroll), NOT by onLineFeed/writes.
  // This prevents intermediate xterm write states from corrupting the follow flag.
  const autoFollowRef = useRef(true);
  // Count of in-progress term.write() calls. While > 0, onScroll must NOT update
  // autoFollowRef — xterm fires onScroll internally during write (cursor-follow),
  // which would corrupt the user's sticky intent.
  const writingCountRef = useRef(0);
  // True while a fit/resize is in progress — suppress scroll-up intent detection
  // because fitAddon.fit() causes xterm buffer reflow which can fire onScroll
  // with viewportY=0 even though the user never scrolled up.
  const fittingRef = useRef(false);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Scroll state: show button + progress bar when scrolled up
  const [scrolledUp, setScrolledUp] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(1); // 0..1, 1 = bottom
  const scrollHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showScrollbar, setShowScrollbar] = useState(false);

  useEffect(() => {
    const term = new Terminal({
      theme: {
        background: '#0f0f13',
        foreground: '#e2e8f0',
        cursor: '#3b82f6',
        selectionBackground: '#1d4ed860',
      },
      fontFamily: "'Cascadia Code', 'Fira Code', 'SF Mono', monospace",
      fontSize: 13,
      lineHeight: 1.4,
      convertEol: true,
      scrollback: 5000,
      allowTransparency: false,
      cursorBlink: true,
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
        const el = containerRef.current;
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          fittingRef.current = true;
          fitAddon.fit();
          requestAnimationFrame(() => { fittingRef.current = false; });
          fitDone = true;
        }
      };
      requestAnimationFrame(() => {
        doFit();
        if (!fitDone) requestAnimationFrame(() => { doFit(); });
      });
      // Fallback: force a fit after 400ms for slow mobile renders
      fitTimer = setTimeout(() => {
        if (!fitDone) {
          fittingRef.current = true;
          fitAddon.fit();
          requestAnimationFrame(() => { fittingRef.current = false; });
          fitDone = true;
        }
      }, 400);
      // Auto-focus terminal on mount for desktop keyboard input
      if (!isMobile) {
        requestAnimationFrame(() => term.focus());
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
    const doFitAndSnap = () => {
      fittingRef.current = true;
      fitAddon.fit();
      // Use rAF so the reflow onScroll events fire before we clear fittingRef
      requestAnimationFrame(() => {
        fittingRef.current = false;
        term.scrollToBottom();
        autoFollowRef.current = true;
      });
    };
    onFitFn?.(doFitAndSnap);

    // Re-fit when window regains focus or tab becomes visible.
    const onWindowFocus = () => { doFitAndSnap(); };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') { doFitAndSnap(); }
    };
    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    const handleResize = (rect?: DOMRectReadOnly) => {
      // Skip when container is hidden (display:none → dimensions are 0)
      if (!rect || rect.width === 0 || rect.height === 0) return;
      fittingRef.current = true;
      fitAddon.fit();
      // Snap to bottom immediately after fit (reflow can reset viewportY to 0)
      term.scrollToBottom();
      autoFollowRef.current = true;
      requestAnimationFrame(() => { fittingRef.current = false; });
      // NOTE: do NOT repaint linesRef.current here — xterm reflows on resize natively,
      // and repainting with stale diff buffer clobbers live PTY output (especially on mobile
      // where viewport resizes frequently due to address bar / keyboard show/hide).
    };

    const observer = new ResizeObserver((entries) => {
      handleResize(entries[0]?.contentRect);
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
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionName]); // eslint-disable-line react-hooks/exhaustive-deps

  // When WS reconnects (connected → true), re-send terminal dimensions so tmux
  // always matches xterm — prevents garbled/corrupted display (花屏).
  // Skip when hidden (chat mode) — parent handles that with 200x50.
  useEffect(() => {
    if (!connected) return;
    const el = containerRef.current;
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return; // hidden (chat mode)
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws) {
      ws.sendResize(sessionName, term.cols, term.rows);
    }
  }, [connected, sessionName]);

  // Raw PTY bytes: feed directly into xterm.js.
  // Use useEffect so cleanup properly unsubscribes this specific handler instance,
  // allowing multiple TerminalViews for the same session (e.g. preview card + window).
  useEffect(() => {
    if (!ws) return;
    return ws.onTerminalRaw(sessionName, (data: Uint8Array) => {
      const term = termRef.current;
      if (!term) return;
      writingCountRef.current++;
      term.write(data, () => {
        writingCountRef.current--;
        // Snap to bottom after each PTY write. CC redraws its UI from cursor-home
        // (\x1b[H) which makes xterm follow the cursor to the top; snapping here
        // ensures the viewport stays at the bottom showing the latest output.
        term.scrollToBottom();
      });
    });
  }, [ws, sessionName]);

  // Handle terminal.stream_reset — reset xterm state so stale ANSI doesn't corrupt (Task 5.4)
  useEffect(() => {
    if (!ws) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'terminal.stream_reset' && msg.session === sessionName) {
        termRef.current?.reset();
        linesRef.current = [];
      }
    });
    return unsub;
  }, [ws, sessionName]);

  const applyDiff = useCallback((diff: TerminalDiff) => {
    const term = termRef.current;
    if (!term) return;

    const lines = linesRef.current;
    for (const [lineIdx, content] of diff.lines) {
      while (lines.length <= lineIdx) lines.push('');
      lines[lineIdx] = content;
    }
    while (lines.length < diff.rows) lines.push('');
    linesRef.current = lines.slice(0, diff.rows);

    if (diff.fullFrame) {
      // Full frame: rewrite entire screen from cursor home
      let buf = '\x1b[H';
      for (let i = 0; i < linesRef.current.length; i++) {
        buf += (linesRef.current[i] ?? '') + '\x1b[K';
        if (i < linesRef.current.length - 1) buf += '\r\n';
      }
      buf += '\x1b[J';
      writingCountRef.current++;
      term.write(buf, () => {
        writingCountRef.current--;
        autoFollowRef.current = true;
        term.scrollToBottom();
      });
    } else if (diff.lines.length > 0) {
      // Partial update: only write changed lines using cursor addressing
      let buf = '';
      for (const [lineIdx, content] of diff.lines) {
        // CSI row;col H — 1-based row addressing
        buf += `\x1b[${lineIdx + 1};1H${content}\x1b[K`;
      }
      term.write(buf);
    }

    // Always scroll to bottom on new content (fullFrame handles its own scroll internally).
    if (!diff.fullFrame) {
      requestAnimationFrame(() => term.scrollToBottom());
    }
  }, []);

  const applyHistory = useCallback((content: string) => {
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
        onClick={isMobile ? undefined : () => { fitRef.current?.fit(); }}
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
