/**
 * SubSessionCard — preview card showing live chat/terminal content for a sub-session.
 * Content renders at native size (no scaling) — card acts as a clipped viewport.
 * Right-edge drag handle lets user resize width independently per card.
 */
import { useRef, useState, useCallback, useMemo, useEffect } from 'preact/hooks';
import { ChatView } from './ChatView.js';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { TerminalView } from './TerminalView.js';
import { useTimeline } from '../hooks/useTimeline.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import { getActiveThinkingTs, isVisuallyBusy } from '../thinking-utils.js';

const TYPE_ICON: Record<string, string> = {
  'claude-code': '⚡',
  'codex': '📦',
  'opencode': '🔆',
  'openclaw': '☁️',
  'gemini': '♊',
  'shell': '🐚',
  'script': '🔄',
};

const STATE_BADGE: Record<string, string> = {
  starting: '…',
  unknown: '?',
  stopped: '■',
  idle: '●',
};

interface Props {
  sub: SubSession;
  ws: WsClient | null;
  connected: boolean;
  isOpen: boolean;
  isFocused?: boolean;
  onOpen: () => void;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  cardW?: number;
  cardH?: number;
}

function loadCardW(id: string, fallback: number): number {
  try {
    const v = localStorage.getItem(`rcc_subcard_w_${id}`);
    if (v) return Math.max(200, Math.min(1200, parseInt(v)));
  } catch { /* ignore */ }
  return fallback;
}

export function SubSessionCard({ sub, ws, connected, isOpen, isFocused, onOpen, onDiff, onHistory, cardW = 350, cardH = 250 }: Props) {
  const isShell = sub.type === 'shell' || sub.type === 'script';
  const { events, refreshing } = isShell ? { events: [], refreshing: false } : useTimeline(sub.sessionName, ws);
  const termScrollRef = useRef<(() => void) | null>(null);
  const agentTag = isShell ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type;
  const label = sub.label ? `${sub.label} · ${agentTag}` : agentTag;
  const icon = TYPE_ICON[sub.type] ?? '⚡';
  const badge = STATE_BADGE[sub.state];

  const busy = useMemo(() => isVisuallyBusy(sub.state, !!getActiveThinkingTs(events)), [events, sub.state]);

  // Flash red when sub-session transitions to idle
  const [idleFlash, setIdleFlash] = useState(false);
  const prevStateRef = useRef(sub.state);
  useEffect(() => {
    if (prevStateRef.current === 'running' && sub.state === 'idle') {
      setIdleFlash(true);
      const t = setTimeout(() => setIdleFlash(false), 3000);
      return () => clearTimeout(t);
    }
    prevStateRef.current = sub.state;
  }, [sub.state]);

  const lastUsage = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'usage.update' && events[i].payload.inputTokens) {
        return events[i].payload as { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string };
      }
    }
    return null;
  }, [events]);

  const modelLabel = useMemo(() => shortModelLabel(lastUsage?.model), [lastUsage]);

  // Per-card width override (persisted in localStorage)
  const [localW, setLocalW] = useState(() => loadCardW(sub.id, cardW));
  const draggingRef = useRef(false);

  // Use localW unless the global cardW has changed (reset local override)
  const effectiveW = localW;

  const onResizeMouseDown = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = effectiveW;

    const onMove = (me: MouseEvent) => {
      const newW = Math.max(200, Math.min(1200, startW + (me.clientX - startX)));
      setLocalW(newW);
    };
    const onUp = (me: MouseEvent) => {
      draggingRef.current = false;
      const newW = Math.max(200, Math.min(1200, startW + (me.clientX - startX)));
      setLocalW(newW);
      try { localStorage.setItem(`rcc_subcard_w_${sub.id}`, String(newW)); } catch { /* ignore */ }
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [effectiveW, sub.id]);

  // Touch support for mobile resize
  const onResizeTouchStart = useCallback((e: TouchEvent) => {
    e.stopPropagation();
    const startX = e.touches[0].clientX;
    const startW = effectiveW;

    const onMove = (te: TouchEvent) => {
      const newW = Math.max(200, Math.min(1200, startW + (te.touches[0].clientX - startX)));
      setLocalW(newW);
    };
    const onEnd = (te: TouchEvent) => {
      const touch = te.changedTouches[0];
      const newW = Math.max(200, Math.min(1200, startW + (touch.clientX - startX)));
      setLocalW(newW);
      try { localStorage.setItem(`rcc_subcard_w_${sub.id}`, String(newW)); } catch { /* ignore */ }
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
  }, [effectiveW, sub.id]);

  return (
    <div
      class={`subcard${isOpen ? ' subcard-open' : ''}${isFocused ? ' subcard-focused' : ''}${busy ? ' subcard-running-pulse' : ''}${idleFlash ? ' subcard-idle-flash' : ''}`}
      style={{ width: effectiveW, height: cardH, minWidth: effectiveW, position: 'relative' }}
      onClick={() => { if (!draggingRef.current) onOpen(); }}
    >
      {/* Header */}
      <div class="subcard-header">
        <span class="subcard-icon">{icon}</span>
        <span class="subcard-label">{label}</span>
        {badge && <span class="subcard-badge">{badge}</span>}
        {busy && <span class="subcard-running">●</span>}
        {modelLabel && <span class="subcard-model">{modelLabel}</span>}
        {lastUsage && (() => {
          const ctx = resolveContextWindow(lastUsage.contextWindow, lastUsage.model);
          const total = lastUsage.inputTokens + lastUsage.cacheTokens;
          const totalPct = Math.min(100, total / ctx * 100);
          const cachePct = Math.min(totalPct, lastUsage.cacheTokens / ctx * 100);
          const newPct = totalPct - cachePct;
          const fmt = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
          const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
          const tip = [
            lastUsage.model ?? '',
            `Context: ${fmt(total)} / ${fmt(ctx)} (${pctStr}%)`,
            `  New: ${fmt(lastUsage.inputTokens)}  Cache: ${fmt(lastUsage.cacheTokens)}`,
          ].filter(Boolean).join('\n');
          return (
            <div class="subcard-ctx-bar" title={tip}>
              <div class="subcard-ctx-cache" style={{ width: `${cachePct}%` }} />
              <div class="subcard-ctx-input" style={{ width: `${newPct}%`, left: `${cachePct}%` }} />
            </div>
          );
        })()}
      </div>

      {/* Preview — native size, clipped by card overflow:hidden, non-interactive */}
      <div class="subcard-preview">
        {isShell ? (
          <TerminalView
            sessionName={sub.sessionName}
            ws={ws}
            connected={connected}
            onDiff={(apply) => onDiff(sub.sessionName, apply)}
            onHistory={(apply) => onHistory(sub.sessionName, apply)}
            onScrollBottomFn={(fn) => { termScrollRef.current = fn; }}
          />
        ) : (
          <ChatView
            events={events}
            loading={false}
            refreshing={refreshing}
            sessionId={sub.sessionName}
            preview
          />
        )}
      </div>

      {/* Right-edge resize handle */}
      <div
        class="subcard-resize-handle"
        onMouseDown={onResizeMouseDown}
        onTouchStart={onResizeTouchStart}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
