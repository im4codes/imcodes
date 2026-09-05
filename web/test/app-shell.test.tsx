/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { createPortal } from 'preact/compat';
import { P2P_WORKFLOW_MSG } from '@shared/p2p-workflow-messages.js';
import { SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY } from '../src/supervision-task-console-preferences.js';
import {
  SUBSESSION_DESKTOP_DOCK_SIDE,
  SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY,
  SUBSESSION_DESKTOP_LAYOUT,
  SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY,
} from '../src/subsession-desktop-layout-preference.js';
import {
  TEAM_DISCUSSION_LAYOUT,
  TEAM_DISCUSSION_LAYOUT_STORAGE_KEY,
} from '../src/team-discussion-layout-preference.js';

const {
  apiFetchMock,
  chatScrollMock,
  clearApiKeyMock,
  clearAuthKeyMock,
  clearAuthKeyIdMock,
  clearServerUrlMock,
  configureApiKeyMock,
  discoverSharedEntriesMock,
  fetchMeMock,
  getAuthKeyMock,
  getAuthKeyIdMock,
  getServerUrlMock,
  initializeServerScopedAuthMock,
  listManagedSharesForServerMock,
  listP2pRunsMock,
  nativeState,
  openSharedEntryMock,
  wsInstances,
  useSubSessionsState,
  authExpiredState,
  loginAttemptState,
  loginState,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  chatScrollMock: vi.fn(),
  clearApiKeyMock: vi.fn(),
  clearAuthKeyMock: vi.fn(async () => undefined),
  clearAuthKeyIdMock: vi.fn(async () => undefined),
  clearServerUrlMock: vi.fn(async () => undefined),
  configureApiKeyMock: vi.fn(),
  discoverSharedEntriesMock: vi.fn(),
  fetchMeMock: vi.fn(),
  getAuthKeyMock: vi.fn(async () => null as string | null),
  getAuthKeyIdMock: vi.fn(async () => null as string | null),
  getServerUrlMock: vi.fn(async () => null as string | null),
  initializeServerScopedAuthMock: vi.fn(async () => undefined),
  listManagedSharesForServerMock: vi.fn(),
  listP2pRunsMock: vi.fn(),
  nativeState: { value: false },
  openSharedEntryMock: vi.fn(),
  wsInstances: [] as Array<{
    connected: boolean;
    options?: { shareTarget?: unknown };
    messageHandlers: Array<(message: any) => void>;
    latencyHandler: ((ms: number) => void) | null;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    requestSessionList: ReturnType<typeof vi.fn>;
    setClaudeWeeklyQuotaOptIn: ReturnType<typeof vi.fn>;
    subscribeTerminal: ReturnType<typeof vi.fn>;
    unsubscribeTerminal: ReturnType<typeof vi.fn>;
    subscribeTransportSession: ReturnType<typeof vi.fn>;
    unsubscribeTransportSession: ReturnType<typeof vi.fn>;
    sendResize: ReturnType<typeof vi.fn>;
    sendInput: ReturnType<typeof vi.fn>;
    sendSessionCommand: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    p2pListDiscussions: ReturnType<typeof vi.fn>;
    p2pStatus: ReturnType<typeof vi.fn>;
    discussionList: ReturnType<typeof vi.fn>;
    discussionStop: ReturnType<typeof vi.fn>;
    askAnswer: ReturnType<typeof vi.fn>;
    repoDetect: ReturnType<typeof vi.fn>;
    resumeConnection: ReturnType<typeof vi.fn>;
    reconnectNow: ReturnType<typeof vi.fn>;
    onMessage(handler: (message: any) => void): () => void;
    onLatency(handler: ((ms: number) => void) | null): void;
    emit(message: any): void;
    emitLatency(ms: number): void;
  }>,
  useSubSessionsState: {
    subSessions: [] as any[],
    visibleSubSessions: [] as any[],
    loadedServerId: null as string | null,
  },
  authExpiredState: {
    handler: null as ((reason?: string) => void) | null,
  },
  loginAttemptState: {
    pending: null as Promise<void> | null,
    mode: 'native' as 'native' | 'web',
    webReloads: 0,
  },
  loginState: {
    userId: 'user-1',
    baseUrl: 'http://localhost',
  },
}));

function textComponent(name: string) {
  return () => name;
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../src/api.js', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;

    constructor(status: number, body?: unknown) {
      super(`api ${status}`);
      this.status = status;
      this.body = body;
    }
  }

  return {
    ApiError,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    clearApiKey: (...args: unknown[]) => clearApiKeyMock(...args),
    configure: vi.fn(),
    configureExpectedUserId: vi.fn(),
    configureApiKey: (...args: unknown[]) => configureApiKeyMock(...args),
    discoverSharedEntries: (...args: unknown[]) => discoverSharedEntriesMock(...args),
    fetchMe: (...args: unknown[]) => fetchMeMock(...args),
    getApiKey: vi.fn(() => 'api-key-1'),
    listManagedSharesForServer: (...args: unknown[]) => listManagedSharesForServerMock(...args),
    listP2pRuns: (...args: unknown[]) => listP2pRunsMock(...args),
    normalizeLocalWebPreviewPath: (path: string) => path.startsWith('/') ? path : `/${path}`,
    openSharedEntry: (...args: unknown[]) => openSharedEntryMock(...args),
    onAuthExpired: (handler: (reason?: string) => void) => {
      authExpiredState.handler = handler;
    },
    refreshSessionIfStale: vi.fn(),
    startProactiveRefresh: vi.fn(),
    stopProactiveRefresh: vi.fn(),
  };
});

vi.mock('../src/native.js', () => ({
  clearServerUrl: (...args: unknown[]) => clearServerUrlMock(...args),
  getServerUrl: (...args: unknown[]) => getServerUrlMock(...args),
  isNative: vi.fn(() => nativeState.value),
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setStyle: vi.fn(async () => undefined),
    setBackgroundColor: vi.fn(async () => undefined),
  },
  Style: { Dark: 'DARK' },
}));

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => undefined) },
}));

vi.mock('../src/biometric-auth.js', () => ({
  clearAuthKey: (...args: unknown[]) => clearAuthKeyMock(...args),
  clearAuthKeyId: (...args: unknown[]) => clearAuthKeyIdMock(...args),
  getAuthKey: (...args: unknown[]) => getAuthKeyMock(...args),
  getAuthKeyId: (...args: unknown[]) => getAuthKeyIdMock(...args),
  initializeServerScopedAuth: (...args: unknown[]) => initializeServerScopedAuthMock(...args),
}));

vi.mock('../src/push-notifications.js', () => ({
  initPushNotifications: vi.fn(async () => undefined),
  resetPushBadge: vi.fn(async () => undefined),
}));

vi.mock('../src/ws-client.js', () => ({
  WsClient: class MockWsClient {
    connected = false;
    options?: { shareTarget?: unknown };
    messageHandlers: Array<(message: any) => void> = [];
    latencyHandler: ((ms: number) => void) | null = null;
    connect = vi.fn(() => { this.connected = true; });
    disconnect = vi.fn(() => { this.connected = false; });
    requestSessionList = vi.fn();
    setClaudeWeeklyQuotaOptIn = vi.fn();
    subscribeTerminal = vi.fn();
    unsubscribeTerminal = vi.fn();
    subscribeTransportSession = vi.fn();
    unsubscribeTransportSession = vi.fn();
    sendResize = vi.fn();
    sendInput = vi.fn();
    sendSessionCommand = vi.fn();
    send = vi.fn();
    p2pListDiscussions = vi.fn();
    p2pStatus = vi.fn();
    discussionList = vi.fn();
    discussionStop = vi.fn();
    askAnswer = vi.fn();
    repoDetect = vi.fn();
    resumeConnection = vi.fn();
    reconnectNow = vi.fn();

    constructor(_baseUrl?: string, _serverId?: string, options?: { shareTarget?: unknown }) {
      this.options = options;
      wsInstances.push(this);
    }

    // The real client always exposes the daemon capability snapshot; anything
    // rendered from `daemon.hello` (remote control, for one) reads it on mount.
    daemonCapabilitySnapshot: { capabilities: string[] } | null = null;
    daemonCapabilityHandlers: Array<(snapshot: unknown) => void> = [];
    getDaemonCapabilitySnapshot(): { capabilities: string[] } | null {
      return this.daemonCapabilitySnapshot;
    }

    onDaemonCapabilitySnapshot(handler: (snapshot: unknown) => void): () => void {
      this.daemonCapabilityHandlers.push(handler);
      return () => {
        this.daemonCapabilityHandlers = this.daemonCapabilityHandlers.filter((h) => h !== handler);
      };
    }

    /** Announce a `daemon.hello` capability set, as the real client does. */
    emitDaemonCapabilities(capabilities: string[]): void {
      this.daemonCapabilitySnapshot = { capabilities };
      for (const handler of [...this.daemonCapabilityHandlers]) handler(this.daemonCapabilitySnapshot);
    }

    onMessage(handler: (message: any) => void): () => void {
      this.messageHandlers.push(handler);
      return () => {
        this.messageHandlers = this.messageHandlers.filter((item) => item !== handler);
      };
    }

    onLatency(handler: ((ms: number) => void) | null): void {
      this.latencyHandler = handler;
    }

    emit(message: any): void {
      for (const handler of [...this.messageHandlers]) handler(message);
    }

    emitLatency(ms: number): void {
      this.latencyHandler?.(ms);
    }
  },
}));

