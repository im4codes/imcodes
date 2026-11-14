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

interface CloudDocsMainChatFloatProps {
  mainChat: CloudDocsMainChatContext;
  activePreviewQuote?: CloudDocQuoteTarget | null;
}

export function CloudDocsMainChatFloat({ mainChat, activePreviewQuote = null }: CloudDocsMainChatFloatProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [dismissedDocKey, setDismissedDocKey] = useState<string | null>(null);
  const [extraQuotes, setExtraQuotes] = useState<string[]>([]);

  const session = mainChat.session;
  const sessionName = session.name;
  const hasChatTimeline = session.agentType !== 'shell' && session.agentType !== 'script';

  const {
    events: timelineEvents,
    loading: timelineLoading,
    refreshing: timelineRefreshing,
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

  return (
    <div
      class="cloud-docs-main-chat-anchor"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {expanded && (
        <div
          class="cloud-docs-mini-chat"
          role="dialog"
          aria-label={t('cloud_docs.ai_chat.title', { session: sessionDisplayName })}
          data-testid="cloud-docs-mini-chat"
        >
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
              onQuote={(text) => setExtraQuotes((prev) => [...prev, text])}
              agentType={session.agentType}
              onResendFailed={handleResendFailed}
              preview
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
        class={`cloud-docs-fab${expanded ? ' active' : ''}${isBusy ? ' busy' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')
          : t('cloud_docs.ai_chat.open', { session: sessionDisplayName })}
        title={expanded
          ? t('cloud_docs.ai_chat.collapse', 'Collapse AI chat')
          : t('cloud_docs.ai_chat.open', { session: sessionDisplayName })}
        data-testid="cloud-docs-main-chat-fab"
      >
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
