/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act, within } from '@testing-library/preact';
import enLocale from '../src/i18n/locales/en.json';

function lookupEn(key: string, opts?: Record<string, unknown>): string {
  const parts = key.split('.');
  let cur: unknown = enLocale;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      cur = undefined;
      break;
    }
  }
  let text = typeof cur === 'string'
    ? cur
    : typeof opts?.defaultValue === 'string'
      ? opts.defaultValue
      : key;
  if (opts) {
    text = text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
      opts[k] !== undefined && opts[k] !== null ? String(opts[k]) : '');
  }
  return text;
}

const textComponent = (label: string) => () => <div>{label}</div>;

interface MockServer {
  id: string;
  name: string;
  status: 'online' | 'offline';
  lastHeartbeatAt: number;
  createdAt: number;
  daemonVersion?: string;
}

interface MockState {
  servers: MockServer[];
  machines: Array<{ id: string; name?: string }>;
  sharedEntries: Array<{
    id: string;
    serverId: string;
    serverName: string;
    role: 'viewer' | 'participant';
    status: 'active';
    target: { kind: 'server'; serverId: string };
    targetLabel: string;
    serverStatus: 'online' | 'offline';
    lastHeartbeatAt: number;
  }>;
  pushTypes: string[];
  enabledServerIds: string[] | null;
  failNextPushSave: boolean;
  deferPushSaves: Array<{
    resolve: () => void;
    reject: (err?: Error) => void;
  }>;
  holdPushSaves: boolean;
  pushPostPayloads: Array<{ types: string[]; enabledServerIds: string[] | null }>;
}

const mockState: MockState = {
  servers: [],
  machines: [],
  sharedEntries: [],
  pushTypes: [],
  enabledServerIds: null,
  failNextPushSave: false,
  deferPushSaves: [],
  holdPushSaves: false,
  pushPostPayloads: [],
};

const apiFetchMock = vi.fn(async (path: string, init?: RequestInit) => {
  if (path === '/api/server') {
    return { servers: mockState.servers.map((s) => ({ ...s })) };
  }
  if (path === '/api/machines') {
    return { machines: mockState.machines.map((m) => ({ ...m })) };
  }
  if (path === '/api/push/preferences' && (!init?.method || init.method === 'GET')) {
    return {
      ok: true,
      types: [...mockState.pushTypes],
      enabledServerIds: mockState.enabledServerIds === null ? null : [...mockState.enabledServerIds],
    };
  }
  if (path === '/api/push/preferences' && init?.method === 'POST') {
    if (mockState.holdPushSaves) {
      await new Promise<void>((resolve, reject) => {
        mockState.deferPushSaves.push({ resolve, reject });
      });
    }
    if (mockState.failNextPushSave) {
      mockState.failNextPushSave = false;
      throw new Error('push save failed');
    }
    const body = JSON.parse(String(init.body ?? '{}')) as {
      types?: string[];
      enabledServerIds?: string[] | null;
    };
    if (Array.isArray(body.types)) {
      mockState.pushTypes = [...body.types];
    }
    if ('enabledServerIds' in body) {
      mockState.enabledServerIds = body.enabledServerIds === null || body.enabledServerIds === undefined
        ? null
        : [...body.enabledServerIds];
    }
    const recorded = {
      types: [...mockState.pushTypes],
      enabledServerIds: mockState.enabledServerIds === null ? null : [...mockState.enabledServerIds],
    };
    mockState.pushPostPayloads.push(recorded);
    return { ok: true, ...recorded };
  }
  if (path === '/api/auth/user/me') {
    return {
      id: 'user-1',
      username: 'ada',
      displayName: 'Ada',
      hasPassword: true,
      role: 'user',
    };
  }
  if (path.includes('/sessions')) {
    return { sessions: [] };
  }
  if (path.includes('/sub-sessions')) {
    return { subSessions: [] };
  }
  return {};
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => lookupEn(key, opts),
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    configure: vi.fn(),
    configureExpectedUserId: vi.fn(),
    configureApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    getApiKey: vi.fn(() => 'api-key-test'),
    onAuthExpired: vi.fn(),
    startProactiveRefresh: vi.fn(),
    stopProactiveRefresh: vi.fn(),
    refreshSessionIfStale: vi.fn().mockResolvedValue(true),
    apiFetch: ((...args: [string, RequestInit?]) => apiFetchMock(...args)) as typeof import('../src/api.js').apiFetch,
    fetchMe: vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'ada',
      displayName: 'Ada',
      hasPassword: true,
      role: 'user',
    }),
    listP2pRuns: vi.fn().mockResolvedValue({ runs: [] }),
    discoverSharedEntries: vi.fn(async () => mockState.sharedEntries.map((entry) => ({ ...entry }))),
    openSharedEntry: vi.fn(),
    listManagedSharesForServer: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('../src/native.js', () => ({
  isNative: () => false,
  getPlatform: () => 'web',
  setupSafeArea: vi.fn(),
  lockOrientation: vi.fn(),
  hasNativeBackgroundMode: () => false,
  isDesktopApp: () => false,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
}));

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: { setStyle: vi.fn(), setBackgroundColor: vi.fn() },
  Style: { Dark: 'DARK' },
}));
vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn() },
}));
vi.mock('../src/biometric-auth.js', () => ({
  checkBiometricAvailability: vi.fn().mockResolvedValue({ available: false, biometryType: null }),
  hasCredential: vi.fn().mockResolvedValue(false),
  authenticateWithBiometric: vi.fn().mockResolvedValue(false),
  saveCredential: vi.fn().mockResolvedValue(undefined),
  clearCredential: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/ws-client.js', () => ({
  WsClient: vi.fn(() => {
    const messageListeners = new Set<(msg: Record<string, unknown>) => void>();
    return {
      connected: true,
      connectionAttemptInFlight: false,
      connect: vi.fn(() => {
        queueMicrotask(() => {
          for (const listener of messageListeners) {
            listener({ type: 'session.event', event: 'connected' });
            listener({ type: 'session_list', sessions: [] });
          }
        });
      }),
      disconnect: vi.fn(() => {
        messageListeners.clear();
      }),
      reconnectNow: vi.fn(),
      resumeConnection: vi.fn(),
      onMessage: vi.fn((cb: (msg: Record<string, unknown>) => void) => {
        messageListeners.add(cb);
        return () => {
          messageListeners.delete(cb);
        };
      }),
    onStateChange: vi.fn(() => () => {}),
    onLatency: vi.fn(() => () => {}),
    getState: vi.fn(() => 'connected'),
    send: vi.fn(),
    sendInput: vi.fn(),
    sendResize: vi.fn(),
    sendSessionCommand: vi.fn(),
    sendSessionMessage: vi.fn(),
    subscribeTerminal: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeTransportSession: vi.fn(),
    unsubscribeTransportSession: vi.fn(),
    getDaemonCapabilitySnapshot: vi.fn(() => null),
    isDaemonCapabilityStale: vi.fn(() => false),
    onDaemonCapabilityChange: vi.fn(() => () => {}),
    onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
    listSubSessions: vi.fn(),
    listSessions: vi.fn(),
    requestSessionList: vi.fn(),
    setClaudeWeeklyQuotaOptIn: vi.fn(),
    discussionStart: vi.fn(),
    discussionList: vi.fn(),
    discussionStop: vi.fn(),
    p2pStatus: vi.fn(),
    p2pListDiscussions: vi.fn(),
    askAnswer: vi.fn(),
    repoDetect: vi.fn(),
    syncP2pConfig: vi.fn(),
    fsListDir: vi.fn(),
    subSessionRebuildAll: vi.fn(),
    };
  }),
}));

