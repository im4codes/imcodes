/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Merges consecutive streaming assistant.text events into single blocks.
 * Supports basic Markdown rendering (code blocks, inline code, bold).
 */
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent, WsClient } from '../ws-client.js';
import { FileBrowser } from './FileBrowser.js';
import { FloatingPanel } from './FloatingPanel.js';
import { ChatMarkdown } from './ChatMarkdown.js';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling new events after a cache hit */
  refreshing?: boolean;
  /** True while loading older events via backward pagination */
  loadingOlder?: boolean;
  /** Called when user wants to load older messages */
  onLoadOlder?: () => void;
  sessionState?: string;
  sessionId?: string | null;
  /** Receives a function that forces the chat list to scroll to the bottom. */
  onScrollBottomFn?: (fn: () => void) => void;
  /** When true, render as a non-interactive preview (no scroll button, no status bar) */
  preview?: boolean;
  /** When provided, clicking file paths in chat messages opens FileBrowser */
  ws?: WsClient | null;
  /** Called when user inserts a path via the FileBrowser opened from a chat message */
  onInsertPath?: (path: string) => void;
  /** Session working directory — used to resolve relative paths clicked in chat */
  workdir?: string | null;
  /** Called when user quotes selected text. */
  onQuote?: (text: string) => void;
  /** Server ID for file transfer download API. */
  serverId?: string;
}

/** A merged view item — either a single event, merged assistant text, or collapsed tool group. */
interface ViewItem {
  key: string;
  type: 'event' | 'assistant-block' | 'tool-group';
  event?: TimelineEvent;
  /** Merged text for assistant-block */
  text?: string;
  /** All events in a collapsed tool group (first, middle..., last) */
  toolEvents?: TimelineEvent[];
  ts?: number;
  lastTs?: number;
}

/** Merge consecutive assistant.text events into blocks for display.
 *  Also:
 *  - Merge consecutive tool.call + tool.result pairs into compact single lines
 *  - Deduplicate consecutive session.state events with same state (keep last)
 */
function buildViewItems(events: TimelineEvent[]): ViewItem[] {
  // Filter out transient/noisy event types that don't belong in the chat log:
  // - agent.status, usage.update: stats, not chat content
  // - mode.state: shown elsewhere (tabs/header)
  // - command.ack, terminal.snapshot: internal plumbing
  const visible = events.filter(
    (e) =>
      !e.hidden &&
      e.type !== 'agent.status' &&
      e.type !== 'usage.update' &&
      e.type !== 'mode.state' &&
      e.type !== 'command.ack' &&
      e.type !== 'terminal.snapshot' &&
      e.type !== 'assistant.thinking',
  );

  // Pre-pass: merge tool.call+tool.result pairs and dedup session.state
  const consolidated: TimelineEvent[] = [];
  // Track tool.result eventIds that have been consumed by a preceding tool.call merge
  const consumedIds = new Set<string>();

  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i];

    // Skip already-consumed tool.result events
    if (consumedIds.has(ev.eventId)) continue;

    // Merge tool.call with its matching tool.result.
    // Scan forward up to 10 events to find the tool.result — user.message /
    // command.ack etc. can land between them during a long-running tool.
    if (ev.type === 'tool.call') {
      let resultIdx = -1;
      for (let j = i + 1; j <= Math.min(i + 10, visible.length - 1); j++) {
        if (visible[j].type === 'tool.result') { resultIdx = j; break; }
        if (visible[j].type === 'tool.call') break; // another call started, stop
      }
      if (resultIdx !== -1) {
        const next = visible[resultIdx];
        consumedIds.add(next.eventId); // mark tool.result as consumed
        const toolName = String(ev.payload.tool ?? 'tool');
        const input = ev.payload.input ? ` ${String(ev.payload.input)}` : '';
        const status = next.payload.error ? `✗ ${String(next.payload.error)}` : '✓';
        consolidated.push({
          ...ev,
          type: 'tool.call',
          payload: { ...ev.payload, tool: toolName, input: `${input} ${status}`.trim(), _merged: true },
        });
        continue;
      }
    }

    // Deduplicate consecutive session.state events with the same state — keep last
    if (ev.type === 'session.state') {
      const next = visible[i + 1];
      if (next && next.type === 'session.state' && String(next.payload.state) === String(ev.payload.state)) {
        continue; // skip — keep the next (checked again on next iteration)
      }
    }

    consolidated.push(ev);
  }

  // Main pass: merge assistant.text blocks + group consecutive tool.call runs
  const items: ViewItem[] = [];
  let pendingText: string[] = [];
  let pendingFirstTs = 0;
  let pendingLastTs = 0;
  let pendingKey = '';
  let pendingTools: TimelineEvent[] = [];
  let deferredEvents: TimelineEvent[] = [];

  const flushPending = () => {
    if (pendingText.length > 0) {
      items.push({
        key: pendingKey,
        type: 'assistant-block',
        text: pendingText.join('\n'),
        ts: pendingFirstTs,
        lastTs: pendingLastTs,
      });
      pendingText = [];
    }
  };

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    if (pendingTools.length === 1) {
      items.push({ key: pendingTools[0].eventId, type: 'event', event: pendingTools[0] });
    } else {
      // 2+ consecutive tool events → collapsible group
      items.push({
        key: `tg_${pendingTools[0].eventId}`,
        type: 'tool-group',
        toolEvents: [...pendingTools],
      });
    }
    pendingTools = [];
    // Flush any session.state events that were deferred to avoid breaking the group
    for (const ev of deferredEvents) items.push({ key: ev.eventId, type: 'event', event: ev });
    deferredEvents = [];
  };

  for (const event of consolidated) {
    if (event.type === 'assistant.text') {
      flushTools();
      // Trim and collapse 3+ consecutive blank lines to 1 (CC output often has many trailing newlines)
      const text = String(event.payload.text ?? '').trim().replace(/\n{3,}/g, '\n\n');
      if (!text) continue;
      if (pendingText.length === 0) {
        pendingKey = event.eventId;
        pendingFirstTs = event.ts;
      }
      pendingLastTs = event.ts;
      pendingText.push(text);
    } else if (event.type === 'tool.call' || event.type === 'tool.result') {
      flushPending();
      pendingTools.push(event);
    } else if (event.type === 'assistant.thinking' && pendingTools.length > 0) {
      // Thinking events between tool calls — defer to render after the tool group
      deferredEvents.push(event);
    } else if (event.type === 'session.state' && pendingTools.length > 0) {
      // session.state hooks can fire between tool calls (e.g. CC notification hook).
      // Defer: render after the tool group closes.
      deferredEvents.push(event);
    } else {
      flushPending();
      flushTools();
      items.push({ key: event.eventId, type: 'event', event });
    }
  }
  flushPending();
  flushTools();

  return items;
}

