/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { P2P_WORKFLOW_MSG } from '@shared/p2p-workflow-messages.js';

const {
  apiFetchMock,
  fetchMeMock,
  listP2pRunsMock,
  wsInstances,
  useSubSessionsState,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  fetchMeMock: vi.fn(),
  listP2pRunsMock: vi.fn(),
  wsInstances: [] as Array<{
    connected: boolean;
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
    clearApiKey: vi.fn(),
    configure: vi.fn(),
    configureApiKey: vi.fn(),
    fetchMe: (...args: unknown[]) => fetchMeMock(...args),
    getApiKey: vi.fn(() => 'api-key-1'),
    listP2pRuns: (...args: unknown[]) => listP2pRunsMock(...args),
    normalizeLocalWebPreviewPath: (path: string) => path.startsWith('/') ? path : `/${path}`,
    onAuthExpired: vi.fn(),
    refreshSessionIfStale: vi.fn(),
    startProactiveRefresh: vi.fn(),
    stopProactiveRefresh: vi.fn(),
  };
});

vi.mock('../src/native.js', () => ({
  clearServerUrl: vi.fn(),
  getServerUrl: vi.fn(async () => null),
  isNative: vi.fn(() => false),
}));

vi.mock('../src/biometric-auth.js', () => ({
  clearAuthKey: vi.fn(async () => undefined),
  getAuthKey: vi.fn(async () => null),
}));

vi.mock('../src/push-notifications.js', () => ({
  initPushNotifications: vi.fn(async () => undefined),
  resetPushBadge: vi.fn(async () => undefined),
}));

