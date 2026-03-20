/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Merges consecutive streaming assistant.text events into single blocks.
 * Supports basic Markdown rendering (code blocks, inline code, bold).
 */
import { h } from 'preact';
import { useEffect, useRef, useState, useMemo, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent, WsClient } from '../ws-client.js';
import { getActiveThinkingTs } from '../thinking-utils.js';
import { FileBrowser } from './FileBrowser.js';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling new events after a cache hit */
  refreshing?: boolean;
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
const FILE_PANEL_MAX = 900;
const FILE_PANEL_DEFAULT = 340;
const panelWidthKey = (id: string | null | undefined) => `chatFilePanelWidth:${id ?? '_'}`;
const panelOpenKey  = (id: string | null | undefined) => `chatFilePanelOpen:${id ?? '_'}`;

function readPanelWidth(id: string | null | undefined): number {
  try { return parseInt(localStorage.getItem(panelWidthKey(id)) ?? String(FILE_PANEL_DEFAULT), 10); } catch { return FILE_PANEL_DEFAULT; }
}
function readPanelOpen(id: string | null | undefined): boolean {
  try { return localStorage.getItem(panelOpenKey(id)) === '1'; } catch { return false; }
}

export function ChatView({ events, loading, refreshing, sessionState, sessionId, onScrollBottomFn, preview, ws, onInsertPath, workdir, serverId }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [fileBrowserPath, setFileBrowserPath] = useState<string | null>(null);
  const [selMenu, setSelMenu] = useState<SelectionMenu | null>(null);
  const [copied, setCopied] = useState(false);

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
      const newW = Math.max(FILE_PANEL_MIN, Math.min(FILE_PANEL_MAX, dragStateRef.current.startWidth + delta));
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

  // Extract active status: show last agent.status until any other event arrives after it
  const statusText = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'agent.status' && e.payload.label) return String(e.payload.label);
      if (e.type !== 'agent.status') break;
    }
    return null;
  }, [events]);

  // Earliest ts of the current continuous thinking sequence.
  // Multiple thinking events in one turn keep the original start ts (timer doesn't reset).
  const activeThinkingTs = useMemo(() => getActiveThinkingTs(events), [events]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  };

  // On session change, reset scroll position to bottom
  useEffect(() => {
    autoScrollRef.current = true;
    setShowScrollBtn(false);
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
  useEffect(() => {
    const changed = lastVisibleTs !== prevVisibleTsRef.current;
    prevVisibleTsRef.current = lastVisibleTs;
    if (!changed && !preview) return;
    // Check scroll position inside rAF to avoid race: user may have scrolled
    // between effect firing and rAF executing. Re-read DOM position instead of
    // trusting autoScrollRef which may have been set true by a prior scrollToBottom.
    requestAnimationFrame(() => {
      if (preview) { scrollToBottom(); return; }
      const el = scrollRef.current;
      if (!el) return;
      // Force scroll to bottom on initial history load (scrollTop is 0 at top, not at bottom).
      if (!hasInitialScrolledRef.current && lastVisibleTs > 0) {
        hasInitialScrolledRef.current = true;
        scrollToBottom();
        return;
      }
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

  // Show selection popup menu when text is selected within the chat view
  useEffect(() => {
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
  }, []);

  if (loading) {
    return <div class="chat-view"><div class="chat-loading">{t('chat.loading')}</div></div>;
  }

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
        <div class="chat-view" ref={scrollRef} onScroll={preview ? undefined : handleScroll}>
          {viewItems.length === 0 && (
            <div class="chat-loading">
              {sessionState ? t('chat.session_state', { state: sessionState }) : t('chat.no_events')}
            </div>
          )}
          {viewItems.map((item, idx) => {
            const nextItem = viewItems[idx + 1];
            const nextTs = nextItem?.ts ?? nextItem?.event?.ts;
            const onPathClick = ws && !preview ? (p: string) => setFileBrowserPath(p) : undefined;
            return item.type === 'assistant-block' ? (
              <div key={item.key} class="chat-event chat-assistant">
                <RichText text={item.text!} onPathClick={onPathClick} />
                <ChatTime ts={item.lastTs ?? item.ts ?? 0} />
              </div>
            ) : item.type === 'tool-group' ? (
              <ToolCallGroup key={item.key} events={item.toolEvents!} onPathClick={onPathClick} />
            ) : (
              <ChatEvent key={item.key} event={item.event!} nextTs={nextTs} onPathClick={onPathClick} serverId={serverId} />
            );
          })}
          <div ref={bottomRef} />
        </div>
        {/* Status / thinking bar — fixed at bottom */}
        {!preview && (statusText || activeThinkingTs) && (
          <div class="chat-thinking-bar">
            <span class="chat-thinking-dots">●●●</span>
            {' '}{activeThinkingTs
              ? <ActiveThinkingLabel startTs={activeThinkingTs} />
              : statusText}
          </div>
        )}
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
          </div>
        )}
      </div>
      {canShowFilePanel && showFilePanel && ws && (
        <>
          <div class="chat-panel-drag" onMouseDown={onDragStart} />
          <div class="chat-file-panel" style={{ width: `${filePanelWidth}px`, flexShrink: 0 }}>
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
      {fileBrowserPath && ws && (
        <FileBrowser
          ws={ws}
          mode="file-single"
          layout="modal"
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

function ToolInputFold({ lines, onPathClick }: { lines: string[]; onPathClick?: (p: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <span class="chat-tool-input">
        {' '}{splitPaths(lines.join('\n'), onPathClick)}
        <button class="chat-tool-fold-inline" onClick={() => setExpanded(false)}>{' '}{t('chat.tool_fold_collapse')}</button>
      </span>
    );
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  return (
    <span class="chat-tool-input">
      {' '}{splitPaths(first, onPathClick)}
      <button class="chat-tool-fold-inline" onClick={() => setExpanded(true)}>{` ${t('chat.tool_fold_more', { count: lines.length - 2 })} `}</button>
      {splitPaths(last, onPathClick)}
    </span>
  );
}

function AttachmentDownloadButton({ att, serverId }: { att: { id: string; originalName?: string; size?: number }; serverId: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const label = att.originalName || att.id;
  const sizeLabel = att.size ? ` (${(att.size / 1024).toFixed(0)}KB)` : '';
  return (
    <button
      class="chat-attachment-dl"
      style={error ? { color: '#ef4444' } : undefined}
      onClick={() => {
        setError(null);
        import('../api.js').then(({ downloadAttachment }) => {
          downloadAttachment(serverId, att.id).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('daemon_offline') || msg.includes('503')) setError(t('upload.daemon_offline'));
            else if (msg.includes('410') || msg.includes('expired')) setError(t('upload.download_expired'));
            else if (msg.includes('404')) setError(t('upload.download_expired'));
            else setError(t('upload.upload_failed'));
            setTimeout(() => setError(null), 5000);
          });
        });
      }}
      title={error || label}
    >
      {error ? `\u{26A0} ${error}` : `\u{1F4CE} ${label}${sizeLabel}`}
    </button>
  );
}

function ChatEvent({ event, nextTs, onPathClick, serverId }: { event: TimelineEvent; nextTs?: number; onPathClick?: (p: string) => void; serverId?: string }) {
  switch (event.type) {
    case 'user.message': {
      const userText = String(event.payload.text ?? '');
      const attachments = event.payload.attachments as Array<{ id: string; originalName?: string; mime?: string; size?: number }> | undefined;
      return (
        <div class={`chat-event chat-user${event.payload.pending ? ' chat-pending' : ''}`}>
          <div class="chat-bubble-content">{splitPaths(userText, onPathClick)}</div>
          {attachments && serverId && attachments.map((att) => (
            <AttachmentDownloadButton key={att.id} att={att} serverId={serverId} />
          ))}
          {!event.payload.pending && <ChatTime ts={event.ts} />}
        </div>
      );
    }

    case 'tool.call': {
      const toolInput = event.payload.input ? String(event.payload.input) : '';
      const inputLines = toolInput.split('\n');
      const needsFold = inputLines.length > 3;
      return (
        <div class="chat-event chat-tool">
          <span class="chat-tool-icon">{'>'}</span>
          <span class="chat-tool-name">{String(event.payload.tool ?? 'tool')}</span>
          {toolInput && (
            needsFold
              ? <ToolInputFold lines={inputLines} onPathClick={onPathClick} />
              : <span class="chat-tool-input">{' '}{splitPaths(toolInput, onPathClick)}</span>
          )}
        </div>
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
}

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

function ThinkingEvent({ event, endTs }: { event: TimelineEvent; endTs?: number }) {
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
}

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

function ChatTime({ ts }: { ts: number }) {
  return (
    <div class="chat-bubble-time">
      {new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </div>
  );
}

// ── Lightweight Markdown renderer ─────────────────────────────────────────

interface TextSegment {
  type: 'text' | 'code' | 'bold' | 'italic';
  content: string;
}

/** Parse inline markdown: `code`, **bold**, *italic* */
function parseInline(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const regex = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', content: text.slice(last, match.index) });
    if (match[1] !== undefined) segments.push({ type: 'code', content: match[1] });
    else if (match[2] !== undefined) segments.push({ type: 'bold', content: match[2] });
    else if (match[3] !== undefined) segments.push({ type: 'italic', content: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', content: text.slice(last) });
  return segments;
}

interface CodeBlock { type: 'code-block'; lang: string; code: string }
interface TextBlock { type: 'text-block'; text: string }
type Block = CodeBlock | TextBlock;

/** Split text into code blocks and text blocks. */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) blocks.push({ type: 'text-block', text: text.slice(last, match.index) });
    blocks.push({ type: 'code-block', lang: match[1] || '', code: match[2].replace(/\n$/, '') });
    last = match.index + match[0].length;
  }
  if (last < text.length) blocks.push({ type: 'text-block', text: text.slice(last) });
  return blocks;
}

// Matches absolute paths (/foo/bar) and relative paths (docs/file.md, src/components/Foo.tsx).
// Relative paths must start with a letter/underscore/tilde and contain at least one slash segment.
// Negative lookbehind avoids matching inside URLs (http://...) or after other path chars.
const PATH_REGEX = /(\/[\w.\-~][\w.\-~/]*|(?<![:/\w])[a-zA-Z_~][\w.\-~]*(?:\/[\w.\-~]+)+)/g;

/** Split a plain-text segment into runs of path and non-path text. */
function splitPaths(text: string, onPathClick?: (p: string) => void): h.JSX.Element[] {
  if (!onPathClick) return [<span>{text}</span>];
  const parts: preact.JSX.Element[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PATH_REGEX.lastIndex = 0;
  while ((m = PATH_REGEX.exec(text)) !== null) {
    const path = m[1];
    if (path.length < 3) continue; // skip lone /
    if (m.index > last) parts.push(<span key={`t${last}`}>{text.slice(last, m.index)}</span>);
    parts.push(
      <span
        key={`p${m.index}`}
        class="chat-path-link"
        onClick={() => onPathClick(path)}
        title={path}
      >
        {path}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={`t${last}`}>{text.slice(last)}</span>);
  return parts.length ? parts : [<span>{text}</span>];
}

/** Render inline segments as JSX. */
function InlineText({ text, onPathClick }: { text: string; onPathClick?: (p: string) => void }) {
  const lines = text.split('\n');
  return (
    <span>
      {lines.map((line, li) => {
        const segments = parseInline(line);
        return (
          <span key={li}>
            {li > 0 && <br />}
            {segments.map((seg, si) => {
              switch (seg.type) {
                case 'code': return <code key={si} class="chat-inline-code">{splitPaths(seg.content, onPathClick)}</code>;
                case 'bold': return <strong key={si}>{seg.content}</strong>;
                case 'italic': return <em key={si}>{seg.content}</em>;
                default: return <span key={si}>{splitPaths(seg.content, onPathClick)}</span>;
              }
            })}
          </span>
        );
      })}
    </span>
  );
}

/** Render markdown text with code blocks and inline formatting. */
function RichText({ text, onPathClick }: { text: string; onPathClick?: (p: string) => void }) {
  const blocks = parseBlocks(text);
  return (
    <div class="chat-rich-text">
      {blocks.map((block, i) =>
        block.type === 'code-block' ? (
          <div key={i} class="chat-code-block">
            {block.lang && <div class="chat-code-lang">{block.lang}</div>}
            <pre><code>{block.code}</code></pre>
          </div>
        ) : (
          <InlineText key={i} text={block.text} onPathClick={onPathClick} />
        ),
      )}
    </div>
  );
}