vi.mock('../src/hooks/useSubSessions.js', () => ({
  useSubSessions: () => ({
    ...useSubSessionsState,
    create: vi.fn(async () => null),
    close: vi.fn(),
    hydrateShared: vi.fn(),
    restart: vi.fn(),
    rename: vi.fn(),
    updateLocal: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useProviderStatus.js', () => ({
  useProviderStatus: () => ({
    isProviderConnected: () => true,
    getRemoteSessions: vi.fn(async () => []),
    refreshSessions: vi.fn(async () => undefined),
  }),
}));

vi.mock('../src/hooks/useUnreadCounts.js', () => ({
  useUnreadCounts: () => new Map(),
}));

vi.mock('../src/hooks/usePref.js', () => ({
  parseString: (value: unknown) => String(value),
  parseBooleanish: (value: unknown) => value === true,
  usePref: () => ({ loaded: true, value: '/bin/bash' }),
}));

vi.mock('../src/hooks/useSyncedPreference.js', async () => {
  const { useState } = await vi.importActual<typeof import('preact/hooks')>('preact/hooks');
  return {
    useSyncedPreference: (_key: string, initial: unknown) => {
      const [value, setValue] = useState(initial);
      return [value, setValue, true];
    },
  };
});

vi.mock('../src/git-status-store.js', () => ({
  requestSharedChanges: vi.fn(),
  useSharedGitChanges: () => [],
}));

vi.mock('../src/watch-bridge.js', () => ({
  onWatchCommand: vi.fn(async () => vi.fn()),
}));

vi.mock('../src/watch-projection.js', () => ({
  watchProjectionStore: {
    addSubSession: vi.fn(),
    beginServerSwitch: vi.fn(),
    getSnapshot: vi.fn(() => ({ sessions: [] })),
    handleTimelineEvent: vi.fn(),
    onSessionIdle: vi.fn(),
    pushDurableEvent: vi.fn(),
    removeSubSession: vi.fn(),
    setApiKey: vi.fn(),
    setCurrentServerId: vi.fn(),
    setServers: vi.fn(),
    setSnapshotStatus: vi.fn(),
    updateFromSessionListWithSubs: vi.fn(),
    updateSessionState: vi.fn(),
  },
}));

vi.mock('../src/hooks/useTimeline.js', () => ({
  ingestTimelineEventForCache: vi.fn(),
  requestActiveTimelineRefresh: vi.fn(),
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
}));

vi.mock('../src/components/ErrorBoundary.js', () => ({
  ErrorBoundary: ({ children }: { children?: unknown }) => children,
}));

vi.mock('../src/components/LanguageSwitcher.js', () => ({ LanguageSwitcher: textComponent('language-switcher') }));
vi.mock('../src/pages/LoginPage.js', () => ({
  LoginPage: ({
    onLoginSuccess,
    beginAuthAttempt,
    onChangeServer,
  }: {
    onLoginSuccess: (userId: string, url: string) => void;
    beginAuthAttempt?: () => { isCurrent: () => boolean; finish: () => void };
    onChangeServer?: () => void | Promise<void>;
  }) => (
    <div>
      <button
        type="button"
        onClick={async () => {
          const attempt = beginAuthAttempt?.();
          try {
            if (loginAttemptState.pending) await loginAttemptState.pending;
            if (attempt?.isCurrent() ?? true) {
              if (loginAttemptState.mode === 'web') {
                // Model the real Web LoginPage path: it owns the cookie login
                // and reloads directly; it does not call native onLoginSuccess.
                loginAttemptState.webReloads += 1;
              } else {
                onLoginSuccess(loginState.userId, loginState.baseUrl);
              }
            }
          } finally {
            attempt?.finish();
          }
        }}
      >login-page</button>
      {onChangeServer && (
        <button type="button" onClick={() => void onChangeServer()}>
          change-server
        </button>
      )}
    </div>
  ),
}));
vi.mock('../src/pages/ServerSetupPage.js', () => ({
  ServerSetupPage: ({ onConnect }: { onConnect: (url: string) => void | Promise<void> }) => (
    <button type="button" onClick={() => void onConnect('https://new-server.example')}>
      server-setup-page
    </button>
  ),
}));
vi.mock('../src/pages/NativeAuthBridge.js', () => ({ NativeAuthBridge: textComponent('native-auth-bridge') }));
vi.mock('../src/pages/DashboardPage.js', () => ({
  DashboardPage: ({ sharedEntries = [] }: { sharedEntries?: Array<{ id: string }> }) => (
    <div>
      <span>dashboard-page</span>
      <span data-testid="dashboard-shared-count">{sharedEntries.length}</span>
    </div>
  ),
}));
vi.mock('../src/pages/DiscussionsPage.js', () => ({
  DiscussionsPage: ({ initialTab }: any) => (
    <div>
      discussions-page
      <span data-testid="discussions-initial-tab">{initialTab ?? 'team'}</span>
    </div>
  ),
}));
vi.mock('../src/pages/RepoPage.js', () => ({
  RepoPage: ({ onBack, onCiEvent }: any) => (
    <div>
      repo-page
      <button onClick={() => onCiEvent?.({ status: 'failure', name: 'CI', failedJobName: 'test', failedStepName: 'unit' })}>repo-ci</button>
      <button onClick={onBack}>repo-back</button>
    </div>
  ),
}));
vi.mock('../src/pages/SettingsPage.js', () => ({
  SettingsPage: ({ onBack, onDisplayNameChanged, onUserAuthUpdated }: any) => (
    <div>
      settings-page
      <button onClick={() => onDisplayNameChanged?.('Grace')}>settings-display</button>
      <button onClick={() => onUserAuthUpdated?.({ username: 'grace', hasPassword: false })}>settings-auth</button>
      <button onClick={onBack}>settings-back</button>
    </div>
  ),
}));
vi.mock('../src/pages/AdminPage.js', () => ({
  AdminPage: ({ onBack }: any) => <button onClick={onBack}>admin-page</button>,
}));
vi.mock('../src/pages/CronManager.js', () => ({
  CronManager: ({ onBack, onNavigateSession, onViewDiscussion }: any) => (
    <div>
      cron-manager
      <button onClick={() => onNavigateSession?.('deck_alpha_brain', 'quote')}>cron-navigate</button>
      <button onClick={() => onViewDiscussion?.('disc-1')}>cron-discussion</button>
      <button onClick={onBack}>cron-back</button>
    </div>
  ),
}));

vi.mock('../src/components/ServerIconBar.js', () => ({
  ServerIconBar: ({ servers, returnHintServerId, onSelectServer, onSettings, onAdmin, onHome, onToggleSidebar, onServerContextMenu }: any) => (
    <div data-testid="server-icon-bar" data-return-hint-server-id={returnHintServerId ?? ''}>
      server-icon-bar
      <button onClick={onSettings}>server-settings</button>
      <button onClick={onAdmin}>server-admin</button>
      <button onClick={onHome}>server-home</button>
      <button onClick={onToggleSidebar}>server-toggle-sidebar</button>
      <button onClick={() => onSelectServer?.(servers?.[0]?.id, servers?.[0]?.name)}>server-select</button>
      <button onClick={() => onServerContextMenu?.(servers?.[0], 11, 22)}>server-menu</button>
    </div>
  ),
}));
vi.mock('../src/components/Sidebar.js', () => ({
  Sidebar: ({ children, onDropPanel }: any) => (
    <div data-testid="sidebar-panel">
      sidebar
      <button onClick={() => onDropPanel?.('subsession', 'sub-1')}>sidebar-drop</button>
      <button onClick={() => onDropPanel?.('subsession', 'sub-2')}>sidebar-drop-sub-2</button>
      {children}
    </div>
  ),
  loadSidebarCollapsed: vi.fn(() => false),
  saveSidebarCollapsed: vi.fn(),
}));
vi.mock('../src/components/SessionTree.js', () => ({
  SessionTree: ({ sessions, subSessions, onSelectSession, onSelectSubSession, onNewSession, onNewSubSession }: any) => (
    <div>
      session-tree
      <button onClick={() => onSelectSession?.(sessions?.[0]?.name)}>tree-select-session</button>
      {sessions?.map((session: any) => (
        <button key={session.name} onClick={() => onSelectSession?.(session.name)}>
          tree-select-session-{session.name}
        </button>
      ))}
      <button onClick={() => onSelectSubSession?.(subSessions?.[0])}>tree-select-sub</button>
      <button onClick={onNewSession}>tree-new-session</button>
      <button onClick={onNewSubSession}>tree-new-sub</button>
    </div>
  ),
}));
vi.mock('../src/components/SessionTabs.js', () => ({
  SessionTabs: ({ sessions, onSelect, onAlertDismiss, onNewSession, onStopProject, onRestartProject, onOpenSessionSettings, onCloneSession, onRenameHandled, onRenameSession }: any) => (
    <div>
      session-tabs
      <button onClick={() => onSelect?.(sessions?.[0]?.name)}>tabs-select</button>
      {sessions?.map((session: any) => (
        <button key={session.name} onClick={() => onSelect?.(session.name)}>tabs-select-{session.name}</button>
      ))}
      <button onClick={() => onAlertDismiss?.(sessions?.[0]?.name)}>tabs-dismiss</button>
      <button onClick={onNewSession}>tabs-new-session</button>
      <button onClick={() => onStopProject?.()}>tabs-stop</button>
      <button onClick={() => onRestartProject?.()}>tabs-restart</button>
      <button onClick={() => onOpenSessionSettings?.(sessions?.[0])}>tabs-settings</button>
      <button onClick={() => onCloneSession?.(sessions?.[0])}>tabs-clone</button>
      <button onClick={onRenameHandled}>tabs-rename-handled</button>
      <button onClick={() => onRenameSession?.(sessions?.[0]?.name, 'Renamed')}>tabs-rename</button>
    </div>
  ),
}));
vi.mock('../src/components/SessionPane.js', () => ({
  SessionPane: ({
    session,
    onAfterAction,
    onChatScrollFn,
    onDiff,
    onFitFn,
    onFocusFn,
    onHistory,
    onInputRef,
    onMobileFileBrowserClose,
    onPendingPrefillApplied,
    onPreviewFile,
    onOpenLocalWebPreview,
    onRenameSession,
    onScrollBottomFn,
    onSettings,
    onStopProject,
    onTransportConfigSaved,
  }: any) => (
    <div
      data-testid={`session-pane-${session.name}`}
      data-active-dispatch-id={session.sharedState?.activeDispatchId ?? ''}
      data-supervision-mode={session.supervisionMode ?? ''}
    >
      session-pane:{session.name}
      <button onClick={() => onFitFn?.(vi.fn())}>pane-fit-ref</button>
      <button onClick={() => onScrollBottomFn?.(vi.fn())}>pane-scroll-ref</button>
      <button onClick={() => onFocusFn?.(vi.fn())}>pane-focus-ref</button>
      <button onClick={() => onChatScrollFn?.(chatScrollMock)}>pane-chat-ref</button>
      <button onClick={() => onInputRef?.(document.createElement('div'))}>pane-input-ref</button>
      <button onClick={() => onDiff?.(vi.fn())}>pane-diff-ref</button>
      <button onClick={() => onHistory?.(vi.fn())}>pane-history-ref</button>
      <button onClick={onStopProject}>pane-stop</button>
      <button onClick={onRenameSession}>pane-rename</button>
      <button onClick={onSettings}>pane-settings</button>
      <button onClick={() => onTransportConfigSaved?.({ supervision: { mode: 'supervised' } })}>pane-config</button>
      <button onClick={onAfterAction}>pane-after-action</button>
      <button onClick={onMobileFileBrowserClose}>pane-close-mobile-files</button>
      <button onClick={onPendingPrefillApplied}>pane-prefill-applied</button>
      <button onClick={() => onPreviewFile?.({
        path: '/home/ai/.imcodes/uploads/392836a75fc67a4ff38c2dcedc9afe32.png',
        sessionName: session.name,
      })}>pane-preview-upload</button>
      <button onClick={() => onOpenLocalWebPreview?.({ port: 8787, path: '/docs?q=1#intro' })}>pane-preview-loopback</button>
    </div>
  ),
}));
vi.mock('../src/components/SubSessionBar.js', () => ({
  SUBSESSION_BAR_COLLAPSED_STORAGE_KEY: 'subsession_bar_collapsed',
  SubSessionBar: ({
    onCollapsedChange,
    onNew,
    onOpen,
    onCloseAllOpen,
    onRestoreQuickClosed,
    onOpenMaximized,
    onViewAutoDeliver,
    onViewCron,
    onViewDiscussions,
    onViewDiscussion,
    onViewRepo,
    onStopDiscussion,
    subSessions,
    discussions = [],
    totalRunningDiscussions = 0,
    openSpecAutoProjection,
    openSpecAutoCompact,
    onOpenSpecAutoView,
    onOpenSpecAutoStop,
    onOpenSpecAutoToggleCompact,
    onOpenSpecAutoHide,
    desktopLayoutCapable,
    desktopLayout,
    onDesktopLayoutChange,
    desktopDockSide,
    onDesktopDockSideChange,
    verticalRailHost,
    teamDiscussionLayout,
    onTeamDiscussionLayoutChange,
    teamDiscussionRailHost,
  }: any) => (
    <div
      data-testid="app-shell-subsession-bar"
      data-running-discussions={String(totalRunningDiscussions)}
      data-desktop-layout={desktopLayout}
      data-desktop-dock-side={desktopDockSide}
      data-team-discussion-layout={teamDiscussionLayout}
    >
      {verticalRailHost && desktopLayout === SUBSESSION_DESKTOP_LAYOUT.VERTICAL && createPortal(
        <div data-testid="app-shell-subsession-vertical-rail">mock vertical rail</div>,
        verticalRailHost,
      )}
      {teamDiscussionRailHost
        && teamDiscussionLayout === TEAM_DISCUSSION_LAYOUT.RIGHT
        && discussions.length > 0
        && createPortal(
          <div data-testid="app-shell-team-discussion-rail">mock Team discussion rail</div>,
          teamDiscussionRailHost,
        )}
      sub-session-bar
      {desktopLayoutCapable && onDesktopLayoutChange && (
        <button
          data-testid="app-shell-subsession-layout-toggle"
          aria-label={desktopLayout === SUBSESSION_DESKTOP_LAYOUT.VERTICAL ? 'switch horizontal' : 'switch vertical'}
          onClick={() => onDesktopLayoutChange(
            desktopLayout === SUBSESSION_DESKTOP_LAYOUT.VERTICAL
              ? SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL
              : SUBSESSION_DESKTOP_LAYOUT.VERTICAL,
          )}
        >layout-toggle</button>
      )}
      {desktopLayoutCapable
        && desktopLayout === SUBSESSION_DESKTOP_LAYOUT.VERTICAL
        && onDesktopDockSideChange && (
        <>
          <button
            data-testid="app-shell-subsession-dock-left"
            onClick={() => onDesktopDockSideChange(SUBSESSION_DESKTOP_DOCK_SIDE.LEFT)}
          >dock-left</button>
          <button
            data-testid="app-shell-subsession-dock-right"
            onClick={() => onDesktopDockSideChange(SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT)}
          >dock-right</button>
        </>
      )}
      {desktopLayoutCapable && onTeamDiscussionLayoutChange && (
        <>
          <button
            data-testid="app-shell-team-discussion-right"
            onClick={() => onTeamDiscussionLayoutChange(TEAM_DISCUSSION_LAYOUT.RIGHT)}
          >team-right</button>
          <button
            data-testid="app-shell-team-discussion-bottom"
            onClick={() => onTeamDiscussionLayoutChange(TEAM_DISCUSSION_LAYOUT.BOTTOM)}
          >team-bottom</button>
        </>
      )}
      {openSpecAutoProjection && (
        <div
          data-testid="app-shell-auto-deliver-runbar"
          data-compact={String(openSpecAutoCompact)}
          data-run-id={openSpecAutoProjection.runId}
        >
          {openSpecAutoProjection.changeName}
          <button onClick={onOpenSpecAutoView}>subbar-auto-deliver-view</button>
          <button onClick={onOpenSpecAutoStop}>subbar-auto-deliver-stop-run</button>
          <button onClick={onOpenSpecAutoToggleCompact}>subbar-auto-deliver-compact-run</button>
          <button onClick={onOpenSpecAutoHide}>subbar-auto-deliver-hide-run</button>
        </div>
      )}
      {discussions.map((discussion: any) => (
        <div
          key={discussion.id}
          data-testid={`app-shell-p2p-discussion-${discussion.id}`}
          data-state={discussion.state}
        >
          {discussion.topic}
          {(discussion.nodes ?? []).map((node: any) => (
            <span key={`${discussion.id}-${node.label}`} data-testid={`app-shell-p2p-node-${discussion.id}-${node.label}`}>
              {node.label}:{node.status}
            </span>
          ))}
        </div>
      ))}
      <button onClick={() => onCollapsedChange?.(true)}>subbar-collapse</button>
      <button onClick={onNew}>subbar-new</button>
      <button onClick={() => onOpen?.(subSessions?.[0]?.id)}>subbar-open</button>
      {subSessions?.map((sub: any) => (
        <button key={sub.id} onClick={() => onOpen?.(sub.id)}>subbar-open-{sub.id}</button>
      ))}
      <button onClick={onCloseAllOpen}>subbar-quick-close</button>
      <button onClick={() => onRestoreQuickClosed?.(subSessions?.map((sub: any) => sub.id) ?? [])}>subbar-quick-restore</button>
      <button onClick={() => onOpenMaximized?.(subSessions?.[0]?.id)}>subbar-open-max</button>
      <button onClick={onViewAutoDeliver}>subbar-auto-deliver</button>
      <button onClick={onViewCron}>subbar-cron</button>
      <button onClick={onViewDiscussions}>subbar-discussions</button>
      <button onClick={() => onViewDiscussion?.('disc-1')}>subbar-discussion</button>
      <button onClick={onViewRepo}>subbar-repo</button>
      <button onClick={() => onStopDiscussion?.('p2p_run-1')}>subbar-stop-p2p</button>
      <button onClick={() => onStopDiscussion?.('discussion-1')}>subbar-stop-discussion</button>
    </div>
  ),
}));
vi.mock('../src/components/SubSessionWindow.js', () => ({
  SubSessionWindow: ({ sub, ws, active, visible, zIndex, onFocus, onViewRepo, onShareSession, sharedState }: any) => {
    const incomingViewer = !!sharedState
      && sharedState.outgoing !== true
      && sharedState.effectiveRole !== 'participant';
    return (
    <div
      data-testid={`sub-session-window-${sub?.id}`}
      data-active={String(active)}
      data-visible={String(visible)}
      data-shared-outgoing={String(sharedState?.outgoing === true)}
      data-share-role={sharedState?.effectiveRole ?? ''}
      style={{ zIndex }}
      onMouseDown={onFocus}
    >
      sub-session-window
      <button onClick={onViewRepo}>sub-window-repo-{sub?.id}</button>
      <input aria-label={`sub-window-composer-${sub?.id}`} disabled={incomingViewer} />
      <button
        disabled={incomingViewer}
        onClick={() => ws?.sendSessionCommand?.(sub.sessionName, `message-for-${sub.id}`, {})}
      >sub-window-send-{sub?.id}</button>
      <button
        onClick={() => onShareSession?.({
          name: sub.sessionName,
          project: sub.label ?? sub.sessionName,
          role: 'w1',
          agentType: sub.type,
          state: sub.state,
        }, sub.id)}
      >sub-window-share-{sub?.id}</button>
    </div>
    );
  },
}));
vi.mock('../src/components/ShareSessionDialog.js', () => ({
  ShareSessionDialog: ({ onClose, onSharesChanged }: any) => (
    <div>
      share-session-dialog
      <button onClick={onSharesChanged}>share-session-refresh</button>
      <button onClick={onClose}>share-session-close</button>
    </div>
  ),
}));
vi.mock('../src/components/DesktopWindowMaximizeButton.js', () => ({
  DesktopWindowMaximizeButton: ({ onClick }: any) => <button onClick={onClick}>maximize-button</button>,
}));
vi.mock('../src/components/NewSessionDialog.js', () => ({
  NewSessionDialog: ({ onClose, onSessionStarted }: any) => (
    <div>
      new-session-dialog
      <button onClick={() => onSessionStarted?.('deck_beta_brain')}>new-session-start</button>
      <button onClick={onClose}>new-session-close</button>
    </div>
  ),
}));
vi.mock('../src/components/StartSubSessionDialog.js', () => ({
  StartSubSessionDialog: ({ onClose, onStart, allowedAgentTypes, overlayClassName }: any) => (
    <div data-allowed-agent-types={allowedAgentTypes?.join(',') ?? ''} data-overlay-class={overlayClassName ?? ''}>
      start-sub-session-dialog
      <button onClick={() => void onStart?.('codex-sdk', '/bin/bash', '/work/alpha', 'Helper', {})}>start-sub-start</button>
      <button onClick={onClose}>start-sub-close</button>
    </div>
  ),
}));
vi.mock('../src/components/SessionSettingsDialog.js', () => ({
  SessionSettingsDialog: ({ onClose, onSaved, onAddPoolSession, poolSessionDialogOpen, supervisionMode, canControlAutomaticSupervision }: any) => (
    <div
      data-testid="session-settings-dialog"
      data-child-dialog-open={String(Boolean(poolSessionDialogOpen))}
      data-supervision-mode={supervisionMode ?? ''}
      data-can-control-supervision={String(Boolean(canControlAutomaticSupervision))}
    >
      session-settings-dialog
      <button onClick={() => onAddPoolSession?.('economy')}>settings-pool-add</button>
      <button onClick={() => onSaved?.({ label: 'Saved', type: 'codex-sdk', cwd: '/work/saved', transportConfig: {} })}>settings-save</button>
      <button onClick={onClose}>settings-close</button>
    </div>
  ),
}));
vi.mock('../src/components/CloneSessionGroupDialog.js', () => ({
  CloneSessionGroupDialog: ({ onClose }: any) => (
    <div>
      clone-session-group-dialog
      <button onClick={onClose}>clone-close</button>
    </div>
  ),
}));
vi.mock('../src/components/StartDiscussionDialog.js', () => ({ StartDiscussionDialog: textComponent('start-discussion-dialog') }));
vi.mock('../src/components/AskQuestionDialog.js', () => ({
  AskQuestionDialog: ({ pending, onDismiss, onSubmit }: any) => (
    <div>
      ask-question-dialog
      {pending?.questions?.map((question: any, index: number) => (
        <div key={index}>
          <span>{question.header}</span>
          <span>{question.question}</span>
          {question.options?.map((option: any, optionIndex: number) => (
            <span key={optionIndex}>{option.label}</span>
          ))}
        </div>
      ))}
      <button onClick={() => onSubmit?.('answer')}>ask-submit</button>
      <button onClick={onDismiss}>ask-dismiss</button>
    </div>
  ),
}));
vi.mock('../src/components/ServerContextMenu.js', () => ({
  DeleteServerDialog: ({ onCancel, onConfirm }: any) => (
    <div>
      delete-server-dialog
      <button onClick={onConfirm}>delete-confirm</button>
      <button onClick={onCancel}>delete-cancel</button>
    </div>
  ),
  ServerContextMenu: ({ onClose, onDelete, onRename, onUpgrade, onUpgradeAll }: any) => (
    <div>
      server-context-menu
      <button onClick={onRename}>server-menu-rename</button>
      <button onClick={onUpgrade}>server-menu-upgrade</button>
      <button onClick={onUpgradeAll}>server-menu-upgrade-all</button>
      <button onClick={onDelete}>server-menu-delete</button>
      <button onClick={onClose}>server-menu-close</button>
    </div>
  ),
}));
vi.mock('../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children, id, zIndex, onClose, onFocus, onPin, onToggleMaximized }: any) => (
    <div data-testid={`floating-panel-${id}`} style={{ zIndex }}>
      floating-panel
      <button onClick={onFocus}>floating-focus</button>
      <button onClick={onPin}>floating-pin</button>
      <button onClick={onToggleMaximized}>floating-toggle-max</button>
      <button onClick={onClose}>floating-close</button>
      {children}
    </div>
  ),
}));
vi.mock('../src/components/SharedContextManagementPanel.js', () => ({
  SharedContextManagementPanel: ({ onEnterpriseChange }: any) => (
    <button onClick={() => onEnterpriseChange?.('ent-2')}>shared-context-management</button>
  ),
}));
vi.mock('../src/components/ControlledNodesPanel.js', () => ({
  ControlledNodesPanel: ({ onOpenRemoteDesktop, onOpenRemoteDesktopWall }: any) => (
    <div>
      <button onClick={() => onOpenRemoteDesktop?.({
        serverId: 'desktop-1',
        refName: 'desktop-ref',
        displayName: 'Desktop One',
        os: 'win',
        online: true,
        execEnabled: true,
        accessRole: 'owner',
        capabilities: [],
      })}>controlled-nodes-panel</button>
      <button onClick={onOpenRemoteDesktopWall}>controlled-nodes-wall</button>
    </div>
  ),
}));
vi.mock('../src/components/ControlledNodeQuickMenu.js', () => ({
  ControlledNodeQuickMenu: ({ onOpenRemoteDesktop, onOpenRemoteDesktopWall }: any) => (
    <>
      <button
        data-testid="controlled-node-quick-trigger"
        onClick={() => onOpenRemoteDesktop?.({
          serverId: 'desktop-quick',
          refName: 'desktop-quick-ref',
          displayName: 'Desktop Quick',
          os: 'win',
          online: true,
          execEnabled: true,
          accessRole: 'owner',
          capabilities: [],
        })}
      >controlled-node-quick-trigger</button>
      <button
        data-testid="controlled-node-quick-wall"
        onClick={() => onOpenRemoteDesktopWall?.()}
      >controlled-node-quick-wall</button>
    </>
  ),
}));
vi.mock('../src/components/RemoteDesktopPanel.js', () => ({
  RemoteDesktopPanel: ({ onClose }: any) => (
    <div data-testid="remote-desktop-panel">
      remote-desktop-panel
      <button onClick={onClose}>remote-desktop-close</button>
    </div>
  ),
}));
vi.mock('../src/components/RemoteDesktopWorkspace.js', () => ({
  RemoteDesktopWorkspace: ({ minimized, onCloseWorkspace, onMinimize, onRestore, zIndex, onFocus }: any) => (
    <div data-testid="remote-desktop-workspace" style={{ zIndex }} onMouseDown={onFocus}>
      remote-desktop-workspace
      <span>remote-desktop-minimized:{String(Boolean(minimized))}</span>
      <button onClick={onMinimize}>remote-desktop-minimize</button>
      {minimized && <button onClick={onRestore}>remote-desktop-restore</button>}
      <button onClick={onCloseWorkspace}>remote-desktop-close</button>
    </div>
  ),
}));
vi.mock('../src/components/RemoteDesktopWall.js', () => ({
  REMOTE_DESKTOP_WALL_WINDOW_ID: 'remote-desktop-wall',
  RemoteDesktopWall: ({ zIndex, onFocus, onClose }: any) => (
    <div data-testid="remote-desktop-wall" style={{ zIndex }} onMouseDown={onFocus}>
      remote-desktop-wall
      <button onClick={() => onClose?.([])}>remote-desktop-wall-close</button>
    </div>
  ),
}));
vi.mock('../src/components/ContextDiagnosticsPanel.js', () => ({
  ContextDiagnosticsPanel: ({ onStateChange }: any) => (
    <button onClick={() => onStateChange?.({ enterpriseId: 'ent-1', language: 'ts' })}>context-diagnostics</button>
  ),
}));
vi.mock('../src/components/NewUserGuide.js', () => ({
  NewUserGuide: ({ onClose, onComplete, open }: any) => (
    <div>
      new-user-guide:{String(open)}
      <button onClick={onClose}>guide-close</button>
      <button onClick={onComplete}>guide-complete</button>
    </div>
  ),
}));
vi.mock('../src/components/P2pRingProgress.js', () => ({ P2pRingProgress: textComponent('p2p-ring-progress') }));
vi.mock('../src/components/SidebarPinnedPanel.js', () => ({
  SidebarPinnedPanel: ({ onResize, onUnpin }: any) => (
    <div>
      sidebar-pinned-panel
      <button onClick={() => onResize?.(333)}>pinned-resize</button>
      <button onClick={onUnpin}>pinned-unpin</button>
    </div>
  ),
}));
vi.mock('../src/components/LocalWebPreviewPanel.js', () => ({
  LocalWebPreviewPanel: ({ port, path, onDraftChange }: any) => (
    <div data-testid="local-web-preview" data-port={port} data-path={path}>
      local-web-preview
      <button onClick={() => onDraftChange?.({ port: '5173', path: '/app' })}>preview-draft</button>
    </div>
  ),
}));
vi.mock('../src/components/file-browser-lazy.js', () => ({
  FileBrowser: ({ autoPreviewPath, onClose, onConfirm, onPreviewStateChange, scopeToSessionRoot }: any) => (
    <div
      data-testid={autoPreviewPath ? 'file-browser-preview' : 'file-browser'}
      data-scope-to-session-root={String(!!scopeToSessionRoot)}
    >
      file-browser
      <button onClick={() => onConfirm?.(['/work/alpha/src/index.ts'])}>file-confirm</button>
      <button onClick={() => onPreviewStateChange?.({ path: '/work/alpha/src/index.ts', preview: { status: 'loaded' } })}>file-preview-state</button>
      <button onClick={onClose}>file-close</button>
    </div>
  ),
}));
vi.mock('../src/components/pinnedPanelTypes.js', () => ({
  LOCAL_WEB_PREVIEW_PANEL_TYPE: 'local-web-preview',
  SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE: 'shared-context-diagnostics',
  SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE: 'shared-context-management',
}));

async function importApp() {
  return import('../src/app.js');
}

function serverList() {
  return {
    servers: [{
      id: 'srv-1',
      name: 'Alpha Server',
      status: 'online',
      lastHeartbeatAt: Date.now(),
      createdAt: Date.now(),
      daemonVersion: '2026.5.11',
    }],
  };
}

function sessionList() {
  return {
    sessions: [{
      name: 'deck_alpha_brain',
      project_name: 'Alpha',
      role: 'brain',
      agent_type: 'codex-sdk',
      agent_version: '5.0',
      state: 'running',
      project_dir: '/work/alpha',
      runtime_type: 'process',
      label: 'Alpha Brain',
      description: 'Main session',
    }],
  };
}

function sharedMainOpenResult(
  shareId: string,
  activeDispatchId: string,
  effectiveRole: 'viewer' | 'participant' = 'participant',
) {
  return {
    server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
    target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    coverage: {
      effectiveRole,
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: [shareId],
      primaryShareId: shareId,
      authorizedAt: Date.now(),
    },
    sessions: [{
      sessionName: 'deck_beta_brain',
      title: 'Shared Beta',
      state: 'running',
      agentType: 'codex-sdk',
      activeDispatchId,
    }],
    subSessions: [],
  };
}

async function getActiveWsClient() {
  await waitFor(() => {
    expect(wsInstances.some((instance) => instance.messageHandlers.length > 0)).toBe(true);
  });
  return wsInstances.findLast((instance) => instance.messageHandlers.length > 0) ?? wsInstances[wsInstances.length - 1];
}

