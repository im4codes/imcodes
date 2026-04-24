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
import { IdleFlashLayer } from './IdleFlashLayer.js';
import { useIdleFlashPlayback } from '../hooks/useIdleFlashPlayback.js';
import { isTransportRuntime, resolveSubSessionRuntimeType } from '../runtime-type.js';

const TYPE_ICON: Record<string, string> = {
  'claude-code': '⚡',
  'claude-code-sdk': '⚡',
  'codex': '📦',
  'codex-sdk': '📦',
  'copilot-sdk': '🧭',
  'cursor-headless': '➤',
  'opencode': '🔆',
  'openclaw': '☁️',
  'qwen': '千',
  'gemini': '♊',
  'gemini-sdk': '♊',
  'shell': '🐚',
  'script': '🔄',
};

const STATE_BADGE: Record<string, string> = {
  starting: '…',
  stopping: '…',
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
  idleFlashToken?: number;
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
  onTransportConfigSaved?: (subId: string, transportConfig: Record<string, unknown> | null) => void;
  /** Whether this sub-session is participating in an active P2P discussion. */
  inP2p?: boolean;
}

function loadCardW(id: string, fallback: number): number {
  try {
    const v = localStorage.getItem(`rcc_subcard_w_${id}`);
    if (v) return Math.max(200, Math.min(1200, parseInt(v)));
  } catch { /* ignore */ }
  return fallback;
}

