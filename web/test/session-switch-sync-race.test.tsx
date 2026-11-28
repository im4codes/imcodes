/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { DAEMON_MSG } from '@shared/daemon-events.js';

const {
  apiFetchMock,
  listSubSessionsMock,
  patchSessionMock,
  patchSubSessionMock,
  wsInstances,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  listSubSessionsMock: vi.fn(),
  patchSessionMock: vi.fn(),
  patchSubSessionMock: vi.fn(),
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
    sendSessionCommand: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    subSessionStart: ReturnType<typeof vi.fn>;
    subSessionStop: ReturnType<typeof vi.fn>;
    subSessionClose: ReturnType<typeof vi.fn>;
    subSessionRestart: ReturnType<typeof vi.fn>;
    subSessionRebuildAll: ReturnType<typeof vi.fn>;
    p2pListDiscussions: ReturnType<typeof vi.fn>;
    p2pStatus: ReturnType<typeof vi.fn>;
    discussionList: ReturnType<typeof vi.fn>;
    emit(message: any): void;
  }>,
}));

const stableT = vi.hoisted(() => (key: string) => key);
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: stableT, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    listSubSessions: (...args: unknown[]) => listSubSessionsMock(...args),
    patchSession: (...args: unknown[]) => patchSessionMock(...args),
    patchSubSession: (...args: unknown[]) => patchSubSessionMock(...args),
    getUserPref: vi.fn().mockResolvedValue(null),
    saveUserPref: vi.fn().mockResolvedValue(undefined),
    discoverSharedEntries: vi.fn().mockResolvedValue([]),
    fetchMe: vi.fn().mockResolvedValue({ id: 'user-1', is_admin: true, display_name: 'Ada', username: 'ada', has_password: true }),
    listManagedSharesForServer: vi.fn().mockResolvedValue([]),
    listP2pRuns: vi.fn().mockResolvedValue([]),
    getApiKey: vi.fn(() => 'api-key-1'),
    onAuthExpired: vi.fn(),
    refreshSessionIfStale: vi.fn(),
    startProactiveRefresh: vi.fn(),
    stopProactiveRefresh: vi.fn(),
  };
});

vi.mock('../src/native.js', () => ({
  clearServerUrl: vi.fn(async () => undefined),
  getServerUrl: vi.fn(async () => null),
  isNative: vi.fn(() => false),
}));
vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: vi.fn(async () => undefined), setBackgroundColor: vi.fn(async () => undefined) },
  Style: { Dark: 'DARK' },
}));
vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: { hide: vi.fn(async () => undefined) } }));
vi.mock('../src/biometric-auth.js', () => ({
  clearAuthKey: vi.fn(async () => undefined),
  clearAuthKeyId: vi.fn(async () => undefined),
  getAuthKey: vi.fn(async () => null),
  getAuthKeyId: vi.fn(async () => null),
  initializeServerScopedAuth: vi.fn(async () => undefined),
}));
vi.mock('../src/push-notifications.js', () => ({
  initPushNotifications: vi.fn(async () => undefined),
  resetPushBadge: vi.fn(async () => undefined),
  stopAndroidBackgroundPushOnLogout: vi.fn(async () => undefined),
  getLocalPushEnabledServers: vi.fn(() => null),
  fetchPushNotificationSettings: vi.fn(async () => null),
  subscribePushEnabledServers: vi.fn(() => () => {}),
  commitPushEnabledServers: vi.fn(async () => true),
  hasUnsyncedPushEnabledServerEdits: vi.fn(() => false),
}));

vi.mock('../src/ws-client.js', () => ({
  WsClient: class MockWsClient {
    connected = false;
    connectionAttemptInFlight = false;
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
    subSessionStart = vi.fn();
    subSessionStop = vi.fn();
    subSessionClose = vi.fn();
    subSessionRestart = vi.fn();
    subSessionRebuildAll = vi.fn();
    p2pListDiscussions = vi.fn();
    p2pStatus = vi.fn();
    discussionList = vi.fn();
    discussionStop = vi.fn();
    askAnswer = vi.fn();
    sendSessionMessage = vi.fn();
    repoDetect = vi.fn();
    resumeConnection = vi.fn();
    reconnectNow = vi.fn();
    onDaemonCapabilitySnapshot = vi.fn(() => () => {});
    getDaemonCapabilitySnapshot = vi.fn(() => ({ capabilities: [] }));
    isDaemonCapabilityStale = vi.fn(() => false);
    constructor() { wsInstances.push(this); }
    onMessage(handler: (message: any) => void): () => void {
      this.messageHandlers.push(handler);
      return () => { this.messageHandlers = this.messageHandlers.filter((h) => h !== handler); };
    }
    onLatency(handler: ((ms: number) => void) | null): void { this.latencyHandler = handler; }
    onPongLiveness(): void {}
    emit(message: any): void {
      for (const h of [...this.messageHandlers]) h(message);
    }
  },
}));

