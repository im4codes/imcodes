/**
 * SubSessionWindow — floating, draggable/resizable window for a sub-session.
 * Uses the full SessionControls for input (same as the main session).
 */
import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getActiveThinkingTs, getActiveStatusText, getTailSessionStateInfo, hasActiveToolCall } from '../thinking-utils.js';
import { recordCost } from '../cost-tracker.js';
import { resolveTimelineBackedSessionState } from '../session-live-status.js';
import { formatLabel } from '../format-label.js';
import { TerminalView } from './TerminalView.js';
import { ChatView } from './ChatView.js';
import { FileBrowser, type FileBrowserPreviewRequest } from './FileBrowser.js';
import { SessionControls } from './SessionControls.js';
import { UsageFooter } from './UsageFooter.js';
import { FloatingPanel } from './FloatingPanel.js';
import { DesktopWindowMaximizeButton } from './DesktopWindowMaximizeButton.js';
import { requestActiveTimelineRefreshAfterUserAction, useTimeline } from '../hooks/useTimeline.js';
import { useTerminalRawHold } from '../hooks/useTerminalRawHold.js';
import { findTrailingAskQuestion, type TrailingAskQuestion } from '../find-pending-question.js';
import { hasActiveTimelineTurn, hasPendingUserSend } from '../timeline-running.js';
import { getLatestTransportActivityDetail } from '../transport-activity-status.js';
import { useSwipeBack } from '../hooks/useSwipeBack.js';
import { useQuickData } from './QuickInputPanel.js';
import { useSharedGitChanges } from '../git-status-store.js';
import type { WsClient } from '../ws-client.js';
import type { TerminalDiff, SessionInfo } from '../types.js';
import type { SubSession } from '../hooks/useSubSessions.js';
import { extractLatestUsage } from '../usage-data.js';
import { IdleFlashLayer } from './IdleFlashLayer.js';
import { useIdleFlashPlayback } from '../hooks/useIdleFlashPlayback.js';
import { useNowTicker } from '../hooks/useNowTicker.js';
import { useExecutionRouting } from '../hooks/useExecutionRouting.js';
import { resolveSubSessionRuntimeType } from '../runtime-type.js';
import { DESKTOP_WINDOW_IDS } from '../window-stack.js';
import {
  clampGeometryFullyIntoWorkspace,
  clampGeometryToWorkspace,
  normalizeWindowGeometry,
  reserveWorkspaceBottom,
  shouldPersistGeometry,
  viewportWorkspaceBelowSessionTabs,
  type WindowGeometry,
  type WorkspaceBounds,
} from '../desktop-window-maximize.js';
import { resolveEffectiveSessionModel } from '@shared/session-model.js';
import { loadLegacyCodexModelPreferenceForModelessSession } from '../codex-model-preference.js';
import { DEFAULT_SUBSESSION_ACCENT_COLOR } from '../subsession-accent-colors.js';
import { buildMemorySummarySyncMessage, localPersonalMemorySummarySource } from '../memory-summary-sync.js';
import { EXECUTION_CLONE_KIND } from '@shared/execution-clone.js';

function isExecutionCloneTemplateLike(sub: { executionCloneKind?: string | null; parentRunId?: string | null }): boolean {
  return sub.executionCloneKind === EXECUTION_CLONE_KIND || typeof sub.parentRunId === 'string';
}

type GetMaximizeBounds = () => WorkspaceBounds | null;

interface Props {
  sub: SubSession;
  ws: WsClient | null;
  connected: boolean;
  /** When false, timeline and terminal subscriptions are paused to save CPU. */
  active: boolean;
  /** Report the trailing pending ask.question (or null) for dialog re-surface. */
  onPendingQuestion?: (sessionName: string, q: TrailingAskQuestion | null) => void;
  idleFlashToken?: number;
  onDiff: (sessionName: string, apply: (d: TerminalDiff) => void) => void;
  onHistory: (sessionName: string, apply: (c: string) => void) => void;
  onMinimize: () => void;
  onClose: () => void;
  maximized?: boolean;
  onToggleMaximized?: () => void;
  onRestoreBeforeClose?: () => void;
  getMaximizeBounds?: GetMaximizeBounds;
  desktopLayoutCapable?: boolean;
  onRestart: () => void;
  onRename: () => void;
  onSettings?: () => void;
  onShareSession?: (session: SessionInfo, subSessionId?: string | null) => void;
  onViewRepo?: () => void;
  onTransportConfigSaved?: (transportConfig: Record<string, unknown> | null) => void;
  /** Open a file preview in the shared floating preview host. */
  onPreviewFile?: (request: FileBrowserPreviewRequest) => void;
  zIndex: number;
  onFocus: () => void;
  /**
   * Owner-child stack integration for the delegated desktop file-browser
   * window owned by this sub-session. When supplied (desktop only), the
   * child file-browser sources its z-index from the shared stack and
   * notifies open/focus/close transitions so banded ordering keeps the
   * child above its owner while a newer unrelated peer can still sit
   * above the entire owner-child group.
   *
   * Mobile renders an inline overlay and ignores these props.
   */
  desktopFileBrowserZIndex?: number;
  onDesktopFileBrowserOpen?: () => void;
  onDesktopFileBrowserFocus?: () => void;
  onDesktopFileBrowserClose?: () => void;
  /** Optional: called to pin this sub-session to the sidebar. Passes current viewMode. */
  onPin?: (viewMode: 'terminal' | 'chat') => void;
  sessions?: SessionInfo[];
  subSessions?: Array<{
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
  serverId?: string;
  pendingPrefillText?: string | null;
  onPendingPrefillApplied?: () => void;
  onVersionSensitiveAction?: (featureLabel: string, action: () => void) => void;
  detectedModelHint?: string;
  /** Whether this sub-session is participating in an active P2P discussion. */
  inP2p?: boolean;
  accentColor?: string;
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

const LOCAL_KEY = (id: string) => `rcc_subsession_${id}`;
const DEFAULT_W = 620;
const DEFAULT_H = 620;
const MIN_W = 600;
const MIN_H = 400;
// Mobile sub-session windows should only clear the bottom sub-session
// launcher/card area. Parent usage footers and composers can sit behind
// the overlay; counting them pushes the window too high.
const MOBILE_SUBSESSION_BAR_SELECTORS = [
  '.subcard-bar',
] as const;

function getExternalMobileSubSessionBarElements(doc: Document = document): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const candidates: HTMLElement[] = [];
  for (const selector of MOBILE_SUBSESSION_BAR_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
      if (seen.has(el)) continue;
      if (el.closest('.subsession-window')) continue;
      seen.add(el);
      candidates.push(el);
    }
  }
  return candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
}

