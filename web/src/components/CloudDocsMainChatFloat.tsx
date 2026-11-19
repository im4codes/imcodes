import type { ComponentProps } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ChatView } from './ChatView.js';
import { StableSessionControls as SessionControls } from './StableSessionControls.js';
import type { UseQuickDataResult } from './QuickInputPanel.js';
import type { WsClient } from '../ws-client.js';
import type { SessionInfo } from '../types.js';
import { requestActiveTimelineRefreshAfterUserAction, useTimeline } from '../hooks/useTimeline.js';
import { getActiveThinkingTs, getTailSessionStateInfo, hasActiveToolCall } from '../thinking-utils.js';
import { hasActiveTimelineTurn, hasPendingUserSend } from '../timeline-running.js';
import { resolveTimelineBackedSessionState } from '../session-live-status.js';
import { resolveSessionInfoRuntimeType } from '../runtime-type.js';
import { formatLabel } from '../format-label.js';
import { isShareScopedState } from '../tab-sharing-ui.js';
import {
  formatCloudDocQuoteBadge,
  getCloudDocQuoteKey,
  sanitizeCloudDocQuoteName,
  type CloudDocQuoteTarget,
} from '../cloud-docs-reference.js';

export type CloudDocsMainChatSubSession = NonNullable<ComponentProps<typeof SessionControls>['subSessions']>[number];

export interface CloudDocsMainChatContext {
  session: SessionInfo;
  sessions: SessionInfo[];
  subSessions: CloudDocsMainChatSubSession[];
  ws: WsClient | null;
  connected: boolean;
  serverId: string;
  quickData: UseQuickDataResult;
  detectedModel?: string;
}

export const DEFAULT_MINI_CHAT_HEIGHT = 420;
export const DEFAULT_MINI_CHAT_MIN_HEIGHT = 220;

interface CloudDocsMainChatFloatProps {
  mainChat: CloudDocsMainChatContext;
  activePreviewQuote?: CloudDocQuoteTarget | null;
  onOpenDoc?: (docId: string) => void;
  heightStorageKey?: string;
  defaultHeight?: number;
  minHeight?: number;
  maxHeight?: number;
  overlayClassName?: string;
  visible?: boolean;
}

function sanitizePositiveHeight(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function readContainerHeight(anchorEl: HTMLDivElement | null): number {
  const parent = anchorEl?.parentElement;
  if (!parent) return 0;
  if (parent.clientHeight > 0) return parent.clientHeight;
  const rectHeight = parent.getBoundingClientRect?.().height ?? 0;
  return rectHeight > 0 ? rectHeight : 0;
}

function resolveAvailableMaxHeight(
  anchorEl: HTMLDivElement | null,
  minHeight: number,
  maxHeightProp?: number,
): number | undefined {
  const containerHeight = readContainerHeight(anchorEl);
  let limit: number | undefined;
  if (containerHeight > 0) {
    // Anchor sits 14px above bottom + 14px top gap + 40px FAB + 8px flex gap = 76px.
    limit = Math.max(140, Math.floor(containerHeight - 76));
  } else if (typeof window !== 'undefined' && window.innerHeight > 0) {
    limit = Math.max(minHeight, Math.floor(window.innerHeight - 120));
  }
  if (maxHeightProp != null && Number.isFinite(maxHeightProp) && maxHeightProp > 0) {
    const cappedProp = Math.max(Math.min(minHeight, maxHeightProp), Math.floor(maxHeightProp));
    limit = limit != null ? Math.min(limit, cappedProp) : cappedProp;
  }
  return limit;
}

function clampMiniChatHeight(
  height: number,
  minHeight: number,
  availableMax?: number,
): number {
  const floor = availableMax != null ? Math.min(minHeight, availableMax) : minHeight;
  const upper = availableMax != null ? Math.max(floor, availableMax) : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(upper, Math.max(floor, height)));
}

