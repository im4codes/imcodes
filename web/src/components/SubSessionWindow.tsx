/**
 * SubSessionWindow — floating, draggable/resizable window for a sub-session.
 * Uses the full SessionControls for input (same as the main session).
 */
import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getActiveThinkingTs } from '../thinking-utils.js';
import { recordCost, getSessionCost, getWeeklyCost, getMonthlyCost, formatCost } from '../cost-tracker.js';
import { TerminalView } from './TerminalView.js';
import { ChatView } from './ChatView.js';
import { SessionControls } from './SessionControls.js';
import { useTimeline } from '../hooks/useTimeline.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import { useQuickData } from './QuickInputPanel.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff, SessionInfo } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';

interface WindowGeometry { x: number; y: number; w: number; h: number }

interface Props {
  sub: SubSession;
  ws: WsClient | null;
  connected: boolean;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  onMinimize: () => void;
  onClose: () => void;
  onRestart: () => void;
  onRename: () => void;
  zIndex: number;
  onFocus: () => void;
}

type ViewMode = 'terminal' | 'chat';

const LOCAL_KEY = (id: string) => `rcc_subsession_${id}`;
const DEFAULT_W = 620;
const DEFAULT_H = 480;
const MIN_W = 300;
const MIN_H = 200;

function loadLocal(id: string): { geom: WindowGeometry; viewMode: ViewMode } {
  try {
    const raw = localStorage.getItem(LOCAL_KEY(id));
    if (raw) return JSON.parse(raw) as { geom: WindowGeometry; viewMode: ViewMode };
  } catch { /* ignore */ }
  const cx = Math.max(0, (window.innerWidth - DEFAULT_W) / 2);
  const cy = Math.max(0, (window.innerHeight - DEFAULT_H) / 2 - 80);
  return { geom: { x: cx, y: cy, w: DEFAULT_W, h: DEFAULT_H }, viewMode: 'chat' };
}

function saveLocal(id: string, geom: WindowGeometry, viewMode: ViewMode) {
  try {
    localStorage.setItem(LOCAL_KEY(id), JSON.stringify({ geom, viewMode }));
  } catch { /* ignore */ }
}

