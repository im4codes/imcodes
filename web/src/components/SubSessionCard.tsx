/**
 * SubSessionCard — preview card showing live chat/terminal content for a sub-session.
 * Content renders at native size (no scaling) — card acts as a clipped viewport.
 * Right-edge drag handle lets user resize width independently per card.
 */
import { useRef, useState, useCallback, useMemo, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ChatView } from './ChatView.js';
import { resolveContextWindow } from '../model-context.js';
import { shortModelLabel } from '../model-label.js';
import { TerminalView } from './TerminalView.js';
import { useTimeline } from '../hooks/useTimeline.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import { getActiveThinkingTs, isVisuallyBusy } from '../thinking-utils.js';
import { SessionControls } from './SessionControls.js';
import type { SessionInfo } from '../types.js';

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
  onClose?: () => void;
  onRestart?: () => void;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  cardW?: number;
  cardH?: number;
  quickData?: import('./QuickInputPanel.js').UseQuickDataResult;
  sessions?: import('../types.js').SessionInfo[];
  subSessions?: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  serverId?: string;
}

function loadCardW(id: string, fallback: number): number {
  try {
    const v = localStorage.getItem(`rcc_subcard_w_${id}`);
    if (v) return Math.max(200, Math.min(1200, parseInt(v)));
  } catch { /* ignore */ }
  return fallback;
}

export function SubSessionCard({ sub, ws, connected, isOpen, isFocused, onOpen, onClose, onRestart, onDiff, onHistory, cardW = 350, cardH = 250, quickData, sessions, subSessions, serverId }: Props) {
  const { t } = useTranslation();
  const isShell = sub.type === 'shell' || sub.type === 'script';
  const { events, refreshing } = isShell ? { events: [], refreshing: false } : useTimeline(sub.sessionName, ws);
  const termScrollRef = useRef<(() => void) | null>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const agentTag = isShell ? (sub.shellBin?.split('/').pop() ?? 'shell') : sub.type;
  const label = sub.label ? `${sub.label} · ${agentTag}` : agentTag;
  const icon = TYPE_ICON[sub.type] ?? '⚡';
  const badge = STATE_BADGE[sub.state];

  // Build a SessionInfo for SessionControls compact mode
  const sessionInfo = useMemo<SessionInfo>(() => ({
    name: sub.sessionName,
    project: sub.sessionName,
    role: 'w1',
    agentType: sub.type,
    state: (sub.state as SessionInfo['state']) ?? 'unknown',
    label: sub.label ?? null,
    projectDir: sub.cwd ?? undefined,
  }), [sub.sessionName, sub.type, sub.state, sub.label, sub.cwd]);

  const handleCardSend = useCallback(() => {
    const text = cardInputRef.current?.value?.trim();
    if (!text || !ws || !connected) return;
    try {
      ws.sendSessionCommand('send', { sessionName: sub.sessionName, text });
    } catch { /* ignore */ }
    cardInputRef.current!.value = '';
  }, [ws, connected, sub.sessionName]);


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

  // Auto-scroll preview to bottom when content updates
  useEffect(() => {
    const el = previewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, sub.state]);

  const lastUsage = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'usage.update' && events[i].payload.inputTokens) {
        return events[i].payload as { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string };
      }
    }
    return null;
  }, [events]);

  // Model may appear in any usage.update event — not only ones with inputTokens
  const detectedModel = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'usage.update' && events[i].payload.model) {
        return events[i].payload.model as string;
      }
    }
    return null;
  }, [events]);

  const modelLabel = useMemo(() => shortModelLabel(detectedModel ?? lastUsage?.model), [detectedModel, lastUsage]);

  // Per-card width override (persisted in localStorage)
  const [localW, setLocalW] = useState(() => loadCardW(sub.id, cardW));
  const draggingRef = useRef(false);

  // Use localW unless the global cardW has changed (reset local override)
  const effectiveW = localW;

  // Pointer-based resize — setPointerCapture routes all pointer events to the
  // handle element, bypassing the parent's HTML5 draggable mechanism entirely.
  const onResizePointerDown = useCallback((e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    draggingRef.current = true;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = effectiveW;

    const onMove = (pe: PointerEvent) => {
      setLocalW(Math.max(200, Math.min(1200, startW + (pe.clientX - startX))));
    };
    const onUp = (pe: PointerEvent) => {
      draggingRef.current = false;
      const newW = Math.max(200, Math.min(1200, startW + (pe.clientX - startX)));
      setLocalW(newW);
      try { localStorage.setItem(`rcc_subcard_w_${sub.id}`, String(newW)); } catch { /* ignore */ }
      target.releasePointerCapture(pe.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
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
          const ctx = resolveContextWindow(lastUsage.contextWindow, detectedModel ?? lastUsage.model);
          const total = lastUsage.inputTokens + lastUsage.cacheTokens;
          const totalPct = Math.min(100, total / ctx * 100);
          const cachePct = Math.min(totalPct, lastUsage.cacheTokens / ctx * 100);
          const newPct = totalPct - cachePct;
          const fmt = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
          const pctStr = totalPct < 1 ? totalPct.toFixed(1) : totalPct.toFixed(0);
          const tip = [
            detectedModel ?? lastUsage.model ?? '',
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

      {/* Preview — scrollable, auto-scrolls to bottom on new content */}
      <div class="subcard-preview" ref={previewRef}>
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

      {/* Compact input — reuses SessionControls with @picker, ⚡, 📎, paste upload */}
      <div class="subcard-input-area" onClick={(e) => e.stopPropagation()}>
        {quickData ? (
          <SessionControls
            ws={ws}
            activeSession={sessionInfo}
            quickData={quickData}
            compact
            hideShortcuts
            onSubStop={onClose}
            onSubRestart={onRestart}
            sessions={sessions}
            subSessions={subSessions}
            serverId={serverId}
          />
        ) : (
          <input
            ref={cardInputRef}
            class="subcard-input"
            type="text"
            placeholder={t('common.send') + '...'}
            disabled={!connected}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                handleCardSend();
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>

      {/* Resize handle — uses pointer capture to bypass parent's HTML5 draggable */}
      <div
        class="subcard-resize-handle"
        onPointerDown={onResizePointerDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
