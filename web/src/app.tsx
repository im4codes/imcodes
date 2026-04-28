import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
import {
  MutableDesktopWindowStack,
  DESKTOP_WINDOW_IDS,
  DESKTOP_WINDOW_KINDS,
  getFrontmostSubSessionId,
  openSubIdsKey,
  type DesktopWindowMeta,
} from './window-stack.js';
import { lazy, Suspense } from 'preact/compat';
import {
  FileBrowser,
  type FileBrowserPreviewRequest,
  type FileBrowserPreviewState,
  type FileBrowserPreviewUpdate,
} from './components/file-browser-lazy.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import { RECONNECT_GRACE_MS } from '@shared/ack-protocol.js';
import { mapP2pRunToDiscussion, mergeP2pDiscussionUpdate } from './p2p-run-mapping.js';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { LanguageSwitcher } from './components/LanguageSwitcher.js';
import { LoginPage } from './pages/LoginPage.js';
import { SessionTabs } from './components/SessionTabs.js';
// TransportChatView removed — transport sessions use unified ChatView via timelineEmitter
import { SessionPane } from './components/SessionPane.js';
import { useQuickData } from './components/QuickInputPanel.js';
import { NewSessionDialog } from './components/NewSessionDialog.js';
import { SubSessionBar } from './components/SubSessionBar.js';
import { SubSessionWindow } from './components/SubSessionWindow.js';
import { useSharedGitChanges, requestSharedChanges } from './git-status-store.js';
import { StartSubSessionDialog } from './components/StartSubSessionDialog.js';
import { SessionSettingsDialog } from './components/SessionSettingsDialog.js';
import { StartDiscussionDialog, type DiscussionPrefs, type SubSessionOption } from './components/StartDiscussionDialog.js';
import { AskQuestionDialog, type PendingQuestion } from './components/AskQuestionDialog.js';
import { ServerContextMenu, DeleteServerDialog } from './components/ServerContextMenu.js';
import { RepoPage } from './pages/RepoPage.js';
import { FloatingPanel } from './components/FloatingPanel.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { CronManager } from './pages/CronManager.js';
import { SharedContextManagementPanel } from './components/SharedContextManagementPanel.js';
import { ContextDiagnosticsPanel } from './components/ContextDiagnosticsPanel.js';
import { NewUserGuide, type NewUserGuideStep } from './components/NewUserGuide.js';
import { ServerIconBar } from './components/ServerIconBar.js';
import { Sidebar, loadSidebarCollapsed, saveSidebarCollapsed } from './components/Sidebar.js';
import { SessionTree } from './components/SessionTree.js';
import { P2pRingProgress } from './components/P2pRingProgress.js';
import { useUnreadCounts } from './hooks/useUnreadCounts.js';
import { SidebarPinnedPanel } from './components/SidebarPinnedPanel.js';
import type { PanelRenderContext } from './components/PinnedPanelRegistry.js';
import './components/pinnedPanelTypes.js'; // register all panel types
import {
  LOCAL_WEB_PREVIEW_PANEL_TYPE,
  SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE,
  SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE,
} from './components/pinnedPanelTypes.js';
import { LocalWebPreviewPanel } from './components/LocalWebPreviewPanel.js';
import { formatDaemonVersionShort } from './util/format-version.js';
import { getSessionRuntimeType } from '@shared/agent-types.js';
import { mergeSessionListEntry, type IncomingSessionListEntry } from './session-list-merge.js';
import { resolveSessionInfoRuntimeType } from './runtime-type.js';
import { useSyncedPreference } from './hooks/useSyncedPreference.js';
import { parseString, usePref } from './hooks/usePref.js';
import { PREF_KEY_DEFAULT_SHELL, PREF_KEY_P2P_SESSION_CONFIG_LEGACY, p2pSessionConfigPrefKey } from './constants/prefs.js';
import {
  p2pSubSessionParentSignature,
  parseP2pSavedConfig,
  resolveP2pRootSession,
  serializeP2pSavedConfig,
} from './preferences/p2p-config-pref.js';
import { resolveInitialServerId, resolveInitialSessionName, writeHashState } from './hooks/useHashState.js';
import { useSubSessions, type SubSession } from './hooks/useSubSessions.js';
import { useProviderStatus } from './hooks/useProviderStatus.js';
import { DEFAULT_NEW_USER_GUIDE_PREF, shouldMarkNewUserGuidePending, shouldShowNewUserGuidePrompt, type NewUserGuidePref } from './onboarding.js';
// useSwipeBack now handled inside FloatingPanel for discussion/repo pages
import { WsClient } from './ws-client.js';
import { configure as configureApi, apiFetch, onAuthExpired, startProactiveRefresh, stopProactiveRefresh, refreshSessionIfStale, ApiError, configureApiKey, clearApiKey, fetchMe, getApiKey, normalizeLocalWebPreviewPath, listP2pRuns } from './api.js';
import { isNative, getServerUrl, clearServerUrl } from './native.js';
import { getAuthKey, clearAuthKey } from './biometric-auth.js';
import { initPushNotifications, resetPushBadge } from './push-notifications.js';
import { ServerSetupPage } from './pages/ServerSetupPage.js';
import { NativeAuthBridge } from './pages/NativeAuthBridge.js';
import type { SessionInfo, TerminalDiff } from './types.js';
import { REPO_MSG } from '@shared/repo-types.js';
import {
  buildTerminalResubscribePlan,
  listGlobalTransportSubSessionNames,
  listGlobalTransportSubscriptionNames,
  listPassiveTerminalSubSessionNames,
  listPassiveTerminalSubscriptionNames,
  shouldSubscribeTerminalRaw,
  type TerminalSubscribeViewMode,
} from './terminal-subscribe-mode.js';
import { onWatchCommand } from './watch-bridge.js';
import { watchProjectionStore } from './watch-projection.js';
import { isIdleSessionStateTimelineEvent, isRunningTimelineEvent } from './timeline-running.js';
import {
  extractTransportPendingMessages,
  mergeTransportPendingEntriesForIdleState,
  mergeTransportPendingEntriesForRunningState,
  mergeTransportPendingMessagesForIdleState,
  mergeTransportPendingMessagesForRunningState,
  normalizeTransportPendingEntries,
} from './transport-queue.js';
import { ingestTimelineEventForCache, requestActiveTimelineRefresh } from './hooks/useTimeline.js';
import { getMobileKeyboardState } from './mobile-keyboard.js';
import { pickReadableSessionDisplay } from '@shared/session-display.js';
import { updateMainSessionLabel } from './session-label-api.js';
import { buildDocumentTitle } from './tab-title.js';
import {
  getDaemonBadgeState,
  getSelectedServerName,
  hasResolvedActiveSession,
  isServerOnline,
  pickAutoEntryServer,
  pickMostRecentMainSession,
  shouldResetSelectedServer,
  shouldShowInitialConnectingGate,
} from './server-selection.js';
import { installNativeAppResumeRefresh } from './app-resume-refresh.js';
import { markServerLive, markServerOffline, touchServerHeartbeat } from './server-online-state.js';
import { MSG_DAEMON_ONLINE, MSG_DAEMON_OFFLINE } from '@shared/ack-protocol.js';

const DashboardPage = lazy(() => import('./pages/DashboardPage.js').then((m) => ({ default: m.DashboardPage })));
const DiscussionsPage = lazy(() => import('./pages/DiscussionsPage.js').then((m) => ({ default: m.DiscussionsPage })));


// On web: if opened by the native app for passkey auth, render the bridge page.
const nativeCallback = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('native_callback')
  : null;

type ViewMode = TerminalSubscribeViewMode;

type SharedContextDiagnosticsWindowState = {
  enterpriseId?: string;
  canonicalRepoId?: string;
  workspaceId?: string;
  enrollmentId?: string;
  language?: string;
  filePath?: string;
};

function buildSessionToastLabel(
  sessionName: string,
  options: {
    label?: string | null;
    parentLabel?: string | null;
    project?: string | null;
    agentType?: string | null;
  },
): string {
  const label = pickReadableSessionDisplay([options.label], sessionName);
  const parentLabel = pickReadableSessionDisplay([options.parentLabel], sessionName);
  const project = pickReadableSessionDisplay([options.project], sessionName);
  const agentType = options.agentType?.trim() || undefined;
  const typeSuffix = agentType ? `(${agentType})` : '';

  if (sessionName.startsWith('deck_sub_')) {
    const name = label || parentLabel || project || agentType || sessionName.replace(/^deck_sub_/, '');
    return `${name}${label ? typeSuffix : ''}${parentLabel && name !== parentLabel ? `@${parentLabel}` : ''}`;
  }

  const name = label || project || sessionName;
  return `${name}${typeSuffix}`;
}

/** A panel pinned to the sidebar. Uses sessionName as stable identity. */
export interface PinnedPanel {
  /** Unique ID for this pinned panel instance */
  id: string;
  /** Panel type — used by registry to determine how to render */
  type: string;
  /** Serializable props captured at pin time */
  props: Record<string, unknown>;
}

function getFilePreviewInitialPath(request: FileBrowserPreviewRequest): string {
  if (request.rootPath) return request.rootPath;
  const slash = request.path.lastIndexOf('/');
  const backslash = request.path.lastIndexOf('\\');
  const idx = Math.max(slash, backslash);
  if (idx > 0) return request.path.slice(0, idx);
  if (idx === 0) return request.path[0] ?? '~';
  return '~';
}

interface AuthState {
  userId: string;
  baseUrl: string;
}

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  createdAt: number;
}

interface WatchSessionRow {
  serverId: string;
  sessionName: string;
  previewUpdatedAt?: number;
  isSubSession?: boolean;
}

