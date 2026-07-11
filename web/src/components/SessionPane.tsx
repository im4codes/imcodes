/**
 * SessionPane — renders the complete session view for a single session.
 * Encapsulates: ChatView / TerminalView rendering, SessionControls input bar,
 * useTimeline hook, UsageFooter, and terminal fit/scroll/focus ref management.
 *
 * Extracted from app.tsx as part of the sidebar-redesign refactor (task 1.5).
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { TerminalView } from './TerminalView.js';
import { ChatView } from './ChatView.js';
import { SessionControls } from './SessionControls.js';
import { UsageFooter } from './UsageFooter.js';
import { requestActiveTimelineRefreshAfterUserAction, useTimeline } from '../hooks/useTimeline.js';
import { findTrailingAskQuestion, type TrailingAskQuestion } from '../find-pending-question.js';
import { getActiveThinkingTs, getActiveStatusText, getTailSessionStateInfo, hasActiveToolCall } from '../thinking-utils.js';
import { hasActiveTimelineTurn } from '../timeline-running.js';
import { recordCost } from '../cost-tracker.js';
import { resolveTimelineBackedSessionState } from '../session-live-status.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import { formatLabel } from '../format-label.js';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo, TerminalDiff } from '../types.js';
import { extractLatestUsage } from '../usage-data.js';
import { getLatestTransportActivityDetail } from '../transport-activity-status.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { useExecutionRouting } from '../hooks/useExecutionRouting.js';
import { resolveSessionInfoRuntimeType } from '../runtime-type.js';
import { resolveEffectiveSessionModel } from '@shared/session-model.js';
import { loadLegacyCodexModelPreferenceForModelessSession } from '../codex-model-preference.js';
import type { FileBrowserPreviewRequest } from './file-browser-lazy.js';
import { buildMemorySummarySyncMessage, localPersonalMemorySummarySource } from '../memory-summary-sync.js';
import { EXECUTION_CLONE_KIND } from '@shared/execution-clone.js';

function isExecutionCloneTemplateLike(sub: { executionCloneKind?: string | null; parentRunId?: string | null }): boolean {
  return sub.executionCloneKind === EXECUTION_CLONE_KIND || typeof sub.parentRunId === 'string';
}

type ViewMode = 'terminal' | 'chat';

const IDLE_HISTORY_STATUS = {
  phase: 'idle',
  steps: {
    cache: 'skipped',
    textTail: 'skipped',
    daemon: 'skipped',
    http: 'skipped',
    older: 'skipped',
  },
} as const;

export interface SessionPaneProps {
  serverId: string;
  /** Report the trailing pending ask.question (or null) so the app can
   *  re-surface it in the dedicated question dialog from history. */
  onPendingQuestion?: (sessionName: string, q: TrailingAskQuestion | null) => void;
  session: SessionInfo;
  sessions: SessionInfo[];
  subSessions: Array<{
    sessionName: string;
    type: string;
    label?: string | null;
    state: string;
    parentSession?: string | null;
    executionCloneKind?: string | null;
    parentRunId?: string | null;
    executionTemplateEligible?: boolean;
    executionTemplateIneligibleReason?: string;
  }>;
  ws: WsClient | null;
  connected: boolean;
  /** Whether this pane is the currently active session (controls show/hide). */
  isActive: boolean;
  /** Current view mode for this session. */
  viewMode: ViewMode;
  /** For future split-view focus highlighting. */
  focused?: boolean;
  /** Whether this pane is the active target for window-level shortcuts. */
  keyboardActive?: boolean;
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
  onShareSession?: (session: SessionInfo, subSessionId?: string | null) => void;
  sessionPinned?: boolean;
  stopBlockedByPinned?: boolean;
  onToggleSessionPin?: (sessionName: string) => void;
  onViewRepo?: () => void;
  onTransportConfigSaved?: (transportConfig: Record<string, unknown> | null) => void;
  /** Called after shortcut/action button clicks — use to restore xterm focus. */
  onAfterAction?: () => void;
  /** Open a file preview in the shared floating preview host. */
  onPreviewFile?: (request: FileBrowserPreviewRequest) => void;
  /** Mobile: whether the file browser overlay is open. */
  mobileFileBrowserOpen?: boolean;
  /** Mobile: called when the file browser overlay requests close. */
  onMobileFileBrowserClose?: () => void;
  /** Text to prefill into the input when a navigation action carries a quote. */
  pendingPrefillText?: string | null;
  /** Called after pendingPrefillText has been consumed by the input. */
  onPendingPrefillApplied?: () => void;
  /** Gate version-sensitive panels when the loaded frontend is stale. */
  onVersionSensitiveAction?: (featureLabel: string, action: () => void) => void;
}

