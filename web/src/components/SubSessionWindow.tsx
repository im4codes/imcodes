/**
 * SubSessionWindow — floating, draggable/resizable window for a sub-session.
 * Uses the full SessionControls for input (same as the main session).
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getActiveThinkingTs, getActiveStatusText } from '../thinking-utils.js';
import { recordCost } from '../cost-tracker.js';
import { formatLabel } from '../format-label.js';
import { TerminalView } from './TerminalView.js';
import { ChatView } from './ChatView.js';
import { SessionControls } from './SessionControls.js';
import { UsageFooter } from './UsageFooter.js';
import { useTimeline } from '../hooks/useTimeline.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import { useQuickData } from './QuickInputPanel.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff, SessionInfo } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import { extractLatestUsage } from '../usage-data.js';
import { IdleFlashLayer } from './IdleFlashLayer.js';
import { useIdleFlashPlayback } from '../hooks/useIdleFlashPlayback.js';
import { useNowTicker } from '../hooks/useNowTicker.js';

interface WindowGeometry { x: number; y: number; w: number; h: number }

interface Props {
  sub: SubSession;
  ws: WsClient | null;
  connected: boolean;
  /** When false, timeline and terminal subscriptions are paused to save CPU. */
  active: boolean;
  idleFlashToken?: number;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  onMinimize: () => void;
  onClose: () => void;
  onRestart: () => void;
  onRename: () => void;
  onSettings?: () => void;
  zIndex: number;
  onFocus: () => void;
  /** Optional: called to pin this sub-session to the sidebar. Passes current viewMode. */
  onPin?: (viewMode: 'terminal' | 'chat') => void;
  sessions?: SessionInfo[];
  subSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  serverId?: string;
  pendingPrefillText?: string | null;
  onPendingPrefillApplied?: () => void;
  /** Whether this sub-session is participating in an active P2P discussion. */
  inP2p?: boolean;
}

type ViewMode = 'terminal' | 'chat';

const LOCAL_KEY = (id: string) => `rcc_subsession_${id}`;
const DEFAULT_W = 620;
const DEFAULT_H = 480;
const MIN_W = 300;
const MIN_H = 200;
const DESKTOP_VISIBLE_MARGIN = 32;

function clampDesktopGeom(geom: WindowGeometry): WindowGeometry {
  const maxW = Math.max(MIN_W, window.innerWidth);
  const maxH = Math.max(MIN_H, window.innerHeight);
  const w = Math.min(Math.max(geom.w, MIN_W), maxW);
  const h = Math.min(Math.max(geom.h, MIN_H), maxH);
  const x = Math.min(Math.max(geom.x, DESKTOP_VISIBLE_MARGIN - w), window.innerWidth - DESKTOP_VISIBLE_MARGIN);
  const y = Math.min(Math.max(geom.y, 0), window.innerHeight - DESKTOP_VISIBLE_MARGIN);
  return { x, y, w, h };
}

function loadLocal(id: string): { geom: WindowGeometry; viewMode: ViewMode } {
  try {
    const raw = localStorage.getItem(LOCAL_KEY(id));
    if (raw) {
      const parsed = JSON.parse(raw) as { geom: WindowGeometry; viewMode: ViewMode };
      return { ...parsed, geom: clampDesktopGeom(parsed.geom) };
    }
  } catch { /* ignore */ }
  const cx = Math.max(0, (window.innerWidth - DEFAULT_W) / 2);
  const cy = Math.max(0, (window.innerHeight - DEFAULT_H) / 2 - 80);
  return { geom: clampDesktopGeom({ x: cx, y: cy, w: DEFAULT_W, h: DEFAULT_H }), viewMode: 'chat' };
}

function saveLocal(id: string, geom: WindowGeometry, viewMode: ViewMode) {
  try {
    localStorage.setItem(LOCAL_KEY(id), JSON.stringify({ geom, viewMode }));
  } catch { /* ignore */ }
}