vi.mock('../src/hooks/useProviderStatus.js', () => ({
  useProviderStatus: () => ({
    isProviderConnected: () => true,
    getRemoteSessions: vi.fn(async () => []),
    refreshSessions: vi.fn(async () => undefined),
  }),
}));
vi.mock('../src/hooks/useUnreadCounts.js', () => ({ useUnreadCounts: () => new Map() }));
vi.mock('../src/hooks/usePref.js', () => ({
  parseString: (v: unknown) => String(v),
  parseBooleanish: (v: unknown) => v === true,
  usePref: () => ({ loaded: true, value: '/bin/bash' }),
}));
vi.mock('../src/git-status-store.js', () => ({
  requestSharedChanges: vi.fn(),
  requestSharedChangesCount: vi.fn(),
  useSharedGitChanges: () => [],
  useSharedGitChangesCount: () => 0,
  subscribeSharedChangesMeta: vi.fn(() => () => {}),
  clearSharedChangesCache: vi.fn(),
}));
vi.mock('../src/watch-bridge.js', () => ({ onWatchCommand: vi.fn(async () => vi.fn()) }));
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
vi.mock('../src/components/ErrorBoundary.js', () => ({ ErrorBoundary: ({ children }: any) => children }));
vi.mock('../src/components/LanguageSwitcher.js', () => ({ LanguageSwitcher: () => null }));
vi.mock('../src/components/ServerIconBar.js', () => ({ ServerIconBar: () => null }));
vi.mock('../src/components/Sidebar.js', () => ({
  Sidebar: ({ children }: any) => <div>{children}</div>,
  loadSidebarCollapsed: vi.fn(() => false),
  saveSidebarCollapsed: vi.fn(),
}));
vi.mock('../src/components/SessionTree.js', () => ({ SessionTree: () => null }));
vi.mock('../src/components/SessionTabs.js', () => ({ SessionTabs: () => null }));
vi.mock('../src/components/SubSessionBar.js', () => ({
  SUBSESSION_BAR_COLLAPSED_STORAGE_KEY: 'subsession_bar_collapsed',
  SUBSESSION_BAR_COLLAPSED_MIGRATION_KEY: 'rcc_subcard_collapsed_default_v2',
  SubSessionBar: ({ subSessions, onOpen }: any) => (
    <div data-testid="subsession-bar">
      {subSessions?.map((sub: any) => (
        <button key={sub.id} data-testid={`subbar-open-${sub.id}`} onClick={() => onOpen?.(sub.id)}>
          {sub.id}
        </button>
      ))}
    </div>
  ),
}));

// Use the REAL QuickSdkModelMenu inside lightweight SessionPane / SubSessionWindow test harnesses
// wired straight to App's `onSessionSaved`, `getLatestSession`, and `onSessionSwitchCommit`.
vi.mock('../src/components/SessionPane.js', async () => {
  const { QuickSdkModelMenu } = await import('../src/components/QuickSdkModelMenu.js');
  return {
    SessionPane: ({ session, serverId, ws, onSessionSaved, getLatestSession, onSessionSwitchCommit }: any) => (
      <div
        data-testid={`app-main-${session.name}`}
        data-agent={session.agentType ?? ''}
        data-preset={session.ccPreset ?? ''}
        data-model={session.requestedModel ?? ''}
        data-display={session.modelDisplay ?? ''}
        data-epoch={session.runtimeEpoch ?? ''}
      >
        <QuickSdkModelMenu
          ws={ws}
          activeSession={session}
          serverId={serverId}
          modelOpen
          splitAllowed
          currentSdk={session.agentType}
          currentModel={session.modelDisplay ?? session.requestedModel ?? null}
          sameSdkItems={[]}
          onSelectSameSdkModel={vi.fn()}
          onClose={vi.fn()}
          onSessionSaved={onSessionSaved}
          getLiveSession={getLatestSession}
          onSessionSwitchCommit={onSessionSwitchCommit}
        />
      </div>
    ),
  };
});

