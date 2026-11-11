/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import type { SessionInfo } from '../../src/types.js';
import type { SharedPayload } from '../../src/services/share-receiver.js';

const {
  uploadFileWithDirectFallbackMock,
  apiFetchMock,
  fetchMeMock,
  shareReceiverProbe,
  composerHydrationGate,
  wsSendSessionCommandMock,
  wsSendMock,
} = vi.hoisted(() => ({
  uploadFileWithDirectFallbackMock: vi.fn(),
  apiFetchMock: vi.fn(),
  fetchMeMock: vi.fn(),
  shareReceiverProbe: {
    listener: null as ((payload: SharedPayload) => void) | null,
  },
  composerHydrationGate: {
    ready: true,
    listeners: new Set<() => void>(),
  },
  wsSendSessionCommandMock: vi.fn(),
  wsSendMock: vi.fn(),
}));

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en', changeLanguage: vi.fn() },
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'shareTarget.files_summary') return `Shared files (${opts?.count ?? 0})`;
      if (key === 'shareTarget.error.file_too_large') return `Exceeds ${opts?.max ?? 50} MB`;
      if (key === 'shareTarget.error.read_failed') return 'Read failed';
      return key;
    },
  }),
}));

vi.mock('../../src/direct-file-transfer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/direct-file-transfer.js')>();
  return {
    ...actual,
    prewarmDirectFileLease: vi.fn(() => undefined),
    uploadFileWithDirectFallback: (...args: unknown[]) => uploadFileWithDirectFallbackMock(...args),
  };
});

vi.mock('../../src/services/share-receiver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/share-receiver.js')>();
  return {
    ...actual,
    subscribeShareReceiver: (handler: (payload: SharedPayload) => void) => {
      shareReceiverProbe.listener = handler;
      return () => {
        if (shareReceiverProbe.listener === handler) {
          shareReceiverProbe.listener = null;
        }
      };
    },
  };
});