const {
  stableSubSessionsResult,
  stableProviderStatusResult,
  stableUnreadCountsResult,
} = vi.hoisted(() => {
  const emptyArr: never[] = [];
  const noop = () => {};
  return {
    stableSubSessionsResult: {
      subSessions: emptyArr,
      loading: false,
      loaded: true,
      refresh: noop,
      createSubSession: noop,
      closeSubSession: noop,
      renameSubSession: noop,
      setSubSessionPinned: noop,
    },
    stableProviderStatusResult: { providers: emptyArr, refresh: noop, getProvider: noop },
    stableUnreadCountsResult: { unreadCounts: {}, markRead: noop, incrementUnread: noop },
  };
});

vi.mock('../src/hooks/useSubSessions.js', () => ({
  useSubSessions: () => stableSubSessionsResult,
}));
vi.mock('../src/hooks/useProviderStatus.js', () => ({
  useProviderStatus: () => stableProviderStatusResult,
}));
vi.mock('../src/hooks/useUnreadCounts.js', () => ({
  useUnreadCounts: () => stableUnreadCountsResult,
}));
vi.mock('../src/hooks/usePref.js', async () => {
  const { useState } = await import('preact/hooks');
  return {
    parseString: (raw: unknown) => (typeof raw === 'string' ? raw : null),
    parseBooleanish: (raw: unknown) => Boolean(raw),
    usePref: <T,>(_k: string, initial: T) => {
      const [val, setVal] = useState(initial);
      return [val, setVal, false] as const;
    },
  };
});
vi.mock('../src/hooks/useSyncedPreference.js', async () => {
  const { useState } = await import('preact/hooks');
  return {
    useSyncedPreference: <T,>(_k: string, initial: T) => {
      const [val, setVal] = useState(initial);
      return [val, setVal, true] as const;
    },
  };
});
vi.mock('../src/git-status-store.js', () => ({
  useSharedGitChanges: () => [],
  requestSharedChanges: vi.fn(),
}));
vi.mock('../src/watch-bridge.js', () => ({
  onWatchCommand: () => Promise.resolve(() => {}),
  sendWatchSnapshot: vi.fn(),
}));
vi.mock('../src/watch-projection.js', () => ({
  watchProjectionStore: {
    update: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getSnapshot: vi.fn(() => ({})),
    setApiKey: vi.fn(),
    setSnapshotStatus: vi.fn(),
    setServers: vi.fn(),
    setCurrentServerId: vi.fn(),
    beginServerSwitch: vi.fn(),
    addSubSession: vi.fn(),
    removeSubSession: vi.fn(),
    updateSessionState: vi.fn(),
    updateFromSessionListWithSubs: vi.fn(),
    handleTimelineEvent: vi.fn(),
    pushDurableEvent: vi.fn(),
    onSessionIdle: vi.fn(),
  },
}));
vi.mock('../src/hooks/useTimeline.js', () => ({
  syncIncognitoTimelineSessions: vi.fn(),
  forgetIncognitoTimelineSessions: vi.fn(),
  ingestTimelineEventForCache: vi.fn(),
  requestActiveTimelineRefresh: vi.fn(),
  dispatchActiveTimelineRefresh: vi.fn(),
  requestActiveTimelineRefreshAfterUserAction: vi.fn(),
}));
vi.mock('../src/components/ErrorBoundary.js', () => ({
  ErrorBoundary: ({ children }: { children: unknown }) => children,
}));
vi.mock('../src/components/LanguageSwitcher.js', () => ({ LanguageSwitcher: textComponent('language-switcher') }));
vi.mock('../src/pages/LoginPage.js', () => ({ LoginPage: textComponent('login-page') }));
vi.mock('../src/pages/ServerSetupPage.js', () => ({ ServerSetupPage: textComponent('server-setup-page') }));
vi.mock('../src/pages/NativeAuthBridge.js', () => ({ NativeAuthBridge: textComponent('native-auth-bridge') }));
vi.mock('../src/pages/DashboardPage.js', () => ({ DashboardPage: textComponent('dashboard-page') }));
vi.mock('../src/pages/DiscussionsPage.js', () => ({ DiscussionsPage: textComponent('discussions-page') }));
vi.mock('../src/pages/RepoPage.js', () => ({ RepoPage: textComponent('repo-page') }));
vi.mock('../src/pages/AdminPage.js', () => ({ AdminPage: textComponent('admin-page') }));
vi.mock('../src/pages/CronManager.js', () => ({ CronManager: textComponent('cron-manager') }));
vi.mock('../src/components/Sidebar.js', () => ({
  Sidebar: ({ children }: { children?: unknown }) => <div>{children}</div>,
  loadSidebarCollapsed: () => false,
  saveSidebarCollapsed: vi.fn(),
}));
vi.mock('../src/components/SessionTree.js', () => ({ SessionTree: textComponent('session-tree') }));
vi.mock('../src/components/SessionTabs.js', () => ({ SessionTabs: textComponent('session-tabs') }));
vi.mock('../src/components/StableSessionPane.js', () => ({ StableSessionPane: textComponent('session-pane') }));
vi.mock('../src/components/SubSessionBar.js', () => ({
  SubSessionBar: textComponent('sub-session-bar'),
  SUBSESSION_BAR_COLLAPSED_MIGRATION_KEY: 'sub_collapsed_mig',
  SUBSESSION_BAR_COLLAPSED_STORAGE_KEY: 'sub_collapsed',
}));
vi.mock('../src/components/StableSubSessionWindow.js', () => ({ StableSubSessionWindow: textComponent('sub-session-window') }));
vi.mock('../src/components/ShareSessionDialog.js', () => ({ ShareSessionDialog: textComponent('share-session-dialog') }));
vi.mock('../src/components/DocShareDialog.js', () => ({ ExternalDocShareSpace: textComponent('doc-share') }));
vi.mock('../src/components/DesktopWindowMaximizeButton.js', () => ({ DesktopWindowMaximizeButton: textComponent('max-btn') }));
vi.mock('../src/components/NewSessionDialog.js', () => ({ NewSessionDialog: textComponent('new-session') }));
vi.mock('../src/components/StartSubSessionDialog.js', () => ({ StartSubSessionDialog: textComponent('start-sub') }));
vi.mock('../src/components/SessionSettingsDialog.js', () => ({
  SessionSettingsDialog: textComponent('session-settings'),
  SupervisionSettingsDialog: textComponent('supervision-settings'),
}));
vi.mock('../src/components/CloneSessionGroupDialog.js', () => ({ CloneSessionGroupDialog: textComponent('clone-group') }));
vi.mock('../src/components/StartDiscussionDialog.js', () => ({ StartDiscussionDialog: textComponent('start-discussion') }));
vi.mock('../src/components/AskQuestionDialog.js', () => ({ AskQuestionDialog: textComponent('ask-question') }));
vi.mock('../src/components/FloatingPanel.js', () => ({ FloatingPanel: ({ children }: { children?: unknown }) => <div>{children}</div> }));
vi.mock('../src/components/SharedContextManagementPanel.js', () => ({ SharedContextManagementPanel: textComponent('shared-mgmt') }));
vi.mock('../src/components/ControlledNodesPanel.js', () => ({ ControlledNodesPanel: textComponent('controlled-nodes') }));
vi.mock('../src/components/ControlledNodeQuickMenu.js', () => ({ ControlledNodeQuickMenu: textComponent('controlled-quick') }));
vi.mock('../src/components/RemoteDesktopPanel.js', () => ({ RemoteDesktopPanel: textComponent('rd-panel') }));
vi.mock('../src/components/RemoteDesktopWorkspace.js', () => ({ RemoteDesktopWorkspace: textComponent('rd-workspace') }));
vi.mock('../src/components/RemoteDesktopWall.js', () => ({
  REMOTE_DESKTOP_WALL_WINDOW_ID: 'remote-desktop-wall',
  RemoteDesktopWall: textComponent('rd-wall'),
}));
vi.mock('../src/components/ContextDiagnosticsPanel.js', () => ({ ContextDiagnosticsPanel: textComponent('ctx-diag') }));
vi.mock('../src/components/NewUserGuide.js', () => ({ NewUserGuide: textComponent('guide') }));
vi.mock('../src/components/P2pRingProgress.js', () => ({ P2pRingProgress: textComponent('p2p-ring') }));
vi.mock('../src/components/SidebarPinnedPanel.js', () => ({ SidebarPinnedPanel: textComponent('sidebar-pinned') }));
vi.mock('../src/components/LocalWebPreviewPanel.js', () => ({ LocalWebPreviewPanel: textComponent('local-web-preview') }));
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: textComponent('file-browser') }));
vi.mock('../src/components/pinnedPanelTypes.js', () => ({
  LOCAL_WEB_PREVIEW_PANEL_TYPE: 'local-web-preview',
  SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE: 'shared-context-diagnostics',
  SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE: 'shared-context-management',
}));