export function SubSessionCard({ sub, ws, connected, isOpen, isFocused, idleFlashToken, onOpen, onClose, onRestart, onDiff, onHistory, cardW = 350, cardH = 250, quickData, sessions, subSessions, serverId, onTransportConfigSaved, inP2p }: Props) {
  const { t } = useTranslation();
  const activeIdleFlashToken = useIdleFlashPlayback(idleFlashToken);
  const isShell = sub.type === 'shell' || sub.type === 'script';
  // Shell/script sub-sessions are terminal-only; they have no chat timeline
  // to attach optimistic bubbles to. For everything else we pull the
  // optimistic helpers so the card input behaves like the main-session pane
  // (message goes straight to the timeline with a spinner, reconciled by the
  // daemon echo).
  const timeline = isShell
    ? { events: [], refreshing: false, addOptimisticUserMessage: undefined, removeOptimisticMessage: undefined }
    : useTimeline(sub.sessionName, ws, serverId, {
      isActiveSession: !!isFocused,
    });
  const { events, refreshing } = timeline;
  const addOptimisticUserMessage = 'addOptimisticUserMessage' in timeline ? timeline.addOptimisticUserMessage : undefined;
  const removeOptimisticMessage = 'removeOptimisticMessage' in timeline ? timeline.removeOptimisticMessage : undefined;
  const termScrollRef = useRef<(() => void) | null>(null);
  const chatScrollRef = useRef<(() => void) | null>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const agentTag = isShell ? (sub.shellBin?.split(/[/\\]/).pop() ?? 'shell') : sub.type;
  const label = sub.label ? `${sub.label} · ${agentTag}` : agentTag;
  const icon = TYPE_ICON[sub.type] ?? '⚡';
  const badge = STATE_BADGE[sub.state];
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Shell/script cards render a live xterm preview. Keep them in raw mode so
  // command output is delivered immediately instead of waiting for passive
  // terminal snapshots; cleanup downgrades back to passive because App owns the
  // global sub-session subscription.
  useEffect(() => {
    if (!isShell || !ws || !connected) return;
    if (typeof ws.holdTerminalRaw === 'function') {
      return ws.holdTerminalRaw(sub.sessionName);
    }
    try { ws.subscribeTerminal(sub.sessionName, true); } catch { /* ignore */ }
    return () => {
      try { ws.subscribeTerminal(sub.sessionName, false); } catch { /* ignore */ }
    };
  }, [connected, isShell, sub.sessionName, ws]);

  // ── Retry failed send ─────────────────────────────────────────────────────
  // Same contract as SessionPane / SubSessionWindow. Shell/script sub-sessions
  // don't expose the optimistic helpers (no chat timeline), so the handler
  // becomes a no-op there.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const handleResendFailed = useCallback((commandId: string, text: string) => {
    if (!ws || !connected || !addOptimisticUserMessage || !removeOptimisticMessage) return;
    const failedEvent = eventsRef.current.find(
      (e) => e.type === 'user.message'
        && e.payload.failed === true
        && e.payload.commandId === commandId,
    );
    const resendExtra = failedEvent && typeof failedEvent.payload._resendExtra === 'object'
      ? (failedEvent.payload._resendExtra as Record<string, unknown>)
      : undefined;
    const attachmentsFromFailure = failedEvent && Array.isArray(failedEvent.payload.attachments)
      ? (failedEvent.payload.attachments as Array<Record<string, unknown>>)
      : undefined;
    const newCommandId = globalThis.crypto?.randomUUID?.()
      ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      ws.sendSessionCommand('send', {
        sessionName: sub.sessionName,
        text,
        ...(resendExtra ?? {}),
        commandId: newCommandId,
      });
    } catch {
      return;
    }
    removeOptimisticMessage(commandId);
    if (!isTransportRuntime(sub)) {
      addOptimisticUserMessage(text, newCommandId, {
        ...(attachmentsFromFailure ? { attachments: attachmentsFromFailure } : {}),
        ...(resendExtra ? { resendExtra } : {}),
      });
    }
  }, [addOptimisticUserMessage, connected, removeOptimisticMessage, sub.sessionName, ws]);

  // Build a SessionInfo for SessionControls compact mode
  const sessionInfo = useMemo<SessionInfo>(() => ({
    name: sub.sessionName,
    project: sub.sessionName,
    role: 'w1',
    agentType: sub.type,
    state: (sub.state as SessionInfo['state']) ?? 'unknown',
    label: sub.label ?? null,
    projectDir: sub.cwd ?? undefined,
    runtimeType: resolveSubSessionRuntimeType(sub),
    transportConfig: sub.transportConfig ?? undefined,
    transportPendingMessages: sub.transportPendingMessages ?? undefined,
    transportPendingMessageEntries: sub.transportPendingMessageEntries ?? undefined,
  }), [sub.sessionName, sub.type, sub.state, sub.label, sub.cwd, sub.runtimeType, sub.transportConfig, sub.transportPendingMessages, sub.transportPendingMessageEntries]);

  const forceFollowLatest = useCallback(() => {
    if (isShell) termScrollRef.current?.();
    else chatScrollRef.current?.();
    const el = previewRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setShowScrollBtn(false);
    }
  }, [isShell]);

  const handleCardSend = useCallback(() => {
    const text = cardInputRef.current?.value?.trim();
    if (!text || !ws || !connected) return;
    try {
      ws.sendSessionCommand('send', { sessionName: sub.sessionName, text });
    } catch { /* ignore */ }
    cardInputRef.current!.value = '';
    requestAnimationFrame(() => { forceFollowLatest(); });
  }, [ws, connected, sub.sessionName, forceFollowLatest]);

  const handleTransportStop = useCallback(() => {
    if (!ws || !connected || sub.state === 'stopped' || sub.state === 'stopping') return;
    try {
      ws.sendSessionCommand('send', { sessionName: sub.sessionName, text: '/stop' });
    } catch { /* ignore */ }
  }, [ws, connected, sub.sessionName, sub.state]);

  const busy = useMemo(() => isVisuallyBusy(sub.state, !!getActiveThinkingTs(events)), [events, sub.state]);
  // Preview cards always follow the latest content.
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setShowScrollBtn(!atBottom);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);
  useEffect(() => {
    requestAnimationFrame(() => { forceFollowLatest(); });
  }, [events, sub.state, forceFollowLatest]);
  const scrollToBottom = useCallback(() => {
    forceFollowLatest();
  }, [forceFollowLatest]);

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
      class={`subcard${isOpen ? ' subcard-open' : ''}${isFocused ? ' subcard-focused' : ''}${busy ? ' subcard-running-pulse' : ''}${quickPanelOpen ? ' subcard-quick-open' : ''}${overlayOpen ? ' subcard-overlay-open' : ''}`}
      style={{ width: effectiveW, height: cardH, minWidth: effectiveW, position: 'relative' }}
      onClick={() => { if (!draggingRef.current) onOpen(); }}
    >
      {activeIdleFlashToken ? <IdleFlashLayer key={`subcard-idle-${activeIdleFlashToken}`} variant="frame" /> : null}
      {/* Header */}
      <div class="subcard-header">
        <span class="subcard-icon">{icon}</span>
        <span class="subcard-label">{label}</span>
        {inP2p && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
        {badge && <span class="subcard-badge">{badge}</span>}
        {busy && <span class="subcard-running">●</span>}
        {modelLabel && <span class="subcard-model">{modelLabel}</span>}
        {sub.ccPresetId && <span class="subcard-custom-api" title={`Custom API: ${sub.ccPresetId}`}>◉</span>}
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
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div class={`subcard-preview${isShell ? ' subcard-preview-terminal' : ''}`} ref={previewRef}>
          {isShell ? (
            <TerminalView
              sessionName={sub.sessionName}
              ws={ws}
              connected={connected}
              preview
              mobileInput
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
              onScrollBottomFn={(fn) => { chatScrollRef.current = fn; }}
              preview
              agentType={sub.type}
              onResendFailed={handleResendFailed}
            />
          )}
        </div>
        {showScrollBtn && (
          <button class="subcard-scroll-bottom" onClick={(e) => { e.stopPropagation(); scrollToBottom(); }} title="Scroll to bottom">↓</button>
        )}
      </div>

      {/* Compact input — reuses SessionControls with @picker, ⚡, 📎, paste upload */}
      <div class="subcard-input-area" onClick={(e) => e.stopPropagation()}>
        <div class="subcard-input-row">
          {isTransportRuntime(sub) && (
            <button
              class="subcard-stop-btn"
              type="button"
              title={t('session.stop')}
              aria-label={t('session.stop')}
              disabled={!connected || sub.state === 'stopped' || sub.state === 'stopping'}
              onClick={(e) => {
                e.stopPropagation();
                handleTransportStop();
              }}
            >
              ■
            </button>
          )}
          <div class="subcard-input-main">
            {quickData ? (
              <SessionControls
                ws={ws}
                activeSession={sessionInfo}
                quickData={quickData}
                compact
                subSessionId={sub.id}
                onSubStop={onClose}
                onSubRestart={onRestart}
                sessions={sessions}
                subSessions={subSessions}
                serverId={serverId}
                onTransportConfigSaved={(transportConfig) => onTransportConfigSaved?.(sub.id, transportConfig)}
                onQuickOpenChange={setQuickPanelOpen}
                onOverlayOpenChange={setOverlayOpen}
                onSend={(_name, text, meta) => {
                  // Inject the optimistic "sending" bubble from the compact
                  // sub-session card — parity with SessionPane and
                  // SubSessionWindow. Shell/script cards have no helper
                  // (no chat timeline) so the call is a no-op there.
                  //
                  // Exception: P2P command sends do not belong in the
                  // sub-session's own chat — they start a discussion run
                  // whose conversation lives in the discussion file.
                  const extras = meta?.extra as Record<string, unknown> | undefined;
                  const isP2pSend = !!extras && (
                    Array.isArray(extras.p2pAtTargets) && extras.p2pAtTargets.length > 0
                    || (typeof extras.p2pMode === 'string' && extras.p2pMode.length > 0)
                    || (extras.p2pSessionConfig != null && typeof extras.p2pSessionConfig === 'object')
                  );
                  if (isP2pSend) return;
                  addOptimisticUserMessage?.(text, meta?.commandId, {
                    ...(meta?.attachments ? { attachments: meta.attachments } : {}),
                    ...(meta?.extra ? { resendExtra: meta.extra } : {}),
                  });
                  scrollToBottom();
                }}
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
        </div>
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
