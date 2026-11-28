/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { MyPrivateDevicePolicyResponse } from '../src/api.js';

const {
  apiFetchMock,
  discoverSharedEntriesMock,
  updatePolicyMock,
  activeUserRef,
} = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  discoverSharedEntriesMock: vi.fn(),
  updatePolicyMock: vi.fn(),
  activeUserRef: { current: 'user-a' },
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
    discoverSharedEntries: (...args: unknown[]) => discoverSharedEntriesMock(...args),
    updateMyServerPrivateDevicePolicy: (...args: unknown[]) => updatePolicyMock(...args),
    fetchMe: vi.fn(async () => ({ id: activeUserRef.current, is_admin: false, display_name: activeUserRef.current, username: activeUserRef.current, has_password: true })),
    getUserPref: vi.fn().mockResolvedValue(null),
    saveUserPref: vi.fn().mockResolvedValue(undefined),
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
    connect = vi.fn();
    disconnect = vi.fn();
    onMessage = vi.fn(() => () => {});
    onLatency = vi.fn(() => () => {});
    requestSessionList = vi.fn();
    getDaemonCapabilitySnapshot = vi.fn(() => null);
    onDaemonCapabilitySnapshot = vi.fn(() => () => {});
    p2pListDiscussions = vi.fn();
    p2pStatus = vi.fn();
    discussionList = vi.fn();
  },
}));

vi.mock('../src/pages/LoginPage.js', () => ({
  LoginPage: ({ onLoginSuccess }: { onLoginSuccess: (userId: string, url: string) => void }) => (
    <button
      type="button"
      data-testid="mock-login-user-b"
      onClick={() => {
        activeUserRef.current = 'user-b';
        onLoginSuccess('user-b', window.location.origin);
      }}
    >
      Login User B
    </button>
  ),
}));

vi.mock('../src/components/ApiKeyManager.js', () => ({ ApiKeyManager: () => null }));
vi.mock('../src/components/GettingStarted.js', () => ({ GettingStarted: () => null }));
vi.mock('../src/components/PasskeyManager.js', () => ({ PasskeyManager: () => null }));
vi.mock('../src/components/DeleteAccount.js', () => ({ DeleteAccount: () => null }));
vi.mock('../src/components/LanguageSwitcher.js', () => ({ LanguageSwitcher: () => null }));
vi.mock('../src/components/VoiceLanguageSwitcher.js', () => ({ VoiceLanguageSwitcher: () => null }));
vi.mock('../src/components/StartSubSessionDialog.js', () => ({ StartSubSessionDialog: () => null }));
vi.mock('../src/components/NewSessionDialog.js', () => ({ NewSessionDialog: () => null }));
vi.mock('../src/components/ShareSessionDialog.js', () => ({ ShareSessionDialog: () => null }));
vi.mock('../src/components/ServerContextMenu.js', () => ({ DeleteServerDialog: () => null, ServerContextMenu: () => null }));
vi.mock('../src/components/ControlledNodesPanel.js', () => ({ ControlledNodesPanel: () => null }));
vi.mock('../src/components/RemoteDesktopPanel.js', () => ({ RemoteDesktopPanel: () => null }));
vi.mock('../src/components/RemoteDesktopWorkspace.js', () => ({ RemoteDesktopWorkspace: () => null }));
vi.mock('../src/components/RemoteDesktopWall.js', () => ({ REMOTE_DESKTOP_WALL_WINDOW_ID: 'wall', RemoteDesktopWall: () => null }));
vi.mock('../src/components/FloatingPanel.js', () => ({ FloatingPanel: ({ children }: any) => <div>{children}</div> }));
vi.mock('../src/components/NewUserGuide.js', () => ({ NewUserGuide: () => null }));
vi.mock('../src/components/P2pRingProgress.js', () => ({ P2pRingProgress: () => null }));
vi.mock('../src/components/SidebarPinnedPanel.js', () => ({ SidebarPinnedPanel: () => null }));
vi.mock('../src/components/LocalWebPreviewPanel.js', () => ({ LocalWebPreviewPanel: () => null }));
vi.mock('../src/components/file-browser-lazy.js', () => ({ FileBrowser: () => null }));