export function SessionPane({
  serverId,
  onPendingQuestion,
  session,
  sessions,
  subSessions,
  ws,
  connected,
  isActive,
  keyboardActive,
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
  onShareSession,
  sessionPinned,
  stopBlockedByPinned,
  onToggleSessionPin,
  onViewRepo,
  onTransportConfigSaved,
  onAfterAction,
  onPreviewFile,
  mobileFileBrowserOpen,
  onMobileFileBrowserClose,
  pendingPrefillText,
  onPendingPrefillApplied,
  onVersionSensitiveAction,
}: SessionPaneProps) {
  const { t } = useTranslation();
  const sessionName = session.name;
  const hasChatTimeline = session.agentType !== 'shell' && session.agentType !== 'script';
  const [syncingMemorySummaries, setSyncingMemorySummaries] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [executionClonesBusy, setExecutionClonesBusy] = useState(false);
  const executionRouting = useExecutionRouting(serverId ?? null);

  // ── Timeline ────────────────────────────────────────────────────────────────
  const {
    events: timelineEvents,
    loading: timelineLoading,
    refreshing: timelineRefreshing,
    historyStatus: timelineHistoryStatus,
    loadingOlder: timelineLoadingOlder,
    hasOlderHistory: timelineHasOlderHistory,
    addOptimisticUserMessage,
    markOptimisticFailed,
    retryOptimisticMessage,
    loadOlderEvents,
    forceRefresh: timelineForceRefresh,
  } = useTimeline(sessionName, ws, serverId, {
    isActiveSession: isActive,
    disableHistory: !hasChatTimeline,
  });
  const historyStatus = timelineHistoryStatus ?? IDLE_HISTORY_STATUS;

  // Re-surface a still-pending agent question in the dedicated dialog from
  // timeline history (e.g. opened from a push notification / after reload).
  useEffect(() => {
    if (!isActive || !onPendingQuestion) return;
    onPendingQuestion(sessionName, findTrailingAskQuestion(timelineEvents));
  }, [isActive, onPendingQuestion, sessionName, timelineEvents]);

  // ── Quotes ────────────────────────────────────────────────────────────────
  const [quotes, setQuotes] = useState<string[]>([]);
  const addQuote = useCallback((text: string) => {
    setQuotes((prev) => [...prev, text]);
  }, []);
  const removeQuote = useCallback((index: number) => {
    setQuotes((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Retry failed send ─────────────────────────────────────────────────────
  // Reads the failed optimistic bubble from the timeline cache (it stores the
  // original text + extras), dispatches a fresh session.send with a new
  // commandId, and updates the existing bubble in place.
  const timelineEventsRef = useRef(timelineEvents);
  timelineEventsRef.current = timelineEvents;
  const handleResendFailed = useCallback((commandId: string, text: string) => {
    if (!ws || !connected) return;
    const failedEvent = timelineEventsRef.current.find(
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
      // Retry replays the ORIGINAL send verbatim: `resendExtra` already carries
      // the alias A′ map resolved when the user first composed it, so we must
      // NOT re-resolve here (Cx1-2/Cx1-3) — re-resolving against the current
      // list could change or leak values.
      ws.sendSessionCommand('send', {
        sessionName,
        text,
        ...(resendExtra ?? {}),
        commandId: newCommandId,
      });
      requestActiveTimelineRefreshAfterUserAction();
    } catch {
      return;
    }
    retryOptimisticMessage(commandId, newCommandId, text, {
      ...(attachmentsFromFailure ? { attachments: attachmentsFromFailure } : {}),
      ...(resendExtra ? { resendExtra } : {}),
    });
  }, [connected, retryOptimisticMessage, sessionName, ws]);

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
  const activeToolCall = useMemo(() => hasActiveToolCall(timelineEvents), [timelineEvents]);
  const activeTimelineTurn = useMemo(() => hasActiveTimelineTurn(timelineEvents), [timelineEvents]);
  const transportActivityDetail = useMemo(() => getLatestTransportActivityDetail(timelineEvents), [timelineEvents]);
  const timelineSessionStateInfo = useMemo(() => getTailSessionStateInfo(timelineEvents), [timelineEvents]);
  const timelineLastEventTs =
    timelineEvents.length > 0 ? (timelineEvents[timelineEvents.length - 1]?.ts ?? null) : null;
  const timelineSessionState = timelineSessionStateInfo.state;
  const liveSessionState = useMemo(
    () => resolveTimelineBackedSessionState({
      timelineState: timelineSessionState,
      sessionState: session.state,
      activeThinking: !!activeThinkingTs,
      activeToolCall,
      activeTransportTurn: activeTimelineTurn,
      timelineStateTs: timelineSessionStateInfo.ts,
      timelineLastEventTs,
    }),
    [activeThinkingTs, activeTimelineTurn, activeToolCall, session.state, timelineLastEventTs, timelineSessionState, timelineSessionStateInfo.ts],
  );
  // shell / script sessions have no agent state, no token usage, no quota —
  // suppress the footer entirely so they don't see misleading "Agent
  // working..." text when raw bytes flow (idle detection fires session.state
  // 'running' on any pipe-pane output, not just real agent activity).
  const isAgentlessSession = session.agentType === 'shell' || session.agentType === 'script';
  const shouldShowFooter = !isAgentlessSession;

  const thinkingNow = useNowTicker(!!activeThinkingTs);

  // Effective view mode: transport sessions are always chat
  const effectiveRuntimeType = resolveSessionInfoRuntimeType(session);
  const isTransportSession = effectiveRuntimeType === 'transport';
  const effectiveViewMode: ViewMode = isTransportSession ? 'chat' : viewMode;
  const controlsSession = useMemo<SessionInfo>(() => {
    if (!isTransportSession || !liveSessionState || liveSessionState === session.state) return session;
    return { ...session, state: liveSessionState as SessionInfo['state'] };
  }, [isTransportSession, liveSessionState, session]);

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
  const fileDropTargetRef = useRef<HTMLDivElement>(null);
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

  const executionTemplateDisplayName = useMemo(() => {
    const template = executionRouting.templateSessionName;
    if (!template) return null;
    const sub = subSessions.find((item) => item.sessionName === template);
    if (sub && !isExecutionCloneTemplateLike(sub)) return sub.label || sub.sessionName.split('_').pop() || sub.sessionName;
    return null;
  }, [executionRouting.templateSessionName, subSessions]);
  const hasValidExecutionTemplate = Boolean(
    executionRouting.enabled
    && executionRouting.templateSessionName
    && executionTemplateDisplayName
    && executionRouting.templateSessionName !== sessionName,
  );
  const executionCloneCount = executionRouting.limits.maxParallelClones;
  const runExecutionClonesTitle = !connected || !ws
    ? t('chat.execution_clone_run_offline')
    : !hasValidExecutionTemplate
      ? t('chat.execution_clone_run_no_template')
      : !(composerText.trim() || inputRef.current?.textContent?.trim())
        ? t('chat.execution_clone_run_empty')
        : t('chat.execution_clone_run_with_template', {
            count: executionCloneCount,
            name: executionTemplateDisplayName,
          });
  const handleRunExecutionClones = useCallback(() => {
    const text = (inputRef.current?.textContent ?? composerText).trim();
    if (!ws || !connected || !hasValidExecutionTemplate || !executionRouting.templateSessionName || !text) return;
    const commandId = globalThis.crypto?.randomUUID?.()
      ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setExecutionClonesBusy(true);
    try {
      ws.sendExecutionClones({
        sessionName,
        text,
        commandId,
        dedicatedExecutionRouting: {
          enabled: true,
          templateSessionName: executionRouting.templateSessionName,
          maxParallelClones: executionRouting.limits.maxParallelClones,
          maxQueuedClones: executionRouting.limits.maxQueuedClones,
          cloneHardTimeoutMs: executionRouting.limits.cloneHardTimeoutMs,
          cloneRetentionMs: executionRouting.limits.cloneRetentionMs,
        },
      });
    } finally {
      window.setTimeout(() => setExecutionClonesBusy(false), 1200);
    }
  }, [composerText, connected, executionRouting.limits, executionRouting.templateSessionName, hasValidExecutionTemplate, sessionName, ws]);

  const handleSyncMemorySummaries = useCallback(async () => {
    if (!ws || !connected || syncingMemorySummaries) return;
    setSyncingMemorySummaries(true);
    try {
      const text = await buildMemorySummarySyncMessage(
        t,
        session.contextNamespace?.projectId ?? null,
        undefined,
        { sources: [localPersonalMemorySummarySource(ws)] },
      );
      if (!text) return;
      const commandId = globalThis.crypto?.randomUUID?.()
        ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      // Alias A′ opt-out (Cx1-2): this is a generated memory-summary sync, not a
      // human-composed message, so it deliberately carries no resolvedAliases.
      ws.sendSessionCommand('send', { sessionName, text, commandId });
      requestActiveTimelineRefreshAfterUserAction();
      if (hasChatTimeline) {
        addOptimisticUserMessage(text, commandId);
        scrollToBottom();
      }
    } catch {
      // Keep the footer button non-intrusive; a failed sync should not block
      // normal chat controls or surface stale memory as if it were sent.
    } finally {
      setSyncingMemorySummaries(false);
    }
  }, [addOptimisticUserMessage, connected, hasChatTimeline, scrollToBottom, session.contextNamespace?.projectId, sessionName, syncingMemorySummaries, t, ws]);

  const terminalVisible = isActive && effectiveViewMode === 'terminal';
  const chatVisible = isActive && effectiveViewMode === 'chat';
  const isShellTerminal = terminalVisible && (session.agentType === 'shell' || session.agentType === 'script');
  const legacyCodexModel = loadLegacyCodexModelPreferenceForModelessSession(session, detectedModel, lastUsage?.model);
  const effectiveDetectedModel = detectedModel ?? legacyCodexModel ?? undefined;

  useEffect(() => {
    if (!terminalVisible || !connected || !ws) return;
    try { ws.sendSnapshotRequest(sessionName); } catch { /* ignore */ }
  }, [terminalVisible, connected, ws, sessionName]);


  return (
    <div
      ref={fileDropTargetRef}
      class={`session-pane${isActive ? '' : ' session-pane-inactive'}${isShellTerminal ? ' shell-terminal-pane' : ''}`}
    >
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
          onForceSync={timelineForceRefresh}
          historyStatus={historyStatus}
          loadingOlder={timelineLoadingOlder}
          hasOlderHistory={timelineHasOlderHistory}
          onLoadOlder={loadOlderEvents}
          sessionId={sessionName}
          sessionState={liveSessionState ?? undefined}
          onScrollBottomFn={setChatScrollFn}
          workdir={session.projectDir}
          onViewRepo={onViewRepo}
          onPreviewFile={onPreviewFile}
          ws={connected ? ws : null}
          serverId={serverId}
          onQuote={addQuote}
          agentType={session.agentType}
          onResendFailed={handleResendFailed}
        />
      )}

      {/* Usage footer: shown only when active */}
      {isActive && shouldShowFooter && (
        <UsageFooter
          usage={lastUsage ?? { inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
          sessionName={sessionName}
          sessionState={liveSessionState}
          agentType={session.agentType}
          wsClient={ws}
          connected={connected}
          modelOverride={resolveEffectiveSessionModel(session, effectiveDetectedModel, lastUsage?.model)}
          planLabel={session.planLabel}
          quotaLabel={session.quotaLabel}
          quotaUsageLabel={session.quotaUsageLabel}
          quotaMeta={session.quotaMeta}
          showCost={!!lastCostEvent}
          activeThinkingTs={activeThinkingTs}
          statusText={statusText}
          activeToolCall={activeToolCall}
          activeTimelineTurn={activeTimelineTurn}
          transportActivityDetail={transportActivityDetail}
          sessionError={session.error}
          now={thinkingNow}
          onSyncMemorySummaries={handleSyncMemorySummaries}
          syncMemorySummariesBusy={syncingMemorySummaries}
          syncMemorySummariesDisabled={!connected || !ws || syncingMemorySummaries}
          onRunExecutionClones={handleRunExecutionClones}
          runExecutionClonesBusy={executionClonesBusy}
          runExecutionClonesDisabled={
            executionClonesBusy
            || !connected
            || !ws
            || !hasValidExecutionTemplate
            || !(composerText.trim() || inputRef.current?.textContent?.trim())
          }
          runExecutionClonesTitle={runExecutionClonesTitle}
          runExecutionClonesCount={executionCloneCount}
        />
      )}

      {/* Session controls: shown only when active */}
      {isActive && (
        <SessionControls
          ws={ws}
          connected={connected}
          activeSession={controlsSession}
          inputRef={inputRef}
          onAfterAction={onAfterAction}
          onSend={(_name, text, meta) => {
            // Always inject the optimistic user bubble for normal chat sends.
            // Transport echoes reconcile by commandId, and queued sends are
            // removed from the timeline once the daemon emits queued state.
            //
            // EXCEPT for P2P commands: `@@all(discuss) xxx` / `@@label(audit) xxx`
            // is a command to start a P2P run — not a chat message to the
            // main session's agent. Injecting an optimistic bubble leaves a
            // stray user message in the main session's timeline (the real
            // conversation lives in .imc/discussions/<run>.md). Detect via
            // the payload extras the composer attaches for structured P2P
            // dispatch (p2pAtTargets / p2pMode / p2pSessionConfig). Skip
            // bubble injection entirely; the daemon emits `p2p.run_started`
            // which the discussions UI surfaces as its own run card.
            const extras = meta?.extra as Record<string, unknown> | undefined;
            const isP2pSend = !!extras && (
              Array.isArray(extras.p2pAtTargets) && extras.p2pAtTargets.length > 0
              || (typeof extras.p2pMode === 'string' && extras.p2pMode.length > 0)
              || (extras.p2pSessionConfig != null && typeof extras.p2pSessionConfig === 'object')
            );
            if (isP2pSend) return;
            if (!hasChatTimeline) return;
            addOptimisticUserMessage(text, meta?.commandId, {
              ...(meta?.attachments ? { attachments: meta.attachments } : {}),
              ...(meta?.extra ? { resendExtra: meta.extra } : {}),
            });
            if (meta?.commandId && meta.localFailure) {
              markOptimisticFailed(meta.commandId, meta.localFailure);
            }
            scrollToBottom();
          }}
          onStopProject={onStopProject}
          onRenameSession={onRenameSession}
          onSettings={onSettings}
          onShareSession={onShareSession}
          sessionPinned={sessionPinned}
          stopBlockedByPinned={stopBlockedByPinned}
          onToggleSessionPin={onToggleSessionPin}
          onTransportConfigSaved={onTransportConfigSaved}
          sessionDisplayName={session.label ? formatLabel(session.label) : (session.project ?? null)}
          quickData={quickData}
          detectedModel={effectiveDetectedModel}
          hideShortcuts={false}
          activeThinking={!!activeThinkingTs}
          activeTransportTurn={activeTimelineTurn}
          keyboardActive={keyboardActive ?? isActive}
          mobileFileBrowserOpen={mobileFileBrowserOpen}
          onMobileFileBrowserClose={onMobileFileBrowserClose}
          sessions={sessions}
          subSessions={subSessions}
          serverId={serverId}
          fileDropTargetRef={fileDropTargetRef}
          quotes={quotes}
          onRemoveQuote={removeQuote}
          pendingPrefillText={pendingPrefillText}
          onPendingPrefillApplied={onPendingPrefillApplied}
          onVersionSensitiveAction={onVersionSensitiveAction}
          onComposerTextChange={setComposerText}
        />
      )}
    </div>
  );
}