vi.mock('../src/ws-client.js', () => ({
  WsClient: class MockWsClient {
    connected = false;
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

    constructor() {
      wsInstances.push(this);
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
    useSyncedPreference: (_key: string, initial: unknown) => useState(initial),
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
}));

vi.mock('../src/components/ErrorBoundary.js', () => ({
  ErrorBoundary: ({ children }: { children?: unknown }) => children,
}));

vi.mock('../src/components/LanguageSwitcher.js', () => ({ LanguageSwitcher: textComponent('language-switcher') }));
vi.mock('../src/pages/LoginPage.js', () => ({ LoginPage: textComponent('login-page') }));
vi.mock('../src/pages/ServerSetupPage.js', () => ({ ServerSetupPage: textComponent('server-setup-page') }));
vi.mock('../src/pages/NativeAuthBridge.js', () => ({ NativeAuthBridge: textComponent('native-auth-bridge') }));
vi.mock('../src/pages/DashboardPage.js', () => ({ DashboardPage: textComponent('dashboard-page') }));
vi.mock('../src/pages/DiscussionsPage.js', () => ({ DiscussionsPage: textComponent('discussions-page') }));
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
  ServerIconBar: ({ servers, onSelectServer, onSettings, onAdmin, onHome, onToggleSidebar, onServerContextMenu }: any) => (
    <div>
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
    <div>
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
    onRenameSession,
    onScrollBottomFn,
    onSettings,
    onStopProject,
    onTransportConfigSaved,
  }: any) => (
    <div>
      session-pane:{session.name}
      <button onClick={() => onFitFn?.(vi.fn())}>pane-fit-ref</button>
      <button onClick={() => onScrollBottomFn?.(vi.fn())}>pane-scroll-ref</button>
      <button onClick={() => onFocusFn?.(vi.fn())}>pane-focus-ref</button>
      <button onClick={() => onChatScrollFn?.(vi.fn())}>pane-chat-ref</button>
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
    </div>
  ),
}));
vi.mock('../src/components/SubSessionBar.js', () => ({
  SUBSESSION_BAR_COLLAPSED_STORAGE_KEY: 'subsession_bar_collapsed',
  SubSessionBar: ({ onCollapsedChange, onNew, onOpen, onOpenMaximized, onViewCron, onViewDiscussions, onViewDiscussion, onViewRepo, onStopDiscussion, subSessions, discussions = [], totalRunningDiscussions = 0 }: any) => (
    <div data-testid="app-shell-subsession-bar" data-running-discussions={String(totalRunningDiscussions)}>
      sub-session-bar
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
      <button onClick={() => onOpenMaximized?.(subSessions?.[0]?.id)}>subbar-open-max</button>
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
  SubSessionWindow: ({ sub, active, zIndex, onFocus, onViewRepo }: any) => (
    <div
      data-testid={`sub-session-window-${sub?.id}`}
      data-active={String(active)}
      style={{ zIndex }}
      onMouseDown={onFocus}
    >
      sub-session-window
      <button onClick={onViewRepo}>sub-window-repo-{sub?.id}</button>
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
  StartSubSessionDialog: ({ onClose, onStart }: any) => (
    <div>
      start-sub-session-dialog
      <button onClick={() => void onStart?.('codex-sdk', '/bin/bash', '/work/alpha', 'Helper', {})}>start-sub-start</button>
      <button onClick={onClose}>start-sub-close</button>
    </div>
  ),
}));
vi.mock('../src/components/SessionSettingsDialog.js', () => ({
  SessionSettingsDialog: ({ onClose, onSaved }: any) => (
    <div>
      session-settings-dialog
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
  AskQuestionDialog: ({ onDismiss, onSubmit }: any) => (
    <div>
      ask-question-dialog
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
  LocalWebPreviewPanel: ({ onDraftChange }: any) => (
    <div>
      local-web-preview
      <button onClick={() => onDraftChange?.({ port: '5173', path: '/app' })}>preview-draft</button>
    </div>
  ),
}));
vi.mock('../src/components/file-browser-lazy.js', () => ({
  FileBrowser: ({ onClose, onConfirm, onPreviewStateChange }: any) => (
    <div>
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

async function getActiveWsClient() {
  await waitFor(() => {
    expect(wsInstances.some((instance) => instance.messageHandlers.length > 0)).toBe(true);
  });
  return wsInstances.findLast((instance) => instance.messageHandlers.length > 0) ?? wsInstances[wsInstances.length - 1];
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  wsInstances.length = 0;
  useSubSessionsState.subSessions = [];
  useSubSessionsState.visibleSubSessions = [];
  useSubSessionsState.loadedServerId = 'srv-1';
  fetchMeMock.mockResolvedValue({
    id: 'user-1',
    is_admin: true,
    display_name: 'Ada',
    username: 'ada',
    has_password: true,
  });
  listP2pRunsMock.mockResolvedValue([]);
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
  it('renders the login page when session verification fails', async () => {
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
    expect(apiFetchMock).toHaveBeenCalledWith('/api/auth/user/me');
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
    expect(ws.connect).toHaveBeenCalled();
  }, 20_000);

  it('clears stale P2P progress from the session bar when a full status response has no active runs', async () => {
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
      expect(screen.queryByTestId('app-shell-p2p-discussion-p2p_run-status-bar')).toBeNull();
      expect(screen.getByTestId('app-shell-subsession-bar').getAttribute('data-running-discussions')).toBe('0');
    });
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

  it('closes all open sub-session windows when clicking the active main session tab', async () => {
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

    fireEvent.click(screen.getByText('tabs-select'));

    await waitFor(() => {
      expect(screen.queryByTestId('sub-session-window-sub-1')).toBeNull();
      expect(screen.queryByTestId('sub-session-window-sub-2')).toBeNull();
      expect(localStorage.getItem('rcc_open_subs_deck_alpha_brain')).toBeNull();
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
    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-3').getAttribute('data-active')).toBe('true');
    });
    expect(screen.getByTestId('sub-session-window-sub-1').getAttribute('data-active')).toBe('false');
    expect(screen.getByTestId('sub-session-window-sub-2').getAttribute('data-active')).toBe('false');

    // Re-activating an older window flips active over to it (and only it).
    fireEvent.mouseDown(screen.getByTestId('sub-session-window-sub-1'));
    await waitFor(() => {
      expect(screen.getByTestId('sub-session-window-sub-1').getAttribute('data-active')).toBe('true');
    });
    expect(screen.getByTestId('sub-session-window-sub-3').getAttribute('data-active')).toBe('false');
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
});