vi.mock('../src/components/SubSessionWindow.js', async () => {
  const { QuickSdkModelMenu } = await import('../src/components/QuickSdkModelMenu.js');
  return {
    SubSessionWindow: ({ sub, serverId, ws, onSessionSaved, getLatestSession, onSessionSwitchCommit }: any) => {
      const asSessionInfo = {
        name: sub.sessionName,
        project: sub.label ?? sub.type,
        role: 'w1' as const,
        agentType: sub.type,
        state: sub.state ?? 'idle',
        ccPreset: sub.ccPresetId ?? undefined,
        requestedModel: sub.requestedModel ?? undefined,
        activeModel: sub.activeModel ?? undefined,
        modelDisplay: sub.modelDisplay ?? undefined,
        runtimeEpoch: sub.runtimeEpoch ?? undefined,
        sessionInstanceId: sub.sessionInstanceId ?? undefined,
      };
      return (
        <div
          data-testid={`app-sub-${sub.id}`}
          data-agent={sub.type ?? ''}
          data-preset={sub.ccPresetId ?? ''}
          data-model={sub.requestedModel ?? ''}
          data-display={sub.modelDisplay ?? ''}
          data-epoch={sub.runtimeEpoch ?? ''}
        >
          <QuickSdkModelMenu
            ws={ws}
            activeSession={asSessionInfo as never}
            serverId={serverId}
            subSessionId={sub.id}
            modelOpen
            splitAllowed
            currentSdk={sub.type}
            currentModel={sub.modelDisplay ?? sub.requestedModel ?? null}
            sameSdkItems={[]}
            onSelectSameSdkModel={vi.fn()}
            onClose={vi.fn()}
            onSessionSaved={onSessionSaved}
            getLiveSession={getLatestSession}
            onSessionSwitchCommit={onSessionSwitchCommit}
          />
        </div>
      );
    },
  };
});

vi.mock('../src/components/StartSubSessionDialog.js', () => ({ StartSubSessionDialog: () => null }));
vi.mock('../src/components/NewSessionDialog.js', () => ({ NewSessionDialog: () => null }));
vi.mock('../src/components/ShareSessionDialog.js', () => ({ ShareSessionDialog: () => null }));
vi.mock('../src/components/DesktopWindowMaximizeButton.js', () => ({ DesktopWindowMaximizeButton: () => null }));
vi.mock('../src/components/SessionSettingsDialog.js', () => ({ SessionSettingsDialog: () => null, SupervisionSettingsDialog: () => null }));
vi.mock('../src/components/CloneSessionGroupDialog.js', () => ({ CloneSessionGroupDialog: () => null }));
vi.mock('../src/components/StartDiscussionDialog.js', () => ({ StartDiscussionDialog: () => null }));
vi.mock('../src/components/AskQuestionDialog.js', () => ({ AskQuestionDialog: () => null }));
vi.mock('../src/components/ServerContextMenu.js', () => ({ DeleteServerDialog: () => null, ServerContextMenu: () => null }));
vi.mock('../src/components/FloatingPanel.js', () => ({ FloatingPanel: ({ children }: any) => <div>{children}</div> }));
vi.mock('../src/components/SharedContextManagementPanel.js', () => ({ SharedContextManagementPanel: () => null }));
vi.mock('../src/components/ControlledNodesPanel.js', () => ({ ControlledNodesPanel: () => null }));
vi.mock('../src/components/ControlledNodeQuickMenu.js', () => ({ ControlledNodeQuickMenu: () => null }));
vi.mock('../src/components/RemoteDesktopPanel.js', () => ({ RemoteDesktopPanel: () => null }));
vi.mock('../src/components/RemoteDesktopWorkspace.js', () => ({ RemoteDesktopWorkspace: () => null }));
vi.mock('../src/components/RemoteDesktopWall.js', () => ({ REMOTE_DESKTOP_WALL_WINDOW_ID: 'wall', RemoteDesktopWall: () => null }));
vi.mock('../src/components/ContextDiagnosticsPanel.js', () => ({ ContextDiagnosticsPanel: () => null }));
vi.mock('../src/components/NewUserGuide.js', () => ({ NewUserGuide: () => null }));
vi.mock('../src/components/P2pRingProgress.js', () => ({ P2pRingProgress: () => null }));
vi.mock('../src/components/SidebarPinnedPanel.js', () => ({ SidebarPinnedPanel: () => null }));
vi.mock('../src/components/LocalWebPreviewPanel.js', () => ({ LocalWebPreviewPanel: () => null }));
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));
vi.mock('../src/components/pinnedPanelTypes.js', () => ({
  LOCAL_WEB_PREVIEW_PANEL_TYPE: 'local-web-preview',
  SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE: 'shared-context-diagnostics',
  SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE: 'shared-context-management',
}));

