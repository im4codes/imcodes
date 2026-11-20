import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemOptionsLike } from '../src/menu.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from '../src/security.js';
import { buildWelcomeDataUrl, openAddServerPrompt } from '../src/server-prompt.js';
import { createPcAppShell, type ShellWindowLike } from '../src/shell.js';

function createFakeShellWindow(opts: {
  webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES;
  loadSpy?: (url: string) => Promise<void> | void;
}): ShellWindowLike & {
  emitter: EventEmitter;
  webContentsEmitter: EventEmitter;
  lastWebPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES;
} {
  const emitter = new EventEmitter();
  const webContentsEmitter = new EventEmitter();
  let url = '';
  let destroyed = false;

  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
  });

  const webContents = Object.assign(webContentsEmitter, {
    getURL: () => url,
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    toggleDevTools: vi.fn(),
    session,
  });

  return {
    emitter,
    webContentsEmitter,
    lastWebPreferences: opts.webPreferences,
    isDestroyed: () => destroyed,
    on: (event: 'closed', listener: () => void) => emitter.on(event, listener),
    loadURL: async (nextUrl: string) => {
      await opts.loadSpy?.(nextUrl);
      url = nextUrl;
    },
    webContents,
  };
}

function findMenuItem(items: MenuItemOptionsLike[], id: string): MenuItemOptionsLike | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.submenu) {
      const found = findMenuItem(item.submenu, id);
      if (found) return found;
    }
  }
  return undefined;
}

