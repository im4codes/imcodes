import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachWindowSecurityGuards,
  isAllowedExternalUrl,
  isAllowedPermissionRequest,
  isSameActiveOrigin,
  isSameOriginDownloadUrl,
  MAIN_WINDOW_WEB_PREFERENCES,
  type WindowOpenHandlerResult,
} from '../src/security.js';
import { ServerStore } from '../src/servers.js';
import { createPcAppShell, type ShellWindowLike } from '../src/shell.js';
import { currentTrustedOrigin, TrustedOriginController, UntrustedOriginError } from '../src/trust.js';

class MockWebContents extends EventEmitter {
  url = '';
  destroyed = false;
  windowOpenHandler: ((details: { url: string }) => WindowOpenHandlerResult) | null = null;
  session: MockSession;

  constructor(session: MockSession) {
    super();
    this.session = session;
  }

  getURL(): string {
    return this.url;
  }

  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void {
    this.windowOpenHandler = handler;
  }
}

class MockSession extends EventEmitter {
  permissionRequestHandler:
    | ((
        wc: unknown,
        permission: string,
        callback: (granted: boolean) => void,
        details?: { requestingUrl?: string },
      ) => void)
    | null = null;
  permissionCheckHandler:
    | ((wc: unknown, permission: string, requestingOrigin: string) => boolean)
    | null = null;
  clearedOrigins: Array<string | undefined> = [];

  setPermissionRequestHandler(
    handler: (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details?: { requestingUrl?: string },
    ) => void,
  ): void {
    this.permissionRequestHandler = handler;
  }

  setPermissionCheckHandler(
    handler: (wc: unknown, permission: string, requestingOrigin: string) => boolean,
  ): void {
    this.permissionCheckHandler = handler;
  }

  async clearStorageData(options?: { origin?: string }): Promise<void> {
    this.clearedOrigins.push(options?.origin);
  }
}