describe('App private device policy account-switch isolation', () => {
  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, '', '/');
    localStorage.clear();
    sessionStorage.clear();
    activeUserRef.current = 'user-a';
    localStorage.setItem('rcc_auth', JSON.stringify({ userId: 'user-a', baseUrl: window.location.origin }));
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/auth/user/me') return { id: activeUserRef.current };
      if (path === '/api/auth/logout') return { ok: true };
      if (path === '/api/auth/keys') return { keys: [] };
      if (path === '/api/machines') return { machines: [] };
      if (path === '/api/server') {
        return {
          servers: [
            {
              id: 'srv-shared',
              name: 'Shared Host',
              status: 'online',
              lastHeartbeatAt: Date.now(),
              createdAt: 1,
              isOwner: false,
              blockMyPrivateDevices: false,
            },
          ],
        };
      }
      return {};
    });
    discoverSharedEntriesMock.mockImplementation(async () => [
      {
        id: `share-${activeUserRef.current}`,
        serverId: 'srv-shared',
        serverName: 'Shared Host',
        role: 'participant',
        status: 'active',
        blockMyPrivateDevices: false,
        targetLabel: 'Main Tab',
        target: { kind: 'main', serverId: 'srv-shared', sessionName: 'deck_shared_brain' },
        targetRef: 'srv-shared:deck_shared_brain',
        targetSessionName: 'deck_shared_brain',
        availability: 'available',
        historyCutoffAt: 0,
        expiresAt: null,
        serverStatus: 'online',
        lastHeartbeatAt: Date.now(),
      },
    ]);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createLinearGradient: () => ({ addColorStop: () => {} }),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('drops a stale PATCH response from account A after switching to account B sharing the same serverId', async () => {
    let resolveStalePatchA!: (val: MyPrivateDevicePolicyResponse) => void;
    updatePolicyMock.mockImplementationOnce(
      () => new Promise<MyPrivateDevicePolicyResponse>((resolve) => { resolveStalePatchA = resolve; }),
    );

    const { App } = await import('../src/app.js');
    render(<App />);

    // Account A loads Dashboard/SharedEntriesPanel and triggers PATCH -> stays pending
    await waitFor(() => {
      expect(document.querySelector('[data-testid="shared-private-policy-srv-shared"]')).not.toBeNull();
    });
    const checkboxA = document.querySelector('[data-testid="shared-private-policy-srv-shared"] input') as HTMLInputElement;
    expect(checkboxA.checked).toBe(false);
    fireEvent.click(checkboxA);
    await waitFor(() => {
      expect(updatePolicyMock).toHaveBeenCalledWith('srv-shared', true);
    });

    // Switch account: A logs out -> B logs in and loads the SAME srv-shared (blockMyPrivateDevices: false)
    const homeBtn = document.querySelector('button[title="common.home"]');
    if (homeBtn) fireEvent.click(homeBtn);
    const logoutBtn = await waitFor(() => screen.getByRole('button', { name: 'dashboard.logout' }), { timeout: 5000 });
    fireEvent.click(logoutBtn);
    const loginB = await waitFor(() => screen.getByTestId('mock-login-user-b'), { timeout: 5000 });
    fireEvent.click(loginB);

    await waitFor(() => {
      const cb = document.querySelector('[data-testid="shared-private-policy-srv-shared"] input') as HTMLInputElement | null;
      expect(cb).not.toBeNull();
      expect(cb!.checked).toBe(false);
    }, { timeout: 5000 });

    // Release delayed PATCH response from Account A with blockPrivateDevices: true
    resolveStalePatchA({ ok: true, serverId: 'srv-shared', blockPrivateDevices: true });
    await new Promise((r) => setTimeout(r, 30));

    // Account B's UI and hydrated server state MUST stay false!
    const checkboxB = document.querySelector('[data-testid="shared-private-policy-srv-shared"] input') as HTMLInputElement;
    expect(checkboxB.checked).toBe(false);
  }, 20_000);
});