describe('PC App V1 shell lifecycle, server menu switcher, and sandboxed server prompt', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-shell-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads welcome page when no server saved, adds/switches/removes servers via menu, and enforces activeOrigin before loadURL', async () => {
    let latestMenu: MenuItemOptionsLike[] = [];
    const loadEvents: Array<{ url: string; activeOriginAtLoad: string | null }> = [];
    const bindFallbackCalls: Array<string | null> = [];
    const openExternal = vi.fn();
    let createdWin!: ReturnType<typeof createFakeShellWindow>;

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      createMainWindow: (opts) => {
        expect(opts.webPreferences).toEqual({
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
        });
        createdWin = createFakeShellWindow({
          webPreferences: opts.webPreferences,
          loadSpy: (u) => {
            loadEvents.push({ url: u, activeOriginAtLoad: shell.controller.getActiveOrigin() });
          },
        });
        return createdWin;
      },
      createPromptWindow: () => {
        throw new Error('not called when promptAddServer is stubbed');
      },
      setApplicationMenu: (template) => {
        latestMenu = template;
      },
      openExternal,
      showSaveDialogSync: vi.fn(() => undefined),
      showMessageBox: vi.fn(async () => ({ response: 1 })),
      promptAddServer: vi
        .fn()
        .mockResolvedValueOnce({ origin: 'https://prod.im.codes', label: 'Prod' })
        .mockResolvedValueOnce({ origin: 'http://localhost:3000', label: 'Local' }),
      onBindFallback: (origin) => {
        bindFallbackCalls.push(origin);
      },
    });

    // 1. Initial launch with empty server store -> welcome data URL, activeOrigin stays null
    await shell.ensureWindow();
    expect(shell.controller.getActiveOrigin()).toBeNull();
    expect(shell.controller.currentTrustedOrigin()).toBeNull();
    expect(loadEvents[0]?.url.startsWith('data:text/html')).toBe(true);
    expect(findMenuItem(latestMenu, 'server:none')?.enabled).toBe(false);
    expect(findMenuItem(latestMenu, 'server:bind-fallback')?.enabled).toBe(false);

    // 2. Add first server via menu -> sets activeOrigin BEFORE loadURL & checks radio item
    findMenuItem(latestMenu, 'server:add')?.click?.();
    await vi.waitFor(() => {
      expect(shell.controller.getActiveOrigin()).toBe('https://prod.im.codes');
    });
    expect(loadEvents.at(-1)).toEqual({
      url: 'https://prod.im.codes',
      activeOriginAtLoad: 'https://prod.im.codes',
    });
    expect(findMenuItem(latestMenu, 'server:https://prod.im.codes')?.checked).toBe(true);

    // 3. Add second server via menu, then switch back to first via menu radio click
    findMenuItem(latestMenu, 'server:add')?.click?.();
    await vi.waitFor(() => {
      expect(shell.controller.getActiveOrigin()).toBe('http://localhost:3000');
    });
    findMenuItem(latestMenu, 'server:https://prod.im.codes')?.click?.();
    await vi.waitFor(() => {
      expect(shell.controller.getActiveOrigin()).toBe('https://prod.im.codes');
      expect(findMenuItem(latestMenu, 'server:https://prod.im.codes')?.checked).toBe(true);
    });

    // 4. Phase B bind fallback hook receives exact currentTrustedOrigin
    findMenuItem(latestMenu, 'server:bind-fallback')?.click?.();
    expect(bindFallbackCalls).toEqual(['https://prod.im.codes']);

    // 5. Docs link in Help menu opens via strict allowlist
    findMenuItem(latestMenu, 'help:docs')?.click?.();
    expect(openExternal).toHaveBeenCalledWith('https://docs.im.codes');

    // 6. Remove active server falls back to remaining server; removing last returns to welcome page
    findMenuItem(latestMenu, 'remove:https://prod.im.codes')?.click?.();
    await vi.waitFor(() => {
      expect(shell.controller.getActiveOrigin()).toBe('http://localhost:3000');
    });
    findMenuItem(latestMenu, 'remove:http://localhost:3000')?.click?.();
    await vi.waitFor(() => {
      expect(shell.controller.getActiveOrigin()).toBeNull();
      expect(loadEvents.at(-1)?.url.startsWith('data:text/html')).toBe(true);
    });
  });

  it('reopens lastOrigin cleanly on next app startup with activeOrigin set prior to loadURL', async () => {
    const first = createPcAppShell({
      platform: 'win32',
      appName: 'IM.codes',
      userDataDir: tempDir,
      createMainWindow: (opts) => createFakeShellWindow({ webPreferences: opts.webPreferences }),
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });
    await first.addAndSelectServer('https://saved.im.codes/deep', 'Saved');

    const secondLoads: Array<{ url: string; active: string | null }> = [];
    const second = createPcAppShell({
      platform: 'win32',
      appName: 'IM.codes',
      userDataDir: tempDir,
      createMainWindow: (opts) =>
        createFakeShellWindow({
          webPreferences: opts.webPreferences,
          loadSpy: (u) => secondLoads.push({ url: u, active: second.controller.getActiveOrigin() }),
        }),
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 1 }),
    });
    await second.ensureWindow();
    expect(secondLoads).toEqual([{ url: 'https://saved.im.codes', active: 'https://saved.im.codes' }]);
    expect(second.controller.currentTrustedOrigin()).toBe('https://saved.im.codes');
  });

  it('sandboxed add-server prompt enforces zero nodeIntegration/preload, rejects invalid URLs inline, and resolves valid input', async () => {
    const wc = new EventEmitter() as EventEmitter & {
      setWindowOpenHandler: (fn: (d: { url: string }) => { action: 'deny' }) => void;
    };
    let windowOpenFn: ((d: { url: string }) => { action: 'deny' }) | null = null;
    wc.setWindowOpenHandler = (fn) => {
      windowOpenFn = fn;
    };
    const modalEmitter = new EventEmitter();
    const loadedUrls: string[] = [];
    let closed = false;

    const resultPromise = openAddServerPrompt((opts) => {
      expect(opts.webPreferences).toEqual({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        partition: 'pc-app-prompt-ephemeral',
      });
      return {
        isDestroyed: () => closed,
        close: () => {
          closed = true;
          modalEmitter.emit('closed');
        },
        loadURL: (u: string) => {
          loadedUrls.push(u);
        },
        on: (ev: 'closed', fn: () => void) => modalEmitter.on(ev, fn),
        webContents: wc,
      };
    });

    expect(windowOpenFn!({ url: 'https://evil.example' })).toEqual({ action: 'deny' });

    // Invalid remote http submission re-renders inline error without closing
    const badEv = { preventDefault: vi.fn() };
    wc.emit('will-navigate', badEv, 'https://imcodes-prompt.local/submit?url=http%3A%2F%2Finsecure.example&label=Test');
    expect(badEv.preventDefault).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    expect(decodeURIComponent(loadedUrls.at(-1)!)).toContain('Unsupported server URL scheme');

    // Valid https submission resolves normalized origin + label and closes modal
    const goodEv = { preventDefault: vi.fn() };
    wc.emit('will-navigate', goodEv, 'https://imcodes-prompt.local/submit?url=https%3A%2F%2Fmy.im.codes%2Fpath&label=Office');
    expect(goodEv.preventDefault).toHaveBeenCalledTimes(1);
    await expect(resultPromise).resolves.toEqual({ origin: 'https://my.im.codes', label: 'Office' });
    expect(closed).toBe(true);
  });

  it('renders interactive ServerSetupPage-style welcome screen, supports /connect, /add, /remove, local bound detection, invalid URL errors, and Switch Server menu', async () => {
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-home-'));
    try {
      // Valid ~/.imcodes/server.json is surfaced read-only as a one-click detected entry
      writeFileSync(
        path.join(fakeHome, 'server.json'),
        JSON.stringify({
          serverId: 'srv-1',
          token: 'tok-1',
          workerUrl: 'https://im.zhinet.work/subpath',
          serverName: 'My Work Mac',
          boundAt: 1000,
        }),
      );

      let latestMenu: MenuItemOptionsLike[] = [];
      let createdWin!: ReturnType<typeof createFakeShellWindow>;

      const shell = createPcAppShell({
        platform: 'darwin',
        appName: 'IM.codes',
        userDataDir: tempDir,
        welcomeLocale: 'zh-CN',
        bindDeps: { imcodesHome: fakeHome },
        createMainWindow: (opts) => {
          createdWin = createFakeShellWindow({ webPreferences: opts.webPreferences });
          return createdWin;
        },
        createPromptWindow: () => {
          throw new Error('unused');
        },
        setApplicationMenu: (template) => {
          latestMenu = template;
        },
        openExternal: () => {},
        showSaveDialogSync: () => undefined,
        showMessageBox: async () => ({ response: 1 }),
      });

      await shell.ensureWindow();
      const welcomeHtml = decodeURIComponent(createdWin.webContents.getURL().replace('data:text/html;charset=utf-8,', ''));
      expect(welcomeHtml).toContain("default-src 'none'; style-src 'unsafe-inline';");
      expect(welcomeHtml).toContain('选择或添加 IM.codes 服务器');
      expect(welcomeHtml).toContain('https://app.im.codes');
      expect(welcomeHtml).toContain('https://im.zhinet.work');
      expect(welcomeHtml).toContain('本机已绑定');
      expect(welcomeHtml).toContain('https://imcodes-welcome.local/connect?url=https%3A%2F%2Fim.zhinet.work');
      expect(welcomeHtml).toContain('action="https://imcodes-welcome.local/add"');

      // Backward-compatible signature check
      expect(decodeURIComponent(buildWelcomeDataUrl())).toContain('https://app.im.codes');
      expect(decodeURIComponent(buildWelcomeDataUrl(0))).toContain('https://imcodes-welcome.local/add');

      // Invalid URL submission renders inline role="alert" banner and preserves inputs
      for (const badUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'http://evil.com', 'https://u:p@host.example']) {
        const badEv = { preventDefault: vi.fn() };
        createdWin.webContentsEmitter.emit(
          'will-navigate',
          badEv,
          `https://imcodes-welcome.local/add?url=${encodeURIComponent(badUrl)}&label=Bad`,
        );
        expect(badEv.preventDefault).toHaveBeenCalled();
        await vi.waitFor(() => {
          const html = decodeURIComponent(createdWin.webContents.getURL());
          expect(html).toContain('role="alert"');
          expect(html).toContain('value="Bad"');
        });
        expect(shell.controller.getActiveOrigin()).toBeNull();
        expect(shell.store.list()).toEqual([]);
      }

      // Submitting valid custom URL via /add persists normalized origin + label and selects server
      const addEv = { preventDefault: vi.fn() };
      createdWin.webContentsEmitter.emit(
        'will-navigate',
        addEv,
        'https://imcodes-welcome.local/add?url=https%3A%2F%2Fcustom.im.codes%2Fapp&label=Custom',
      );
      expect(addEv.preventDefault).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(shell.controller.getActiveOrigin()).toBe('https://custom.im.codes');
      });
      expect(shell.store.list().map((s) => s.origin)).toEqual(['https://custom.im.codes']);

      // Menu has Switch Server… which returns to interactive welcome screen while preserving saved server + Add Server…
      const switchItem = findMenuItem(latestMenu, 'server:switch');
      expect(switchItem).toBeDefined();
      expect(findMenuItem(latestMenu, 'server:add')).toBeDefined();
      switchItem?.click?.();
      await vi.waitFor(() => {
        expect(shell.controller.getActiveOrigin()).toBeNull();
        expect(createdWin.webContents.getURL().startsWith('data:text/html')).toBe(true);
      });
      const returnedHtml = decodeURIComponent(createdWin.webContents.getURL());
      expect(returnedHtml).toContain('https://imcodes-welcome.local/remove?url=https%3A%2F%2Fcustom.im.codes');

      // Clicking remove link deletes custom server and refreshes welcome page without removing default
      const removeEv = { preventDefault: vi.fn() };
      createdWin.webContentsEmitter.emit(
        'will-navigate',
        removeEv,
        'https://imcodes-welcome.local/remove?url=https%3A%2F%2Fcustom.im.codes',
      );
      expect(removeEv.preventDefault).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(shell.store.list()).toEqual([]);
      });

      // Clicking detected server card connects directly
      const connectEv = { preventDefault: vi.fn() };
      createdWin.webContentsEmitter.emit(
        'will-navigate',
        connectEv,
        'https://imcodes-welcome.local/connect?url=https%3A%2F%2Fim.zhinet.work',
      );
      expect(connectEv.preventDefault).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(shell.controller.getActiveOrigin()).toBe('https://im.zhinet.work');
      });
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('silently ignores missing, corrupt, or non-https local server.json when building welcome screen', async () => {
    const badHome = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-badhome-'));
    try {
      writeFileSync(path.join(badHome, 'server.json'), '{not-valid-json');
      let createdWin!: ReturnType<typeof createFakeShellWindow>;
      const shell = createPcAppShell({
        platform: 'linux',
        appName: 'IM.codes',
        userDataDir: tempDir,
        bindDeps: { imcodesHome: badHome },
        createMainWindow: (opts) => {
          createdWin = createFakeShellWindow({ webPreferences: opts.webPreferences });
          return createdWin;
        },
        createPromptWindow: () => {
          throw new Error('unused');
        },
        setApplicationMenu: () => {},
        openExternal: () => {},
        showSaveDialogSync: () => undefined,
        showMessageBox: async () => ({ response: 1 }),
      });

      await shell.ensureWindow();
      const html = decodeURIComponent(createdWin.webContents.getURL());
      expect(html).toContain('https://app.im.codes');
      expect(shell.controller.getActiveOrigin()).toBeNull();
    } finally {
      rmSync(badHome, { recursive: true, force: true });
    }
  });
});