export function SubSessionWindow({
  sub, ws, connected, active, idleFlashToken, onDiff, onHistory, onMinimize, onClose, onRestart, onRename, onSettings, zIndex, onFocus, onPin, sessions, subSessions, serverId, pendingPrefillText, onPendingPrefillApplied, inP2p,
}: Props) {
  const { t } = useTranslation();
  const activeIdleFlashToken = useIdleFlashPlayback(idleFlashToken);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const swipeBackRef = useSwipeBack(isMobile ? onMinimize : null);

  // Always pass sessionName + ws so useTimeline keeps its cache warm.
  // active flag is only for rendering — timeline state should persist across minimize/restore.
  const { events, refreshing } = useTimeline(sub.sessionName, ws, serverId);
  const quickData = useQuickData();

  // Earliest ts of the current continuous thinking sequence (shared logic).
  const activeThinkingTs = useMemo(() => getActiveThinkingTs(events), [events]);

  // Extract active agent status (e.g. "Reading file...")
  const statusText = useMemo(() => getActiveStatusText(events), [events]);

  const [quotes, setQuotes] = useState<string[]>([]);
  const addQuote = useCallback((text: string) => setQuotes((prev) => [...prev, text]), []);
  const removeQuote = useCallback((i: number) => setQuotes((prev) => prev.filter((_, j) => j !== i)), []);

  const thinkingNow = useNowTicker(!!activeThinkingTs && active);
  const isShell = sub.type === 'shell' || sub.type === 'script';
  /** Transport-backed sessions have no tmux terminal — chat only */
  const isTransport = sub.runtimeType === 'transport';
  const initial = loadLocal(sub.id);
  const [geom, setGeom] = useState<WindowGeometry>(initial.geom);
  const [viewMode, setViewMode] = useState<ViewMode>(isShell ? 'terminal' : isTransport ? 'chat' : initial.viewMode);
  // confirmClose removed — × now minimizes instead of terminating

  const inputRef = useRef<HTMLDivElement>(null);
  const termFitFnRef = useRef<(() => void) | null>(null);
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const termScrollRef = useRef<(() => void) | null>(null);
  const chatScrollRef = useRef<(() => void) | null>(null);
  const onTermScrollBottomFn = useCallback((fn: () => void) => { termScrollRef.current = fn; }, []);
  const onChatScrollBottomFn = useCallback((fn: () => void) => { chatScrollRef.current = fn; }, []);

  // SessionInfo shape for SessionControls — read metadata from sub-session object directly
  const sessionInfo: SessionInfo = {
    name: sub.sessionName,
    project: sub.label ?? sub.type,
    role: 'w1',
    agentType: sub.type,
    state:
      sub.state === 'running'
        ? 'running'
        : sub.state === 'stopped'
          ? 'stopped'
          : sub.state === 'stopping'
            ? 'stopping'
            : sub.state === 'error'
              ? 'error'
              : 'idle',
    projectDir: sub.cwd ?? undefined,
    qwenModel: sub.qwenModel ?? undefined,
    qwenAuthType: sub.qwenAuthType ?? undefined,
    qwenAvailableModels: sub.qwenAvailableModels ?? undefined,
    modelDisplay: sub.modelDisplay ?? undefined,
    planLabel: sub.planLabel ?? undefined,
    quotaLabel: sub.quotaLabel ?? undefined,
    quotaUsageLabel: sub.quotaUsageLabel ?? undefined,
    quotaMeta: sub.quotaMeta ?? undefined,
    effort: sub.effort ?? undefined,
    runtimeType: sub.runtimeType ?? undefined,
    transportPendingMessages: sub.transportPendingMessages ?? undefined,
  };

  useEffect(() => {
    saveLocal(sub.id, geom, viewMode);
  }, [sub.id, geom, viewMode]);

  useEffect(() => {
    if (isMobile) return;
    const onResize = () => setGeom((g) => clampDesktopGeom(g));
    window.addEventListener('resize', onResize);
    requestAnimationFrame(onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile]);

  // Scroll to bottom whenever switching to chat view;
  // force fit + full terminal refresh when switching to terminal view.
  useEffect(() => {
    if (viewMode === 'chat') {
      setTimeout(() => chatScrollRef.current?.(), 50);
    } else if (viewMode === 'terminal') {
      requestAnimationFrame(() => {
        termFitFnRef.current?.();
        if (ws && connected && active) {
          try { ws.sendSnapshotRequest(sub.sessionName); } catch { /* ignore */ }
        }
      });
    }
  }, [viewMode, ws, connected, active, sub.sessionName]);

  // Re-subscribe terminal on mount so the server sends a fresh snapshot.
  // SubSessionWindow unmounts on minimize, so without this the remounted
  // TerminalView would start empty (no snapshot, only incremental data).
  useEffect(() => {
    if (!ws || !connected) return;
    const raw = active;
    try { ws.subscribeTerminal(sub.sessionName, raw); } catch { /* ignore */ }
    if (!raw) {
      return;
    }
    return () => {
      try { ws.subscribeTerminal(sub.sessionName, false); } catch { /* ignore */ }
    };
  }, [ws, connected, sub.sessionName, active]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (viewModeRef.current === 'chat') chatScrollRef.current?.();
      else termScrollRef.current?.();
    }, 50);
  }, []);

  // ── Dragging ──────────────────────────────────────────────────────────────
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const clampPos = useCallback((x: number, y: number, w: number, h = geomRef.current.h) => {
    const clamped = clampDesktopGeom({ x, y, w, h });
    return { x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h };
  }, []);

  const startDrag = useCallback((e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, [contenteditable]')) return;
    dragStart.current = { mx: e.clientX, my: e.clientY, ox: geomRef.current.x, oy: geomRef.current.y };
    onFocus();
    const onMove = (me: MouseEvent) => {
      if (!dragStart.current) return;
      const dx = me.clientX - dragStart.current.mx;
      const dy = me.clientY - dragStart.current.my;
      setGeom((g) => {
        const { x, y } = clampPos(dragStart.current!.ox + dx, dragStart.current!.oy + dy, g.w);
        return { ...g, x, y };
      });
    };
    const onUp = () => {
      dragStart.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, [onFocus, clampPos]);

  const onHeaderMouseDown = startDrag;

  // ── Resizing ──────────────────────────────────────────────────────────────
  type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

  const onResizeMouseDown = useCallback((dir: ResizeDir) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onFocus();
    const startG = { ...geomRef.current };
    const sx = e.clientX, sy = e.clientY;
    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - sx;
      const dy = me.clientY - sy;
      setGeom((_g) => {
        let { x, y, w, h } = { ...startG };
        if (dir.includes('e')) w = Math.max(MIN_W, startG.w + dx);
        if (dir.includes('s')) h = Math.max(MIN_H, startG.h + dy);
        if (dir.includes('w')) { w = Math.max(MIN_W, startG.w - dx); x = startG.x + (startG.w - w); }
        if (dir.includes('n')) { h = Math.max(MIN_H, startG.h - dy); y = startG.y + (startG.h - h); }
        return clampDesktopGeom({ x, y, w, h });
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onFocus]);

  const agentTag = sub.type === 'shell' ? (sub.shellBin?.split(/[/\\]/).pop() ?? 'shell') : sub.type;
  const typeLabel = sub.label ? `${formatLabel(sub.label)} · ${agentTag}` : agentTag;

  // Only non-terminal (chat) sub-sessions can be pinned to sidebar
  const isPinnable = !!onPin;

  // HTML5 drag-to-pin: set dataTransfer so sidebar can read panel type + id
  const handleDragStart = useCallback((e: DragEvent) => {
    if (!isPinnable) { e.preventDefault(); return; }
    e.dataTransfer?.setData('application/x-pinpanel', JSON.stringify({ type: 'subsession', id: sub.id }));
    e.dataTransfer?.setData('text/plain', sub.id); // fallback
  }, [isPinnable, sub.id]);

  // Usage tracking
  const lastUsage = useMemo(() => extractLatestUsage(events), [events]);

  // Model may appear in any usage.update event — not only ones with inputTokens
  const detectedModel = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'usage.update' && events[i].payload.model) {
        return String(events[i].payload.model);
      }
    }
    return undefined;
  }, [events]);

  const lastCostEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'usage.update' && events[i].payload.costUsd) {
        return events[i].payload as { costUsd: number };
      }
    }
    return null;
  }, [events]);

  // Record cost delta to ledger whenever costUsd increases
  useEffect(() => {
    if (lastCostEvent?.costUsd) {
      recordCost(sub.sessionName, lastCostEvent.costUsd);
    }
  }, [lastCostEvent?.costUsd, sub.sessionName]);

  const [barHeight, setBarHeight] = useState(0);
  useEffect(() => {
    if (!isMobile) return;
    const bar = document.querySelector('.subsession-bar');
    if (!bar) return;
    const update = () => setBarHeight((bar as HTMLElement).offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [isMobile]);

  const [vvh, setVvh] = useState(() => window.visualViewport?.height ?? window.innerHeight);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVvh(vv.height);
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, [isMobile]);

  const style: Record<string, string | number> = isMobile
    ? { position: 'fixed', top: 'var(--sat, 0px)', left: 0, right: 0, height: `calc(${vvh - barHeight}px - var(--sat, 0px))`, zIndex }
    : { position: 'fixed', left: geom.x, top: geom.y, width: geom.w, height: geom.h, zIndex };

  return (
    <div ref={swipeBackRef} class="subsession-window" style={style} onMouseDown={onFocus}>
      {activeIdleFlashToken ? <IdleFlashLayer key={`subwindow-idle-${activeIdleFlashToken}`} variant="frame" /> : null}
      {/* 8-direction resize handles (desktop only) */}
      {!isMobile && (['n','s','e','w','ne','nw','se','sw'] as ResizeDir[]).map((dir) => (
        <div key={dir} class={`resize-handle resize-${dir}`} onMouseDown={onResizeMouseDown(dir)} />
      ))}

      {/* Header */}
      <div
        class="subsession-header"
        onMouseDown={onHeaderMouseDown}
        draggable={!!isPinnable}
        onDragStart={handleDragStart}
      >
        <span class="subsession-drag-icon">⠿</span>
        <span class="subsession-title">{typeLabel}</span>
        {inP2p && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
        {sub.ccPresetId && <span style={{ fontSize: 11, color: '#f59e0b' }} title={`Custom API: ${sub.ccPresetId}`}>◉</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {!isShell && !isTransport && <button class="subsession-mode-btn" onClick={() => { const next = viewMode === 'chat' ? 'terminal' : 'chat'; setViewMode(next); if (next === 'chat') requestAnimationFrame(() => chatScrollRef.current?.()); }} title={viewMode === 'chat' ? 'Switch to terminal' : 'Switch to chat'}>{viewMode === 'chat' ? '⌨' : '💬'}</button>}
          {isPinnable && <button class="subsession-minimize-btn" onClick={() => onPin?.(viewMode)} title={t('sidebar.pin_to_sidebar')}>📌</button>}
          <button class="subsession-minimize-btn" onClick={onMinimize} title="Minimize">▾</button>
          <button class="subsession-close-btn" onClick={onMinimize} title="Hide">×</button>
        </div>
      </div>

      {/* Content */}
      <div class="subsession-content">
        <div style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}>
          <TerminalView
            sessionName={sub.sessionName}
            ws={ws}
            connected={connected}
            active={active && viewMode === 'terminal'}
            onDiff={(apply) => onDiff(sub.sessionName, apply)}
            onHistory={(apply) => onHistory(sub.sessionName, apply)}
            onFitFn={(fn) => { termFitFnRef.current = fn; }}
            onScrollBottomFn={onTermScrollBottomFn}
            mobileInput={isShell}
          />
        </div>
        {viewMode === 'chat' && (
          <ChatView
            events={events}
            loading={false}
            refreshing={refreshing}
            sessionId={sub.sessionName}
            onScrollBottomFn={onChatScrollBottomFn}
            ws={ws}
            workdir={sub.cwd ?? null}
            serverId={serverId}
            onQuote={addQuote}
          />
        )}
      </div>

      {/* Usage footer — shared component */}
      {(lastUsage || activeThinkingTs || statusText || sessionInfo?.planLabel || sessionInfo?.quotaLabel || sessionInfo?.quotaUsageLabel) && (
        <UsageFooter
          usage={lastUsage ?? { inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
          sessionName={sub.sessionName}
          sessionState={sessionInfo?.state}
          agentType={sessionInfo?.agentType}
          modelOverride={sessionInfo?.modelDisplay ?? (sessionInfo?.agentType === 'qwen' ? sessionInfo?.qwenModel : undefined)}
          planLabel={sessionInfo?.planLabel}
          quotaLabel={sessionInfo?.quotaLabel}
          quotaUsageLabel={(sessionInfo?.agentType === 'codex' || sessionInfo?.agentType === 'codex-sdk') ? undefined : sessionInfo?.quotaUsageLabel}
          quotaMeta={sessionInfo?.quotaMeta}
          showCost={!!lastCostEvent}
          activeThinkingTs={activeThinkingTs}
          statusText={statusText}
          now={thinkingNow}
        />
      )}

      {/* Full SessionControls — with sub-session action overrides */}
      <div onMouseDown={startDrag} style={{ cursor: 'grab' }}>
        <SessionControls
          ws={ws}
          activeSession={sessionInfo}
          inputRef={inputRef}
          quickData={quickData}
          hideShortcuts={false}
          onSend={scrollToBottom}
          onSubRestart={onRestart}
          onSubNew={onRestart}
          onSubStop={onClose}
          onRenameSession={onRename}
          onSettings={onSettings}
          sessionDisplayName={sub.label ? formatLabel(sub.label) : agentTag}
          activeThinking={!!activeThinkingTs}
          sessions={sessions}
          subSessions={subSessions}
          serverId={serverId}
          detectedModel={detectedModel ?? lastUsage?.model}
          quotes={quotes}
          onRemoveQuote={removeQuote}
          pendingPrefillText={pendingPrefillText}
          onPendingPrefillApplied={onPendingPrefillApplied}
        />
      </div>
    </div>
  );
}