async function getLatestWs() {
  await waitFor(() => expect(wsInstances.some((i) => i.messageHandlers.length > 0)).toBe(true));
  return wsInstances.findLast((i) => i.messageHandlers.length > 0)!;
}

describe('App session switch vs WS sync race protection', () => {
  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, '', '/#/srv-1');
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    wsInstances.length = 0;
    listSubSessionsMock.mockResolvedValue([{
      id: 'sub1',
      serverId: 'srv-1',
      type: 'claude-code-sdk',
      runtimeType: 'transport',
      providerId: 'claude-code-sdk',
      providerSessionId: 'p-sub-0',
      shellBin: null,
      cwd: '/work/alpha',
      label: 'Sub 1',
      ccSessionId: null,
      geminiSessionId: null,
      parentSession: 'deck_alpha_brain',
      ccPresetId: null,
      requestedModel: null,
      activeModel: null,
      modelDisplay: null,
      effort: null,
      transportConfig: null,
      closedAt: null,
      createdAt: 1,
      updatedAt: 1,
    }]);
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      if (path === '/api/server') {
        return {
          servers: [{ id: 'srv-1', name: 'Server One', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() }],
        };
      }
      if (path === '/api/server/srv-1/sessions') {
        return {
          sessions: [{
            name: 'deck_alpha_brain',
            project_name: 'Alpha',
            role: 'brain',
            agent_type: 'claude-code-sdk',
            state: 'idle',
            project_dir: '/work/alpha',
            runtime_type: 'transport',
            runtime_epoch: 'ep-main-0',
          }],
        };
      }
      if (path === '/api/server/srv-1/cc-presets') return { presets: [] };
      return {};
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('keeps newer WS synced state B when delayed HTTP success response A resolves afterwards for both main and sub sessions', async () => {
    const { App } = await import('../src/app.js');
    const view = render(<App />);
    const ws = await getLatestWs();

    ws.connected = true;
    ws.emit({ type: 'session.event', event: 'connected' });
    ws.emit({ type: DAEMON_MSG.RECONNECTED });
    ws.emit({
      type: 'session_list',
      sessions: [{
        name: 'deck_alpha_brain',
        project: 'Alpha',
        role: 'brain',
        agentType: 'claude-code-sdk',
        state: 'idle',
        projectDir: '/work/alpha',
        runtimeType: 'transport',
        runtimeEpoch: 'ep-main-0',
      }],
    });

    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="app-main-deck_alpha_brain"]')).not.toBeNull();
    });

    ws.emit({
      type: 'subsession.created',
      id: 'sub1',
      sessionName: 'deck_sub_sub1',
      sessionType: 'claude-code-sdk',
      runtimeType: 'transport',
      parentSession: 'deck_alpha_brain',
      state: 'idle',
      runtimeEpoch: 'ep-sub-0',
    });

    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="subbar-open-sub1"]')).not.toBeNull();
    });
    fireEvent.click(view.container.querySelector('[data-testid="subbar-open-sub1"]') as HTMLButtonElement);
    await waitFor(() => {
      expect(view.container.querySelector('[data-testid="app-sub-sub1"]')).not.toBeNull();
    });

    // 1) Start main-session HTTP A switch and hold Promise A in-flight
    let resolveMainA!: (val: unknown) => void;
    patchSessionMock.mockImplementationOnce(() => new Promise((r) => { resolveMainA = r; }));
    const mainWrap = view.container.querySelector('[data-testid="app-main-deck_alpha_brain"]')!;
    fireEvent.click(mainWrap.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const mainModelBtn = await waitFor(() => {
      const btn = mainWrap.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(mainModelBtn);
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledTimes(1));

    // Device 2 syncs B to main session BEFORE HTTP A resolves
    ws.emit({
      type: 'session_list',
      sessions: [{
        name: 'deck_alpha_brain',
        project: 'Alpha',
        role: 'brain',
        agentType: 'qwen',
        ccPreset: 'PresetB',
        requestedModel: 'qwen-b',
        activeModel: 'qwen-b',
        modelDisplay: 'qwen-b',
        state: 'idle',
        projectDir: '/work/alpha',
        runtimeType: 'transport',
        runtimeEpoch: 'ep-main-B',
      }],
    });
    await waitFor(() => {
      expect(mainWrap.getAttribute('data-epoch')).toBe('ep-main-B');
      expect(mainWrap.getAttribute('data-model')).toBe('qwen-b');
    });

    // Release delayed HTTP A with ok=true & applied A -> main session MUST remain on B
    resolveMainA({
      ok: true,
      applied: {
        agentType: 'codex-sdk',
        ccPreset: null,
        requestedModel: 'codex-a',
        activeModel: 'codex-a',
        modelDisplay: 'codex-a',
        runtimeType: 'transport',
        providerId: 'codex-sdk',
        cwd: '/work/alpha',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-main-A',
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mainWrap.getAttribute('data-agent')).toBe('qwen');
    expect(mainWrap.getAttribute('data-preset')).toBe('PresetB');
    expect(mainWrap.getAttribute('data-model')).toBe('qwen-b');
    expect(mainWrap.getAttribute('data-epoch')).toBe('ep-main-B');

    // 2) Start sub-session HTTP A switch and hold Promise A in-flight
    let resolveSubA!: (val: unknown) => void;
    patchSubSessionMock.mockImplementationOnce(() => new Promise((r) => { resolveSubA = r; }));
    const subWrap = view.container.querySelector('[data-testid="app-sub-sub1"]')!;
    fireEvent.click(subWrap.querySelector('[data-sdk-id="codex-sdk"]') as HTMLButtonElement);
    const subModelBtn = await waitFor(() => {
      const btn = subWrap.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(subModelBtn);
    await waitFor(() => expect(patchSubSessionMock).toHaveBeenCalledTimes(1));

    // Device 2 syncs B via subsession.created BEFORE HTTP A resolves
    ws.emit({
      type: 'subsession.created',
      id: 'sub1',
      sessionName: 'deck_sub_sub1',
      sessionType: 'qwen',
      runtimeType: 'transport',
      ccPresetId: 'SubPresetB',
      requestedModel: 'sub-qwen-b',
      activeModel: 'sub-qwen-b',
      modelDisplay: 'sub-qwen-b',
      parentSession: 'deck_alpha_brain',
      state: 'idle',
      runtimeEpoch: 'ep-sub-B',
    });
    await waitFor(() => {
      expect(subWrap.getAttribute('data-epoch')).toBe('ep-sub-B');
      expect(subWrap.getAttribute('data-model')).toBe('sub-qwen-b');
    });

    // Release delayed HTTP A with ok=true & applied A -> sub-session MUST remain on B
    resolveSubA({
      ok: true,
      applied: {
        agentType: 'codex-sdk',
        ccPreset: null,
        requestedModel: 'sub-codex-a',
        activeModel: 'sub-codex-a',
        modelDisplay: 'sub-codex-a',
        runtimeType: 'transport',
        providerId: 'codex-sdk',
        cwd: '/work/alpha',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-sub-A',
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(subWrap.getAttribute('data-agent')).toBe('qwen');
    expect(subWrap.getAttribute('data-preset')).toBe('SubPresetB');
    expect(subWrap.getAttribute('data-model')).toBe('sub-qwen-b');
    expect(subWrap.getAttribute('data-epoch')).toBe('ep-sub-B');

    // 3) Same-runtimeEpoch hot model switch race (E / m1 synced, then hot-switched inside SAME E to m2,
    // followed by delayed HTTP A carrying E / m1): MUST preserve m2 in BOTH UI and local AGY preference
    // for main and sub sessions.
    const { saveAgyModelPreference, loadAgyModelPreference } = await import('../src/agy-model-preference.js');

    // Main session same-epoch hot-switch race
    let resolveMainSameEpoch!: (val: unknown) => void;
    patchSessionMock.mockImplementationOnce(() => new Promise((r) => { resolveMainSameEpoch = r; }));
    fireEvent.click(mainWrap.querySelector('[data-sdk-id="agy-sdk"]') as HTMLButtonElement);
    const mainAgyModelBtn = await waitFor(() => {
      const btn = mainWrap.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(mainAgyModelBtn);
    await waitFor(() => expect(patchSessionMock).toHaveBeenCalledTimes(2));

    // Step 3a: A commits on daemon and WS syncs (ep-same-main, agy-sdk, m1), then Step 3b: hot-switch inside SAME ep-same-main to m2
    ws.emit({
      type: 'session_list',
      sessions: [{
        name: 'deck_alpha_brain',
        project: 'Alpha',
        role: 'brain',
        agentType: 'agy-sdk',
        requestedModel: 'm1',
        activeModel: 'm1',
        modelDisplay: 'm1',
        state: 'idle',
        projectDir: '/work/alpha',
        runtimeType: 'transport',
        runtimeEpoch: 'ep-same-main',
      }],
    });
    saveAgyModelPreference('m2', 'deck_alpha_brain');
    ws.emit({
      type: 'session_list',
      sessions: [{
        name: 'deck_alpha_brain',
        project: 'Alpha',
        role: 'brain',
        agentType: 'agy-sdk',
        requestedModel: 'm2',
        activeModel: 'm2',
        modelDisplay: 'm2',
        state: 'idle',
        projectDir: '/work/alpha',
        runtimeType: 'transport',
        runtimeEpoch: 'ep-same-main',
      }],
    });
    await waitFor(() => {
      expect(mainWrap.getAttribute('data-epoch')).toBe('ep-same-main');
      expect(mainWrap.getAttribute('data-model')).toBe('m2');
    });

    // Release delayed HTTP A carrying SAME runtimeEpoch ep-same-main + stale m1
    resolveMainSameEpoch({
      ok: true,
      applied: {
        agentType: 'agy-sdk',
        ccPreset: null,
        requestedModel: 'm1',
        activeModel: 'm1',
        modelDisplay: 'm1',
        runtimeType: 'transport',
        providerId: 'agy-sdk',
        cwd: '/work/alpha',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-same-main',
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mainWrap.getAttribute('data-model')).toBe('m2');
    expect(mainWrap.getAttribute('data-display')).toBe('m2');
    expect(loadAgyModelPreference('deck_alpha_brain')).toBe('m2');

    // Sub-session same-epoch hot-switch race
    let resolveSubSameEpoch!: (val: unknown) => void;
    patchSubSessionMock.mockImplementationOnce(() => new Promise((r) => { resolveSubSameEpoch = r; }));
    fireEvent.click(subWrap.querySelector('[data-sdk-id="agy-sdk"]') as HTMLButtonElement);
    const subAgyModelBtn = await waitFor(() => {
      const btn = subWrap.querySelector('[data-cross-model-id]') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(subAgyModelBtn);
    await waitFor(() => expect(patchSubSessionMock).toHaveBeenCalledTimes(2));

    ws.emit({
      type: 'subsession.created',
      id: 'sub1',
      sessionName: 'deck_sub_sub1',
      sessionType: 'agy-sdk',
      runtimeType: 'transport',
      requestedModel: 'm1',
      activeModel: 'm1',
      modelDisplay: 'm1',
      parentSession: 'deck_alpha_brain',
      state: 'idle',
      runtimeEpoch: 'ep-same-sub',
    });
    saveAgyModelPreference('m2', 'deck_sub_sub1');
    ws.emit({
      type: 'subsession.created',
      id: 'sub1',
      sessionName: 'deck_sub_sub1',
      sessionType: 'agy-sdk',
      runtimeType: 'transport',
      requestedModel: 'm2',
      activeModel: 'm2',
      modelDisplay: 'm2',
      parentSession: 'deck_alpha_brain',
      state: 'idle',
      runtimeEpoch: 'ep-same-sub',
    });
    await waitFor(() => {
      expect(subWrap.getAttribute('data-epoch')).toBe('ep-same-sub');
      expect(subWrap.getAttribute('data-model')).toBe('m2');
    });

    resolveSubSameEpoch({
      ok: true,
      applied: {
        agentType: 'agy-sdk',
        ccPreset: null,
        requestedModel: 'm1',
        activeModel: 'm1',
        modelDisplay: 'm1',
        runtimeType: 'transport',
        providerId: 'agy-sdk',
        cwd: '/work/alpha',
        label: null,
        description: null,
        effort: null,
        transportConfig: null,
        runtimeEpoch: 'ep-same-sub',
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(subWrap.getAttribute('data-model')).toBe('m2');
    expect(subWrap.getAttribute('data-display')).toBe('m2');
    expect(loadAgyModelPreference('deck_sub_sub1')).toBe('m2');
  }, 20_000);
});