export function App() {
  const { t: trans } = useTranslation();
  const [auth, setAuth] = useState<AuthState | null>(() => {
    try {
      const raw = localStorage.getItem('rcc_auth');
      const state = raw ? (JSON.parse(raw) as AuthState) : null;
      if (state) configureApi(state.baseUrl);
      return state;
    } catch {
      return null;
    }
  });
  const clearAuthState = useCallback(async (reason?: string) => {
    console.warn('[auth] clearing auth state', reason ?? '');
    clearApiKey();
    try { await clearAuthKey(); } catch { /* ignore */ }
    try {
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.remove({ key: 'deck_api_key_id' });
    } catch { /* ignore */ }
    localStorage.removeItem('rcc_auth');
    localStorage.removeItem('rcc_server');
    localStorage.removeItem('rcc_server_name');
    localStorage.removeItem('rcc_session');
    setAuth(null);
    setServers([]);
    setServersLoaded(false);
    setServersSynced(false);
    setSelectedServerId(null);
    setSelectedServerName(null);
    setManualDashboard(false);
    setAutoEnteringRecent(false);
  }, []);

  // Native: server URL state and readiness flag
  const [nativeServerUrl, setNativeServerUrl] = useState<string | null>(null);
  const [nativeReady, setNativeReady] = useState(!isNative()); // web is immediately ready
  const [splashDone, setSplashDone] = useState(false);

  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [serversSynced, setServersSynced] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    () => resolveInitialServerId(),
  );
  const selectedServerIdRef = useRef<string | null>(selectedServerId);
  const [selectedServerName, setSelectedServerName] = useState<string | null>(
    () => localStorage.getItem('rcc_server_name'),
  );
  const [autoEnteringRecent, setAutoEnteringRecent] = useState(false);
  const [manualDashboard, setManualDashboard] = useState(false);
  const autoEntryRunRef = useRef(0);
  const [showMobileServerMenu, setShowMobileServerMenu] = useState(false);
  const [showMobileFileBrowser, setShowMobileFileBrowser] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileHideServerBar, setMobileHideServerBar] = useState(() => localStorage.getItem('mobile_hide_server_bar') === '1');
  const [mobileHideTabBar, setMobileHideTabBar] = useState(() => localStorage.getItem('mobile_hide_tab_bar') === '1');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => loadSidebarCollapsed());
  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);
  useEffect(() => {
    saveSidebarCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);
  const [showDesktopFileBrowser, setShowDesktopFileBrowser] = useState(false);
  const [showDesktopLocalWebPreview, setShowDesktopLocalWebPreview] = useState(false);
  const [localWebPreviewPort, setLocalWebPreviewPort] = useState('');
  const [localWebPreviewPath, setLocalWebPreviewPath] = useState('/');
  // File browser geometry now managed by FloatingPanel (id="filebrowser")
  // NOTE: top-bar 📁 buttons call setShowMobile/DesktopFileBrowser directly.
  // Sub-sessions now own their own FileBrowser inside SubSessionWindow
  // (rooted at sub.cwd, layered above the window) — no shared toggle needed.
  const [serverCtxMenu, setServerCtxMenu] = useState<{ server: ServerInfo; x: number; y: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerInfo | null>(null);

  useEffect(() => {
    if (!auth) {
      setServersLoaded(false);
      setServersSynced(false);
      watchProjectionStore.setApiKey(null);
      watchProjectionStore.setSnapshotStatus('switching');
      watchProjectionStore.setServers([]);
      watchProjectionStore.setCurrentServerId(null);
      watchProjectionStore.setSnapshotStatus('stale');
      return;
    }

    watchProjectionStore.setApiKey(getApiKey());
    watchProjectionStore.setServers(servers.map((server) => ({
      id: server.id,
      name: server.name,
      baseUrl: auth.baseUrl,
    })));
    watchProjectionStore.setCurrentServerId(selectedServerId);
  }, [auth, servers, selectedServerId]);

  useEffect(() => {
    if (!selectedServerId) return;
    watchProjectionStore.beginServerSwitch(selectedServerId);
  }, [selectedServerId]);

  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
    if (selectedServerId) {
      localStorage.setItem('rcc_server', selectedServerId);
      return;
    }
    localStorage.removeItem('rcc_server');
  }, [selectedServerId]);

  const resolvedSelectedServerName = useMemo(
    () => getSelectedServerName(selectedServerId, servers, selectedServerName),
    [selectedServerId, selectedServerName, servers],
  );

  useEffect(() => {
    if (!selectedServerId || servers.length === 0) return;
    if (resolvedSelectedServerName === selectedServerName) return;
    setSelectedServerName(resolvedSelectedServerName);
    if (resolvedSelectedServerName) {
      localStorage.setItem('rcc_server_name', resolvedSelectedServerName);
      return;
    }
    localStorage.removeItem('rcc_server_name');
  }, [resolvedSelectedServerName, selectedServerId, selectedServerName, servers.length]);

  useEffect(() => {
    if (!serversSynced) return;
    if (!shouldResetSelectedServer(selectedServerId, servers, serversLoaded)) return;
    setSelectedServerId(null);
    setSelectedServerName(null);
    setSessionsLoaded(true);
    setConnecting(false);
    localStorage.removeItem('rcc_server');
    localStorage.removeItem('rcc_server_name');
    localStorage.removeItem('rcc_session');
  }, [selectedServerId, servers, serversLoaded]);

  useEffect(() => {
    let cleanup = () => {};
    void onWatchCommand((command) => {
      if (command.action === 'switchServer') {
        setSelectedServerId((prev) => (prev === command.serverId ? prev : command.serverId));
        return;
      }
      if (command.action === 'openSession') {
        setSelectedServerId(command.serverId);
        navigateToSessionRef.current(command.sessionName);
        return;
      }
      wsRef.current?.requestSessionList();
    }).then((dispose) => {
      cleanup = dispose;
    });
    return () => {
      cleanup();
    };
  }, []);

  // Keep layout height within visual viewport on mobile (keyboard-aware)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let inputFocused = false;
    let hadKeyboardOpen = false;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      document.documentElement.style.setProperty('--vvh', `${vv.height}px`);
      // Detect keyboard open: viewport shrink + optional input-focus fallback.
      // Chinese IME candidate bars can be ~40px, so use low threshold when input is focused.
      const shrink = window.innerHeight - vv.height;
      const state = getMobileKeyboardState(inputFocused, shrink, hadKeyboardOpen);
      hadKeyboardOpen = state.hadKeyboardOpen;
      const { kbOpen, hideInputUi } = state;
      document.documentElement.classList.toggle('kb-open', kbOpen);
      document.documentElement.classList.toggle('input-focused', hideInputUi);
      // Reset any scroll/offset caused by keyboard opening on mobile.
      // Always reset — iOS can have vv.offsetTop > 0 even when scrollY is 0.
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      // Auto-scroll sidebar panel into view when viewport settles (keyboard done animating).
      // Debounced 100ms — resize fires multiple times during animation, we want the final one.
      if (kbOpen && inputFocused) {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          const el = document.activeElement as HTMLElement | null;
          const panel = el?.closest?.('.sidebar-pinned-panel') as HTMLElement | null;
          if (panel?.closest('.mobile-sidebar-body')) {
            panel.scrollIntoView({ block: 'start', behavior: 'instant' });
          }
        }, 100);
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      inputFocused = tag === 'INPUT' || tag === 'TEXTAREA'
        || el.getAttribute('contenteditable') === 'true'
        || el.classList.contains('xterm-helper-textarea');
      // Toggle .input-focused instantly on focus (no viewport delay needed)
      document.documentElement.classList.toggle('input-focused', inputFocused);
      // Aggressively reset scroll — iOS visual viewport push
      if (inputFocused) {
        window.scrollTo(0, 0);
        document.body.scrollTop = 0;
        document.documentElement.scrollTop = 0;
      }
      update();
    };
    const onFocusOut = () => {
      inputFocused = false;
      hadKeyboardOpen = false;
      document.documentElement.classList.remove('input-focused');
      clearTimeout(scrollTimer);
      update();
    };
    update();
    vv.addEventListener('resize', update);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    // App-resume recovery: when the app returns from background (push-notification
    // tap, switcher, home-button), the OS dismisses the keyboard + blurs inputs at
    // the native layer, but the WebView doesn't always fire matching focusout /
    // visualViewport resize events. Without this handler, `inputFocused`/
    // `hadKeyboardOpen` stay truthy and the `.input-focused` / `.kb-open` classes
    // stick on <html>, hiding the sub-session bar (styles.css lines 983/989)
    // even though the keyboard is gone — which is exactly what users see after
    // tapping a notification ("底部的 sub-session 按钮没了").
    const onResume = () => {
      if (document.visibilityState !== 'visible') return;
      const active = document.activeElement as HTMLElement | null;
      const activeIsInput = !!active && (
        active.tagName === 'INPUT'
        || active.tagName === 'TEXTAREA'
        || active.getAttribute('contenteditable') === 'true'
        || active.classList.contains('xterm-helper-textarea')
      );
      // If the OS dismissed focus during background, blur the stale element so
      // update() reflects reality. If focus genuinely survived, keep it.
      if (!activeIsInput) {
        inputFocused = false;
        hadKeyboardOpen = false;
      }
      update();
    };
    document.addEventListener('visibilitychange', onResume);
    return () => {
      vv.removeEventListener('resize', update);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, []);

  // Native: initialize server URL and API key from Preferences storage
  useEffect(() => {
    if (!isNative()) return;
    // Set status bar to match app background
    import('@capacitor/status-bar').then(({ StatusBar, Style }) => {
      StatusBar.setStyle({ style: Style.Dark });
      StatusBar.setBackgroundColor({ color: '#0f172a' });
    }).catch(() => {});
    // Start OTA update manager (checks for web bundle updates)
    import('./update-manager.js').then(({ initUpdateManager }) => {
      initUpdateManager();
    }).catch(() => {});
    (async () => {
      try {
        const url = await getServerUrl();
        setNativeServerUrl(url);
        if (url) configureApi(url);

        const storedKey = url ? await getAuthKey() : null;
        if (storedKey) {
          configureApiKey(storedKey);
          try {
            const user = await apiFetch<{ id: string }>('/api/auth/user/me');
            const authState: AuthState = { userId: user.id, baseUrl: url! };
            localStorage.setItem('rcc_auth', JSON.stringify(authState));
            setAuth(authState);
          } catch (err) {
            console.warn('[native] /me failed:', err);
            clearApiKey();
            await clearAuthKey();
          }
        }
      } catch (e) {
        console.error('[native] init error:', e);
      } finally {
        setNativeReady(true);
        // Hide splash screen now that we've decided what to show
        import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide()).catch(() => {});
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dismiss splash after minimum display time (let animation play)
  // Skip splash entirely for native auth callback — needs to render immediately
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (!splash) { setSplashDone(true); return; }
    if (nativeCallback) { splash.remove(); setSplashDone(true); return; }
    const minMs = 1800; // let full animation play on all platforms
    const t = setTimeout(() => {
      splash.classList.add('splash-exit');
      setTimeout(() => { splash.remove(); setSplashDone(true); }, 500);
    }, minMs);
    return () => clearTimeout(t);
  }, []);

  // Native: init push notifications after login
  useEffect(() => {
    if (!auth || !isNative()) return;
    getAuthKey().then((key) => {
      if (key) initPushNotifications(key, auth.baseUrl).catch(console.warn);
    });
  }, [auth]);

  // Native: clear server-side push badge whenever the app becomes visible with
  // a valid auth context. AppDelegate also tries via JS bridge, but that can
  // fire before the web bundle is ready, leaving badge_count stale.
  useEffect(() => {
    if (!auth || !isNative()) return;
    void resetPushBadge();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void resetPushBadge();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [auth]);

  // When session expires mid-session (refresh failed), clear auth and show login.
  // Registered once so any apiFetch 401 after refresh failure lands here.
  useEffect(() => {
    onAuthExpired((reason?: string) => {
      void clearAuthState(reason ?? 'expired');
    });
  }, [clearAuthState]);


  // Verify session via /api/auth/user/me on mount (cookie-based auth)
  // Also handles post-OAuth redirect: cookie was set by server, we just need to confirm.
  useEffect(() => {
    if (isNative()) return; // native uses biometric auth flow above
    const baseUrl = window.location.origin;
    configureApi(baseUrl);
    console.warn('[auth] mount: verifying session via /api/auth/user/me');
    apiFetch<{ id: string }>('/api/auth/user/me').then((user) => {
      console.warn(`[auth] /me OK: userId=${user.id}`);
      const authState: AuthState = { userId: user.id, baseUrl };
      localStorage.setItem('rcc_auth', JSON.stringify(authState));
      setAuth((prev) => {
        if (prev && prev.userId === authState.userId && prev.baseUrl === authState.baseUrl) return prev;
        return authState;
      });
    }).catch((err) => {
      console.warn(`[auth] /me FAILED:`, err instanceof ApiError ? `${err.status}: ${err.body}` : err);
      if (err instanceof ApiError && err.status === 401) {
        void clearAuthState('mount_verify_401');
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Configure API client when auth changes; start/stop proactive refresh timer
  useEffect(() => {
    if (auth) {
      configureApi(auth.baseUrl);
      startProactiveRefresh();
    } else {
      stopProactiveRefresh();
    }
    return () => stopProactiveRefresh();
  }, [auth]);

  // Refresh session whenever the tab becomes visible again (mobile browsers pause
  // setInterval when the tab is backgrounded, so the proactive timer may miss).
  // Rate-limited to avoid excessive token rotation from frequent tab switches.
  useEffect(() => {
    if (!auth) return;
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshSessionIfStale(2 * 60 * 1000); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [auth]);

  useEffect(() => {
    if (!auth) return;
    const verifyAuthStillValid = async (reason: string) => {
      try {
        await fetchMe();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await clearAuthState(reason);
        }
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void verifyAuthStillValid('visibility_verify_401');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [auth, clearAuthState]);

  const handleRenameServer = useCallback(async (server: ServerInfo) => {
    const newName = prompt('Rename server:', server.name);
    if (!newName || newName.trim() === server.name) return;
    try {
      await apiFetch(`/api/server/${server.id}/name`, { method: 'PATCH', body: JSON.stringify({ name: newName.trim() }) });
      setServers((prev) => prev.map((s) => s.id === server.id ? { ...s, name: newName.trim() } : s));
      if (server.id === selectedServerId) {
        setSelectedServerName(newName.trim());
        localStorage.setItem('rcc_server_name', newName.trim());
      }
    } catch { /* ignore */ }
  }, [selectedServerId]);

  const handleUpgradeDaemon = useCallback(async (server: ServerInfo) => {
    try {
      await apiFetch(`/api/server/${server.id}/upgrade`, { method: 'POST' });
      alert(trans('server.upgrade_sent', { name: server.name }));
    } catch {
      alert(trans('server.upgrade_failed'));
    }
  }, [trans]);

  const handleUpgradeAll = useCallback(async () => {
    const results: string[] = [];
    for (const server of servers) {
      try {
        await apiFetch(`/api/server/${server.id}/upgrade`, { method: 'POST' });
        results.push(`✓ ${server.name}`);
      } catch {
        results.push(`✗ ${server.name}`);
      }
    }
    alert(results.join('\n'));
  }, [servers]);

  const handleDeleteServer = useCallback(async (server: ServerInfo) => {
    try {
      await apiFetch(`/api/server/${server.id}`, { method: 'DELETE' });
      setServers((prev) => prev.filter((s) => s.id !== server.id));
      if (server.id === selectedServerId) {
        setSelectedServerId(null);
        setSelectedServerName(null);
        localStorage.removeItem('rcc_server');
        localStorage.removeItem('rcc_server_name');
      }
    } catch { /* ignore */ }
    setDeleteTarget(null);
  }, [selectedServerId]);

  // Load servers list whenever auth is available
  const loadServers = useCallback(async () => {
    if (!auth) return;
    try {
      const data = await apiFetch<{ servers: ServerInfo[] }>('/api/server');
      setServers(data.servers);
      setServersSynced(true);
    } catch {
      // Preserve the last known list on refresh failures. The request is still
      // considered resolved so the UI can escape the initial connecting gate.
    } finally {
      setServersLoaded(true);
    }
  }, [auth]);

  useEffect(() => {
    setServersLoaded(false);
    setServersSynced(false);
    void loadServers();
  }, [loadServers]);

  useEffect(() => {
    if (!auth || !selectedServerId || !serversLoaded) return;
    const selectedServer = servers.find((server) => server.id === selectedServerId);
    if (!selectedServer || isServerOnline(selectedServer)) return;
    void fetchMe().catch(async (err) => {
      if (err instanceof ApiError && err.status === 401) {
        await clearAuthState('server_offline_verify_401');
      }
    });
  }, [auth, clearAuthState, selectedServerId, servers, serversLoaded]);

  // Periodically refresh server list so lastHeartbeatAt stays current
  useEffect(() => {
    if (!auth) return;
    const id = setInterval(() => { loadServers(); }, 30_000);
    return () => clearInterval(id);
  }, [auth, loadServers]);

  // Fetch sessions from DB immediately when auth + server are available
  useEffect(() => {
    if (!auth || !selectedServerId) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000); // 5s timeout — don't block UI on slow network
    apiFetch<{ sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; agent_version?: string; state: string; project_dir?: string; runtime_type?: 'process' | 'transport'; label?: string | null; description?: string | null }> }>(
      `/api/server/${selectedServerId}/sessions`,
      { signal: ctrl.signal },
    ).then((data) => {
      clearTimeout(timer);
      const mapped = data.sessions.map((s) => ({
        name: s.name,
        project: s.project_name,
        role: s.role as SessionInfo['role'],
        agentType: s.agent_type,
        agentVersion: s.agent_version,
        // Start as 'unknown' — DB state may be stale (idle not persisted back to DB).
        // Daemon will send live state via WebSocket shortly after connecting.
        state: 'unknown' as SessionInfo['state'],
        projectDir: s.project_dir,
        runtimeType: s.runtime_type,
        label: s.label ?? null,
        description: s.description ?? null,
        qwenModel: undefined,
        qwenAuthType: undefined,
        qwenAuthLimit: undefined,
        qwenAvailableModels: undefined,
        modelDisplay: undefined,
        planLabel: undefined,
        quotaLabel: undefined,
        quotaUsageLabel: undefined,
        quotaMeta: undefined,
      }));
      setSessions((prev) => mapped.map((s) => {
        const existing = prev.find((p) => p.name === s.name);
        return mergeSessionListEntry(s as IncomingSessionListEntry, existing);
      }));
      // Only mark loaded if we got data — empty means daemon hasn't synced yet,
      // so wait for WS session_list to avoid flashing "No active sessions"
      if (mapped.length > 0) {
        setSessionsLoaded(true);
      }
      // Auto-select first session if none was previously saved
      if (mapped.length > 0 && !localStorage.getItem('rcc_session')) {
        setActiveSession(mapped[0].name);
      }
    }).catch(() => { clearTimeout(timer); /* WS fallback */ });
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [auth, selectedServerId]);

  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [activeSession, setActiveSessionState] = useState<string | null>(
    () => resolveInitialSessionName(),
  );

  // Sync URL hash with current server + session so each tab has its own URL
  useEffect(() => {
    writeHashState(selectedServerId, activeSession);
  }, [selectedServerId, activeSession]);

  const [showNewSession, setShowNewSession] = useState(false);
  const [renameRequest, setRenameRequest] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [daemonOnline, setDaemonOnline] = useState(false);
  const sessionListRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Debounce the "Daemon Offline" badge. The server broadcasts
  // DAEMON_MSG.DISCONNECTED the instant the daemon WS closes, then waits
  // RECONNECT_GRACE_MS before actually declaring the daemon offline (inflight
  // commands are replayed silently if the daemon returns in time). Without
  // this matching delay on the client, a 200 ms pod restart or network blip
  // flashes "Daemon Offline" even though the daemon is back before the grace
  // window expires and the user's turn never fails.
  const daemonOfflineGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [idleAlerts, setIdleAlerts] = useState<Set<string>>(new Set());
  const [idleFlashTokens, setIdleFlashTokens] = useState<Map<string, number>>(() => new Map());
  const [toasts, setToasts] = useState<Array<{ id: number; sessionName: string; project: string; kind: 'idle' | 'notification'; title?: string; message?: string; openRepoLatest?: boolean; failedJobName?: string; failedStepName?: string }>>([]);
  const [detectedModels, setDetectedModels] = useState<Map<string, string>>(new Map());
  const [subUsages, setSubUsages] = useState<Map<string, { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string }>>(new Map());
  const quickData = useQuickData();
  const lastImcodesActivityRef = useRef(Date.now());
  const resubscribeTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Rename = update main-session label in D1 + local sessions state
  const handleRenameSession = useCallback(async (sessionName: string, nextLabel: string | null) => {
    if (!selectedServerId) return;
    const previousLabel = sessions.find((s) => s.name === sessionName)?.label ?? null;
    setSessions((prev) => prev.map((s) => (
      s.name === sessionName ? { ...s, label: nextLabel } : s
    )));
    try {
      await updateMainSessionLabel(selectedServerId, sessionName, nextLabel);
    } catch {
      setSessions((prev) => prev.map((s) => (
        s.name === sessionName ? { ...s, label: previousLabel } : s
      )));
    }
  }, [selectedServerId, sessions]);

  // IDs of currently-open (non-minimized) sub-session windows.
  // Persisted per main session in localStorage so open state survives
  // session switches and page reloads.
  const [openSubIds, setOpenSubIdsRaw] = useState<Set<string>>(() => {
    try {
      const initial = localStorage.getItem('rcc_session');
      if (initial) {
        const raw = localStorage.getItem(`rcc_open_subs_${initial}`);
        if (raw) return new Set(JSON.parse(raw) as string[]);
      }
    } catch { /* ignore */ }
    return new Set();
  });
  const setOpenSubIds = useCallback((updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setOpenSubIdsRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      // Persist open sub IDs for the current main session
      const mainSession = localStorage.getItem('rcc_session');
      if (mainSession) {
        const ids = Array.from(next);
        if (ids.length > 0) localStorage.setItem(`rcc_open_subs_${mainSession}`, JSON.stringify(ids));
        else localStorage.removeItem(`rcc_open_subs_${mainSession}`);
      }
      return next;
    });
  }, []);

  // Panels pinned to the sidebar — synced to server, write-through cache
  const [pinnedPanels, setPinnedPanels] = useSyncedPreference<PinnedPanel[]>('sidebar_pinned_panels', [], 0);
  const [newUserGuidePref, setNewUserGuidePref] = useSyncedPreference<NewUserGuidePref>('new_user_guide', DEFAULT_NEW_USER_GUIDE_PREF, 0);
  const [showNewUserGuidePrompt, setShowNewUserGuidePrompt] = useState(false);
  const [showNewUserGuide, setShowNewUserGuide] = useState(false);
  const [guidePromptSnoozed, setGuidePromptSnoozed] = useState(false);
  const sawLoadedEmptySessionsRef = useRef(false);

  // Per-panel heights (device-local, not synced)
  const [pinnedPanelHeights, setPinnedPanelHeights] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem('sidebar_pinned_panel_heights');
      if (raw) return JSON.parse(raw) as Record<string, number>;
    } catch { /* ignore */ }
    return {};
  });

  // ── Desktop floating window stack ────────────────────────────────────────────
  // Single shared ordering authority for all desktop, non-modal floating
  // workspace windows (sub-sessions, file preview, file browser, repo, cron,
  // discussions, shared-context, local web preview, delegated child windows).
  //
  // Held as a MUTABLE instance in a stable ref. React re-renders are driven by
  // the version counter — components subscribe to `stackVersion`, NEVER to the
  // stack object itself. See `web/src/window-stack.ts` and the openspec
  // change `unify-floating-window-stack` (especially the "React State
  // Integration (Normative)" section in `design.md`) for rules; the previous
  // attempt (commit 31f2a56e, reverted) cloned the stack on every mutation
  // and triggered a render/fetch storm on every pointer interaction.
  const stackRef = useRef<MutableDesktopWindowStack | null>(null);
  if (stackRef.current === null) stackRef.current = new MutableDesktopWindowStack();
  const [stackVersion, setStackVersion] = useState(0);
  const bumpStack = useCallback(() => setStackVersion((n) => n + 1), []);
  const isMobileRef = useRef(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent));

  /** Idempotent register; raises if `bringToFront` is requested. Bumps version only on real change. */
  const ensureDesktopWindow = useCallback((id: string, meta: DesktopWindowMeta, opts?: { bringToFront?: boolean }) => {
    if (isMobileRef.current) return;
    const stack = stackRef.current!;
    let changed = stack.ensureWindow(id, meta);
    if (opts?.bringToFront) {
      if (stack.bringToFront(id)) changed = true;
    }
    if (changed) bumpStack();
  }, []);

  /** Raise an existing window. No-op (no version bump) if it is already frontmost. */
  const bringDesktopWindowToFront = useCallback((id: string) => {
    if (isMobileRef.current) return;
    if (stackRef.current!.bringToFront(id)) bumpStack();
  }, []);

  /** Remove a window (and its children). Bumps only if anything was actually removed. */
  const removeDesktopWindow = useCallback((id: string) => {
    if (stackRef.current!.removeWindow(id)) bumpStack();
  }, []);

  /**
   * Read effective z-index. Cheap and called during render. Consumers must
   * re-render when `stackVersion` bumps — that's how the value updates.
   */
  const getDesktopWindowZIndex = useCallback((id: string, fallback: number): number => {
    const z = stackRef.current!.getZIndex(id);
    return z ?? fallback;
  }, []);

  const [showSubDialog, setShowSubDialog] = useState(false);
  const [settingsTarget, setSettingsTarget] = useState<{ sessionName: string; subId?: string; label: string; description: string; cwd: string; type: string; parentSession?: string | null; transportConfig?: Record<string, unknown> | null } | null>(null);

  // Derive focused (topmost) sub-session from the shared stack + open set.
  // Dep list intentionally lists `stackVersion` (number) and `openSubIdsKey`
  // (stable string) — never the stack object or the Set instance — so this
  // memo only invalidates on real ordering / membership changes.
  const openSubIdsKeyMemo = useMemo(() => openSubIdsKey(openSubIds), [openSubIds]);
  const focusedSubId = useMemo(
    () => (isMobileRef.current ? null : getFrontmostSubSessionId(stackRef.current!, openSubIds)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentionally [stackVersion, key] to avoid invalidating on every Set re-creation
    [stackVersion, openSubIdsKeyMemo],
  );
  const flashIdleSession = useCallback((sessionName: string) => {
    setIdleFlashTokens((prev) => {
      const next = new Map(prev);
      next.set(sessionName, (next.get(sessionName) ?? 0) + 1);
      return next;
    });
  }, []);
  const focusedSubIdRef = useRef(focusedSubId);
  focusedSubIdRef.current = focusedSubId;

  useEffect(() => {
    if (sessionsLoaded && sessions.length === 0) {
      sawLoadedEmptySessionsRef.current = true;
    }
  }, [sessionsLoaded, sessions.length]);

  useEffect(() => {
    if (!shouldMarkNewUserGuidePending(newUserGuidePref, sessionsLoaded, sessions.length, sawLoadedEmptySessionsRef.current)) return;
    setNewUserGuidePref((prev) => ({ ...prev, pending: true }));
    setGuidePromptSnoozed(false);
    setShowNewUserGuidePrompt(true);
  }, [newUserGuidePref, sessionsLoaded, sessions.length, setNewUserGuidePref]);

  useEffect(() => {
    if (shouldShowNewUserGuidePrompt(newUserGuidePref, sessionsLoaded, sessions.length) && !guidePromptSnoozed && !showNewUserGuide) {
      setShowNewUserGuidePrompt(true);
      return;
    }
    if (!newUserGuidePref.pending || newUserGuidePref.completed || newUserGuidePref.disabled) {
      setShowNewUserGuidePrompt(false);
      setShowNewUserGuide(false);
    }
  }, [guidePromptSnoozed, newUserGuidePref, sessionsLoaded, sessions.length, showNewUserGuide]);

  useEffect(() => {
    const markActive = () => { lastImcodesActivityRef.current = Date.now(); };
    const onVisible = () => {
      if (document.visibilityState === 'visible') markActive();
    };
    document.addEventListener('pointerdown', markActive, true);
    document.addEventListener('keydown', markActive, true);
    document.addEventListener('focusin', markActive, true);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('pointerdown', markActive, true);
      document.removeEventListener('keydown', markActive, true);
      document.removeEventListener('focusin', markActive, true);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // ── Repo ────────────────────────────────────────────────────────────────────
  const [showRepoPage, setShowRepoPage] = useState(false);
  const [repoFocusLatestAction, setRepoFocusLatestAction] = useState<{ token: number; failedJobName?: string; failedStepName?: string } | null>(null);
  const [pendingRepoToastSession, setPendingRepoToastSession] = useState<{ sessionName: string; focus: { token: number; failedJobName?: string; failedStepName?: string } } | null>(null);
  /** Floating file preview request opened from pinned file browser. */
  const [previewFileRequest, setPreviewFileRequest] = useState<FileBrowserPreviewRequest | null>(null);
  const [previewFileCache, setPreviewFileCache] = useState<Record<string, { preferDiff?: boolean; preview: FileBrowserPreviewState }>>({});
  const [repoContexts, setRepoContexts] = useState<Map<string, any>>(new Map());
  const repoContextsRef = useRef(repoContexts);
  repoContextsRef.current = repoContexts;

  // ── Settings / Admin ────────────────────────────────────────────────────────
  const [showSettingsPage, setShowSettingsPage] = useState(false);
  const [showCronManager, setShowCronManager] = useState(false);
  const [showAdminPage, setShowAdminPage] = useState(false);
  const [showSharedContextManagement, setShowSharedContextManagement] = useState(false);
  const [showSharedContextDiagnostics, setShowSharedContextDiagnostics] = useState(false);
  const [sharedContextManagementProps, setSharedContextManagementProps] = useState<Record<string, unknown>>({});
  const [sharedContextDiagnosticsProps, setSharedContextDiagnosticsProps] = useState<SharedContextDiagnosticsWindowState>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [userDisplayName, setUserDisplayName] = useState<string | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [userHasPassword, setUserHasPassword] = useState(false);

  // Fetch current user info on auth
  useEffect(() => {
    if (!auth) {
      setIsAdmin(false);
      setUserDisplayName(null);
      setUsername(null);
      setUserHasPassword(false);
      return;
    }
    fetchMe().then((me) => {
      setIsAdmin(me.is_admin);
      setUserDisplayName(me.display_name);
      setUsername(me.username);
      setUserHasPassword(me.has_password);
    }).catch(() => {});
  }, [auth]);

  // ── Discussions ─────────────────────────────────────────────────────────────
  const [showDiscussionsPage, setShowDiscussionsPage] = useState(false);
  const [discussionInitialId, setDiscussionInitialId] = useState<string | null>(null);
  // Swipe back for discussions is handled by FloatingPanel on mobile
  const [showDiscussionDialog, setShowDiscussionDialog] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [discussionPrefs, _setDiscussionPrefs] = useState<DiscussionPrefs | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [discussions, setDiscussions] = useState<Array<{
    id: string;
    topic: string;
    state: string;
    modeKey?: string;
    currentRound: number;
    maxRounds: number;
    completedHops: number;
    completedRoundHops?: number;
    totalHops: number;
    activeHop?: number | null;
    activeRoundHop?: number | null;
    activePhase?: 'queued' | 'initial' | 'hop' | 'summary';
    initiatorLabel?: string;
    currentSpeaker?: string;
    conclusion?: string;
    filePath?: string;
    nodes?: Array<{
      label: string;
      displayLabel?: string;
      agentType: string;
      ccPreset?: string | null;
      mode?: string;
      phase?: 'initial' | 'hop' | 'summary';
      status: 'done' | 'active' | 'pending' | 'skipped';
    }>;
    hopStates?: Array<{
      hopIndex: number;
      roundIndex: number;
      session?: string;
      mode?: string;
      status: 'queued' | 'dispatched' | 'running' | 'completed' | 'timed_out' | 'failed' | 'cancelled';
    }>;
    /** Discussion file ID for navigation (P2P runs use discussion_id, not run id) */
    fileId?: string;
    /** Epoch ms when the P2P run was created (for elapsed timer) */
    startedAt?: number;
    /** Epoch ms when the current hop/phase started (for hop-level elapsed timer) */
    hopStartedAt?: number;
  }>>([]);

  /** Set of session names enabled in the P2P config for the active root session. */
  const [p2pSessionNames, setP2pSessionNames] = useState<Set<string>>(new Set());
  // Alias for components that receive this prop
  const p2pSessionLabels = p2pSessionNames;

  // Forward-declared ref populated below at the canonical assignment site
  // (line ~1290) once `useSubSessions(...)` runs. Reading
  // `subSessionsRef.current` BEFORE that point would yield an empty list, but
  // `bringSubToFront` is only invoked from event handlers / effects, not
  // during the initial synchronous render path.
  const subSessionsRef = useRef<readonly SubSession[]>([]);

  /**
   * Sub-session bring-to-front. Wraps the shared stack so the rest of the
   * codebase keeps the same affordance during migration. Ensures the window
   * is registered first (idempotent), then raises it. The stack itself
   * short-circuits no-ops, so calling this on the already-frontmost
   * sub-session does NOT bump the version — that is the load-bearing
   * render-stability guarantee.
   */
  const bringSubToFront = useCallback((id: string) => {
    if (isMobileRef.current) return;
    const sub = subSessionsRef.current.find((candidate) => candidate.id === id);
    ensureDesktopWindow(DESKTOP_WINDOW_IDS.subSession(id), {
      kind: DESKTOP_WINDOW_KINDS.subSession,
      subId: id,
      serverId: sub?.serverId ?? selectedServerIdRef.current ?? undefined,
    }, { bringToFront: true });
  }, [ensureDesktopWindow]);

  const toggleSubSession = useCallback((id: string) => {
    const mobile = isMobileRef.current;
    let willOpen = false;
    setOpenSubIds((prev) => {
      if (mobile) {
        // Exclusive on mobile: close if already open, otherwise open only this one
        if (prev.has(id)) return new Set();
        willOpen = true;
        return new Set([id]);
      }
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        willOpen = false;
      } else {
        next.add(id);
        willOpen = true;
      }
      return next;
    });
    if (willOpen) {
      bringSubToFront(id);
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.subSession(id));
    }
  }, [bringSubToFront, removeDesktopWindow]);

  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // ── Desktop window stack ↔ visibility-boolean sync ──────────────────────────
  // For each managed singleton floating window, mirror its show-boolean into
  // the stack. Opening = ensure + bring-to-front. Closing = remove. The
  // stack's own short-circuit logic ensures no version bump when nothing
  // changed (e.g. re-running the effect when an unrelated dep changes).
  //
  // Mobile is a no-op (the helpers themselves bail out on isMobileRef).
  useEffect(() => {
    if (showRepoPage) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.repo, {
        kind: DESKTOP_WINDOW_KINDS.repo,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.repo);
    }
  }, [showRepoPage, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (showCronManager) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.cronManager, {
        kind: DESKTOP_WINDOW_KINDS.cronManager,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.cronManager);
    }
  }, [showCronManager, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (showDiscussionsPage) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.discussions, {
        kind: DESKTOP_WINDOW_KINDS.discussions,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.discussions);
    }
  }, [showDiscussionsPage, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (showDesktopFileBrowser) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.fileBrowser, {
        kind: DESKTOP_WINDOW_KINDS.fileBrowser,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.fileBrowser);
    }
  }, [showDesktopFileBrowser, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (!selectedServerId) return;
    const id = DESKTOP_WINDOW_IDS.localWebPreview(selectedServerId);
    if (showDesktopLocalWebPreview) {
      ensureDesktopWindow(id, {
        kind: DESKTOP_WINDOW_KINDS.localWebPreview,
        serverId: selectedServerId,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(id);
    }
  }, [showDesktopLocalWebPreview, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (showSharedContextManagement) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.sharedContextManagement, {
        kind: DESKTOP_WINDOW_KINDS.sharedContextManagement,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.sharedContextManagement);
    }
  }, [showSharedContextManagement, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (showSharedContextDiagnostics) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.sharedContextDiagnostics, {
        kind: DESKTOP_WINDOW_KINDS.sharedContextDiagnostics,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.sharedContextDiagnostics);
    }
  }, [showSharedContextDiagnostics, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  useEffect(() => {
    if (previewFileRequest) {
      ensureDesktopWindow(DESKTOP_WINDOW_IDS.filePreview, {
        kind: DESKTOP_WINDOW_KINDS.filePreview,
        serverId: selectedServerId ?? undefined,
      }, { bringToFront: true });
    } else {
      removeDesktopWindow(DESKTOP_WINDOW_IDS.filePreview);
    }
  }, [previewFileRequest, selectedServerId, ensureDesktopWindow, removeDesktopWindow]);

  // Sub-session stack cleanup: remove a sub-session's stack entry whenever it
  // leaves `openSubIds` (close, minimize, pin, server switch, etc.). This is
  // the single authoritative place that GCs sub-session stack memberships;
  // user-action open paths (toggleSubSession, bringSubToFront) handle
  // ensure+bring on the way in.
  const openSubIdsKeyForEffect = openSubIdsKeyMemo;
  useEffect(() => {
    if (isMobileRef.current) return;
    const currentlyOpen = new Set(openSubIdsRef.current);
    const stack = stackRef.current!;
    let changed = false;
    for (const entry of stack.getOrderForTests()) {
      if (entry.meta.kind !== DESKTOP_WINDOW_KINDS.subSession) continue;
      if (entry.meta.subId && !currentlyOpen.has(entry.meta.subId)) {
        if (stack.removeWindow(entry.id)) changed = true;
      }
    }
    if (changed) bumpStack();
  }, [openSubIdsKeyForEffect]);

  const setActiveSession = useCallback((name: string | null, opts?: { keepSubWindows?: boolean }) => {
    if (name) localStorage.setItem('rcc_session', name);
    else localStorage.removeItem('rcc_session');
    setActiveSessionState(name);
    if (!opts?.keepSubWindows) {
      // Restore saved open sub-sessions for the target main session
      if (name) {
        try {
          const raw = localStorage.getItem(`rcc_open_subs_${name}`);
          if (raw) { setOpenSubIds(new Set(JSON.parse(raw) as string[])); }
          else { setOpenSubIds(new Set()); }
        } catch { setOpenSubIds(new Set()); }
      } else {
        setOpenSubIds(new Set());
      }
    }
    // scroll chat to bottom on session switch (rAF gives ChatView time to mount)
    if (name) requestAnimationFrame(() => chatScrollFnsRef.current.get(name)?.());
  }, [setOpenSubIds]);

  useEffect(() => {
    if (!auth || selectedServerId || !serversLoaded || servers.length === 0 || manualDashboard) return;
    const runId = ++autoEntryRunRef.current;
    let cancelled = false;
    setAutoEnteringRecent(true);

    const choose = async () => {
      const savedServerId = localStorage.getItem('rcc_server');
      const rows: WatchSessionRow[] = [];
      await Promise.allSettled(servers.map(async (server) => {
        const result = await apiFetch<{ sessions: WatchSessionRow[] }>(
          `/api/watch/sessions?serverId=${encodeURIComponent(server.id)}`,
        );
        if (!Array.isArray(result.sessions)) return;
        for (const row of result.sessions) {
          if (!row || typeof row.sessionName !== 'string') continue;
          rows.push({
            serverId: typeof row.serverId === 'string' ? row.serverId : server.id,
            sessionName: row.sessionName,
            previewUpdatedAt: typeof row.previewUpdatedAt === 'number' ? row.previewUpdatedAt : undefined,
            isSubSession: row.isSubSession === true,
          });
        }
      }));
      if (cancelled || runId !== autoEntryRunRef.current || selectedServerIdRef.current) return;

      const recent = pickMostRecentMainSession(rows.filter((row) => typeof row.previewUpdatedAt === 'number'));
      const fallback = pickAutoEntryServer(servers, savedServerId);
      const savedFallbackSession = fallback ? localStorage.getItem(`rcc_session_${fallback.serverId}`) : null;
      const firstMain = pickMostRecentMainSession(rows);
      const selection = recent
        ?? (fallback && savedFallbackSession ? { ...fallback, sessionName: savedFallbackSession } : null)
        ?? firstMain
        ?? fallback;
      if (!selection) return;

      const server = servers.find((item) => item.id === selection.serverId);
      localStorage.setItem('rcc_server', selection.serverId);
      if (server?.name) localStorage.setItem('rcc_server_name', server.name);
      else localStorage.removeItem('rcc_server_name');
      setSelectedServerId(selection.serverId);
      setSelectedServerName(server?.name ?? null);
      if (selection.sessionName) {
        localStorage.setItem(`rcc_session_${selection.serverId}`, selection.sessionName);
        setActiveSession(selection.sessionName);
      } else {
        const savedSession = localStorage.getItem(`rcc_session_${selection.serverId}`);
        setActiveSession(savedSession);
      }
      writeHashState(selection.serverId, selection.sessionName ?? localStorage.getItem(`rcc_session_${selection.serverId}`));
    };

    void choose().finally(() => {
      if (!cancelled && runId === autoEntryRunRef.current) setAutoEnteringRecent(false);
    });
    return () => {
      cancelled = true;
    };
  }, [auth, manualDashboard, selectedServerId, servers, serversLoaded, setActiveSession]);

  const wsRef = useRef<WsClient | null>(null);
  const [daemonStats, setDaemonStats] = useState<{ daemonVersion?: string | null; cpu: number; memUsed: number; memTotal: number; load1: number; load5: number; load15: number; uptime: number } | null>(null);

  useEffect(() => {
    if (!auth || !selectedServerId) return;
    let cancelled = false;
    void listP2pRuns(selectedServerId)
      .then((runs) => {
        if (cancelled) return;
        const mapped = runs
          .map((run) => mapP2pRunToDiscussion(run as Record<string, any>))
          .filter((d) => d.state === 'running' || d.state === 'setup');
        setDiscussions((prev) => {
          const nonP2p = prev.filter((d) => !d.id.startsWith('p2p_'));
          return [...nonP2p, ...mapped];
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [auth, selectedServerId]);

  // ── Sub-sessions ───────────────────────────────────────────────────────────
  const { subSessions, visibleSubSessions, loadedServerId, create: createSubSession, close: closeSubSession, restart: restartSubSession, rename: renameSubSession, updateLocal: updateSubLocal } = useSubSessions(
    (nativeReady && auth) ? selectedServerId : null,
    wsRef.current,
    connected,
    activeSession,
  );

  const defaultShellPref = usePref<string>(PREF_KEY_DEFAULT_SHELL, { parse: parseString });
  const subSessionParentSignature = useMemo(
    () => p2pSubSessionParentSignature(subSessions),
    [subSessions],
  );
  const activeRootSession = useMemo(() => {
    return resolveP2pRootSession(activeSession, subSessions);
  // Depend on the session→parent projection, not the full subSessions array
  // reference, so unrelated sub-session metadata churn does not change the
  // preference subscription key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession, subSessionParentSignature]);
  const p2pConfigPref = usePref(
    activeRootSession ? p2pSessionConfigPrefKey(activeRootSession) : null,
    {
      legacyKey: PREF_KEY_P2P_SESSION_CONFIG_LEGACY,
      parse: parseP2pSavedConfig,
      serialize: serializeP2pSavedConfig,
    },
  );

  // ── Unread counts (sidebar session tree badges) ────────────────────────────
  const sessionNames = useMemo(() => sessions.map((s) => s.name), [sessions]);
  const unreadCounts = useUnreadCounts(sessionNames, activeSession, wsRef.current, selectedServerId);

  // Auto-create a shell sub-session when switching to a session with none.
  // Only update the ref after we've acted (created or confirmed existing) —
  // otherwise a race between activeSession changing and loadedServerId syncing
  // causes the ref to advance before conditions are met, skipping auto-creation.
  const prevActiveSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveSessionRef.current;
    if (!activeSession || activeSession === prev) return;
    if (!connected || loadedServerId !== selectedServerId) return;
    if (!defaultShellPref.loaded) return;
    // Conditions met — mark this session as handled
    prevActiveSessionRef.current = activeSession;
    if (visibleSubSessions.length > 0) return;
    const shell = defaultShellPref.value || '/bin/bash';
    void createSubSession('shell', shell);
  }, [activeSession, connected, loadedServerId, selectedServerId, visibleSubSessions.length, createSubSession, defaultShellPref.loaded, defaultShellPref.value]);

  // Load P2P config — determine which sessions are enabled for P2P tagging
  useEffect(() => {
    if (!activeRootSession || !p2pConfigPref.value?.sessions) { setP2pSessionNames(new Set()); return; }
    const names = new Set<string>();
    for (const [name, entry] of Object.entries(p2pConfigPref.value.sessions)) {
      if (entry.enabled && entry.mode !== 'skip') names.add(name);
    }
    setP2pSessionNames(names);
  }, [activeRootSession, p2pConfigPref.value]);

  const diffApplyersRef = useRef<Map<string, (diff: TerminalDiff) => void>>(new Map());
  const historyApplyersRef = useRef<Map<string, (content: string) => void>>(new Map());
  // Per-session input refs (chat input element in SessionPane) — used by global keyboard handler
  const inputRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const termFocusFnsRef = useRef<Map<string, () => void>>(new Map());
  const termFitFnsRef = useRef<Map<string, () => void>>(new Map());
  const termScrollFnsRef = useRef<Map<string, () => void>>(new Map());
  // Per-session chat scroll functions — registered by SessionPane
  const chatScrollFnsRef = useRef<Map<string, () => void>>(new Map());
  const openSubIdsRef = useRef(openSubIds);
  openSubIdsRef.current = openSubIds;
  // subSessionsRef itself is declared earlier (forward-declared before
  // bringSubToFront so the callback can close over it). Just sync each render.
  subSessionsRef.current = subSessions;

  useEffect(() => {
    const liveSessionNames = new Set<string>([
      ...sessions.map((session) => session.name),
      ...subSessions.map((sub) => sub.sessionName),
    ]);
    setIdleFlashTokens((prev) => {
      let changed = false;
      const next = new Map<string, number>();
      for (const [sessionName, token] of prev) {
        if (liveSessionNames.has(sessionName)) {
          next.set(sessionName, token);
          continue;
        }
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions, subSessions]);

  // When sub-sessions load from API (after session_list already fired), sync them to Watch projection
  useEffect(() => {
    if (subSessions.length === 0 || !selectedServerId) return;
    for (const sub of subSessions) {
      watchProjectionStore.addSubSession({
        sessionName: sub.sessionName,
        sessionType: sub.type ?? '',
        state: sub.state,
        label: sub.label,
        parentSession: sub.parentSession,
      }, selectedServerId);
    }
  }, [subSessions, selectedServerId]);

  const savePinnedPanelHeight = useCallback((panelKey: string, height: number) => {
    setPinnedPanelHeights((prev) => {
      const next = { ...prev, [panelKey]: height };
      try { localStorage.setItem('sidebar_pinned_panel_heights', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  /** Generic pin: close the source floating window + add to sidebar pinnedPanels. */
  const pinPanel = useCallback((type: string, props: Record<string, unknown>, closeSource?: () => void) => {
    const id = type === LOCAL_WEB_PREVIEW_PANEL_TYPE
      ? `${type}:${props.serverId ?? selectedServerId ?? ''}:${props.port ?? ''}:${String(props.path ?? '/')}`
      : type === SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE || type === SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE
        ? `${type}:${props.serverId ?? selectedServerId ?? ''}`
      : `${type}:${props.sessionName ?? Date.now()}`;
    closeSource?.();
    setPinnedPanels((prev) => {
      if (prev.some((p) => p.id === id)) return prev;
      return [...prev, { id, type, props }];
    });
  }, [selectedServerId, setPinnedPanels]);

  const updatePinnedPanelProps = useCallback((panelId: string, props: Record<string, unknown>) => {
    setPinnedPanels((prev) => prev.map((panel) => (
      panel.id === panelId ? { ...panel, props } : panel
    )));
  }, [setPinnedPanels]);

  const handlePreviewFileRequest = useCallback((request: FileBrowserPreviewRequest) => {
    const cached = previewFileCache[request.path];
    setPreviewFileRequest({
      ...request,
      preview: request.preview ?? cached?.preview,
      preferDiff: request.preferDiff ?? cached?.preferDiff,
    });
  }, [previewFileCache]);

  const handlePreviewStateChange = useCallback((update: FileBrowserPreviewUpdate) => {
    setPreviewFileCache((prev) => {
      const existing = prev[update.path];
      if (existing?.preview === update.preview && existing.preferDiff === update.preferDiff) return prev;
      return {
        ...prev,
        [update.path]: {
          preferDiff: update.preferDiff,
          preview: update.preview,
        },
      };
    });
    setPreviewFileRequest((prev) => {
      if (!prev) return prev;
      if (prev.path === update.path) {
        return {
          ...prev,
          preferDiff: prev.preferDiff ?? update.preferDiff,
          preview: update.preview,
        };
      }
      return {
        ...prev,
        path: update.path,
        preferDiff: update.preferDiff,
        preview: update.preview,
      };
    });
  }, []);

  /** Generic unpin: remove from pinnedPanels + reopen the source floating window. */
  const unpinPanel = useCallback((panel: PinnedPanel) => {
    setPinnedPanels((prev) => prev.filter((p) => p.id !== panel.id));
    // Reopen source window based on type
    if (panel.type === 'filebrowser' || panel.type === 'repo') {
      setShowDesktopFileBrowser(true);
    } else if (panel.type === 'repopage') {
      setShowRepoPage(true);
    } else if (panel.type === 'cronmanager') {
      setShowCronManager(true);
    } else if (panel.type === SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE) {
      setSharedContextManagementProps(panel.props);
      setShowSharedContextManagement(true);
    } else if (panel.type === SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE) {
      setSharedContextDiagnosticsProps({
        enterpriseId: typeof panel.props?.enterpriseId === 'string' ? panel.props.enterpriseId : undefined,
        canonicalRepoId: typeof panel.props?.canonicalRepoId === 'string' ? panel.props.canonicalRepoId : undefined,
        workspaceId: typeof panel.props?.workspaceId === 'string' ? panel.props.workspaceId : undefined,
        enrollmentId: typeof panel.props?.enrollmentId === 'string' ? panel.props.enrollmentId : undefined,
        language: typeof panel.props?.language === 'string' ? panel.props.language : undefined,
        filePath: typeof panel.props?.filePath === 'string' ? panel.props.filePath : undefined,
      });
      setShowSharedContextDiagnostics(true);
    } else if (panel.type === LOCAL_WEB_PREVIEW_PANEL_TYPE) {
      setLocalWebPreviewPort(String(panel.props?.port ?? ''));
      setLocalWebPreviewPath(String(panel.props?.path ?? '/'));
      setShowDesktopLocalWebPreview(true);
    } else if (panel.type === 'subsession') {
      const sub = subSessions.find((s) => s.sessionName === (panel.props?.sessionName as string));
      if (sub) {
        setOpenSubIds((prev) => new Set([...prev, sub.id]));
        bringSubToFront(sub.id);
      }
    }
  }, [setPinnedPanels, subSessions, bringSubToFront]);

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const defaultViewMode: ViewMode = isMobile ? 'chat' : 'terminal';
  // Per-session view mode: Record<sessionName, ViewMode>
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>(() => {
    try {
      const stored = localStorage.getItem('rcc_viewModes');
      if (stored) return JSON.parse(stored) as Record<string, ViewMode>;
    } catch { /* ignore */ }
    return {};
  });
  // Transport sessions have no terminal backend — force chat mode, no toggle
  const activeRuntimeType = activeSession
    ? (() => {
        const session = sessions.find((s) => s.name === activeSession);
        return session ? resolveSessionInfoRuntimeType(session) : undefined;
      })()
    : undefined;
  const isTransportSession = activeRuntimeType === 'transport';
  const effectiveDefault: ViewMode = isTransportSession ? 'chat' : defaultViewMode;
  const viewMode: ViewMode = isTransportSession ? 'chat' : ((activeSession && viewModes[activeSession]) ? viewModes[activeSession] : effectiveDefault);
  const toggleViewMode = useCallback(() => {
    if (!activeSession) return;
    setViewModes((prev) => {
      const current = prev[activeSession] ?? defaultViewMode;
      const next: ViewMode = current === 'terminal' ? 'chat' : 'terminal';
      const updated = { ...prev, [activeSession]: next };
      localStorage.setItem('rcc_viewModes', JSON.stringify(updated));
      if (next === 'chat') {
        requestAnimationFrame(() => {
          chatScrollFnsRef.current.get(activeSession)?.();
          // Steal focus from xterm textarea so it stops capturing keystrokes in chat mode.
          // Only on desktop — on mobile we don't want to pop up the keyboard automatically.
          if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
            inputRefsMap.current.get(activeSession)?.focus();
          }
        });
      }
      return updated;
    });
  }, [activeSession, defaultViewMode]);

  const focusTerminal = useCallback(() => {
    if (!activeSession) return;
    termFitFnsRef.current.get(activeSession)?.();
    if (!isMobile) termFocusFnsRef.current.get(activeSession)?.();
  }, [activeSession, isMobile]);

  // Provider status (hoisted to app level so it's always listening — dialogs mount later)
  const { isProviderConnected, getRemoteSessions, refreshSessions } = useProviderStatus(wsRef.current);

  // Set up WebSocket only when a server is selected
  useEffect(() => {
    if (!auth || !selectedServerId) return;

    const ws = new WsClient(auth.baseUrl, selectedServerId);
    wsRef.current = ws;

    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'session.event') {
        if (msg.session) {
          watchProjectionStore.updateSessionState(msg.session, msg.state);
        }
        if (msg.event === 'connected') {
          setConnected(true);
          setConnecting(false);
          ws.requestSessionList();
          ws.discussionList();
          ws.p2pStatus();
          requestActiveTimelineRefresh({ resetCooldowns: true });
          // Timeout: if session_list never arrives, stop blocking the UI
          if (sessionListRetryRef.current) clearTimeout(sessionListRetryRef.current);
          sessionListRetryRef.current = setTimeout(() => {
            setSessionsLoaded((prev) => {
              if (!prev) {
                // session_list never arrived — unblock the UI with empty state
                return true;
              }
              return prev;
            });
          }, 5000);
        }
        if (msg.event === 'disconnected') {
          setConnected(false); setConnecting(true); setDaemonOnline(false);
          // Cancel any pending debounce — the browser-server WS dropped so
          // the grace-window flip would be redundant (badge now shows
          // "Connecting"/"Offline", not "Daemon Offline") and could later
          // fire in a stale state after a reconnect cycle.
          if (daemonOfflineGraceTimerRef.current) {
            clearTimeout(daemonOfflineGraceTimerRef.current);
            daemonOfflineGraceTimerRef.current = null;
          }
        }
        if (msg.session && !msg.session.startsWith('deck_sub_')) {
          setSessions((prev) => {
            // Stopped → remove the tab immediately
            if (msg.event === 'stopped') {
              return prev.filter((s) => s.name !== msg.session);
            }
            const existing = prev.find((s) => s.name === msg.session);
            if (!existing && msg.session) {
              // Parse project name from session name pattern: deck_{project}_{role}
              const parts = msg.session.split('_');
              const project = parts.length >= 3 && parts[0] === 'deck' ? parts.slice(1, -1).join('_') : msg.session;
              return [...prev, { name: msg.session, project, role: 'brain', agentType: 'unknown', state: msg.state as SessionInfo['state'] }];
            }
            return prev.map((s) => s.name === msg.session ? { ...s, state: msg.state as SessionInfo['state'] } : s);
          });
          // Active session stopped → navigate back after a grace period
          // (allows restart to re-create the session before navigating away)
          if (msg.event === 'stopped' && msg.session === activeSessionRef.current) {
            if (stoppedNavTimerRef.current) clearTimeout(stoppedNavTimerRef.current);
            stoppedNavTimerRef.current = setTimeout(() => {
              stoppedNavTimerRef.current = null;
              if (activeSessionRef.current === msg.session) {
                setActiveSession(null);
              }
            }, 8000);
          }
          // Cancel navigate-away if the same project restarts (any role: brain/worker)
          if (msg.event === 'started' && stoppedNavTimerRef.current) {
            const stoppedSession = activeSessionRef.current;
            if (stoppedSession) {
              const stoppedProject = stoppedSession.replace(/^deck_/, '').replace(/_(brain|w\d+)$/, '');
              const startedProject = (msg.session as string).replace(/^deck_/, '').replace(/_(brain|w\d+)$/, '');
              if (stoppedProject === startedProject) {
                clearTimeout(stoppedNavTimerRef.current);
                stoppedNavTimerRef.current = null;
              }
            }
          }
        }
      }
      if (msg.type === 'session_list') {
        const watchServerName = resolvedSelectedServerName
          ?? selectedServerId;
        // Build sub-session inputs from app state (daemon filters them from session_list)
        // Use ref to avoid stale closure — subSessions state may not be in useEffect deps
        const watchSubInputs = subSessionsRef.current.map((sub: any) => ({
          sessionName: sub.sessionName,
          sessionType: sub.type ?? '',
          state: sub.state,
          label: sub.label,
          parentSession: sub.parentSession,
        }));
        watchProjectionStore.updateFromSessionListWithSubs(
          { id: selectedServerId, name: watchServerName, baseUrl: auth.baseUrl },
          msg.sessions,
          watchSubInputs,
        );
        // Daemon is connected — mark this server as online now. Also cancel
        // any pending disconnect→offline timer: receiving a session_list is
        // proof that the daemon is alive even without a DAEMON_MSG.RECONNECTED
        // (e.g. first connect after a page reload during a grace window).
        if (daemonOfflineGraceTimerRef.current) {
          clearTimeout(daemonOfflineGraceTimerRef.current);
          daemonOfflineGraceTimerRef.current = null;
        }
        setDaemonOnline(true);
        if (sessionListRetryRef.current) { clearTimeout(sessionListRetryRef.current); sessionListRetryRef.current = null; }
        setServers((prev) => markServerLive(prev, selectedServerId));
        const newSessions = msg.sessions.filter((s) => !s.name.startsWith('deck_sub_'));
        setSessions((prev) => newSessions.map((s) => {
          const existing = prev.find((p) => p.name === s.name);
          return mergeSessionListEntry(s as IncomingSessionListEntry, existing);
        }));
        setSessionsLoaded(true);
        // If active session disappeared from the list, navigate back
        if (activeSessionRef.current && !newSessions.some((s) => s.name === activeSessionRef.current)) {
          setActiveSession(null);
        }
      }
      if (msg.type === 'terminal.diff') {
        const apply = diffApplyersRef.current.get(msg.diff.sessionName);
        apply?.(msg.diff);
        // Scan terminal lines for model keywords (catches Codex footer, fallback for all agents)
        const sessionName = msg.diff.sessionName;
        const stripped = msg.diff.lines.map(([, l]: [unknown, string]) => l.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')).join(' ').toLowerCase();
        // Detect models from terminal output
        const claudeModel: string | null =
          stripped.includes('opus') ? 'opus[1M]' :
          stripped.includes('sonnet') ? 'sonnet' :
          stripped.includes('haiku') ? 'haiku' : null;
        const gptMatch = stripped.match(/\b(gpt-5(?:\.\d+)?(?:-\w+)?)\b/);
        const geminiMatch = stripped.match(/\b(gemini[- ]\d[\w.-]*)\b/);
        const detected = claudeModel ?? (gptMatch ? gptMatch[1] : null) ?? (geminiMatch ? geminiMatch[1] : null);
        if (detected) {
          setDetectedModels((prev) => {
            if (prev.get(sessionName) === detected) return prev;
            const next = new Map(prev);
            next.set(sessionName, detected);
            return next;
          });
        }
      }
      // Detect model from JSONL usage.update events (authoritative, overrides terminal scan)
      if (msg.type === 'timeline.event') {
        const event = msg.event;
        ingestTimelineEventForCache(event, selectedServerId);
        watchProjectionStore.handleTimelineEvent(event);
        if (isRunningTimelineEvent(event) && !event.sessionId.startsWith('deck_sub_')) {
          setSessions((prev) => prev.map((s) =>
            s.name === event.sessionId && s.state !== 'running'
              ? { ...s, state: 'running' as SessionInfo['state'] }
              : s,
          ));
        }
        if (isIdleSessionStateTimelineEvent(event)) {
          flashIdleSession(event.sessionId);
          if (!event.sessionId.startsWith('deck_sub_')) {
            setIdleAlerts((prev) => new Set([...prev, event.sessionId]));
          }
        }
        if (event.type === 'ask.question') {
          setPendingQuestion({
            sessionName: event.sessionId,
            toolUseId: String(event.payload.toolUseId ?? ''),
            questions: (event.payload.questions as PendingQuestion['questions']) ?? [],
          });
        }
        // Sync session state from live timeline events (running/idle)
        if (event.type === 'session.state' && !event.sessionId.startsWith('deck_sub_')) {
          const liveState = String(event.payload.state ?? '');
          const hasPendingMessagesField = Object.prototype.hasOwnProperty.call(event.payload ?? {}, 'pendingMessages');
          if (liveState === 'queued') {
            const pendingMessages = extractTransportPendingMessages(event.payload.pendingMessages);
            const pendingEntries = normalizeTransportPendingEntries(
              event.payload.pendingMessageEntries,
              pendingMessages,
              event.sessionId,
            );
            setSessions((prev) => prev.map((s) =>
              s.name === event.sessionId
                ? {
                    ...s,
                    state: 'queued' as SessionInfo['state'],
                    transportPendingMessages: pendingMessages,
                    transportPendingMessageEntries: pendingEntries,
                  }
                : s,
            ));
          } else if (liveState === 'running') {
            setSessions((prev) => prev.map((s) =>
              s.name === event.sessionId
                ? {
                    ...s,
                    state: 'running' as SessionInfo['state'],
                    transportPendingMessages: mergeTransportPendingMessagesForRunningState(
                      s.transportPendingMessages,
                      event.payload.pendingMessages,
                      hasPendingMessagesField,
                    ),
                    transportPendingMessageEntries: mergeTransportPendingEntriesForRunningState(
                      s.transportPendingMessageEntries,
                      event.payload.pendingMessageEntries,
                      event.payload.pendingMessages,
                      hasPendingMessagesField,
                      event.sessionId,
                    ),
                  }
                : s,
            ));
          } else if (liveState === 'idle') {
            setSessions((prev) => prev.map((s) =>
              s.name === event.sessionId
                ? {
                    ...s,
                    state: liveState as SessionInfo['state'],
                    transportPendingMessages: mergeTransportPendingMessagesForIdleState(
                      s.transportPendingMessages,
                      event.payload.pendingMessages,
                      hasPendingMessagesField,
                    ),
                    transportPendingMessageEntries: mergeTransportPendingEntriesForIdleState(
                      s.transportPendingMessageEntries,
                      event.payload.pendingMessageEntries,
                      event.payload.pendingMessages,
                      hasPendingMessagesField,
                      event.sessionId,
                    ),
                  }
                : s,
            ));
          }
        }
        if (event.type === 'session.state') {
          const liveState = String(event.payload.state ?? '');
          if (liveState) watchProjectionStore.updateSessionState(event.sessionId, liveState);
        }
        if (event.type === 'usage.update') {
          // Model detection
          if (event.payload.model) {
            const modelStr = String(event.payload.model).toLowerCase();
            const claudeM: string | null =
              modelStr.includes('opus') ? 'opus[1M]' :
              modelStr.includes('sonnet') ? 'sonnet' :
              modelStr.includes('haiku') ? 'haiku' : null;
            const gptM = modelStr.match(/\b(gpt-5(?:\.\d+)?(?:-\w+)?)\b/);
            const gemM = modelStr.match(/\b(gemini[- ]\d[\w.-]*)\b/);
            const det = claudeM ?? (gptM ? gptM[1] : null) ?? (gemM ? gemM[1] : null);
            if (det) {
              setDetectedModels((prev) => {
                if (prev.get(event.sessionId) === det) return prev;
                const next = new Map(prev);
                next.set(event.sessionId, det);
                return next;
              });
            }
          }
          // Track usage data for all sub-sessions (ctx bar in collapsed buttons)
          if (event.sessionId.startsWith('deck_sub_') && event.payload.inputTokens) {
            setSubUsages((prev) => {
              const next = new Map(prev);
              next.set(event.sessionId, event.payload as { inputTokens: number; cacheTokens: number; contextWindow: number; model?: string });
              return next;
            });
          }
        }
      }
      if (msg.type === 'terminal.history') {
        const applyHistory = historyApplyersRef.current.get(msg.sessionName);
        applyHistory?.(msg.content);
      }
      if (msg.type === 'session.idle') {
        const sessionName = msg.session as string;
        if (!sessionName) return;
        watchProjectionStore.onSessionIdle(sessionName);
        void watchProjectionStore.pushDurableEvent({
          type: 'session.idle',
          session: sessionName,
          serverId: selectedServerId,
          title: msg.project,
          agentType: msg.agentType,
          label: msg.label,
          parentLabel: msg.parentLabel,
        });
        // Format: label(type)@mainSession — fallback to local subSessions label, then agentType
        const localSub = subSessions.find(s => s.sessionName === sessionName);
        const label = (msg.label as string | undefined) || localSub?.label || undefined;
        const parentLabel = msg.parentLabel as string | undefined;
        const agentType = (msg.agentType as string | undefined) || localSub?.type || undefined;
        const rawProject = (msg.project as string) || sessionName;
        const displayProject = buildSessionToastLabel(sessionName, {
          label,
          parentLabel,
          project: rawProject,
          agentType,
        });
        if (!sessionName.startsWith('deck_sub_')) {
          // Main session: update state + tab alert
          setSessions((prev) => prev.map((s) => s.name === sessionName ? { ...s, state: 'idle' as SessionInfo['state'] } : s));
          // Always flash the tab — even if it's the active one
          setIdleAlerts((prev) => new Set([...prev, sessionName]));
        }
        flashIdleSession(sessionName);
        // Always show a toast (main + sub sessions)
        const id = Date.now();
        setToasts((prev) => [...prev, { id, sessionName, project: displayProject, kind: 'idle' }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
      }
      if (msg.type === 'session.notification') {
        void watchProjectionStore.pushDurableEvent({
          type: 'session.notification',
          session: msg.session,
          serverId: selectedServerId,
          title: msg.title,
          message: msg.message,
          agentType: msg.agentType,
          label: msg.label,
          parentLabel: msg.parentLabel,
        });
        const sessionName = msg.session;
        const localSub = subSessions.find(s => s.sessionName === sessionName);
        const label = (msg.label as string | undefined) || localSub?.label || undefined;
        const parentLabel = msg.parentLabel as string | undefined;
        const agentType = (msg.agentType as string | undefined) || localSub?.type || undefined;
        const rawProject = msg.project || sessionName;
        const displayProject = buildSessionToastLabel(sessionName, {
          label,
          parentLabel,
          project: rawProject,
          agentType,
        });
        const id = Date.now();
        setToasts((prev) => [...prev, { id, sessionName, project: displayProject, kind: 'notification', title: msg.title, message: msg.message }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
      }
      if (msg.type === 'session.error') {
        void watchProjectionStore.pushDurableEvent({
          type: 'session.error',
          project: msg.project,
          message: msg.message,
        });
      }
      if (msg.type === 'subsession.created') {
        watchProjectionStore.addSubSession({
          sessionName: msg.sessionName,
          sessionType: msg.sessionType,
          state: msg.state,
          label: msg.label,
          parentSession: msg.parentSession,
        }, selectedServerId);
      }
      if (msg.type === 'subsession.removed') {
        watchProjectionStore.removeSubSession(msg.sessionName);
      }
      if (msg.type === 'discussion.started') {
        setDiscussions((prev) => [
          ...prev,
          { id: msg.discussionId, topic: msg.topic, state: 'setup', currentRound: 0, maxRounds: msg.maxRounds, completedHops: 0, totalHops: msg.totalHops ?? 0, startedAt: Date.now() },
        ]);
      }
      if (msg.type === 'discussion.update') {
        setDiscussions((prev) => prev.map((d) =>
          d.id === msg.discussionId
            ? { ...d, state: msg.state, currentRound: msg.currentRound, maxRounds: msg.maxRounds, completedHops: msg.completedHops ?? d.completedHops, totalHops: msg.totalHops ?? d.totalHops, currentSpeaker: msg.currentSpeaker }
            : d,
        ));
      }
      if (msg.type === 'discussion.done') {
        setDiscussions((prev) => prev.map((d) =>
          d.id === msg.discussionId
            ? { ...d, state: 'done', conclusion: msg.conclusion, filePath: msg.filePath }
            : d,
        ));
      }
      if (msg.type === 'discussion.error') {
        if (msg.discussionId) {
          setDiscussions((prev) => prev.map((d) =>
            d.id === msg.discussionId ? { ...d, state: 'failed', error: msg.error ?? undefined } : d,
          ));
        }
      }
      if (msg.type === 'discussion.list') {
        // Merge live discussions from daemon with existing DB history
        // Preserve active P2P entries (p2p_ prefix) — they come from p2p.run_update, not discussion.list
        setDiscussions((prev) => {
          const liveIds = new Set(msg.discussions.map((d: { id: string }) => d.id));
          const dbHistory = prev.filter((d) => !liveIds.has(d.id) && (d.state === 'done' || d.state === 'failed'));
          const activeP2p = prev.filter((d) => d.id.startsWith('p2p_') && d.state !== 'done' && d.state !== 'failed');
          const mapped = msg.discussions.map((d) => ({ ...d, completedHops: d.completedHops ?? 0, totalHops: d.totalHops ?? 0 }));
          return [...mapped, ...dbHistory, ...activeP2p];
        });
      }
      // ── P2P Quick Discussion progress → map to discussions state ──────────
      if (msg.type === 'p2p.conflict') {
        // Active P2P run exists — notify user
        if (typeof window !== 'undefined') {
          window.alert(
            trans('p2p.conflict_alert') ||
            'A P2P discussion is already running. Your message was sent as a regular message instead. Wait for the current discussion to finish, or stop it first.'
          );
        }
      }
      if (msg.type === 'p2p.run_update' && msg.run) {
        const entry = mapP2pRunToDiscussion(msg.run as Record<string, any>);
        setDiscussions((prev) => {
          const existing = prev.find((d) => d.id === entry.id);
          return existing
            ? prev.map((d) => d.id === entry.id ? mergeP2pDiscussionUpdate(d, entry) : d)
            : [...prev, entry];
        });

        // Auto-cleanup completed/failed P2P entries after 30s
        if (entry.state === 'done' || entry.state === 'failed') {
          setTimeout(() => {
            setDiscussions((prev) => prev.filter((d) => d.id !== entry.id));
          }, 120_000);
        }
      }
      if (msg.type === 'p2p.cancel_response' && msg.ok && msg.runId) {
        setDiscussions((prev) => prev.filter((d) => d.id !== `p2p_${msg.runId}`));
      }
      if (msg.type === 'p2p.status_response') {
        const runs = Array.isArray(msg.runs)
          ? msg.runs
          : msg.run
            ? [msg.run]
            : [];
        const mapped = runs.map((run) => mapP2pRunToDiscussion(run as Record<string, any>));
        const activeIds = new Set(mapped.map((d) => d.id));
        setDiscussions((prev) => {
          const retained = prev.filter((d) => {
            if (!d.id.startsWith('p2p_')) return true;
            return activeIds.has(d.id);
          });
          const merged = [...retained];
          for (const entry of mapped) {
            const idx = merged.findIndex((d) => d.id === entry.id);
            if (idx >= 0) merged[idx] = mergeP2pDiscussionUpdate(merged[idx], entry);
            else merged.push(entry);
          }
          return merged;
        });
      }
      if (msg.type === REPO_MSG.DETECTED || msg.type === REPO_MSG.DETECT_RESPONSE) {
        const dir = msg.projectDir as string;
        if (dir) {
          // Normalize shape: repo.detected wraps in { context }, detect_response spreads at top level.
          // Flatten so repoContext.status always works (SubSessionBar) AND repoContext.context.status works (effect).
          const context = (msg as any).context ?? msg;
          const normalized = { ...context, context, projectDir: dir };
          setRepoContexts((prev) => {
            const next = new Map(prev);
            next.set(dir, normalized);
            return next;
          });
        }
      }
      if (msg.type === REPO_MSG.ERROR) {
        // Store error status so the auto-detect effect can stop retrying for terminal errors
        // and SubSessionBar can show appropriate state (dimmed button or hidden)
        const error = (msg as any).error as string;
        const dir = (msg as any).projectDir as string;
        if (dir && error) {
          const status = error === 'invalid_params' ? 'cli_error'
            : error === 'cli_missing' ? 'cli_missing'
            : error === 'unauthorized' ? 'unauthorized'
            : error === 'cli_outdated' ? 'cli_outdated'
            : error === 'cli_error' ? 'cli_error'
            : null;
          if (status) {
            setRepoContexts((prev) => {
              const next = new Map(prev);
              next.set(dir, { status, context: { status }, projectDir: dir });
              return next;
            });
          }
        }
      }
      if (msg.type === DAEMON_MSG.UPGRADE_BLOCKED) {
        const message = msg.reason === 'transport_busy'
          ? trans('toast.upgrade_blocked_transport_busy')
          : trans('toast.upgrade_blocked_p2p_active');
        const id = Date.now() + Math.random();
        setToasts((prev) => [...prev, {
          id,
          sessionName: '',
          project: '',
          kind: 'notification',
          title: trans('toast.upgrade_blocked_title'),
          message,
        }]);
        setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 8000);
      }
      if (msg.type === DAEMON_MSG.DISCONNECTED) {
        // Mark projection stale immediately — that's just a data-freshness
        // hint, not the user-facing status badge. But do NOT flip the
        // "Daemon Offline" badge yet: the server side still has a
        // RECONNECT_GRACE_MS window during which the daemon can reconnect
        // and inflight commands are replayed without surfacing any failure.
        // Matching that grace period here prevents the badge from flashing
        // on every pod restart / brief network blip while the user's turn
        // is actually landing fine. If the daemon does stay gone, the
        // server will broadcast MSG_DAEMON_OFFLINE (no reconnect event) and
        // this timer fires, putting the badge into the Daemon-Offline
        // state. RECONNECTED / session_list clear the timer below.
        watchProjectionStore.setSnapshotStatus('stale');
        if (daemonOfflineGraceTimerRef.current) clearTimeout(daemonOfflineGraceTimerRef.current);
        daemonOfflineGraceTimerRef.current = setTimeout(() => {
          daemonOfflineGraceTimerRef.current = null;
          setDaemonOnline(false);
          setServers((prev) => markServerOffline(prev, selectedServerId));
        }, RECONNECT_GRACE_MS);
      }
      if (msg.type === MSG_DAEMON_ONLINE || msg.type === DAEMON_MSG.RECONNECTED) {
        if (daemonOfflineGraceTimerRef.current) {
          clearTimeout(daemonOfflineGraceTimerRef.current);
          daemonOfflineGraceTimerRef.current = null;
        }
        setDaemonOnline(true);
        setServers((prev) => markServerLive(prev, selectedServerId));
      }
      if (msg.type === MSG_DAEMON_OFFLINE) {
        if (daemonOfflineGraceTimerRef.current) {
          clearTimeout(daemonOfflineGraceTimerRef.current);
          daemonOfflineGraceTimerRef.current = null;
        }
        setDaemonOnline(false);
        setServers((prev) => markServerOffline(prev, selectedServerId));
        watchProjectionStore.setSnapshotStatus('stale');
      }
      if (msg.type === 'daemon.error') {
        // Surface uncaught daemon errors as a toast so users aren't left in the dark.
        const id = Date.now() + Math.random();
        setToasts((prev) => [...prev, {
          id,
          sessionName: '',
          project: '',
          kind: 'notification',
          title: 'Daemon error',
          message: msg.message,
        }]);
        // eslint-disable-next-line no-console
        console.error('[daemon.error]', msg.kind, msg.message, msg.stack);
        // Auto-dismiss after 10 seconds
        setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 10_000);
      }
      // P2P command errors surface as `command.ack status:error` with a
      // specific `error` code. `useTimeline` handles them per-session by
      // flipping an optimistic bubble to failed-"!", but the web composer
      // now INTERCEPTS optimistic bubbles for P2P sends (they belong to
      // the discussion file, not the chat) — so without this top-level
      // toast there is literally no UI feedback and P2P failures look
      // like the daemon ate the command silently. Handle here so the
      // user can see what happened and open the config panel.
      if (msg.type === 'command.ack'
        && (msg as { status?: unknown }).status === 'error'
        && typeof (msg as { error?: unknown }).error === 'string') {
        // Cast through `unknown` because `msg.type === 'command.ack'` already
        // narrows msg to a shape that doesn't declare `error`; the runtime
        // `typeof error === 'string'` check above guarantees the field exists.
        const errorCode = (msg as unknown as { error: string }).error;
        const knownP2pErrors = new Set<string>([
          'no_configured_targets',
          'no_sessions',
          'no_valid_targets',
        ]);
        if (knownP2pErrors.has(errorCode)) {
          const titleMap: Record<string, string> = {
            no_configured_targets: 'P2P: no configured participants',
            no_sessions: 'P2P: no eligible sessions',
            no_valid_targets: 'P2P: targets not found',
          };
          const bodyMap: Record<string, string> = {
            no_configured_targets: 'All eligible sessions are opt-out or absent from your saved P2P config. Open the P2P panel and enable the sessions you want to include.',
            no_sessions: 'No other active sessions in this project/domain to dispatch to.',
            no_valid_targets: 'The @@ targets you referenced do not match any active sessions.',
          };
          const id = Date.now() + Math.random();
          setToasts((prev) => [...prev, {
            id,
            sessionName: '',
            project: '',
            kind: 'notification',
            title: titleMap[errorCode] ?? 'P2P send failed',
            message: bodyMap[errorCode] ?? errorCode,
          }]);
          setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 8000);
        }
      }
      if (msg.type === DAEMON_MSG.RECONNECTED) {
        // Daemon came back within (or after) the grace window — cancel any
        // pending "flip to offline" so the badge never flashes red for a
        // reconnect that actually succeeded.
        if (daemonOfflineGraceTimerRef.current) {
          clearTimeout(daemonOfflineGraceTimerRef.current);
          daemonOfflineGraceTimerRef.current = null;
        }
        setDaemonOnline(true);
        // Daemon process (re)started — all its subscriptions are gone.
        // Re-subscribe active targets first, then stagger the rest to avoid a herd.
        const activeName = activeSessionRef.current;
        const activeMode = activeName ? (viewModesRef.current[activeName] ?? defaultViewMode) as ViewMode : undefined;
        scheduleResubscribe(buildTerminalResubscribePlan({
          activeName,
          activeMode,
          focusedSubId: focusedSubIdRef.current,
          sessions: sessionsRef.current,
          subSessions: subSessionsRef.current,
        }));
        // Refresh discussion list
        ws.discussionList();
      }
    });

    ws.onLatency((ms) => {
      setLatencyMs(ms);
      // Pong proves the WS to the server pod is alive. Refresh lastHeartbeatAt
      // so the sidebar device dot stays green during quiet periods (no
      // session_list / timeline events arriving). Without this, the 60s
      // freshness window expires on idle daemons — especially when the tab is
      // backgrounded and `loadServers()` polls are throttled — and the dot
      // turns gray until *some* WS app-level message arrives (e.g. another
      // client sends a message and the daemon broadcasts back). Use
      // `touchServerHeartbeat` so a server that was explicitly marked offline
      // via MSG_DAEMON_OFFLINE doesn't get accidentally promoted back online.
      setServers((prev) => touchServerHeartbeat(prev, selectedServerId));
    });
    const unsubStats = ws.onMessage((msg) => {
      if (msg.type === 'daemon.stats') {
        setDaemonStats({ daemonVersion: msg.daemonVersion, cpu: msg.cpu, memUsed: msg.memUsed, memTotal: msg.memTotal, load1: msg.load1, load5: msg.load5, load15: msg.load15, uptime: msg.uptime });
      }
    });
    setConnecting(true);
    ws.connect();

    // Probe the browser-server socket when the tab returns to the foreground.
    // While the probe is waiting for pong, WsClient marks itself disconnected
    // so the first user send cannot disappear into a stale-open socket.
    let lastResumeCheckAt = 0;
    const handleResume = () => {
      const now = Date.now();
      if (now - lastResumeCheckAt < 500) return;
      lastResumeCheckAt = now;
      ws.probeConnection();
      requestActiveTimelineRefresh({ resetCooldowns: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') return;
      handleResume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', handleResume);
    const onPageShow = (ev: PageTransitionEvent) => {
      if (ev.persisted) handleResume();
    };
    window.addEventListener('pageshow', onPageShow);

    let removeAppStateListener: (() => void) | null = null;
    if (isNative()) {
      void import('@capacitor/app')
        .then(({ App }) => installNativeAppResumeRefresh(true, () => ws.probeConnection(), App))
        .then((cleanup) => {
          removeAppStateListener = cleanup;
        })
        .catch(() => {});
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', handleResume);
      window.removeEventListener('pageshow', onPageShow);
      removeAppStateListener?.();
      unsub();
      unsubStats();
      ws.onLatency(null);
      ws.disconnect();
      wsRef.current = null;
      setConnected(false);
      setConnecting(false);
      setDaemonOnline(false);
      setLatencyMs(null);
      setDaemonStats(null);
      if (sessionListRetryRef.current) { clearTimeout(sessionListRetryRef.current); sessionListRetryRef.current = null; }
      if (daemonOfflineGraceTimerRef.current) { clearTimeout(daemonOfflineGraceTimerRef.current); daemonOfflineGraceTimerRef.current = null; }
      for (const timer of resubscribeTimersRef.current) clearTimeout(timer);
      resubscribeTimersRef.current.clear();
    };
  }, [auth, selectedServerId]);

  // Subscribe to terminal for ALL sessions when connected.
  // SDK/transport sessions must remain passively subscribed so shared timeline
  // updates keep flowing even when their chat controls are not mounted.
  const sessionNamesKey = sessions.map((s) => s.name).sort().join(',');
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || sessions.length === 0) return;
    const names = listPassiveTerminalSubscriptionNames(sessions);
    for (const name of names) {
      ws.subscribeTerminal(name, false);
      const mode = viewModesRef.current[name] ?? defaultViewMode;
      if (mode === 'chat') {
        ws.sendResize(name, 200, 50);
      }
    }
    return () => {
      for (const name of names) {
        try { ws.unsubscribeTerminal(name); } catch { /* ignore */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionNamesKey]);

  // Subscribe to structured transport chat/timeline updates for ALL transport sessions.
  // SDK-backed sessions must remain globally subscribed regardless of which panel is active.
  // Key includes runtimeType so effect re-runs when WebSocket merge corrects null→'transport'
  // for copilot/cursor sessions loaded from a pre-migration DB (runtime_type was NULL).
  const transportSessionKey = sessions.map((s) => `${s.name}:${s.runtimeType}`).sort().join(',');
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || sessions.length === 0) return;
    const names = listGlobalTransportSubscriptionNames(sessions);
    for (const name of names) {
      try { ws.subscribeTransportSession(name); } catch { /* ignore */ }
    }
    return () => {
      for (const name of names) {
        try { ws.unsubscribeTransportSession(name); } catch { /* ignore */ }
      }
    };
  // NOTE: `sessions` (the raw array) is intentionally omitted from the dep
  // array. Including it caused a subscribe/unsubscribe flap loop — every
  // setState produces a new array reference even when contents are identical,
  // which re-ran this effect dozens of times per frame and saturated the
  // server's per-browser rate limit (120 msgs / 10s), collaterally dropping
  // `session.send` messages and leaving the chat bubble spinning for 30s.
  // `transportSessionKey` already captures every semantic change
  // (session names + runtimeType), so the string key is sufficient.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, transportSessionKey]);

  // Subscribe terminal for ALL sub-sessions in passive mode.
  // Active sub-session windows upgrade themselves to raw:true while visible.
  const subSessionNamesKey = subSessions.map((s) => s.sessionName).sort().join(',');
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || subSessions.length === 0) return;
    const names = listPassiveTerminalSubSessionNames(subSessions);
    for (const name of names) {
      try { ws.subscribeTerminal(name, false); } catch { /* ignore */ }
    }
    return () => {
      for (const name of names) {
        try { ws.unsubscribeTerminal(name); } catch { /* ignore */ }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, subSessionNamesKey]);

  // Subscribe to structured transport updates for ALL transport sub-sessions too.
  // Key includes runtimeType so effect re-runs when WebSocket merge corrects null→'transport'.
  const transportSubSessionKey = subSessions.map((s) => `${s.sessionName}:${s.runtimeType}`).sort().join(',');
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || subSessions.length === 0) return;
    const names = listGlobalTransportSubSessionNames(subSessions);
    for (const name of names) {
      try { ws.subscribeTransportSession(name); } catch { /* ignore */ }
    }
    return () => {
      for (const name of names) {
        try { ws.unsubscribeTransportSession(name); } catch { /* ignore */ }
      }
    };
  // Same rationale as the transport-session effect above — string key only,
  // no raw array ref. See that effect's comment for the subscribe/unsubscribe
  // flap loop this prevents.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, transportSubSessionKey]);

  // When switching to a session in terminal mode, trigger fit.
  // All sessions are subscribed to PTY streaming, so xterm buffer is already current —
  // the ResizeObserver handles the fit; no snapshot request needed (it would cause a
  // redundant full-frame re-render that makes the switch feel slow/flashy).
  useEffect(() => {
    if (!activeSession || viewMode !== 'terminal') return;
    // Use double-rAF: first rAF waits for display:flex to take effect,
    // second rAF ensures layout has computed real dimensions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        termFitFnsRef.current.get(activeSession)?.();
      });
    });
  }, [activeSession, viewMode]);

  // Re-subscribe when tab/window becomes visible (handles sleep/wake, background tabs)
  const viewModesRef = useRef(viewModes);
  viewModesRef.current = viewModes;

  // Keep the active session in raw mode only while it is actively rendering terminal output.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws?.connected || !activeSession) return;
    const raw = shouldSubscribeTerminalRaw(true, viewMode);
    ws.subscribeTerminal(activeSession, raw);
    if (!raw) {
      ws.sendResize(activeSession, 200, 50);
    }
    return () => {
      try { ws.subscribeTerminal(activeSession, false); } catch { /* ignore */ }
    };
  }, [connected, activeRuntimeType, activeSession, viewMode]);

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      const ws = wsRef.current;
      const session = activeSessionRef.current;
      if (!ws?.connected || !session) return;
      const raw = shouldSubscribeTerminalRaw(true, (viewModesRef.current[session] ?? defaultViewMode) as ViewMode);
      ws.subscribeTerminal(session, raw);
      const mode = viewModesRef.current[session] ?? defaultViewMode;
      if (mode === 'chat') {
        ws.sendResize(session, 200, 50);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []); // no deps — uses refs

  // Global keyboard passthrough
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ws = wsRef.current;
      const session = activeSession;
      if (!ws?.connected || !session) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (el?.isContentEditable) return;

      const currentViewMode = viewModesRef.current[session] ?? defaultViewMode;
      if (currentViewMode === 'chat') {
        // In chat mode: route Up/Down/Enter to chat input (history nav + send)
        const chatInput = inputRefsMap.current.get(session) ?? null;
        if (!chatInput) return;
        if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Backspace') {
          e.preventDefault();
          chatInput.focus();
          chatInput.dispatchEvent(new KeyboardEvent('keydown', {
            key: e.key, code: e.code, keyCode: e.keyCode,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
            bubbles: true, cancelable: true,
          }));
        } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
          // Printable chars: focus and insert text directly into contentEditable
          e.preventDefault();
          chatInput.focus();
          document.execCommand('insertText', false, e.key);
        }
        return;
      }

      let data: string | null = null;
      if (e.key === 'Enter')     { data = '\r'; }
      else if (e.key === 'Backspace') { data = '\x7f'; }
      else if (e.key === 'Tab')  { data = '\t'; e.preventDefault(); }
      else if (e.key === 'Escape') { data = '\x1b'; }
      else if (e.key === 'ArrowUp')    { data = '\x1b[A'; }
      else if (e.key === 'ArrowDown')  { data = '\x1b[B'; }
      else if (e.key === 'ArrowRight') { data = '\x1b[C'; }
      else if (e.key === 'ArrowLeft')  { data = '\x1b[D'; }
      else if (e.key === 'Home')  { data = '\x1b[H'; }
      else if (e.key === 'End')   { data = '\x1b[F'; }
      else if (e.key === 'Delete') { data = '\x1b[3~'; }
      else if (e.ctrlKey && e.key.length === 1) {
        const code = e.key.toLowerCase().charCodeAt(0) - 96;
        if (code >= 1 && code <= 26) { data = String.fromCharCode(code); }
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
        data = e.key;
      }

      if (data !== null) {
        e.preventDefault();
        ws.sendInput(session, data);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [activeSession, connected]);

  // Ctrl+B (Cmd+B on Mac) — toggle sidebar collapse (desktop only)
  useEffect(() => {
    if (isMobile) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'b') return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (el?.isContentEditable) return;
      e.preventDefault();
      handleToggleSidebar();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isMobile, handleToggleSidebar]);

  // Mobile sidebar: drag-follow gesture system.
  // - Swipe right from left edge → panel follows finger → snap open/closed on release
  // - When open, swipe left on panel/backdrop → follows finger → snap closed
  // Sidebar: simple open/close via state + CSS transition. No drag gesture (was interfering
  // with chat long-press and scroll). Open via ≡ button, close via backdrop tap or ✕ button.
  const sidebarOverlayRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = useRef<HTMLDivElement>(null);
  const closeSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  const handleLogout = useCallback(async () => {
    if (isNative()) {
      // Native: revoke API key server-side, clear biometric storage
      try {
        const { Preferences } = await import('@capacitor/preferences');
        const { value: keyId } = await Preferences.get({ key: 'deck_api_key_id' });
        if (keyId) {
          await apiFetch(`/api/auth/user/me/keys/${keyId}`, { method: 'DELETE' }).catch(() => {});
          await Preferences.remove({ key: 'deck_api_key_id' });
        }
      } catch { /* ignore */ }
      await clearAuthKey();
      clearApiKey();
    } else {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch { /* ignore — clear local state regardless */ }
    }
    localStorage.removeItem('rcc_auth');
    localStorage.removeItem('rcc_server');
    localStorage.removeItem('rcc_server_name');
    localStorage.removeItem('rcc_session');
    setAuth(null);
    setSessions([]);
    setActiveSession(null);
    setSelectedServerId(null);
    setDiscussions([]);
    setRepoContexts(new Map());
    setManualDashboard(false);
    setAutoEnteringRecent(false);
  }, [setActiveSession]);

  // Native only: log out + clear server URL → back to ServerSetupPage
  const handleChangeServer = useCallback(async () => {
    setShowMobileServerMenu(false);
    try { await handleLogout(); } catch { /* ignore */ }
    try { await clearServerUrl(); } catch { /* ignore */ }
    setNativeServerUrl(null);
  }, [handleLogout]);

  const handleSelectServer = useCallback(async (serverId: string, serverName?: string) => {
    autoEntryRunRef.current++;
    setManualDashboard(false);
    // Save current active session for the server we're leaving
    const prevServer = localStorage.getItem('rcc_server');
    const currentSession = localStorage.getItem('rcc_session');
    if (prevServer && currentSession) {
      localStorage.setItem(`rcc_session_${prevServer}`, currentSession);
    } else if (prevServer) {
      localStorage.removeItem(`rcc_session_${prevServer}`);
    }

    localStorage.setItem('rcc_server', serverId);
    if (serverName) localStorage.setItem('rcc_server_name', serverName);

    // Restore previously selected session for this server
    const savedSession = localStorage.getItem(`rcc_session_${serverId}`);
    if (savedSession) {
      localStorage.setItem('rcc_session', savedSession);
    } else {
      localStorage.removeItem('rcc_session');
    }

    // Write the hash BEFORE reload so the new page picks up the right server+session
    // from the URL rather than from (now shared) localStorage.
    writeHashState(serverId, savedSession ?? null);

    // Full page reload — guarantees all components, WS connections, and pinned
    // panels start fresh with the new server. Avoids stale WS/state bugs.
    window.location.reload();
  }, []);

  // Pending navigation target for sub-sessions that haven't loaded yet
  const [pendingNav, setPendingNav] = useState<{ session: string; quote?: string } | null>(() => {
    // Post-reload: pick up pending push target from localStorage (set before server switch reload)
    const target = localStorage.getItem('rcc_push_target');
    if (!target) return null;
    localStorage.removeItem('rcc_push_target');
    const quote = localStorage.getItem('rcc_push_quote') ?? undefined;
    if (quote) localStorage.removeItem('rcc_push_quote');
    return { session: target, quote };
  });
  const [pendingPrefills, setPendingPrefills] = useState<Record<string, string>>({});

  // Helper: navigate to a session (main or sub) without reload.
  // For sub-sessions, if sub-session data isn't loaded yet, queues a pending nav.
  const navigateToSession = useCallback((session: string, quote?: string) => {
    const subMatch = session.match(/^deck_sub_(.+)$/);
    if (subMatch) {
      const subId = subMatch[1];
      const sub = subSessionsRef.current.find((s) => s.id === subId);
      if (!sub) {
        // Sub-sessions not loaded yet — queue for retry when they arrive
        setPendingNav({ session, quote });
        return;
      }
      // Activate parent main session first
      if (sub.parentSession) {
        localStorage.setItem('rcc_session', sub.parentSession);
        setActiveSession(sub.parentSession, { keepSubWindows: true });
      }
      setOpenSubIds((prev) => new Set([...prev, subId]));
      bringSubToFront(subId);
    } else {
      localStorage.setItem('rcc_session', session);
      setActiveSession(session);
    }
    if (quote) {
      const quoteText = `${quote.trim().split('\n').map((l: string) => `> ${l}`).join('\n')}\n`;
      setPendingPrefills((prev) => ({ ...prev, [session]: (prev[session] || '') + quoteText }));
    }
  }, [setActiveSession, bringSubToFront]);

  const navigateToSessionRef = useRef(navigateToSession);
  navigateToSessionRef.current = navigateToSession;

  // Reactive: when sub-sessions load and we have a pending nav, retry navigation
  useEffect(() => {
    if (!pendingNav) return;
    const subMatch = pendingNav.session.match(/^deck_sub_(.+)$/);
    if (!subMatch) {
      navigateToSession(pendingNav.session, pendingNav.quote);
      setPendingNav(null);
      return;
    }
    const sub = subSessions.find((s) => s.id === subMatch[1]);
    if (sub) {
      navigateToSession(pendingNav.session, pendingNav.quote);
      setPendingNav(null);
    }
  }, [pendingNav, subSessions, navigateToSession]);

  // Safety timeout: if pending nav isn't resolved within 8s, clear it
  useEffect(() => {
    if (!pendingNav) return;
    const timer = setTimeout(() => setPendingNav(null), 8000);
    return () => clearTimeout(timer);
  }, [pendingNav]);

  // Push notification tap → navigate to the right server + session.
  useEffect(() => {
    const handler = (e: Event) => {
      const { serverId: sid, session, quote } = (e as CustomEvent).detail ?? {};
      const currentServer = localStorage.getItem('rcc_server');
      const needsServerSwitch = sid && sid !== currentServer;

      if (needsServerSwitch) {
        if (session) localStorage.setItem('rcc_push_target', session as string);
        if (quote) localStorage.setItem('rcc_push_quote', quote as string);
        handleSelectServer(sid!);
        return;
      }

      if (session) {
        navigateToSession(session as string, quote as string | undefined);
      }
    };
    window.addEventListener('deck:navigate', handler);

    const discussionHandler = (e: Event) => {
      const { fileId } = (e as CustomEvent).detail ?? {};
      if (fileId) { setDiscussionInitialId(fileId); setShowDiscussionsPage(true); }
    };
    window.addEventListener('deck:view-discussion', discussionHandler);

    return () => { window.removeEventListener('deck:navigate', handler); window.removeEventListener('deck:view-discussion', discussionHandler); };
  }, [handleSelectServer, navigateToSession]);

  const handleBackToDashboard = useCallback(() => {
    autoEntryRunRef.current++;
    setManualDashboard(true);
    localStorage.removeItem('rcc_server');
    localStorage.removeItem('rcc_server_name');
    localStorage.removeItem('rcc_session');
    setSelectedServerId(null);
    setSelectedServerName(null);
    setActiveSession(null);
    setShowMobileServerMenu(false);
  }, [setActiveSession]);

  const handleStopProject = useCallback((project: string) => {
    if (!wsRef.current) return;
    setSessions((prev) => prev.map((s) =>
      s.project === project ? { ...s, state: 'stopping' as SessionInfo['state'] } : s,
    ));
    wsRef.current.sendSessionCommand('stop', { project });
  }, []);

  const handleRestartProject = useCallback((project: string, fresh?: boolean) => {
    wsRef.current?.sendSessionCommand('restart', { project, ...(fresh ? { fresh: true } : {}) });
  }, []);

  const registerDiffApplyer = useCallback((sessionName: string, apply: (d: TerminalDiff) => void) => {
    diffApplyersRef.current.set(sessionName, apply);
  }, []);

  const registerHistoryApplyer = useCallback((sessionName: string, apply: (content: string) => void) => {
    historyApplyersRef.current.set(sessionName, apply);
  }, []);

  // Web page opened by native app via ASWebAuthenticationSession for passkey login.
  // Only allow imcodes:// callback to prevent open redirect attacks.
  if (nativeCallback && nativeCallback.startsWith('imcodes://') && !isNative()) {
    return <NativeAuthBridge callbackUrl={nativeCallback} />;
  }

  if (!nativeReady || !splashDone) {
    return null; // Wait for splash animation + native init
  }

  if (isNative() && !nativeServerUrl) {
    return (
      <ServerSetupPage
        onConnect={(url) => {
          setNativeServerUrl(url);
          configureApi(url);
        }}
      />
    );
  }

  if (!auth) {
    return (
      <LoginPage
        serverUrl={nativeServerUrl}
        onLoginSuccess={(userId, url) => {
          const authState: AuthState = { userId, baseUrl: url };
          localStorage.setItem('rcc_auth', JSON.stringify(authState));
          setAuth(authState);
        }}
        onChangeServer={isNative() ? () => setNativeServerUrl(null) : undefined}
      />
    );
  }

  const activeSessionInfo = sessions.find((s) => s.name === activeSession) ?? null;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = buildDocumentTitle(resolvedSelectedServerName, activeSessionInfo);
  }, [resolvedSelectedServerName, activeSessionInfo]);

  const newUserGuideSteps = useMemo<NewUserGuideStep[]>(() => [
    {
      selector: '[data-onboarding="new-main-session"]',
      titleKey: 'onboarding.steps.new_main.title',
      bodyKeys: [
        'onboarding.steps.new_main.body_1',
        'onboarding.steps.new_main.body_2',
      ],
    },
    {
      selector: '[data-onboarding="new-sub-session"]',
      titleKey: 'onboarding.steps.new_sub.title',
      bodyKeys: [
        'onboarding.steps.new_sub.body_1',
        'onboarding.steps.new_sub.body_2',
      ],
    },
    {
      selector: '[data-onboarding="discussion-history"]',
      titleKey: 'onboarding.steps.discussions.title',
      bodyKeys: [
        'onboarding.steps.discussions.body_1',
      ],
    },
    {
      selector: '[data-onboarding="repo-page"]',
      titleKey: 'onboarding.steps.repo.title',
      bodyKeys: [
        'onboarding.steps.repo.body_1',
      ],
    },
    {
      selector: '[data-onboarding="cron-manager"]',
      titleKey: 'onboarding.steps.cron.title',
      bodyKeys: [
        'onboarding.steps.cron.body_1',
      ],
    },
    {
      selector: '[data-onboarding="view-toggle"]',
      titleKey: 'onboarding.steps.view_toggle.title',
      bodyKeys: [
        'onboarding.steps.view_toggle.body_1',
      ],
    },
    {
      selector: '[data-onboarding="p2p-mode"]',
      titleKey: 'onboarding.steps.p2p_defaults.title',
      bodyKeys: [
        'onboarding.steps.p2p_defaults.body_1',
        'onboarding.steps.p2p_defaults.body_2',
      ],
    },
    {
      selector: '[data-onboarding="chat-input"]',
      titleKey: 'onboarding.steps.p2p_send.title',
      bodyKeys: [
        'onboarding.steps.p2p_send.body_1',
        'onboarding.steps.p2p_send.body_2',
        'onboarding.steps.p2p_send.body_3',
      ],
    },
  ], []);

  function scheduleResubscribe(items: Array<{ name: string; mode?: ViewMode }>) {
    const ws = wsRef.current;
    if (!ws?.connected || items.length === 0) return;

    const unique = new Map<string, { name: string; mode?: ViewMode }>();
    for (const item of items) {
      if (!unique.has(item.name)) unique.set(item.name, item);
    }

    let index = 0;
    for (const item of unique.values()) {
      const timer = setTimeout(() => {
        resubscribeTimersRef.current.delete(timer);
        const liveWs = wsRef.current;
        if (!liveWs?.connected) return;
        try { liveWs.subscribeTerminal(item.name, item.mode === 'terminal'); } catch { return; }
        if (item.mode === 'chat') {
          try { liveWs.sendResize(item.name, 200, 50); } catch { /* ignore */ }
        }
      }, index * 120);
      resubscribeTimersRef.current.add(timer);
      index++;
    }
  }

  useEffect(() => {
    if (!pendingRepoToastSession) return;
    if (activeSession !== pendingRepoToastSession.sessionName) return;
    setShowRepoPage(true);
    setRepoFocusLatestAction(pendingRepoToastSession.focus);
    setPendingRepoToastSession(null);
  }, [activeSession, pendingRepoToastSession]);

  // Memoized sub-session mappings — avoids creating new arrays on every render,
  // which would defeat memo() on child components (SessionPane, SessionTree, pinned panels).
  const subSessionsSlim = useMemo(() =>
    subSessions.map(s => ({ sessionName: s.sessionName, type: s.type, label: s.label, state: s.state, parentSession: s.parentSession })),
    [subSessions]
  );

  const visiblePinnedPanels = useMemo(() =>
    pinnedPanels.filter((p) => (
      p.id
      && p.props
      && (p.type !== 'subsession' || !p.props.serverId || p.props.serverId === selectedServerId)
      && (p.type !== LOCAL_WEB_PREVIEW_PANEL_TYPE || !p.props.serverId || p.props.serverId === selectedServerId)
    )),
    [pinnedPanels, selectedServerId]
  );

  // Auto-pin file browser to sidebar on first session activation.
  // Respects user preference: once they have any pinned panels saved, don't interfere.
  const autoPinnedRef = useRef(false);
  useEffect(() => {
    if (autoPinnedRef.current || !activeSession || !activeSessionInfo?.projectDir) return;
    if (pinnedPanels.length > 0) { autoPinnedRef.current = true; return; } // user already has panels
    autoPinnedRef.current = true;
    pinPanel('filebrowser', { sessionName: activeSession, projectDir: activeSessionInfo.projectDir, serverId: selectedServerId });
    const cronProject = sessions.find(s => s.name === activeSession)?.project;
    if (cronProject) {
      pinPanel('cronmanager', { sessionName: activeSession, projectName: cronProject, serverId: selectedServerId });
    }
  }, [activeSession, activeSessionInfo?.projectDir, pinnedPanels.length, pinPanel, selectedServerId]);

  // ── Git changes count for file browser badge ───────────────────────────
  // Uses useSharedGitChanges — shares the cache with FileBrowser, SubSessionWindow,
  // and any other consumer pointing at the same repo path. A single `fs.git_status`
  // request feeds all of them; no duplicate requests when paths match.
  const sharedGitFiles = useSharedGitChanges(wsRef.current, activeSessionInfo?.projectDir ?? null);
  const gitChangesCount = sharedGitFiles.length;

  // Nudge the shared cache when the agent finishes a tool call or goes idle,
  // so the badge reflects new/modified files without waiting for the 30s poll.
  // The 5s TTL in the store dedupes bursty events across sessions.
  useEffect(() => {
    const ws = wsRef.current;
    const dir = activeSessionInfo?.projectDir;
    if (!ws || !connected || !dir) return;
    const unsub = ws.onMessage((msg) => {
      if (msg.type !== 'timeline.event') return;
      const evt = (msg as unknown as { event?: { type?: string; payload?: { state?: string } } }).event;
      if (evt?.type === 'tool.result' || (evt?.type === 'session.state' && evt.payload?.state === 'idle')) {
        requestSharedChanges(ws, dir);
      }
    });
    return () => { unsub(); };
  }, [activeSessionInfo?.projectDir, connected]);

  // ── Auto-detect repo for active session (with retry) ───────────────────
  // IMPORTANT: This useEffect MUST be before any conditional returns to avoid
  // React hooks ordering violation (hooks cannot be called conditionally).
  useEffect(() => {
    const ws = wsRef.current;
    const dir = activeSessionInfo?.projectDir;
    if (!ws || !dir || !connected) return;

    const existing = repoContextsRef.current.get(dir);
    // Already detected with a definitive status — no need to re-detect
    const TERMINAL_STATUSES = new Set(['ok', 'no_repo', 'cli_missing', 'cli_outdated', 'unauthorized', 'unknown_platform']);
    // Note: 'cli_error' is NOT terminal — it can be transient (rate limit, path mismatch, etc.)
    if (existing?.context?.status && TERMINAL_STATUSES.has(existing.context.status)) return;

    // Delay initial detect to avoid browser rate limit on connect (burst of subscribes + timeline requests)
    const initialTimer = setTimeout(() => ws.repoDetect(dir), 3_000);

    // Retry every 15s unless we get a definitive answer
    const interval = setInterval(() => {
      const ctx = repoContextsRef.current.get(dir);
      if (ctx?.context?.status && TERMINAL_STATUSES.has(ctx.context.status)) {
        clearInterval(interval);
        return;
      }
      ws.repoDetect(dir);
    }, 15_000);

    return () => { clearTimeout(initialTimer); clearInterval(interval); };
  }, [activeSessionInfo?.projectDir, connected]);

  // Show full-screen connecting indicator while waiting for initial WS + session data.
  // After 8s, show escape buttons so the user is never stuck.
  const [connectTimeout, setConnectTimeout] = useState(false);
  const showInitialConnectingGate = shouldShowInitialConnectingGate(
    Boolean(auth),
    selectedServerId,
    connected,
    sessionsLoaded,
  );
  const resolvedActiveSessionExists = hasResolvedActiveSession(activeSession, sessions);
  const selectedServerInfo = selectedServerId
    ? servers.find((server) => server.id === selectedServerId) ?? null
    : null;
  const daemonBadgeState = getDaemonBadgeState(connected, connecting, daemonOnline, selectedServerInfo);

  useEffect(() => {
    if (showInitialConnectingGate) {
      const t = setTimeout(() => setConnectTimeout(true), 5000);
      return () => { clearTimeout(t); setConnectTimeout(false); };
    }
    setConnectTimeout(false);
    return undefined;
  }, [showInitialConnectingGate]);

  if (showInitialConnectingGate) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0a0e1a', flexDirection: 'column', gap: 16 }}>
        <div class="spinner" style={{ width: 32, height: 32 }} />
        <div style={{ color: '#64748b', fontSize: 14 }}>{connecting ? trans('common.reconnecting') : trans('common.loading')}</div>
        {connectTimeout && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button class="btn" style={{ background: '#334155', color: '#e2e8f0', fontSize: 12 }} onClick={handleBackToDashboard}>
              ← Back
            </button>
            <button class="btn" style={{ background: '#334155', color: '#e2e8f0', fontSize: 12 }} onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div class="layout" key={selectedServerId ?? ''}>
      {/* Desktop 3-column: [ServerIconBar][SidebarPanel][MainContent] */}
      {!isMobile && (
        <>
          <ServerIconBar
            servers={servers}
            activeServerId={selectedServerId}
            onSelectServer={handleSelectServer}
            onServerContextMenu={(server, x, y) => setServerCtxMenu({ server, x, y })}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={handleToggleSidebar}
            onSettings={() => setShowSettingsPage(true)}
            onHome={handleBackToDashboard}
            isAdmin={isAdmin}
            onAdmin={() => setShowAdminPage(true)}
          />
          <Sidebar
            collapsed={sidebarCollapsed}
            serverId={selectedServerId}
            pinnedPanels={pinnedPanels}
            onDropPanel={(type, id) => {
              if (type === 'subsession') {
                const sub = subSessions.find(s => s.id === id);
                if (sub) pinPanel('subsession', { sessionName: sub.sessionName, label: sub.label, serverId: selectedServerId }, () => setOpenSubIds((prev) => { const s = new Set(prev); s.delete(id); return s; }));
              }
            }}
          >
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px 0' }}>
              <button
                class="btn"
                style={{ background: '#334155', color: '#e2e8f0', fontSize: 12 }}
                onClick={() => {
                  setSharedContextManagementProps((prev) => ({ ...prev, serverId: selectedServerId }));
                  setShowSharedContextManagement(true);
                }}
              >
                {trans('sharedContext.management.title')}
              </button>
              <button
                class="btn"
                style={{ background: '#334155', color: '#e2e8f0', fontSize: 12 }}
                onClick={() => setShowSharedContextDiagnostics(true)}
              >
                {trans('sharedContext.diagnostics.title')}
              </button>
            </div>
            {/* Session tree */}
            <SessionTree
              serverId={selectedServerId}
              sessions={sessions}
              subSessions={subSessions}
              activeSession={activeSession}
              unreadCounts={unreadCounts}
              idleFlashTokens={idleFlashTokens}
              p2pSessionLabels={p2pSessionLabels}
              onSelectSession={(name) => {
                setActiveSession(name);
                setIdleAlerts((prev) => { const s = new Set(prev); s.delete(name); return s; });
              }}
              onSelectSubSession={(sub) => {
                if (sub.parentSession && sub.parentSession !== activeSession) {
                  setActiveSession(sub.parentSession, { keepSubWindows: true });
                }
                toggleSubSession(sub.id);
              }}
              onNewSession={() => setShowNewSession(true)}
              onNewSubSession={() => setShowSubDialog(true)}
            />

            {/* P2P ring progress — show active P2P runs */}
            {discussions.filter((d) => d.state === 'running' || d.state === 'setup').filter((d) => d.id.startsWith('p2p_')).map((d) => (
              <P2pRingProgress
                key={d.id}
                completedRounds={Math.max(0, d.currentRound - 1)}
                totalRounds={d.maxRounds}
                completedHops={d.completedHops}
                totalHops={d.totalHops}
                activeHop={d.activeHop}
                activeRoundHop={d.activeRoundHop}
                status={d.state}
                modeKey={d.modeKey}
                onClick={() => { setDiscussionInitialId(d.fileId ?? null); setShowDiscussionsPage(true); }}
              />
            ))}

            {/* Pinned panels — sub-session panels filtered by current server (WS/tmux bound); others always shown */}
            {visiblePinnedPanels.map((panel) => {
              const height = pinnedPanelHeights[panel.id] ?? 240;
              const ctx: PanelRenderContext = {
                ws: wsRef.current,
                connected,
                serverId: selectedServerId ?? '',
                subSessions,
                inputRefsMap,
                onPreviewFile: (request) => handlePreviewFileRequest({ ...request, sourcePreviewLive: false }),
                onPreviewStateChange: handlePreviewStateChange,
                activeSession,
                activeProjectDir: activeSessionInfo?.projectDir,
                sessions,
                servers: servers.map(s => ({ id: s.id, name: s.name })),
                onQuote: (text) => {
                  const inputEl = activeSession ? inputRefsMap.current.get(activeSession) : null;
                  if (inputEl) {
                    const quote = `> ${text.replace(/\n/g, '\n> ')}\n`;
                    inputEl.textContent = (inputEl.textContent || '') + quote;
                    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                    inputEl.focus();
                  }
                },
                t: trans,
                updatePanelProps: updatePinnedPanelProps,
              };
              return (
                <SidebarPinnedPanel
                  key={panel.id}
                  panel={panel}
                  height={height}
                  onUnpin={() => unpinPanel(panel)}
                  onResize={(h) => savePinnedPanelHeight(panel.id, h)}
                  ctx={ctx}
                />
              );
            })}
          </Sidebar>
        </>
      )}

      {/* Sidebar — server list (mobile only; desktop uses ServerIconBar) */}
      <aside class={`sidebar${!isMobile ? ' sidebar-desktop-hidden' : ''}`}>
        <div class="sidebar-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>IM.codes</span>
          <span style={{ display: 'flex', gap: '4px' }}>
            {isAdmin && (
              <button
                onClick={() => setShowAdminPage(true)}
                title="Admin"
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: '2px 4px', color: '#94a3b8' }}
              >&#x1f6e1;</button>
            )}
            <button
              onClick={() => setShowSettingsPage(true)}
              title="Settings"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: '2px 4px', color: '#94a3b8' }}
            >&#x2699;</button>
          </span>
        </div>
        <div class="server-list">
          {servers.map((server) => {
            const online = isServerOnline(server);
            return (
              <button
                key={server.id}
                class={`server-item${server.id === selectedServerId ? ' active' : ''}${online ? '' : ' offline'}`}
                onClick={() => handleSelectServer(server.id, server.name)}
                onContextMenu={(e) => { e.preventDefault(); setServerCtxMenu({ server, x: e.clientX, y: e.clientY }); }}
              >
                <span class="server-item-dot" style={{ color: online ? '#4ade80' : '#475569' }}>
                  {online ? '●' : '○'}
                </span>
                {server.name}
              </button>
            );
          })}
          {servers.length === 0 && (
            <div style={{ padding: '12px 16px', fontSize: 12, color: '#475569' }}>No devices</div>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {daemonStats && connected && (
          <div class="sidebar-stats">
            {daemonStats.daemonVersion && (
              <div class="sidebar-stats-row">
                {/* Tooltip surfaces the full version (incl. dev counter) for support. */}
                <span style={{ color: '#94a3b8' }} title={`Daemon v${daemonStats.daemonVersion}`}>
                  Daemon v{formatDaemonVersionShort(daemonStats.daemonVersion)}
                </span>
              </div>
            )}
            <div class="sidebar-stats-row">
              <span style={{ color: daemonStats.cpu > 80 ? '#f87171' : daemonStats.cpu > 50 ? '#fbbf24' : '#4ade80' }}>
                CPU {daemonStats.cpu}%
              </span>
              <span style={{ color: '#a78bfa' }}>
                Load {daemonStats.load1}
              </span>
            </div>
            <div class="sidebar-stats-row">
              <span style={{ color: '#60a5fa' }}>
                Mem {(() => { const gb = daemonStats.memUsed / (1024 ** 3); return gb >= 1 ? `${gb.toFixed(1)}G` : `${(daemonStats.memUsed / (1024 ** 2)).toFixed(0)}M`; })()}/{(() => { const gb = daemonStats.memTotal / (1024 ** 3); return gb >= 1 ? `${gb.toFixed(1)}G` : `${(daemonStats.memTotal / (1024 ** 2)).toFixed(0)}M`; })()}
              </span>
              <span style={{ color: '#94a3b8' }}>
                {(() => { const s = daemonStats.uptime; const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); return d > 0 ? `${d}d ${h}h` : `${h}h`; })()}
              </span>
            </div>
          </div>
        )}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #334155' }}>
          <div style={{ fontSize: 10, color: '#475569', marginBottom: 8, textAlign: 'center' }}>
            {(() => { try { const d = new Date(__BUILD_TIME__); return `Build: ${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; } catch { return ''; } })()}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <LanguageSwitcher />
          </div>
          <button class="btn btn-secondary" style={{ width: '100%', fontSize: 11 }} onClick={handleLogout}>
            Log Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main class="main">
        {!selectedServerId && !manualDashboard && (!serversLoaded || autoEnteringRecent || servers.length > 0) ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', flexDirection: 'column', gap: 12 }}>
            <div class="spinner" />
            <div>{trans('common.loading')}</div>
          </div>
        ) : !selectedServerId ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <Suspense fallback={<div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>Loading...</div>}>
              <DashboardPage onSelectServer={handleSelectServer} onLogout={handleLogout} onServersLoaded={setServers} />
            </Suspense>
          </div>
        ) : (
          <>
            {/* Mobile-only server switcher */}
            <div class="mobile-server-bar">
              <button class="mobile-sidebar-toggle" onClick={() => setMobileSidebarOpen(true)}>≡</button>
              <div class="mobile-server-switcher-wrap">
                <button
                  class="mobile-server-btn"
                  onClick={() => setShowMobileServerMenu((o) => !o)}
                >
                  {resolvedSelectedServerName ?? 'Server'} ▾
                </button>
                {showMobileServerMenu && (
                  <>
                  <div class="mobile-server-menu">
                    <button class="mobile-server-menu-item" onClick={() => { setShowMobileServerMenu(false); handleBackToDashboard(); }}>
                      ← Home
                    </button>
                    {isNative() && (
                      <button class="mobile-server-menu-item mobile-server-menu-change" onClick={() => { setShowMobileServerMenu(false); handleChangeServer(); }}>
                        ⇄ Switch Cloud Server
                      </button>
                    )}
                    {servers.map((s) => {
                      const online = isServerOnline(s);
                      return (
                        <button
                          key={s.id}
                          class={`mobile-server-menu-item${s.id === selectedServerId ? ' active' : ''}`}
                          onClick={() => { handleSelectServer(s.id, s.name); setShowMobileServerMenu(false); }}
                        >
                          <span style={{ color: online ? '#4ade80' : '#475569' }}>{online ? '●' : '○'}</span>
                          {' '}{s.name}
                        </button>
                      );
                    })}
                    <div style={{ padding: '6px 12px', borderTop: '1px solid #334155' }}>
                      <LanguageSwitcher />
                    </div>
                  </div>
                  </>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {activeSession && (
                  <button class="view-toggle" title="Files" onClick={() => setShowMobileFileBrowser((o) => !o)} style={{ position: 'relative' }}>
                    📁
                    {gitChangesCount > 0 && <span class="file-badge">{gitChangesCount}</span>}
                  </button>
                )}
                <button class="view-toggle" title={trans('localWebPreview.title')} onClick={() => setShowDesktopLocalWebPreview((o) => !o)} style={{ position: 'relative' }}>
                  🌐
                </button>
                {!isTransportSession && (
                  <button class="view-toggle" data-onboarding="view-toggle" onClick={toggleViewMode}>
                    {viewMode === 'chat' ? '⌨' : '💬'}
                  </button>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0, lineHeight: 1.2 }}>
                  <span class={`badge ${daemonBadgeState === 'online' ? 'badge-online' : daemonBadgeState === 'connecting' ? 'badge-connecting' : 'badge-offline'}`} style={{ fontSize: 10 }}>
                    {daemonBadgeState === 'online'
                      ? '● Online'
                      : daemonBadgeState === 'connecting'
                        ? (<><span class="connecting-dot" />{' Connecting'}</>)
                        : (<><span class="connecting-dot" />{' Daemon Offline'}</>)}
                  </span>
                  <span style={{ fontSize: 9, color: '#475569' }}>
                    {(() => { try { const d = new Date(__BUILD_TIME__); return `v${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; } catch { return ''; } })()}
                  </span>
                </div>
              </div>
            </div>
            {showMobileServerMenu && <div class="mobile-server-backdrop" onClick={() => setShowMobileServerMenu(false)} />}

            <SessionTabs
              sessions={sessions}
              activeSession={activeSession}
              connected={connected}
              latencyMs={latencyMs}
              idleAlerts={idleAlerts}
              p2pSessionLabels={p2pSessionLabels}
              onAlertDismiss={(name) => setIdleAlerts((prev) => { const s = new Set(prev); s.delete(name); return s; })}
              onSelect={(name) => { setActiveSession(name); setIdleAlerts((prev) => { const s = new Set(prev); s.delete(name); return s; }); }}
              onNewSession={() => setShowNewSession(true)}
              onStopProject={handleStopProject}
              onRestartProject={handleRestartProject}
              renameRequest={renameRequest}
              onRenameHandled={() => setRenameRequest(null)}
              onRenameSession={handleRenameSession}
              sessionsLoaded={sessionsLoaded}
            />

            {/* Desktop local preview shortcut — available even before a session is active */}
            {!isMobile && selectedServerId && !resolvedActiveSessionExists && (
              <div class="desktop-view-toggle">
                <button
                  class="view-toggle"
                  title={trans('localWebPreview.title')}
                  onClick={() => setShowDesktopLocalWebPreview((o) => !o)}
                  style={{ position: 'relative' }}
                >
                  🌐
                </button>
              </div>
            )}

            {/* Desktop view mode toggle — mobile uses the one in mobile-server-bar */}
            {!isMobile && resolvedActiveSessionExists && (
              <div class="desktop-view-toggle">
                <button class="view-toggle" title={trans('picker.files')} onClick={() => setShowDesktopFileBrowser(o => !o)} style={{ position: 'relative' }}>
                  📁
                  {gitChangesCount > 0 && <span class="file-badge">{gitChangesCount}</span>}
                </button>
                <button
                  class="view-toggle"
                  title={trans('localWebPreview.title')}
                  onClick={() => setShowDesktopLocalWebPreview((o) => !o)}
                  style={{ position: 'relative' }}
                >
                  🌐
                </button>
                {!isTransportSession && (
                  <button class="view-toggle" data-onboarding="view-toggle" onClick={toggleViewMode}>
                    {viewMode === 'chat' ? '⌨ Terminal' : '💬 Chat'}
                  </button>
                )}
              </div>
            )}

            {/* Session panes: all sessions kept alive (terminal views persist), show/hide per active */}
            {sessions.map((s) => (
              <ErrorBoundary key={`eb-${s.name}`}>
              <SessionPane
                key={s.name}
                serverId={selectedServerId ?? ''}
                session={s}
                sessions={sessions}
                subSessions={subSessionsSlim}
                ws={wsRef.current}
                connected={connected}
                isActive={s.name === activeSession}
                viewMode={(viewModes[s.name] ?? defaultViewMode) as ViewMode}
                quickData={quickData}
                detectedModel={detectedModels.get(s.name)}
                onFitFn={(fn) => { termFitFnsRef.current.set(s.name, fn); }}
                onScrollBottomFn={(fn) => { termScrollFnsRef.current.set(s.name, fn); }}
                onFocusFn={(fn) => { termFocusFnsRef.current.set(s.name, fn); }}
                onChatScrollFn={(fn) => { chatScrollFnsRef.current.set(s.name, fn); }}
                onInputRef={(el) => { if (el) inputRefsMap.current.set(s.name, el); else inputRefsMap.current.delete(s.name); }}
                onDiff={(apply) => registerDiffApplyer(s.name, apply)}
                onHistory={(apply) => registerHistoryApplyer(s.name, apply)}
                onStopProject={handleStopProject}
                onRenameSession={() => setRenameRequest(s.name)}
                onSettings={() => setSettingsTarget({ sessionName: s.name, label: s.label || '', description: s.description || '', cwd: s.projectDir || '', type: s.agentType || '', parentSession: null, transportConfig: s.transportConfig ?? null })}
                onTransportConfigSaved={(transportConfig) => {
                  setSessions((prev) => prev.map((session) => (
                    session.name === s.name ? { ...session, transportConfig } : session
                  )));
                }}
                onAfterAction={focusTerminal}
                mobileFileBrowserOpen={s.name === activeSession ? showMobileFileBrowser : false}
                onMobileFileBrowserClose={() => setShowMobileFileBrowser(false)}
                pendingPrefillText={pendingPrefills[s.name] ?? null}
                onPendingPrefillApplied={() => setPendingPrefills((prev) => {
                  if (!(s.name in prev)) return prev;
                  const next = { ...prev };
                  delete next[s.name];
                  return next;
                })}
              />
              </ErrorBoundary>
            ))}

            {!resolvedActiveSessionExists && !sessionsLoaded && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', flexDirection: 'column', gap: 12 }}>
                <div class="spinner" />
                <div>{connected ? 'Waiting for daemon...' : 'Connecting...'}</div>
              </div>
            )}
            {!resolvedActiveSessionExists && sessionsLoaded && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', flexDirection: 'column', gap: 12 }}>
                <div style={{ fontSize: 32 }}>⌨</div>
                <div>Select a session or start a new one</div>
                <button class="btn btn-primary" onClick={() => setShowNewSession(true)}>
                  + New Session
                </button>
              </div>
            )}

            {/* Desktop floating file browser */}
            {!isMobile && showDesktopFileBrowser && wsRef.current && activeSessionInfo && (
              <FloatingPanel id="filebrowser" title={`📁 ${trans('picker.files')}`} onClose={() => setShowDesktopFileBrowser(false)} onPin={() => pinPanel('filebrowser', { sessionName: activeSession, projectDir: activeSessionInfo?.projectDir, serverId: selectedServerId }, () => setShowDesktopFileBrowser(false))} pinTooltip={trans('sidebar.pin_to_sidebar')} defaultW={420} defaultH={500} zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.fileBrowser, 5020)} onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.fileBrowser)}>
                <FileBrowser
                  ws={wsRef.current}
                  serverId={selectedServerId}
                  mode="file-multi"
                  layout="panel"
                  initialPath={activeSessionInfo.projectDir ?? '~'}
                  changesRootPath={activeSessionInfo.projectDir ?? undefined}
                  hideFooter={false}
                  onConfirm={(paths) => {
                    const cwd = activeSessionInfo.projectDir;
                    const rel = cwd
                      ? paths.map((p) => '@' + (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p) + ' ')
                      : paths.map((p) => '@' + p + ' ');
                    const inputEl = activeSession ? inputRefsMap.current.get(activeSession) : null;
                    if (inputEl) {
                      inputEl.textContent = (inputEl.textContent || '') + rel.join('');
                      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                      inputEl.focus();
                    }
                  }}
                  onClose={() => setShowDesktopFileBrowser(false)}
                />
              </FloatingPanel>
            )}

            {/* Desktop floating local web preview */}
            {showDesktopLocalWebPreview && selectedServerId && (
              <FloatingPanel
                id={`local-web-preview-${selectedServerId}`}
                title={trans('localWebPreview.title')}
                onClose={() => setShowDesktopLocalWebPreview(false)}
                onPin={
                  localWebPreviewPort.trim() && /^\d+$/.test(localWebPreviewPort.trim())
                    ? () => pinPanel(
                        LOCAL_WEB_PREVIEW_PANEL_TYPE,
                        { serverId: selectedServerId, port: localWebPreviewPort.trim(), path: normalizeLocalWebPreviewPath(localWebPreviewPath) },
                        () => setShowDesktopLocalWebPreview(false),
                      )
                    : undefined
                }
                pinTooltip={trans('sidebar.pin_to_sidebar')}
                defaultW={860}
                defaultH={640}
                zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.localWebPreview(selectedServerId), 5030)}
                onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.localWebPreview(selectedServerId))}
              >
                <LocalWebPreviewPanel
                  serverId={selectedServerId}
                  port={localWebPreviewPort}
                  path={localWebPreviewPath}
                  onDraftChange={({ port, path }) => {
                    setLocalWebPreviewPort(port);
                    setLocalWebPreviewPath(path);
                  }}
                />
              </FloatingPanel>
            )}

            {/* Sub-session bar — hidden on desktop when sidebar is expanded (SessionTree shows sub-sessions there) */}
            {selectedServerId && (
              <SubSessionBar
                subSessions={visibleSubSessions}
                openIds={openSubIds}
                idleFlashTokens={idleFlashTokens}
                onOpen={toggleSubSession}
                onClose={closeSubSession}
                onRestart={restartSubSession}
                onNew={() => setShowSubDialog(true)}
                onViewDiscussions={() => { setDiscussionInitialId(null); setShowDiscussionsPage(true); }}
                onViewDiscussion={(fileId) => { setDiscussionInitialId(fileId); setShowDiscussionsPage(true); }}
                discussions={discussions.filter((d) => d.state !== 'done')}
                onStopDiscussion={(id) => {
                  if (id.startsWith('p2p_')) {
                    // P2P runs use p2p.cancel with the actual run ID (strip p2p_ prefix)
                    wsRef.current?.send({ type: 'p2p.cancel', runId: id.slice(4) });
                    // Remove from UI immediately
                    setDiscussions((prev) => prev.filter((d) => d.id !== id));
                  } else {
                    wsRef.current?.discussionStop(id);
                  }
                }}
                ws={wsRef.current}
                connected={connected}
                onDiff={registerDiffApplyer}
                onHistory={registerHistoryApplyer}
                serverId={selectedServerId}
                onViewRepo={() => setShowRepoPage(true)}
                onViewCron={() => setShowCronManager(true)}
                subUsages={subUsages}
                focusedSubId={focusedSubId}
                quickData={quickData}
                sessions={sessions}
                allSubSessions={subSessionsSlim}
                p2pSessionLabels={p2pSessionLabels}
                onSubTransportConfigSaved={(subId, transportConfig) => updateSubLocal(subId, { transportConfig })}
              />
            )}
          </>
        )}
      </main>

      {/* Mobile sidebar overlay — always mounted so pinned panels stay alive, shown/hidden via CSS */}
      {isMobile && selectedServerId && (
        <div ref={sidebarOverlayRef} class={`mobile-sidebar-overlay${mobileSidebarOpen ? ' open' : ''}`} onPointerDown={(e) => { if (e.target === e.currentTarget) closeSidebar(); }}>
          <div ref={sidebarPanelRef} class="mobile-sidebar-panel">
            <div class="mobile-sidebar-header">
              <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0' }}>IM.codes</span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                  class="mobile-sidebar-hdr-btn"
                  onClick={() => { handleBackToDashboard(); closeSidebar(); }}
                  title="Home"
                >🏠</button>
                <button
                  class="mobile-sidebar-hdr-btn"
                  onClick={() => { setShowSettingsPage(true); closeSidebar(); }}
                  title="Settings"
                >⚙</button>
                <button
                  class="mobile-sidebar-hdr-btn"
                  onClick={() => {
                    setSharedContextManagementProps((prev) => ({ ...prev, serverId: selectedServerId }));
                    setShowSharedContextManagement(true);
                    closeSidebar();
                  }}
                  title={trans('sharedContext.management.title')}
                >CTX</button>
                <button
                  class="mobile-sidebar-hdr-btn"
                  onClick={() => {
                    setShowSharedContextDiagnostics(true);
                    closeSidebar();
                  }}
                  title={trans('sharedContext.diagnostics.title')}
                >DBG</button>
                <button
                  class={`mobile-sidebar-hdr-btn${mobileHideServerBar ? '' : ' active'}`}
                  onClick={() => setMobileHideServerBar((p) => { const v = !p; localStorage.setItem('mobile_hide_server_bar', v ? '1' : ''); return v; })}
                  title="Server bar"
                >≡</button>
                <button
                  class={`mobile-sidebar-hdr-btn${mobileHideTabBar ? '' : ' active'}`}
                  onClick={() => setMobileHideTabBar((p) => { const v = !p; localStorage.setItem('mobile_hide_tab_bar', v ? '1' : ''); return v; })}
                  title="Session tabs"
                >⊞</button>
                <button class="mobile-sidebar-close" onClick={() => closeSidebar()}>✕</button>
              </div>
            </div>
            <div class="mobile-sidebar-body">
              <ErrorBoundary>
              {/* Server switcher — collapsible via sidebar toggle */}
              {!mobileHideServerBar && (
                <div style={{ padding: '8px 12px', borderBottom: '1px solid #1e293b' }}>
                  {servers.map((s) => {
                    const online = isServerOnline(s);
                    return (
                      <button
                        key={s.id}
                        class={`server-item${s.id === selectedServerId ? ' active' : ''}${online ? '' : ' offline'}`}
                        onClick={() => { handleSelectServer(s.id, s.name); closeSidebar(); }}
                      >
                        <span class="server-item-dot" style={{ color: online ? '#4ade80' : '#475569' }}>
                          {online ? '●' : '○'}
                        </span>
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Session tree — collapsible via sidebar toggle */}
              {!mobileHideTabBar && <SessionTree
                serverId={selectedServerId}
                sessions={sessions}
                subSessions={subSessions}
                activeSession={activeSession}
                unreadCounts={unreadCounts}
                idleFlashTokens={idleFlashTokens}
                p2pSessionLabels={p2pSessionLabels}
                onSelectSession={(name) => {
                  setActiveSession(name);
                  setIdleAlerts((prev) => { const s = new Set(prev); s.delete(name); return s; });
                  closeSidebar();
                }}
                onSelectSubSession={(sub) => {
                  if (sub.parentSession && sub.parentSession !== activeSession) {
                    setActiveSession(sub.parentSession, { keepSubWindows: true });
                  }
                  toggleSubSession(sub.id);
                  closeSidebar();
                }}
                onNewSession={() => { setShowNewSession(true); closeSidebar(); }}
                onNewSubSession={() => { setShowSubDialog(true); closeSidebar(); }}
              />}
              {/* P2P ring progress */}
              {discussions.filter((d) => d.state === 'running' || d.state === 'setup').filter((d) => d.id.startsWith('p2p_')).map((d) => (
                <P2pRingProgress
                  key={d.id}
                  completedRounds={Math.max(0, d.currentRound - 1)}
                  totalRounds={d.maxRounds}
                  completedHops={d.completedHops}
                  totalHops={d.totalHops}
                  activeHop={d.activeHop}
                  activeRoundHop={d.activeRoundHop}
                  status={d.state}
                  modeKey={d.modeKey}
                  onClick={() => { setDiscussionInitialId(d.fileId ?? null); setShowDiscussionsPage(true); closeSidebar(); }}
                />
              ))}
              {/* Pinned panels — same as desktop sidebar */}
              {visiblePinnedPanels.map((panel) => {
                const height = pinnedPanelHeights[panel.id] ?? 240;
                const ctx: PanelRenderContext = {
                  ws: wsRef.current,
                  connected,
                  serverId: selectedServerId ?? '',
                  subSessions,
                  inputRefsMap,
                  onPreviewFile: (request) => { handlePreviewFileRequest({ ...request, sourcePreviewLive: false }); closeSidebar(); },
                  onPreviewStateChange: handlePreviewStateChange,
                  activeSession,
                  activeProjectDir: activeSessionInfo?.projectDir,
                  sessions,
                  servers: servers.map(s => ({ id: s.id, name: s.name })),
                  onQuote: (text) => {
                    const inputEl = activeSession ? inputRefsMap.current.get(activeSession) : null;
                    if (inputEl) {
                      const quote = `> ${text.replace(/\n/g, '\n> ')}\n`;
                      inputEl.textContent = (inputEl.textContent || '') + quote;
                      inputEl.focus();
                    }
                  },
                  t: trans,
                  updatePanelProps: updatePinnedPanelProps,
                };
                return (
                  <SidebarPinnedPanel
                    key={panel.id}
                    panel={panel}
                    height={height}
                    onUnpin={() => unpinPanel(panel)}
                    onResize={(h) => savePinnedPanelHeight(panel.id, h)}
                    ctx={ctx}
                  />
                );
              })}
              </ErrorBoundary>
            </div>
            {/* Footer */}
            <div class="mobile-sidebar-footer">
              {daemonStats && connected && (
                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span title={daemonStats.daemonVersion ? `v${daemonStats.daemonVersion}` : undefined}>
                    {daemonStats.daemonVersion && <span>v{formatDaemonVersionShort(daemonStats.daemonVersion)} · </span>}
                    CPU {daemonStats.cpu}% · Load {daemonStats.load1}
                  </span>
                  <button
                    style={{ fontSize: 10, color: '#38bdf8', background: 'none', border: '1px solid #334155', borderRadius: 4, padding: '1px 5px', cursor: 'pointer' }}
                    onClick={async () => {
                      try {
                        const snapshot = watchProjectionStore.getSnapshot();
                        const WB = await import('./plugins/watch-bridge.js');
                        await WB.default.syncSnapshot({ context: {
                          ...snapshot,
                          generatedAt: Date.now(),
                          apiKey: getApiKey() ?? '',
                        } } as any);
                        const mainCount = snapshot.sessions.filter(s => !s.isSubSession).length;
                        const subCount = snapshot.sessions.filter(s => s.isSubSession).length;
                        const withParent = snapshot.sessions.filter(s => s.parentSessionName).length;
                        alert(`${mainCount} main + ${subCount} sub (${withParent} with parent)\nhook has ${subSessions.length}`);
                      } catch (e: any) {
                        alert('Error: ' + (e?.message ?? e));
                      }
                    }}
                  >⌚</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <LanguageSwitcher />
                <span style={{ fontSize: 10, color: '#475569' }}>
                  {(() => { try { const d = new Date(__BUILD_TIME__); return `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; } catch { return ''; } })()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDiscussionsPage && selectedServerId && (
        <FloatingPanel id="discussions" title={trans('p2p.discussions.title')} onClose={() => { setShowDiscussionsPage(false); setDiscussionInitialId(null); }} defaultW={800} defaultH={600} zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.discussions, 5040)} onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.discussions)}>
          <Suspense fallback={<div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>Loading...</div>}>
            <DiscussionsPage
              ws={wsRef.current}
              onBack={() => { setShowDiscussionsPage(false); setDiscussionInitialId(null); }}
              initialSelectedId={discussionInitialId}
              liveDiscussions={discussions}
              onStopDiscussion={(id) => {
                if (id.startsWith('p2p_')) {
                  wsRef.current?.send({ type: 'p2p.cancel', runId: id.slice(4) });
                  setDiscussions((prev) => prev.filter((d) => d.id !== id));
                } else {
                  wsRef.current?.discussionStop(id);
                }
              }}
            />
          </Suspense>
        </FloatingPanel>
      )}

      {showRepoPage && wsRef.current && activeSessionInfo?.projectDir && (
        <FloatingPanel id="repo" title="Repository" onClose={() => setShowRepoPage(false)} onPin={() => pinPanel('repopage', { sessionName: activeSession, projectDir: activeSessionInfo?.projectDir, serverId: selectedServerId }, () => setShowRepoPage(false))} pinTooltip={trans('sidebar.pin_to_sidebar')} defaultW={800} defaultH={600} zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.repo, 5050)} onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.repo)}>
          <RepoPage ws={wsRef.current} projectDir={activeSessionInfo.projectDir} onBack={() => setShowRepoPage(false)} onCiEvent={(run) => {
            const id = Date.now();
            const icon = run.status === 'success' ? '✅' : '❌';
            const failurePath = [run.failedJobName, run.failedStepName].filter(Boolean).join(' → ');
            const message = failurePath || run.conclusion || run.status;
            setToasts((prev) => [...prev, {
              id,
              sessionName: activeSession ?? '',
              project: `${icon} ${run.name}`,
              kind: 'notification',
              title: run.status === 'success' ? 'CI Passed' : 'CI Failed',
              message,
              openRepoLatest: run.status === 'failure',
              failedJobName: run.failedJobName,
              failedStepName: run.failedStepName,
            }]);
            setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
          }} focusLatestAction={repoFocusLatestAction} />
        </FloatingPanel>
      )}

      {/* Floating file preview — one file at a time, opened from pinned file browser */}
      {previewFileRequest && wsRef.current && (
        <FloatingPanel
          id="file-preview"
          title={previewFileRequest.path.split(/[/\\]/).pop() ?? 'Preview'}
          onClose={() => setPreviewFileRequest(null)}
          defaultW={700}
          defaultH={500}
          zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.filePreview, 5060)}
          onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.filePreview)}
        >
          <FileBrowser
            key={previewFileRequest.rootPath ?? getFilePreviewInitialPath(previewFileRequest)}
            ws={wsRef.current}
            serverId={selectedServerId ?? undefined}
            mode="file-single"
            layout="panel"
            initialPath={getFilePreviewInitialPath(previewFileRequest)}
            changesRootPath={previewFileRequest.rootPath}
            initialPreview={previewFileRequest.preview ?? previewFileCache[previewFileRequest.path]?.preview}
            autoPreviewPath={previewFileRequest.path}
            autoPreviewPreferDiff={!!previewFileRequest.preferDiff}
            skipAutoPreviewIfLoading={!!previewFileRequest.sourcePreviewLive}
            hideFooter
            onPreviewStateChange={handlePreviewStateChange}
            onConfirm={() => {}}
            onClose={() => setPreviewFileRequest(null)}
          />
        </FloatingPanel>
      )}

      {showSettingsPage && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#0a0e1a', paddingTop: 'var(--sat, 0px)' }}>
          <SettingsPage
            displayName={userDisplayName}
            username={username}
            hasPassword={userHasPassword}
            serverUrl={auth?.baseUrl ?? nativeServerUrl}
            onBack={() => setShowSettingsPage(false)}
            onDisplayNameChanged={(name) => setUserDisplayName(name)}
            onUserAuthUpdated={(next) => {
              setUsername(next.username);
              setUserHasPassword(next.hasPassword);
            }}
          />
        </div>
      )}

      {showCronManager && selectedServerId && (() => {
        const cronProject = sessions.find(s => s.name === activeSession)?.project;
        return cronProject ? (
          <FloatingPanel
            id="cron"
            title={trans('cron.title')}
            onClose={() => setShowCronManager(false)}
            onPin={() => pinPanel('cronmanager', { sessionName: activeSession, projectName: cronProject, serverId: selectedServerId }, () => setShowCronManager(false))}
            pinTooltip={trans('sidebar.pin_to_sidebar')}
            defaultW={700}
            defaultH={550}
            zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.cronManager, 5070)}
            onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.cronManager)}
          >
            <CronManager
              serverId={selectedServerId}
              projectName={cronProject}
              sessions={sessions}
              subSessions={subSessionsSlim}
              activeSession={activeSession}
              onNavigateSession={(sessionName, quote) => {
                setShowCronManager(false);
                window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { session: sessionName, quote } }));
              }}
              onBack={() => setShowCronManager(false)}
              onViewDiscussion={(fileId) => { setDiscussionInitialId(fileId); setShowDiscussionsPage(true); }}
              servers={servers.map(s => ({ id: s.id, name: s.name }))}
            />
          </FloatingPanel>
        ) : null;
      })()}

      {showSharedContextManagement && (
        <FloatingPanel
          id="shared-context-management"
          title={trans('sharedContext.management.title')}
          onClose={() => setShowSharedContextManagement(false)}
          onPin={() => pinPanel(
            SHARED_CONTEXT_MANAGEMENT_PANEL_TYPE,
            { ...sharedContextManagementProps, serverId: selectedServerId },
            () => setShowSharedContextManagement(false),
          )}
          pinTooltip={trans('sidebar.pin_to_sidebar')}
          defaultW={760}
          defaultH={620}
          zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.sharedContextManagement, 5080)}
          onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.sharedContextManagement)}
        >
          <SharedContextManagementPanel
            enterpriseId={typeof sharedContextManagementProps.enterpriseId === 'string' ? sharedContextManagementProps.enterpriseId : undefined}
            serverId={selectedServerId ?? undefined}
            ws={wsRef.current}
            onEnterpriseChange={(enterpriseId) => setSharedContextManagementProps((prev) => ({ ...prev, enterpriseId, serverId: selectedServerId }))}
          />
        </FloatingPanel>
      )}

      {showSharedContextDiagnostics && (
        <FloatingPanel
          id="shared-context-diagnostics"
          title={trans('sharedContext.diagnostics.title')}
          onClose={() => setShowSharedContextDiagnostics(false)}
          onPin={() => pinPanel(
            SHARED_CONTEXT_DIAGNOSTICS_PANEL_TYPE,
            { ...sharedContextDiagnosticsProps, serverId: selectedServerId },
            () => setShowSharedContextDiagnostics(false),
          )}
          pinTooltip={trans('sidebar.pin_to_sidebar')}
          defaultW={760}
          defaultH={620}
          zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.sharedContextDiagnostics, 5090)}
          onFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.sharedContextDiagnostics)}
        >
          <ContextDiagnosticsPanel
            enterpriseId={sharedContextDiagnosticsProps.enterpriseId}
            canonicalRepoId={sharedContextDiagnosticsProps.canonicalRepoId}
            workspaceId={sharedContextDiagnosticsProps.workspaceId}
            enrollmentId={sharedContextDiagnosticsProps.enrollmentId}
            language={sharedContextDiagnosticsProps.language}
            filePath={sharedContextDiagnosticsProps.filePath}
            onStateChange={(next) => setSharedContextDiagnosticsProps(next)}
          />
        </FloatingPanel>
      )}

      {showAdminPage && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#0a0e1a', paddingTop: 'var(--sat, 0px)' }}>
          <AdminPage onBack={() => setShowAdminPage(false)} />
        </div>
      )}

      {showNewUserGuidePrompt && (
        <div class="ask-dialog-overlay" onClick={() => { setShowNewUserGuidePrompt(false); setGuidePromptSnoozed(true); }}>
          <div class="ask-dialog onboarding-choice-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="onboarding-choice-title">{trans('onboarding.prompt.title')}</div>
            <div class="onboarding-choice-body">
              <div>{trans('onboarding.prompt.body_1')}</div>
              <div>{trans('onboarding.prompt.body_2')}</div>
            </div>
            <div class="ask-actions onboarding-choice-actions">
              <button
                class="ask-btn-submit"
                onClick={() => {
                  setShowNewUserGuidePrompt(false);
                  setGuidePromptSnoozed(false);
                  setShowNewUserGuide(true);
                }}
              >
                {trans('onboarding.prompt.beginner')}
              </button>
              <button
                class="ask-btn-cancel"
                onClick={() => {
                  setNewUserGuidePref((prev) => ({ ...prev, pending: false, disabled: true }));
                  setShowNewUserGuidePrompt(false);
                  setGuidePromptSnoozed(true);
                }}
              >
                {trans('onboarding.prompt.expert')}
              </button>
              <button
                class="ask-btn-cancel"
                onClick={() => {
                  setShowNewUserGuidePrompt(false);
                  setGuidePromptSnoozed(true);
                }}
              >
                {trans('onboarding.prompt.later')}
              </button>
            </div>
          </div>
        </div>
      )}

      <NewUserGuide
        open={showNewUserGuide}
        steps={newUserGuideSteps}
        onClose={() => {
          setShowNewUserGuide(false);
          setGuidePromptSnoozed(true);
        }}
        onComplete={() => {
          setShowNewUserGuide(false);
          setGuidePromptSnoozed(true);
          setNewUserGuidePref((prev) => ({ ...prev, pending: false, completed: true }));
        }}
      />

      {showNewSession && (
        <NewSessionDialog
          ws={wsRef.current}
          onClose={() => setShowNewSession(false)}
          onSessionStarted={(name) => { setActiveSession(name); setShowNewSession(false); }}
          isProviderConnected={isProviderConnected}
        />
      )}

      {/* Sub-session windows (floating) — only show if not pinned */}
      {visibleSubSessions.filter((sub) => isMobile || !pinnedPanels.some((p) => p.type === 'subsession' && p.props?.sessionName === sub.sessionName)).map((sub) => {
        const isOpen = openSubIds.has(sub.id);
        return (
          <div key={sub.id} style={{ display: isOpen ? 'contents' : 'none' }}>
            <SubSessionWindow
              sub={sub}
              ws={wsRef.current}
              connected={connected}
              active={isOpen}
              idleFlashToken={idleFlashTokens.get(sub.sessionName) ?? 0}
              onDiff={registerDiffApplyer}
              onHistory={registerHistoryApplyer}
              onMinimize={() => setOpenSubIds((prev) => { const s = new Set(prev); s.delete(sub.id); return s; })}
              onClose={() => closeSubSession(sub.id)}
              onRestart={() => restartSubSession(sub.id)}
              onRename={() => {
                const label = prompt('Rename sub-session:', sub.label ?? '');
                if (label !== null) renameSubSession(sub.id, label);
              }}
              onSettings={() => setSettingsTarget({ sessionName: sub.sessionName, subId: sub.id, label: sub.label || '', description: sub.description || '', cwd: sub.cwd || '', type: sub.type, parentSession: sub.parentSession, transportConfig: sub.transportConfig ?? null })}
              onTransportConfigSaved={(transportConfig) => updateSubLocal(sub.id, { transportConfig })}
              zIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.subSession(sub.id), 6000)}
              onFocus={() => bringSubToFront(sub.id)}
              desktopFileBrowserZIndex={getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.subsessionFileBrowser(sub.id), getDesktopWindowZIndex(DESKTOP_WINDOW_IDS.subSession(sub.id), 6000) + 1)}
              onDesktopFileBrowserOpen={() => {
                ensureDesktopWindow(DESKTOP_WINDOW_IDS.subSession(sub.id), {
                  kind: DESKTOP_WINDOW_KINDS.subSession,
                  subId: sub.id,
                  serverId: sub.serverId ?? selectedServerId ?? undefined,
                });
                ensureDesktopWindow(DESKTOP_WINDOW_IDS.subsessionFileBrowser(sub.id), {
                  kind: DESKTOP_WINDOW_KINDS.subsessionFileBrowser,
                  parentId: DESKTOP_WINDOW_IDS.subSession(sub.id),
                  subId: sub.id,
                  serverId: sub.serverId ?? selectedServerId ?? undefined,
                }, { bringToFront: true });
              }}
              onDesktopFileBrowserFocus={() => bringDesktopWindowToFront(DESKTOP_WINDOW_IDS.subsessionFileBrowser(sub.id))}
              onDesktopFileBrowserClose={() => removeDesktopWindow(DESKTOP_WINDOW_IDS.subsessionFileBrowser(sub.id))}
              onPin={(vm) => pinPanel('subsession', { sessionName: sub.sessionName, viewMode: vm, label: sub.label, serverId: selectedServerId }, () => setOpenSubIds((prev) => { const s = new Set(prev); s.delete(sub.id); return s; }))}
              sessions={sessions}
              subSessions={subSessionsSlim}
              serverId={selectedServerId ?? undefined}
              inP2p={p2pSessionLabels.has(sub.sessionName)}
              pendingPrefillText={pendingPrefills[sub.sessionName] ?? null}
              onPendingPrefillApplied={() => setPendingPrefills((prev) => {
                if (!(sub.sessionName in prev)) return prev;
                const next = { ...prev };
                delete next[sub.sessionName];
                return next;
              })}
            />
          </div>
        );
      })}

      {showDiscussionDialog && wsRef.current && (
        <StartDiscussionDialog
          ws={wsRef.current}
          defaultCwd={activeSessionInfo?.projectDir}
          existingSessions={subSessions.map((s): SubSessionOption => ({
            sessionName: s.sessionName,
            label: s.label ?? '',
            type: s.type,
          }))}
          savedPrefs={discussionPrefs}
          onClose={() => setShowDiscussionDialog(false)}
        />
      )}

      {pendingQuestion && wsRef.current && (
        <AskQuestionDialog
          pending={pendingQuestion}
          onSubmit={(answer) => {
            wsRef.current?.askAnswer(pendingQuestion.sessionName, answer);
            setPendingQuestion(null);
          }}
          onDismiss={() => setPendingQuestion(null)}
        />
      )}

      {serverCtxMenu && (
        <ServerContextMenu
          x={serverCtxMenu.x}
          y={serverCtxMenu.y}
          onRename={() => handleRenameServer(serverCtxMenu.server)}
          onUpgrade={() => handleUpgradeDaemon(serverCtxMenu.server)}
          onUpgradeAll={servers.length > 1 ? handleUpgradeAll : undefined}
          onDelete={() => setDeleteTarget(serverCtxMenu.server)}
          onClose={() => setServerCtxMenu(null)}
        />
      )}

      {deleteTarget && (
        <DeleteServerDialog
          serverName={deleteTarget.name}
          onConfirm={() => handleDeleteServer(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {showSubDialog && (
        <StartSubSessionDialog
          ws={wsRef.current}
          defaultCwd={activeSessionInfo?.projectDir}
          isProviderConnected={isProviderConnected}
          getRemoteSessions={getRemoteSessions}
          refreshSessions={refreshSessions}
          onStart={async (type, shellBin, cwd, label, extra) => {
            setShowSubDialog(false);
            const sub = await createSubSession(type, shellBin, cwd, label, extra);
            if (sub) {
              setOpenSubIds((prev) => new Set([...prev, sub.id]));
              bringSubToFront(sub.id);
            }
          }}
          onClose={() => setShowSubDialog(false)}
        />
      )}

      {settingsTarget && selectedServerId && (
        <SessionSettingsDialog
          serverId={selectedServerId}
          sessionName={settingsTarget.sessionName}
          subSessionId={settingsTarget.subId}
          label={settingsTarget.label}
          description={settingsTarget.description}
          cwd={settingsTarget.cwd}
          type={settingsTarget.type}
          parentSession={settingsTarget.parentSession}
          transportConfig={settingsTarget.transportConfig}
          ws={wsRef.current}
          onClose={() => setSettingsTarget(null)}
          onSaved={(fields) => {
            if (settingsTarget.subId) {
              // Sub-session: update local state to reflect saved label/description/cwd
              updateSubLocal(settingsTarget.subId, {
                type: fields.type !== undefined ? fields.type : undefined,
                runtimeType: fields.type !== undefined ? getSessionRuntimeType(fields.type) : undefined,
                label: fields.label !== undefined ? (fields.label ?? null) : undefined,
                description: fields.description !== undefined ? (fields.description ?? null) : undefined,
                cwd: fields.cwd !== undefined ? (fields.cwd ?? null) : undefined,
                transportConfig: fields.transportConfig !== undefined ? fields.transportConfig : undefined,
              });
            } else {
              // Main session: update sessions list with saved fields
              setSessions((prev) => prev.map((s) => {
                if (s.name !== settingsTarget.sessionName) return s;
                const updated = { ...s };
                if (fields.type !== undefined) {
                  updated.agentType = fields.type;
                  updated.runtimeType = getSessionRuntimeType(fields.type);
                }
                if (fields.label !== undefined) updated.label = fields.label ?? null;
                if (fields.description !== undefined) updated.description = fields.description ?? null;
                if (fields.cwd !== undefined) updated.projectDir = fields.cwd ?? updated.projectDir;
                if (fields.transportConfig !== undefined) updated.transportConfig = fields.transportConfig;
                return updated;
              }));
            }
          }}
        />
      )}

      {/* Toasts: idle completions + CC notifications */}
      {toasts.length > 0 && (
        <div class="toast-container">
          {toasts.map((t) => (
            <div
              key={t.id}
              class={`toast toast-${t.kind}`}
              onClick={() => {
                if (t.openRepoLatest) {
                  const focus = {
                    token: Date.now(),
                    failedJobName: t.failedJobName,
                    failedStepName: t.failedStepName,
                  };
                  localStorage.setItem('repo-active-tab', 'actions');
                  if (t.sessionName && t.sessionName !== activeSession) {
                    setPendingRepoToastSession({ sessionName: t.sessionName, focus });
                  } else {
                    setShowRepoPage(true);
                    setRepoFocusLatestAction(focus);
                  }
                }
                if (t.sessionName) {
                  // Reuse push notification navigation — handles sub-sessions, parent activation, etc.
                  window.dispatchEvent(new CustomEvent('deck:navigate', {
                    detail: { session: t.sessionName, serverId: selectedServerId },
                  }));
                }
                setIdleAlerts((prev) => { const s = new Set(prev); s.delete(t.sessionName); return s; });
                setToasts((prev) => prev.filter((x) => x.id !== t.id));
              }}
            >
              <span class="toast-icon">{t.kind === 'idle' ? '✓' : '🔔'}</span>
              <span class="toast-body">
                {t.kind === 'idle' ? (
                  <><strong>{t.project}</strong> {trans('toast.finished')}</>
                ) : (
                  <><strong>{t.title || t.project}</strong>{t.message ? <> — {t.message}</> : null}</>
                )}
              </span>
              <button class="toast-close" onClick={(e) => { e.stopPropagation(); setToasts((prev) => prev.filter((x) => x.id !== t.id)); }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
