/**
 * SessionPane — renders the complete session view for a single session.
 * Encapsulates: ChatView / TerminalView rendering, SessionControls input bar,
 * useTimeline hook, UsageFooter, and terminal fit/scroll/focus ref management.
 *
 * Extracted from app.tsx as part of the sidebar-redesign refactor (task 1.5).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { TerminalView } from './TerminalView.js';
import { ChatView } from './ChatView.js';
import { SessionControls } from './SessionControls.js';
import { UsageFooter } from './UsageFooter.js';
import { useTimeline } from '../hooks/useTimeline.js';
import { getActiveThinkingTs, getActiveStatusText } from '../thinking-utils.js';
import { recordCost } from '../cost-tracker.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import { formatLabel } from '../format-label.js';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo, TerminalDiff } from '../types.js';
import { extractLatestUsage } from '../usage-data.js';

type ViewMode = 'terminal' | 'chat';

export interface SessionPaneProps {
  serverId: string;
  session: SessionInfo;
  sessions: SessionInfo[];
  subSessions: Array<{ sessionName: string; type: string; label?: string | null; state: string; parentSession?: string | null }>;
  ws: WsClient | null;
  connected: boolean;
  /** Whether this pane is the currently active session (controls show/hide). */
  isActive: boolean;
  /** Current view mode for this session. */
  viewMode: ViewMode;
  /** For future split-view focus highlighting. */
  focused?: boolean;
  quickData: UseQuickDataResult;
  detectedModel?: string;

  // ── Ref-registration callbacks ─────────────────────────────────────────────
  /** Called with the terminal fit function so app.tsx can call it on resize/reconnect. */
  onFitFn?: (fn: () => void) => void;
  /** Called with the terminal scroll-to-bottom function. */
  onScrollBottomFn?: (fn: () => void) => void;
  /** Called with the terminal focus function. */
  onFocusFn?: (fn: () => void) => void;
  /** Called with the chat scroll-to-bottom function. */
  onChatScrollFn?: (fn: () => void) => void;
  /** Called with the chat input element ref so app.tsx can route keystrokes to it. */
  onInputRef?: (el: HTMLDivElement | null) => void;
  /** Called with the terminal diff applier for this session. */
  onDiff?: (apply: (diff: TerminalDiff) => void) => void;
  /** Called with the terminal history applier for this session. */
  onHistory?: (apply: (content: string) => void) => void;

  // ── Action callbacks ────────────────────────────────────────────────────────
  onStopProject?: (project: string) => void;
  onRenameSession?: () => void;
  onSettings?: () => void;
  /** Called after shortcut/action button clicks — use to restore xterm focus. */
  onAfterAction?: () => void;
  /** Mobile: whether the file browser overlay is open. */
  mobileFileBrowserOpen?: boolean;
  /** Mobile: called when the file browser overlay requests close. */
  onMobileFileBrowserClose?: () => void;
  /** Text to prefill into the input when a navigation action carries a quote. */
  pendingPrefillText?: string | null;
  /** Called after pendingPrefillText has been consumed by the input. */
  onPendingPrefillApplied?: () => void;
}