export function measureMobileSubSessionBarHeight(
  doc: Document = document,
  viewportHeight = window.visualViewport?.height ?? window.innerHeight,
): number {
  const elements = getExternalMobileSubSessionBarElements(doc);
  if (elements.length === 0) return 0;

  const visibleTops = elements
    .map((el) => el.getBoundingClientRect())
    .filter((rect) => rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight)
    .map((rect) => Math.max(0, rect.top));
  if (visibleTops.length > 0) {
    return Math.ceil(Math.max(0, viewportHeight - Math.min(...visibleTops)));
  }

  return Math.ceil(elements.reduce((total, el) => total + Math.max(0, el.offsetHeight), 0));
}

function isMobileSubSessionBarSuppressed(doc: Document = document): boolean {
  const root = doc.documentElement;
  return root.classList.contains('kb-open') || root.classList.contains('input-focused');
}

function getInitialMobileSubSessionBarHeight(isMobile: boolean): number {
  if (!isMobile || typeof document === 'undefined') return 0;
  if (isMobileSubSessionBarSuppressed()) return 0;
  return measureMobileSubSessionBarHeight();
}

function currentDesktopBounds(): WorkspaceBounds {
  return reserveWorkspaceBottom(viewportWorkspaceBelowSessionTabs({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    minW: MIN_W,
    minH: MIN_H,
  }));
}

function clampDesktopGeom(geom: WindowGeometry): WindowGeometry {
  const bounds = currentDesktopBounds();
  return clampGeometryFullyIntoWorkspace(geom, bounds, {
    minW: MIN_W,
    minH: MIN_H,
  });
}

function clampMaximizedGeom(bounds: WorkspaceBounds): WindowGeometry {
  const workspace = currentDesktopBounds();
  const minW = Math.min(MIN_W, workspace.w);
  const minH = Math.min(MIN_H, workspace.h);
  return clampGeometryToWorkspace({
    x: bounds.x,
    y: bounds.y,
    w: Math.max(bounds.w, minW),
    h: Math.max(bounds.h, minH),
  }, workspace, {
    minW,
    minH,
    visibleMargin: 0,
  });
}

function loadLocal(id: string): { geom: WindowGeometry; viewMode: ViewMode } {
  const fallback = {
    x: Math.max(0, (window.innerWidth - DEFAULT_W) / 2),
    y: Math.max(0, (window.innerHeight - DEFAULT_H) / 2 - 80),
    w: DEFAULT_W,
    h: DEFAULT_H,
  };
  try {
    const raw = localStorage.getItem(LOCAL_KEY(id));
    if (raw) {
      const parsed = JSON.parse(raw) as { geom?: unknown; viewMode?: unknown };
      return {
        geom: clampDesktopGeom(normalizeWindowGeometry(parsed.geom, fallback)),
        viewMode: parsed.viewMode === 'terminal' || parsed.viewMode === 'chat' ? parsed.viewMode : 'chat',
      };
    }
  } catch { /* ignore */ }
  return { geom: clampDesktopGeom(fallback), viewMode: 'chat' };
}

function saveLocal(id: string, geom: WindowGeometry, viewMode: ViewMode) {
  try {
    localStorage.setItem(LOCAL_KEY(id), JSON.stringify({ geom, viewMode }));
  } catch { /* ignore */ }
}

