/**
 * ChatView — renders TimelineEvent[] as a chat-style view.
 * Merges consecutive streaming assistant.text events into single blocks.
 * Supports basic Markdown rendering (code blocks, inline code, bold).
 */
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'preact/hooks';
import { memo } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import type { TimelineEvent, WsClient, MemoryContextTimelinePayload, MemoryContextTimelineItem } from '../ws-client.js';
import type { FileChangeBatch, FileChangePatch } from '@shared/file-change.js';
import { FileBrowser } from './file-browser-lazy.js';
import { FloatingPanel } from './FloatingPanel.js';
import { ChatMarkdown } from './ChatMarkdown.js';
import { useNowTicker } from '../hooks/useNowTicker.js';

interface Props {
  events: TimelineEvent[];
  loading: boolean;
  /** True while gap-filling new events after a cache hit */
  refreshing?: boolean;
  /** True while loading older events via backward pagination */
  loadingOlder?: boolean;
  /** False when no more history is available */
  hasOlderHistory?: boolean;
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

interface AssistantBlockProps {
  text: string;
  ts: number;
  onPathClick?: (p: string) => void;
  onUrlClick?: (url: string) => void;
  onDownload?: (path: string) => void;
}

function extractChatEventText(target: HTMLElement): string {
  const clone = target.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('.chat-bubble-time')) el.remove();
  return (clone.textContent ?? '').trim();
}

function hasFileExtension(path: string): boolean {
  const basename = path.split(/[/\\]/).pop() ?? '';
  return /\.\w{1,10}$/.test(basename);
}

function isLikelyDomainPath(value: string): boolean {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(value);
}

function trimDetectedUrl(url: string): string {
  const hardStop = url.search(/[（【《「『，。；：！？⬇]/u);
  let next = hardStop >= 0 ? url.slice(0, hardStop) : url;
  while (next.length > 1 && /[.,;:!?)}\]>）】》」』，。；：！？⬇]$/u.test(next)) next = next.slice(0, -1);
  return next;
}

function formatMemoryContextScore(score: number | undefined): string | null {
  if (typeof score !== 'number' || Number.isNaN(score)) return null;
  return score >= 1 ? score.toFixed(2) : score.toFixed(3);
}

function formatMemoryContextTimestamp(ts: number | undefined): string | null {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const TOOL_INPUT_SUMMARY_KEYS = [
  'query',
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'url',
  'input',
  'text',
  'prompt',
  'objective',
  'description',
  'name',
] as const;

type FileBrowserTarget = {
  path: string;
  preferDiff: boolean;
};

type GroupedFileChange = {
  filePath: string;
  patches: FileChangePatch[];
};

function isFileChangeEvent(event: TimelineEvent): event is TimelineEvent & { payload: { batch?: FileChangeBatch } } {
  return event.type === 'file.change' && !!event.payload && typeof event.payload === 'object';
}

function getFileChangeBatch(event: TimelineEvent): FileChangeBatch | null {
  if (!isFileChangeEvent(event)) return null;
  const batch = event.payload.batch;
  if (!batch || typeof batch !== 'object') return null;
  const payload = batch as FileChangeBatch;
  if (!Array.isArray(payload.patches)) return null;
  return payload;
}

function truncateToolText(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatToolPayloadValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return truncateToolText(value.replace(/\s+/g, ' ').trim());
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((item) => formatToolPayloadValue(item)).filter(Boolean);
    if (parts.length === 0) return '';
    return truncateToolText(parts.join(', '));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 0) return '';
    for (const key of TOOL_INPUT_SUMMARY_KEYS) {
      const candidate = record[key];
      if (candidate === undefined) continue;
      const formatted = formatToolPayloadValue(candidate);
      if (formatted) return formatted;
    }
    const entries = Object.entries(record);
    if (entries.length === 1) {
      return formatToolPayloadValue(entries[0][1]);
    }
    try {
      return truncateToolText(JSON.stringify(value));
    } catch {
      return '[object]';
    }
  }
  return truncateToolText(String(value));
}

function summarizeToolInput(
  input: unknown,
  detail: unknown,
): string {
  const direct = formatToolPayloadValue(input);
  if (direct) return direct;
  if (!detail || typeof detail !== 'object') return '';
  const record = detail as Record<string, unknown>;
  const fromDetailInput = formatToolPayloadValue(record.input);
  if (fromDetailInput) return fromDetailInput;
  const raw = record.raw;
  if (!raw || typeof raw !== 'object') return '';
  const rawRecord = raw as Record<string, unknown>;
  const fromRawArgs = formatToolPayloadValue(rawRecord.args);
  if (fromRawArgs) return fromRawArgs;
  return formatToolPayloadValue(rawRecord.input);
}