beforeEach(() => {
  vi.resetModules();
  history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  wsInstances.length = 0;
  useSubSessionsState.subSessions = [];
  useSubSessionsState.visibleSubSessions = [];
  useSubSessionsState.loadedServerId = 'srv-1';
  authExpiredState.handler = null;
  loginAttemptState.pending = null;
  loginAttemptState.mode = 'native';
  loginAttemptState.webReloads = 0;
  loginState.userId = 'user-1';
  loginState.baseUrl = 'http://localhost';
  nativeState.value = false;
  chatScrollMock.mockReset();
  clearApiKeyMock.mockReset();
  clearAuthKeyMock.mockReset();
  clearAuthKeyMock.mockResolvedValue(undefined);
  clearAuthKeyIdMock.mockReset();
  clearAuthKeyIdMock.mockResolvedValue(undefined);
  clearServerUrlMock.mockReset();
  clearServerUrlMock.mockResolvedValue(undefined);
  configureApiKeyMock.mockReset();
  getAuthKeyMock.mockReset();
  getAuthKeyMock.mockResolvedValue(null);
  getAuthKeyIdMock.mockReset();
  getAuthKeyIdMock.mockResolvedValue(null);
  getServerUrlMock.mockReset();
  getServerUrlMock.mockResolvedValue(null);
  initializeServerScopedAuthMock.mockReset();
  initializeServerScopedAuthMock.mockResolvedValue(undefined);
  listManagedSharesForServerMock.mockReset();
  listManagedSharesForServerMock.mockResolvedValue([]);
  fetchMeMock.mockResolvedValue({
    id: 'user-1',
    is_admin: true,
    display_name: 'Ada',
    username: 'ada',
    has_password: true,
  });
  listP2pRunsMock.mockResolvedValue([]);
  discoverSharedEntriesMock.mockReset();
  discoverSharedEntriesMock.mockResolvedValue([]);
  openSharedEntryMock.mockReset();
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/auth/user/me') return { id: 'user-1' };
    if (path === '/api/server') return serverList();
    if (path === '/api/server/srv-1/sessions') return sessionList();
    if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
    return {};
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App shell', () => {
  it('keeps Safari viewport height bounded and corrects it on visual viewport scrolling', async () => {
    const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const originalClientHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'clientHeight');
    const visualViewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    visualViewport.height = 1_100;
    visualViewport.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(document.documentElement, 'clientHeight', {
      configurable: true,
      value: 780,
    });

    let view: ReturnType<typeof render> | null = null;
    try {
      const { App } = await importApp();
      view = render(<App />);

      await waitFor(() => {
        expect(document.documentElement.style.getPropertyValue('--vvh')).toBe('780px');
      });

      visualViewport.height = 720;
      visualViewport.dispatchEvent(new Event('scroll'));
      await waitFor(() => {
        expect(document.documentElement.style.getPropertyValue('--vvh')).toBe('720px');
      });
    } finally {
      view?.unmount();
      document.documentElement.style.removeProperty('--vvh');
      document.documentElement.style.removeProperty('--kbh');
      if (originalVisualViewport) Object.defineProperty(window, 'visualViewport', originalVisualViewport);
      else Reflect.deleteProperty(window, 'visualViewport');
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
      if (originalClientHeight) {
        Object.defineProperty(document.documentElement, 'clientHeight', originalClientHeight);
      } else {
        Reflect.deleteProperty(document.documentElement, 'clientHeight');
      }
    }
  }, 20_000);

  it('renders the login page when session verification fails', async () => {
    history.replaceState(
      null,
      '',
      '/#/srv-shared/deck_beta_brain?shared=share-login-route',
    );
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') {
        const { ApiError } = await import('../src/api.js');
        throw new ApiError(401, 'expired');
      }
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('login-page')).toBeTruthy();
    expect(screen.queryByText('remote_desktop.guest.title')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/auth/user/me');
    expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-login-route',
    );
  }, 20_000);

  it('keeps and restores an explicit shared tab across an expired-auth login boundary', async () => {
    history.replaceState(
      null,
      '',
      '/#/srv-shared/deck_beta_brain?shared=share-after-login',
    );
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'user-1',
      baseUrl: 'http://localhost',
    }));
    let sessionVerificationExpired = true;
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') {
        if (sessionVerificationExpired) {
          sessionVerificationExpired = false;
          const { ApiError } = await import('../src/api.js');
          throw new ApiError(401, 'expired');
        }
        return { id: 'user-1' };
      }
      if (path === '/api/server') return { servers: [] };
      return {};
    });
    discoverSharedEntriesMock.mockResolvedValue([]);
    openSharedEntryMock.mockResolvedValue(
      sharedMainOpenResult('share-after-login', 'dispatch-after-login'),
    );

    const { App } = await importApp();
    render(<App />);

    const login = await screen.findByRole('button', { name: 'login-page' });
    expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-after-login',
    );
    expect(openSharedEntryMock).not.toHaveBeenCalled();

    fireEvent.click(login);

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));
    expect(openSharedEntryMock).toHaveBeenCalledWith({
      kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain',
    });
    expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
    expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-after-login',
    );
    expect(screen.queryByText('dashboard-page')).toBeNull();
  }, 20_000);

  it('ignores a stale logged-out mount verification failure after a fresh login', async () => {
    history.replaceState(
      null,
      '',
      '/#/srv-shared/deck_beta_brain?shared=share-login-race',
    );
    let rejectInitialVerification!: (reason: unknown) => void;
    const initialVerification = new Promise<never>((_resolve, reject) => {
      rejectInitialVerification = reject;
    });
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return initialVerification;
      if (path === '/api/server') return { servers: [] };
      return {};
    });
    discoverSharedEntriesMock.mockResolvedValue([]);
    openSharedEntryMock.mockResolvedValue(
      sharedMainOpenResult('share-login-race', 'dispatch-login-race'),
    );

    const { App } = await importApp();
    render(<App />);

    const login = await screen.findByRole('button', { name: 'login-page' });
    expect(openSharedEntryMock).not.toHaveBeenCalled();
    fireEvent.click(login);

    const { ApiError } = await import('../src/api.js');
    await act(async () => {
      rejectInitialVerification(new ApiError(401, 'stale logged-out verification'));
      await Promise.resolve();
    });

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('rcc_auth') ?? '{}')).toMatchObject({ userId: 'user-1' });
    expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-login-race',
    );
  }, 20_000);

  it('lets an explicit Web login claim authority before a stale mount verification succeeds', async () => {
    let resolveInitialVerification!: (value: { id: string }) => void;
    const initialVerification = new Promise<{ id: string }>((resolve) => {
      resolveInitialVerification = resolve;
    });
    let resolveWebLogin!: () => void;
    loginAttemptState.mode = 'web';
    loginAttemptState.pending = new Promise<void>((resolve) => {
      resolveWebLogin = resolve;
    });
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return initialVerification;
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    const login = await screen.findByRole('button', { name: 'login-page' });
    fireEvent.click(login);

    // The user-auth attempt claims a new generation synchronously. The older
    // mount verifier must not install its previous-cookie identity even if it
    // resolves before the explicit Web login finishes and reloads.
    await act(async () => {
      resolveInitialVerification({ id: 'stale-cookie-user' });
      await Promise.resolve();
    });
    expect(localStorage.getItem('rcc_auth')).toBeNull();
    expect(loginAttemptState.webReloads).toBe(0);

    await act(async () => {
      resolveWebLogin();
      await Promise.resolve();
    });
    await waitFor(() => expect(loginAttemptState.webReloads).toBe(1));
    expect(localStorage.getItem('rcc_auth')).toBeNull();
    expect(screen.getByRole('button', { name: 'login-page' })).toBeTruthy();
  }, 20_000);

  it('drops a mount verification success that arrives after auth cleanup starts', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'user-1',
      baseUrl: 'http://localhost',
    }));
    let resolveVerification!: (value: { id: string }) => void;
    const verification = new Promise<{ id: string }>((resolve) => {
      resolveVerification = resolve;
    });
    let resolveCredentialCleanup!: () => void;
    let resolveKeyIdCleanup!: () => void;
    clearAuthKeyMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCredentialCleanup = resolve;
    }));
    clearAuthKeyIdMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveKeyIdCleanup = resolve;
    }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return verification;
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') return sessionList();
      return {};
    });

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(authExpiredState.handler).not.toBeNull());

    act(() => authExpiredState.handler?.('expire while mount verification is pending'));
    expect(await screen.findByTestId('auth-credential-cleanup-gate')).toBeTruthy();

    await act(async () => {
      resolveVerification({ id: 'stale-success-user' });
      await Promise.resolve();
    });
    expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
    expect(localStorage.getItem('rcc_auth')).toBeNull();

    await act(async () => {
      resolveCredentialCleanup();
      await Promise.resolve();
    });
    await waitFor(() => expect(clearAuthKeyIdMock).toHaveBeenCalledWith('http://localhost'));
    expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();

    await act(async () => {
      resolveKeyIdCleanup();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'login-page' })).toBeTruthy();
    expect(localStorage.getItem('rcc_auth')).toBeNull();
  }, 20_000);

  it('waits for an invalidated in-flight LoginPage attempt before deleting old credentials', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return new Promise(() => {});
      return {};
    });
    let resolveLoginAttempt!: () => void;
    loginAttemptState.pending = new Promise<void>((resolve) => {
      resolveLoginAttempt = resolve;
    });

    const { App } = await importApp();
    render(<App />);
    const login = await screen.findByRole('button', { name: 'login-page' });
    fireEvent.click(login);
    await waitFor(() => expect(authExpiredState.handler).not.toBeNull());

    act(() => authExpiredState.handler?.('cleanup during active login attempt'));
    expect(await screen.findByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(clearAuthKeyMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoginAttempt();
      await Promise.resolve();
    });
    await waitFor(() => expect(clearAuthKeyMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'login-page' })).toBeTruthy();
    expect(localStorage.getItem('rcc_auth')).toBeNull();
  }, 20_000);

  it('keeps login gated until overlapping auth cleanups finish out of order', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'user-1',
      baseUrl: 'http://localhost',
    }));
    let resolveFirstCleanup!: () => void;
    let resolveSecondCleanup!: () => void;
    clearAuthKeyMock
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstCleanup = resolve;
      }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveSecondCleanup = resolve;
      }));

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(authExpiredState.handler).not.toBeNull());
    act(() => {
      authExpiredState.handler?.('first overlapping cleanup');
      authExpiredState.handler?.('second overlapping cleanup');
    });
    await waitFor(() => expect(clearAuthKeyMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('auth-credential-cleanup-gate')).toBeTruthy();

    await act(async () => {
      resolveSecondCleanup();
      await Promise.resolve();
    });
    expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();

    await act(async () => {
      resolveFirstCleanup();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'login-page' })).toBeTruthy();
    expect(clearAuthKeyIdMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('waits for an active native login and preserves its credentials before changing server', async () => {
    nativeState.value = true;
    getServerUrlMock.mockResolvedValue('https://old-server.example');
    let resolveLoginAttempt!: () => void;
    loginAttemptState.pending = new Promise<void>((resolve) => {
      resolveLoginAttempt = resolve;
    });
    let resolveServerCleanup!: () => void;
    clearServerUrlMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveServerCleanup = resolve;
    }));

    const { App } = await importApp();
    render(<App />);

    const login = await screen.findByRole('button', { name: 'login-page' });
    fireEvent.click(login);
    fireEvent.click(screen.getByRole('button', { name: 'change-server' }));

    expect(await screen.findByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(clearAuthKeyMock).not.toHaveBeenCalled();
    expect(clearAuthKeyIdMock).not.toHaveBeenCalled();
    expect(clearServerUrlMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoginAttempt();
      await Promise.resolve();
    });
    await waitFor(() => expect(clearServerUrlMock).toHaveBeenCalledTimes(1));
    expect(clearAuthKeyMock).not.toHaveBeenCalled();
    expect(clearAuthKeyIdMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('rcc_auth')).toBeNull();
    expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();

    await act(async () => {
      resolveServerCleanup();
      await Promise.resolve();
    });
    expect(await screen.findByText('server-setup-page')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
    expect(localStorage.getItem('rcc_auth')).toBeNull();
    expect(sessionStorage.getItem('rcc_tab_route_v1')).toBeNull();
  }, 20_000);

  it('keeps authenticated native server switching gated through server cleanup', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    nativeState.value = true;
    getServerUrlMock.mockResolvedValue('https://old-server.example');
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'user-1',
      baseUrl: 'https://old-server.example',
    }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    let resolveServerCleanup!: () => void;
    clearServerUrlMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveServerCleanup = resolve;
    }));

    try {
      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(initializeServerScopedAuthMock).toHaveBeenCalledWith(
        'https://old-server.example',
      ));
      await waitFor(() => expect(document.querySelector('.mobile-server-btn')).toBeTruthy());
      fireEvent.click(document.querySelector('.mobile-server-btn')!);
      fireEvent.click(await screen.findByText('⇄ Switch Cloud Server'));

      await waitFor(() => expect(clearServerUrlMock).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
      expect(localStorage.getItem('rcc_auth')).toBeNull();
      expect(sessionStorage.getItem('rcc_tab_route_v1')).toBeNull();
      expect(clearAuthKeyMock).not.toHaveBeenCalled();
      expect(clearAuthKeyIdMock).not.toHaveBeenCalled();

      await act(async () => {
        resolveServerCleanup();
        await Promise.resolve();
      });
      expect(await screen.findByText('server-setup-page')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
    }
  }, 20_000);

  it('restores the selected native Cloud Server with its isolated saved session', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    nativeState.value = true;
    getServerUrlMock.mockResolvedValue('https://old-server.example');
    getAuthKeyMock.mockImplementation(async (serverUrl?: string) => (
      serverUrl === 'https://new-server.example' ? 'new-server-key' : null
    ));
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'old-user',
      baseUrl: 'https://old-server.example',
    }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') {
        const activeKey = configureApiKeyMock.mock.calls.at(-1)?.[0];
        return { id: activeKey === 'new-server-key' ? 'new-user' : 'old-user' };
      }
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') return sessionList();
      return {};
    });

    try {
      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(document.querySelector('.mobile-server-btn')).toBeTruthy());
      fireEvent.click(document.querySelector('.mobile-server-btn')!);
      fireEvent.click(await screen.findByText('⇄ Switch Cloud Server'));
      const setup = await screen.findByRole('button', { name: 'server-setup-page' });

      expect(clearAuthKeyMock).not.toHaveBeenCalled();
      expect(clearAuthKeyIdMock).not.toHaveBeenCalled();
      fireEvent.click(setup);

      await waitFor(() => expect(getAuthKeyMock).toHaveBeenCalledWith('https://new-server.example'));
      await waitFor(() => expect(configureApiKeyMock).toHaveBeenCalledWith('new-server-key'));
      await waitFor(() => {
        expect(JSON.parse(localStorage.getItem('rcc_auth') ?? '{}')).toEqual({
          userId: 'new-user',
          baseUrl: 'https://new-server.example',
        });
      });
      expect(await screen.findByTestId('session-pane-deck_alpha_brain')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
      expect(clearAuthKeyMock).not.toHaveBeenCalled();
      expect(clearAuthKeyIdMock).not.toHaveBeenCalled();
      expect(apiFetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/auth/user/me/keys/'),
        expect.anything(),
      );
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
    }
  }, 20_000);

  it('deletes only the selected Cloud Server credential after an authoritative restore 401', async () => {
    nativeState.value = true;
    getServerUrlMock.mockResolvedValue(null);
    getAuthKeyMock.mockImplementation(async (serverUrl?: string) => (
      serverUrl === 'https://new-server.example' ? 'expired-server-key' : null
    ));
    const { ApiError } = await import('../src/api.js');
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me' && configureApiKeyMock.mock.calls.at(-1)?.[0] === 'expired-server-key') {
        // Match the production Bearer flow: apiFetch announces expiry before
        // its rejected Promise reaches connectNativeServer's catch block.
        authExpiredState.handler?.('selected server credential expired');
        throw new ApiError(401, 'session_expired');
      }
      if (path === '/api/auth/user/me') return new Promise(() => {});
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    const setup = await screen.findByRole('button', { name: 'server-setup-page' });
    await waitFor(() => expect(authExpiredState.handler).not.toBeNull());
    fireEvent.click(setup);

    await waitFor(() => expect(clearAuthKeyMock).toHaveBeenCalledWith('https://new-server.example'));
    await waitFor(() => expect(clearAuthKeyIdMock).toHaveBeenCalledWith('https://new-server.example'));
    expect(await screen.findByRole('button', { name: 'login-page' })).toBeTruthy();
    expect(clearAuthKeyMock).not.toHaveBeenCalledWith('https://other-server.example');
    expect(clearAuthKeyIdMock).not.toHaveBeenCalledWith('https://other-server.example');
    expect(localStorage.getItem('rcc_auth')).toBeNull();
  }, 20_000);

  it('revokes and deletes only the active Cloud Server credential on explicit logout', async () => {
    nativeState.value = true;
    getServerUrlMock.mockResolvedValue('https://active-server.example');
    getAuthKeyIdMock.mockResolvedValue('active-key-id');
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'active-user',
      baseUrl: 'https://active-server.example',
    }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'active-user' };
      if (path === '/api/server') return { servers: [] };
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    fireEvent.click(await screen.findByText('Log Out'));

    await waitFor(() => expect(getAuthKeyIdMock).toHaveBeenCalledWith(
      'https://active-server.example',
    ));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/auth/user/me/keys/active-key-id',
      { method: 'DELETE' },
    ));
    expect(clearAuthKeyMock).toHaveBeenCalledWith('https://active-server.example');
    expect(clearAuthKeyIdMock).toHaveBeenCalledWith('https://active-server.example');
    expect(clearAuthKeyMock).not.toHaveBeenCalledWith('https://other-server.example');
    expect(clearAuthKeyIdMock).not.toHaveBeenCalledWith('https://other-server.example');
    expect(await screen.findByRole('button', { name: 'login-page' })).toBeTruthy();
  }, 20_000);

  it('clears stale shared session authority until re-open succeeds after auth expiry', async () => {
    history.replaceState(
      null,
      '',
      '/#/srv-shared/deck_beta_brain?shared=share-auth-expiry',
    );
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'user-1',
      baseUrl: 'http://localhost',
    }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return { servers: [] };
      return {};
    });
    discoverSharedEntriesMock.mockResolvedValue([]);

    let resolveReauthorizedOpen!: (value: ReturnType<typeof sharedMainOpenResult>) => void;
    openSharedEntryMock
      .mockResolvedValueOnce(sharedMainOpenResult('share-auth-expiry', 'dispatch-old-identity'))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveReauthorizedOpen = resolve;
      }));

    const { App } = await importApp();
    render(<App />);

    const oldPane = await screen.findByTestId('session-pane-deck_beta_brain');
    expect(oldPane.getAttribute('data-active-dispatch-id')).toBe('dispatch-old-identity');
    expect(openSharedEntryMock).toHaveBeenCalledTimes(1);
    expect(authExpiredState.handler).not.toBeNull();

    act(() => authExpiredState.handler?.('expired during shared session'));

    const login = await screen.findByRole('button', { name: 'login-page' });
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-auth-expiry',
    );
    expect(openSharedEntryMock).toHaveBeenCalledTimes(1);
    expect(wsInstances.filter((instance) => instance.options?.shareTarget && instance.connected)).toHaveLength(0);

    loginState.userId = 'user-2';
    fireEvent.click(login);

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    expect(wsInstances.filter((instance) => instance.options?.shareTarget && instance.connected)).toHaveLength(0);

    await act(async () => {
      resolveReauthorizedOpen(sharedMainOpenResult('share-auth-expiry', 'dispatch-new-identity'));
      await Promise.resolve();
    });

    const newPane = await screen.findByTestId('session-pane-deck_beta_brain');
    expect(newPane.getAttribute('data-active-dispatch-id')).toBe('dispatch-new-identity');
    expect(openSharedEntryMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem('rcc_auth') ?? '{}')).toMatchObject({ userId: 'user-2' });
  }, 20_000);

  it('discards a shared open response that settles after its auth generation expires', async () => {
    history.replaceState(
      null,
      '',
      '/#/srv-shared/deck_beta_brain?shared=share-stale-open',
    );
    localStorage.setItem('rcc_auth', JSON.stringify({
      userId: 'user-1',
      baseUrl: 'http://localhost',
    }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return { servers: [] };
      return {};
    });
    discoverSharedEntriesMock.mockResolvedValue([]);
    let resolveOldOpen!: (value: ReturnType<typeof sharedMainOpenResult>) => void;
    let resolveCredentialCleanup!: () => void;
    let resolveKeyIdCleanup!: () => void;
    openSharedEntryMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldOpen = resolve;
    }));
    clearAuthKeyMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCredentialCleanup = resolve;
    }));
    clearAuthKeyIdMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveKeyIdCleanup = resolve;
    }));

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));
    expect(authExpiredState.handler).not.toBeNull();
    act(() => authExpiredState.handler?.('expired with open in flight'));
    // clearAuthState is still blocked on credential I/O. The generation fence
    // and old-authority UI revocation must already be effective synchronously,
    // while fresh login stays unavailable until the unconditional deletion ends.
    await waitFor(() => expect(clearAuthKeyMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();

    await act(async () => {
      resolveOldOpen(sharedMainOpenResult('share-stale-open', 'dispatch-must-not-render'));
      await Promise.resolve();
    });

    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();
    expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-stale-open',
    );
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    expect(readSharedTabRestoreMarker()).toBeNull();
    expect(wsInstances.filter((instance) => instance.options?.shareTarget && instance.connected)).toHaveLength(0);

    await act(async () => {
      resolveCredentialCleanup();
      await Promise.resolve();
    });
    await waitFor(() => expect(clearAuthKeyIdMock).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost'),
    ));
    expect(screen.getByTestId('auth-credential-cleanup-gate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'login-page' })).toBeNull();

    await act(async () => {
      resolveKeyIdCleanup();
      await Promise.resolve();
    });
    const login = await screen.findByRole('button', { name: 'login-page' });
    expect(screen.queryByTestId('auth-credential-cleanup-gate')).toBeNull();
    fireEvent.click(login);
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('rcc_auth') ?? '{}')).toMatchObject({
        userId: 'user-1',
      });
    });
    expect(clearAuthKeyMock).toHaveBeenCalledTimes(1);
    expect(clearAuthKeyIdMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('loads servers and renders the dashboard when no server is selected', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return { servers: [] };
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('dashboard-page')).toBeTruthy();
    expect(fetchMeMock).toHaveBeenCalled();
  }, 20_000);

  it('lets a mobile admin open navigation and the admin page without an associated server', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/auth/user/me') return { id: 'user-1' };
        if (path === '/api/server') return { servers: [] };
        return {};
      });

      const { App } = await importApp();
      const view = render(<App />);

      expect(await screen.findByText('dashboard-page')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'sidebar.expand' }));
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-overlay.open')).toBeTruthy());
      expect(screen.queryByTitle('sharedContext.management.title')).toBeNull();
      expect(screen.queryByTitle('Server bar')).toBeNull();
      expect(screen.queryByTitle('Session tabs')).toBeNull();
      expect(screen.queryByText('session-tree')).toBeNull();
      fireEvent.click(screen.getByTitle('admin.title'));

      expect(await screen.findByText('admin-page')).toBeTruthy();
      const overlay = screen.getByTestId('admin-page-overlay');
      expect(overlay.style.display).toBe('flex');
      expect(overlay.style.height).toBe('100dvh');
      expect(overlay.style.overflow).toBe('hidden');
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('lets a mobile user with no owned server open a shared session from the main shell', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const sharedEntry = {
      id: 'share-zero-owned',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant' as const,
      status: 'active' as const,
      target: { kind: 'main' as const, serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
      targetLabel: 'Shared Beta',
    };

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/auth/user/me') return { id: 'user-1' };
        if (path === '/api/server') return { servers: [] };
        return {};
      });
      discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
      openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-zero-owned', 'dispatch-zero-owned'));

      const { App } = await importApp();
      const view = render(<App />);

      expect(await screen.findByText('dashboard-page')).toBeTruthy();
      await waitFor(() => expect(screen.getByTestId('dashboard-shared-count').textContent).toBe('1'));
      fireEvent.click(screen.getByRole('button', { name: 'sidebar.expand' }));
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-overlay.open')).toBeTruthy());
      expect(view.container.querySelector('.mobile-sidebar-body')?.scrollHeight).toBeGreaterThanOrEqual(0);
      fireEvent.click(screen.getByText('Shared Beta'));

      await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledWith(sharedEntry.target));
      expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
      expect(screen.queryByText('dashboard-page')).toBeNull();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('keeps the admin entry in mobile navigation when a server is selected', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');

      const { App } = await importApp();
      const view = render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      fireEvent.click(view.container.querySelector('.mobile-sidebar-toggle')!);
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-overlay.open')).toBeTruthy());
      expect(screen.getByTitle('admin.title')).toBeTruthy();
      expect(screen.getByTitle('sharedContext.management.title')).toBeTruthy();
      expect(screen.getByText('session-tree')).toBeTruthy();
      fireEvent.click(screen.getByTitle('admin.title'));
      expect(await screen.findByText('admin-page')).toBeTruthy();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('connects the selected server, merges session_list, and renders the session shell', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    const view = render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const ws = wsInstances[0];

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    expect(view.container.textContent).toContain('session-pane:deck_alpha_brain');
    expect(view.container.textContent).toContain('session-tree');
    expect(screen.getByRole('button', { name: 'sharedContext.management.title' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sharedContext.diagnostics.title' })).toBeNull();
    expect(ws.connect).toHaveBeenCalled();
    expect(screen.getByText('featureAnnouncements.messagePins')).toBeTruthy();
    fireEvent.click(screen.getByText('featureAnnouncements.dismiss'));
    await waitFor(() => expect(screen.queryByTestId('feature-announcement')).toBeNull());
  }, 20_000);

  it('defaults the vertical rail right, persists both dock sides, and keeps each as a root flex child', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    const view = render(<App />);
    const toggle = await screen.findByTestId('app-shell-subsession-layout-toggle');
    expect(screen.getByTestId('app-shell-subsession-bar').dataset.desktopLayout).toBe('horizontal');

    fireEvent.click(toggle);

    let host = await screen.findByTestId('subsession-vertical-rail-host');
    expect(await screen.findByTestId('app-shell-subsession-vertical-rail')).toBeTruthy();
    let layout = host.parentElement!;
    let children = Array.from(layout.children);
    expect(host.dataset.dockSide).toBe(SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT);
    expect(children.indexOf(layout.querySelector('.main')!)).toBeLessThan(children.indexOf(host));
    expect(JSON.parse(localStorage.getItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1,
      layout: SUBSESSION_DESKTOP_LAYOUT.VERTICAL,
    });
    expect(localStorage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByTestId('app-shell-subsession-dock-left'));
    await waitFor(() => expect(screen.getByTestId('subsession-vertical-rail-host').dataset.dockSide)
      .toBe(SUBSESSION_DESKTOP_DOCK_SIDE.LEFT));
    host = screen.getByTestId('subsession-vertical-rail-host');
    layout = host.parentElement!;
    children = Array.from(layout.children);
    expect(children.indexOf(screen.getByTestId('sidebar-panel'))).toBeLessThan(children.indexOf(host));
    expect(children.indexOf(host)).toBeLessThan(children.indexOf(layout.querySelector('.main')!));
    expect(JSON.parse(localStorage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY)!)).toEqual({
      version: 1,
      side: SUBSESSION_DESKTOP_DOCK_SIDE.LEFT,
    });

    view.unmount();
    render(<App />);
    host = await screen.findByTestId('subsession-vertical-rail-host');
    expect(host.dataset.dockSide).toBe(SUBSESSION_DESKTOP_DOCK_SIDE.LEFT);
    expect(screen.getByTestId('app-shell-subsession-bar').dataset.desktopLayout).toBe('vertical');

    fireEvent.click(screen.getByTestId('app-shell-subsession-dock-right'));
    await waitFor(() => expect(screen.getByTestId('subsession-vertical-rail-host').dataset.dockSide)
      .toBe(SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT));
    host = screen.getByTestId('subsession-vertical-rail-host');
    layout = host.parentElement!;
    children = Array.from(layout.children);
    expect(children.indexOf(layout.querySelector('.main')!)).toBeLessThan(children.indexOf(host));
    expect(JSON.parse(localStorage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY)!)).toEqual({
      version: 1,
      side: SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT,
    });
  }, 20_000);

  it('defaults Team discussions right at low height, then preserves a manual bottom choice', async () => {
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 640 });
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    try {
      const { App } = await importApp();
      const view = render(<App />);
      const ws = await getActiveWsClient();
      await act(async () => {
        ws.emit({
          type: P2P_WORKFLOW_MSG.RUN_UPDATE,
          run: {
            id: 'run-team-rail',
            status: 'running',
            current_round: 1,
            total_rounds: 2,
            total_hops: 2,
            active_phase: 'hop',
            initiator_session: 'deck_alpha_brain',
          },
        });
      });

      let host = await screen.findByTestId('team-discussion-rail-host');
      expect(await screen.findByTestId('app-shell-team-discussion-rail')).toBeTruthy();
      expect(screen.getByTestId('app-shell-subsession-bar').dataset.teamDiscussionLayout)
        .toBe(TEAM_DISCUSSION_LAYOUT.RIGHT);
      expect(localStorage.getItem(TEAM_DISCUSSION_LAYOUT_STORAGE_KEY)).toBeNull();
      const layout = host.parentElement!;
      expect(Array.from(layout.children).indexOf(layout.querySelector('.main')!))
        .toBeLessThan(Array.from(layout.children).indexOf(host));

      fireEvent.click(screen.getByTestId('app-shell-team-discussion-bottom'));
      await waitFor(() => expect(screen.queryByTestId('team-discussion-rail-host')).toBeNull());
      expect(JSON.parse(localStorage.getItem(TEAM_DISCUSSION_LAYOUT_STORAGE_KEY)!)).toEqual({
        version: 1,
        layout: TEAM_DISCUSSION_LAYOUT.BOTTOM,
      });

      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 500 });
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(screen.getByTestId('app-shell-subsession-bar').dataset.teamDiscussionLayout)
        .toBe(TEAM_DISCUSSION_LAYOUT.BOTTOM));

      view.unmount();
      render(<App />);
      const refreshedWs = await getActiveWsClient();
      await act(async () => {
        refreshedWs.emit({
          type: P2P_WORKFLOW_MSG.RUN_UPDATE,
          run: {
            id: 'run-team-rail-refresh',
            status: 'running',
            current_round: 1,
            total_rounds: 1,
            total_hops: 1,
            initiator_session: 'deck_alpha_brain',
          },
        });
      });
      await screen.findByTestId('app-shell-p2p-discussion-p2p_run-team-rail-refresh');
      expect(screen.queryByTestId('team-discussion-rail-host')).toBeNull();
      expect(screen.getByTestId('app-shell-subsession-bar').dataset.teamDiscussionLayout)
        .toBe(TEAM_DISCUSSION_LAYOUT.BOTTOM);
    } finally {
      if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
    }
  }, 20_000);

  it('keeps the saved desktop rail preference untouched while mobile uses its original layout', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    const saved = JSON.stringify({ version: 1, layout: SUBSESSION_DESKTOP_LAYOUT.VERTICAL });
    const savedDockSide = JSON.stringify({ version: 1, side: SUBSESSION_DESKTOP_DOCK_SIDE.LEFT });
    localStorage.setItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY, saved);
    localStorage.setItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY, savedDockSide);
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    try {
      const { App } = await importApp();
      render(<App />);
      await screen.findByTestId('app-shell-subsession-bar');

      expect(screen.queryByTestId('app-shell-subsession-layout-toggle')).toBeNull();
      expect(screen.queryByTestId('subsession-vertical-rail-host')).toBeNull();
      expect(screen.queryByTestId('app-shell-subsession-vertical-rail')).toBeNull();
      expect(localStorage.getItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY)).toBe(saved);
      expect(localStorage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY)).toBe(savedDockSide);
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('restores the task panel open state and persists close and toggle changes across refreshes', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      open: true,
      width: 584,
    }));

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByRole('complementary', { name: 'supervision_task_console.title' })).toBeTruthy();
    const close = screen.getByRole('button', { name: 'common.close' });
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'supervision_task_console.title' })).toBeNull());
    expect(JSON.parse(localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!).open).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: 'supervision_task_console.toggle' })[0]!);
    expect(await screen.findByRole('complementary', { name: 'supervision_task_console.title' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!).open).toBe(true);
  }, 20_000);

  it('opens the session named by an all-pins navigation request', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') {
        return {
          sessions: [
            ...sessionList().sessions,
            { ...sessionList().sessions[0], name: 'deck_beta_brain', project_name: 'Beta', label: 'Beta Brain' },
          ],
        };
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    const { App } = await importApp();
    const view = render(<App />);
    await waitFor(() => expect(view.container.textContent).toContain('session-pane:deck_alpha_brain'));

    const { requestMessagePinNavigation } = await import('../src/message-pin-navigation.js');
    act(() => requestMessagePinNavigation({
      id: 'pin-beta',
      serverId: 'srv-1',
      sessionName: 'deck_beta_brain',
      eventId: 'event-beta',
      eventTs: 123,
      eventType: 'assistant.text',
      text: 'Pinned in Beta',
      createdAt: 123,
      updatedAt: 123,
    }));

    await waitFor(() => expect(view.container.textContent).toContain('session-pane:deck_beta_brain'));
  }, 20_000);

  it('opens the sub-session window named by an all-pins navigation request', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [{
      id: 'sub-1',
      sessionName: 'deck_sub_alpha_helper',
      parentSession: 'deck_alpha_brain',
      label: 'Helper',
      description: 'Helper session',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(wsInstances.length).toBe(1));

    const { requestMessagePinNavigation } = await import('../src/message-pin-navigation.js');
    act(() => requestMessagePinNavigation({
      id: 'pin-sub',
      serverId: 'srv-1',
      sessionName: 'deck_sub_alpha_helper',
      eventId: 'event-sub',
      eventTs: 123,
      eventType: 'user.message',
      text: 'Pinned in Helper',
      createdAt: 123,
      updatedAt: 123,
    }));

    expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();
  }, 20_000);

  it('fronts an already-open sub-session selected from another window pin list', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-2',
        sessionName: 'deck_sub_alpha_reviewer',
        parentSession: 'deck_alpha_brain',
        label: 'Reviewer',
        description: 'Reviewer session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(wsInstances.length).toBe(1));

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    const first = await screen.findByTestId('sub-session-window-sub-1');
    fireEvent.click(screen.getByText('subbar-open-sub-2'));
    const second = await screen.findByTestId('sub-session-window-sub-2');
    await waitFor(() => expect(second.getAttribute('data-active')).toBe('true'));

    const { requestMessagePinNavigation } = await import('../src/message-pin-navigation.js');
    act(() => requestMessagePinNavigation({
      id: 'pin-sub-front',
      serverId: 'srv-1',
      sessionName: 'deck_sub_alpha_helper',
      eventId: 'event-sub-front',
      eventTs: 123,
      eventType: 'assistant.text',
      text: 'Pinned in the background helper window',
      createdAt: 123,
      updatedAt: 123,
    }));

    await waitFor(() => {
      const firstNow = screen.getByTestId('sub-session-window-sub-1');
      const secondNow = screen.getByTestId('sub-session-window-sub-2');
      expect(firstNow.getAttribute('data-active')).toBe('true');
      expect(secondNow.getAttribute('data-active')).toBe('false');
      expect(Number((firstNow as HTMLElement).style.zIndex)).toBeGreaterThan(Number((secondNow as HTMLElement).style.zIndex));
    });
  }, 20_000);

  it('hides the source sub-session when its pin list navigates to a main session', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [{
      id: 'sub-1',
      sessionName: 'deck_sub_alpha_helper',
      parentSession: 'deck_alpha_brain',
      label: 'Helper',
      description: 'Helper session',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(wsInstances.length).toBe(1));

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();
    fireEvent.click(screen.getByText('pane-chat-ref'));
    chatScrollMock.mockClear();

    const { requestMessagePinNavigation } = await import('../src/message-pin-navigation.js');
    act(() => requestMessagePinNavigation({
      id: 'pin-main-from-sub',
      serverId: 'srv-1',
      sessionName: 'deck_alpha_brain',
      eventId: 'event-main-from-sub',
      eventTs: 123,
      eventType: 'assistant.text',
      text: 'Pinned in the parent main session',
      createdAt: 123,
      updatedAt: 123,
    }, 'deck_sub_alpha_helper'));

    await waitFor(() => {
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();
      expect(screen.getByTestId('session-pane-deck_alpha_brain')).toBeTruthy();
      expect(chatScrollMock).not.toHaveBeenCalled();
    });
  }, 20_000);

  it('opens controlled-node management above sub-session windows and re-fronts it from the sidebar', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-1']));
    useSubSessionsState.subSessions = [{
      id: 'sub-1',
      sessionName: 'deck_sub_alpha_helper',
      parentSession: 'deck_alpha_brain',
      label: 'Helper',
      description: 'Helper session',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const subWindow = await screen.findByTestId('sub-session-window-sub-1');
    fireEvent.click(await screen.findByText('controlled_nodes.title'));

    const panel = await screen.findByTestId('floating-panel-controlled-nodes');
    expect(panel.textContent).toContain('controlled-nodes-panel');
    const panelZ = () => Number((panel as HTMLElement).style.zIndex);
    const subZ = () => Number((subWindow as HTMLElement).style.zIndex);

    await waitFor(() => expect(panelZ()).toBeGreaterThan(subZ()));

    fireEvent.mouseDown(subWindow);
    await waitFor(() => expect(subZ()).toBeGreaterThan(panelZ()));

    fireEvent.click(screen.getByText('controlled_nodes.title'));
    await waitFor(() => expect(panelZ()).toBeGreaterThan(subZ()));

    fireEvent.click(screen.getByText('controlled-nodes-panel'));
    expect(await screen.findByText('remote-desktop-workspace')).toBeTruthy();

    const closeControlledNodes = Array.from(panel.querySelectorAll('button'))
      .find((button) => button.textContent === 'floating-close');
    expect(closeControlledNodes).toBeTruthy();
    fireEvent.click(closeControlledNodes!);
    await waitFor(() => expect(screen.queryByTestId('floating-panel-controlled-nodes')).toBeNull());
    expect(screen.getByText('remote-desktop-workspace')).toBeTruthy();
    expect(screen.getByText('remote-desktop-minimized:false')).toBeTruthy();
    fireEvent.click(screen.getByText('remote-desktop-minimize'));
    expect(await screen.findByText('remote-desktop-minimized:true')).toBeTruthy();
    fireEvent.click(screen.getByText('remote-desktop-restore'));
    expect(await screen.findByText('remote-desktop-minimized:false')).toBeTruthy();
  }, 20_000);

  it('keeps mobile remote desktop workspace above earlier floating surfaces', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');

      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      fireEvent.click(screen.getByText('subbar-discussions'));
      const discussionsPanel = await screen.findByTestId('floating-panel-discussions');
      fireEvent.click(document.querySelector('.mobile-server-btn')!);
      fireEvent.click(await screen.findByText('controlled_nodes.title'));
      expect(await screen.findByTestId('floating-panel-controlled-nodes')).toBeTruthy();
      fireEvent.click(screen.getByText('controlled-nodes-panel'));
      const remoteDesktop = await screen.findByTestId('remote-desktop-workspace');

      await waitFor(() => {
        expect(screen.queryByTestId('floating-panel-controlled-nodes')).toBeNull();
        const remoteZ = Number((remoteDesktop as HTMLElement).style.zIndex);
        expect(remoteZ).toBeGreaterThan(Number((discussionsPanel as HTMLElement).style.zIndex));
      });
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('keeps mobile remote desktop wall above earlier floating surfaces', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');

      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      fireEvent.click(screen.getByText('subbar-discussions'));
      const discussionsPanel = await screen.findByTestId('floating-panel-discussions');
      fireEvent.click(document.querySelector('.mobile-server-btn')!);
      fireEvent.click(await screen.findByText('controlled_nodes.title'));
      expect(await screen.findByTestId('floating-panel-controlled-nodes')).toBeTruthy();
      fireEvent.click(screen.getByText('controlled-nodes-wall'));
      const wall = await screen.findByTestId('remote-desktop-wall');

      await waitFor(() => {
        expect(screen.queryByTestId('floating-panel-controlled-nodes')).toBeNull();
        const wallZ = Number((wall as HTMLElement).style.zIndex);
        expect(wallZ).toBeGreaterThan(Number((discussionsPanel as HTMLElement).style.zIndex));
      });
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('hides mobile chat chrome while remote desktop or wall is the active full-screen surface', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');
      useSubSessionsState.subSessions = [
        {
          id: 'sub-1',
          sessionName: 'deck_sub_alpha_helper',
          parentSession: 'deck_alpha_brain',
          label: 'Helper',
          description: 'Helper session',
          cwd: '/work/alpha',
          type: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
          serverId: 'srv-1',
        },
      ];
      useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

      const { App } = await importApp();
      const view = render(<App />);
      const layout = () => view.container.querySelector('.layout') as HTMLElement;

      await waitFor(() => expect(wsInstances.length).toBe(1));
      expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(false);
      fireEvent.click(screen.getByText('subbar-open-sub-1'));
      const subWindow = await screen.findByTestId('sub-session-window-sub-1');

      fireEvent.click(document.querySelector('.mobile-server-btn')!);
      fireEvent.click(await screen.findByText('controlled_nodes.title'));
      fireEvent.click(screen.getByText('controlled-nodes-panel'));
      const remoteDesktop = await screen.findByTestId('remote-desktop-workspace');

      await waitFor(() => {
        expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(true);
        expect(screen.queryByTestId('floating-panel-controlled-nodes')).toBeNull();
        expect((subWindow.closest('[data-subsession-retained]') as HTMLElement)?.style.display).toBe('none');
        expect(Number((remoteDesktop as HTMLElement).style.zIndex)).toBeGreaterThan(Number((subWindow as HTMLElement).style.zIndex));
      });

      fireEvent.click(screen.getByText('remote-desktop-minimize'));
      await waitFor(() => {
        expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(false);
        expect((subWindow.closest('[data-subsession-retained]') as HTMLElement)?.style.display).toBe('contents');
      });
      fireEvent.click(screen.getByText('remote-desktop-restore'));
      await waitFor(() => {
        expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(true);
        expect((subWindow.closest('[data-subsession-retained]') as HTMLElement)?.style.display).toBe('none');
      });
      fireEvent.click(screen.getByText('remote-desktop-close'));
      await waitFor(() => {
        expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(false);
        expect((subWindow.closest('[data-subsession-retained]') as HTMLElement)?.style.display).toBe('contents');
      });

      fireEvent.click(document.querySelector('.mobile-server-btn')!);
      fireEvent.click(await screen.findByText('controlled_nodes.title'));
      fireEvent.click(screen.getByText('controlled-nodes-wall'));
      const wall = await screen.findByTestId('remote-desktop-wall');
      await waitFor(() => {
        expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(true);
        expect(screen.queryByTestId('floating-panel-controlled-nodes')).toBeNull();
        expect((subWindow.closest('[data-subsession-retained]') as HTMLElement)?.style.display).toBe('none');
        expect(Number((wall as HTMLElement).style.zIndex)).toBeGreaterThan(Number((subWindow as HTMLElement).style.zIndex));
      });
      fireEvent.click(screen.getByText('remote-desktop-wall-close'));
      await waitFor(() => expect(layout().classList.contains('layout-mobile-remote-surface-active')).toBe(false));

      const css = readFileSync(process.cwd().split(/[\\/]/).pop() === 'web' ? 'src/styles.css' : 'web/src/styles.css', 'utf8');
      expect(css).toMatch(/\.layout-mobile\.layout-mobile-remote-surface-active\s*>\s*\.main\s*{[^}]*display:\s*none/s);
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('opens remote control from the sidebar chevron without opening node management', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(wsInstances.length).toBe(1));

    fireEvent.click(await screen.findByTestId('controlled-node-quick-trigger'));
    expect(await screen.findByText('remote-desktop-workspace')).toBeTruthy();
    expect(screen.queryByTestId('floating-panel-controlled-nodes')).toBeNull();
  }, 20_000);

  it('puts remote control in the desktop toolbar, not only on mobile', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    const view = render(<App />);
    const ws = await getActiveWsClient();

    const toolbar = () => view.container.querySelector('.desktop-view-toggle');
    await waitFor(() => expect(toolbar()).toBeTruthy());
    // Nothing claimed yet, so nothing offered.
    expect(toolbar()!.querySelector('.daemon-remote-desktop-btn')).toBeNull();

    await act(async () => {
      // An offline daemon offers nothing, so it has to be heard from first.
      ws.emit({
        type: 'daemon.stats',
        daemonVersion: '2026.8.1',
        cpu: 1, memUsed: 1, memTotal: 2, load1: 0, load5: 0, load15: 0, uptime: 10,
      });
      ws.emitDaemonCapabilities([
        'remote.desktop.windows.installable.v1',
        'remote.desktop.windows.h264.v2',
      ]);
    });

    // The desktop layout has no daemon status bar at all, so without this the
    // button existed on mobile only.
    await waitFor(() => expect(toolbar()!.querySelector('.daemon-remote-desktop-btn')).toBeTruthy());
  });

  it('keeps the mobile server menu available on wide-viewport Android browsers', async () => {
    const originalUserAgent = navigator.userAgent;
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android' });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');

      const { App } = await importApp();
      const view = render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      expect(view.container.querySelector('.layout')?.classList.contains('layout-mobile')).toBe(true);
      expect(view.container.querySelector('[title="sharedContext.management.title"]')).toBeTruthy();
      expect(view.container.querySelector('[title="sharedContext.diagnostics.title"]')).toBeNull();
      expect(view.container.textContent).not.toContain('DBG');
      fireEvent.click(view.container.querySelector('.mobile-server-btn')!);

      const controlledNodesButton = await screen.findByRole('button', { name: 'controlled_nodes.title' });
      expect(controlledNodesButton.classList.contains('mobile-server-menu-controlled-nodes')).toBe(true);
      fireEvent.click(controlledNodesButton);

      const panel = await screen.findByTestId('floating-panel-controlled-nodes');
      expect(panel.textContent).toContain('controlled-nodes-panel');
      expect(view.container.querySelector('.mobile-server-menu')).toBeNull();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth });
    }
  }, 20_000);

  it('refreshes the session list when the daemon reconnects behind an open browser socket', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();

    ws.requestSessionList.mockClear();
    await act(async () => {
      ws.emit({ type: 'daemon.reconnected' });
    });

    expect(ws.requestSessionList).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('subscribes sdk sub-sessions to transport live events even when runtimeType is missing', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-sdk',
        sessionName: 'deck_sub_alpha_sdk',
        parentSession: 'deck_alpha_brain',
        label: 'SDK',
        description: 'SDK session',
        cwd: '/work/alpha',
        type: 'claude-code-sdk',
        runtimeType: undefined,
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-process',
        sessionName: 'deck_sub_alpha_process',
        parentSession: 'deck_alpha_brain',
        label: 'Process',
        description: 'Process session',
        cwd: '/work/alpha',
        type: 'claude-code',
        runtimeType: undefined,
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const ws = wsInstances[0];
    expect(await screen.findByText('session-tabs')).toBeTruthy();

    // The production client announces connection asynchronously. The mock's
    // connect() only flips its own field, so drive the app-level connected
    // state explicitly before asserting subscription side effects.
    await act(async () => {
      ws.emit({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
    });

    await waitFor(() => {
      expect(ws.subscribeTransportSession).toHaveBeenCalledWith('deck_sub_alpha_sdk', { replayHistory: false });
    });
    expect(ws.subscribeTransportSession).not.toHaveBeenCalledWith('deck_sub_alpha_process', expect.anything());
  }, 20_000);

  it('keeps cached P2P progress until an explicit status lookup confirms the run is missing', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();

    await act(async () => {
      ws.emit({
        type: P2P_WORKFLOW_MSG.RUN_UPDATE,
        run: {
          id: 'run-status-bar',
          status: 'running',
          mode_key: 'discuss',
          current_round: 1,
          total_rounds: 1,
          total_hops: 2,
          active_phase: 'hop',
          initiator_session: 'deck_alpha_brain',
          all_nodes: [
            { label: 'Cx1', agentType: 'codex-sdk', status: 'completed', phase: 'hop' },
            { label: 'Cu1', agentType: 'cursor-headless', status: 'running', phase: 'hop' },
          ],
        },
      });
    });

    const row = await screen.findByTestId('app-shell-p2p-discussion-p2p_run-status-bar');
    expect(row.getAttribute('data-state')).toBe('running');
    expect(screen.getByTestId('app-shell-p2p-node-p2p_run-status-bar-Cx1').textContent).toBe('Cx1:done');
    expect(screen.getByTestId('app-shell-subsession-bar').getAttribute('data-running-discussions')).toBe('1');

    await act(async () => {
      ws.emit({
        type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
        requestId: 'p2p-status-empty',
        runs: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('app-shell-p2p-discussion-p2p_run-status-bar')).toBeTruthy();
      expect(screen.getByTestId('app-shell-subsession-bar').getAttribute('data-running-discussions')).toBe('1');
    });

    await act(async () => {
      ws.emit({
        type: P2P_WORKFLOW_MSG.STATUS_RESPONSE,
        requestId: 'p2p-status-missing',
        runId: 'run-status-bar',
        run: null,
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('app-shell-p2p-discussion-p2p_run-status-bar')).toBeNull();
      expect(screen.getByTestId('app-shell-subsession-bar').getAttribute('data-running-discussions')).toBe('0');
    });
  }, 20_000);

  it('restores scoped team discussion cards immediately when returning to a main tab before visible sub-sessions refresh', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') {
        return {
          sessions: [
            ...sessionList().sessions,
            { ...sessionList().sessions[0], name: 'deck_beta_brain', project_name: 'Beta', label: 'Beta Brain' },
          ],
        };
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    const alphaSub = {
      id: 'sub-alpha-a1',
      sessionName: 'deck_sub_alpha_a1',
      parentSession: 'deck_alpha_brain',
      label: 'A1',
      description: '',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    };
    const betaSub = {
      id: 'sub-beta-b1',
      sessionName: 'deck_sub_beta_b1',
      parentSession: 'deck_beta_brain',
      label: 'B1',
      description: '',
      cwd: '/work/beta',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    };
    useSubSessionsState.subSessions = [alphaSub, betaSub];
    useSubSessionsState.visibleSubSessions = [alphaSub];

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();
    await act(async () => {
      ws.emit({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
      ws.emit({
        type: P2P_WORKFLOW_MSG.RUN_UPDATE,
        run: {
          id: 'run-alpha-sub-only',
          status: 'running',
          mode_key: 'discuss',
          current_round: 1,
          total_rounds: 1,
          total_hops: 1,
          active_phase: 'hop',
          current_target_session: 'deck_sub_alpha_a1',
          all_nodes: [
            { label: 'A1', agentType: 'codex-sdk', status: 'running', phase: 'hop' },
          ],
        },
      });
    });
    expect(await screen.findByTestId('app-shell-p2p-discussion-p2p_run-alpha-sub-only')).toBeTruthy();

    ws.p2pListDiscussions.mockClear();
    ws.p2pStatus.mockClear();
    useSubSessionsState.visibleSubSessions = [betaSub];
    fireEvent.click(screen.getByText('tabs-select-deck_beta_brain'));
    await waitFor(() => {
      expect(screen.queryByTestId('app-shell-p2p-discussion-p2p_run-alpha-sub-only')).toBeNull();
    });
    expect(ws.p2pListDiscussions).toHaveBeenCalledWith({ sessionName: 'deck_beta_brain' });
    expect(ws.p2pStatus).toHaveBeenCalledWith({ sessionName: 'deck_beta_brain' });

    ws.p2pListDiscussions.mockClear();
    ws.p2pStatus.mockClear();
    fireEvent.click(screen.getByText('tabs-select-deck_alpha_brain'));

    await waitFor(() => {
      expect(screen.getByTestId('app-shell-p2p-discussion-p2p_run-alpha-sub-only')).toBeTruthy();
    });
    expect(ws.p2pListDiscussions).toHaveBeenCalledWith({ sessionName: 'deck_alpha_brain' });
    expect(ws.p2pStatus).toHaveBeenCalledWith({ sessionName: 'deck_alpha_brain' });
  }, 20_000);

  it('nudges browser WebSocket recovery when daemon heartbeat is fresh but the tab is disconnected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-31T12:00:00Z'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');

      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      expect(await screen.findByText('session-tabs')).toBeTruthy();
      const ws = wsInstances[wsInstances.length - 1];
      expect(ws.reconnectNow).not.toHaveBeenCalled();

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      expect(wsInstances.some((instance) => instance.reconnectNow.mock.calls.some((call) => call[0] === true))).toBe(true);

      const activeWs = wsInstances.find((instance) => instance.reconnectNow.mock.calls.length > 0) ?? ws;
      act(() => {
        activeWs.emit({ type: 'session.event', event: 'connected', session: '', state: 'connected' });
      });

      const callsAfterConnect = activeWs.reconnectNow.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(activeWs.reconnectNow).toHaveBeenCalledTimes(callsAfterConnect);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('brings a newly opened sub-session window above restored open sub-session windows', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-1']));
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-2',
        sessionName: 'deck_sub_alpha_reviewer',
        parentSession: 'deck_alpha_brain',
        label: 'Reviewer',
        description: 'Reviewer session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const restored = await screen.findByTestId('sub-session-window-sub-1');
    await waitFor(() => expect(restored.getAttribute('data-active')).toBe('true'));

    fireEvent.click(screen.getByText('subbar-open-sub-2'));

    const opened = await screen.findByTestId('sub-session-window-sub-2');
    await waitFor(() => {
      expect(opened.getAttribute('data-active')).toBe('true');
      const restoredZ = Number((restored as HTMLElement).style.zIndex);
      const openedZ = Number((opened as HTMLElement).style.zIndex);
      expect(restoredZ).toBeGreaterThan(0);
      expect(openedZ).toBeGreaterThan(restoredZ);
    });
  }, 20_000);

  it('keeps multiple desktop sub-session windows open and fronts the latest click', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-2',
        sessionName: 'deck_sub_alpha_reviewer',
        parentSession: 'deck_alpha_brain',
        label: 'Reviewer',
        description: 'Reviewer session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    const first = await screen.findByTestId('sub-session-window-sub-1');

    fireEvent.click(screen.getByText('subbar-open-sub-2'));
    const second = await screen.findByTestId('sub-session-window-sub-2');

    await waitFor(() => {
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeTruthy();
      expect(screen.queryByTestId('sub-session-window-sub-2')).toBeTruthy();
      expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBe(JSON.stringify(['sub-1', 'sub-2']));
      expect(Number((second as HTMLElement).style.zIndex)).toBeGreaterThan(Number((first as HTMLElement).style.zIndex));
    });
  }, 20_000);

  it('opens a pinned sub-session as a floating window without closing other desktop sub-session windows', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-2',
        sessionName: 'deck_sub_alpha_reviewer',
        parentSession: 'deck_alpha_brain',
        label: 'Reviewer',
        description: 'Reviewer session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();

    fireEvent.click(screen.getByText('sidebar-drop-sub-2'));

    fireEvent.click(screen.getByText('subbar-open-sub-2'));

    await waitFor(() => {
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeTruthy();
      expect(screen.queryByTestId('sub-session-window-sub-2')).toBeTruthy();
    });
  }, 20_000);

  it('brings an already-open repository panel above a sub-session when the sub-session branch action opens it', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-1']));
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const subWindow = await screen.findByTestId('sub-session-window-sub-1');

    fireEvent.click(screen.getByText('subbar-repo'));
    expect(await screen.findByText('repo-page')).toBeTruthy();

    const repoZ = () => Number((screen.getByTestId('floating-panel-repo') as HTMLElement).style.zIndex);
    const subZ = () => Number((subWindow as HTMLElement).style.zIndex);

    await waitFor(() => expect(repoZ()).toBeGreaterThan(subZ()));

    fireEvent.mouseDown(subWindow);
    await waitFor(() => expect(subZ()).toBeGreaterThan(repoZ()));

    fireEvent.click(screen.getByText('sub-window-repo-sub-1'));
    await waitFor(() => expect(repoZ()).toBe(subZ() + 1));
  }, 20_000);

  it('keeps an existing sub-session window open when selecting its session-tree button', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-1']));
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();

    fireEvent.click(screen.getByText('tree-select-sub'));

    await waitFor(() => {
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeTruthy();
      expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBe(JSON.stringify(['sub-1']));
    });
  }, 20_000);

  it('restores open sub-session windows from the tab-local hash session after refresh', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    // Simulate another browser tab having most recently written the shared
    // fallback while this tab remains on Alpha through its own URL hash.
    localStorage.setItem('rcc_session', 'deck_other_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-1']));
    localStorage.setItem('rcc_open_subs_deck_other_brain', JSON.stringify(['sub-other']));
    history.replaceState(null, '', '/#/srv-1/deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();
    expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBe(JSON.stringify(['sub-1']));
    expect(localStorage.getItem('rcc_open_subs_deck_other_brain')).toBe(JSON.stringify(['sub-other']));
  }, 20_000);

  it('keeps this browser tab on its tab-local server and session when another tab changed the shared fallback', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    // localStorage represents the most recently used route in another browser
    // tab. This tab's URL is its independent, authoritative navigation state.
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const { writeHashState } = await import('../src/hooks/useHashState.js');
    writeHashState('srv-2', 'deck_beta_brain');
    // A reload/navigation boundary may reach the SPA without the hash. The
    // tab-local snapshot must still beat another page's shared fallback.
    history.replaceState(null, '', '/');
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') {
        return {
          servers: [
            ...serverList().servers,
            {
              id: 'srv-2',
              name: 'Beta Server',
              status: 'online',
              lastHeartbeatAt: Date.now(),
              createdAt: Date.now(),
              daemonVersion: '2026.8.25',
            },
          ],
        };
      }
      if (path === '/api/server/srv-2/sessions') {
        return {
          sessions: [{
            name: 'deck_beta_brain',
            project_name: 'Beta',
            role: 'brain',
            agent_type: 'codex-sdk',
            state: 'running',
            project_dir: '/work/beta',
            runtime_type: 'transport',
            label: 'Beta Brain',
          }],
        };
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
    expect(screen.queryByTestId('session-pane-deck_alpha_brain')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/server/srv-2/sessions',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(window.location.hash).toBe('#/srv-2/deck_beta_brain');
  }, 20_000);

  it('toggles a mobile bottom sub-session button open and closed', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');
      useSubSessionsState.subSessions = [
        {
          id: 'sub-1',
          sessionName: 'deck_sub_alpha_helper',
          parentSession: 'deck_alpha_brain',
          label: 'Helper',
          description: 'Helper session',
          cwd: '/work/alpha',
          type: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
          serverId: 'srv-1',
        },
      ];
      useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();

      fireEvent.click(screen.getByText('subbar-open-sub-1'));

      await waitFor(() => {
        expect(screen.queryByTestId('sub-session-window-sub-1')).toBeTruthy();
        expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBe(JSON.stringify(['sub-1']));
      });

      fireEvent.click(screen.getByText('subbar-open-sub-1'));

      await waitFor(() => {
        expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();
        expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBeNull();
      });
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('activates exactly the mobile window targeted by a notification tap', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');
      useSubSessionsState.subSessions = [
        {
          id: 'sub-1',
          sessionName: 'deck_sub_alpha_helper',
          parentSession: 'deck_alpha_brain',
          label: 'Helper',
          description: 'Helper session',
          cwd: '/work/alpha',
          type: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
          serverId: 'srv-1',
        },
        {
          id: 'sub-2',
          sessionName: 'deck_sub_alpha_reviewer',
          parentSession: 'deck_alpha_brain',
          label: 'Reviewer',
          description: 'Reviewer session',
          cwd: '/work/alpha',
          type: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
          serverId: 'srv-1',
        },
      ];
      useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

      const { App } = await importApp();
      render(<App />);
      await waitFor(() => expect(wsInstances.length).toBe(1));

      // Start on the second full-screen sub-session overlay.
      fireEvent.click(screen.getByText('subbar-open-sub-2'));
      expect(await screen.findByTestId('sub-session-window-sub-2')).toBeTruthy();
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();

      // A notification for the first sub-session must replace, not merely add
      // to, the mobile open set. Both overlays have the same mobile z-index,
      // so retaining sub-2 would let DOM order cover the requested target.
      act(() => window.dispatchEvent(new CustomEvent('deck:navigate', {
        detail: { serverId: 'srv-1', session: 'deck_sub_alpha_helper' },
      })));

      await waitFor(() => {
        expect(screen.getByTestId('sub-session-window-sub-1')).toBeTruthy();
        expect(screen.queryByTestId('sub-session-window-sub-2')).toBeNull();
        expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBe(JSON.stringify(['sub-1']));
      });

      // A notification for the parent main chat must also dismiss the mobile
      // full-screen sub-session overlay so the requested chat is visible.
      act(() => window.dispatchEvent(new CustomEvent('deck:navigate', {
        detail: { serverId: 'srv-1', session: 'deck_alpha_brain' },
      })));

      await waitFor(() => {
        // Quick collapse intentionally retains the live chat node to avoid a
        // cold remount, but it must no longer cover the main-session target.
        expect(screen.getByTestId('sub-session-window-sub-1').getAttribute('data-visible')).toBe('false');
        expect(screen.getByTestId('session-pane-deck_alpha_brain')).toBeTruthy();
        expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBeNull();
      });
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('keeps the mobile Team discussions page above an open sub-session window', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');
      useSubSessionsState.subSessions = [
        {
          id: 'sub-1',
          sessionName: 'deck_sub_alpha_helper',
          parentSession: 'deck_alpha_brain',
          label: 'Helper',
          description: 'Helper session',
          cwd: '/work/alpha',
          type: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
          serverId: 'srv-1',
        },
      ];
      useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

      const { App } = await importApp();
      render(<App />);

      await waitFor(() => expect(wsInstances.length).toBe(1));
      fireEvent.click(screen.getByText('subbar-open-sub-1'));

      const subWindow = await screen.findByTestId('sub-session-window-sub-1');
      fireEvent.click(screen.getByText('subbar-discussions'));
      const discussionsPanel = await screen.findByTestId('floating-panel-discussions');

      await waitFor(() => {
        expect(Number((discussionsPanel as HTMLElement).style.zIndex)).toBeGreaterThan(Number((subWindow as HTMLElement).style.zIndex));
      });
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('opens the Auto Deliver list from the sub-session toolbar status button', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    fireEvent.click(screen.getByText('subbar-auto-deliver'));

    expect(await screen.findByText('discussions-page')).toBeTruthy();
    expect(screen.getByTestId('discussions-initial-tab').textContent).toBe('auto');
  }, 20_000);

  it('renders the Auto Deliver runbar in the global sub-session toolbar and persists compact presentation locally', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-global-1',
          projectionVersion: 1,
          visibility: 'full',
          changeName: 'openspec-auto-delivery',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 84, checked: 80, unchecked: 4 },
          canStop: true,
        },
      });
    });

    const runbar = await screen.findByTestId('app-shell-auto-deliver-runbar');
    expect(runbar.textContent).toContain('openspec-auto-delivery');
    expect(runbar.getAttribute('data-compact')).toBe('false');

    await act(async () => {
      ws.emit({ type: 'p2p.status_response', runs: [] });
    });
    expect(screen.getByTestId('app-shell-auto-deliver-runbar').textContent).toContain('openspec-auto-delivery');

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.status_projection',
        projection: {
          runId: 'auto-global-1',
          projectionVersion: 0,
          visibility: 'full',
          changeName: 'stale-change',
          status: 'stopped',
          stage: 'stopped',
          terminal: true,
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 1, checked: 1, unchecked: 0 },
          canStop: false,
        },
      });
      ws.emit({
        type: 'openspec_auto_deliver.list_response',
        rows: [
          {
            runId: 'bad-list-row',
            projectionVersion: Number.POSITIVE_INFINITY,
            visibility: 'full',
            changeName: 'bad-list-row-change',
            status: 'active',
            stage: 'implementation_task_loop',
            owningMainSessionName: 'deck_alpha_brain',
          },
        ],
      });
    });
    expect(screen.getByTestId('app-shell-auto-deliver-runbar').textContent).toContain('openspec-auto-delivery');
    expect(screen.getByTestId('app-shell-auto-deliver-runbar').textContent).not.toContain('stale-change');
    expect(screen.getByTestId('app-shell-auto-deliver-runbar').textContent).not.toContain('bad-list-row-change');

    fireEvent.click(screen.getByText('subbar-auto-deliver-compact-run'));
    expect(screen.getByTestId('app-shell-auto-deliver-runbar').getAttribute('data-compact')).toBe('true');
    expect(localStorage.getItem('rcc_openspec_auto_runbar_compact')).toBe('1');

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.status_projection',
        projection: {
          runId: 'auto-global-1',
          projectionVersion: 4,
          visibility: 'full',
          changeName: 'openspec-auto-delivery',
          status: 'implementation_audit_repair',
          stage: 'implementation_audit_repair',
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 84, checked: 82, unchecked: 2 },
          canStop: true,
        },
      });
    });
    expect(screen.getByTestId('app-shell-auto-deliver-runbar').getAttribute('data-compact')).toBe('true');

    fireEvent.click(screen.getByText('subbar-auto-deliver-view'));
    expect(await screen.findByTestId('openspec-auto-details')).toBeTruthy();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('subbar-auto-deliver-stop-run'));
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.stop',
      runId: 'auto-global-1',
      sessionName: 'deck_alpha_brain',
    }));

    fireEvent.click(screen.getByText('subbar-auto-deliver-hide-run'));
    expect(screen.queryByTestId('app-shell-auto-deliver-runbar')).toBeNull();

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-global-2',
          projectionVersion: 1,
          visibility: 'full',
          changeName: 'second-change',
          status: 'spec_audit_repair',
          stage: 'spec_audit_repair',
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 4, checked: 1, unchecked: 3 },
          canStop: true,
        },
      });
    });

    const resetRunbar = await screen.findByTestId('app-shell-auto-deliver-runbar');
    expect(resetRunbar.textContent).toContain('second-change');
    expect(resetRunbar.getAttribute('data-compact')).toBe('true');
  }, 20_000);

  it('hides the global Auto Deliver runbar after the run reaches a terminal status', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-terminal-hidden',
          projectionVersion: 1,
          visibility: 'full',
          changeName: 'finished-change',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 2, checked: 1, unchecked: 1 },
          canStop: true,
        },
      });
    });

    expect(await screen.findByTestId('app-shell-auto-deliver-runbar')).toBeTruthy();

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-terminal-hidden',
          projectionVersion: 2,
          visibility: 'full',
          changeName: 'finished-change',
          status: 'passed',
          stage: 'passed',
          terminal: true,
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 2, checked: 2, unchecked: 0 },
          canStop: false,
        },
      });
    });

    expect(screen.queryByTestId('app-shell-auto-deliver-runbar')).toBeNull();
  }, 20_000);

  it('keeps the Auto Deliver runbar scoped to the main session when a desktop sub-session window is focused', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();

    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'openspec_auto_deliver.status_request',
        sessionName: 'deck_alpha_brain',
      }));
    });
    expect(ws.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.status_request',
      sessionName: 'deck_sub_alpha_helper',
    }));

    await act(async () => {
      ws.emit({
        type: 'openspec_auto_deliver.projection',
        projection: {
          runId: 'auto-main-while-sub-focused',
          projectionVersion: 1,
          visibility: 'full',
          changeName: 'openspec-auto-delivery',
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: 'deck_alpha_brain',
          launchedFromSessionName: 'deck_alpha_brain',
          targetImplementationSessionName: 'deck_alpha_brain',
          taskStats: { total: 4, checked: 2, unchecked: 2 },
          canStop: true,
        },
      });
    });

    expect(await screen.findByTestId('app-shell-auto-deliver-runbar')).toBeTruthy();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByText('subbar-auto-deliver-stop-run'));
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'openspec_auto_deliver.stop',
      runId: 'auto-main-while-sub-focused',
      sessionName: 'deck_alpha_brain',
    }));
  }, 20_000);

  it('binds the global Auto Deliver runbar to the open sub-session UI scope on mobile', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android' });

    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');
      useSubSessionsState.subSessions = [
        {
          id: 'sub-1',
          sessionName: 'deck_sub_alpha_helper',
          parentSession: 'deck_alpha_brain',
          label: 'Helper',
          description: 'Helper session',
          cwd: '/work/alpha',
          type: 'codex-sdk',
          runtimeType: 'transport',
          state: 'idle',
          serverId: 'srv-1',
        },
      ];
      useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

      const { App } = await importApp();
      render(<App />);

      expect(await screen.findByText('session-tabs')).toBeTruthy();
      const ws = await getActiveWsClient();

      fireEvent.click(screen.getByText('subbar-open-sub-1'));
      expect(await screen.findByTestId('sub-session-window-sub-1')).toBeTruthy();

      await waitFor(() => {
        expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'openspec_auto_deliver.status_request',
          sessionName: 'deck_sub_alpha_helper',
        }));
      });

      await act(async () => {
        ws.emit({
          type: 'openspec_auto_deliver.projection',
          projection: {
            runId: 'auto-sub-mobile',
            projectionVersion: 1,
            visibility: 'full',
            changeName: 'openspec-auto-delivery',
            status: 'implementation_task_loop',
            stage: 'implementation_task_loop',
            owningMainSessionName: 'deck_alpha_brain',
            launchedFromSessionName: 'deck_sub_alpha_helper',
            targetImplementationSessionName: 'deck_sub_alpha_helper',
            taskStats: { total: 4, checked: 2, unchecked: 2 },
            canStop: true,
          },
        });
      });

      expect(await screen.findByTestId('app-shell-auto-deliver-runbar')).toBeTruthy();
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      fireEvent.click(screen.getByText('subbar-auto-deliver-stop-run'));
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'openspec_auto_deliver.stop',
        runId: 'auto-sub-mobile',
        sessionName: 'deck_sub_alpha_helper',
      }));
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('reuses the AskQuestion dialog UI for Auto Deliver needs_human handoff questions', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');

    const { App } = await importApp();
    const { watchProjectionStore } = await import('../src/watch-projection.js');
    render(<App />);

    expect(await screen.findByText('session-tabs')).toBeTruthy();
    const ws = await getActiveWsClient();
    await act(async () => {
      ws.emit({
        type: 'timeline.event',
        event: {
          id: 'evt-auto-ask',
          ts: Date.now(),
          sessionId: 'deck_alpha_brain',
          type: 'ask.question',
          payload: {
            toolUseId: 'auto-run-1:needs-human:2',
            waitMs: 300_000,
            questions: [{
              header: 'OpenSpec Auto Deliver',
              question: 'Auto Deliver stopped with reason "missing_authoritative_json". What should happen next in this session?',
              options: [
                { label: 'Review the failure and continue manually' },
                { label: 'Stop here and summarize the current state' },
              ],
            }],
          },
        },
      });
    });

    expect(await screen.findByText('ask-question-dialog')).toBeTruthy();
    expect(screen.getByText('OpenSpec Auto Deliver')).toBeTruthy();
    expect(screen.getByText(/missing_authoritative_json/)).toBeTruthy();
    expect(screen.getByText('Review the failure and continue manually')).toBeTruthy();
    await waitFor(() => {
      expect(vi.mocked(watchProjectionStore.pushDurableEvent)).toHaveBeenCalledWith(expect.objectContaining({
        type: 'ask.question',
        session: 'deck_alpha_brain',
        serverId: 'srv-1',
        message: 'Auto Deliver stopped with reason "missing_authoritative_json". What should happen next in this session?',
      }));
    });

    fireEvent.click(screen.getByText('ask-submit'));
    expect(ws.askAnswer).toHaveBeenCalledWith('deck_alpha_brain', 'answer');
    expect(screen.queryByText('ask-question-dialog')).toBeNull();
  }, 20_000);

  it('quick-collapses and restores all sub-session windows without unmounting their chat state', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-1', 'sub-2']));
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-2',
        sessionName: 'deck_sub_alpha_reviewer',
        parentSession: 'deck_alpha_brain',
        label: 'Reviewer',
        description: 'Reviewer session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const first = await screen.findByTestId('sub-session-window-sub-1');
    const second = await screen.findByTestId('sub-session-window-sub-2');
    await waitFor(() => {
      expect(first.getAttribute('data-active')).toBe('false');
      expect(second.getAttribute('data-active')).toBe('true');
    });

    fireEvent.click(screen.getByText('subbar-quick-close'));

    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-1')).toBe(first);
      expect(screen.getByTestId('sub-session-window-sub-2')).toBe(second);
      expect(first.getAttribute('data-visible')).toBe('false');
      expect(second.getAttribute('data-visible')).toBe('false');
      expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBeNull();
    });

    // The arrow's bulk restore uses the exact retained nodes instead of
    // reconstructing two timelines concurrently (the production blank-pane
    // race reported by users).
    fireEvent.click(screen.getByText('subbar-quick-restore'));
    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-1')).toBe(first);
      expect(screen.getByTestId('sub-session-window-sub-2')).toBe(second);
      expect(first.getAttribute('data-visible')).toBe('true');
      expect(second.getAttribute('data-visible')).toBe('true');
    });
  }, 20_000);

  it('does not mount closed sub-session windows after sub-sessions load', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [
      {
        id: 'sub-1',
        sessionName: 'deck_sub_alpha_helper',
        parentSession: 'deck_alpha_brain',
        label: 'Helper',
        description: 'Helper session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
      {
        id: 'sub-2',
        sessionName: 'deck_sub_alpha_reviewer',
        parentSession: 'deck_alpha_brain',
        label: 'Reviewer',
        description: 'Reviewer session',
        cwd: '/work/alpha',
        type: 'codex-sdk',
        runtimeType: 'transport',
        state: 'idle',
        serverId: 'srv-1',
      },
    ];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    expect(await screen.findByText('session-tabs')).toBeTruthy();
    expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();
    expect(screen.queryByTestId('sub-session-window-sub-2')).toBeNull();

    fireEvent.click(screen.getByText('subbar-open-sub-2'));
    expect(await screen.findByTestId('sub-session-window-sub-2')).toBeTruthy();
    expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();
  }, 20_000);

  it('keeps both open sub-session window instances mounted while switching main tabs', async () => {
    // Regression: main SessionPane components stay mounted across tab switches,
    // but floating sub-session windows used to be filtered out by
    // visibleSubSessions. Returning to a main tab rebuilt both ChatViews at
    // once; their cache/IDB bootstrap raced and one window intermittently
    // rendered blank until a manual refresh. The exact DOM nodes must survive
    // the round trip — hidden while inactive, visible again on return.
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem('rcc_open_subs_deck_alpha_brain', JSON.stringify(['sub-a1', 'sub-a2']));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') {
        return {
          sessions: [
            ...sessionList().sessions,
            { ...sessionList().sessions[0], name: 'deck_beta_brain', project_name: 'Beta', label: 'Beta Brain' },
          ],
        };
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    const alphaSubs = ['a1', 'a2'].map((suffix) => ({
      id: `sub-${suffix}`,
      sessionName: `deck_sub_alpha_${suffix}`,
      parentSession: 'deck_alpha_brain',
      label: suffix.toUpperCase(),
      description: '',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }));
    const betaSub = {
      id: 'sub-b1',
      sessionName: 'deck_sub_beta_b1',
      parentSession: 'deck_beta_brain',
      label: 'B1',
      description: '',
      cwd: '/work/beta',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    };
    useSubSessionsState.subSessions = [...alphaSubs, betaSub];
    useSubSessionsState.visibleSubSessions = alphaSubs;

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(wsInstances.length).toBe(1));

    const firstA = await screen.findByTestId('sub-session-window-sub-a1');
    const secondA = await screen.findByTestId('sub-session-window-sub-a2');
    expect(firstA.getAttribute('data-visible')).toBe('true');
    expect(secondA.getAttribute('data-visible')).toBe('true');

    useSubSessionsState.visibleSubSessions = [betaSub];
    fireEvent.click(await screen.findByText('tabs-select-deck_beta_brain'));
    await waitFor(() => {
      expect(firstA.getAttribute('data-visible')).toBe('false');
      expect(secondA.getAttribute('data-visible')).toBe('false');
    });

    useSubSessionsState.visibleSubSessions = alphaSubs;
    fireEvent.click(screen.getByText('tabs-select-deck_alpha_brain'));
    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-a1')).toBe(firstA);
      expect(screen.getByTestId('sub-session-window-sub-a2')).toBe(secondA);
      expect(firstA.getAttribute('data-visible')).toBe('true');
      expect(secondA.getAttribute('data-visible')).toBe('true');
    });
  }, 20_000);

  it('marks the most-recently opened sub-session window active, regardless of how many are open', async () => {
    // Regression: opening a 3rd (or Nth) window left it inactive (dashed accent,
    // un-closable) because the active sub was re-derived from the mutable window
    // stack and lost a race with background churn. The active sub is now set
    // explicitly on open, so the just-opened window is always the active one.
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = ['a', 'b', 'c'].map((suffix, i) => ({
      id: `sub-${i + 1}`,
      sessionName: `deck_sub_alpha_${suffix}`,
      parentSession: 'deck_alpha_brain',
      label: suffix.toUpperCase(),
      description: '',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }));
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    render(<App />);
    await waitFor(() => expect(wsInstances.length).toBe(1));
    expect(await screen.findByText('session-tabs')).toBeTruthy();

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    fireEvent.click(screen.getByText('subbar-open-sub-2'));
    fireEvent.click(screen.getByText('subbar-open-sub-3'));

    // The just-opened sub-3 is active; the earlier two are open but inactive.
    // Windows mount one animation frame apart (useProgressiveMount), so wait
    // for all three to exist before comparing their active flags — otherwise
    // this races the mount schedule rather than testing it.
    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-1')).toBeTruthy();
      expect(screen.getByTestId('sub-session-window-sub-2')).toBeTruthy();
      expect(screen.getByTestId('sub-session-window-sub-3').getAttribute('data-active')).toBe('true');
    });
    expect(screen.getByTestId('sub-session-window-sub-1').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('sub-session-window-sub-2').getAttribute('data-active')).toBe('false');

    const windowDomOrder = () => screen.getAllByTestId(/^sub-session-window-sub-/)
      .map((node) => node.getAttribute('data-testid'));
    const orderBeforeFocusChange = windowDomOrder();

    // Re-activating an older window flips active over to it (and only it), but
    // must not move either live window in the DOM. Reordering keyed siblings
    // makes Blink/WebKit re-anchor the chat scrollers and visibly jolts the
    // window that just lost focus.
    fireEvent.mouseDown(screen.getByTestId('sub-session-window-sub-1'));
    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-1').getAttribute('data-active')).toBe('true');
    });
    expect(screen.getByTestId('sub-session-window-sub-3').getAttribute('data-active')).toBe('false');
    expect(windowDomOrder()).toEqual(orderBeforeFocusChange);
  }, 20_000);

  it('keeps the third outgoing shared window writable and exactly routed across role and subscription refresh', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const makeSubs = () => ['a', 'b', 'c'].map((suffix, index) => ({
      id: `sub-${index + 1}`,
      sessionName: `deck_sub_alpha_${suffix}`,
      parentSession: 'deck_alpha_brain',
      label: suffix.toUpperCase(),
      description: '',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }));
    const outgoingShares = (role: 'viewer' | 'participant') => makeSubs().map((sub, index) => ({
      id: `share-${index + 1}`,
      targetUserId: `recipient-${index + 1}`,
      targetUserDisplayName: `Recipient ${index + 1}`,
      role,
      status: 'active',
      target: { kind: 'subsession', serverId: 'srv-1', subSessionId: sub.id },
    }));
    useSubSessionsState.subSessions = makeSubs();
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;
    listManagedSharesForServerMock.mockResolvedValue(outgoingShares('viewer'));

    const { App } = await importApp();
    render(<App />);
    const ws = await getActiveWsClient();
    await waitFor(() => expect(listManagedSharesForServerMock).toHaveBeenCalledWith('srv-1'));

    fireEvent.click(screen.getByText('subbar-open-sub-1'));
    fireEvent.click(screen.getByText('subbar-open-sub-2'));
    fireEvent.click(screen.getByText('subbar-open-sub-3'));

    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-1')).toBeTruthy();
      expect(screen.getByTestId('sub-session-window-sub-2')).toBeTruthy();
      expect(screen.getByTestId('sub-session-window-sub-3').getAttribute('data-active')).toBe('true');
      expect(screen.getByTestId('sub-session-window-sub-3').getAttribute('data-shared-outgoing')).toBe('true');
    });
    const thirdComposer = screen.getByLabelText('sub-window-composer-sub-3') as HTMLInputElement;
    expect(thirdComposer.disabled).toBe(false);
    fireEvent.click(screen.getByText('sub-window-send-sub-3'));
    expect(ws.sendSessionCommand).toHaveBeenLastCalledWith(
      'deck_sub_alpha_c',
      'message-for-sub-3',
      {},
    );

    // Recreate the hook snapshots like a background sub-session subscription
    // refresh, and refresh the managed grants at the same time. Neither fresh
    // object identities nor a recipient role change may turn the owner's third
    // composer into an incoming viewer surface or move focus away from it.
    useSubSessionsState.subSessions = makeSubs();
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;
    listManagedSharesForServerMock.mockResolvedValue(outgoingShares('participant'));
    fireEvent.click(screen.getByText('sub-window-share-sub-3'));
    fireEvent.click(await screen.findByText('share-session-refresh'));
    await act(async () => {
      ws.emit({
        type: 'session_list',
        sessions: [{
          name: 'deck_alpha_brain',
          project: 'Alpha',
          role: 'brain',
          agentType: 'codex-sdk',
          state: 'idle',
          runtimeType: 'process',
        }],
      });
    });

    await waitFor(() => {
      const third = screen.getByTestId('sub-session-window-sub-3');
      expect(third.getAttribute('data-active')).toBe('true');
      expect(third.getAttribute('data-shared-outgoing')).toBe('true');
      expect(third.getAttribute('data-share-role')).toBe('participant');
      expect((screen.getByLabelText('sub-window-composer-sub-3') as HTMLInputElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByText('sub-window-send-sub-3'));
    expect(ws.sendSessionCommand).toHaveBeenLastCalledWith(
      'deck_sub_alpha_c',
      'message-for-sub-3',
      {},
    );

    // The inverse authority boundary remains fail-closed: when the parent is
    // an incoming viewer surface rather than an outgoing owner grant, every
    // child composer is read-only, including the focused third window.
    listManagedSharesForServerMock.mockResolvedValue([]);
    fireEvent.click(screen.getByText('share-session-refresh'));
    await act(async () => {
      ws.emit({
        type: 'session_list',
        sessions: [{
          name: 'deck_alpha_brain',
          project: 'Alpha',
          role: 'brain',
          agentType: 'codex-sdk',
          state: 'idle',
          runtimeType: 'process',
          sharedState: { status: 'active', effectiveRole: 'viewer' },
        }],
      });
    });
    await waitFor(() => {
      expect((screen.getByLabelText('sub-window-composer-sub-1') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByLabelText('sub-window-composer-sub-2') as HTMLInputElement).disabled).toBe(true);
      expect((screen.getByLabelText('sub-window-composer-sub-3') as HTMLInputElement).disabled).toBe(true);
    });
  }, 20_000);

  it('executes app-level shell callbacks and websocket message reducers', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    useSubSessionsState.subSessions = [{
      id: 'sub-1',
      sessionName: 'deck_sub_alpha_helper',
      parentSession: 'deck_alpha_brain',
      label: 'Helper',
      description: 'Helper session',
      cwd: '/work/alpha',
      type: 'codex-sdk',
      runtimeType: 'transport',
      state: 'idle',
      serverId: 'srv-1',
    }];
    useSubSessionsState.visibleSubSessions = useSubSessionsState.subSessions;

    const { App } = await importApp();
    const view = render(<App />);

    await waitFor(() => expect(wsInstances.length).toBe(1));
    const ws = wsInstances[0];
    expect(await screen.findByText('session-tabs')).toBeTruthy();

    fireEvent.click(screen.getByTitle('picker.files'));
    expect(await screen.findByText('file-browser')).toBeTruthy();
    fireEvent.click(screen.getByText('file-confirm'));
    fireEvent.click(screen.getByText('file-preview-state'));
    fireEvent.click(screen.getByText('file-close'));

    fireEvent.click(screen.getByText('pane-preview-upload'));
    expect((await screen.findByTestId('file-browser-preview')).getAttribute('data-scope-to-session-root')).toBe('true');
    fireEvent.click(screen.getByText('file-close'));

    fireEvent.click(screen.getByText('subbar-repo'));
    expect(await screen.findByText('repo-page')).toBeTruthy();
    fireEvent.click(screen.getByText('repo-ci'));
    fireEvent.click(screen.getByText('repo-back'));

    fireEvent.click(screen.getByText('subbar-cron'));
    expect(await screen.findByText('cron-manager')).toBeTruthy();
    fireEvent.click(screen.getByText('cron-back'));
    fireEvent.click(screen.getByText('subbar-cron'));
    expect(await screen.findByText('cron-manager')).toBeTruthy();
    fireEvent.click(screen.getByText('cron-discussion'));
    fireEvent.click(screen.getByText('subbar-cron'));
    expect(await screen.findByText('cron-manager')).toBeTruthy();
    fireEvent.click(screen.getByText('cron-navigate'));

    fireEvent.click(screen.getByText('subbar-discussions'));
    await waitFor(() => expect(view.container.textContent).toContain('discussions-page'));
    fireEvent.click(screen.getAllByText('floating-close')[0]);

    fireEvent.click(screen.getAllByTitle('localWebPreview.title')[0]);
    expect(await screen.findByText('local-web-preview')).toBeTruthy();
    fireEvent.click(screen.getByText('preview-draft'));

    fireEvent.click(screen.getByText('pane-preview-loopback'));
    const loopbackPreview = await screen.findByTestId('local-web-preview');
    expect(loopbackPreview.getAttribute('data-port')).toBe('8787');
    expect(loopbackPreview.getAttribute('data-path')).toBe('/docs?q=1#intro');

    for (const label of [
      'pane-fit-ref',
      'pane-scroll-ref',
      'pane-focus-ref',
      'pane-chat-ref',
      'pane-input-ref',
      'pane-diff-ref',
      'pane-history-ref',
      'pane-config',
      'pane-after-action',
      'pane-close-mobile-files',
      'pane-prefill-applied',
      'tabs-select',
      'tabs-dismiss',
      'tabs-rename-handled',
      'tabs-rename',
      'tree-select-session',
      'tree-select-sub',
      'subbar-collapse',
      'subbar-open',
      'subbar-open-max',
      'subbar-stop-p2p',
      'subbar-stop-discussion',
      'maximize-button',
      'server-toggle-sidebar',
    ]) {
      fireEvent.click(screen.getByText(label));
    }

    await act(async () => {
      ws.emit({ type: 'session.event', event: 'connected', session: 'deck_alpha_brain', state: 'running' });
      ws.emit({ type: 'session.event', event: 'started', session: 'deck_alpha_worker', state: 'running' });
      ws.emit({ type: 'session_list', sessions: sessionList().sessions, daemonVersion: '2026.5.12-dev.1' });
      ws.emit({ type: 'terminal.diff', diff: { sessionName: 'deck_alpha_brain', lines: [[0, 'model gpt-5.4']] } });
      ws.emit({ type: 'terminal.history', sessionName: 'deck_alpha_brain', content: 'history' });
      ws.emit({
        type: 'timeline.event',
        event: {
          id: 'evt-1',
          ts: Date.now(),
          sessionId: 'deck_alpha_brain',
          type: 'session.state',
          payload: { state: 'queued', pendingMessages: ['queued prompt'] },
        },
      });
      ws.emit({
        type: 'timeline.event',
        event: {
          id: 'evt-2',
          ts: Date.now(),
          sessionId: 'deck_alpha_brain',
          type: 'session.state',
          payload: { state: 'running' },
        },
      });
      ws.emit({
        type: 'timeline.event',
        event: {
          id: 'evt-3',
          ts: Date.now(),
          sessionId: 'deck_alpha_brain',
          type: 'ask.question',
          payload: { toolUseId: 'tool-1', questions: [{ id: 'q1', question: 'Proceed?' }] },
        },
      });
    });
    await act(async () => {
      ws.emit({ type: 'session.idle', session: 'deck_alpha_brain', project: 'Alpha', agentType: 'codex-sdk' });
      ws.emit({ type: 'session.notification', session: 'deck_alpha_brain', project: 'Alpha', title: 'Done', message: 'ok' });
      ws.emit({ type: 'discussion.started', discussionId: 'discussion-1', topic: 'Topic', maxRounds: 2, totalHops: 3 });
      ws.emit({ type: 'discussion.update', discussionId: 'discussion-1', state: 'running', currentRound: 1, maxRounds: 2, completedHops: 1 });
      ws.emit({ type: 'discussion.done', discussionId: 'discussion-1', conclusion: 'done', filePath: '/work/alpha/discussion.md' });
      ws.emit({ type: 'discussion.error', discussionId: 'discussion-1', error: 'failed' });
      ws.emit({ type: 'discussion.list', discussions: [{ id: 'discussion-2', topic: 'Listed', state: 'done' }] });
      ws.emit({ type: 'p2p.run_update', run: { id: 'run-1', state: 'running', currentRound: 1, maxRounds: 2, completedHops: 0, totalHops: 2 } });
      ws.emit({ type: 'p2p.status_response', runs: [{ id: 'run-1', state: 'done', currentRound: 2, maxRounds: 2 }] });
      ws.emit({ type: 'p2p.cancel_response', ok: true, runId: 'run-1' });
      ws.emit({ type: 'repo.detected', projectDir: '/work/alpha', context: { status: 'ok', owner: 'im', repo: 'codes' } });
      ws.emit({ type: 'repo.error', projectDir: '/work/alpha', error: 'cli_missing' });
      ws.emit({ type: 'daemon.upgrade_blocked', reason: 'transport_busy' });
      ws.emit({ type: 'daemon.disconnected' });
      ws.emit({ type: 'daemon.reconnected' });
      ws.emit({ type: 'daemon.offline' });
      ws.emit({ type: 'daemon.error', kind: 'uncaught', message: 'boom', stack: 'stack' });
      ws.emit({ type: 'command.ack', status: 'error', error: 'no_saved_config' });
      ws.emitLatency(42);
    });

    fireEvent.click(screen.getByText('server-settings'));
    expect(await screen.findByText('settings-page')).toBeTruthy();
    fireEvent.click(screen.getByText('settings-display'));
    fireEvent.click(screen.getByText('settings-auth'));
    fireEvent.click(screen.getByText('settings-back'));

    fireEvent.click(screen.getByText('server-admin'));
    fireEvent.click(await screen.findByText('admin-page'));

    fireEvent.click(screen.getByText('tree-new-session'));
    expect(await screen.findByText('new-session-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('new-session-start'));

    fireEvent.click(screen.getByText('tree-new-sub'));
    expect(await screen.findByText('start-sub-session-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('start-sub-start'));

    fireEvent.click(screen.getByText('pane-settings'));
    expect(await screen.findByText('session-settings-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('settings-pool-add'));
    const poolLauncher = await screen.findByText('start-sub-session-dialog');
    expect(poolLauncher.getAttribute('data-allowed-agent-types')).toBe('claude-code-sdk,codex-sdk,qwen,openclaw');
    expect(poolLauncher.getAttribute('data-overlay-class')).toBe('session-settings-child-overlay');
    expect(screen.getByText('session-settings-dialog').getAttribute('data-child-dialog-open')).toBe('true');
    fireEvent.click(screen.getByText('start-sub-close'));
    fireEvent.click(screen.getByText('settings-save'));
    fireEvent.click(screen.getByText('settings-close'));

    fireEvent.click(screen.getByText('tabs-settings'));
    expect(await screen.findByText('session-settings-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('settings-close'));

    fireEvent.click(screen.getByText('tabs-clone'));
    expect(await screen.findByText('clone-session-group-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('clone-close'));

    fireEvent.click(screen.getByText('server-menu'));
    expect(await screen.findByText('server-context-menu')).toBeTruthy();
    fireEvent.click(screen.getByText('server-menu-delete'));
    expect(await screen.findByText('delete-server-dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('delete-cancel'));

    expect(view.container.textContent).toContain('sub-session-bar');
  }, 30_000);

  it('guides the user back to their previous server after opening shared content', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-1',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue({
      server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
      target: sharedEntry.target,
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-1'],
        primaryShareId: 'share-1',
        authorizedAt: Date.now(),
      },
      sessions: [{
        sessionName: 'deck_beta_brain',
        title: 'Shared Beta',
        state: 'running',
        agentType: 'codex-sdk',
        activeDispatchId: 'dispatch-open-1',
        supervisionMode: 'supervised_audit',
      }],
      subSessions: [],
    });

    const { App } = await importApp();
    render(<App />);

    const ownServerWsCount = wsInstances.length;
    const entryLabel = await screen.findByText('Shared Beta');
    fireEvent.click(entryLabel.closest('button')!);

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledWith(sharedEntry.target));
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    expect(readSharedTabRestoreMarker()).toEqual({
      version: 1,
      entryId: 'share-1',
      serverId: 'srv-shared',
      targetKey: 'main:srv-shared:deck_beta_brain',
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/srv-shared/deck_beta_brain?shared=share-1');
    });
    const sharedPane = await screen.findByTestId('session-pane-deck_beta_brain');
    expect(sharedPane.getAttribute('data-active-dispatch-id')).toBe('dispatch-open-1');
    expect(sharedPane.getAttribute('data-supervision-mode')).toBe('supervised_audit');
    fireEvent.click(within(sharedPane).getByRole('button', { name: 'pane-settings' }));
    const settings = await screen.findByTestId('session-settings-dialog');
    expect(settings.getAttribute('data-supervision-mode')).toBe('supervised_audit');
    expect(settings.getAttribute('data-can-control-supervision')).toBe('false');
    fireEvent.click(within(settings).getByRole('button', { name: 'settings-close' }));
    await waitFor(() => expect(wsInstances.length).toBeGreaterThan(ownServerWsCount));
    await waitFor(() => expect(wsInstances.some((instance) => instance.options?.shareTarget === sharedEntry.target)).toBe(true));
    const sharedWs = wsInstances.findLast((instance) => instance.options?.shareTarget === sharedEntry.target)!;
    await waitFor(() => expect(sharedWs.messageHandlers.length).toBeGreaterThan(0));
    act(() => {
      sharedWs.emit({
        type: 'command.ack',
        commandId: 'dispatch-live-2',
        status: 'accepted',
        session: 'deck_beta_brain',
        activeDispatchId: 'dispatch-live-2',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('session-pane-deck_beta_brain').getAttribute('data-active-dispatch-id')).toBe('dispatch-live-2');
    });
    const guide = await screen.findByTestId('shared-return-guide');
    expect(guide.textContent).toContain('share.sharedWithMe.guideReturn');
    expect(guide.textContent).toContain('share.sharedWithMe.guideDismiss');
    expect(screen.getByTestId('server-icon-bar').getAttribute('data-return-hint-server-id')).toBe('srv-1');

    fireEvent.click(screen.getByRole('button', { name: 'share.sharedWithMe.guideDismiss' }));
    expect(screen.queryByTestId('shared-return-guide')).toBeNull();
  }, 20_000);

  it('keeps an explicit server choice authoritative after a shared route has settled', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-settled-switch',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult(
      'share-settled-switch',
      'dispatch-settled-switch',
    ));

    const { App } = await importApp();
    render(<App />);

    fireEvent.click((await screen.findByText('Shared Beta')).closest('button')!);
    await screen.findByTestId('session-pane-deck_beta_brain');
    await waitFor(() => {
      expect(window.location.hash).toBe('#/srv-shared/deck_beta_brain?shared=share-settled-switch');
    });

    fireEvent.click(screen.getByTestId('shared-return-guide').querySelector('.shared-return-guide-return')!);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.location.hash).toBe('#/srv-1/deck_alpha_brain');
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    const { readTabRouteState } = await import('../src/hooks/useHashState.js');
    expect(readSharedTabRestoreMarker()).toBeNull();
    expect(readTabRouteState()).toEqual({
      serverId: 'srv-1',
      sessionName: 'deck_alpha_brain',
      sharedEntryId: null,
    });
  }, 20_000);

  it('does not let a pending shared open undo Back to dashboard', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-pending-back',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    let resolveOpen!: (value: ReturnType<typeof sharedMainOpenResult>) => void;
    openSharedEntryMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOpen = resolve;
    }));

    const { App } = await importApp();
    render(<App />);

    const entryLabel = await screen.findByText('Shared Beta');
    fireEvent.click(entryLabel.closest('button')!);
    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'server-home' }));
    expect(await screen.findByText('dashboard-page')).toBeTruthy();

    await act(async () => {
      resolveOpen(sharedMainOpenResult('share-pending-back', 'dispatch-must-not-return'));
      await Promise.resolve();
    });

    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    expect(screen.getByText('dashboard-page')).toBeTruthy();
    expect(window.location.hash).toBe('');
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    const { readTabRouteState } = await import('../src/hooks/useHashState.js');
    expect(readSharedTabRestoreMarker()).toBeNull();
    expect(readTabRouteState()).toEqual({ serverId: null, sessionName: null, sharedEntryId: null });
    expect(wsInstances.some((instance) => instance.options?.shareTarget)).toBe(false);
  }, 20_000);

  /**
   * RED — the existing guards cover "Back to dashboard" and "Logout", but not
   * the case the user actually reports: while a shared open is still in flight,
   * explicitly navigating to ANOTHER AUTHORIZED SERVER must win.
   *
   * Both the URL and the canonical selection have to land on the newer
   * destination. Asserting only one of them would let a stale write move the
   * other half and still pass.
   */
  it('does not let a pending shared open undo selecting another authorized server', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-pending-switch',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    let resolveOpen!: (value: ReturnType<typeof sharedMainOpenResult>) => void;
    openSharedEntryMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOpen = resolve;
    }));

    const { App } = await importApp();
    render(<App />);

    const entryLabel = await screen.findByText('Shared Beta');
    fireEvent.click(entryLabel.closest('button')!);
    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));

    // The user changes their mind and picks one of their own servers while the
    // shared open is still pending.
    fireEvent.click(screen.getByRole('button', { name: 'server-select' }));
    await waitFor(() => expect(window.location.hash).toContain('srv-1'));

    // The stale shared open now settles.
    await act(async () => {
      resolveOpen(sharedMainOpenResult('share-pending-switch', 'dispatch-must-not-return'));
      await Promise.resolve();
    });

    // URL must stay on the user's newer destination...
    expect(window.location.hash).toContain('srv-1');
    expect(window.location.hash).not.toContain('srv-shared');
    // ...and so must the canonical selection: no shared pane, no share-scoped
    // socket resurrected by the late response.
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    expect(readSharedTabRestoreMarker()).toBeNull();
    const { readTabRouteState } = await import('../src/hooks/useHashState.js');
    expect(readTabRouteState().serverId).not.toBe('srv-shared');
  }, 20_000);

  it('does not let a pending shared open undo Logout while the logout request is pending', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-pending-logout',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    let resolveOpen!: (value: ReturnType<typeof sharedMainOpenResult>) => void;
    let resolveLogout!: () => void;
    openSharedEntryMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOpen = resolve;
    }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') return sessionList();
      if (path === '/api/auth/logout') {
        return new Promise<void>((resolve) => { resolveLogout = resolve; });
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    const entryLabel = await screen.findByText('Shared Beta');
    fireEvent.click(entryLabel.closest('button')!);
    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Log Out' }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' }));

    await act(async () => {
      resolveOpen(sharedMainOpenResult('share-pending-logout', 'dispatch-must-not-return'));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    expect(wsInstances.some((instance) => instance.options?.shareTarget)).toBe(false);

    await act(async () => {
      resolveLogout();
      await Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: 'login-page' })).toBeTruthy();
    expect(window.location.hash).toBe('');
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    const { readTabRouteState } = await import('../src/hooks/useHashState.js');
    expect(readSharedTabRestoreMarker()).toBeNull();
    expect(readTabRouteState()).toEqual({ serverId: null, sessionName: null, sharedEntryId: null });
  }, 20_000);

  /**
   * RED — an external URL change must not be silently reverted.
   *
   * `writeHashState` publishes routes with `history.replaceState`, and nothing
   * in web/src subscribes to `popstate` or `hashchange` (verified: zero matches
   * across the source tree). So when the URL changes underneath the app — the
   * user edits the address bar, follows a direct link into the same tab, or the
   * browser restores a session — the app never learns about it, while the
   * unconditional hash-sync effect at app.tsx:1606 keeps republishing the
   * in-memory selection.
   *
   * Net effect for a user sitting in a shared session: navigating to another
   * authorized server by URL is undone, and the tab snaps back to the shared
   * session. That is exactly the reported regression, and it needs no reload
   * and no restore race to happen.
   */
  it('does not revert an explicit direct-URL navigation to another authorized server', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-direct-url',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-direct-url', 'dispatch-direct-url'));

    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    // The user navigates this tab to one of their OWN servers by URL.
    await act(async () => {
      history.replaceState(null, '', '/#/srv-1/deck_alpha_brain');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    // The URL itself survives — the hash-sync effect only republishes when the
    // in-memory selection changes, so it does not stomp an external edit.
    expect(window.location.hash).toContain('srv-1');

    // But the app must actually FOLLOW that navigation. Nothing in web/src
    // subscribes to popstate/hashchange, so the shared pane stays mounted and
    // the tab keeps talking to the shared server while the address bar claims
    // otherwise. A URL that no longer describes the session on screen is the
    // user-visible half of "it forced me back to the shared session".
    expect(
      screen.queryByTestId('session-pane-deck_beta_brain'),
      'the shared pane is still mounted after the user navigated away by URL',
    ).toBeNull();
    expect(
      screen.queryByTestId('session-pane-deck_alpha_brain'),
      'the app did not follow the explicit URL navigation to the owned server',
    ).not.toBeNull();
  }, 20_000);

  const navigateExternally = async (hash: string) => {
    await act(async () => {
      history.replaceState(null, '', hash);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      window.dispatchEvent(new PopStateEvent('popstate'));
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
  };

  it('lets an explicit session click retire an older shared-route promise', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const serverEntry = {
      id: 'share-whole-server',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Whole Shared Server',
      target: { kind: 'server', serverId: 'srv-shared' },
    } as const;
    const lateEntry = {
      id: 'share-late-session-route',
      serverId: 'srv-late',
      serverName: 'Late Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Late Session',
      target: { kind: 'main', serverId: 'srv-late', sessionName: 'deck_late_brain' },
    } as const;
    discoverSharedEntriesMock.mockResolvedValue([serverEntry, lateEntry]);
    let resolveLate!: (value: unknown) => void;
    openSharedEntryMock.mockImplementation((target: { kind: string; serverId: string }) => {
      if (target.serverId === 'srv-late') {
        return new Promise((resolve) => { resolveLate = resolve; });
      }
      return Promise.resolve({
        server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
        target: serverEntry.target,
        coverage: {
          effectiveRole: 'participant',
          historyCutoffAt: 0,
          nextCoverageRecheckAt: null,
          coveringShareIds: [serverEntry.id],
          primaryShareId: serverEntry.id,
          authorizedAt: Date.now(),
        },
        sessions: [
          { sessionName: 'deck_beta_brain', title: 'Shared Beta', state: 'running', agentType: 'codex-sdk' },
          { sessionName: 'deck_gamma_brain', title: 'Shared Gamma', state: 'running', agentType: 'codex-sdk' },
        ],
        subSessions: [],
      });
    });

    const { App } = await importApp();
    render(<App />);
    fireEvent.click((await screen.findByText('Whole Shared Server')).closest('button')!);
    await waitFor(() => expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-whole-server',
    ));

    await navigateExternally('/#/srv-late/deck_late_brain?shared=share-late-session-route');
    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledWith(lateEntry.target));

    fireEvent.click(screen.getByText('tabs-select-deck_gamma_brain'));
    await waitFor(() => expect(window.location.hash).toBe(
      '#/srv-shared/deck_gamma_brain?shared=share-whole-server',
    ));

    await act(async () => {
      resolveLate({
        server: { id: 'srv-late', name: 'Late Server', status: 'online', lastHeartbeatAt: Date.now() },
        target: lateEntry.target,
        coverage: {
          effectiveRole: 'participant',
          historyCutoffAt: 0,
          nextCoverageRecheckAt: null,
          coveringShareIds: [lateEntry.id],
          primaryShareId: lateEntry.id,
          authorizedAt: Date.now(),
        },
        sessions: [{ sessionName: 'deck_late_brain', title: 'Late Session', state: 'running', agentType: 'codex-sdk' }],
        subSessions: [],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.location.hash).toBe('#/srv-shared/deck_gamma_brain?shared=share-whole-server');
    expect(screen.queryByTestId('session-pane-deck_late_brain')).toBeNull();
  }, 20_000);

  it('retires a main-share route when the desktop SessionTree selects another session on that server', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-main-desktop',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    } as const;
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue({
      ...sharedMainOpenResult(sharedEntry.id, 'dispatch-main-desktop'),
      sessions: [
        { sessionName: 'deck_beta_brain', title: 'Shared Beta', state: 'running', agentType: 'codex-sdk' },
        { sessionName: 'deck_gamma_brain', title: 'Shared Gamma', state: 'running', agentType: 'codex-sdk' },
      ],
    });
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') return serverList();
      if (path === '/api/server/srv-1/sessions') return sessionList();
      if (path === '/api/server/srv-shared/sessions') return { sessions: [] };
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    const { App } = await importApp();
    render(<App />);
    fireEvent.click((await screen.findByText('Shared Beta')).closest('button')!);
    await waitFor(() => expect(window.location.hash).toBe(
      '#/srv-shared/deck_beta_brain?shared=share-main-desktop',
    ));

    fireEvent.click(screen.getByText('tree-select-session-deck_gamma_brain'));

    await waitFor(() => expect(window.location.hash).toBe('#/srv-shared/deck_gamma_brain'));
    const { readSharedTabRestoreMarker } = await import('../src/shared-tab-restore.js');
    const { readTabRouteState } = await import('../src/hooks/useHashState.js');
    expect(readSharedTabRestoreMarker()).toBeNull();
    expect(readTabRouteState()).toEqual({
      serverId: 'srv-shared',
      sessionName: 'deck_gamma_brain',
      sharedEntryId: null,
    });
    await waitFor(() => expect(wsInstances.at(-1)?.options?.shareTarget ?? null).toBeNull());
  }, 20_000);

  it('makes the mobile SessionTree click outrank a stale shared open and closes its sidebar', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
    try {
      localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
      localStorage.setItem('rcc_server', 'srv-1');
      localStorage.setItem('rcc_session', 'deck_alpha_brain');
      const serverEntry = {
        id: 'share-mobile-server',
        serverId: 'srv-shared',
        serverName: 'Shared Server',
        role: 'participant',
        status: 'active',
        targetLabel: 'Whole Mobile Server',
        target: { kind: 'server', serverId: 'srv-shared' },
      } as const;
      const lateEntry = {
        id: 'share-mobile-late',
        serverId: 'srv-late',
        serverName: 'Late Server',
        role: 'participant',
        status: 'active',
        targetLabel: 'Late Mobile Session',
        target: { kind: 'main', serverId: 'srv-late', sessionName: 'deck_late_brain' },
      } as const;
      discoverSharedEntriesMock.mockResolvedValue([serverEntry, lateEntry]);
      let resolveLate!: (value: unknown) => void;
      openSharedEntryMock.mockImplementation((target: { serverId: string }) => {
        if (target.serverId === 'srv-late') {
          return new Promise((resolve) => { resolveLate = resolve; });
        }
        return Promise.resolve({
          server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
          target: serverEntry.target,
          coverage: {
            effectiveRole: 'participant', historyCutoffAt: 0, nextCoverageRecheckAt: null,
            coveringShareIds: [serverEntry.id], primaryShareId: serverEntry.id, authorizedAt: Date.now(),
          },
          sessions: [
            { sessionName: 'deck_beta_brain', title: 'Shared Beta', state: 'running', agentType: 'codex-sdk' },
            { sessionName: 'deck_gamma_brain', title: 'Shared Gamma', state: 'running', agentType: 'codex-sdk' },
          ],
          subSessions: [],
        });
      });

      const { App } = await importApp();
      const view = render(<App />);
      await waitFor(() => expect(wsInstances.length).toBeGreaterThan(0));
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-toggle')).toBeTruthy());
      fireEvent.click(view.container.querySelector('.mobile-sidebar-toggle')!);
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-overlay.open')).toBeTruthy());
      fireEvent.click((await screen.findByText('Whole Mobile Server')).closest('button')!);
      await waitFor(() => expect(window.location.hash).toBe(
        '#/srv-shared/deck_beta_brain?shared=share-mobile-server',
      ));

      await navigateExternally('/#/srv-late/deck_late_brain?shared=share-mobile-late');
      await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledWith(lateEntry.target));
      fireEvent.click(view.container.querySelector('.mobile-sidebar-toggle')!);
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-overlay.open')).toBeTruthy());
      fireEvent.click(screen.getByText('tree-select-session-deck_gamma_brain'));
      await waitFor(() => expect(view.container.querySelector('.mobile-sidebar-overlay.open')).toBeNull());
      await waitFor(() => expect(window.location.hash).toBe(
        '#/srv-shared/deck_gamma_brain?shared=share-mobile-server',
      ));

      await act(async () => {
        resolveLate({
          server: { id: 'srv-late', name: 'Late Server', status: 'online', lastHeartbeatAt: Date.now() },
          target: lateEntry.target,
          coverage: {
            effectiveRole: 'participant', historyCutoffAt: 0, nextCoverageRecheckAt: null,
            coveringShareIds: [lateEntry.id], primaryShareId: lateEntry.id, authorizedAt: Date.now(),
          },
          sessions: [{ sessionName: 'deck_late_brain', title: 'Late Session', state: 'running', agentType: 'codex-sdk' }],
          subSessions: [],
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(window.location.hash).toBe('#/srv-shared/deck_gamma_brain?shared=share-mobile-server');
      expect(screen.queryByTestId('session-pane-deck_late_brain')).toBeNull();
    } finally {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalUserAgent });
    }
  }, 20_000);

  it('treats duplicate hashchange/popstate for one navigation as a single idempotent move', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-idem',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-idem', 'dispatch-idem'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');
    const openCallsAfterRestore = openSharedEntryMock.mock.calls.length;

    await navigateExternally('/#/srv-1/deck_alpha_brain');
    // Fire the pair again for the SAME route: must be a no-op.
    await navigateExternally('/#/srv-1/deck_alpha_brain');

    expect(await screen.findByTestId('session-pane-deck_alpha_brain')).toBeTruthy();
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    // No extra share-open was attempted by the repeated events.
    expect(openSharedEntryMock.mock.calls.length).toBe(openCallsAfterRestore);
  }, 20_000);

  it('fails closed on an unauthorized route and does not keep the privileged shared pane', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-unauth',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-unauth', 'dispatch-unauth'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    // A server this account has neither ownership of nor a share for.
    await navigateExternally('/#/srv-not-mine/deck_secret');

    expect(
      screen.queryByTestId('session-pane-deck_beta_brain'),
      'a privileged shared pane survived a route that does not authorize it',
    ).toBeNull();
    expect(screen.queryByTestId('session-pane-deck_secret')).toBeNull();
  }, 20_000);

  /**
   * RED — opening a share must not turn its server into an owned one.
   *
   * `handleOpenSharedEntry` merges the shared server into `servers`
   * ([nextServer, ...prev]), so after one successful open that id is
   * indistinguishable from a server this account actually owns. Any ownership
   * check written as `servers.find(...)` therefore starts returning a hit for a
   * shared server, and a later visit to that route takes the owned branch and
   * never calls /api/shares/open — the coverage check is skipped entirely, so a
   * revoked or expired share still renders.
   *
   * The assertion that matters is the AUTHORITY CALL, not the pane: checking
   * only that a pane is absent is satisfied by merely having navigated
   * elsewhere, which is how the previous version of this test passed while the
   * bypass was live.
   */
  it('re-checks share authority when revisiting a previously opened shared server', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-revoked',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-revoked', 'dispatch-revoked'));

    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    // Leave for an owned server. srv-shared is now sitting in `servers`.
    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await screen.findByTestId('session-pane-deck_alpha_brain');

    // The share is revoked server-side.
    openSharedEntryMock.mockClear();
    openSharedEntryMock.mockRejectedValue(new Error('share_revoked'));

    await navigateExternally('/#/srv-shared/deck_beta_brain?shared=share-revoked');

    expect(
      openSharedEntryMock.mock.calls.length,
      'revisiting a shared route must re-run the /api/shares/open coverage check exactly once',
    ).toBe(1);
    expect(
      screen.queryByTestId('session-pane-deck_beta_brain'),
      'a revoked share must not render',
    ).toBeNull();
  }, 20_000);

  it('re-checks authority for a viewer role revisit, and fails closed when it expires', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-viewer',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'viewer',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-viewer', 'dispatch-viewer'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await screen.findByTestId('session-pane-deck_alpha_brain');

    openSharedEntryMock.mockClear();
    openSharedEntryMock.mockRejectedValue(new Error('share_expired'));
    await navigateExternally('/#/srv-shared/deck_beta_brain?shared=share-viewer');

    expect(openSharedEntryMock.mock.calls.length).toBe(1);
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
  }, 20_000);

  it('re-checks authority for a cross-user share id on a previously opened server', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-mine',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-mine', 'dispatch-mine'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await screen.findByTestId('session-pane-deck_alpha_brain');

    // Someone else's share id, aimed at a server this tab has already opened.
    openSharedEntryMock.mockClear();
    openSharedEntryMock.mockRejectedValue(new Error('not_covered'));
    await navigateExternally('/#/srv-shared/deck_beta_brain?shared=share-someone-else');

    expect(
      openSharedEntryMock.mock.calls.length,
      'a foreign share id must still be adjudicated by the server, exactly once',
    ).toBe(1);
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
  }, 20_000);

  it('does not let a late authority result for an abandoned shared route render', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-race',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValueOnce(sharedMainOpenResult('share-race', 'dispatch-race'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await screen.findByTestId('session-pane-deck_alpha_brain');

    // Revisit the shared route but hold the authority response open...
    let resolveLate!: (v: ReturnType<typeof sharedMainOpenResult>) => void;
    openSharedEntryMock.mockClear();
    openSharedEntryMock.mockImplementationOnce(() => new Promise((r) => { resolveLate = r; }));
    await navigateExternally('/#/srv-shared/deck_beta_brain?shared=share-race');
    expect(openSharedEntryMock.mock.calls.length).toBe(1);

    // ...and move away again before it settles.
    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await act(async () => {
      resolveLate?.(sharedMainOpenResult('share-race', 'dispatch-race-late'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.queryByTestId('session-pane-deck_beta_brain'),
      'a late authority result for an abandoned route must not render',
    ).toBeNull();
    expect(screen.queryByTestId('session-pane-deck_alpha_brain')).not.toBeNull();
  }, 20_000);

  it('converges on the final route through a rapid A to B to A sequence', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-rapid',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult('share-rapid', 'dispatch-rapid'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await navigateExternally('/#/srv-shared/deck_beta_brain?shared=share-rapid');
    await navigateExternally('/#/srv-1/deck_alpha_brain');

    expect(await screen.findByTestId('session-pane-deck_alpha_brain')).toBeTruthy();
    expect(screen.queryByTestId('session-pane-deck_beta_brain')).toBeNull();
    expect(window.location.hash).toContain('srv-1');
  }, 20_000);

  it('does not let a late share-open settle over a newer external navigation', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    const sharedEntry = {
      id: 'share-late',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    let resolveLate!: (value: ReturnType<typeof sharedMainOpenResult>) => void;
    openSharedEntryMock.mockResolvedValueOnce(sharedMainOpenResult('share-late', 'dispatch-late'));
    const { App } = await importApp();
    render(<App />);
    await screen.findByTestId('session-pane-deck_beta_brain');

    // Navigate back to the shared route, but hold the share-open open.
    openSharedEntryMock.mockImplementationOnce(() => new Promise((resolve) => { resolveLate = resolve; }));
    await navigateExternally('/#/srv-shared/deck_beta_brain?shared=share-late');
    // ...then move on to an owned server before it settles.
    await navigateExternally('/#/srv-1/deck_alpha_brain');
    await screen.findByTestId('session-pane-deck_alpha_brain');

    await act(async () => {
      resolveLate?.(sharedMainOpenResult('share-late', 'dispatch-late-2'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.queryByTestId('session-pane-deck_beta_brain'),
      'a stale share-open won over a newer explicit navigation',
    ).toBeNull();
    expect(screen.queryByTestId('session-pane-deck_alpha_brain')).not.toBeNull();
  }, 20_000);

  it('restores a shared tab from the URL hash instead of falling back to an owned tab', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_server_name', 'Alpha Server');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, open: true, width: 584 }));
    const sharedEntry = {
      id: 'share-refresh-1',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    };
    let resolveSharedEntries!: (entries: unknown[]) => void;
    discoverSharedEntriesMock.mockImplementation(() => new Promise((resolve) => {
      resolveSharedEntries = resolve;
    }));
    openSharedEntryMock.mockResolvedValue({
      server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
      target: sharedEntry.target,
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-refresh-1'],
        primaryShareId: 'share-refresh-1',
        authorizedAt: Date.now(),
      },
      sessions: [{
        sessionName: 'deck_beta_brain',
        title: 'Shared Beta',
        state: 'running',
        agentType: 'codex-sdk',
        activeDispatchId: 'dispatch-refresh-1',
      }],
      subSessions: [],
    });

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/server'));
    await waitFor(() => expect(discoverSharedEntriesMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.location.hash).toBe('#/srv-shared/deck_beta_brain');
    expect(openSharedEntryMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveSharedEntries([sharedEntry]);
      await Promise.resolve();
    });
    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));
    expect(openSharedEntryMock).toHaveBeenCalledWith(sharedEntry.target);
    const sharedPane = await screen.findByTestId('session-pane-deck_beta_brain');
    expect(sharedPane.getAttribute('data-active-dispatch-id')).toBe('dispatch-refresh-1');
    expect(window.location.hash).toBe('#/srv-shared/deck_beta_brain?shared=share-refresh-1');
    expect(screen.queryByTestId('session-pane-deck_alpha_brain')).toBeNull();
    expect(screen.queryByTestId('shared-return-guide')).toBeNull();
    await waitFor(() => {
      expect(wsInstances.some((instance) => instance.options?.shareTarget === sharedEntry.target)).toBe(true);
    });
    expect(screen.getByRole('complementary', { name: 'supervision_task_console.title' }).getAttribute('data-read-only')).toBe('false');
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/server/srv-shared/sessions', expect.anything());
  }, 20_000);

  it('keeps the shared-main task console visible but read-only for a viewer', async () => {
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    localStorage.setItem('rcc_session', 'deck_alpha_brain');
    localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, open: true, width: 584 }));
    const sharedEntry = {
      id: 'share-task-console-viewer',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'viewer',
      status: 'active',
      targetLabel: 'Shared Viewer Brain',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    } as const;
    discoverSharedEntriesMock.mockResolvedValue([sharedEntry]);
    openSharedEntryMock.mockResolvedValue(sharedMainOpenResult(
      'share-task-console-viewer',
      'dispatch-task-console-viewer',
      'viewer',
    ));

    const { App } = await importApp();
    render(<App />);

    fireEvent.click((await screen.findByText('Shared Viewer Brain')).closest('button')!);
    expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('complementary', { name: 'supervision_task_console.title' }).getAttribute('data-read-only')).toBe('true');
    });
    expect(screen.getAllByRole('button', { name: 'supervision_task_console.toggle' }).length).toBeGreaterThan(0);
  }, 20_000);

  it('restores the exact shared tab after refresh even when its server is also in the server list', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain?shared=share-refresh-exact');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-shared');
    localStorage.setItem('rcc_server_name', 'Shared Server');
    localStorage.setItem('rcc_session', 'deck_beta_brain');
    const sharedEntry = {
      id: 'share-refresh-exact',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'participant',
      status: 'active',
      targetLabel: 'Shared Beta',
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
    } as const;
    const otherEntry = {
      id: 'share-refresh-server',
      serverId: 'srv-shared',
      serverName: 'Shared Server',
      role: 'viewer',
      status: 'active',
      targetLabel: 'Whole Shared Server',
      target: { kind: 'server', serverId: 'srv-shared' },
    } as const;
    discoverSharedEntriesMock.mockResolvedValue([otherEntry, sharedEntry]);
    openSharedEntryMock.mockResolvedValue({
      server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
      target: sharedEntry.target,
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-refresh-exact'],
        primaryShareId: 'share-refresh-exact',
        authorizedAt: Date.now(),
      },
      sessions: [{
        sessionName: 'deck_beta_brain',
        title: 'Shared Beta',
        state: 'running',
        agentType: 'codex-sdk',
        activeDispatchId: 'dispatch-refresh-exact',
      }],
      subSessions: [],
    });
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') {
        return {
          servers: [
            ...serverList().servers,
            {
              id: 'srv-shared',
              name: 'Shared Server',
              status: 'online',
              lastHeartbeatAt: Date.now(),
              createdAt: Date.now(),
              daemonVersion: '2026.8.24',
            },
          ],
        };
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      if (path === '/api/server/srv-shared/sessions') return sessionList();
      return {};
    });

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledTimes(1));
    expect(openSharedEntryMock).toHaveBeenCalledWith(sharedEntry.target);
    expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
    expect(screen.queryByTestId('session-pane-deck_alpha_brain')).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/server/srv-shared/sessions', expect.anything());
    await waitFor(() => {
      expect(wsInstances.some((instance) => instance.options?.shareTarget === sharedEntry.target)).toBe(true);
    });
  }, 20_000);

  it('restores an explicit shared URL even when the shared inventory is temporarily empty', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain?shared=share-url-only');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    discoverSharedEntriesMock.mockResolvedValue([]);
    openSharedEntryMock.mockResolvedValue({
      server: { id: 'srv-shared', name: 'Shared Server', status: 'online', lastHeartbeatAt: Date.now() },
      target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_beta_brain' },
      coverage: {
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['share-url-only'],
        primaryShareId: 'share-url-only',
        authorizedAt: Date.now(),
      },
      sessions: [{
        sessionName: 'deck_beta_brain',
        title: 'Shared Beta',
        state: 'running',
        agentType: 'codex-sdk',
        activeDispatchId: 'dispatch-url-only',
      }],
      subSessions: [],
    });

    const { App } = await importApp();
    render(<App />);

    await waitFor(() => expect(openSharedEntryMock).toHaveBeenCalledWith({
      kind: 'main',
      serverId: 'srv-shared',
      sessionName: 'deck_beta_brain',
    }));
    expect(await screen.findByTestId('session-pane-deck_beta_brain')).toBeTruthy();
    expect(window.location.hash).toBe('#/srv-shared/deck_beta_brain?shared=share-url-only');
    expect(screen.queryByText('dashboard-page')).toBeNull();
  }, 20_000);

  it('keeps the explicit shared URL instead of jumping home when restore temporarily fails', async () => {
    history.replaceState(null, '', '/#/srv-shared/deck_beta_brain?shared=share-retry');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    discoverSharedEntriesMock.mockResolvedValue([]);
    openSharedEntryMock.mockRejectedValue(new Error('temporary shared restore failure'));

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByText('temporary shared restore failure')).toBeTruthy();
    expect(window.location.hash).toBe('#/srv-shared/deck_beta_brain?shared=share-retry');
    expect(screen.queryByText('dashboard-page')).toBeNull();
  }, 20_000);

  it('does not wait for shared-entry discovery when the hash points to an owned server', async () => {
    history.replaceState(null, '', '/#/srv-1/deck_alpha_brain');
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    discoverSharedEntriesMock.mockImplementation(() => new Promise(() => {}));

    const { App } = await importApp();
    render(<App />);

    expect(await screen.findByTestId('session-pane-deck_alpha_brain')).toBeTruthy();
    await waitFor(() => expect(wsInstances.some((instance) => !instance.options?.shareTarget)).toBe(true));
    expect(window.location.hash).toBe('#/srv-1/deck_alpha_brain');
    expect(openSharedEntryMock).not.toHaveBeenCalled();
  }, 20_000);
});