export function SubSessionWindow({
  sub, ws, connected, active, onPendingQuestion, idleFlashToken, onDiff, onHistory, onMinimize, onClose, maximized = false, onToggleMaximized, onRestoreBeforeClose, getMaximizeBounds, desktopLayoutCapable = true, onRestart, onRename, onSettings, onShareSession, onViewRepo, onTransportConfigSaved, onPreviewFile, zIndex, onFocus, desktopFileBrowserZIndex, onDesktopFileBrowserOpen, onDesktopFileBrowserFocus, onDesktopFileBrowserClose, onPin, sessions, subSessions, serverId, pendingPrefillText, onPendingPrefillApplied, onVersionSensitiveAction, detectedModelHint, inP2p, accentColor = DEFAULT_SUBSESSION_ACCENT_COLOR,
}: Props) {
  const { t } = useTranslation();
  const activeIdleFlashToken = useIdleFlashPlayback(idleFlashToken);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isDesktopMaximized = desktopLayoutCapable && maximized;
  const swipeBackRef = useSwipeBack(isMobile ? onMinimize : null);

  // ── Shared git-changes cache for the 📁 badge ─────────────────────────────
  // Uses the same git-status-store as the main session and FileBrowser.
  // When cwd matches another consumer (main session, other sub-sessions),
  // a single `fs.git_status` request feeds all of them. No separate polling
  // loop needed — `useSharedGitChanges` polls every 30s automatically.
  const sharedGitFiles = useSharedGitChanges(ws, sub.cwd ?? null);
  const gitChangesCount = sharedGitFiles.length;

  // Always pass sessionName + ws so useTimeline keeps its cache warm.
  // active flag is only for rendering — timeline state should persist across minimize/restore.
  const {
    events,
    refreshing,
    historyStatus: timelineHistoryStatus,
    addOptimisticUserMessage,
    markOptimisticFailed,
    retryOptimisticMessage,
    forceRefresh: timelineForceRefresh,
    loadingOlder,
    hasOlderHistory,
    loadOlderEvents,
  } = useTimeline(sub.sessionName, ws, serverId, {
    // Any mounted sub-session window is user-visible work, even when it is not
    // the focused/topmost one. Keep its active history/replay/retry path armed
    // so timeline gaps do not wait for a focus/window switch to backfill.
    isActiveSession: true,
    isVisible: true,
  });

  // Re-surface a still-pending question in the dedicated dialog from history
  // (only the focused window, to avoid multiple windows racing the app dialog).
  useEffect(() => {
    if (!active || !onPendingQuestion) return;
    onPendingQuestion(sub.sessionName, findTrailingAskQuestion(events));
  }, [active, onPendingQuestion, sub.sessionName, events]);
  const historyStatus = timelineHistoryStatus ?? IDLE_HISTORY_STATUS;
  const quickData = useQuickData();

  // Earliest ts of the current continuous thinking sequence (shared logic).
  const activeThinkingTs = useMemo(() => getActiveThinkingTs(events), [events]);

  // Extract active agent status (e.g. "Reading file...")
  const statusText = useMemo(() => getActiveStatusText(events), [events]);
  const activeToolCall = useMemo(() => hasActiveToolCall(events), [events]);
  const activeTimelineTurn = useMemo(() => hasActiveTimelineTurn(events), [events]);
  const pendingUserSend = useMemo(() => hasPendingUserSend(events), [events]);
  const transportActivityDetail = useMemo(() => getLatestTransportActivityDetail(events), [events]);
  const timelineSessionStateInfo = useMemo(() => getTailSessionStateInfo(events), [events]);
  const timelineLastEventTs = events.length > 0 ? (events[events.length - 1]?.ts ?? null) : null;
  const timelineSessionState = timelineSessionStateInfo.state;
  const liveSessionState = useMemo(
    () => resolveTimelineBackedSessionState({
      timelineState: timelineSessionState,
      sessionState: sub.state,
      activeThinking: !!activeThinkingTs,
      activeToolCall,
      activeTransportTurn: activeTimelineTurn,
      timelineStateTs: timelineSessionStateInfo.ts,
      timelineLastEventTs,
    }),
    [activeThinkingTs, activeTimelineTurn, activeToolCall, sub.state, timelineLastEventTs, timelineSessionState, timelineSessionStateInfo.ts],
  );

  // Dedicated per-sub-session file browser state. Each sub-session has its own
  // cwd, so opening 📁 here should browse THIS sub-session's working directory
  // (not the parent main session's). The overlay/panel is rendered locally so
  // it layers above this sub-session window instead of being hidden behind it.
  const [showFileBrowser, setShowFileBrowser] = useState(false);

  // Sync the desktop child file-browser open/close into the shared window
  // stack via the parent-supplied callbacks. Mobile is a no-op (it renders
  // an inline overlay, not a managed floating window).
  useEffect(() => {
    if (isMobile) return;
    if (showFileBrowser) {
      onDesktopFileBrowserOpen?.();
    } else {
      onDesktopFileBrowserClose?.();
    }
  }, [showFileBrowser, isMobile, onDesktopFileBrowserOpen, onDesktopFileBrowserClose]);

  const [quotes, setQuotes] = useState<string[]>([]);
  const [syncingMemorySummaries, setSyncingMemorySummaries] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [executionClonesBusy, setExecutionClonesBusy] = useState(false);
  const executionRouting = useExecutionRouting(serverId ?? null);
  const addQuote = useCallback((text: string) => setQuotes((prev) => [...prev, text]), []);
  const removeQuote = useCallback((i: number) => setQuotes((prev) => prev.filter((_, j) => j !== i)), []);

  // ── Retry failed send ─────────────────────────────────────────────────────
  // Mirrors the main-session SessionPane handler so optimistic-UX behavior is
  // uniform: locate the failed bubble in the timeline cache, dispatch a fresh
  // session.send with a new commandId, and update the existing bubble in place.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const handleResendFailed = useCallback((commandId: string, text: string) => {
    if (!ws || !connected) return;
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
      // Retry replays the ORIGINAL send verbatim: `resendExtra` already carries
      // the alias A′ map resolved when the user first composed it, so we do NOT
      // re-resolve here (Cx1-2/Cx1-3).
      ws.sendSessionCommand('send', {
        sessionName: sub.sessionName,
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
  }, [connected, retryOptimisticMessage, sub.sessionName, ws]);

  const thinkingNow = useNowTicker(!!activeThinkingTs && active);
  const isShell = sub.type === 'shell' || sub.type === 'script';
  /** Transport-backed sessions have no tmux terminal — chat only */
  const effectiveRuntimeType = resolveSubSessionRuntimeType(sub);
  const isTransport = effectiveRuntimeType === 'transport';
  const initial = loadLocal(sub.id);
  const [geom, setGeom] = useState<WindowGeometry>(initial.geom);
  const [viewMode, setViewMode] = useState<ViewMode>(isShell ? 'terminal' : isTransport ? 'chat' : initial.viewMode);
  const [maximizeBoundsVersion, setMaximizeBoundsVersion] = useState(0);
  // confirmClose removed — × now minimizes instead of terminating

  const inputRef = useRef<HTMLDivElement>(null);
  const fileDropTargetRef = useRef<HTMLDivElement>(null);
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
      sub.state === 'queued'
        ? 'queued'
        : sub.state === 'running'
          ? 'running'
        : sub.state === 'stopped'
          ? 'stopped'
          : sub.state === 'stopping'
            ? 'stopping'
            : sub.state === 'error'
              ? 'error'
              : 'idle',
    projectDir: sub.cwd ?? undefined,
    ccPreset: sub.ccPresetId ?? undefined,
    qwenModel: sub.qwenModel ?? undefined,
    qwenAuthType: sub.qwenAuthType ?? undefined,
    qwenAvailableModels: sub.qwenAvailableModels ?? undefined,
    codexAvailableModels: sub.codexAvailableModels ?? undefined,
    requestedModel: sub.requestedModel ?? undefined,
    activeModel: sub.activeModel ?? undefined,
    modelDisplay: sub.modelDisplay ?? undefined,
    planLabel: sub.planLabel ?? undefined,
    quotaLabel: sub.quotaLabel ?? undefined,
    quotaUsageLabel: sub.quotaUsageLabel ?? undefined,
    quotaMeta: sub.quotaMeta ?? undefined,
    effort: sub.effort ?? undefined,
    runtimeType: effectiveRuntimeType,
    sessionInstanceId: sub.sessionInstanceId ?? undefined,
    runtimeEpoch: sub.runtimeEpoch ?? undefined,
    providerId: sub.providerId ?? undefined,
    transportConfig: sub.transportConfig ?? undefined,
    transportPendingMessages: sub.transportPendingMessages ?? undefined,
    transportPendingMessageEntries: sub.transportPendingMessageEntries ?? undefined,
    transportPendingMessageVersion: sub.transportPendingMessageVersion ?? undefined,
  };

  useEffect(() => {
    if (!shouldPersistGeometry(isDesktopMaximized)) return;
    saveLocal(sub.id, geom, viewMode);
  }, [sub.id, geom, viewMode, isDesktopMaximized]);

  useEffect(() => {
    if (isMobile) return;
    const onResize = () => {
      if (isDesktopMaximized) {
        setMaximizeBoundsVersion((v) => v + 1);
      } else {
        setGeom((g) => clampDesktopGeom(g));
      }
    };
    window.addEventListener('resize', onResize);
    requestAnimationFrame(onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile, isDesktopMaximized]);

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

  // Shell/script window: hold the raw PTY stream for the window's ENTIRE
  // lifetime — NOT just while focused. An open sub-session window is always
  // on-screen (position:fixed); users often keep one at the side to observe, so
  // it must keep updating regardless of focus. (Previously this bailed with
  // `if (isShell && !active) return` and unsubscribed on focus loss, which froze
  // an open-but-unfocused shell window.) Ref-counted hold — see useTerminalRawHold.
  useTerminalRawHold(ws, connected, isShell && !isTransport, sub.sessionName);

  // Non-shell window: subscribe raw only while focused (full-fidelity view); when
  // unfocused it falls back to the passive (non-raw) subscription app.tsx keeps.
  // Re-subscribe on mount so the server sends a fresh snapshot (the window
  // unmounts on minimize, so a remount would otherwise start empty).
  useEffect(() => {
    if (!ws || !connected || isTransport || isShell) return;
    const raw = active;
    try { ws.subscribeTerminal(sub.sessionName, raw); } catch { /* ignore */ }
    if (!raw) return;
    return () => {
      try { ws.subscribeTerminal(sub.sessionName, false); } catch { /* ignore */ }
    };
  }, [ws, connected, sub.sessionName, active, isTransport, isShell]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (viewModeRef.current === 'chat') chatScrollRef.current?.();
      else termScrollRef.current?.();
    }, 50);
  }, []);
  const memorySummaryProjectId = useMemo(() => {
    const parent = sub.parentSession
      ? sessions?.find((session) => session.name === sub.parentSession)
      : undefined;
    return sub.contextNamespace?.projectId
      ?? parent?.contextNamespace?.projectId
      ?? null;
  }, [sessions, sub.contextNamespace?.projectId, sub.parentSession]);

  const executionTemplateDisplayName = useMemo(() => {
    const template = executionRouting.templateSessionName;
    if (!template) return null;
    const candidateSub = subSessions?.find((item) => item.sessionName === template);
    if (candidateSub && !isExecutionCloneTemplateLike(candidateSub)) return candidateSub.label || candidateSub.sessionName.split('_').pop() || candidateSub.sessionName;
    return null;
  }, [executionRouting.templateSessionName, subSessions]);
  const hasValidExecutionTemplate = Boolean(
    executionRouting.enabled
    && executionRouting.templateSessionName
    && executionTemplateDisplayName
    && executionRouting.templateSessionName !== sub.sessionName,
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
      // Alias A′ scope boundary (Cx1-2): the composer text is wrapped into a
      // generated worker prompt (buildGenericExecutionCloneWorkerPrompt) and
      // dispatched through the delegation path, not the direct human
      // handleSend path, so — like memory-summary sync / P2P / agent
      // send_message — it deliberately carries NO resolvedAliases. A `;;(name)`
      // typed here reaches the (LLM) clone literally. See design.md
      // "Send-surface coverage → Scope boundary".
      ws.sendExecutionClones({
        sessionName: sub.sessionName,
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
  }, [composerText, connected, executionRouting.limits, executionRouting.templateSessionName, hasValidExecutionTemplate, sub.sessionName, ws]);

  const handleSyncMemorySummaries = useCallback(async () => {
    if (!ws || !connected || syncingMemorySummaries) return;
    setSyncingMemorySummaries(true);
    try {
      const text = await buildMemorySummarySyncMessage(t, memorySummaryProjectId, undefined, {
        sources: [localPersonalMemorySummarySource(ws)],
      });
      if (!text) return;
      const commandId = globalThis.crypto?.randomUUID?.()
        ?? `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      // Alias A′ opt-out (Cx1-2): generated memory-summary sync, not a
      // human-composed message, so it deliberately carries no resolvedAliases.
      ws.sendSessionCommand('send', { sessionName: sub.sessionName, text, commandId });
      requestActiveTimelineRefreshAfterUserAction();
      addOptimisticUserMessage(text, commandId);
      scrollToBottom();
    } catch {
      // Non-blocking context sync: leave normal chat/send controls untouched.
    } finally {
      setSyncingMemorySummaries(false);
    }
  }, [addOptimisticUserMessage, connected, memorySummaryProjectId, scrollToBottom, sub.sessionName, syncingMemorySummaries, t, ws]);

  // ── Dragging ──────────────────────────────────────────────────────────────
  const dragStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const clampPos = useCallback((x: number, y: number, w: number, h = geomRef.current.h) => {
    const clamped = clampDesktopGeom({ x, y, w, h });
    return { x: clamped.x, y: clamped.y, w: clamped.w, h: clamped.h };
  }, []);

  const startDrag = useCallback((e: MouseEvent) => {
    if (isDesktopMaximized) {
      onFocus();
      return;
    }
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
  }, [isDesktopMaximized, onFocus, clampPos]);

  const onHeaderMouseDown = startDrag;

  // ── Resizing ──────────────────────────────────────────────────────────────
  type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

  const onResizeMouseDown = useCallback((dir: ResizeDir) => (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDesktopMaximized) return;
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
        if (dir.includes('n')) {
          const bounds = currentDesktopBounds();
          const startBottom = startG.y + startG.h;
          y = Math.max(bounds.y, Math.min(startG.y + dy, startBottom - MIN_H));
          h = startBottom - y;
        }
        return clampDesktopGeom({ x, y, w, h });
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [isDesktopMaximized, onFocus]);

  const agentTag = sub.type === 'shell' ? (sub.shellBin?.split(/[/\\]/).pop() ?? 'shell') : sub.type;
  const typeLabel = sub.label ? `${formatLabel(sub.label)} · ${agentTag}` : agentTag;

  // Only non-terminal (chat) sub-sessions can be pinned to sidebar
  const isPinnable = !!onPin;

  // HTML5 drag-to-pin: set dataTransfer so sidebar can read panel type + id
  const handleDragStart = useCallback((e: DragEvent) => {
    if (isDesktopMaximized) { e.preventDefault(); return; }
    if (!isPinnable) { e.preventDefault(); return; }
    e.dataTransfer?.setData('application/x-pinpanel', JSON.stringify({ type: 'subsession', id: sub.id }));
    e.dataTransfer?.setData('text/plain', sub.id); // fallback
  }, [isPinnable, isDesktopMaximized, sub.id]);

  const handleToggleMaximized = useCallback(() => {
    onFocus();
    onToggleMaximized?.();
  }, [onFocus, onToggleMaximized]);

  const restoreBeforeClosing = useCallback(() => {
    if (maximized) onRestoreBeforeClose?.();
  }, [maximized, onRestoreBeforeClose]);

  const focusOnlyWindowCommandRef = useRef(false);
  const focusInactiveDesktopWindow = useCallback((
    event?: Pick<Event, 'preventDefault' | 'stopPropagation'>,
    options?: { suppressFollowingClick?: boolean },
  ) => {
    if (!desktopLayoutCapable || isMobile || active) return false;
    if (options?.suppressFollowingClick) focusOnlyWindowCommandRef.current = true;
    event?.preventDefault();
    event?.stopPropagation();
    onFocus();
    return true;
  }, [active, desktopLayoutCapable, isMobile, onFocus]);

  const consumeFocusOnlyWindowCommandClick = useCallback((event: Pick<Event, 'preventDefault' | 'stopPropagation'>) => {
    if (!focusOnlyWindowCommandRef.current) return false;
    focusOnlyWindowCommandRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, []);

  const handleMinimize = useCallback(() => {
    if (focusInactiveDesktopWindow()) return;
    restoreBeforeClosing();
    onMinimize();
  }, [focusInactiveDesktopWindow, onMinimize, restoreBeforeClosing]);

  const handleClose = useCallback(() => {
    if (focusInactiveDesktopWindow()) return;
    restoreBeforeClosing();
    onClose();
  }, [focusInactiveDesktopWindow, onClose, restoreBeforeClosing]);

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
  const legacyCodexModel = loadLegacyCodexModelPreferenceForModelessSession(sub, detectedModel, detectedModelHint, lastUsage?.model);
  const effectiveDetectedModel = detectedModel ?? detectedModelHint ?? legacyCodexModel ?? undefined;

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

  const [vvh, setVvh] = useState(() => window.visualViewport?.height ?? window.innerHeight);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setVvh(vv.height);
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, [isMobile]);

  const [subSessionBarHeight, setSubSessionBarHeight] = useState(() => getInitialMobileSubSessionBarHeight(isMobile));
  useLayoutEffect(() => {
    if (!isMobile) return;
    let raf = 0;
    let ro: ResizeObserver | null = null;
    const vv = window.visualViewport;

    const update = () => {
      const measured = measureMobileSubSessionBarHeight();
      if (measured <= 0) {
        if (isMobileSubSessionBarSuppressed()) {
          setSubSessionBarHeight((prev) => (prev === 0 ? prev : 0));
        }
        return;
      }
      setSubSessionBarHeight((prev) => (prev === measured ? prev : measured));
    };
    const scheduleUpdate = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    };
    const observeTargets = () => {
      if (typeof ResizeObserver === 'undefined') return;
      ro?.disconnect();
      ro = new ResizeObserver(scheduleUpdate);
      for (const el of getExternalMobileSubSessionBarElements()) {
        ro.observe(el);
      }
    };

    observeTargets();
    update();

    const mo = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
        observeTargets();
        scheduleUpdate();
      });
    mo?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    mo?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    window.addEventListener('resize', scheduleUpdate);
    document.addEventListener('focusin', scheduleUpdate, true);
    document.addEventListener('focusout', scheduleUpdate, true);
    vv?.addEventListener('resize', scheduleUpdate);
    vv?.addEventListener('scroll', scheduleUpdate);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      document.removeEventListener('focusin', scheduleUpdate, true);
      document.removeEventListener('focusout', scheduleUpdate, true);
      vv?.removeEventListener('resize', scheduleUpdate);
      vv?.removeEventListener('scroll', scheduleUpdate);
    };
  }, [isMobile]);

  const displayGeom = useMemo(() => {
    if (!isDesktopMaximized || isMobile) return geom;
    const bounds = getMaximizeBounds?.();
    if (!bounds) return clampDesktopGeom(geom);
    return clampMaximizedGeom(bounds);
  }, [geom, getMaximizeBounds, isMobile, isDesktopMaximized, maximizeBoundsVersion]);

  const mobileSubSessionBarHeight = Math.max(0, Math.min(subSessionBarHeight, Math.max(0, vvh - 120)));
  const mobileWindowHeight = `calc(${vvh}px - var(--sat, 0px) - ${mobileSubSessionBarHeight}px)`;

  const style: Record<string, string | number> = isMobile
    ? {
        '--subsession-accent-color': accentColor,
        position: 'fixed',
        top: 'var(--sat, 0px)',
        left: 0,
        right: 0,
        bottom: `${mobileSubSessionBarHeight}px`,
        height: mobileWindowHeight,
        maxHeight: mobileWindowHeight,
        minHeight: 0,
        zIndex,
      }
    : { '--subsession-accent-color': accentColor, position: 'fixed', left: displayGeom.x, top: displayGeom.y, width: displayGeom.w, height: displayGeom.h, zIndex };
  const rootClass = [
    'subsession-window',
    isDesktopMaximized ? 'subsession-window-maximized' : '',
    desktopLayoutCapable && !isMobile && active ? 'subsession-window-active' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={swipeBackRef}
      class={rootClass}
      style={style}
      onMouseDown={onFocus}
    >
      {activeIdleFlashToken ? <IdleFlashLayer key={`subwindow-idle-${activeIdleFlashToken}`} variant="frame" /> : null}
      {/* 8-direction resize handles (desktop only) */}
      {!isMobile && !isDesktopMaximized && (['n','s','e','w','ne','nw','se','sw'] as ResizeDir[]).map((dir) => (
        <div key={dir} class={`resize-handle resize-${dir}`} onMouseDown={onResizeMouseDown(dir)} />
      ))}

      {/* Header */}
      <div
        class="subsession-header"
        onMouseDown={onHeaderMouseDown}
        draggable={!!isPinnable && !isDesktopMaximized}
        onDragStart={handleDragStart}
      >
        <span class="subsession-drag-icon">⠿</span>
        <span class="subsession-title">{typeLabel}</span>
        {inP2p && <span class="p2p-tag">{t('session.p2p_tag')}</span>}
        {sub.ccPresetId && <span style={{ fontSize: 11, color: '#f59e0b' }} title={`Custom API: ${sub.ccPresetId}`}>◉</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          {!isShell && !isTransport && <button class="subsession-mode-btn" onClick={() => { const next = viewMode === 'chat' ? 'terminal' : 'chat'; setViewMode(next); if (next === 'chat') requestAnimationFrame(() => chatScrollRef.current?.()); }} title={viewMode === 'chat' ? 'Switch to terminal' : 'Switch to chat'}>{viewMode === 'chat' ? '⌨' : '💬'}</button>}
          {/* File browser — placed to the LEFT of the pin button in the
              sub-session window header. Each sub-session owns its own
              FileBrowser instance rooted at sub.cwd, so selected paths land
              in THIS sub-session's input (not the parent main session's).
              The overlay/panel is rendered at zIndex > this window's zIndex
              so it isn't hidden behind the window itself. */}
          <button
            class="subsession-minimize-btn"
            onClick={() => setShowFileBrowser((o) => !o)}
            title={t('picker.files')}
            aria-label={t('picker.files')}
            style={{ position: 'relative' }}
          >
            <span aria-hidden="true">{'\u{1F4C1}'}</span>
            {(gitChangesCount ?? 0) > 0 && <span class="file-badge">{gitChangesCount}</span>}
          </button>
          {isPinnable && <button class="subsession-minimize-btn" onClick={() => onPin?.(viewMode)} title={t('sidebar.pin_to_sidebar')}>📌</button>}
          {desktopLayoutCapable && onToggleMaximized && (
            <DesktopWindowMaximizeButton
              maximized={isDesktopMaximized}
              onClick={(event) => {
                if (focusInactiveDesktopWindow(event)) return;
                handleToggleMaximized();
              }}
            />
          )}
          <button
            class="subsession-minimize-btn"
            onMouseDown={(event) => { focusInactiveDesktopWindow(event, { suppressFollowingClick: true }); }}
            onClick={(event) => { if (!consumeFocusOnlyWindowCommandClick(event) && !focusInactiveDesktopWindow(event)) handleMinimize(); }}
            title={t('window.minimize')}
            aria-label={t('window.minimize')}
          >▾</button>
          <button
            class="subsession-close-btn"
            onMouseDown={(event) => { focusInactiveDesktopWindow(event, { suppressFollowingClick: true }); }}
            onClick={(event) => { if (!consumeFocusOnlyWindowCommandClick(event) && !focusInactiveDesktopWindow(event)) handleMinimize(); }}
            title={t('window.hide')}
            aria-label={t('window.hide')}
          >×</button>
        </div>
      </div>

      <div ref={fileDropTargetRef} class="subsession-session-surface">
      {/* Content */}
      <div class="subsession-content">
        <div style={{ display: viewMode === 'terminal' ? 'flex' : 'none', flex: 1, overflow: 'hidden' }}>
          <TerminalView
            sessionName={sub.sessionName}
            ws={ws}
            connected={connected}
            active={(isShell || active) && viewMode === 'terminal'}
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
            historyStatus={historyStatus}
            loadingOlder={loadingOlder}
            hasOlderHistory={hasOlderHistory}
            onLoadOlder={loadOlderEvents}
            sessionId={sub.sessionName}
            onForceSync={timelineForceRefresh}
            onScrollBottomFn={onChatScrollBottomFn}
            ws={ws}
            workdir={sub.cwd ?? null}
            onViewRepo={onViewRepo}
            onPreviewFile={onPreviewFile}
            serverId={serverId}
            onQuote={addQuote}
            agentType={sessionInfo?.agentType ?? sub.type}
            onResendFailed={handleResendFailed}
          />
        )}
      </div>

      {/* Usage footer — shared component */}
      {!isShell && (
        <UsageFooter
          usage={lastUsage ?? { inputTokens: 0, cacheTokens: 0, contextWindow: 0 }}
          sessionName={sub.sessionName}
          sessionState={liveSessionState}
          agentType={sessionInfo?.agentType}
          wsClient={ws}
          connected={connected}
          modelOverride={resolveEffectiveSessionModel(sessionInfo, effectiveDetectedModel, lastUsage?.model)}
          planLabel={sessionInfo?.planLabel}
          quotaLabel={sessionInfo?.quotaLabel}
          quotaUsageLabel={(sessionInfo?.agentType === 'codex' || sessionInfo?.agentType === 'codex-sdk') ? undefined : sessionInfo?.quotaUsageLabel}
          quotaMeta={sessionInfo?.quotaMeta}
          showCost={!!lastCostEvent}
          activeThinkingTs={activeThinkingTs}
          statusText={statusText}
          activeToolCall={activeToolCall}
          activeTimelineTurn={activeTimelineTurn}
          pendingUserSend={pendingUserSend}
          transportActivityDetail={transportActivityDetail}
          sessionError={sessionInfo?.error}
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

      {/* Full SessionControls — with sub-session action overrides */}
      <SessionControls
        ws={ws}
        connected={connected}
        activeSession={sessionInfo}
        inputRef={inputRef}
        quickData={quickData}
        hideShortcuts={false}
        keyboardActive={active}
        onSend={(_name, text, meta) => {
          // Inject the optimistic "sending" bubble so the user sees the
          // message with a spinner immediately, instead of waiting for the
          // daemon's echoed user.message (transport) or the JSONL scrape lag
          // (process). Uses the same contract as SessionPane — bubble keyed
          // by commandId, reconciled when the authoritative echo arrives.
          //
          // Exception: P2P command sends (`@@all(...) ...`, structured
          // p2pMode / p2pAtTargets). Those belong to a discussion file, not
          // the sub-session's own chat. Matches the SessionPane guard.
          const extras = meta?.extra as Record<string, unknown> | undefined;
          const isP2pSend = !!extras && (
            Array.isArray(extras.p2pAtTargets) && extras.p2pAtTargets.length > 0
            || (typeof extras.p2pMode === 'string' && extras.p2pMode.length > 0)
            || (extras.p2pSessionConfig != null && typeof extras.p2pSessionConfig === 'object')
          );
          if (isP2pSend) return;
          addOptimisticUserMessage(text, meta?.commandId, {
            ...(meta?.attachments ? { attachments: meta.attachments } : {}),
            ...(meta?.extra ? { resendExtra: meta.extra } : {}),
          });
          if (meta?.commandId && meta.localFailure) {
            markOptimisticFailed(meta.commandId, meta.localFailure);
          }
          scrollToBottom();
        }}
        onSubRestart={onRestart}
        onSubNew={onRestart}
        onSubStop={handleClose}
        onRenameSession={onRename}
        onSettings={onSettings}
        onShareSession={onShareSession}
        subSessionId={sub.id}
        onTransportConfigSaved={onTransportConfigSaved}
        sessionDisplayName={sub.label ? formatLabel(sub.label) : agentTag}
        activeThinking={!!activeThinkingTs}
        activeTransportTurn={activeTimelineTurn}
        transportTimelineEvents={events}
        sessions={sessions}
        subSessions={subSessions}
        serverId={serverId}
        fileDropTargetRef={fileDropTargetRef}
        detectedModel={effectiveDetectedModel ?? lastUsage?.model}
        quotes={quotes}
        onRemoveQuote={removeQuote}
        pendingPrefillText={pendingPrefillText}
        onPendingPrefillApplied={onPendingPrefillApplied}
        onVersionSensitiveAction={onVersionSensitiveAction}
        onComposerTextChange={setComposerText}
      />
      </div>

      {/* Per-sub-session file browser. Mobile: full-screen overlay.
          Desktop: floating panel layered via the shared desktop window stack
          using parent-child banded ordering — `desktopFileBrowserZIndex` is
          supplied by the parent and is always above this sub-session's
          `zIndex` within the band, while a newer unrelated peer can still
          sit above the entire owner-child group. */}
      {showFileBrowser && ws && (
        isMobile ? (
          <div class="mobile-fb-overlay" style={{ zIndex: zIndex + 1 }}>
            <div class="mobile-fb-header">
              <span style={{ fontSize: 13, fontWeight: 600 }}>📁 {t('picker.files')}</span>
              <button class="fb-close" onClick={() => setShowFileBrowser(false)}>✕</button>
            </div>
            <FileBrowser
              ws={ws}
              serverId={serverId}
              sessionName={sub.sessionName}
              mode="file-multi"
              layout="panel"
              initialPath={sub.cwd ?? '~'}
              changesRootPath={sub.cwd ?? undefined}
              hideFooter={false}
              onConfirm={(paths) => {
                const cwd = sub.cwd ?? null;
                const rel = cwd
                  ? paths.map((p) => '@' + (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) + ' ')
                  : paths.map((p) => '@' + p + ' ');
                const inputEl = inputRef.current;
                if (inputEl) {
                  inputEl.textContent = (inputEl.textContent || '') + rel.join('');
                  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                  inputEl.focus();
                }
                setShowFileBrowser(false);
              }}
              onClose={() => setShowFileBrowser(false)}
            />
          </div>
        ) : (
          <FloatingPanel
            id={DESKTOP_WINDOW_IDS.subsessionFileBrowser(sub.id)}
            title={`📁 ${t('picker.files')}`}
            onClose={() => setShowFileBrowser(false)}
            zIndex={desktopFileBrowserZIndex ?? zIndex + 1}
            onFocus={onDesktopFileBrowserFocus}
            defaultW={420}
            defaultH={500}
          >
            <FileBrowser
              ws={ws}
              serverId={serverId}
              sessionName={sub.sessionName}
              mode="file-multi"
              layout="panel"
              initialPath={sub.cwd ?? '~'}
              changesRootPath={sub.cwd ?? undefined}
              hideFooter={false}
              onConfirm={(paths) => {
                const cwd = sub.cwd ?? null;
                const rel = cwd
                  ? paths.map((p) => '@' + (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) + ' ')
                  : paths.map((p) => '@' + p + ' ');
                const inputEl = inputRef.current;
                if (inputEl) {
                  inputEl.textContent = (inputEl.textContent || '') + rel.join('');
                  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                  inputEl.focus();
                }
              }}
              onClose={() => setShowFileBrowser(false)}
            />
          </FloatingPanel>
        )
      )}
    </div>
  );
}