function seedAuth() {
  localStorage.setItem('rcc_auth', JSON.stringify({
    userId: 'user-1',
    baseUrl: 'https://deck.example.test',
  }));
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('App server push controls integration', () => {
  let AppComponent: typeof import('../src/app.js').App;
  let pollCallbacks: Array<() => void>;
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const mod = await import('../src/app.js');
    AppComponent = mod.App;
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    seedAuth();
    mockState.servers = [];
    mockState.machines = [];
    mockState.sharedEntries = [];
    mockState.pushTypes = ['session.idle', 'session.notification'];
    mockState.enabledServerIds = null;
    mockState.failNextPushSave = false;
    mockState.deferPushSaves = [];
    mockState.holdPushSaves = false;
    mockState.pushPostPayloads = [];
    pollCallbacks = [];
    const origSetInterval = globalThis.setInterval;
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((cb: TimerHandler, ms?: number) => {
      if (ms === 30_000 && typeof cb === 'function') {
        pollCallbacks.push(cb as () => void);
      }
      return origSetInterval(cb, ms);
    }) as typeof globalThis.setInterval);
    const pushMod = await import('../src/push-notifications.js');
    pushMod.resetPushNotificationPreferencesStateForTesting();
  });

  afterEach(() => {
    cleanup();
    pollCallbacks = [];
    setIntervalSpy.mockRestore();
  });

  function renderApp() {
    return render(<AppComponent />);
  }

  async function triggerServerPoll() {
    await act(async () => {
      for (const cb of [...pollCallbacks]) cb();
      await flushAsync();
    });
  }

  it('does not prompt on cold boot (1 or 2 servers) and renders desktop & mobile badges accurately', async () => {
    mockState.servers = [
      { id: 'srv-1', name: 'Office Mac', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
    ];
    mockState.enabledServerIds = null;

    const { container, queryByTestId, unmount } = renderApp();

    await waitFor(() => {
      expect(container.querySelector('.server-icon-server')).not.toBeNull();
    }, { timeout: 4000 });

    // Initial sync must not show new-device prompt
    expect(queryByTestId('new-device-push-prompt')).toBeNull();

    // 1 server with null -> speaker (enabled) badge on desktop
    const desktopBadge = container.querySelector('.server-icon-server .server-icon-push-badge');
    expect(desktopBadge).not.toBeNull();
    expect(desktopBadge?.getAttribute('data-push-state')).toBe('enabled');

    // Open mobile menu and verify inline badge is also enabled
    const mobileMenuBtn = await waitFor(() => {
      const btn = container.querySelector('.mobile-server-btn') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(mobileMenuBtn);
    await waitFor(() => {
      const mobileBadge = container.querySelector('.mobile-server-menu-server .server-icon-push-badge');
      expect(mobileBadge).not.toBeNull();
      expect(mobileBadge?.getAttribute('data-push-state')).toBe('enabled');
    });

    unmount();

    // Cold boot with 2 owned servers and enabledServerIds=null -> both muted, zero prompt
    const pushMod = await import('../src/push-notifications.js');
    pushMod.resetPushNotificationPreferencesStateForTesting();
    mockState.servers = [
      { id: 'srv-1', name: 'Office Mac', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
      { id: 'srv-2', name: 'Home Linux', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 2 },
    ];
    const second = renderApp();
    await waitFor(() => {
      expect(second.container.querySelectorAll('.server-icon-server .server-icon-push-badge').length).toBe(2);
    }, { timeout: 4000 });
    expect(second.queryByTestId('new-device-push-prompt')).toBeNull();
    const states = Array.from(second.container.querySelectorAll('.server-icon-server .server-icon-push-badge'))
      .map((el) => el.getAttribute('data-push-state'));
    expect(states).toEqual(['muted', 'muted']);
  }, 15_000);

  it('prompts once for newly bound server, preserves prior auto-enabled server on 1->2 null->explicit conversion, and dedupes across polls & reloads', async () => {
    mockState.servers = [
      { id: 'srv-1', name: 'Office Mac', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
    ];
    mockState.enabledServerIds = null;

    const first = renderApp();
    await waitFor(() => {
      expect(first.container.querySelector('.server-icon-server .server-icon-push-badge')?.getAttribute('data-push-state')).toBe('enabled');
    }, { timeout: 4000 });
    expect(first.queryByTestId('new-device-push-prompt')).toBeNull();

    // Bind a second server after initial sync
    mockState.servers = [
      ...mockState.servers,
      { id: 'srv-2', name: 'Build Box', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 2 },
    ];
    await triggerServerPoll();

    await waitFor(() => {
      expect(first.queryByTestId('new-device-push-prompt')).not.toBeNull();
    });
    expect(first.getByTestId('new-device-push-prompt').textContent).toContain('Build Box');

    // Polling again while prompt is queued should not duplicate prompts
    await triggerServerPoll();
    expect(first.queryAllByTestId('new-device-push-prompt').length).toBe(1);

    // Click Enable: must convert null -> ['srv-1', 'srv-2'] (preserving auto-enabled srv-1!)
    fireEvent.click(first.getByTestId('new-device-push-enable'));

    await waitFor(() => {
      expect(first.queryByTestId('new-device-push-prompt')).toBeNull();
      expect(mockState.pushPostPayloads.length).toBe(1);
    });
    expect(mockState.pushPostPayloads[0].enabledServerIds).toEqual(['srv-1', 'srv-2']);

    // Badges on both servers should now be enabled
    await waitFor(() => {
      const states = Array.from(first.container.querySelectorAll('.server-icon-server .server-icon-push-badge'))
        .map((el) => el.getAttribute('data-push-state'));
      expect(states).toEqual(['enabled', 'enabled']);
    });

    // Remount app preserving localStorage -> must not re-prompt for srv-2
    first.unmount();
    const pushMod = await import('../src/push-notifications.js');
    pushMod.resetPushNotificationPreferencesStateForTesting();
    const reloaded = renderApp();
    await waitFor(() => {
      expect(reloaded.container.querySelectorAll('.server-icon-server .server-icon-push-badge').length).toBe(2);
    }, { timeout: 4000 });
    expect(reloaded.queryByTestId('new-device-push-prompt')).toBeNull();

    // Now bind a 3rd server and click Keep muted -> keeps srv-1 & srv-2 enabled, srv-3 muted
    mockState.servers = [
      ...mockState.servers,
      { id: 'srv-3', name: 'Cloud VM', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 3 },
    ];
    await triggerServerPoll();
    await waitFor(() => {
      expect(reloaded.queryByTestId('new-device-push-prompt')).not.toBeNull();
    });
    fireEvent.click(reloaded.getByTestId('new-device-push-mute'));
    await waitFor(() => {
      expect(reloaded.queryByTestId('new-device-push-prompt')).toBeNull();
      expect(mockState.pushPostPayloads.length).toBe(2);
    });
    expect(mockState.pushPostPayloads[1].enabledServerIds).toEqual(['srv-1', 'srv-2']);
  }, 15_000);

  it('handles 0->1 newly bound Keep muted (null->[]) without breaking explicit empty semantics', async () => {
    mockState.servers = [];
    mockState.enabledServerIds = null;

    const { queryByTestId, container, getByTestId } = renderApp();
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/server');
    });
    expect(queryByTestId('new-device-push-prompt')).toBeNull();

    mockState.servers = [
      { id: 'srv-only', name: 'Solo Box', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
    ];
    await triggerServerPoll();

    await waitFor(() => {
      expect(queryByTestId('new-device-push-prompt')).not.toBeNull();
    });
    fireEvent.click(getByTestId('new-device-push-mute'));

    await waitFor(() => {
      expect(queryByTestId('new-device-push-prompt')).toBeNull();
      expect(mockState.pushPostPayloads.length).toBe(1);
    });
    expect(mockState.pushPostPayloads[0].enabledServerIds).toEqual([]);
    await waitFor(() => {
      expect(container.querySelector('.server-icon-server .server-icon-push-badge')?.getAttribute('data-push-state')).toBe('muted');
    });
  }, 15_000);

  it('syncs server right-click Mute/Unmute (desktop & mobile) with Settings Notifications, excludes shared-in servers, and rolls back on failure', async () => {
    mockState.servers = [
      { id: 'srv-1', name: 'Alpha Server', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
      { id: 'srv-2', name: 'Beta Server', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 2 },
    ];
    mockState.sharedEntries = [
      {
        id: 'share-1',
        serverId: 'srv-shared',
        serverName: 'External Shared',
        role: 'participant',
        status: 'active',
        target: { kind: 'server', serverId: 'srv-shared' },
        targetLabel: 'External Shared',
        serverStatus: 'online',
        lastHeartbeatAt: Date.now(),
      },
    ];
    mockState.enabledServerIds = ['srv-1'];

    const { container, queryByTestId, getByTestId } = renderApp();

    await waitFor(() => {
      // Only 2 owned servers get push badges; shared-in srv-shared must have no badge
      expect(container.querySelectorAll('.server-icon-server').length).toBe(3);
      expect(container.querySelectorAll('.server-icon-server .server-icon-push-badge').length).toBe(2);
    }, { timeout: 4000 });

    const getDesktopBtn = (name: string) =>
      Array.from(container.querySelectorAll('.server-icon-server'))
        .find((b) => b.getAttribute('title')?.includes(name)) as HTMLButtonElement;
    const alphaBtn = getDesktopBtn('Alpha Server');
    const betaBtn = getDesktopBtn('Beta Server');
    const sharedBtn = getDesktopBtn('External Shared');
    expect(sharedBtn.querySelector('.server-icon-push-badge')).toBeNull();
    expect(alphaBtn.querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe('enabled');
    expect(betaBtn.querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe('muted');

    // Right-clicking shared-in server opens Pin-only context menu and never shows push-mute or owner controls
    fireEvent.contextMenu(sharedBtn);
    const sharedPinBtn = await waitFor(() => getByTestId('server-ctx-toggle-pin'));
    expect(sharedPinBtn.textContent).toContain('Pin');
    expect(queryByTestId('server-ctx-toggle-push-mute')).toBeNull();
    expect(container.querySelectorAll('.server-ctx-item').length).toBe(1);

    // Right-click Alpha Server -> Mute notifications
    fireEvent.contextMenu(alphaBtn);
    const toggleBtn = await waitFor(() => getByTestId('server-ctx-toggle-push-mute'));
    expect(toggleBtn.textContent).toContain('Mute notifications');
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockState.enabledServerIds).toEqual([]);
      expect(getDesktopBtn('Alpha Server').querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe('muted');
    });

    // Open mobile menu and verify badges + right-click Unmute from mobile
    const mobileMenuBtn = await waitFor(() => {
      const btn = container.querySelector('.mobile-server-btn') as HTMLButtonElement | null;
      expect(btn).not.toBeNull();
      return btn!;
    });
    fireEvent.click(mobileMenuBtn);
    await waitFor(() => {
      expect(container.querySelectorAll('.mobile-server-menu-server').length).toBe(3);
      expect(container.querySelectorAll('.mobile-server-menu-server .server-icon-push-badge').length).toBe(2);
    });
    const mobileAlpha = Array.from(container.querySelectorAll('.mobile-server-menu-server'))
      .find((el) => el.textContent?.includes('Alpha Server'))!;
    expect(mobileAlpha.querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe('muted');
    fireEvent.contextMenu(mobileAlpha);
    const unmuteBtn = await waitFor(() => getByTestId('server-ctx-toggle-push-mute'));
    expect(unmuteBtn.textContent).toContain('Unmute notifications');

    // API failure rollback on context menu toggle
    mockState.failNextPushSave = true;
    fireEvent.click(unmuteBtn);
    await waitFor(() => {
      expect(container.querySelector('.toast-error')).not.toBeNull();
    });
    expect(mockState.enabledServerIds).toEqual([]);
    expect(getDesktopBtn('Alpha Server').querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe('muted');

    // Open Settings -> Notifications tab and toggle Alpha Server checkbox ON -> syncs back to ServerIconBar
    const settingsBtn = Array.from(container.querySelectorAll('.server-icon-bar button'))
      .find((btn) => btn.textContent?.includes('⚙')) as HTMLButtonElement;
    expect(settingsBtn).toBeDefined();
    fireEvent.click(settingsBtn);
    const settingsOverlay = await waitFor(() => getByTestId('settings-page-overlay'));
    fireEvent.click(within(settingsOverlay).getByRole('tab', { name: 'Notifications' }));
    const alphaCb = await waitFor(() => within(settingsOverlay).getByLabelText(/Alpha Server/) as HTMLInputElement);
    expect(alphaCb.checked).toBe(false);
    fireEvent.click(alphaCb);
    expect(alphaCb.checked).toBe(true);

    await waitFor(() => {
      expect(mockState.enabledServerIds).toEqual(['srv-1']);
    });

    // Close Settings and verify desktop badge immediately reflects enabled state
    fireEvent.click(container.querySelector('[data-testid="settings-page-overlay"] button')!);
    await waitFor(() => expect(queryByTestId('settings-page-overlay')).toBeNull());
    expect(getDesktopBtn('Alpha Server').querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe('enabled');

    // NewDevicePushPrompt failure rollback
    mockState.failNextPushSave = true;
    mockState.servers = [
      ...mockState.servers,
      { id: 'srv-4', name: 'Fail Box', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 4 },
    ];
    await triggerServerPoll();
    const prompt = await waitFor(() => getByTestId('new-device-push-prompt'));
    expect(prompt.textContent).toContain('Fail Box');
    fireEvent.click(getByTestId('new-device-push-enable'));
    await waitFor(() => {
      expect(container.querySelectorAll('.toast-error').length).toBe(2);
    });
    expect(mockState.enabledServerIds).toEqual(['srv-1']);
    expect(container.querySelectorAll('.toast-error')[1]?.textContent).toContain(
      'Failed to update notification setting for this server.',
    );
  }, 15_000);

  it.each([
    {
      transition: '0->1',
      initialServers: [] as MockServer[],
      newServer: { id: 'srv-only', name: 'Solo Box', status: 'online' as const, lastHeartbeatAt: 1, createdAt: 1 },
      actionTestId: 'new-device-push-enable',
      expectedEnabledIds: ['srv-only'],
      expectedNewBadgeState: 'enabled',
    },
    {
      transition: '0->1',
      initialServers: [] as MockServer[],
      newServer: { id: 'srv-only', name: 'Solo Box', status: 'online' as const, lastHeartbeatAt: 1, createdAt: 1 },
      actionTestId: 'new-device-push-mute',
      expectedEnabledIds: [] as string[],
      expectedNewBadgeState: 'muted',
    },
    {
      transition: '0->1',
      initialServers: [] as MockServer[],
      newServer: { id: 'srv-only', name: 'Solo Box', status: 'online' as const, lastHeartbeatAt: 1, createdAt: 1 },
      actionTestId: 'new-device-push-dismiss',
      expectedEnabledIds: [] as string[],
      expectedNewBadgeState: 'muted',
    },
    {
      transition: '1->2',
      initialServers: [{ id: 'srv-1', name: 'Office Mac', status: 'online' as const, lastHeartbeatAt: 1, createdAt: 1 }],
      newServer: { id: 'srv-2', name: 'Build Box', status: 'online' as const, lastHeartbeatAt: 2, createdAt: 2 },
      actionTestId: 'new-device-push-enable',
      expectedEnabledIds: ['srv-1', 'srv-2'],
      expectedNewBadgeState: 'enabled',
    },
    {
      transition: '1->2',
      initialServers: [{ id: 'srv-1', name: 'Office Mac', status: 'online' as const, lastHeartbeatAt: 1, createdAt: 1 }],
      newServer: { id: 'srv-2', name: 'Build Box', status: 'online' as const, lastHeartbeatAt: 2, createdAt: 2 },
      actionTestId: 'new-device-push-mute',
      expectedEnabledIds: ['srv-1'],
      expectedNewBadgeState: 'muted',
    },
    {
      transition: '1->2',
      initialServers: [{ id: 'srv-1', name: 'Office Mac', status: 'online' as const, lastHeartbeatAt: 1, createdAt: 1 }],
      newServer: { id: 'srv-2', name: 'Build Box', status: 'online' as const, lastHeartbeatAt: 2, createdAt: 2 },
      actionTestId: 'new-device-push-dismiss',
      expectedEnabledIds: ['srv-1'],
      expectedNewBadgeState: 'muted',
    },
  ])(
    'persists new-device prompt $transition action ($actionTestId) with failure retry and busy dismiss lock',
    async ({ initialServers, newServer, actionTestId, expectedEnabledIds, expectedNewBadgeState }) => {
      mockState.servers = initialServers.map((s) => ({ ...s }));
      mockState.enabledServerIds = null;

      const view = renderApp();
      await waitFor(() => {
        expect(apiFetchMock).toHaveBeenCalledWith('/api/server');
        expect(view.container.querySelectorAll('.server-icon-server').length).toBe(initialServers.length);
      }, { timeout: 4000 });

      mockState.servers = [...mockState.servers, { ...newServer }];
      await triggerServerPoll();
      await waitFor(() => expect(view.queryByTestId('new-device-push-prompt')).not.toBeNull());

      // First attempt fails: must keep prompt retryable, NOT mark handled, and roll back local to null
      mockState.failNextPushSave = true;
      fireEvent.click(view.getByTestId(actionTestId));
      await waitFor(() => {
        expect(view.container.querySelector('.toast-error')).not.toBeNull();
      });
      expect(view.queryByTestId('new-device-push-prompt')).not.toBeNull();
      expect(mockState.pushPostPayloads.length).toBe(0);
      expect(mockState.enabledServerIds).toBeNull();

      // Hold the retry POST in flight -> all 3 buttons including × close must be disabled
      mockState.holdPushSaves = true;
      fireEvent.click(view.getByTestId(actionTestId));
      await waitFor(() => expect(mockState.deferPushSaves.length).toBe(1));
      expect((view.getByTestId('new-device-push-enable') as HTMLButtonElement).disabled).toBe(true);
      expect((view.getByTestId('new-device-push-mute') as HTMLButtonElement).disabled).toBe(true);
      expect((view.getByTestId('new-device-push-dismiss') as HTMLButtonElement).disabled).toBe(true);

      // Resolve in-flight POST -> handled persisted, prompt closes, badge & remote match
      mockState.holdPushSaves = false;
      await act(async () => {
        mockState.deferPushSaves.shift()?.resolve();
        await flushAsync();
      });

      await waitFor(() => {
        expect(view.queryByTestId('new-device-push-prompt')).toBeNull();
        expect(mockState.pushPostPayloads.length).toBe(1);
      });
      expect(mockState.pushPostPayloads[0].enabledServerIds).toEqual(expectedEnabledIds);
      expect(mockState.enabledServerIds).toEqual(expectedEnabledIds);

      const newBtn = Array.from(view.container.querySelectorAll('.server-icon-server'))
        .find((b) => b.getAttribute('title')?.includes(newServer.name));
      expect(newBtn?.querySelector('.server-icon-push-badge')?.getAttribute('data-push-state')).toBe(expectedNewBadgeState);

      // Remount preserving localStorage -> must not re-prompt once succeeded
      view.unmount();
      const pushMod = await import('../src/push-notifications.js');
      pushMod.resetPushNotificationPreferencesStateForTesting();
      const reloaded = renderApp();
      await waitFor(() => {
        expect(reloaded.container.querySelectorAll('.server-icon-server').length).toBe(initialServers.length + 1);
      }, { timeout: 4000 });
      expect(reloaded.queryByTestId('new-device-push-prompt')).toBeNull();
    },
    15_000,
  );

  it('keeps Settings checkboxes and App badges at confirmed snapshot across concurrent App + Settings double failures', async () => {
    mockState.servers = [
      { id: 'srv-1', name: 'Alpha Server', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 1 },
      { id: 'srv-2', name: 'Beta Server', status: 'online', lastHeartbeatAt: Date.now(), createdAt: 2 },
    ];
    mockState.enabledServerIds = [];

    const view = renderApp();
    await waitFor(() => {
      expect(view.container.querySelectorAll('.server-icon-server .server-icon-push-badge').length).toBe(2);
    }, { timeout: 4000 });

    const getDesktopBadge = (name: string) =>
      Array.from(view.container.querySelectorAll('.server-icon-server'))
        .find((b) => b.getAttribute('title')?.includes(name))
        ?.querySelector('.server-icon-push-badge')
        ?.getAttribute('data-push-state');

    // Open Settings -> Notifications
    const settingsBtn = Array.from(view.container.querySelectorAll('.server-icon-bar button'))
      .find((btn) => btn.textContent?.includes('⚙')) as HTMLButtonElement;
    fireEvent.click(settingsBtn);
    const settingsOverlay = await waitFor(() => view.getByTestId('settings-page-overlay'));
    fireEvent.click(within(settingsOverlay).getByRole('tab', { name: 'Notifications' }));
    const alphaCb = await waitFor(() => within(settingsOverlay).getByLabelText(/Alpha Server/) as HTMLInputElement);
    const betaCb = within(settingsOverlay).getByLabelText(/Beta Server/) as HTMLInputElement;
    expect(alphaCb.checked).toBe(false);
    expect(betaCb.checked).toBe(false);

    // Hold POSTs: A (App context menu unmute srv-1) then B (Settings checkbox srv-2), both fail!
    mockState.holdPushSaves = true;
    const alphaBtn = Array.from(view.container.querySelectorAll('.server-icon-server'))
      .find((b) => b.getAttribute('title')?.includes('Alpha Server')) as HTMLButtonElement;
    fireEvent.contextMenu(alphaBtn);
    const unmuteBtn = await waitFor(() => view.getByTestId('server-ctx-toggle-push-mute'));
    fireEvent.click(unmuteBtn);
    await waitFor(() => expect(mockState.deferPushSaves.length).toBe(1));

    // While A is in flight, user clicks Beta Server in Settings (serialized behind A)
    fireEvent.click(betaCb);

    // Reject POST A -> serialized queue launches POST B -> reject POST B as well
    await act(async () => {
      mockState.deferPushSaves.shift()?.reject(new Error('App POST A failed'));
      await flushAsync();
    });
    await waitFor(() => expect(mockState.deferPushSaves.length).toBe(1));
    mockState.holdPushSaves = false;
    await act(async () => {
      mockState.deferPushSaves.shift()?.reject(new Error('Settings POST B failed'));
      await flushAsync();
    });

    const pushMod = await import('../src/push-notifications.js');
    await waitFor(() => {
      expect(pushMod.getLocalPushEnabledServers()).toEqual([]);
      expect(pushMod.hasUnsyncedPushEnabledServerEdits()).toBe(false);
    });
    expect(mockState.enabledServerIds).toEqual([]);
    expect((within(settingsOverlay).getByLabelText(/Alpha Server/) as HTMLInputElement).checked).toBe(false);
    expect((within(settingsOverlay).getByLabelText(/Beta Server/) as HTMLInputElement).checked).toBe(false);
    expect(getDesktopBadge('Alpha Server')).toBe('muted');
    expect(getDesktopBadge('Beta Server')).toBe('muted');

    // Settings Select All + Clear double failure also cleanly reverts both Settings and App badges to []
    mockState.holdPushSaves = true;
    fireEvent.click(within(settingsOverlay).getByRole('button', { name: 'Select All' }));
    await waitFor(() => expect(mockState.deferPushSaves.length).toBe(1));
    fireEvent.click(within(settingsOverlay).getByRole('button', { name: 'Clear' }));
    await act(async () => {
      mockState.deferPushSaves.shift()?.reject(new Error('Settings Select All failed'));
      await flushAsync();
    });
    await waitFor(() => expect(mockState.deferPushSaves.length).toBe(1));
    mockState.holdPushSaves = false;
    await act(async () => {
      mockState.deferPushSaves.shift()?.reject(new Error('Settings Clear failed'));
      await flushAsync();
    });
    await waitFor(() => {
      expect(pushMod.getLocalPushEnabledServers()).toEqual([]);
      expect(pushMod.hasUnsyncedPushEnabledServerEdits()).toBe(false);
    });
    expect((within(settingsOverlay).getByLabelText(/Alpha Server/) as HTMLInputElement).checked).toBe(false);
    expect((within(settingsOverlay).getByLabelText(/Beta Server/) as HTMLInputElement).checked).toBe(false);
    expect(getDesktopBadge('Alpha Server')).toBe('muted');
    expect(getDesktopBadge('Beta Server')).toBe('muted');
  }, 15_000);
});