export function SessionPane({
  serverId,
  session,
  sessions,
  subSessions,
  ws,
  connected,
  isActive,
  viewMode,
  quickData,
  detectedModel,
  onFitFn,
  onScrollBottomFn,
  onFocusFn,
  onChatScrollFn,
  onInputRef,
  onDiff,
  onHistory,
  onStopProject,
  onRenameSession,
  onSettings,
  onAfterAction,
  mobileFileBrowserOpen,
  onMobileFileBrowserClose,
  pendingPrefillText,
  onPendingPrefillApplied,
}: SessionPaneProps) {
  const sessionName = session.name;

  // ── Timeline ────────────────────────────────────────────────────────────────
  const {
    events: timelineEvents,
    loading: timelineLoading,
    refreshing: timelineRefreshing,
    loadingOlder: timelineLoadingOlder,
    hasOlderHistory: timelineHasOlderHistory,
    addOptimisticUserMessage,
    loadOlderEvents,
  } = useTimeline(sessionName, ws, serverId);

  // ── Quotes ────────────────────────────────────────────────────────────────
  const [quotes, setQuotes] = useState<string[]>([]);
  const addQuote = useCallback((text: string) => {
    setQuotes((prev) => [...prev, text]);
  }, []);
  const removeQuote = useCallback((index: number) => {
    setQuotes((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Usage & thinking state ──────────────────────────────────────────────────
  const lastUsage = useMemo(() => extractLatestUsage(timelineEvents), [timelineEvents]);

  const lastCostEvent = useMemo(() => {
    for (let i = timelineEvents.length - 1; i >= 0; i--) {
      if (timelineEvents[i].type === 'usage.update' && timelineEvents[i].payload.costUsd) {
        return timelineEvents[i].payload as { costUsd: number };
      }
    }
    return null;
  }, [timelineEvents]);

  useEffect(() => {
    if (lastCostEvent?.costUsd) {
      recordCost(sessionName, lastCostEvent.costUsd);
    }
  }, [lastCostEvent?.costUsd, sessionName]);

  const activeThinkingTs = useMemo(() => getActiveThinkingTs(timelineEvents), [timelineEvents]);
  const statusText = useMemo(() => getActiveStatusText(timelineEvents), [timelineEvents]);

  // 1-second tick for thinking elapsed display (only while thinking)
  const [thinkingNow, setThinkingNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activeThinkingTs) return;
    setThinkingNow(Date.now());
    const id = setInterval(() => setThinkingNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [!!activeThinkingTs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Effective view mode: transport sessions are always chat
  const isTransportSession = session.runtimeType === 'transport';
  const effectiveViewMode: ViewMode = isTransportSession ? 'chat' : viewMode;

  // ── Chat scroll + input ref ─────────────────────────────────────────────────
  const chatScrollFnRef = useRef<(() => void) | null>(null);
  const setChatScrollFn = useCallback((fn: () => void) => {
    chatScrollFnRef.current = fn;
    onChatScrollFn?.(fn);
  }, [onChatScrollFn]);

  // Terminal scroll fn (populated by TerminalView, also forwarded to app.tsx via onScrollBottomFn prop)
  const termScrollFnRef = useRef<(() => void) | null>(null);
  const handleTermScrollFn = useCallback((fn: () => void) => {
    termScrollFnRef.current = fn;
    onScrollBottomFn?.(fn);
  }, [onScrollBottomFn]);

  // inputRef for SessionControls — expose to app.tsx via onInputRef
  const inputRef = useRef<HTMLDivElement>(null);
  // Re-register with app.tsx when session becomes active/inactive
  useEffect(() => {
    if (!onInputRef) return;
    if (isActive) {
      // SessionControls is now mounted — inputRef.current will be set after first render.
      // Use rAF to ensure the DOM ref is populated before registering.
      const id = requestAnimationFrame(() => { onInputRef(inputRef.current); });
      return () => cancelAnimationFrame(id);
    } else {
      onInputRef(null);
      return undefined;
    }
  }, [isActive, onInputRef]);

  // ── Scroll to bottom in whichever view is active ────────────────────────────
  const scrollToBottom = useCallback(() => {
    if (effectiveViewMode === 'chat') {
      chatScrollFnRef.current?.();
    } else {
      termScrollFnRef.current?.();
    }
  }, [effectiveViewMode]);

  const terminalVisible = isActive && effectiveViewMode === 'terminal';
  const chatVisible = isActive && effectiveViewMode === 'chat';
  const isShellTerminal = terminalVisible && (session.agentType === 'shell' || session.agentType === 'script');

  useEffect(() => {
    if (!terminalVisible || !connected || !ws) return;
    try { ws.sendSnapshotRequest(sessionName); } catch { /* ignore */ }
  }, [terminalVisible, connected, ws, sessionName]);


  return (
    <div class={isShellTerminal ? 'shell-terminal-pane' : undefined} style={{ display: 'contents' }}>
      {/* Terminal view: kept alive, shown/hidden via CSS display */}
      <div
        key={`term-${sessionName}`}
        style={{ display: terminalVisible ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}
      >
        <TerminalView
          sessionName={sessionName}
          ws={ws}
          connected={connected}
          active={terminalVisible}
          onDiff={onDiff ? (apply) => onDiff(apply) : undefined}
          onHistory={onHistory ? (apply) => onHistory(apply) : undefined}
          onFocusFn={onFocusFn}
          onFitFn={onFitFn}
          onScrollBottomFn={handleTermScrollFn}
          mobileInput={session.agentType === 'shell'}
        />
      </div>

      {/* Chat view: only rendered when active + in chat mode */}
      {chatVisible && (
        <ChatView
          events={timelineEvents}
          loading={timelineLoading}
          refreshing={timelineRefreshing}
          loadingOlder={timelineLoadingOlder}
          hasOlderHistory={timelineHasOlderHistory}
          onLoadOlder={loadOlderEvents}
          sessionId={sessionName}
          sessionState={session.state}
          onScrollBottomFn={setChatScrollFn}
          workdir={session.projectDir}
          ws={connected ? ws : null}
          serverId={serverId}
          onQuote={addQuote}
        />
      )}

      {/* Usage footer: shown only when active */}
      {isActive && (lastUsage || activeThinkingTs || statusText) && (
        <UsageFooter
          usage={lastUsage ?? { inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
          sessionName={sessionName}
          agentType={session.agentType}
          modelOverride={session.modelDisplay ?? (session.agentType === 'qwen' ? session.qwenModel : undefined)}
          planLabel={session.planLabel}
          quotaLabel={session.agentType === 'codex' ? session.quotaLabel : undefined}
          quotaUsageLabel={undefined}
          showCost={!!lastCostEvent}
          activeThinkingTs={activeThinkingTs}
          statusText={statusText}
          now={thinkingNow}
        />
      )}

      {/* Session controls: shown only when active */}
      {isActive && (
        <SessionControls
          ws={ws}
          activeSession={session}
          inputRef={inputRef}
          onAfterAction={onAfterAction}
          onSend={(_name, text) => {
            addOptimisticUserMessage(text);
            scrollToBottom();
          }}
          onStopProject={onStopProject}
          onRenameSession={onRenameSession}
          onSettings={onSettings}
          sessionDisplayName={session.label ? formatLabel(session.label) : (session.project ?? null)}
          quickData={quickData}
          detectedModel={detectedModel}
          hideShortcuts={false}
          activeThinking={!!activeThinkingTs}
          mobileFileBrowserOpen={mobileFileBrowserOpen}
          onMobileFileBrowserClose={onMobileFileBrowserClose}
          sessions={sessions}
          subSessions={subSessions}
          serverId={serverId}
          quotes={quotes}
          onRemoveQuote={removeQuote}
          pendingPrefillText={pendingPrefillText}
          onPendingPrefillApplied={onPendingPrefillApplied}
        />
      )}
    </div>
  );
}