describe('PC App V1 exact-origin trust and §4.7 security guards', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-sec-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('enforces §4.7 webPreferences security baseline with zero preload/nodeIntegration', () => {
    expect(MAIN_WINDOW_WEB_PREFERENCES).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    });
    expect('preload' in MAIN_WINDOW_WEB_PREFERENCES).toBe(false);
  });

  it('currentTrustedOrigin fails closed for destroyed, empty, about:blank, untrusted, or mismatched origins', () => {
    const trusted = new Set(['https://app.im.codes', 'https://alt.im.codes']);
    const session = new MockSession();
    const wc = new MockWebContents(session);
    const win = {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      loadURL: async (u: string) => {
        wc.url = u;
      },
      webContents: wc,
    };

    // Missing / destroyed / empty / about:blank / data: / malformed
    expect(currentTrustedOrigin(null, 'https://app.im.codes', trusted)).toBeNull();
    wc.url = '';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();
    wc.url = 'about:blank';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();
    wc.url = 'data:text/html,<h1>hi</h1>';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();
    wc.url = 'not-a-url';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();

    // Attacker HTTPS site never passes even if window navigated there
    wc.url = 'https://attacker.example/login';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();
    expect(currentTrustedOrigin(win, 'https://attacker.example', trusted)).toBeNull();

    // Different saved server origin fails when activeOrigin is app.im.codes
    wc.url = 'https://alt.im.codes/home';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();

    // Exact active + trusted origin passes
    wc.url = 'https://app.im.codes/session/42';
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBe('https://app.im.codes');

    // Destroyed window fails closed even with valid URL
    win.destroyed = true;
    expect(currentTrustedOrigin(win, 'https://app.im.codes', trusted)).toBeNull();
  });

  it('selectServer updates activeOrigin BEFORE win.loadURL and rejects untrusted origins', async () => {
    const store = new ServerStore(tempDir);
    store.addServer('https://app.im.codes');
    const session = new MockSession();
    const wc = new MockWebContents(session);

    let activeAtLoadStart: string | null = null;
    let trustedDuringLoad: string | null = null;
    const win = {
      isDestroyed: () => false,
      webContents: wc,
      loadURL: vi.fn(async (url: string) => {
        activeAtLoadStart = controller.getActiveOrigin();
        wc.url = `${url}/`;
        trustedDuringLoad = controller.currentTrustedOrigin();
      }),
    };

    const controller = new TrustedOriginController(store, () => win);
    const navEvents: string[] = [];
    controller.onDidNavigateTrustedOrigin((origin) => navEvents.push(origin));

    await expect(controller.selectServer('https://attacker.example')).rejects.toBeInstanceOf(UntrustedOriginError);
    expect(controller.getActiveOrigin()).toBeNull();
    expect(win.loadURL).not.toHaveBeenCalled();

    const selected = await controller.selectServer('https://app.im.codes/ignored-path');
    expect(selected).toBe('https://app.im.codes');
    expect(activeAtLoadStart).toBe('https://app.im.codes');
    expect(trustedDuringLoad).toBe('https://app.im.codes');
    expect(store.getLastOrigin()).toBe('https://app.im.codes');

    // did-navigate seam triggers only when currentTrustedOrigin() is valid
    wc.url = 'https://attacker.example';
    expect(controller.notifyDidNavigate()).toBeNull();
    expect(navEvents).toEqual([]);

    wc.url = 'https://app.im.codes/dashboard';
    expect(controller.notifyDidNavigate()).toBe('https://app.im.codes');
    expect(navEvents).toEqual(['https://app.im.codes']);

    await controller.clearSession();
    expect(session.clearedOrigins).toEqual(['https://app.im.codes']);
  });

  it('blocks cross-origin navigation/redirect, denies new windows, isolates external docs allowlist, gates permissions, and requires save prompt for downloads', async () => {
    const trusted = new Set(['https://app.im.codes', 'https://second.im.codes']);
    let activeOrigin: string | null = 'https://app.im.codes';
    const session = new MockSession();
    const wc = new MockWebContents(session);
    wc.url = 'https://app.im.codes/home';

    const openExternal = vi.fn();
    const promptSavePathSync = vi.fn();

    attachWindowSecurityGuards({
      webContents: wc,
      session,
      getActiveOrigin: () => activeOrigin,
      getTrustedOrigins: () => trusted,
      getCurrentTrustedOrigin: () =>
        currentTrustedOrigin(
          { isDestroyed: () => false, loadURL: () => {}, webContents: wc },
          activeOrigin,
          trusted,
        ),
      openExternal,
      promptSavePathSync,
    });

    // 1. will-navigate & will-redirect: same activeOrigin allowed, cross-origin blocked
    for (const eventName of ['will-navigate', 'will-redirect'] as const) {
      const sameEv = { preventDefault: vi.fn() };
      wc.emit(eventName, sameEv, 'https://app.im.codes/settings?tab=keys');
      expect(sameEv.preventDefault).not.toHaveBeenCalled();

      const otherSavedEv = { preventDefault: vi.fn() };
      wc.emit(eventName, otherSavedEv, 'https://second.im.codes/home');
      expect(otherSavedEv.preventDefault).toHaveBeenCalledTimes(1);

      const attackerEv = { preventDefault: vi.fn() };
      wc.emit(eventName, attackerEv, 'https://evil.example/oauth');
      expect(attackerEv.preventDefault).toHaveBeenCalledTimes(1);

      const fileEv = { preventDefault: vi.fn() };
      wc.emit(eventName, fileEv, 'file:///etc/passwd');
      expect(fileEv.preventDefault).toHaveBeenCalledTimes(1);
    }

    // 2. will-attach-webview always prevented
    const webviewEv = { preventDefault: vi.fn() };
    wc.emit('will-attach-webview', webviewEv);
    expect(webviewEv.preventDefault).toHaveBeenCalledTimes(1);

    // 3. setWindowOpenHandler always denies BrowserWindow creation and routes safe http/https URLs to openExternal
    expect(wc.windowOpenHandler).toBeTruthy();
    for (const safeUrl of [
      'https://docs.im.codes/guide',
      'https://example.com/article?id=42#top',
      'http://localhost:3000/preview',
      'https://second.im.codes/admin',
    ]) {
      openExternal.mockClear();
      expect(wc.windowOpenHandler!({ url: safeUrl })).toEqual({ action: 'deny' });
      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(openExternal).toHaveBeenCalledWith(safeUrl);
    }

    openExternal.mockClear();
    for (const blockedUrl of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'smb://fileserver/share',
      'ftp://example.com/file',
      'https://user:pass@example.com/secret',
      'http://user@example.com/',
      'https://imcodes-welcome.local/add?url=https%3A%2F%2Fevil.example',
      'https://imcodes-prompt.local/submit?url=https%3A%2F%2Fevil.example',
      'not-a-valid-url',
      '',
    ]) {
      expect(wc.windowOpenHandler!({ url: blockedUrl })).toEqual({ action: 'deny' });
    }
    expect(openExternal).not.toHaveBeenCalled();

    // 4. Permission gate: clipboard/media allowed only for active + trusted origin
    const askPermission = (perm: string, requestingUrl: string, targetWc: unknown = wc) => {
      let granted = false;
      session.permissionRequestHandler!(
        targetWc,
        perm,
        (res) => {
          granted = res;
        },
        { requestingUrl },
      );
      return granted;
    };

    expect(askPermission('clipboard-read', 'https://app.im.codes/chat')).toBe(true);
    expect(askPermission('clipboard-sanitized-write', 'https://app.im.codes/chat')).toBe(true);
    expect(askPermission('media', 'https://app.im.codes/call')).toBe(true);
    expect(askPermission('fullscreen', 'https://app.im.codes/remote-desktop')).toBe(true);
    expect(askPermission('keyboardLock', 'https://app.im.codes/remote-desktop')).toBe(true);
    expect(askPermission('notifications', 'https://app.im.codes/chat')).toBe(true);
    expect(askPermission('geolocation', 'https://app.im.codes/chat')).toBe(false);
    expect(askPermission('openExternal', 'https://app.im.codes/chat')).toBe(false);
    expect(askPermission('clipboard-read', 'https://evil.example/frame')).toBe(false);
    expect(askPermission('notifications', 'https://evil.example/frame')).toBe(false);
    expect(askPermission('notifications', 'https://second.im.codes/frame')).toBe(false);
    expect(askPermission('fullscreen', 'https://evil.example/frame')).toBe(false);
    expect(askPermission('keyboardLock', 'https://evil.example/frame')).toBe(false);
    expect(askPermission('fullscreen', 'https://second.im.codes/frame')).toBe(false);
    expect(askPermission('keyboardLock', 'https://second.im.codes/frame')).toBe(false);
    expect(askPermission('clipboard-read', 'https://app.im.codes/chat', {})).toBe(false);
    expect(askPermission('notifications', 'https://app.im.codes/chat', {})).toBe(false);
    expect(askPermission('fullscreen', 'https://app.im.codes/remote-desktop', {})).toBe(false);
    expect(askPermission('keyboardLock', 'https://app.im.codes/remote-desktop', {})).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'clipboard-read', 'https://app.im.codes')).toBe(true);
    expect(session.permissionCheckHandler!(wc, 'notifications', 'https://app.im.codes')).toBe(true);
    expect(session.permissionCheckHandler!(wc, 'fullscreen', 'https://app.im.codes')).toBe(true);
    expect(session.permissionCheckHandler!(wc, 'keyboardLock', 'https://app.im.codes')).toBe(true);
    expect(session.permissionCheckHandler!(wc, 'notifications', 'https://evil.example')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'notifications', 'https://second.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'fullscreen', 'https://evil.example')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'keyboardLock', 'https://evil.example')).toBe(false);
    expect(session.permissionCheckHandler!({}, 'notifications', 'https://app.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!({}, 'fullscreen', 'https://app.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!({}, 'keyboardLock', 'https://app.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'geolocation', 'https://app.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'openExternal', 'https://app.im.codes')).toBe(false);

    // If active page drifted to untrusted URL, permission check/request denies
    wc.url = 'https://evil.example';
    expect(askPermission('clipboard-read', 'https://app.im.codes/chat')).toBe(false);
    expect(askPermission('fullscreen', 'https://app.im.codes/remote-desktop')).toBe(false);
    expect(askPermission('keyboardLock', 'https://app.im.codes/remote-desktop')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'fullscreen', 'https://app.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'keyboardLock', 'https://app.im.codes')).toBe(false);
    wc.url = 'https://app.im.codes/home';

    // On welcome screen (activeOrigin === null), fullscreen & keyboardLock are denied
    const prevActiveOrigin = activeOrigin;
    activeOrigin = null;
    wc.url = 'data:text/html;charset=utf-8,<h1>welcome</h1>';
    expect(askPermission('fullscreen', 'https://app.im.codes/remote-desktop')).toBe(false);
    expect(askPermission('keyboardLock', 'https://app.im.codes/remote-desktop')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'fullscreen', 'https://app.im.codes')).toBe(false);
    expect(session.permissionCheckHandler!(wc, 'keyboardLock', 'https://app.im.codes')).toBe(false);
    activeOrigin = prevActiveOrigin;
    wc.url = 'https://app.im.codes/home';

    // 5. will-download synchronously prompts save dialog & cancels on reject/cancel
    promptSavePathSync.mockReturnValueOnce('/Users/tester/Downloads/report.pdf');
    const dlOkEv = { preventDefault: vi.fn() };
    const itemOk = {
      getFilename: () => '../../report.pdf',
      cancel: vi.fn(),
      setSavePath: vi.fn(),
    };
    session.emit('will-download', dlOkEv, itemOk, wc);
    expect(promptSavePathSync).toHaveBeenCalledWith('report.pdf');
    expect(itemOk.setSavePath).toHaveBeenCalledWith('/Users/tester/Downloads/report.pdf');
    expect(itemOk.cancel).not.toHaveBeenCalled();
    expect(dlOkEv.preventDefault).not.toHaveBeenCalled();

    promptSavePathSync.mockReturnValueOnce(undefined);
    const dlCancelEv = { preventDefault: vi.fn() };
    const itemCancel = {
      getFilename: () => 'secret.txt',
      cancel: vi.fn(),
      setSavePath: vi.fn(),
    };
    session.emit('will-download', dlCancelEv, itemCancel, wc);
    expect(dlCancelEv.preventDefault).toHaveBeenCalledTimes(1);
    expect(itemCancel.cancel).toHaveBeenCalledTimes(1);
    expect(itemCancel.setSavePath).not.toHaveBeenCalled();

    // Helper checks
    expect(isSameActiveOrigin('https://app.im.codes/x', activeOrigin, trusted)).toBe(true);
    activeOrigin = null;
    expect(isSameActiveOrigin('https://app.im.codes/x', activeOrigin, trusted)).toBe(false);
    expect(isAllowedExternalUrl('https://github.com/im4codes/imcodes')).toBe(true);
    expect(isAllowedExternalUrl('http://127.0.0.1:8080/app')).toBe(true);
    expect(isAllowedExternalUrl('https://arbitrary-external-site.org/path')).toBe(true);
    expect(isAllowedExternalUrl('https://user:pass@github.com/im4codes')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('https://imcodes-welcome.local/connect')).toBe(false);
    expect(isAllowedExternalUrl('https://evil.example', ['docs.im.codes'])).toBe(false);
    expect(
      isAllowedPermissionRequest({
        requestingUrl: 'https://app.im.codes',
        permission: 'clipboard-read',
        activeOrigin: 'https://app.im.codes',
        trustedOrigins: trusted,
        currentPageOrigin: 'https://app.im.codes',
      }),
    ).toBe(true);
    expect(
      isAllowedPermissionRequest({
        requestingUrl: 'https://app.im.codes',
        permission: 'fullscreen',
        activeOrigin: 'https://app.im.codes',
        trustedOrigins: trusted,
        currentPageOrigin: 'https://app.im.codes',
      }),
    ).toBe(true);
    expect(
      isAllowedPermissionRequest({
        requestingUrl: 'https://app.im.codes',
        permission: 'keyboardLock',
        activeOrigin: 'https://app.im.codes',
        trustedOrigins: trusted,
        currentPageOrigin: 'https://app.im.codes',
      }),
    ).toBe(true);
    expect(
      isAllowedPermissionRequest({
        requestingUrl: 'https://app.im.codes',
        permission: 'fullscreen',
        activeOrigin: null,
        trustedOrigins: trusted,
        currentPageOrigin: 'https://app.im.codes',
      }),
    ).toBe(false);
  });

  it('invokes onTrustedMediaPermissionRequest only for active trusted origin media permission requests', async () => {
    const trusted = new Set(['https://app.im.codes']);
    let activeOrigin: string | null = 'https://app.im.codes';
    const session = new MockSession();
    const wc = new MockWebContents(session);
    wc.url = 'https://app.im.codes/home';
    const onTrustedMediaPermissionRequest = vi.fn(async () => true);

    attachWindowSecurityGuards({
      webContents: wc,
      session,
      getActiveOrigin: () => activeOrigin,
      getTrustedOrigins: () => trusted,
      getCurrentTrustedOrigin: () =>
        currentTrustedOrigin(
          { isDestroyed: () => false, loadURL: () => {}, webContents: wc },
          activeOrigin,
          trusted,
        ),
      openExternal: vi.fn(),
      promptSavePathSync: vi.fn(),
      onTrustedMediaPermissionRequest,
    });

    const askAsync = (perm: string, requestingUrl: string, targetWc: unknown = wc) =>
      new Promise<boolean>((resolve) => {
        session.permissionRequestHandler!(targetWc, perm, resolve, { requestingUrl });
      });

    expect(await askAsync('media', 'https://app.im.codes/session')).toBe(true);
    expect(onTrustedMediaPermissionRequest).toHaveBeenCalledTimes(1);

    onTrustedMediaPermissionRequest.mockResolvedValueOnce(false);
    expect(await askAsync('media', 'https://app.im.codes/session')).toBe(false);

    // Untrusted frame / drifted URL / non-media must NEVER trigger onTrustedMediaPermissionRequest
    onTrustedMediaPermissionRequest.mockClear();
    expect(await askAsync('media', 'https://evil.example/mic')).toBe(false);
    expect(await askAsync('media', 'https://app.im.codes/session', {})).toBe(false);
    expect(await askAsync('clipboard-read', 'https://app.im.codes/session')).toBe(true);
    activeOrigin = null;
    wc.url = 'data:text/html,<h1>welcome</h1>';
    expect(await askAsync('media', 'https://app.im.codes/session')).toBe(false);
    expect(onTrustedMediaPermissionRequest).not.toHaveBeenCalled();
  });

  it('rejects imcodes-welcome.local virtual actions when a remote origin is loaded or current page is not data:text/html welcome', async () => {
    const session = new MockSession();
    const wc = new MockWebContents(session);
    const win: ShellWindowLike = {
      isDestroyed: () => false,
      loadURL: async (nextUrl: string) => {
        wc.url = nextUrl;
      },
      on: vi.fn(),
      webContents: Object.assign(wc, {
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        toggleDevTools: vi.fn(),
      }),
    };

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      bindDeps: { imcodesHome: tempDir },
      createMainWindow: () => win,
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });

    await shell.addAndSelectServer('https://app.im.codes');
    expect(shell.controller.getActiveOrigin()).toBe('https://app.im.codes');
    expect(wc.url).toBe('https://app.im.codes');

    // Loaded remote web page must NEVER trigger welcome /add, /connect, or /remove
    for (const virtualUrl of [
      'https://imcodes-welcome.local/add?url=https%3A%2F%2Fevil.example&label=Evil',
      'https://imcodes-welcome.local/connect?url=https%3A%2F%2Fevil.example',
      'https://imcodes-welcome.local/remove?url=https%3A%2F%2Fapp.im.codes',
    ]) {
      const ev = { preventDefault: vi.fn() };
      wc.emit('will-navigate', ev, virtualUrl);
      expect(ev.preventDefault).toHaveBeenCalled();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(shell.controller.getActiveOrigin()).toBe('https://app.im.codes');
    expect(shell.store.list().map((s) => s.origin)).toEqual(['https://app.im.codes']);

    // Even if activeOrigin is cleared, non-data:text/html URL must NOT trigger welcome actions
    shell.controller.clearActiveOrigin();
    wc.url = 'https://evil.example/spoof';
    const spoofEv = { preventDefault: vi.fn() };
    wc.emit('will-navigate', spoofEv, 'https://imcodes-welcome.local/add?url=https%3A%2F%2Fevil.example');
    expect(spoofEv.preventDefault).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(shell.store.list().map((s) => s.origin)).toEqual(['https://app.im.codes']);
  });

  it('routes external http/https windowOpenHandler links from createPcAppShell to openExternal while keeping virtual and unsafe URLs blocked', async () => {
    const session = new MockSession();
    const wc = new MockWebContents(session);
    const openExternal = vi.fn();
    const win: ShellWindowLike = {
      isDestroyed: () => false,
      loadURL: async (nextUrl: string) => {
        wc.url = nextUrl;
      },
      on: vi.fn(),
      webContents: Object.assign(wc, {
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        toggleDevTools: vi.fn(),
      }),
    };

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      bindDeps: { imcodesHome: tempDir },
      createMainWindow: () => win,
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal,
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });

    await shell.ensureWindow();
    expect(wc.windowOpenHandler).toBeTruthy();

    expect(wc.windowOpenHandler!({ url: 'https://example.org/docs' })).toEqual({ action: 'deny' });
    expect(wc.windowOpenHandler!({ url: 'http://127.0.0.1:4321/preview' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenNthCalledWith(1, 'https://example.org/docs');
    expect(openExternal).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4321/preview');

    openExternal.mockClear();
    expect(wc.windowOpenHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(wc.windowOpenHandler!({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(wc.windowOpenHandler!({ url: 'https://imcodes-welcome.local/connect?url=https%3A%2F%2Fapp.im.codes' })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();

    // imcodes-welcome.local virtual navigation on the welcome page still connects normally
    const connectEv = { preventDefault: vi.fn() };
    wc.emit('will-navigate', connectEv, 'https://imcodes-welcome.local/connect?url=https%3A%2F%2Fapp.im.codes');
    expect(connectEv.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(shell.controller.getActiveOrigin()).toBe('https://app.im.codes'));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('allows same-origin popout windows with enforced webPreferences and wires did-create-window security guards onto child windows', async () => {
    const session = new MockSession();
    const wc = new MockWebContents(session);
    const openExternal = vi.fn();
    const preloadPath = '/tmp/mock-preload.cjs';
    const win: ShellWindowLike = {
      isDestroyed: () => false,
      loadURL: async (nextUrl: string) => {
        wc.url = nextUrl;
      },
      on: vi.fn(),
      webContents: Object.assign(wc, {
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        toggleDevTools: vi.fn(),
      }),
    };

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      preloadPath,
      bindDeps: { imcodesHome: tempDir },
      createMainWindow: () => win,
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal,
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });

    await shell.addAndSelectServer('https://app.im.codes');
    await shell.addAndSelectServer('https://second.im.codes');
    await shell.selectServer('https://app.im.codes');
    expect(wc.windowOpenHandler).toBeTruthy();

    // Same active origin (e.g. Remote Desktop "Open in new window") returns allow with strict webPreferences
    const sameOriginResult = wc.windowOpenHandler!({
      url: 'https://app.im.codes/#/remote-desktop/srv_1',
    });
    expect(sameOriginResult).toEqual({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 560,
        autoHideMenuBar: true,
        webPreferences: {
          ...MAIN_WINDOW_WEB_PREFERENCES,
          preload: preloadPath,
        },
      },
    });
    expect(openExternal).not.toHaveBeenCalled();

    // Another saved origin or external URL still returns deny and routes external http/https to openExternal
    expect(wc.windowOpenHandler!({ url: 'https://second.im.codes/home' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://second.im.codes/home');
    openExternal.mockClear();
    expect(wc.windowOpenHandler!({ url: 'https://docs.im.codes/guide' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://docs.im.codes/guide');

    // Emit did-create-window and verify child BrowserWindow enforces navigation, webview, and window-open guards
    openExternal.mockClear();
    const childWc = new MockWebContents(session);
    childWc.url = 'https://app.im.codes/#/remote-desktop/srv_1';
    wc.emit('did-create-window', { webContents: childWc });
    expect(childWc.windowOpenHandler).toBeTruthy();

    // Child window allows same-active-origin navigation/redirect, blocks untrusted origins, other saved servers, file:, and imcodes-welcome.local
    for (const eventName of ['will-navigate', 'will-redirect'] as const) {
      const sameEv = { preventDefault: vi.fn() };
      childWc.emit(eventName, sameEv, 'https://app.im.codes/#/remote-desktop/srv_2');
      expect(sameEv.preventDefault).not.toHaveBeenCalled();

      for (const blockedTarget of [
        'https://evil.example/phish',
        'https://second.im.codes/home',
        'https://imcodes-welcome.local/add?url=https%3A%2F%2Fevil.example',
        'file:///etc/passwd',
      ]) {
        const blockedEv = { preventDefault: vi.fn() };
        childWc.emit(eventName, blockedEv, blockedTarget);
        expect(blockedEv.preventDefault).toHaveBeenCalledTimes(1);
      }
    }

    // Child window blocks webview attachment
    const childWebviewEv = { preventDefault: vi.fn() };
    childWc.emit('will-attach-webview', childWebviewEv);
    expect(childWebviewEv.preventDefault).toHaveBeenCalledTimes(1);

    // Child window preserves same-origin popout + external handoff rules
    expect(childWc.windowOpenHandler!({ url: 'https://app.im.codes/sub' })).toEqual({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1280,
        height: 800,
        minWidth: 800,
        minHeight: 560,
        autoHideMenuBar: true,
        webPreferences: {
          ...MAIN_WINDOW_WEB_PREFERENCES,
          preload: preloadPath,
        },
      },
    });
    expect(openExternal).not.toHaveBeenCalled();

    expect(childWc.windowOpenHandler!({ url: 'https://example.com/external' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/external');

    openExternal.mockClear();
    expect(childWc.windowOpenHandler!({ url: 'https://imcodes-welcome.local/connect' })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();

    // Child window created via did-create-window is allowed trusted Remote Desktop permissions while on active origin,
    // and loses them once destroyed or drifted
    expect(session.permissionCheckHandler!(childWc, 'fullscreen', 'https://app.im.codes')).toBe(true);
    expect(session.permissionCheckHandler!(childWc, 'keyboardLock', 'https://app.im.codes')).toBe(true);
    expect(session.permissionCheckHandler!(childWc, 'geolocation', 'https://app.im.codes')).toBe(false);
    childWc.url = 'https://evil.example/spoof';
    expect(session.permissionCheckHandler!(childWc, 'fullscreen', 'https://app.im.codes')).toBe(false);
    childWc.url = 'https://app.im.codes/#/remote-desktop/srv_1';
    childWc.emit('destroyed');
    expect(session.permissionCheckHandler!(childWc, 'fullscreen', 'https://app.im.codes')).toBe(false);
  });

  it('omits preload in same-origin overrideBrowserWindowOptions when shell has no preloadPath', async () => {
    const session = new MockSession();
    const wc = new MockWebContents(session);
    const win: ShellWindowLike = {
      isDestroyed: () => false,
      loadURL: async (nextUrl: string) => {
        wc.url = nextUrl;
      },
      on: vi.fn(),
      webContents: Object.assign(wc, {
        reload: vi.fn(),
        reloadIgnoringCache: vi.fn(),
        toggleDevTools: vi.fn(),
      }),
    };

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      bindDeps: { imcodesHome: tempDir },
      createMainWindow: () => win,
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });

    await shell.addAndSelectServer('https://app.im.codes');
    const result = wc.windowOpenHandler!({ url: 'https://app.im.codes/#/remote-desktop/srv_1' });
    expect(result.action).toBe('allow');
    if (result.action === 'allow') {
      expect(result.overrideBrowserWindowOptions?.webPreferences).toEqual(MAIN_WINDOW_WEB_PREFERENCES);
      expect('preload' in (result.overrideBrowserWindowOptions?.webPreferences ?? {})).toBe(false);
      expect('backgroundThrottling' in (result.overrideBrowserWindowOptions?.webPreferences ?? {})).toBe(false);
    }
  });

  it('disables backgroundThrottling on the main window only without altering MAIN_WINDOW_WEB_PREFERENCES', async () => {
    let capturedMainWebPreferences: Record<string, unknown> | undefined;
    const wc = {
      getURL: () => '',
      setWindowOpenHandler: vi.fn(),
      session: Object.assign(new EventEmitter(), { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      toggleDevTools: vi.fn(),
      on: vi.fn(),
    };

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      bindDeps: { imcodesHome: tempDir },
      createMainWindow: (opts) => {
        capturedMainWebPreferences = opts.webPreferences;
        return {
          isDestroyed: () => false,
          loadURL: async () => {},
          on: vi.fn(),
          webContents: wc,
        };
      },
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });

    await shell.addAndSelectServer('https://app.im.codes');
    expect(capturedMainWebPreferences).toEqual({
      ...MAIN_WINDOW_WEB_PREFERENCES,
      backgroundThrottling: false,
    });
    expect(MAIN_WINDOW_WEB_PREFERENCES).toEqual({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    });
  });

  it('routes same-origin /api/downloads/ URLs to openExternal and denies blank child windows while preserving popout windows and host allowlists', () => {
    const trusted = new Set(['https://app.im.codes']);
    const activeOrigin = 'https://app.im.codes';

    expect(isSameOriginDownloadUrl('https://app.im.codes/api/downloads/latest/desktop-mac', activeOrigin, trusted)).toBe(true);
    expect(isSameOriginDownloadUrl('https://app.im.codes/api/downloads/latest/android-with-fcm?channel=dev', activeOrigin, trusted)).toBe(true);
    expect(isSameOriginDownloadUrl('https://app.im.codes/api/downloads-other', activeOrigin, trusted)).toBe(false);
    expect(isSameOriginDownloadUrl('https://app.im.codes/#/remote-desktop/srv_1', activeOrigin, trusted)).toBe(false);
    expect(isSameOriginDownloadUrl('https://other.im.codes/api/downloads/latest/desktop-mac', activeOrigin, trusted)).toBe(false);

    const session = new MockSession();
    const wc = new MockWebContents(session);
    wc.url = 'https://app.im.codes/';
    const openExternal = vi.fn();

    attachWindowSecurityGuards({
      webContents: wc,
      session,
      getActiveOrigin: () => activeOrigin,
      getTrustedOrigins: () => trusted,
      getCurrentTrustedOrigin: () => activeOrigin,
      openExternal,
      promptSavePathSync: () => undefined,
    });

    const downloadUrl = 'https://app.im.codes/api/downloads/latest/desktop-mac';
    expect(wc.windowOpenHandler!({ url: downloadUrl })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(downloadUrl);

    // Embedded credentials are still rejected before openExternal
    openExternal.mockClear();
    expect(wc.windowOpenHandler!({ url: 'https://user:pass@app.im.codes/api/downloads/latest/desktop-mac' })).toEqual({
      action: 'deny',
    });
    expect(openExternal).not.toHaveBeenCalled();

    // Non-download same-origin popouts still open cleanly
    expect(wc.windowOpenHandler!({ url: 'https://app.im.codes/#/remote-desktop/srv_1' })).toMatchObject({
      action: 'allow',
    });
    expect(openExternal).not.toHaveBeenCalled();

    // Child windows inherit the same /api/downloads/ external handoff guard
    const childWc = new MockWebContents(session);
    childWc.url = 'https://app.im.codes/#/remote-desktop/srv_1';
    wc.emit('did-create-window', { webContents: childWc });
    expect(childWc.windowOpenHandler!({ url: downloadUrl })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(downloadUrl);

    // Explicit externalDocsHosts allowlist is never bypassed by same-origin /api/downloads/
    const restrictedSession = new MockSession();
    const restrictedWc = new MockWebContents(restrictedSession);
    restrictedWc.url = 'https://app.im.codes/';
    const restrictedOpenExternal = vi.fn();

    attachWindowSecurityGuards({
      webContents: restrictedWc,
      session: restrictedSession,
      getActiveOrigin: () => activeOrigin,
      getTrustedOrigins: () => trusted,
      getCurrentTrustedOrigin: () => activeOrigin,
      openExternal: restrictedOpenExternal,
      promptSavePathSync: () => undefined,
      externalDocsHosts: ['docs.im.codes'],
    });

    expect(restrictedWc.windowOpenHandler!({ url: downloadUrl })).toEqual({ action: 'deny' });
    expect(restrictedOpenExternal).not.toHaveBeenCalled();
  });
});
