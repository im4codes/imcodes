/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { DAEMON_MSG } from '@shared/daemon-events.js';

const {
  apiFetchMock,
  listSubSessionsMock,
  createSubSessionMock,
  wsInstances,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  listSubSessionsMock: vi.fn(),
  createSubSessionMock: vi.fn(),
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
    createSubSession: (...args: unknown[]) => createSubSessionMock(...args),
    patchSubSession: vi.fn().mockResolvedValue(undefined),
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
vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => undefined) },
}));
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
    constructor() {
      wsInstances.push(this);
    }
    onMessage(handler: (message: any) => void): () => void {
      this.messageHandlers.push(handler);
      return () => {
        this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
      };
    }
    onLatency(handler: ((ms: number) => void) | null): void {
      this.latencyHandler = handler;
    }
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
  useSharedGitChanges: () => [],
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
vi.mock('../src/components/ServerIconBar.js', () => ({
  ServerIconBar: ({ servers, onSelectServer }: any) => (
    <div data-testid="server-icon-bar">
      {servers?.map((srv: any) => (
        <button key={srv.id} data-testid={`server-icon-${srv.id}`} onClick={() => onSelectServer?.(srv.id, srv.name)}>
          {srv.name}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../src/components/Sidebar.js', () => ({
  Sidebar: ({ children }: any) => <div data-testid="sidebar">{children}</div>,
  loadSidebarCollapsed: vi.fn(() => false),
  saveSidebarCollapsed: vi.fn(),
}));
vi.mock('../src/components/SessionTree.js', () => ({ SessionTree: () => <div data-testid="session-tree" /> }));
vi.mock('../src/components/SessionTabs.js', () => ({
  SessionTabs: ({ sessions, activeSession, onSelect, onStopProject }: any) => (
    <div data-testid="session-tabs">
      {sessions?.map((s: any) => (
        <button
          key={s.name}
          data-testid={`tab-${s.name}`}
          data-active={String(s.name === activeSession)}
          data-incognito={String(Boolean(s.incognito))}
          data-state={s.state ?? ''}
          onClick={() => onSelect?.(s.name)}
        >
          {s.name}
        </button>
      ))}
      <button data-testid="tabs-stop" onClick={() => onStopProject?.('IncogProj')}>tabs-stop</button>
    </div>
  ),
}));
vi.mock('../src/components/SessionPane.js', () => ({
  SessionPane: ({ isActive, session }: any) => (
    <div data-testid={`session-pane-${session.name}`} data-active={String(Boolean(isActive))} data-incognito={String(Boolean(session.incognito))} data-state={session.state ?? ''} />
  ),
}));
vi.mock('../src/components/SubSessionBar.js', () => ({
  SUBSESSION_BAR_COLLAPSED_STORAGE_KEY: 'subsession_bar_collapsed',
  SUBSESSION_BAR_COLLAPSED_MIGRATION_KEY: 'rcc_subcard_collapsed_default_v2',
  SubSessionBar: ({ subSessions, openIds, onOpen }: any) => (
    <div data-testid="subsession-bar">
      {subSessions?.map((sub: any) => (
        <button key={sub.id} data-testid={`subbar-item-${sub.id}`} data-open={String(openIds?.has(sub.id) ?? false)} data-incognito={String(Boolean(sub.incognito))} onClick={() => onOpen?.(sub.id)}>
          {sub.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../src/components/SubSessionWindow.js', () => ({
  SubSessionWindow: ({ sub, visible, onClose, onMinimize }: any) => (
    <div data-testid={`sub-window-${sub.id}`} data-visible={String(Boolean(visible))} data-incognito={String(Boolean(sub.incognito))} data-state={sub.state ?? ''}>
      <button data-testid={`sub-window-min-${sub.id}`} onClick={onMinimize}>min</button>
      <button data-testid={`sub-window-close-${sub.id}`} onClick={onClose}>close</button>
    </div>
  ),
}));
vi.mock('../src/components/StartSubSessionDialog.js', () => ({
  StartSubSessionDialog: ({ onStart, onClose }: any) => (
    <div>
      <button data-testid="start-incog-sub" onClick={() => void onStart?.('claude-code-sdk', undefined, '/tmp/secret', 'Incog Sub', { incognito: true })}>start-incog</button>
      <button onClick={onClose}>close</button>
    </div>
  ),
}));
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

describe('App incognito window & timeline persistence across disconnects and server switches', () => {
  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, '', '/#/srv-1');
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-1', baseUrl: 'http://localhost' }));
    wsInstances.length = 0;

    listSubSessionsMock.mockResolvedValue([]);
    createSubSessionMock.mockResolvedValue({
      id: 'incSub1',
      sessionName: 'deck_sub_incSub1',
      subSession: {
        id: 'incSub1',
        server_id: 'srv-1',
        type: 'claude-code-sdk',
        shell_bin: null,
        cwd: '/tmp/secret',
        label: 'Secret Sub',
        closed_at: null,
        cc_session_id: null,
        gemini_session_id: null,
        parent_session: 'deck_alpha_brain',
        incognito: true,
      },
    });
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: 'user-1' };
      if (path.startsWith('/api/watch/sessions')) return { sessions: [] };
      if (path === '/api/server') {
        return {
          servers: [
            { id: 'srv-1', name: 'Server One', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() },
            { id: 'srv-2', name: 'Server Two', status: 'online', lastHeartbeatAt: Date.now(), createdAt: Date.now() },
          ],
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
          }],
        };
      }
      if (path === '/api/server/srv-2/sessions') {
        return {
          sessions: [{
            name: 'deck_beta_brain',
            project_name: 'Beta',
            role: 'brain',
            agent_type: 'claude-code-sdk',
            state: 'idle',
            project_dir: '/work/beta',
            runtime_type: 'transport',
          }],
        };
      }
      return {};
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps incognito main & sub-session windows and timelines open across disconnects, non-manual stops, and server switches, clearing only on manual close', async () => {
    const {
      __getTimelineCacheForTests,
      __resetTimelineCacheForTests,
      isIncognitoTimelineSession,
    } = await import('../src/hooks/useTimeline.js');
    __resetTimelineCacheForTests();
    const { App } = await import('../src/app.js');
    render(<App />);

    const ws1 = await getLatestWs();
    ws1.connected = true;
    ws1.emit({ type: 'session.event', event: 'connected' });
    ws1.emit({
      type: 'session_list',
      sessions: [
        { name: 'deck_alpha_brain', project: 'Alpha', role: 'brain', agentType: 'claude-code-sdk', state: 'idle' },
        { name: 'deck_incog_brain', project: 'IncogProj', role: 'brain', agentType: 'claude-code-sdk', state: 'running', incognito: true },
      ],
    });

    await screen.findByTestId('session-pane-deck_alpha_brain');
    await screen.findByTestId('tab-deck_incog_brain');

    // Receive live incognito sub-session window on srv-1 under deck_alpha_brain & open it
    ws1.emit({
      type: 'subsession.created',
      id: 'incSub1',
      sessionName: 'deck_sub_incSub1',
      sessionType: 'claude-code-sdk',
      runtimeType: 'transport',
      label: 'Secret Sub',
      parentSession: 'deck_alpha_brain',
      state: 'idle',
      incognito: true,
    });
    const subBtn = await screen.findByTestId('subbar-item-incSub1');
    fireEvent.click(subBtn);
    await waitFor(() => expect(screen.getByTestId('sub-window-incSub1').getAttribute('data-visible')).toBe('true'));

    // Deliver live incognito timeline events to both incognito main & sub sessions
    ws1.emit({
      type: 'timeline.event',
      event: {
        eventId: 'inc-sub-ev-1',
        sessionId: 'deck_sub_incSub1',
        epoch: 1,
        seq: 1,
        ts: Date.now(),
        type: 'assistant.text',
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'INC_SUB_SECRET_MSG', streaming: false, incognito: true },
      },
    });
    ws1.emit({
      type: 'timeline.event',
      event: {
        eventId: 'inc-main-ev-1',
        sessionId: 'deck_incog_brain',
        epoch: 1,
        seq: 1,
        ts: Date.now(),
        type: 'assistant.text',
        source: 'daemon',
        confidence: 'high',
        payload: { text: 'INC_MAIN_SECRET_MSG', streaming: false, incognito: true },
      },
    });
    expect(__getTimelineCacheForTests('srv-1:deck_sub_incSub1')?.map((e) => e.eventId)).toEqual(['inc-sub-ev-1']);
    expect(__getTimelineCacheForTests('srv-1:deck_incog_brain')?.map((e) => e.eventId)).toEqual(['inc-main-ev-1']);

    // 1. Transient WS disconnect, daemon disconnect, and non-manual session stopped must NOT close or clear incognito state
    ws1.emit({ type: 'session.event', event: 'disconnected' });
    ws1.emit({ type: DAEMON_MSG.DISCONNECTED });
    ws1.emit({ type: 'session.event', event: 'stopped', session: 'deck_incog_brain', state: 'stopped' });

    expect(screen.getByTestId('sub-window-incSub1').getAttribute('data-visible')).toBe('true');
    expect(screen.getByTestId('tab-deck_incog_brain')).toBeTruthy();
    expect(isIncognitoTimelineSession('srv-1', 'deck_sub_incSub1')).toBe(true);
    expect(isIncognitoTimelineSession('srv-1', 'deck_incog_brain')).toBe(true);
    expect(__getTimelineCacheForTests('srv-1:deck_sub_incSub1')?.map((e) => e.eventId)).toEqual(['inc-sub-ev-1']);
    expect(__getTimelineCacheForTests('srv-1:deck_incog_brain')?.map((e) => e.eventId)).toEqual(['inc-main-ev-1']);

    // Select deck_incog_brain on srv-1 (to also verify returning to active incognito main session)
    // First test sub-window persistence under deck_alpha_brain across srv-1 -> srv-2 -> srv-1:
    fireEvent.click(screen.getByTestId('server-icon-srv-2'));
    const ws2 = await getLatestWs();
    expect(ws2).not.toBe(ws1);
    ws2.connected = true;
    ws2.emit({ type: 'session.event', event: 'connected' });
    ws2.emit({
      type: 'session_list',
      sessions: [{ name: 'deck_beta_brain', project: 'Beta', role: 'brain', agentType: 'claude-code-sdk', state: 'idle' }],
    });
    await screen.findByTestId('session-pane-deck_beta_brain');

    // Privacy: zero incognito IDs or contents written to localStorage
    const lsDump = JSON.stringify({ ...localStorage });
    expect(lsDump).not.toContain('incSub1');
    expect(lsDump).not.toContain('deck_incog_brain');
    expect(lsDump).not.toContain('INC_SUB_SECRET_MSG');
    expect(lsDump).not.toContain('INC_MAIN_SECRET_MSG');

    // 2. Switch BACK to srv-1 -> both open incognito sub-window & incognito main tab + timelines MUST survive!
    fireEvent.click(screen.getByTestId('server-icon-srv-1'));
    const ws1Return = await getLatestWs();
    ws1Return.connected = true;
    ws1Return.emit({ type: 'session.event', event: 'connected' });
    ws1Return.emit({
      type: 'session_list',
      sessions: [
        { name: 'deck_alpha_brain', project: 'Alpha', role: 'brain', agentType: 'claude-code-sdk', state: 'idle' },
        { name: 'deck_incog_brain', project: 'IncogProj', role: 'brain', agentType: 'claude-code-sdk', state: 'running', incognito: true },
      ],
    });

    await waitFor(() => expect(screen.getByTestId('sub-window-incSub1').getAttribute('data-visible')).toBe('true'));
    expect(screen.getByTestId('tab-deck_incog_brain')).toBeTruthy();
    expect(__getTimelineCacheForTests('srv-1:deck_sub_incSub1')?.map((e) => e.eventId)).toEqual(['inc-sub-ev-1']);
    expect(__getTimelineCacheForTests('srv-1:deck_incog_brain')?.map((e) => e.eventId)).toEqual(['inc-main-ev-1']);

    // 3. Switch to incognito main tab, switch to srv-2 and back -> active incognito tab itself stays selected
    fireEvent.click(screen.getByTestId('tab-deck_incog_brain'));
    await waitFor(() => expect(screen.getByTestId('tab-deck_incog_brain').getAttribute('data-active')).toBe('true'));
    fireEvent.click(screen.getByTestId('server-icon-srv-2'));
    const ws2Again = await getLatestWs();
    ws2Again.connected = true;
    ws2Again.emit({ type: 'session.event', event: 'connected' });
    ws2Again.emit({
      type: 'session_list',
      sessions: [{ name: 'deck_beta_brain', project: 'Beta', role: 'brain', agentType: 'claude-code-sdk', state: 'idle' }],
    });
    await screen.findByTestId('session-pane-deck_beta_brain');

    fireEvent.click(screen.getByTestId('server-icon-srv-1'));
    const ws1Return2 = await getLatestWs();
    ws1Return2.connected = true;
    ws1Return2.emit({ type: 'session.event', event: 'connected' });
    ws1Return2.emit({
      type: 'session_list',
      sessions: [
        { name: 'deck_alpha_brain', project: 'Alpha', role: 'brain', agentType: 'claude-code-sdk', state: 'idle' },
        { name: 'deck_incog_brain', project: 'IncogProj', role: 'brain', agentType: 'claude-code-sdk', state: 'running', incognito: true },
      ],
    });
    await waitFor(() => expect(screen.getByTestId('tab-deck_incog_brain').getAttribute('data-active')).toBe('true'));

    // 4. Manual close clears incognito main & sub sessions completely
    fireEvent.click(screen.getByTestId('tabs-stop'));
    expect(ws1Return2.sendSessionCommand).toHaveBeenCalledWith('stop', { project: 'IncogProj' });
    ws1Return2.emit({ type: 'session.event', event: 'stopped', session: 'deck_incog_brain', state: 'stopped' });
    await waitFor(() => expect(screen.queryByTestId('tab-deck_incog_brain')).toBeNull());
    expect(__getTimelineCacheForTests('srv-1:deck_incog_brain')).toBeUndefined();

    // Re-open deck_alpha_brain to close incSub1 manually
    fireEvent.click(screen.getByTestId('tab-deck_alpha_brain'));
    const closeBtn = await screen.findByTestId('sub-window-close-incSub1');
    fireEvent.click(closeBtn);
    expect(ws1Return2.subSessionStop).toHaveBeenCalledWith('deck_sub_incSub1');
    ws1Return2.emit({ type: 'subsession.removed', id: 'incSub1', sessionName: 'deck_sub_incSub1' });
    await waitFor(() => expect(screen.queryByTestId('sub-window-incSub1')).toBeNull());
    expect(__getTimelineCacheForTests('srv-1:deck_sub_incSub1')).toBeUndefined();
  }, 20_000);
});