vi.mock('../../src/api.js', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body?: unknown) {
      super(`api ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  class SharedOpenTimeoutError extends Error {}
  return {
    ApiError,
    SharedOpenTimeoutError,
    DEFAULT_SHARED_ENTRY_OPEN_TIMEOUT_MS: 15_000,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    clearApiKey: vi.fn(),
    configure: vi.fn(),
    configureExpectedUserId: vi.fn(),
    configureApiKey: vi.fn(),
    discoverSharedEntries: vi.fn(async () => []),
    fetchMe: (...args: unknown[]) => fetchMeMock(...args),
    getApiKey: vi.fn(() => 'api-key-1'),
    listManagedSharesForServer: vi.fn(async () => []),
    listP2pRuns: vi.fn(async () => []),
    normalizeLocalWebPreviewPath: (p: string) => (p.startsWith('/') ? p : `/${p}`),
    openSharedEntry: vi.fn(),
    onAuthExpired: vi.fn(),
    refreshSessionIfStale: vi.fn(),
    startProactiveRefresh: vi.fn(),
    stopProactiveRefresh: vi.fn(),
  };
});

vi.mock('../../src/native.js', () => ({
  clearServerUrl: vi.fn(async () => undefined),
  getServerUrl: vi.fn(async () => null),
  isNative: vi.fn(() => false),
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: vi.fn(async () => undefined), setBackgroundColor: vi.fn(async () => undefined) },
  Style: { Dark: 'DARK' },
}));

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => undefined) },
}));

vi.mock('../../src/biometric-auth.js', () => ({
  clearAuthKey: vi.fn(async () => undefined),
  clearAuthKeyId: vi.fn(async () => undefined),
  getAuthKey: vi.fn(async () => null),
  getAuthKeyId: vi.fn(async () => null),
  initializeServerScopedAuth: vi.fn(async () => undefined),
}));

vi.mock('../../src/push-notifications.js', () => ({
  initPushNotifications: vi.fn(async () => undefined),
  resetPushBadge: vi.fn(async () => undefined),
}));

vi.mock('../../src/ws-client.js', () => ({
  WsClient: class MockWsClient {
    connected = true;
    connectionAttemptInFlight = false;
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
    sendSessionCommand = wsSendSessionCommandMock;
    send = wsSendMock;
    p2pListDiscussions = vi.fn();
    p2pStatus = vi.fn();
    discussionList = vi.fn();
    discussionStop = vi.fn();
    askAnswer = vi.fn();
    sendSessionMessage = vi.fn();
    repoDetect = vi.fn();
    resumeConnection = vi.fn();
    reconnectNow = vi.fn();
    getDaemonCapabilitySnapshot = () => null;
    onDaemonCapabilitySnapshot = () => () => {};
    onMessage = () => () => {};
    onLatency = () => {};
  },
}));

vi.mock('../../src/hooks/useSubSessions.js', () => ({
  useSubSessions: () => ({
    subSessions: [],
    visibleSubSessions: [],
    loadedServerId: 'srv-1',
    create: vi.fn(async () => null),
    close: vi.fn(),
    hydrateShared: vi.fn(),
    restart: vi.fn(),
    rename: vi.fn(),
    updateLocal: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useProviderStatus.js', () => ({
  useProviderStatus: () => ({
    isProviderConnected: () => true,
    getRemoteSessions: vi.fn(async () => []),
    refreshSessions: vi.fn(async () => undefined),
  }),
}));

vi.mock('../../src/hooks/useUnreadCounts.js', () => ({
  useUnreadCounts: () => new Map(),
}));

vi.mock('../../src/hooks/usePref.js', () => ({
  parseString: (value: unknown) => String(value),
  parseBooleanish: (value: unknown) => value === true,
  usePref: () => ({ loaded: true, value: '/bin/bash' }),
}));

vi.mock('../../src/hooks/useSyncedPreference.js', async () => {
  const { useState } = await vi.importActual<typeof import('preact/hooks')>('preact/hooks');
  return {
    useSyncedPreference: (_key: string, initial: unknown) => {
      const [value, setValue] = useState(initial);
      return [value, setValue, true];
    },
  };
});

vi.mock('../../src/git-status-store.js', () => ({
  requestSharedChanges: vi.fn(),
  useSharedGitChanges: () => [],
}));

vi.mock('../../src/watch-bridge.js', () => ({
  onWatchCommand: vi.fn(async () => vi.fn()),
}));

vi.mock('../../src/watch-projection.js', () => ({
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

vi.mock('../../src/hooks/useTimeline.js', () => ({
  ingestTimelineEventForCache: vi.fn(),
  requestActiveTimelineRefresh: vi.fn(),
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
}));

vi.mock('../../src/components/ErrorBoundary.js', () => ({
  ErrorBoundary: ({ children }: { children?: unknown }) => children,
}));

function noopComponent(label: string) {
  return () => label;
}
vi.mock('../../src/components/LanguageSwitcher.js', () => ({ LanguageSwitcher: noopComponent('language-switcher') }));
vi.mock('../../src/pages/LoginPage.js', () => ({ LoginPage: noopComponent('login-page') }));
vi.mock('../../src/pages/ServerSetupPage.js', () => ({ ServerSetupPage: noopComponent('server-setup-page') }));
vi.mock('../../src/pages/NativeAuthBridge.js', () => ({ NativeAuthBridge: noopComponent('native-auth-bridge') }));
vi.mock('../../src/pages/DashboardPage.js', () => ({ DashboardPage: noopComponent('dashboard-page') }));
vi.mock('../../src/pages/DiscussionsPage.js', () => ({ DiscussionsPage: noopComponent('discussions-page') }));
vi.mock('../../src/pages/RepoPage.js', () => ({ RepoPage: noopComponent('repo-page') }));
vi.mock('../../src/pages/SettingsPage.js', () => ({ SettingsPage: noopComponent('settings-page') }));
vi.mock('../../src/pages/AdminPage.js', () => ({ AdminPage: noopComponent('admin-page') }));
vi.mock('../../src/pages/CronManager.js', () => ({ CronManager: noopComponent('cron-manager') }));
vi.mock('../../src/components/ServerIconBar.js', () => ({ ServerIconBar: noopComponent('server-icon-bar') }));
vi.mock('../../src/components/Sidebar.js', () => ({
  Sidebar: ({ children }: { children?: unknown }) => h('div', null, children as any),
  loadSidebarCollapsed: vi.fn(() => false),
  saveSidebarCollapsed: vi.fn(),
}));
vi.mock('../../src/components/SessionTree.js', () => ({ SessionTree: noopComponent('session-tree') }));
vi.mock('../../src/components/SessionTabs.js', () => ({ SessionTabs: noopComponent('session-tabs') }));
vi.mock('../../src/components/SubSessionBar.js', () => ({
  SUBSESSION_BAR_COLLAPSED_STORAGE_KEY: 'subsession_bar_collapsed',
  SubSessionBar: noopComponent('sub-session-bar'),
}));
vi.mock('../../src/components/SubSessionWindow.js', () => ({ SubSessionWindow: noopComponent('sub-session-window') }));
vi.mock('../../src/components/ShareSessionDialog.js', () => ({ ShareSessionDialog: noopComponent('share-session-dialog') }));
vi.mock('../../src/components/DesktopWindowMaximizeButton.js', () => ({ DesktopWindowMaximizeButton: noopComponent('maximize-btn') }));
vi.mock('../../src/components/NewSessionDialog.js', () => ({ NewSessionDialog: noopComponent('new-session-dialog') }));
vi.mock('../../src/components/StartSubSessionDialog.js', () => ({ StartSubSessionDialog: noopComponent('start-sub-dialog') }));
vi.mock('../../src/components/SessionSettingsDialog.js', () => ({
  SessionSettingsDialog: noopComponent('session-settings-dialog'),
  SupervisionSettingsDialog: noopComponent('supervision-settings-dialog'),
}));
vi.mock('../../src/components/CloneSessionGroupDialog.js', () => ({ CloneSessionGroupDialog: noopComponent('clone-dialog') }));
vi.mock('../../src/components/StartDiscussionDialog.js', () => ({ StartDiscussionDialog: noopComponent('start-discussion-dialog') }));
vi.mock('../../src/components/AskQuestionDialog.js', () => ({ AskQuestionDialog: noopComponent('ask-question-dialog') }));
vi.mock('../../src/components/ServerContextMenu.js', () => ({
  DeleteServerDialog: noopComponent('delete-server-dialog'),
  ServerContextMenu: noopComponent('server-context-menu'),
}));
vi.mock('../../src/components/FloatingPanel.js', () => ({
  FloatingPanel: ({ children }: { children?: unknown }) => h('div', null, children as any),
}));
vi.mock('../../src/components/SharedContextManagementPanel.js', () => ({ SharedContextManagementPanel: noopComponent('shared-context') }));
vi.mock('../../src/components/ControlledNodesPanel.js', () => ({ ControlledNodesPanel: noopComponent('controlled-nodes') }));
vi.mock('../../src/components/ControlledNodeQuickMenu.js', () => ({ ControlledNodeQuickMenu: noopComponent('controlled-node-quick') }));
vi.mock('../../src/components/RemoteDesktopPanel.js', () => ({ RemoteDesktopPanel: noopComponent('remote-desktop-panel') }));
vi.mock('../../src/components/RemoteDesktopWorkspace.js', () => ({ RemoteDesktopWorkspace: noopComponent('remote-desktop-workspace') }));
vi.mock('../../src/components/RemoteDesktopWall.js', () => ({
  REMOTE_DESKTOP_WALL_WINDOW_ID: 'remote-desktop-wall',
  RemoteDesktopWall: noopComponent('remote-desktop-wall'),
}));
vi.mock('../../src/components/ContextDiagnosticsPanel.js', () => ({ ContextDiagnosticsPanel: noopComponent('context-diagnostics') }));
vi.mock('../../src/components/NewUserGuide.js', () => ({ NewUserGuide: noopComponent('new-user-guide') }));
vi.mock('../../src/components/P2pRingProgress.js', () => ({ P2pRingProgress: noopComponent('p2p-ring') }));
vi.mock('../../src/components/SidebarPinnedPanel.js', () => ({ SidebarPinnedPanel: noopComponent('sidebar-pinned') }));
vi.mock('../../src/components/LocalWebPreviewPanel.js', () => ({ LocalWebPreviewPanel: noopComponent('local-web-preview') }));
vi.mock('../../src/components/file-browser-lazy.js', () => ({ FileBrowser: noopComponent('file-browser') }));
vi.mock('../../src/components/pinnedPanelTypes.js', () => ({
  LOCAL_WEB_PREVIEW_PANEL_TYPE: 'local-web-preview',
  SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE: 'shared-context-diagnostics',
  SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE: 'shared-context-management',
}));

import { ShareTargetModal } from '../../src/components/ShareTargetModal.js';
import { SessionControls } from '../../src/components/SessionControls.js';

vi.mock('../../src/components/SessionPane.js', () => ({
  SessionPane: ({
    isActive,
    serverId,
    session,
    ws,
    connected,
    quickData,
    pendingSharedUpload,
    onPendingSharedUploadConsumed,
  }: any) => {
    const [, setTick] = useState(0);
    return (
      <div
        data-testid={`session-pane-${session.name}`}
        data-server-id={serverId ?? ''}
        data-is-active={String(Boolean(isActive))}
        data-pending-upload-id={pendingSharedUpload?.id ?? ''}
        data-pending-upload-files={pendingSharedUpload?.files?.map((f: File) => f.name).join(',') ?? ''}
        data-pending-upload-text={pendingSharedUpload?.text ?? ''}
      >
        <button
          type="button"
          data-testid={`hydrate-${session.name}`}
          onClick={() => {
            composerHydrationGate.ready = true;
            setTick((n) => n + 1);
          }}
        >
          hydrate
        </button>
        {composerHydrationGate.ready && isActive && (
          <SessionControls
            ws={ws}
            connected={connected}
            serverId={serverId}
            activeSession={session}
            quickData={quickData}
            pendingSharedUpload={pendingSharedUpload}
            onPendingSharedUploadConsumed={onPendingSharedUploadConsumed}
          />
        )}
      </div>
    );
  },
}));

import { App } from '../../src/app.js';

const makeSession = (overrides: Partial<SessionInfo> & { name: string }): SessionInfo => ({
  name: overrides.name,
  project: overrides.project ?? overrides.name,
  role: overrides.role ?? 'brain',
  agentType: overrides.agentType ?? 'claude-code-sdk',
  state: overrides.state ?? 'idle',
  label: overrides.label ?? null,
});

describe('ShareTargetModal & shared session attachment upload', () => {
  beforeEach(() => {
    uploadFileWithDirectFallbackMock.mockReset();
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('defaults to current selectedServerId, lists navigable main sessions with activeSession highlighted first, and supports server switching', () => {
    const file1 = new File(['hello'], 'doc.pdf', { type: 'application/pdf' });
    const file2 = new File(['world!'], 'photo.png', { type: 'image/png' });
    const payload: SharedPayload = {
      id: 'share-modal-1',
      files: [file1, file2],
      text: 'Shared caption text',
    };

    const servers = [
      { id: 'srv-1', name: 'Prod Server' },
      { id: 'srv-2', name: 'Dev Box' },
    ];

    const srv1Sessions: SessionInfo[] = [
      makeSession({ name: 'deck_alpha_brain', project: 'alpha', label: 'Alpha Main' }),
      makeSession({ name: 'deck_beta_brain', project: 'beta', label: 'Beta Main' }),
      makeSession({ name: 'deck_alpha_w1', project: 'alpha', role: 'w1' as SessionInfo['role'] }),
    ];

    const onSelectServer = vi.fn();
    const onSelectSession = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <ShareTargetModal
        payload={payload}
        servers={servers}
        selectedServerId="srv-1"
        sessions={srv1Sessions}
        activeSession="deck_beta_brain"
        onSelectServer={onSelectServer}
        onSelectSession={onSelectSession}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('share-target-files-section').textContent).toContain('Shared files (2)');
    expect(screen.getByTestId('share-target-file-list').textContent).toContain('doc.pdf');
    expect(screen.getByTestId('share-target-file-list').textContent).toContain('photo.png');
    expect(screen.getByTestId('share-target-text-preview').textContent).toContain('Shared caption text');

    const serverSelect = screen.getByTestId('share-target-server-select') as HTMLSelectElement;
    expect(serverSelect.value).toBe('srv-1');

    // Only navigable brain main sessions are listed, with activeSession placed first
    const sessionList = screen.getByTestId('share-target-session-list');
    const sessionButtons = sessionList.querySelectorAll('button');
    expect(sessionButtons).toHaveLength(2);
    expect(sessionButtons[0]?.getAttribute('data-testid')).toBe('share-target-session-deck_beta_brain');
    expect(sessionButtons[1]?.getAttribute('data-testid')).toBe('share-target-session-deck_alpha_brain');
    expect(screen.getByTestId('share-target-current-badge')).toBeDefined();

    // Switch server to srv-2
    fireEvent.change(serverSelect, { target: { value: 'srv-2' } });
    expect(onSelectServer).toHaveBeenCalledWith('srv-2');

    const srv2Sessions: SessionInfo[] = [
      makeSession({ name: 'deck_gamma_brain', project: 'gamma', label: 'Gamma Main' }),
    ];
    rerender(
      <ShareTargetModal
        payload={payload}
        servers={servers}
        selectedServerId="srv-2"
        sessions={srv2Sessions}
        activeSession={null}
        onSelectServer={onSelectServer}
        onSelectSession={onSelectSession}
        onClose={onClose}
      />,
    );

    const gammaBtn = screen.getByTestId('share-target-session-deck_gamma_brain');
    fireEvent.click(gammaBtn);
    expect(onSelectSession).toHaveBeenCalledWith('srv-2', 'deck_gamma_brain');
  });

  it('displays error banner and disables session selection when share has only an error', () => {
    const payload: SharedPayload = {
      id: 'share-err-1',
      files: [],
      error: 'file_too_large',
    };
    const onSelectSession = vi.fn();

    render(
      <ShareTargetModal
        payload={payload}
        servers={[{ id: 'srv-1', name: 'Prod Server' }]}
        selectedServerId="srv-1"
        sessions={[makeSession({ name: 'deck_alpha_brain', project: 'alpha' })]}
        activeSession="deck_alpha_brain"
        onSelectServer={vi.fn()}
        onSelectSession={onSelectSession}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('share-target-error').textContent).toContain('Exceeds 50 MB');
    const sessionBtn = screen.getByTestId('share-target-session-deck_alpha_brain') as HTMLButtonElement;
    expect(sessionBtn.disabled).toBe(true);
    fireEvent.click(sessionBtn);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('shows warning banner for partial_files_skipped while still allowing valid files to be shared', () => {
    const validFile = new File(['ok'], 'small.txt', { type: 'text/plain' });
    const payload: SharedPayload = {
      id: 'share-partial-1',
      files: [validFile],
      error: 'partial_files_skipped',
    };
    const onSelectSession = vi.fn();

    render(
      <ShareTargetModal
        payload={payload}
        servers={[{ id: 'srv-1', name: 'Prod Server' }]}
        selectedServerId="srv-1"
        sessions={[makeSession({ name: 'deck_alpha_brain', project: 'alpha' })]}
        activeSession="deck_alpha_brain"
        onSelectServer={vi.fn()}
        onSelectSession={onSelectSession}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('share-target-error').textContent).toContain('shareTarget.error.partial_files_skipped');
    const sessionBtn = screen.getByTestId('share-target-session-deck_alpha_brain') as HTMLButtonElement;
    expect(sessionBtn.disabled).toBe(false);
    fireEvent.click(sessionBtn);
    expect(onSelectSession).toHaveBeenCalledWith('srv-1', 'deck_alpha_brain');
  });

  it('uploads shared files into the target session composer and appends shared text while keeping input editable', async () => {
    uploadFileWithDirectFallbackMock.mockImplementation(async ({ file }: { file: File }) => ({
      attachment: {
        id: `att-${file.name}`,
        daemonPath: `/tmp/uploads/${file.name}`,
        serverId: 'srv-2',
      },
      mode: 'relay',
    }));

    const sharedFile = new File(['shared-content'], 'shared-spec.md', { type: 'text/markdown' });
    const onConsumed = vi.fn();
    const onComposerTextChange = vi.fn();

    const quickDataStub = {
      data: { history: {}, sessionHistory: {}, commands: [], phrases: [] },
      loading: false,
      recordHistory: vi.fn(),
      addCommand: vi.fn(),
      removeCommand: vi.fn(),
      addPhrase: vi.fn(),
      removePhrase: vi.fn(),
      clearHistory: vi.fn(),
      removeHistoryEntry: vi.fn(),
    };

    // Pre-populate existing draft for the target session to verify shared text appends without clobbering
    sessionStorage.setItem('rcc_draft_session:deck_gamma_brain', 'Existing draft');

    const { rerender, container } = render(
      <SessionControls
        ws={null}
        connected
        serverId="srv-1"
        activeSession={makeSession({ name: 'deck_alpha_brain', project: 'alpha' })}
        quickData={quickDataStub}
        pendingSharedUpload={{
          id: 'upload-1',
          serverId: 'srv-2',
          sessionName: 'deck_gamma_brain',
          files: [sharedFile],
          text: 'Shared note from external app',
        }}
        onPendingSharedUploadConsumed={onConsumed}
        onComposerTextChange={onComposerTextChange}
      />,
    );

    // Mismatched server/session must NOT consume or upload
    expect(onConsumed).not.toHaveBeenCalled();
    expect(uploadFileWithDirectFallbackMock).not.toHaveBeenCalled();

    // Switch to target server + target main session
    rerender(
      <SessionControls
        ws={null}
        connected
        serverId="srv-2"
        activeSession={makeSession({ name: 'deck_gamma_brain', project: 'gamma' })}
        quickData={quickDataStub}
        pendingSharedUpload={{
          id: 'upload-1',
          serverId: 'srv-2',
          sessionName: 'deck_gamma_brain',
          files: [sharedFile],
          text: 'Shared note from external app',
        }}
        onPendingSharedUploadConsumed={onConsumed}
        onComposerTextChange={onComposerTextChange}
      />,
    );

    await waitFor(() => {
      expect(onConsumed).toHaveBeenCalledWith('upload-1');
      expect(uploadFileWithDirectFallbackMock).toHaveBeenCalledTimes(1);
    });

    expect(uploadFileWithDirectFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      serverId: 'srv-2',
      file: sharedFile,
    });

    // Attachment badge (#1 shared-spec.md) is mounted above the composer
    await waitFor(() => {
      expect(container.textContent).toContain('#1');
      expect(container.textContent).toContain('shared-spec.md');
    });

    // Existing draft was preserved and shared text was appended, and user can continue typing
    const inputEl = container.querySelector('[data-onboarding="chat-input"]') as HTMLDivElement;
    expect(inputEl).not.toBeNull();
    expect(inputEl.textContent).toContain('Existing draft');
    expect(inputEl.textContent).toContain('Shared note from external app');
  });

  it('queues multiple cold and warm shares in App without overwriting open modals or unconsumed target handoffs', async () => {
    composerHydrationGate.ready = false;
    shareReceiverProbe.listener = null;
    wsSendSessionCommandMock.mockReset();
    wsSendMock.mockReset();

    uploadFileWithDirectFallbackMock.mockImplementation(async ({ file, serverId }: { file: File; serverId: string }) => ({
      attachment: {
        id: `att-${serverId}-${file.name}`,
        daemonPath: `/tmp/uploads/${serverId}/${file.name}`,
        serverId,
      },
      mode: 'relay',
    }));

    fetchMeMock.mockResolvedValue({
      id: 'user-1',
      is_admin: true,
      display_name: 'Ada',
      username: 'ada',
      has_password: true,
    });

    const now = Date.now();
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path === '/api/server') {
        return {
          servers: [
            { id: 'srv-1', name: 'Alpha Server', status: 'online', lastHeartbeatAt: now, createdAt: now, daemonVersion: '2026.5.11' },
            { id: 'srv-2', name: 'Gamma Server', status: 'online', lastHeartbeatAt: now, createdAt: now, daemonVersion: '2026.5.11' },
          ],
        };
      }
      if (path === '/api/server/srv-1/sessions') {
        return {
          sessions: [
            {
              name: 'deck_alpha_brain',
              project_name: 'Alpha',
              role: 'brain',
              agent_type: 'codex-sdk',
              state: 'idle',
              project_dir: '/work/alpha',
              runtime_type: 'transport',
              label: 'Alpha Brain',
            },
            {
              name: 'deck_beta_brain',
              project_name: 'Beta',
              role: 'brain',
              agent_type: 'codex-sdk',
              state: 'idle',
              project_dir: '/work/beta',
              runtime_type: 'transport',
              label: 'Beta Brain',
            },
          ],
        };
      }
      if (path === '/api/server/srv-2/sessions') {
        return {
          sessions: [
            {
              name: 'deck_gamma_brain',
              project_name: 'Gamma',
              role: 'brain',
              agent_type: 'codex-sdk',
              state: 'idle',
              project_dir: '/work/gamma',
              runtime_type: 'transport',
              label: 'Gamma Brain',
            },
          ],
        };
      }
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      return {};
    });

    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);

    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    localStorage.setItem('rcc_server', 'srv-1');
    sessionStorage.setItem('rcc_draft_session:deck_alpha_brain', 'Existing alpha draft');
    sessionStorage.setItem('rcc_draft_session:deck_gamma_brain', 'Existing gamma draft');

    const { container } = render(<App />);

    await waitFor(() => {
      expect(shareReceiverProbe.listener).toBeTypeOf('function');
      expect(screen.getByTestId('session-pane-deck_alpha_brain')).toBeDefined();
    });

    const firstFile = new File(['one'], 'first.txt', { type: 'text/plain' });
    const secondFile = new File(['two'], 'second.txt', { type: 'text/plain' });
    const thirdFile = new File(['three'], 'third.txt', { type: 'text/plain' });

    // 1. Two cold pending shares arrive in the same turn
    await act(async () => {
      shareReceiverProbe.listener?.({ id: 'cold-one', files: [firstFile], text: 'first caption' });
      shareReceiverProbe.listener?.({ id: 'cold-two', files: [secondFile], text: 'second caption' });
    });

    const modalAfterCold = await screen.findByTestId('share-target-modal');
    expect(modalAfterCold.textContent).toContain('first.txt');
    expect(modalAfterCold.textContent).toContain('first caption');
    expect(modalAfterCold.textContent).not.toContain('second.txt');

    // 2. A warm share arrives while the first modal is still open — must append without overwriting cold-one
    await act(async () => {
      shareReceiverProbe.listener?.({ id: 'warm-three', files: [thirdFile], text: 'third caption' });
    });
    expect(screen.getByTestId('share-target-modal').textContent).toContain('first.txt');
    expect(screen.getByTestId('share-target-modal').textContent).not.toContain('third.txt');

    // 3. Dismissing cold-one removes ONLY cold-one and advances the modal to cold-two
    await act(async () => {
      fireEvent.click(screen.getByTestId('share-target-cancel'));
    });
    const modalAfterCancel = await screen.findByTestId('share-target-modal');
    expect(modalAfterCancel.textContent).toContain('second.txt');
    expect(modalAfterCancel.textContent).toContain('second caption');
    expect(modalAfterCancel.textContent).not.toContain('first.txt');

    // 4. Confirming cold-two on srv-1 / deck_alpha_brain while composer hydration is gated
    // advances modal to warm-three and queues cold-two for deck_alpha_brain
    await act(async () => {
      fireEvent.click(screen.getByTestId('share-target-session-deck_alpha_brain'));
    });

    const modalForWarmThree = await screen.findByTestId('share-target-modal');
    expect(modalForWarmThree.textContent).toContain('third.txt');
    expect(modalForWarmThree.textContent).toContain('third caption');

    const alphaPaneBeforeHydration = screen.getByTestId('session-pane-deck_alpha_brain');
    expect(alphaPaneBeforeHydration.getAttribute('data-pending-upload-id')).toBe('cold-two');
    expect(alphaPaneBeforeHydration.getAttribute('data-pending-upload-files')).toBe('second.txt');
    expect(alphaPaneBeforeHydration.getAttribute('data-pending-upload-text')).toBe('second caption');

    // 5. Switch server to srv-2 in warm-three's modal and confirm srv-2 / deck_gamma_brain
    // while cold-two is STILL unconsumed (awaiting hydration)
    const serverSelect = screen.getByTestId('share-target-server-select') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(serverSelect, { target: { value: 'srv-2' } });
    });
    const gammaBtn = await screen.findByTestId('share-target-session-deck_gamma_brain');
    await act(async () => {
      fireEvent.click(gammaBtn);
    });

    // Modal is now closed; App restores srv-1 / deck_alpha_brain so prior unconsumed cold-two is NOT replaced
    expect(screen.queryByTestId('share-target-modal')).toBeNull();
    await waitFor(() => {
      const alphaPane = screen.getByTestId('session-pane-deck_alpha_brain');
      expect(alphaPane.getAttribute('data-pending-upload-id')).toBe('cold-two');
      expect(alphaPane.getAttribute('data-pending-upload-files')).toBe('second.txt');
      expect(alphaPane.getAttribute('data-pending-upload-text')).toBe('second caption');
    });
    expect(uploadFileWithDirectFallbackMock).not.toHaveBeenCalled();

    // 6. Release composer hydration gate: cold-two is handed off first to (srv-1, deck_alpha_brain),
    // then warm-three automatically advances and is handed off once-only to (srv-2, deck_gamma_brain)
    await act(async () => {
      fireEvent.click(screen.getByTestId('hydrate-deck_alpha_brain'));
    });

    await waitFor(() => {
      expect(uploadFileWithDirectFallbackMock).toHaveBeenCalledTimes(2);
    });

    expect(uploadFileWithDirectFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      serverId: 'srv-1',
      file: secondFile,
    });
    expect(uploadFileWithDirectFallbackMock.mock.calls[1]?.[0]).toMatchObject({
      serverId: 'srv-2',
      file: thirdFile,
    });

    // Existing drafts on both sessions were preserved with shared text appended, and nothing was auto-sent
    expect(sessionStorage.getItem('rcc_draft_session:deck_alpha_brain')).toBe('Existing alpha draft\nsecond caption');
    expect(sessionStorage.getItem('rcc_draft_session:deck_gamma_brain')).toBe('Existing gamma draft\nthird caption');

    const activeInputEl = container.querySelector('[data-onboarding="chat-input"]') as HTMLDivElement;
    expect(activeInputEl).not.toBeNull();
    expect(activeInputEl.textContent).toContain('Existing gamma draft');
    expect(activeInputEl.textContent).toContain('third caption');

    expect(wsSendSessionCommandMock).not.toHaveBeenCalled();
    expect(
      wsSendMock.mock.calls.some(([msg]) =>
        typeof msg?.type === 'string' && (msg.type.startsWith('session.') || msg.type.startsWith('terminal.')),
      ),
    ).toBe(false);
  });
});