export function SubSessionWindow({
  sub, ws, connected, onDiff, onHistory, onMinimize, onClose, onRestart, onRename, zIndex, onFocus,
}: Props) {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const swipeBackRef = useSwipeBack(isMobile ? onMinimize : null);

  const { t } = useTranslation();
  const { events, refreshing } = useTimeline(sub.sessionName, ws);
  const quickData = useQuickData();

  // Earliest ts of the current continuous thinking sequence (shared logic).
  const activeThinkingTs = useMemo(() => getActiveThinkingTs(events), [events]);

  const [thinkingNow, setThinkingNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeThinkingTs) return;
    setThinkingNow(Date.now());
    const id = setInterval(() => setThinkingNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [!!activeThinkingTs]); // eslint-disable-line react-hooks/exhaustive-deps
  const isShell = sub.type === 'shell' || sub.type === 'script';
  const initial = loadLocal(sub.id);
  const [geom, setGeom] = useState<WindowGeometry>(initial.geom);
  const [viewMode, setViewMode] = useState<ViewMode>(isShell ? 'terminal' : initial.viewMode);
  const [confirmClose, setConfirmClose] = useState(false);
  const inputRef = useRef<HTMLDivElement>(null);
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const termScrollRef = useRef<(() => void) | null>(null);
  const chatScrollRef = useRef<(() => void) | null>(null);
  const onTermScrollBottomFn = useCallback((fn: () => void) => { termScrollRef.current = fn; }, []);
  const onChatScrollBottomFn = useCallback((fn: () => void) => { chatScrollRef.current = fn; }, []);

  // SessionInfo shape for SessionControls
  const sessionInfo: SessionInfo = {
    name: sub.sessionName,
    project: sub.label ?? sub.type,
    role: 'w1',
    agentType: sub.type,
    state: sub.state === 'running' ? 'running' : sub.state === 'stopped' ? 'stopped' : 'idle',
    projectDir: sub.cwd ?? undefined,
  };

  useEffect(() => {
    saveLocal(sub.id, geom, viewMode);
  }, [sub.id, geom, viewMode]);

  // Scroll to bottom whenever switching to chat view
  useEffect(() => {
    if (viewMode === 'chat') {
      setTimeout(() => chatScrollRef.current?.(), 50);
    }
  }, [viewMode]);

  // Re-subscribe terminal on mount so the server sends a fresh snapshot.
  // SubSessionWindow unmounts on minimize, so without this the remounted
  // TerminalView would start empty (no snapshot, only incremental data).
  useEffect(() => {
    if (!ws || !connected) return;
    try { ws.subscribeTerminal(sub.sessionName); } catch { /* ignore */ }
  }, [ws, connected, sub.sessionName]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (viewModeRef.current === 'chat') chatScrollRef.current?.();
      else termScrollRef.current?.();
    }, 50);
  }, []);

  // ── Dragging ──────────────────────────────────────────────────────────────
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const DRAG_MARGIN = 32; // px — minimum visible edge to keep in viewport

  const clampPos = useCallback((x: number, y: number, w: number) => ({
    x: Math.min(Math.max(x, DRAG_MARGIN - w), window.innerWidth - DRAG_MARGIN),
    y: Math.min(Math.max(y, 0), window.innerHeight - DRAG_MARGIN),
  }), []);

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
        return { x, y, w, h };
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onFocus]);

  const agentTag = sub.type === 'shell' ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type;
  const typeLabel = sub.label ? `${sub.label} · ${agentTag}` : agentTag;

  // Usage tracking
  const lastUsage = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'usage.update' && events[i].payload.inputTokens) {
        return events[i].payload as { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string };
      }
    }
    return null;
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
    <div ref={swipeBackRef} class={`subsession-window${(sub.state !== 'idle' && sub.state !== 'stopped' && (sub.state === 'running' || activeThinkingTs)) ? ' subcard-running-pulse' : ''}`} style={style} onMouseDown={onFocus}>
      {/* 8-direction resize handles (desktop only) */}
      {!isMobile && (['n','s','e','w','ne','nw','se','sw'] as ResizeDir[]).map((dir) => (
        <div key={dir} class={`resize-handle resize-${dir}`} onMouseDown={onResizeMouseDown(dir)} />
      ))}

      {/* Header */}
      <div class="subsession-header" onMouseDown={onHeaderMouseDown}>
        <span class="subsession-drag-icon">⠿</span>
        <span class="subsession-title">{typeLabel}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {!isShell && <button class="subsession-mode-btn" onClick={() => { const next = viewMode === 'chat' ? 'terminal' : 'chat'; setViewMode(next); if (next === 'chat') requestAnimationFrame(() => chatScrollRef.current?.()); }} title={viewMode === 'chat' ? 'Switch to terminal' : 'Switch to chat'}>{viewMode === 'chat' ? '⌨' : '💬'}</button>}
          <button class="subsession-minimize-btn" onClick={onMinimize} title="Minimize">─</button>
          {confirmClose ? (
            <>
              <span class="subsession-close-confirm-label">Terminate?</span>
              <button class="subsession-close-btn" onClick={onClose} title="Confirm close">✓</button>
              <button class="subsession-minimize-btn" onClick={() => setConfirmClose(false)} title="Cancel">✕</button>
            </>
          ) : (
            <button class="subsession-close-btn" onClick={() => setConfirmClose(true)} title="Close (terminate)">×</button>
          )}
        </div>
      </div>

      {/* Content */}
      <div class="subsession-content">
        <div style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}>
          <TerminalView
            sessionName={sub.sessionName}
            ws={ws}
            connected={connected}
            onDiff={(apply) => onDiff(sub.sessionName, apply)}
            onHistory={(apply) => onHistory(sub.sessionName, apply)}
            onScrollBottomFn={onTermScrollBottomFn}
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
          />
        )}
      </div>

      {/* Usage footer — context bar + cost */}
      {lastUsage && (() => {
        const ctx = lastUsage.contextWindow || 1_000_000;
        const total = lastUsage.inputTokens + lastUsage.cacheTokens;
        const totalPct = Math.min(100, total / ctx * 100);
        const cachePct = Math.min(totalPct, lastUsage.cacheTokens / ctx * 100);
        const newPct = totalPct - cachePct;
        const fmt = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
        const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
        const sessionCost = lastCostEvent ? getSessionCost(sub.sessionName) : 0;
        const weeklyCost = sessionCost > 0 ? getWeeklyCost() : 0;
        const monthlyCost = sessionCost > 0 ? getMonthlyCost() : 0;
        const tip = [
          lastUsage.model ?? '',
          `Context: ${fmt(total)} / ${fmt(ctx)} (${pctStr}%)`,
          `  New: ${fmt(lastUsage.inputTokens)}  Cache: ${fmt(lastUsage.cacheTokens)}`,
        ].filter(Boolean).join('\n');
        return (
          <div class="session-usage-footer" title={tip}>
            <div class="session-ctx-bar">
              <div class="session-ctx-cache" style={{ width: `${cachePct}%` }} />
              <div class="session-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
            </div>
            <div class="session-usage-stats">
              <span class="session-usage-tokens">{fmt(total)} / {fmt(ctx)} ({pctStr}%)</span>
              {activeThinkingTs && (
                <span class="session-thinking-inline">
                  <span class="chat-thinking-dots">···</span>
                  {' '}{t('chat.thinking_running', { sec: Math.max(0, Math.round((thinkingNow - activeThinkingTs) / 1000)) })}
                </span>
              )}
              {sessionCost > 0 && (
                <span class="session-usage-cost" style={{ marginLeft: 'auto' }}>
                  {formatCost(sessionCost)} · wk {formatCost(weeklyCost)} · mo {formatCost(monthlyCost)}
                </span>
              )}
            </div>
          </div>
        );
      })()}

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
          sessionDisplayName={sub.label ?? agentTag}
          activeThinking={!!activeThinkingTs}
        />
      </div>
    </div>
  );
}