interface SelectionMenu {
  x: number;
  y: number;
  text: string;
}

const FILE_PANEL_MIN = 220;
const FILE_PANEL_MAX_RATIO = 0.6; // 60% of viewport width
const FILE_PANEL_DEFAULT = 340;
const panelWidthKey = (id: string | null | undefined) => `chatFilePanelWidth:${id ?? '_'}`;
const panelOpenKey  = (id: string | null | undefined) => `chatFilePanelOpen:${id ?? '_'}`;

function readPanelWidth(id: string | null | undefined): number {
  try { return parseInt(localStorage.getItem(panelWidthKey(id)) ?? String(FILE_PANEL_DEFAULT), 10); } catch { return FILE_PANEL_DEFAULT; }
}
function readPanelOpen(id: string | null | undefined): boolean {
  try { return localStorage.getItem(panelOpenKey(id)) === '1'; } catch { return false; }
}

export function ChatView({ events, loading, refreshing, loadingOlder, onLoadOlder, sessionState, sessionId, onScrollBottomFn, preview, ws, onInsertPath, workdir, serverId, onQuote }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [fileBrowserPath, setFileBrowserPath] = useState<string | null>(null);
  const [selMenu, setSelMenu] = useState<SelectionMenu | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [highlightEl, setHighlightEl] = useState<HTMLElement | null>(null);
  const highlightElRef = useRef(highlightEl);
  highlightElRef.current = highlightEl;
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  // Timestamp when ctx menu was opened — clicks within 400ms are synthetic (from long-press release)
  const menuOpenedAtRef = useRef(0);

  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Track tool.call events to trigger file panel refresh
  const [filePanelRefreshTrigger, setFilePanelRefreshTrigger] = useState(0);
  const lastToolCallTsRef = useRef(0);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'tool.call') {
        if (e.ts > lastToolCallTsRef.current) {
          lastToolCallTsRef.current = e.ts;
          const id = setTimeout(() => setFilePanelRefreshTrigger((n) => n + 1), 1000);
          return () => clearTimeout(id);
        }
        break;
      }
    }
  }, [events]);

  // Split-screen file panel — width and open state are per-session
  const [showFilePanel, setShowFilePanel] = useState(() => readPanelOpen(sessionId));
  const [filePanelWidth, setFilePanelWidth] = useState(() => readPanelWidth(sessionId));
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const filePanelWidthRef = useRef(filePanelWidth);
  filePanelWidthRef.current = filePanelWidth;

  // Re-load per-session values when sessionId changes
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId === prevSessionIdRef.current) return;
    prevSessionIdRef.current = sessionId;
    setShowFilePanel(readPanelOpen(sessionId));
    setFilePanelWidth(readPanelWidth(sessionId));
  }, [sessionId]);

  const toggleFilePanel = useCallback(() => {
    setShowFilePanel((v) => {
      const next = !v;
      try { localStorage.setItem(panelOpenKey(sessionId), next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, [sessionId]);

  const onDragStart = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: filePanelWidthRef.current };
    const onMove = (ev: MouseEvent) => {
      if (!dragStateRef.current) return;
      const delta = dragStateRef.current.startX - ev.clientX;
      const maxW = Math.floor(window.innerWidth * FILE_PANEL_MAX_RATIO);
      const newW = Math.max(FILE_PANEL_MIN, Math.min(maxW, dragStateRef.current.startWidth + delta));
      setFilePanelWidth(newW);
    };
    const onUp = () => {
      try { localStorage.setItem(panelWidthKey(sessionId), String(filePanelWidthRef.current)); } catch { /* ignore */ }
      dragStateRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [sessionId]);

  const viewItems = useMemo(() => buildViewItems(events), [events]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  };

  // On session change, reset scroll position to bottom
  useEffect(() => {
    autoScrollRef.current = true;
    hasInitialScrolledRef.current = false;
    setShowScrollBtn(false);
    // Force scroll to bottom on tab switch — the auto-scroll effect may not fire
    // if no new events arrived while this tab was inactive.
    requestAnimationFrame(() => scrollToBottom());
  }, [sessionId]);

  // On mobile: when keyboard opens, viewport shrinks and scrollTop can reset to 0.
  // Save scrollTop on focusin, restore it when visualViewport height decreases (keyboard appeared).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let savedScrollTop = 0;
    let prevHeight = vv.height;
    const onFocusIn = () => {
      savedScrollTop = scrollRef.current?.scrollTop ?? 0;
    };
    const onResize = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (vv.height < prevHeight) {
        // Keyboard appeared — restore scroll position
        el.scrollTop = savedScrollTop;
      }
      prevHeight = vv.height;
    };
    vv.addEventListener('resize', onResize);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      vv.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  // Expose scroll-to-bottom fn to parent (stable when parent uses useCallback).
  useEffect(() => {
    onScrollBottomFn?.(scrollToBottom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScrollBottomFn]);

  // Scroll to bottom once on mount (e.g. when switching terminal→chat).
  // Keep separate from fn-registration so parent re-renders don't re-trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scrollToBottom(); }, []);

  // Auto-scroll only on visible new events — agent.status / assistant.thinking / usage.update
  // events are filtered from the chat view but still part of `events`, so using the raw last ts
  // would trigger spurious scrolls while the agent is running without any new visible content.
  const lastVisibleTs = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e.hidden && e.type !== 'agent.status' && e.type !== 'usage.update') {
        return e.ts;
      }
    }
    return 0;
  }, [events]);
  const prevVisibleTsRef = useRef(lastVisibleTs);
  const hasInitialScrolledRef = useRef(false);

  // Synchronous scroll-to-bottom BEFORE paint on initial history load.
  // useLayoutEffect runs after DOM mutation but before the browser paints,
  // so the user never sees content at the top position.
  useLayoutEffect(() => {
    if (preview) return;
    if (!hasInitialScrolledRef.current && lastVisibleTs > 0) {
      hasInitialScrolledRef.current = true;
      scrollToBottom();
    }
  }, [lastVisibleTs]);

  // Subsequent auto-scroll (new messages while at bottom) — use rAF for smooth updates.
  useEffect(() => {
    const changed = lastVisibleTs !== prevVisibleTsRef.current;
    prevVisibleTsRef.current = lastVisibleTs;
    if (!changed && !preview) return;
    requestAnimationFrame(() => {
      if (preview) { scrollToBottom(); return; }
      if (autoScrollRef.current) scrollToBottom();
    });
  }, [lastVisibleTs, preview]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Use generous threshold — 150px from bottom still counts as "at bottom"
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
  };

  // Keep the active chat pinned to bottom when layout changes reduce available height
  // (for example, when the sub-session bar appears after tab switch).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    let prevClientHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      const nextClientHeight = el.clientHeight;
      if (nextClientHeight === prevClientHeight) return;
      prevClientHeight = nextClientHeight;
      if (!preview && autoScrollRef.current) {
        requestAnimationFrame(() => scrollToBottom());
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [preview]);

  const isTouchDevice = 'ontouchstart' in window;

  // Desktop: show selection popup menu when text is selected within the chat view
  useEffect(() => {
    if (isTouchDevice) return; // mobile uses long-press instead
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const container = scrollRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setSelMenu(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) { setSelMenu(null); return; }
      const selRect = range.getBoundingClientRect();
      const wrapEl = container.closest('.chat-view-wrap') as HTMLElement | null;
      const wrapRect = (wrapEl ?? container).getBoundingClientRect();
      setSelMenu({
        x: selRect.left + selRect.width / 2 - wrapRect.left,
        y: selRect.top - wrapRect.top,
        text,
      });
      setCopied(false);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, [isTouchDevice]);

  // Show custom context menu (Copy/Quote) at given position for given target element.
  const openCtxMenu = useCallback((target: HTMLElement, clientX: number, clientY: number) => {
    if (highlightElRef.current) highlightElRef.current.classList.remove('chat-highlight');
    target.classList.add('chat-highlight');
    setHighlightEl(target);
    const text = (target.textContent ?? '').trim();
    if (!text) return;
    const mainEl = scrollRef.current?.closest('.chat-main') as HTMLElement | null;
    const mainRect = (mainEl ?? scrollRef.current!).getBoundingClientRect();
    menuOpenedAtRef.current = Date.now();
    setCtxMenu({
      x: Math.max(40, Math.min(clientX - mainRect.left, mainRect.width - 80)),
      y: Math.max(10, Math.min(clientY - mainRect.top - 40, mainRect.height - 120)),
      text,
    });
  }, []);

  // Desktop: right-click → contextmenu event → custom menu
  const handleContextMenu = useCallback((e: Event) => {
    if (preview) return;
    e.preventDefault();
    const target = (e.target as HTMLElement)?.closest?.('.chat-event') as HTMLElement | null;
    if (!target) return;
    const me = e as MouseEvent;
    openCtxMenu(target, me.clientX ?? 0, me.clientY ?? 0);
  }, [preview, openCtxMenu]);

  // Mobile: touch timer long-press (450ms) → custom menu.
  // Native contextmenu doesn't fire on iOS when user-select:none + touch-callout:none are set.
  useEffect(() => {
    if (!isTouchDevice || preview) return;
    const container = scrollRef.current;
    if (!container) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0, startY = 0;

    // Telegram pattern: eat the touchend + subsequent click after menu opens
    const cancelEvent = (e: Event) => { e.preventDefault(); e.stopPropagation(); };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) return; // multi-touch → cancel
      const t = e.touches[0];
      startX = t.clientX; startY = t.clientY;
      const targetEl = e.target as HTMLElement;
      timer = setTimeout(() => {
        timer = null;
        const chatEvent = targetEl.closest?.('.chat-event') as HTMLElement | null;
        if (!chatEvent) return;
        openCtxMenu(chatEvent, startX, startY);
        // One-shot: eat the touchend that follows to prevent synthetic click from closing menu
        container.addEventListener('touchend', cancelEvent, { once: true, capture: true });
      }, 400);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!timer) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
        clearTimeout(timer); timer = null;
      }
    };

    const onTouchEnd = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('touchend', cancelEvent, { capture: true } as EventListenerOptions);
    };
  }, [isTouchDevice, preview, openCtxMenu]);

  const canShowFilePanel = !preview && !!ws;

  return (
    <div class={`chat-view-wrap${canShowFilePanel && showFilePanel ? ' chat-split' : ''}`}>
      {canShowFilePanel && (
        <button
          class={`chat-panel-toggle${showFilePanel ? ' active' : ''}`}
          onClick={toggleFilePanel}
          title={showFilePanel ? t('chat.hide_file_panel') : t('chat.show_file_panel')}
        >
          ⊞
        </button>
      )}
      {refreshing && <div class="chat-refreshing">{t('chat.syncing')}</div>}
      <div class="chat-main">
        <div class={`chat-view${preview ? ' chat-view-preview' : ''}`} ref={scrollRef} onScroll={preview ? undefined : handleScroll}
          onContextMenu={!preview && !isTouchDevice ? handleContextMenu : undefined}
          onClick={(highlightEl || ctxMenu) ? () => {
            // Ignore synthetic click from long-press release (within 400ms of menu opening)
            if (Date.now() - menuOpenedAtRef.current < 400) return;
            if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
            setCtxMenu(null);
          } : undefined}
        >
          {loading ? (
            <div class="chat-loading">{t('chat.loading')}</div>
          ) : viewItems.length === 0 ? (
            <div class="chat-loading">
              {sessionState ? t('chat.session_state', { state: sessionState }) : t('chat.no_events')}
            </div>
          ) : null}
          {!loading && !preview && onLoadOlder && viewItems.length > 0 && (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <button
                class="btn btn-sm"
                style={{ fontSize: 11, opacity: 0.7 }}
                onClick={onLoadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? t('chat.loading_older') : t('chat.load_older')}
              </button>
            </div>
          )}
          {!loading && viewItems.map((item, idx) => {
            const nextItem = viewItems[idx + 1];
            const nextTs = nextItem?.ts ?? nextItem?.event?.ts;
            const onPathClick = ws && !preview ? (p: string) => setFileBrowserPath(p) : undefined;
            const onUrlClick = !preview ? (url: string) => setPendingUrl(url) : undefined;
            return item.type === 'assistant-block' ? (
              <div key={item.key} class="chat-event chat-assistant">
                <ChatMarkdown text={item.text!} onPathClick={onPathClick} onUrlClick={onUrlClick} />
                <ChatTime ts={item.lastTs ?? item.ts ?? 0} />
              </div>
            ) : item.type === 'tool-group' ? (
              <ToolCallGroup key={item.key} events={item.toolEvents!} onPathClick={onPathClick} />
            ) : (
              <ChatEvent key={item.key} event={item.event!} nextTs={nextTs} onPathClick={onPathClick} serverId={serverId} />
            );
          })}
          {!loading && <div ref={bottomRef} />}
        </div>
        {!preview && showScrollBtn && (
          <button
            class="chat-scroll-btn"
            onClick={() => {
              autoScrollRef.current = true;
              setShowScrollBtn(false);
              scrollToBottom();
            }}
          >
            ↓
          </button>
        )}
        {selMenu && !preview && (
          <div
            class="chat-sel-menu"
            style={{ left: `${selMenu.x}px`, top: `${selMenu.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              class={`chat-sel-btn${copied ? ' copied' : ''}`}
              onClick={() => {
                navigator.clipboard.writeText(selMenu.text).then(() => {
                  setCopied(true);
                  setTimeout(() => {
                    setSelMenu(null);
                    setCopied(false);
                  }, 1000);
                });
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            {onQuote && (
              <button
                class="chat-sel-btn"
                onClick={() => {
                  onQuote(selMenu.text);
                  setSelMenu(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                {t('common.quote', 'Quote')}
              </button>
            )}
          </div>
        )}
        {ctxMenu && !preview && (
          <div
            class="chat-sel-menu"
            style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              class={`chat-sel-btn${copied ? ' copied' : ''}`}
              onClick={() => {
                navigator.clipboard.writeText(ctxMenu.text).then(() => {
                  setCopied(true);
                  setTimeout(() => { setCtxMenu(null); setCopied(false); if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); } }, 800);
                });
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            {onQuote && (
              <>
              <button
                class="chat-sel-btn"
                onClick={() => {
                  onQuote(ctxMenu.text);
                  setCtxMenu(null);
                  if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
                }}
              >
                {t('common.quote', 'Quote')}
              </button>
              <button
                class="chat-sel-btn"
                onClick={() => {
                  onQuote(ctxMenu.text);
                  setCtxMenu(null);
                  if (highlightEl) { highlightEl.classList.remove('chat-highlight'); setHighlightEl(null); }
                }}
              >
                {t('common.quote_block', 'Quote All')}
              </button>
              </>
            )}
          </div>
        )}
      </div>
      {canShowFilePanel && showFilePanel && ws && (
        <>
          <div class="chat-panel-drag" onMouseDown={onDragStart} />
          <div class="chat-file-panel" style={{ width: `${filePanelWidth}px`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', background: '#1e293b', borderBottom: '1px solid #334155' }}>
              <span style={{ flex: 1, fontSize: 11, color: '#64748b' }}>{t('picker.files')}</span>
              <button onClick={() => { setShowFilePanel(false); try { localStorage.setItem(panelOpenKey(sessionId), '0'); } catch { /* ignore */ } }} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}>✕</button>
            </div>
            <FileBrowser
              ws={ws}
              mode="file-single"
              layout="panel"
              initialPath={workdir ?? '~'}
              hideFooter
              changesRootPath={workdir ?? undefined}
              refreshTrigger={filePanelRefreshTrigger}
              onConfirm={(paths) => {
                if (paths[0]) onInsertPath?.(paths[0]);
              }}
            />
          </div>
        </>
      )}
      {/* External link confirm dialog */}
      {pendingUrl && (
        <div class="dialog-overlay" onClick={() => setPendingUrl(null)}>
          <div class="dialog-box" onClick={(e: Event) => e.stopPropagation()}>
            <div class="dialog-title">{t('chat.external_link_title')}</div>
            <p style={{ fontSize: 13, color: '#94a3b8', margin: '8px 0', wordBreak: 'break-all' }}>{pendingUrl}</p>
            <p style={{ fontSize: 12, color: '#f59e0b', margin: '8px 0' }}>{t('chat.external_link_warning')}</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button class="dialog-btn" onClick={() => setPendingUrl(null)}>{t('chat.external_link_cancel')}</button>
              <button class="dialog-btn dialog-btn-primary" onClick={() => {
                window.open(pendingUrl, '_blank', 'noopener,noreferrer');
                setPendingUrl(null);
              }}>{t('chat.external_link_open')}</button>
            </div>
          </div>
        </div>
      )}
      {fileBrowserPath && ws && (
        <FloatingPanel id="chat-file-preview" title={`📄 ${fileBrowserPath.split('/').pop() ?? 'File'}`} onClose={() => setFileBrowserPath(null)} defaultW={600} defaultH={500}>
          <FileBrowser
            ws={ws}
            mode="file-single"
            layout="panel"
            initialPath={(() => {
              const isAbsolute = fileBrowserPath.startsWith('/') || fileBrowserPath.startsWith('~');
              const resolved = isAbsolute ? fileBrowserPath : `${workdir ?? '~'}/${fileBrowserPath}`;
              return resolved.includes('.') && !resolved.endsWith('/')
                ? resolved.split('/').slice(0, -1).join('/') || '~'
                : resolved;
            })()}
            highlightPath={fileBrowserPath.startsWith('/') || fileBrowserPath.startsWith('~')
              ? fileBrowserPath
              : `${workdir ?? '~'}/${fileBrowserPath}`}
            autoPreviewPath={fileBrowserPath.startsWith('/') || fileBrowserPath.startsWith('~')
              ? fileBrowserPath
              : `${workdir ?? '~'}/${fileBrowserPath}`}
            onConfirm={(paths) => {
              if (paths[0]) onInsertPath?.(paths[0]);
              setFileBrowserPath(null);
            }}
            onClose={() => setFileBrowserPath(null)}
          />
        </FloatingPanel>
      )}
    </div>
  );
}

/** Unified tool block fold — collapses any tool content exceeding ~3 lines (54px). */
function ToolBlockFold({ children }: { children: preact.ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (!ref.current) return;
    setOverflows(ref.current.scrollHeight > 60);
  }, [children]);

  return (
    <div class={`chat-tool-block-fold${!expanded && overflows ? ' collapsed' : ''}`}>
      <div ref={ref} class="chat-tool-block-fold-content" style={!expanded && overflows ? { maxHeight: 54, overflow: 'hidden' } : undefined}>
        {children}
      </div>
      {overflows && !expanded && (
        <button class="chat-tool-fold-btn" onClick={() => setExpanded(true)}>
          {'··· more'}
        </button>
      )}
      {overflows && expanded && (
        <button class="chat-tool-fold-btn" onClick={() => setExpanded(false)}>
          {t('chat.tool_fold_collapse')}
        </button>
      )}
    </div>
  );
}

/** Collapsible group of consecutive tool events. Shows first and last, folds middle. */
function ToolCallGroup({ events, onPathClick }: { events: TimelineEvent[]; onPathClick?: (p: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const first = events[0];
  const last = events.length > 1 ? events[events.length - 1] : null;
  const middle = events.slice(1, last ? -1 : undefined);

  return (
    <div class="chat-tool-group">
      <ChatEvent event={first} onPathClick={onPathClick} />
      <div class="chat-tool-group-indent">
        {middle.length > 0 && (
          expanded ? (
            middle.map((ev) => <ChatEvent key={ev.eventId} event={ev} onPathClick={onPathClick} />)
          ) : (
            <button class="chat-tool-fold-btn" onClick={() => setExpanded(true)}>
              {t('chat.tool_group_more', { count: middle.length })}
            </button>
          )
        )}
        {last && <ChatEvent event={last} onPathClick={onPathClick} />}
        {expanded && middle.length > 0 && (
          <button class="chat-tool-fold-btn" onClick={() => setExpanded(false)}>
            {t('chat.tool_group_collapse')}
          </button>
        )}
      </div>
    </div>
  );
}

// ToolInputFold removed — replaced by unified ToolBlockFold (CSS max-height based)

function AttachmentDownloadButton({ att, serverId }: { att: { id: string; originalName?: string; size?: number }; serverId: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const label = att.originalName || att.id;
  const sizeLabel = att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : '';

  const handleError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('daemon_offline') || msg.includes('503')) setError(t('upload.daemon_offline'));
    else if (msg.includes('410') || msg.includes('expired')) setError(t('upload.download_expired'));
    else if (msg.includes('404')) setError(t('upload.download_expired'));
    else setError(t('upload.upload_failed'));
    setTimeout(() => setError(null), 5000);
  };

  return (
    <span class="chat-attachment-row" style={error ? { color: '#ef4444' } : undefined}>
      <button
        class="chat-attachment-dl"
        onClick={() => {
          setError(null);
          import('../api.js').then(({ previewAttachment }) => {
            previewAttachment(serverId, att.id).catch(handleError);
          });
        }}
        title={error || label}
      >
        {error ? `\u{26A0} ${error}` : `\u{1F4CE} ${label}${sizeLabel}`}
      </button>
      <button
        class="chat-attachment-dl-btn"
        onClick={() => {
          setError(null);
          import('../api.js').then(({ downloadAttachment }) => {
            downloadAttachment(serverId, att.id).catch(handleError);
          });
        }}
        title={t('common.download')}
      >
        ⬇
      </button>
    </span>
  );
}

const ChatEvent = memo(function ChatEvent({ event, nextTs, onPathClick, serverId }: { event: TimelineEvent; nextTs?: number; onPathClick?: (p: string) => void; serverId?: string }) {
  switch (event.type) {
    case 'user.message': {
      let userText = String(event.payload.text ?? '');
      const attachments = event.payload.attachments as Array<{ id: string; originalName?: string; mime?: string; size?: number; daemonPath?: string }> | undefined;
      // Strip @path references from text when they're shown as attachment badges
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          if (att.daemonPath) userText = userText.split(`@${att.daemonPath}`).join('').trim();
        }
      }
      return (
        <div class={`chat-event chat-user${event.payload.pending ? ' chat-pending' : ''}`}>
          {attachments && serverId && attachments.map((att) => (
            <AttachmentDownloadButton key={att.id} att={att} serverId={serverId} />
          ))}
          {userText && <div class="chat-bubble-content">{splitPathsAndUrls(userText, onPathClick)}</div>}
          {!event.payload.pending && <ChatTime ts={event.ts} />}
        </div>
      );
    }

    case 'tool.call': {
      const toolInput = event.payload.input ? String(event.payload.input) : '';
      return (
        <ToolBlockFold>
          <div class="chat-event chat-tool">
            <span class="chat-tool-icon">{'>'}</span>
            <span class="chat-tool-name">{String(event.payload.tool ?? 'tool')}</span>
            {toolInput && <span class="chat-tool-input">{' '}{splitPathsAndUrls(toolInput, onPathClick)}</span>}
          </div>
        </ToolBlockFold>
      );
    }

    case 'tool.result': {
      // Standalone tool.result (not merged) — still rendered for cases without a preceding call
      const error = event.payload.error;
      return (
        <div class="chat-event chat-tool">
          <span class="chat-tool-icon">{'<'}</span>
          {error ? (
            <span class="chat-tool-error">{`error: ${String(error)}`}</span>
          ) : (
            <span class="chat-tool-output">done</span>
          )}
        </div>
      );
    }

    case 'mode.state':
      return (
        <div class="chat-event">
          <span class="chat-mode">{String(event.payload.mode ?? event.payload.state ?? '')}</span>
        </div>
      );

    case 'session.state': {
      const state = String(event.payload.state ?? '');
      const stateLabel: Record<string, string> = {
        idle: 'Agent idle — waiting for input',
        running: 'Agent working...',
        started: 'Session started',
        starting: 'Session starting...',
        stopped: 'Session stopped',
      };
      return (
        <div class="chat-event chat-system">
          {stateLabel[state] ?? state}
          <ChatTime ts={event.ts} />
        </div>
      );
    }

    case 'assistant.thinking':
      return <ThinkingEvent event={event} endTs={nextTs} />;

    case 'terminal.snapshot':
      return <SnapshotEvent event={event} />;

    default:
      return null;
  }
});

function ActiveThinkingLabel({ startTs }: { startTs: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const sec = Math.max(0, Math.round((now - startTs) / 1000));
  return <>{t('chat.thinking_running', { sec })}</>;
}

const ThinkingEvent = memo(function ThinkingEvent({ event, endTs }: { event: TimelineEvent; endTs?: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const isActive = endTs === undefined;

  const text = String(event.payload.text ?? '');
  const preview = text.length > 100 ? text.slice(0, 100) + '…' : text;
  const hasText = text.length > 0;

  return (
    <div class={`chat-event chat-thinking${isActive ? ' thinking-active' : ''}`}>
      <button class={`chat-thinking-toggle${hasText ? '' : ' no-text'}`} onClick={hasText ? () => setExpanded(!expanded) : undefined}>
        <span class={`chat-thinking-dot${isActive ? '' : ' done'}`}>{isActive ? '◌' : '~'}</span>
        <span class="chat-thinking-label">
          {isActive
            ? <ActiveThinkingLabel startTs={event.ts ?? Date.now()} />
            : t('chat.thinking_done', { sec: Math.max(0, Math.round((endTs - (event.ts ?? endTs)) / 1000)) })}
        </span>
        {hasText && <span class="chat-thinking-text">{expanded ? text : preview}</span>}
      </button>
    </div>
  );
});

function SnapshotEvent({ event }: { event: TimelineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const lines = (event.payload.lines as string[] | undefined) ?? [];

  return (
    <div class="chat-event chat-system">
      <button
        class="chat-snapshot-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '[-] Terminal snapshot' : '[+] Terminal snapshot'}
      </button>
      {expanded && (
        <pre class="chat-snapshot-content">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

const ChatTime = memo(function ChatTime({ ts }: { ts: number }) {
  return (
    <div class="chat-bubble-time">
      {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  );
});

// ── Markdown rendering delegated to ChatMarkdown.tsx ──────────────────────

// ── URL detection (must run BEFORE path detection) ────────────────────────
const URL_REGEX = /https?:\/\/[^\s<>"\])}]+/g;

// Matches absolute paths (/foo/bar) and relative paths (docs/file.md, src/components/Foo.tsx).
const PATH_REGEX = /(\.{1,2}\/[\w.\-~/]+|\/[\w.\-~][\w.\-~/]*|(?<![:/\w])[a-zA-Z_~][\w.\-~]*(?:\/[\w.\-~]+)+)/g;

/** Split a plain-text segment into URL tokens, path tokens, and plain text. */
function splitPathsAndUrls(
  text: string,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
): h.JSX.Element[] {
  if (!onPathClick && !onUrlClick) return [<span>{text}</span>];

  // Step 1: Split by URLs first (URLs take priority over path detection)
  const parts: preact.JSX.Element[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_REGEX.lastIndex = 0;

  interface TextChunk { type: 'text' | 'url'; value: string; start: number }
  const chunks: TextChunk[] = [];

  while ((m = URL_REGEX.exec(text)) !== null) {
    if (m.index > last) chunks.push({ type: 'text', value: text.slice(last, m.index), start: last });
    // Strip trailing punctuation that likely isn't part of the URL
    let url = m[0];
    while (url.length > 1 && /[.,;:!?)}\]>]$/.test(url)) url = url.slice(0, -1);
    chunks.push({ type: 'url', value: url, start: m.index });
    last = m.index + url.length;
    URL_REGEX.lastIndex = last; // adjust for stripped chars
  }
  if (last < text.length) chunks.push({ type: 'text', value: text.slice(last), start: last });

  // Step 2: For text chunks, apply path detection. URL chunks render as links.
  for (const chunk of chunks) {
    if (chunk.type === 'url') {
      parts.push(
        <a
          key={`u${chunk.start}`}
          class="chat-external-link"
          href={chunk.value}
          title={chunk.value}
          onClick={(e: Event) => {
            e.preventDefault();
            onUrlClick?.(chunk.value);
          }}
        >
          {chunk.value}
        </a>,
      );
    } else if (onPathClick) {
      // Apply path detection only on non-URL text
      let pathLast = 0;
      PATH_REGEX.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PATH_REGEX.exec(chunk.value)) !== null) {
        const path = pm[1];
        if (path.length < 3) continue;
        if (pm.index > pathLast) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast, pm.index)}</span>);
        parts.push(
          <span
            key={`p${chunk.start + pm.index}`}
            class="chat-path-link"
            onClick={() => onPathClick(path)}
            title={path}
          >
            {path}
          </span>,
        );
        pathLast = pm.index + pm[0].length;
      }
      if (pathLast < chunk.value.length) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast)}</span>);
    } else {
      parts.push(<span key={`t${chunk.start}`}>{chunk.value}</span>);
    }
  }

  return parts.length ? parts : [<span>{text}</span>];
}