function readStoredMiniChatHeight(
  storageKey: string | undefined,
  minHeight: number,
  maxHeightProp?: number,
): number | null {
  if (!storageKey || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = sanitizePositiveHeight(raw);
    if (parsed === null) return null;
    const maxBound = maxHeightProp != null && Number.isFinite(maxHeightProp) && maxHeightProp > 0
      ? Math.max(minHeight, Math.floor(maxHeightProp))
      : undefined;
    return clampMiniChatHeight(parsed, minHeight, maxBound);
  } catch {
    return null;
  }
}

function writeStoredMiniChatHeight(storageKey: string | undefined, height: number): void {
  if (!storageKey || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, String(Math.round(height)));
  } catch {
    /* ignore storage quota / restricted storage failures */
  }
}

export function CloudDocsMainChatFloat({
  mainChat,
  activePreviewQuote = null,
  onOpenDoc,
  heightStorageKey,
  defaultHeight = DEFAULT_MINI_CHAT_HEIGHT,
  minHeight = DEFAULT_MINI_CHAT_MIN_HEIGHT,
  maxHeight,
  overlayClassName,
  visible = true,
}: CloudDocsMainChatFloatProps) {
  const { t } = useTranslation();
  const safeMinHeight = useMemo(
    () => (Number.isFinite(minHeight) && minHeight > 0 ? minHeight : DEFAULT_MINI_CHAT_MIN_HEIGHT),
    [minHeight],
  );
  const safeDefaultHeight = useMemo(
    () => (Number.isFinite(defaultHeight) && defaultHeight > 0 ? Math.max(safeMinHeight, defaultHeight) : DEFAULT_MINI_CHAT_HEIGHT),
    [defaultHeight, safeMinHeight],
  );
  const resizable = Boolean(heightStorageKey);
  const [expanded, setExpanded] = useState(false);
  const [dismissedDocKey, setDismissedDocKey] = useState<string | null>(null);
  const [extraQuotes, setExtraQuotes] = useState<string[]>([]);
  const [customHeight, setCustomHeight] = useState<number | null>(() => (
    readStoredMiniChatHeight(heightStorageKey, safeMinHeight, maxHeight)
  ));
  const [containerMaxHeight, setContainerMaxHeight] = useState<number | undefined>(undefined);
  const [isResizing, setIsResizing] = useState(false);
  const [isEntering, setIsEntering] = useState<boolean>(() => visible);
  const [entranceEpoch, setEntranceEpoch] = useState<number>(() => (visible ? 1 : 0));
  const prevVisibleRef = useRef<boolean>(visible);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const miniChatRef = useRef<HTMLDivElement | null>(null);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const wasVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!visible) {
      setIsEntering(false);
      return;
    }
    if (!wasVisible && visible) {
      setEntranceEpoch((epoch) => epoch + 1);
      setIsEntering(true);
    }
  }, [visible]);

  useEffect(() => {
    if (!isEntering || typeof window === 'undefined') return undefined;
    const timer = window.setTimeout(() => {
      setIsEntering(false);
    }, 950);
    return () => window.clearTimeout(timer);
  }, [isEntering, entranceEpoch]);

  useEffect(() => {
    setCustomHeight(readStoredMiniChatHeight(heightStorageKey, safeMinHeight, maxHeight));
  }, [heightStorageKey, maxHeight, safeMinHeight]);

  useEffect(() => {
    if (!resizable || !expanded) return undefined;
    const syncMaxHeight = () => {
      setContainerMaxHeight(resolveAvailableMaxHeight(anchorRef.current, safeMinHeight, maxHeight));
    };
    syncMaxHeight();
    const parent = anchorRef.current?.parentElement;
    let observer: ResizeObserver | null = null;
    if (parent && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => syncMaxHeight());
      observer.observe(parent);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', syncMaxHeight);
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', syncMaxHeight);
      }
    };
  }, [expanded, maxHeight, resizable, safeMinHeight]);

  useEffect(() => () => {
    cleanupDragRef.current?.();
  }, []);

  const handleResizePointerDown = useCallback((event: PointerEvent) => {
    if (!resizable) return;
    if (typeof event.button === 'number' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupDragRef.current?.();

    const startY = event.clientY;
    const rectHeight = miniChatRef.current?.getBoundingClientRect?.().height ?? 0;
    const currentEffective = customHeight != null
      ? clampMiniChatHeight(customHeight, safeMinHeight, containerMaxHeight ?? resolveAvailableMaxHeight(anchorRef.current, safeMinHeight, maxHeight))
      : safeDefaultHeight;
    const startHeight = rectHeight > 0 ? rectHeight : currentEffective;
    const pointerId = event.pointerId;
    let latestHeight: number | null = null;
    setIsResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      if (pointerId != null && moveEvent.pointerId != null && moveEvent.pointerId !== pointerId) return;
      const availableMax = resolveAvailableMaxHeight(anchorRef.current, safeMinHeight, maxHeight);
      setContainerMaxHeight(availableMax);
      const nextHeight = clampMiniChatHeight(
        startHeight + (startY - moveEvent.clientY),
        safeMinHeight,
        availableMax,
      );
      latestHeight = nextHeight;
      setCustomHeight(nextHeight);
      writeStoredMiniChatHeight(heightStorageKey, nextHeight);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      cleanupDragRef.current = null;
      setIsResizing(false);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (pointerId != null && upEvent.pointerId != null && upEvent.pointerId !== pointerId) return;
      cleanup();
      if (latestHeight !== null) {
        writeStoredMiniChatHeight(heightStorageKey, latestHeight);
      }
    };

    const onCancel = (cancelEvent: PointerEvent) => {
      if (pointerId != null && cancelEvent.pointerId != null && cancelEvent.pointerId !== pointerId) return;
      cleanup();
    };

    cleanupDragRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [containerMaxHeight, customHeight, heightStorageKey, maxHeight, resizable, safeDefaultHeight, safeMinHeight]);

  // Attach lowercase 'pointerdown' directly so both real browsers and jsdom
  // (where HTMLElement lacks `onpointerdown` in Preact's prop-name check) fire it.
  useEffect(() => {
    const el = resizeHandleRef.current;
    if (!el || !resizable || !expanded) return undefined;
    el.addEventListener('pointerdown', handleResizePointerDown);
    return () => {
      el.removeEventListener('pointerdown', handleResizePointerDown);
    };
  }, [expanded, handleResizePointerDown, resizable]);

  const effectiveMiniChatHeight = useMemo(() => {
    if (!resizable || customHeight === null) return undefined;
    const maxBound = containerMaxHeight ?? resolveAvailableMaxHeight(anchorRef.current, safeMinHeight, maxHeight);
    return clampMiniChatHeight(customHeight, safeMinHeight, maxBound);
  }, [containerMaxHeight, customHeight, maxHeight, resizable, safeMinHeight]);

  const session = mainChat.session;
  const sessionName = session.name;
  const hasChatTimeline = session.agentType !== 'shell' && session.agentType !== 'script';

  const {
    events: timelineEvents,
    loading: timelineLoading,
    refreshing: timelineRefreshing,
    historyStatus,
    loadingOlder,
    hasOlderHistory,
    loadOlderEvents,
    historyGap,
    loadMessageContext,
    addOptimisticUserMessage,
    removeOptimisticMessage,
    markOptimisticFailed,
    retryOptimisticMessage,
    forceRefresh: timelineForceRefresh,
  } = useTimeline(sessionName, mainChat.ws, mainChat.serverId, {
    incognito: session.incognito,
    // SessionPane owns keyboard/recovery timers for activeSession. Keep this card
    // secondary so it stays synced live without competing on recovery work.
    isActiveSession: false,
    isVisible: expanded,
    subscriptionMode: expanded ? 'full' : 'summary',
    bootstrapWhenVisible: true,
    disableHistory: !hasChatTimeline,
    authoritativeSessionState: session.state,
  });

  const activeThinkingTs = useMemo(() => getActiveThinkingTs(timelineEvents), [timelineEvents]);
  const activeToolCall = useMemo(() => hasActiveToolCall(timelineEvents), [timelineEvents]);
  const pendingUserSend = useMemo(() => hasPendingUserSend(timelineEvents), [timelineEvents]);
  const timelineSessionStateInfo = useMemo(() => getTailSessionStateInfo(timelineEvents), [timelineEvents]);
  const timelineLastEventTs = timelineEvents.length > 0
    ? (timelineEvents[timelineEvents.length - 1]?.ts ?? null)
    : null;
  const activeTimelineTurn = useMemo(() => (
    session.authoritativeIdleAt != null
      && timelineLastEventTs != null
      && timelineLastEventTs <= session.authoritativeIdleAt
      ? false
      : hasActiveTimelineTurn(timelineEvents)
  ), [session.authoritativeIdleAt, timelineEvents, timelineLastEventTs]);

  const liveSessionState = useMemo(
    () => resolveTimelineBackedSessionState({
      timelineState: timelineSessionStateInfo.state,
      sessionState: session.state,
      activeThinking: !!activeThinkingTs,
      activeToolCall,
      activeTransportTurn: activeTimelineTurn,
      authoritativeIdleAt: session.authoritativeIdleAt,
      timelineStateTs: timelineSessionStateInfo.ts,
      timelineLastEventTs,
    }),
    [
      activeThinkingTs,
      activeTimelineTurn,
      activeToolCall,
      session.authoritativeIdleAt,
      session.state,
      timelineLastEventTs,
      timelineSessionStateInfo.state,
      timelineSessionStateInfo.ts,
    ],
  );

  const effectiveRuntimeType = resolveSessionInfoRuntimeType(session);
  const isTransportSession = effectiveRuntimeType === 'transport';
  const controlsSession = useMemo<SessionInfo>(() => {
    if (!isTransportSession || !liveSessionState || liveSessionState === session.state) return session;
    return { ...session, state: liveSessionState as SessionInfo['state'] };
  }, [isTransportSession, liveSessionState, session]);

  const isBusy = liveSessionState === 'running'
    || !!activeThinkingTs
    || activeToolCall
    || activeTimelineTurn
    || pendingUserSend;

  const sessionDisplayName = session.label
    ? formatLabel(session.label)
    : (session.project || session.name);

  const activeDocKey = activePreviewQuote ? getCloudDocQuoteKey(activePreviewQuote) : null;
  const autoQuoteBadge = activePreviewQuote ? formatCloudDocQuoteBadge(activePreviewQuote) : null;

  useEffect(() => {
    setDismissedDocKey(null);
  }, [activeDocKey]);

  useEffect(() => {
    setExtraQuotes([]);
  }, [sessionName]);

  const isAutoQuoteAttached = !!autoQuoteBadge && !!activeDocKey && dismissedDocKey !== activeDocKey;
  const quotes = useMemo(
    () => (isAutoQuoteAttached && autoQuoteBadge ? [autoQuoteBadge, ...extraQuotes] : extraQuotes),
    [autoQuoteBadge, extraQuotes, isAutoQuoteAttached],
  );

  const handleRemoveQuote = useCallback((index: number) => {
    if (isAutoQuoteAttached) {
      if (index === 0) {
        setDismissedDocKey(activeDocKey);
        return;
      }
      setExtraQuotes((prev) => prev.filter((_, idx) => idx !== index - 1));
      return;
    }
    setExtraQuotes((prev) => prev.filter((_, idx) => idx !== index));
  }, [activeDocKey, isAutoQuoteAttached]);

  const chatScrollFnRef = useRef<(() => void) | null>(null);
  const setChatScrollFn = useCallback((fn: () => void) => {
    chatScrollFnRef.current = fn;
  }, []);

  useEffect(() => {
    if (!expanded) return;
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(() => chatScrollFnRef.current?.());
      return () => cancelAnimationFrame(id);
    }
    chatScrollFnRef.current?.();
    return undefined;
  }, [expanded]);

  const timelineEventsRef = useRef(timelineEvents);
  timelineEventsRef.current = timelineEvents;

  const handleResendFailed = useCallback((commandId: string, text: string) => {
    if (!mainChat.ws || !mainChat.connected) return;
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
      mainChat.ws.sendSessionCommand('send', {
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
  }, [mainChat.connected, mainChat.ws, retryOptimisticMessage, sessionName]);

  const overlayClassSuffix = overlayClassName ? ` ${overlayClassName}` : '';
  const miniChatStyle = effectiveMiniChatHeight != null
    ? {
        height: `${effectiveMiniChatHeight}px`,
        ...(containerMaxHeight != null ? { maxHeight: `${containerMaxHeight}px` } : {}),
      }
    : undefined;

  return (
    <div
      ref={anchorRef}
      class="cloud-docs-main-chat-anchor"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {expanded && (
        <div
          ref={miniChatRef}
          class={`cloud-docs-mini-chat${isResizing ? ' is-resizing' : ''}${overlayClassSuffix}`}
          style={miniChatStyle}
          role="dialog"
          aria-modal="false"
          aria-label={t('cloud_docs.ai_chat.title', { session: sessionDisplayName })}
          data-testid="cloud-docs-mini-chat"
          onContextMenu={(e) => e.stopPropagation()}
        >
          {resizable && (
            <div
              ref={resizeHandleRef}
              class="mini-chat-resize-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('cloud_docs.ai_chat.resize_height', 'Resize AI chat height')}
              aria-valuemin={safeMinHeight}
              aria-valuemax={containerMaxHeight}
              aria-valuenow={effectiveMiniChatHeight ?? safeDefaultHeight}
              data-testid="mini-chat-resize-handle"
            />
          )}
          <div class="cloud-docs-mini-chat-header">
            <div class="cloud-docs-mini-chat-title-group">
              <img
                class="cloud-docs-mini-chat-avatar"
                src="/imcodes-robot-avatar.png"
                alt=""
                aria-hidden="true"
                draggable={false}
              />
              <div class="cloud-docs-mini-chat-title-meta">
                <span class="cloud-docs-mini-chat-title" title={sessionDisplayName}>
                  {sessionDisplayName}
                </span>
                <span class={`cloud-docs-mini-chat-status${isBusy ? ' busy' : ''}`}>
                  <span class="cloud-docs-mini-chat-status-dot" aria-hidden="true" />
                  <span>
                    {isBusy
                      ? t('cloud_docs.ai_chat.thinking', 'Thinking...')
                      : t('cloud_docs.ai_chat.synced', 'Synced')}
                  </span>
                </span>
              </div>
            </div>
            <button
              type="button"
              class="cloud-docs-mini-chat-close"
              onClick={() => setExpanded(false)}
              aria-label={t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')}
              title={t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')}
              data-testid="cloud-docs-mini-chat-close"
            >
              ×
            </button>
          </div>

          <div class="cloud-docs-mini-chat-messages">
            <ChatView
              visible={expanded}
              events={timelineEvents}
              loading={timelineLoading}
              refreshing={timelineRefreshing}
              historyStatus={historyStatus}
              loadingOlder={loadingOlder}
              hasOlderHistory={hasOlderHistory}
              onLoadOlder={loadOlderEvents}
              historyGap={historyGap}
              onLoadMessageContext={loadMessageContext}
              onForceSync={timelineForceRefresh}
              sessionId={sessionName}
              sessions={mainChat.sessions}
              sessionState={liveSessionState ?? undefined}
              onScrollBottomFn={setChatScrollFn}
              workdir={session.projectDir}
              ws={mainChat.connected ? mainChat.ws : null}
              serverId={mainChat.serverId}
              scopeFilesToSession={!!session.sharedState && session.sharedState.targetKind !== 'server'}
              readOnlyFiles={!!session.sharedState && session.sharedState.effectiveRole !== 'participant'}
              canManageFileShares={!isShareScopedState(session.sharedState)}
              onQuote={(text) => setExtraQuotes((prev) => [...prev, text])}
              onCloudDocClick={onOpenDoc}
              agentType={session.agentType}
              onResendFailed={handleResendFailed}
              hideFilePanel
            />
          </div>

          {activePreviewQuote && activeDocKey && dismissedDocKey === activeDocKey && (
            <div class="cloud-docs-mini-chat-doc-strip">
              <button
                type="button"
                class="cloud-docs-mini-chat-reattach-btn"
                onClick={() => setDismissedDocKey(null)}
                data-testid="cloud-docs-mini-chat-reattach"
                title={t('cloud_docs.ai_chat.reattach_doc_hint', {
                  name: sanitizeCloudDocQuoteName(activePreviewQuote.name),
                })}
              >
                + {t('cloud_docs.ai_chat.reattach_doc', {
                  name: sanitizeCloudDocQuoteName(activePreviewQuote.name),
                })}
              </button>
            </div>
          )}

          <div class="cloud-docs-mini-chat-controls">
            <SessionControls
              ws={mainChat.ws}
              connected={mainChat.connected}
              activeSession={controlsSession}
              sessionDisplayName={sessionDisplayName}
              quickData={mainChat.quickData}
              detectedModel={mainChat.detectedModel}
              compact
              activeThinking={!!activeThinkingTs}
              activeTransportTurn={activeTimelineTurn}
              transportTimelineEvents={timelineEvents}
              sessions={mainChat.sessions}
              subSessions={mainChat.subSessions}
              serverId={mainChat.serverId}
              canManageFileShares={!isShareScopedState(session.sharedState)}
              quotes={quotes}
              onRemoveQuote={handleRemoveQuote}
              onSend={(_name, text, meta) => {
                const extras = meta?.extra as Record<string, unknown> | undefined;
                const isP2pSend = !!extras && (
                  (Array.isArray(extras.p2pAtTargets) && extras.p2pAtTargets.length > 0)
                  || (typeof extras.p2pMode === 'string' && extras.p2pMode.length > 0)
                  || (extras.p2pSessionConfig != null && typeof extras.p2pSessionConfig === 'object')
                );
                if (isP2pSend || !hasChatTimeline) return;
                addOptimisticUserMessage(text, meta?.commandId, {
                  ...(meta?.attachments ? { attachments: meta.attachments } : {}),
                  ...(meta?.extra ? { resendExtra: meta.extra } : {}),
                  ...(meta?.queueAppend ? { queueAppend: true } : {}),
                });
                if (meta?.commandId && meta.localFailure) {
                  markOptimisticFailed(meta.commandId, meta.localFailure);
                }
                chatScrollFnRef.current?.();
              }}
              onRemoveOptimisticMessage={removeOptimisticMessage}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        class={`cloud-docs-fab${expanded ? ' active' : ''}${isBusy ? ' busy' : ''}${isEntering ? ' is-entering' : ''}${overlayClassSuffix}`}
        onClick={() => setExpanded((prev) => !prev)}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.animationName && event.animationName !== 'cloudDocsFabEntrance') return;
          setIsEntering(false);
        }}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')
          : t('cloud_docs.ai_chat.open', { session: sessionDisplayName })}
        title={expanded
          ? t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')
          : t('cloud_docs.ai_chat.open', { session: sessionDisplayName })}
        data-testid="cloud-docs-main-chat-fab"
      >
        <span class="cloud-docs-fab-aura" aria-hidden="true" />
        <span class="cloud-docs-fab-ring" aria-hidden="true" />
        <img
          class="cloud-docs-fab-avatar"
          src="/imcodes-robot-avatar.png"
          alt="IM.codes AI"
          draggable={false}
        />
        {isBusy && (
          <span
            class="cloud-docs-fab-busy-dot"
            aria-hidden="true"
            data-testid="cloud-docs-fab-busy-dot"
          />
        )}
      </button>
    </div>
  );
}