function formatToolDetailJson(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ToolDetailSection({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  const text = formatToolDetailJson(value);
  if (!text) return null;
  return (
    <div class="chat-tool-detail-section">
      <div class="chat-tool-detail-label">{label}</div>
      <pre class="chat-tool-detail-pre">{text}</pre>
    </div>
  );
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
  // - session.state running/idle: live status belongs in footer/header, not chat history
  const visible = events.filter(
    (e) =>
      !e.hidden &&
      e.type !== 'agent.status' &&
      e.type !== 'usage.update' &&
      e.type !== 'mode.state' &&
      e.type !== 'command.ack' &&
      e.type !== 'terminal.snapshot' &&
      !(e.type === 'session.state' && (e.payload.state === 'running' || e.payload.state === 'idle')) &&
      e.type !== 'assistant.thinking',
  );

  // Pre-pass: merge tool.call+tool.result pairs, dedup session.state,
  // and dedup stable-eventId streaming events (keep last occurrence only)
  const consolidated: TimelineEvent[] = [];
  // Track tool.result eventIds that have been consumed by a preceding tool.call merge
  const consumedIds = new Set<string>();

  // Dedup: for events sharing a stable eventId (streaming deltas), keep only the last
  const lastByEventId = new Map<string, number>();
  for (let i = 0; i < visible.length; i++) {
    lastByEventId.set(visible[i].eventId, i);
  }

  for (let i = 0; i < visible.length; i++) {
    const ev = visible[i];

    // Skip earlier occurrences of duplicate eventIds (streaming delta updates — keep last only)
    if (lastByEventId.get(ev.eventId) !== i) continue;

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
        // tool.call from transport SDK may have no input yet (streamed incrementally).
        // Fall back to the result's detail.input which has the complete args.
        const inputText = summarizeToolInput(ev.payload.input, ev.payload.detail)
          || summarizeToolInput((next.payload.detail as any)?.input, next.payload.detail);
        const input = inputText ? ` ${inputText}` : '';
        const status = next.payload.error ? `✗ ${String(next.payload.error)}` : '✓';
        const output = !next.payload.error && next.payload.output ? String(next.payload.output) : undefined;
        consolidated.push({
          ...ev,
          type: 'tool.call',
          payload: {
            ...ev.payload,
            tool: toolName,
            input: `${input} ${status}`.trim(),
            _merged: true,
            ...(output ? { _output: output } : {}),
            ...(ev.payload.detail ? { _callDetail: ev.payload.detail } : {}),
            ...(next.payload.detail ? { _resultDetail: next.payload.detail } : {}),
          },
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

export function ChatView({ events, loading, refreshing: _refreshing, loadingOlder, hasOlderHistory = true, onLoadOlder, sessionState, sessionId, onScrollBottomFn, preview, ws, onInsertPath, workdir, serverId, onQuote }: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [fileBrowserTarget, setFileBrowserTarget] = useState<FileBrowserTarget | null>(null);
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
  const lastScrollTopRef = useRef(0);
  const suppressLoadOlderUntilRef = useRef(0);

  const suppressLoadOlder = useCallback((durationMs = 1200) => {
    suppressLoadOlderUntilRef.current = Date.now() + durationMs;
  }, []);

  // Track tool.call and normalized file.change events to trigger file panel refresh
  const [filePanelRefreshTrigger, setFilePanelRefreshTrigger] = useState(0);
  const lastToolCallTsRef = useRef(0);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'tool.call' || e.type === 'file.change') {
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

  const openFileBrowserTarget = useCallback((path: string, preferDiff = false) => {
    setFileBrowserTarget({ path: path.replace(/^`+|`+$/g, ''), preferDiff });
  }, []);

  const handlePathClick = useCallback((path: string) => {
    openFileBrowserTarget(path, false);
  }, [openFileBrowserTarget]);

  const handleFileChangeOpen = useCallback((path: string, preferDiff = false) => {
    openFileBrowserTarget(path, preferDiff);
  }, [openFileBrowserTarget]);

  const handleUrlClick = useCallback((url: string) => {
    setPendingUrl(url);
  }, []);

  const handleDownload = useCallback((path: string) => {
    if (!serverId || !ws) return;
    const reqId = ws.fsReadFile(path);
    const unsub = ws.onMessage((msg) => {
      if (msg.type !== 'fs.read_response' || msg.requestId !== reqId) return;
      unsub();
      if (msg.downloadId) {
        import('../api.js').then(({ downloadAttachment }) => {
          downloadAttachment(serverId, msg.downloadId as string).catch(() => {});
        });
      }
    });
    setTimeout(unsub, 30_000);
  }, [serverId, ws]);

  const pathClickHandler = ws && !preview ? handlePathClick : undefined;
  const urlClickHandler = !preview ? handleUrlClick : undefined;
  const downloadHandler = serverId && ws ? handleDownload : undefined;

  const viewItems = useMemo(() => buildViewItems(events), [events]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    suppressLoadOlder();
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
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
  // Save the relative bottom offset on focusin, then restore against the new layout
  // when visualViewport height decreases (keyboard appeared). Using absolute scrollTop
  // is brittle on iOS and can replay a stale 0 value, snapping the chat to the top.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let savedBottomOffset = 0;
    let savedWasNearBottom = true;
    let prevHeight = vv.height;
    const onFocusIn = () => {
      const el = scrollRef.current;
      if (!el) return;
      savedBottomOffset = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
      savedWasNearBottom = savedBottomOffset < 150;
      suppressLoadOlder();
    };
    const onResize = () => {
      const el = scrollRef.current;
      if (!el) return;
      if (vv.height !== prevHeight) {
        suppressLoadOlder();
        if (savedWasNearBottom || autoScrollRef.current) {
          requestAnimationFrame(() => scrollToBottom());
        } else if (vv.height < prevHeight) {
          const targetTop = Math.max(0, el.scrollHeight - el.clientHeight - savedBottomOffset);
          el.scrollTop = targetTop;
          lastScrollTopRef.current = el.scrollTop;
        }
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

  // Any visible content update should force-follow to the latest message.
  // Skip while prepending older history so anchor restoration can preserve position.
  useLayoutEffect(() => {
    if (loadingOlder || scrollAnchorRef.current) return;
    scrollToBottom();
  }, [preview, viewItems, loading, loadingOlder]);

  // Restore scroll position after Load Older prepends events
  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.scrollHeight - anchor.scrollHeight;
    if (delta > 0) el.scrollTop += delta;
    scrollAnchorRef.current = null;
  }, [events]);

  // Fallback for timestamp-based message additions. The layout effect above handles
  // streaming edits and other view changes that do not advance timestamps.
  useEffect(() => {
    const changed = lastVisibleTs !== prevVisibleTsRef.current;
    prevVisibleTsRef.current = lastVisibleTs;
    if (!changed && !preview) return;
    requestAnimationFrame(() => {
      scrollToBottom();
    });
  }, [lastVisibleTs, preview]);

  const lastScrollActivityRef = useRef(Date.now());
  const SCROLL_IDLE_RESUME_MS = 60_000;

  // Scroll auto-trigger for Load Older
  const lastLoadOlderAtRef = useRef(0);
  const LOAD_OLDER_COOLDOWN_MS = 1000;
  // Scroll anchor preservation: save scrollHeight before prepend, restore after
  const scrollAnchorRef = useRef<{ scrollHeight: number } | null>(null);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const clientHeight = el.clientHeight;
    const wasAutoFollowing = autoScrollRef.current;
    const transientTopJump = wasAutoFollowing
      && scrollTop < 100
      && lastScrollTopRef.current > 100
      && Date.now() < suppressLoadOlderUntilRef.current;
    if (transientTopJump) {
      setShowScrollBtn(false);
      requestAnimationFrame(() => scrollToBottom());
      return;
    }
    // Use generous threshold — 150px from bottom still counts as "at bottom"
    const atBottom = scrollHeight - scrollTop - clientHeight < 150;
    autoScrollRef.current = atBottom;
    setShowScrollBtn(!atBottom);
    if (!atBottom) lastScrollActivityRef.current = Date.now();
    lastScrollTopRef.current = scrollTop;
    // Auto-trigger load older when scrolled near top
    if (scrollTop < 100 && onLoadOlder && hasOlderHistory && !loadingOlder && !loading) {
      const now = Date.now();
      if (now - lastLoadOlderAtRef.current >= LOAD_OLDER_COOLDOWN_MS) {
        lastLoadOlderAtRef.current = now;
        scrollAnchorRef.current = { scrollHeight };
        onLoadOlder();
      }
    }
  };

  // Resume auto-scroll after 1 min of scroll inactivity
  useEffect(() => {
    if (!showScrollBtn || preview) return;
    const timer = setInterval(() => {
      if (!autoScrollRef.current && Date.now() - lastScrollActivityRef.current >= SCROLL_IDLE_RESUME_MS) {
        autoScrollRef.current = true;
        setShowScrollBtn(false);
        scrollToBottom();
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [showScrollBtn, preview]);

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
    const text = extractChatEventText(target);
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
      {/* refreshing indicator removed — gap-fill is invisible to the user */}
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
          {!loading && !preview && onLoadOlder && viewItems.length > 0 && hasOlderHistory && (
            <div style={{ textAlign: 'center', padding: '8px 0' }}>
              <button
                class="btn btn-sm"
                style={{ fontSize: 11, opacity: 0.7 }}
                onClick={() => {
                  const el = scrollRef.current;
                  if (el) scrollAnchorRef.current = { scrollHeight: el.scrollHeight };
                  onLoadOlder();
                }}
                disabled={loadingOlder}
              >
                {loadingOlder ? t('chat.loading_older') : t('chat.load_older')}
              </button>
            </div>
          )}
          {!loading && viewItems.map((item, idx) => {
            const nextItem = viewItems[idx + 1];
            const nextTs = nextItem?.ts ?? nextItem?.event?.ts;
            return item.type === 'assistant-block' ? (
              <AssistantBlock
                key={item.key}
                text={item.text!}
                ts={item.lastTs ?? item.ts ?? 0}
                onPathClick={pathClickHandler}
                onUrlClick={urlClickHandler}
                onDownload={downloadHandler}
              />
            ) : item.type === 'tool-group' ? (
              <ToolCallGroup key={item.key} events={item.toolEvents!} onPathClick={pathClickHandler} onDownload={downloadHandler} serverId={serverId} />
            ) : (
              <ChatEvent key={item.key} event={item.event!} nextTs={nextTs} onPathClick={pathClickHandler} onFileChangeOpen={handleFileChangeOpen} onDownload={downloadHandler} serverId={serverId} />
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
              serverId={serverId}
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
      {fileBrowserTarget && ws && (
        <FloatingPanel
          id="chat-file-preview"
          title={`📄 ${fileBrowserTarget.path.split(/[/\\]/).pop() ?? fileBrowserTarget.path}`}
          onClose={() => setFileBrowserTarget(null)}
          defaultW={600}
          defaultH={500}
        >
          <FileBrowser
            ws={ws}
            serverId={serverId}
            mode="file-single"
            layout="panel"
            initialPath={(() => {
              const path = fileBrowserTarget.path;
              const isAbsolute = path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[/\\]/.test(path);
              const resolved = isAbsolute ? path : `${workdir ?? '~'}/${path}`;
              return resolved.includes('.') && !resolved.endsWith('/')
                ? resolved.split(/[/\\]/).slice(0, -1).join('/') || '~'
                : resolved;
            })()}
            highlightPath={fileBrowserTarget.path.startsWith('/') || fileBrowserTarget.path.startsWith('~') || /^[A-Za-z]:[/\\]/.test(fileBrowserTarget.path)
              ? fileBrowserTarget.path
              : `${workdir ?? '~'}/${fileBrowserTarget.path}`}
            autoPreviewPath={fileBrowserTarget.path.startsWith('/') || fileBrowserTarget.path.startsWith('~') || /^[A-Za-z]:[/\\]/.test(fileBrowserTarget.path)
              ? fileBrowserTarget.path
              : `${workdir ?? '~'}/${fileBrowserTarget.path}`}
            autoPreviewPreferDiff={fileBrowserTarget.preferDiff}
            onConfirm={(paths) => {
              if (paths[0]) onInsertPath?.(paths[0]);
              setFileBrowserTarget(null);
            }}
            onClose={() => setFileBrowserTarget(null)}
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
function ToolCallGroup({
  events,
  onPathClick,
  onDownload,
  serverId,
}: {
  events: TimelineEvent[];
  onPathClick?: (p: string) => void;
  onDownload?: (path: string) => void;
  serverId?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const first = events[0];
  const last = events.length > 1 ? events[events.length - 1] : null;
  const middle = events.slice(1, last ? -1 : undefined);

  return (
    <div class="chat-tool-group">
      <ChatEvent event={first} onPathClick={onPathClick} onDownload={onDownload} serverId={serverId} />
      <div class="chat-tool-group-indent">
        {middle.length > 0 && (
          expanded ? (
            middle.map((ev) => <ChatEvent key={ev.eventId} event={ev} onPathClick={onPathClick} onDownload={onDownload} serverId={serverId} />)
          ) : (
            <button class="chat-tool-fold-btn" onClick={() => setExpanded(true)}>
              {t('chat.tool_group_more', { count: middle.length })}
            </button>
          )
        )}
        {last && <ChatEvent event={last} onPathClick={onPathClick} onDownload={onDownload} serverId={serverId} />}
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

const AssistantBlock = memo(function AssistantBlock({
  text,
  ts,
  onPathClick,
  onUrlClick,
  onDownload,
}: AssistantBlockProps) {
  return (
    <div class="chat-event chat-assistant">
      <ChatMarkdown text={text} onPathClick={onPathClick} onUrlClick={onUrlClick} onDownload={onDownload} />
      <ChatTime ts={ts} />
    </div>
  );
});

function AttachmentDownloadButton({ att, serverId, onPathClick }: { att: { id: string; originalName?: string; size?: number; daemonPath?: string }; serverId: string; onPathClick?: (p: string) => void }) {
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
          // If file has a daemon path, open in file browser floating panel
          if (att.daemonPath && onPathClick) {
            onPathClick(att.daemonPath);
            return;
          }
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

const ChatEvent = memo(function ChatEvent({
  event,
  nextTs,
  onPathClick,
  onFileChangeOpen,
  onDownload,
  serverId,
}: {
  event: TimelineEvent;
  nextTs?: number;
  onPathClick?: (p: string) => void;
  onFileChangeOpen?: (path: string, preferDiff?: boolean) => void;
  onDownload?: (path: string) => void;
  serverId?: string;
}) {
  const { t } = useTranslation();
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
            <AttachmentDownloadButton key={att.id} att={att} serverId={serverId} onPathClick={onPathClick} />
          ))}
          {userText && <div class="chat-bubble-content">{splitPathsAndUrls(userText, onPathClick, undefined, onDownload)}</div>}
          {!event.payload.pending && <ChatTime ts={event.ts} />}
        </div>
      );
    }

    case 'tool.call': {
      const callDetail = event.payload._callDetail ?? event.payload.detail;
      const resultDetail = event.payload._resultDetail;
      // Fall back to result detail for input — transport SDK tool.call may arrive without input
      const toolInput = summarizeToolInput(event.payload.input, callDetail)
        || summarizeToolInput((resultDetail as any)?.input, resultDetail);
      const toolOutput = event.payload._output ? String(event.payload._output) : undefined;
      return (
        <ToolBlockFold>
          <div class="chat-event chat-tool">
            <span class="chat-tool-icon">{'>'}</span>
            <span class="chat-tool-name">{String(event.payload.tool ?? 'tool')}</span>
            {toolInput && <span class="chat-tool-input">{' '}{splitPathsAndUrls(toolInput, onPathClick, undefined, onDownload)}</span>}
          </div>
          {toolOutput && (
            <div class="chat-event chat-tool chat-tool-result-preview">
              <span class="chat-tool-output">{splitPathsAndUrls(toolOutput, onPathClick, undefined, onDownload)}</span>
            </div>
          )}
          {(callDetail || resultDetail) && (
            <details class="chat-tool-detail">
              <summary class="chat-tool-detail-summary">{t('chat.tool_detail_toggle')}</summary>
              <ToolDetailSection label={t('chat.tool_detail_input')} value={(callDetail as any)?.input} />
              <ToolDetailSection label={t('chat.tool_detail_output')} value={(resultDetail as any)?.output} />
              <ToolDetailSection label={t('chat.tool_detail_meta')} value={(callDetail as any)?.meta ?? (resultDetail as any)?.meta} />
              <ToolDetailSection label={t('chat.tool_detail_raw')} value={(callDetail as any)?.raw ?? (resultDetail as any)?.raw} />
            </details>
          )}
        </ToolBlockFold>
      );
    }

    case 'tool.result': {
      // Standalone tool.result (not merged) — still rendered for cases without a preceding call
      const error = event.payload.error;
      const output = formatToolPayloadValue(event.payload.output);
      const detail = event.payload.detail;
      return (
        <ToolBlockFold>
          <div class="chat-event chat-tool">
            <span class="chat-tool-icon">{'<'}</span>
            {error ? (
            <span class="chat-tool-error">{`error: ${String(error)}`}</span>
          ) : output ? (
              <span class="chat-tool-output">{splitPathsAndUrls(output, onPathClick, undefined, onDownload)}</span>
            ) : (
              <span class="chat-tool-output">done</span>
            )}
          </div>
          {detail && (
            <details class="chat-tool-detail">
              <summary class="chat-tool-detail-summary">{t('chat.tool_detail_toggle')}</summary>
              <ToolDetailSection label={t('chat.tool_detail_output')} value={(detail as any).output} />
              <ToolDetailSection label={t('chat.tool_detail_meta')} value={(detail as any).meta} />
              <ToolDetailSection label={t('chat.tool_detail_raw')} value={(detail as any).raw} />
            </details>
          )}
        </ToolBlockFold>
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
      const inline = state === 'idle' || state === 'running';
      return (
        <div class="chat-event chat-system" style={inline ? { display: 'flex', alignItems: 'center', gap: 8 } : undefined}>
          <span>{stateLabel[state] ?? state}</span>
          {inline
            ? <span class="chat-bubble-time" style={{ display: 'inline', margin: 0 }}>{new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            : <ChatTime ts={event.ts} />}
        </div>
      );
    }

    case 'assistant.thinking':
      return <ThinkingEvent event={event} endTs={nextTs} />;

    case 'memory.context':
      return <MemoryContextEvent event={event} />;

    case 'terminal.snapshot':
      return <SnapshotEvent event={event} />;

    case 'file.change':
      return <FileChangeCard event={event} onOpenFile={onFileChangeOpen} />;

    default:
      return null;
  }
});

function groupFileChangePatches(batch: FileChangeBatch): GroupedFileChange[] {
  const groups = new Map<string, GroupedFileChange>();
  const order: string[] = [];
  for (const patch of batch.patches ?? []) {
    if (!patch?.filePath) continue;
    let group = groups.get(patch.filePath);
    if (!group) {
      group = { filePath: patch.filePath, patches: [] };
      groups.set(patch.filePath, group);
      order.push(patch.filePath);
    }
    group.patches.push(patch);
  }
  return order.map((filePath) => groups.get(filePath)!).filter(Boolean);
}

function fileChangeOperationKey(operation: string): string {
  switch (operation) {
    case 'create': return 'chat.file_change_operation_create';
    case 'update': return 'chat.file_change_operation_update';
    case 'delete': return 'chat.file_change_operation_delete';
    case 'rename': return 'chat.file_change_operation_rename';
    default: return 'chat.file_change_operation_unknown';
  }
}

function fileChangeConfidenceKey(confidence: string): string {
  switch (confidence) {
    case 'exact': return 'chat.file_change_confidence_exact';
    case 'derived': return 'chat.file_change_confidence_derived';
    default: return 'chat.file_change_confidence_coarse';
  }
}

function fileChangeProviderKey(provider: string): string {
  switch (provider) {
    case 'claude-code': return 'chat.file_change_provider_claude_code';
    case 'opencode': return 'chat.file_change_provider_opencode';
    case 'codex-sdk': return 'chat.file_change_provider_codex_sdk';
    case 'qwen': return 'chat.file_change_provider_qwen';
    case 'gemini': return 'chat.file_change_provider_gemini';
    default: return provider;
  }
}

function clampPreviewText(text: string, maxLines = 14, maxChars = 1200): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const clippedByLines = lines.length > maxLines;
  const clipped = clippedByLines ? lines.slice(0, maxLines).join('\n') : normalized;
  const truncated = clippedByLines || clipped.length > maxChars;
  const textOut = clipped.length > maxChars ? clipped.slice(0, maxChars) : clipped;
  return { text: textOut, truncated };
}

function extractStackedPreviewFromUnifiedDiff(diff: string): { before: string; after: string } | null {
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  for (const rawLine of diff.replace(/\r\n/g, '\n').split('\n')) {
    if (!rawLine) continue;
    if (rawLine.startsWith('---') || rawLine.startsWith('+++') || rawLine.startsWith('@@')) continue;
    if (rawLine.startsWith('-')) {
      beforeLines.push(rawLine.slice(1));
      continue;
    }
    if (rawLine.startsWith('+')) {
      afterLines.push(rawLine.slice(1));
    }
  }
  if (beforeLines.length === 0 && afterLines.length === 0) return null;
  return {
    before: beforeLines.join('\n'),
    after: afterLines.join('\n'),
  };
}

const FileChangeCard = memo(function FileChangeCard({
  event,
  onOpenFile,
}: {
  event: TimelineEvent;
  onOpenFile?: (path: string, preferDiff?: boolean) => void;
}) {
  const { t } = useTranslation();
  const batch = getFileChangeBatch(event);
  if (!batch) return null;
  const fileGroups = groupFileChangePatches(batch);
  if (fileGroups.length === 0) return null;

  return (
    <div class="chat-event chat-file-change">
      <div class="chat-file-change-header">
        <div class="chat-file-change-title">
          {t('chat.file_change_title', { count: fileGroups.length })}
        </div>
        <div class="chat-file-change-meta">
          <span class="chat-file-change-chip">{t(fileChangeProviderKey(batch.provider))}</span>
          {batch.title && <span class="chat-file-change-chip chat-file-change-chip-muted">{batch.title}</span>}
        </div>
      </div>
      <div class="chat-file-change-body">
        {fileGroups.map((group) => {
          const operations = Array.from(new Set(group.patches.map((patch) => patch.operation)));
          const confidences = Array.from(new Set(group.patches.map((patch) => patch.confidence)));
          const first = group.patches[0];
          const hasExactPreview = group.patches.some((patch) => patch.confidence === 'exact' && (patch.beforeText || patch.afterText || patch.unifiedDiff));
          const fileLabel = first?.oldPath && first.oldPath !== group.filePath
            ? `${first.oldPath} → ${group.filePath}`
            : group.filePath;
          return (
            <div class="chat-file-change-file" key={group.filePath}>
              <div
                class="chat-file-change-path"
                role="button"
                tabIndex={0}
                onClick={() => onOpenFile?.(group.filePath, hasExactPreview)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onOpenFile?.(group.filePath, hasExactPreview);
                }}
                title={group.filePath}
              >
                {fileLabel}
              </div>
              <div class="chat-file-change-badges">
                <span class="chat-file-change-chip">{operations.length === 1 ? t(fileChangeOperationKey(operations[0])) : t('chat.file_change_operation_mixed')}</span>
                <span class="chat-file-change-chip chat-file-change-chip-muted">{confidences.length === 1 ? t(fileChangeConfidenceKey(confidences[0])) : t('chat.file_change_confidence_mixed')}</span>
                <span class="chat-file-change-chip chat-file-change-chip-muted">{t('chat.file_change_patch_count', { count: group.patches.length })}</span>
              </div>
              <div class="chat-file-change-patches">
                {group.patches.map((patch, idx) => (
                  <div class="chat-file-change-patch" key={`${group.filePath}:${idx}`}>
                    {patch.confidence === 'exact' ? (
                      <ExactFilePatch patch={patch} />
                    ) : patch.confidence === 'derived' ? (
                      <DerivedFilePatch patch={patch} />
                    ) : (
                      <CoarseFilePatch patch={patch} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

function ExactFilePatch({ patch }: { patch: FileChangePatch }) {
  const { t } = useTranslation();
  const unifiedPreview = patch.unifiedDiff ? extractStackedPreviewFromUnifiedDiff(patch.unifiedDiff) : null;
  const before = patch.beforeText ?? unifiedPreview?.before ?? '';
  const after = patch.afterText ?? unifiedPreview?.after ?? '';
  const beforePreview = clampPreviewText(before || t('chat.file_change_no_before'));
  const afterPreview = clampPreviewText(after || t('chat.file_change_no_after'));
  return (
    <div class="chat-file-change-diff">
      <div class="chat-file-change-diff-block">
        <div class="chat-file-change-diff-label chat-file-change-diff-label-removed">{t('chat.file_change_removed')}</div>
        <pre class="chat-file-change-diff-pre chat-file-change-diff-pre-removed">{beforePreview.text}{beforePreview.truncated ? `\n${t('chat.file_change_truncated')}` : ''}</pre>
      </div>
      <div class="chat-file-change-diff-block">
        <div class="chat-file-change-diff-label chat-file-change-diff-label-added">{t('chat.file_change_added')}</div>
        <pre class="chat-file-change-diff-pre chat-file-change-diff-pre-added">{afterPreview.text}{afterPreview.truncated ? `\n${t('chat.file_change_truncated')}` : ''}</pre>
      </div>
    </div>
  );
}

function DerivedFilePatch({ patch }: { patch: FileChangePatch }) {
  const { t } = useTranslation();
  const previewText = patch.afterText ?? patch.beforeText ?? patch.unifiedDiff ?? '';
  const preview = clampPreviewText(previewText || t('chat.file_change_derived_no_preview'));
  return (
    <div class="chat-file-change-diff">
      <div class="chat-file-change-diff-label">{t('chat.file_change_confidence_derived')}</div>
      <pre class="chat-file-change-diff-pre">{preview.text}{preview.truncated ? `\n${t('chat.file_change_truncated')}` : ''}</pre>
    </div>
  );
}

function CoarseFilePatch({ patch }: { patch: FileChangePatch }) {
  const { t } = useTranslation();
  return (
    <div class="chat-file-change-diff chat-file-change-diff-coarse">
      <div class="chat-file-change-diff-label">{t('chat.file_change_confidence_coarse')}</div>
      <div class="chat-file-change-coarse-text">
        {patch.oldPath && patch.oldPath !== patch.filePath
          ? t('chat.file_change_renamed_from', { oldPath: patch.oldPath, newPath: patch.filePath })
          : t('chat.file_change_coarse_hint')}
      </div>
    </div>
  );
}

function ActiveThinkingLabel({ startTs }: { startTs: number }) {
  const { t } = useTranslation();
  const now = useNowTicker(true);
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

const MemoryContextEvent = memo(function MemoryContextEvent({ event }: { event: TimelineEvent }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const payload = event.payload as unknown as MemoryContextTimelinePayload;
  const items = Array.isArray(payload.items) ? payload.items as MemoryContextTimelineItem[] : [];
  const query = typeof payload.query === 'string' ? payload.query : '';
  const reason = payload.reason ?? 'message';

  return (
    <div class="chat-event chat-memory-context" data-related-to={String(payload.relatedToEventId ?? '')}>
      <button class="chat-memory-context-toggle" onClick={() => setExpanded((value) => !value)}>
        <span class="chat-memory-context-title">{t('chat.memory_context_title')}</span>
        <span class="chat-memory-context-summary">{t('chat.memory_context_summary', { count: items.length })}</span>
        <span class="chat-memory-context-caret">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div class="chat-memory-context-body">
          {reason === 'startup' ? (
            <div class="chat-memory-context-query">{t('chat.memory_context_startup_reason')}</div>
          ) : null}
          {query && (
            <div class="chat-memory-context-query">{t('chat.memory_context_query', { query })}</div>
          )}
          <div class="chat-memory-context-list">
            {items.map((item) => {
              const score = formatMemoryContextScore(item.relevanceScore);
              const recalledAt = formatMemoryContextTimestamp(item.lastUsedAt);
              return (
                <div key={item.id} class="chat-memory-context-item">
                  <div class="chat-memory-context-item-summary">{item.summary}</div>
                  <div class="chat-memory-context-item-meta">
                    <span class="chat-memory-context-chip">{item.projectId}</span>
                    {score && <span class="chat-memory-context-chip">{t('chat.memory_context_score', { score })}</span>}
                    {typeof item.hitCount === 'number' && item.hitCount > 0 ? (
                      <span class="chat-memory-context-chip">{t('sharedContext.management.memoryRecalls', { count: item.hitCount })}</span>
                    ) : null}
                    <span class="chat-memory-context-chip chat-memory-context-chip-muted">
                      {recalledAt
                        ? t('sharedContext.management.memoryLastRecalled', { time: recalledAt })
                        : t('sharedContext.management.memoryNeverRecalled')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
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
const URL_REGEX = /https?:\/\/[^\s<>"\])}）】》」』，。；：！？（【《「『]+/g;

// Matches absolute paths (/foo/bar) and relative paths (docs/file.md, src/components/Foo.tsx).
const PATH_REGEX = /(\\\\[\w.$ -]+\\[\w.$ \\-]+|[A-Za-z]:\\(?:[\w.$ -]+\\)*[\w.$ -]+|\.{1,2}\/[\w\p{L}.\-~/]+|\/[\w\p{L}.\-~][\w\p{L}.\-~/]*|(?<![:/\w\p{L}])[a-zA-Z_~][\w\p{L}.\-~]*(?:\/[\w\p{L}.\-~]+)+)/gu;

/** Split a plain-text segment into URL tokens, path tokens, and plain text. */
function splitPathsAndUrls(
  text: string,
  onPathClick?: (p: string) => void,
  onUrlClick?: (url: string) => void,
  onDownload?: (path: string) => void,
): h.JSX.Element[] {
  if (!onPathClick && !onUrlClick && !onDownload) return [<span>{text}</span>];

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
    let url = trimDetectedUrl(m[0]);
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
        if (isLikelyDomainPath(path)) continue;
        if (pm.index > pathLast) parts.push(<span key={`t${chunk.start + pathLast}`}>{chunk.value.slice(pathLast, pm.index)}</span>);
        parts.push(
          <span key={`p${chunk.start + pm.index}`}>
            <span
              class="chat-path-link"
              onClick={() => onPathClick(path)}
              title={path}
            >
              {path}
            </span>
            {onDownload && hasFileExtension(path) && (
              <button
                class="chat-dl-btn"
                title="Download"
                onClick={(e: Event) => {
                  e.stopPropagation();
                  onDownload(path);
                }}
              >
                ⬇
              </button>
            )}
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
