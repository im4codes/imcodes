import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookieLike, CookiesChangeEventLike } from '../src/bind.js';
import { PC_APP_LOCALES, tPcApp } from '../src/i18n.js';
import { buildAppMenuTemplate, type MenuItemOptionsLike } from '../src/menu.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from '../src/security.js';
import { buildWelcomeDataUrl, openAddServerPrompt } from '../src/server-prompt.js';
import { MIC_TEST_OVERLAY_ID } from '../src/mic-test.js';
import { createPcAppShell, type ShellWindowLike } from '../src/shell.js';

function createFakeShellWindow(opts: {
  webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES;
  loadSpy?: (url: string) => Promise<void> | void;
  cookies?: CookiesChangeEventLike;
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
    ...(opts.cookies ? { cookies: opts.cookies } : {}),
  });

  const webContents = Object.assign(webContentsEmitter, {
    getURL: () => url,
    setWindowOpenHandler: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    toggleDevTools: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined),
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

  it('adds Cmd+, Settings… menu item on macOS, disabled on welcome screen and guarded by trusted origin when connected', async () => {
    let createdWin!: ReturnType<typeof createFakeShellWindow>;
    let latestMenu: MenuItemOptionsLike[] = [];

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      welcomeLocale: 'en',
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
    // Welcome screen: Settings… exists with CmdOrCtrl+, accelerator but disabled and no-op
    let settingsItem = findMenuItem(latestMenu, 'app:settings');
    expect(settingsItem).toBeDefined();
    expect(settingsItem?.accelerator).toBe('CmdOrCtrl+,');
    expect(settingsItem?.enabled).toBe(false);
    settingsItem?.click?.();
    expect(createdWin.webContents.executeJavaScript).not.toHaveBeenCalled();

    // Connect to trusted origin via welcome connect action: Settings… becomes enabled and dispatches imcodes:open-settings
    const connectEv = { preventDefault: vi.fn() };
    createdWin.webContentsEmitter.emit(
      'will-navigate',
      connectEv,
      'https://imcodes-welcome.local/connect?url=https%3A%2F%2Fapp.im.codes',
    );
    await vi.waitFor(() => {
      expect(shell.controller.getActiveOrigin()).toBe('https://app.im.codes');
      expect(createdWin.webContents.getURL()).toBe('https://app.im.codes');
      expect(findMenuItem(latestMenu, 'app:settings')?.enabled).toBe(true);
    });
    settingsItem = findMenuItem(latestMenu, 'app:settings');
    settingsItem?.click?.();
    expect(createdWin.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(createdWin.webContents.executeJavaScript).toHaveBeenCalledWith(
      'window.dispatchEvent(new CustomEvent("imcodes:open-settings"))',
      true,
    );

    // If webContents navigated away to an untrusted origin, did-navigate disables Settings… and click is a safe no-op
    (createdWin.webContents.executeJavaScript as ReturnType<typeof vi.fn>).mockClear();
    await createdWin.loadURL('https://evil.example/');
    createdWin.webContentsEmitter.emit('did-navigate');
    settingsItem = findMenuItem(latestMenu, 'app:settings');
    expect(settingsItem?.enabled).toBe(false);
    settingsItem?.click?.();
    expect(createdWin.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('omits macOS app:settings menu item on non-darwin platforms', async () => {
    let latestMenu: MenuItemOptionsLike[] = [];
    const shell = createPcAppShell({
      platform: 'win32',
      appName: 'IM.codes',
      userDataDir: tempDir,
      welcomeLocale: 'en',
      createMainWindow: (opts) => createFakeShellWindow({ webPreferences: opts.webPreferences }),
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
    expect(findMenuItem(latestMenu, 'app:settings')).toBeUndefined();
  });

  it('builds localized native menus across all 7 locales while preserving item IDs and accelerators', () => {
    const enMenu = buildAppMenuTemplate({
      platform: 'darwin',
      appName: 'IM.codes',
      locale: 'en',
      servers: [{ origin: 'https://app.im.codes', label: 'Prod', addedAt: 1 }],
      activeOrigin: 'https://app.im.codes',
      onSelectServer: () => {},
      onAddServer: () => {},
      onSwitchServer: () => {},
      onRemoveServer: () => {},
      onOpenSettings: () => {},
      onReload: () => {},
      onForceReload: () => {},
      onToggleDevTools: () => {},
      onClearSession: () => {},
      onBindFallback: () => {},
      onOpenDocs: () => {},
    });

    const collectIdsAndAccelerators = (items: MenuItemOptionsLike[]): Array<[string | undefined, string | undefined]> => {
      const out: Array<[string | undefined, string | undefined]> = [];
      for (const item of items) {
        if (item.id && !item.id.startsWith('server:http') && !item.id.startsWith('remove:http')) {
          out.push([item.id, item.accelerator]);
        }
        if (item.submenu) {
          out.push(...collectIdsAndAccelerators(item.submenu));
        }
      }
      return out;
    };
    const expectedIds = collectIdsAndAccelerators(enMenu);

    for (const locale of PC_APP_LOCALES) {
      const menu = buildAppMenuTemplate({
        platform: 'darwin',
        appName: 'IM.codes',
        locale,
        servers: [{ origin: 'https://app.im.codes', label: 'Prod', addedAt: 1 }],
        activeOrigin: 'https://app.im.codes',
        onSelectServer: () => {},
        onAddServer: () => {},
        onSwitchServer: () => {},
        onRemoveServer: () => {},
        onOpenSettings: () => {},
        onReload: () => {},
        onForceReload: () => {},
        onToggleDevTools: () => {},
        onClearSession: () => {},
        onBindFallback: () => {},
        onOpenDocs: () => {},
      });
      expect(collectIdsAndAccelerators(menu)).toEqual(expectedIds);
      expect(findMenuItem(menu, 'app:settings')?.label).toBe(tPcApp(locale, 'menu.app.settings'));
      expect(findMenuItem(menu, 'app:settings')?.accelerator).toBe('CmdOrCtrl+,');
      expect(findMenuItem(menu, 'server:switch')?.label).toBe(tPcApp(locale, 'menu.server.switch'));
      expect(findMenuItem(menu, 'server:add')?.label).toBe(tPcApp(locale, 'menu.server.add'));
      expect(findMenuItem(menu, 'voice:model-system')?.label).toBe(tPcApp(locale, 'menu.voice.system'));
      expect(findMenuItem(menu, 'voice:model-qwen3-0.6b')?.label).toBe(tPcApp(locale, 'menu.voice.qwen06b'));
      expect(findMenuItem(menu, 'voice:model-qwen3-1.7b')?.label).toBe(tPcApp(locale, 'menu.voice.qwen17b'));
      expect(findMenuItem(menu, 'voice:mic-test')?.label).toBe(tPcApp(locale, 'menu.voice.micTest'));
      expect(findMenuItem(menu, 'help:docs')?.label).toBe(tPcApp(locale, 'menu.help.docs'));
      expect(menu.find((m) => m.label === tPcApp(locale, 'menu.edit.label'))).toBeDefined();
      expect(menu.find((m) => m.label === tPcApp(locale, 'menu.view.label'))).toBeDefined();
      expect(menu.find((m) => m.label === tPcApp(locale, 'menu.server.label'))).toBeDefined();
      expect(menu.find((m) => m.label === tPcApp(locale, 'menu.voice.label'))).toBeDefined();
      expect(menu.find((m) => m.label === tPcApp(locale, 'menu.window.label'))).toBeDefined();
      expect(menu.find((m) => m.label === tPcApp(locale, 'menu.help.label'))).toBeDefined();
    }

    const zhMenu = buildAppMenuTemplate({
      platform: 'darwin',
      appName: 'IM.codes',
      locale: 'zh-CN',
      servers: [],
      activeOrigin: null,
      onSelectServer: () => {},
      onAddServer: () => {},
      onSwitchServer: () => {},
      onRemoveServer: () => {},
      onOpenSettings: () => {},
      onReload: () => {},
      onForceReload: () => {},
      onToggleDevTools: () => {},
      onClearSession: () => {},
      onBindFallback: () => {},
      onOpenDocs: () => {},
    });
    expect(findMenuItem(zhMenu, 'app:settings')?.label).toBe('设置…');
    expect(findMenuItem(zhMenu, 'server:none')?.label).toBe('未保存服务器');
    expect(findMenuItem(zhMenu, 'server:switch')?.label).toBe('切换服务器…');
  });

  it('syncs active locale in real time from active-origin imcodes_lang cookie, ignores untrusted origins and malformed values, and persists across restarts', async () => {
    const cookieEmitter = new EventEmitter();
    const initialCookies: CookieLike[] = [];
    const cookies: CookiesChangeEventLike = {
      on: (event, listener) => cookieEmitter.on(event, listener),
      get: async ({ name }) => initialCookies.filter((c) => c.name === name),
    };

    const menus: MenuItemOptionsLike[][] = [];
    const dialogPrompts: Array<{ title: string; message: string; buttons: string[] }> = [];
    let createdWin!: ReturnType<typeof createFakeShellWindow>;

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      welcomeLocale: 'en',
      createMainWindow: (opts) => {
        createdWin = createFakeShellWindow({ webPreferences: opts.webPreferences, cookies });
        return createdWin;
      },
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: (template) => {
        menus.push(template);
      },
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async (_win, opts) => {
        dialogPrompts.push({ title: opts.title, message: opts.message, buttons: opts.buttons });
        return { response: 0 };
      },
    });

    await shell.addAndSelectServer('https://prod.im.codes', 'Prod');
    expect(shell.getLocale()).toBe('en');
    expect(findMenuItem(menus.at(-1)!, 'app:settings')?.label).toBe('Settings…');

    // Untrusted/inactive origin imcodes_lang cookie MUST be ignored (§4.7)
    cookieEmitter.emit(
      'changed',
      {},
      { name: 'imcodes_lang', value: 'zh-CN', domain: 'evil.example', path: '/' },
      'explicit',
      false,
    );
    expect(shell.getLocale()).toBe('en');

    // Malformed URI cookie value on trusted origin MUST NOT throw and keeps current locale
    cookieEmitter.emit(
      'changed',
      {},
      { name: 'imcodes_lang', value: '%ZZ', domain: 'prod.im.codes', path: '/' },
      'explicit',
      false,
    );
    expect(shell.getLocale()).toBe('en');

    // Trusted active origin imcodes_lang cookie updates menu + dialogs immediately and persists locale.json
    cookieEmitter.emit(
      'changed',
      {},
      { name: 'imcodes_lang', value: 'zh-CN', domain: 'prod.im.codes', path: '/' },
      'explicit',
      false,
    );
    await vi.waitFor(() => {
      expect(shell.getLocale()).toBe('zh-CN');
      expect(findMenuItem(menus.at(-1)!, 'app:settings')?.label).toBe('设置…');
      expect(findMenuItem(menus.at(-1)!, 'server:switch')?.label).toBe('切换服务器…');
    });

    // Triggering Remove Server dialog uses the synced locale
    findMenuItem(menus.at(-1)!, 'remove:https://prod.im.codes')?.click?.();
    await vi.waitFor(() => {
      expect(dialogPrompts.at(-1)).toEqual({
        title: '移除服务器',
        message: '确定从已保存服务器中移除 https://prod.im.codes 吗？',
        buttons: ['取消', '移除'],
      });
    });

    // Persisted locale survives shell restart even before any server loads or when OS welcomeLocale is 'en'
    const persistedJson = JSON.parse(readFileSync(path.join(tempDir, 'locale.json'), 'utf8'));
    expect(persistedJson).toEqual({ version: 1, locale: 'zh-CN' });

    const restartedMenus: MenuItemOptionsLike[][] = [];
    let restartedWin!: ReturnType<typeof createFakeShellWindow>;
    const restarted = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      welcomeLocale: 'en',
      createMainWindow: (opts) => {
        restartedWin = createFakeShellWindow({ webPreferences: opts.webPreferences, cookies });
        return restartedWin;
      },
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: (template) => {
        restartedMenus.push(template);
      },
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 0 }),
    });
    await restarted.ensureWindow();
    expect(restarted.getLocale()).toBe('zh-CN');
    expect(findMenuItem(restartedMenus.at(-1)!, 'app:settings')?.label).toBe('设置…');

    // did-finish-load reads imcodes_lang cookie for the active trusted origin
    initialCookies.push({ name: 'imcodes_lang', value: 'ja', domain: 'prod.im.codes', path: '/' });
    restartedWin.webContentsEmitter.emit('did-finish-load');
    await vi.waitFor(() => {
      expect(restarted.getLocale()).toBe('ja');
      expect(findMenuItem(restartedMenus.at(-1)!, 'server:switch')?.label).toBe('サーバーを切り替え…');
    });
  });

  it('restores and focuses the main window on focusWindow() and webContents focus while minimized', async () => {
    let minimized = true;
    const restore = vi.fn(() => { minimized = false; });
    const show = vi.fn();
    const focus = vi.fn();
    const focusApp = vi.fn();

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      focusApp,
      createMainWindow: (opts) => {
        const base = createFakeShellWindow({ webPreferences: opts.webPreferences });
        return Object.assign(base, {
          isMinimized: () => minimized,
          restore,
          show,
          focus,
        });
      },
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: () => {},
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 0 }),
    });

    const win = await shell.ensureWindow();
    // Notification click / dock activation restores minimized window and focuses app
    await shell.focusWindow();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focusApp).toHaveBeenCalledTimes(1);
    expect(minimized).toBe(false);

    // WebContents focus event (e.g. renderer window.focus() from Notification click) also restores if minimized
    minimized = true;
    (win as unknown as { webContentsEmitter: EventEmitter }).webContentsEmitter.emit('focus');
    expect(restore).toHaveBeenCalledTimes(2);
    expect(minimized).toBe(false);
  });

  it('renders Microphone submenu in voice:menu, wires selection & refresh in shell, and keeps voice menu null off darwin', async () => {
    const win32Template = buildAppMenuTemplate({
      platform: 'win32',
      appName: 'IM.codes',
      locale: 'en',
      servers: [],
      activeOrigin: null,
      onSelectServer: () => {},
      onAddServer: () => {},
      onRemoveServer: () => {},
      onReload: () => {},
      onForceReload: () => {},
      onToggleDevTools: () => {},
      onClearSession: () => {},
      onBindFallback: () => {},
      onOpenDocs: () => {},
    });
    expect(findMenuItem(win32Template, 'voice:menu')).toBeUndefined();

    const menus: MenuItemOptionsLike[][] = [];
    let deviceListCalls = 0;
    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      welcomeLocale: 'en',
      voiceDeps: {
        speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
        runHelperAsync: async (_bin, args) => {
          if (args[0] === 'devices') {
            deviceListCalls += 1;
            return JSON.stringify(
              deviceListCalls === 1
                ? [
                    { uid: 'mic-1', name: 'MacBook Pro Mic', transport: 'builtin', isDefault: true, isPhysical: true },
                    { uid: 'bt-1', name: 'AirPods', transport: 'bluetooth', isDefault: false, isPhysical: false },
                  ]
                : [
                    { uid: 'mic-1', name: 'MacBook Pro Mic', transport: 'builtin', isDefault: false, isPhysical: true },
                    { uid: 'usb-1', name: 'Shure MV7', transport: 'usb', isDefault: true, isPhysical: true },
                  ],
            );
          }
          return JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true });
        },
      },
      createMainWindow: (opts) => createFakeShellWindow({ webPreferences: opts.webPreferences }),
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: (template) => {
        menus.push(template);
      },
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 0 }),
    });

    await shell.ensureWindow();
    await vi.waitFor(() => {
      const latest = menus.at(-1)!;
      expect(findMenuItem(latest, 'voice:mic:mic-1')).toBeDefined();
    });

    const initialMenu = menus.at(-1)!;
    expect(findMenuItem(initialMenu, 'voice:mic-menu')?.label).toBe('Microphone');
    expect(findMenuItem(initialMenu, 'voice:mic-auto')?.checked).toBe(true);
    expect(findMenuItem(initialMenu, 'voice:mic:mic-1')?.label).toBe('MacBook Pro Mic (Default)');
    expect(findMenuItem(initialMenu, 'voice:mic:bt-1')?.label).toBe('AirPods (Bluetooth)');

    findMenuItem(initialMenu, 'voice:mic:bt-1')?.click?.();
    await vi.waitFor(() => {
      const latest = menus.at(-1)!;
      expect(shell.voice.getSelectedInputDevice()).toBe('bt-1');
      expect(findMenuItem(latest, 'voice:mic:bt-1')?.checked).toBe(true);
      expect(findMenuItem(latest, 'voice:mic-auto')?.checked).toBe(false);
    });

    findMenuItem(menus.at(-1)!, 'voice:mic-refresh')?.click?.();
    await vi.waitFor(() => {
      const latest = menus.at(-1)!;
      expect(findMenuItem(latest, 'voice:mic:usb-1')?.label).toBe('Shure MV7 (Default)');
      expect(findMenuItem(latest, 'voice:mic:bt-1')).toBeUndefined();
    });
  });

  it('mounts in-page floating Microphone Test overlay inside mainWindow without opening a separate BrowserWindow, skips select rebuilds on level ticks, and stops listening on close', async () => {
    const menus: MenuItemOptionsLike[][] = [];
    const createPromptWindowSpy = vi.fn(() => {
      throw new Error('should not open separate BrowserWindow for mic test');
    });
    let mainWin: ReturnType<typeof createFakeShellWindow> | null = null;
    const spawnedChildren: Array<{
      args: string[];
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    }> = [];

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir: tempDir,
      welcomeLocale: 'en',
      voiceDeps: {
        speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
        getMediaAccessStatus: () => 'granted',
        runHelperAsync: async (_bin, args) => {
          if (args[0] === 'devices') {
            return JSON.stringify([
              { uid: 'bt-1', name: 'AirPods Pro', transport: 'bluetooth', isDefault: true, isPhysical: false },
              { uid: 'usb-1', name: 'LG USB Audio', transport: 'usb', isDefault: false, isPhysical: true },
            ]);
          }
          return JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true });
        },
        spawnHelper: (_bin, args) => {
          const em = new EventEmitter();
          const child = Object.assign(em, {
            args,
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
            stdin: { write: vi.fn(), end: vi.fn() },
            kill: vi.fn(() => {
              em.emit('exit', 0);
            }),
          });
          spawnedChildren.push(child);
          return child as unknown as import('node:child_process').ChildProcess;
        },
      },
      createMainWindow: (opts) => {
        mainWin = createFakeShellWindow({ webPreferences: opts.webPreferences });
        return mainWin;
      },
      createPromptWindow: createPromptWindowSpy,
      setApplicationMenu: (template) => {
        menus.push(template);
      },
      openExternal: () => {},
      showSaveDialogSync: () => undefined,
      showMessageBox: async () => ({ response: 0 }),
    });

    await shell.ensureWindow();
    const micTestItem = findMenuItem(menus.at(-1)!, 'voice:mic-test');
    expect(micTestItem).toBeDefined();

    // While on welcome data: page (no trusted origin), clicking Microphone Test does not inject into data: or open a window
    micTestItem?.click?.();
    await new Promise((r) => setTimeout(r, 15));
    expect(createPromptWindowSpy).not.toHaveBeenCalled();
    expect(mainWin!.webContents.executeJavaScript).not.toHaveBeenCalled();

    // Connect to a trusted server origin, then open Voice -> Microphone Test…
    await shell.addAndSelectServer('https://app.im.codes', 'App');
    findMenuItem(menus.at(-1)!, 'voice:mic-test')?.click?.();
    await vi.waitFor(() => {
      expect(mainWin!.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    });
    expect(createPromptWindowSpy).not.toHaveBeenCalled();

    const injectedScript = (mainWin!.webContents.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(injectedScript).toContain(MIC_TEST_OVERLAY_ID);
    expect(injectedScript).toContain('window.__IMCODES_PC_APP__');

    // Execute the injected overlay script inside a minimal DOM/voice harness to verify UI behavior end-to-end
    const elements = new Map<string, FakeDomElement>();
    type FakeDomElement = {
      id: string;
      className: string;
      tagName: string;
      style: Record<string, string>;
      textContent: string;
      value: string;
      children: FakeDomElement[];
      options?: FakeDomElement[];
      parentNode: FakeDomElement | null;
      listeners: Map<string, Array<(ev?: unknown) => void>>;
      _innerHTMLChanges: number;
      appendChild: (child: FakeDomElement) => FakeDomElement;
      removeChild: (child: FakeDomElement) => void;
      addEventListener: (ev: string, fn: (ev?: unknown) => void) => void;
      dispatchEvent: (ev: string, payload?: unknown) => void;
      focus?: () => void;
      get innerHTML(): string;
      set innerHTML(v: string);
    };
    const makeEl = (tagName: string): FakeDomElement => {
      const listeners = new Map<string, Array<(ev?: unknown) => void>>();
      const el: FakeDomElement = {
        id: '',
        className: '',
        tagName,
        style: {},
        textContent: '',
        value: '',
        children: [],
        ...(tagName === 'select' ? { options: [] } : {}),
        parentNode: null,
        listeners,
        _innerHTMLChanges: 0,
        appendChild(child) {
          child.parentNode = el;
          el.children.push(child);
          if (tagName === 'select') el.options = el.children;
          if (child.id) elements.set(child.id, child);
          return child;
        },
        removeChild(child) {
          el.children = el.children.filter((c) => c !== child);
          child.parentNode = null;
          if (child.id) elements.delete(child.id);
        },
        addEventListener(ev, fn) {
          const arr = listeners.get(ev) ?? [];
          arr.push(fn);
          listeners.set(ev, arr);
        },
        dispatchEvent(ev, payload) {
          for (const fn of listeners.get(ev) ?? []) fn(payload);
        },
        get innerHTML() {
          return '';
        },
        set innerHTML(_v: string) {
          el._innerHTMLChanges += 1;
          el.children = [];
          if (tagName === 'select') el.options = [];
        },
      };
      return el;
    };
    const bodyEl = makeEl('body');
    const fakeDocument = {
      body: bodyEl,
      documentElement: bodyEl,
      createElement: (tag: string) => makeEl(tag),
      getElementById: (id: string) => elements.get(id) ?? null,
    };
    const voiceSubscribers = new Set<(ev: unknown) => void>();
    const stopListeningMock = vi.fn(async () => {});
    const startListeningMock = vi.fn(async () => ({ ok: true }));
    const setInputDeviceMock = vi.fn(async (uid: string) => uid);
    const fakeWindow: Record<string, unknown> = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      __IMCODES_PC_APP__: {
        voice: {
          getInputDevices: vi.fn(async () => [
            { uid: 'bt-1', name: 'AirPods Pro', transport: 'bluetooth', isDefault: true, isPhysical: false },
            { uid: 'usb-1', name: 'LG USB Audio', transport: 'usb', isDefault: false, isPhysical: true },
          ]),
          getInputDevice: vi.fn(async () => 'auto'),
          setInputDevice: setInputDeviceMock,
          getSpeechModelStatus: vi.fn(async () => ({
            selectedModel: 'system',
            activeBackend: 'system',
            state: 'downloading',
            progress: 0.42125,
            downloadedBytes: 42125,
            totalBytes: 100000,
            mlxSupported: true,
            downloadingModel: 'qwen3-0.6b',
            models: {
              'qwen3-0.6b': { state: 'downloading', progress: 0.42125, downloadedBytes: 42125, totalBytes: 100000, modelDir: '/m/06' },
              'qwen3-1.7b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 100000, modelDir: '/m/17' },
            },
          })),
          startListening: startListeningMock,
          stopListening: stopListeningMock,
          subscribe: vi.fn((fn: (ev: unknown) => void) => {
            voiceSubscribers.add(fn);
            return () => { voiceSubscribers.delete(fn); };
          }),
        },
      },
    };
    const runner = new Function('window', 'document', `return ${injectedScript}`);
    expect(runner(fakeWindow, fakeDocument)).toEqual({ mounted: true });

    const overlay = elements.get(MIC_TEST_OVERLAY_ID)!;
    expect(overlay).toBeDefined();
    expect(overlay.style.position).toBe('fixed');
    const selectEl = elements.get('imcodes-mic-test-select')!;
    const waveformEl = elements.get('imcodes-mic-test-waveform')!;
    expect(waveformEl.children).toHaveLength(16);

    await vi.waitFor(() => {
      expect(selectEl.children).toHaveLength(3);
      expect(elements.get('imcodes-mic-test-model-badge')!.textContent).toContain('Qwen3-ASR 0.6B (42.125%)');
    });
    const initialRebuilds = selectEl._innerHTMLChanges;

    // Click Start Test, emit level + transcript ticks, and verify <select> is NOT rebuilt on level updates
    elements.get('imcodes-mic-test-toggle')!.dispatchEvent('click');
    await vi.waitFor(() => expect(startListeningMock).toHaveBeenCalledTimes(1));

    for (const sub of voiceSubscribers) {
      sub({ type: 'start' });
      sub({ type: 'level', value: 0.72 });
      sub({ type: 'level', value: 0.45 });
      sub({ type: 'result', text: 'floating mic test', isFinal: true });
    }
    expect(selectEl._innerHTMLChanges).toBe(initialRebuilds);
    expect(elements.get('imcodes-mic-test-level-pct')!.textContent).toBe('45%');
    expect(waveformEl.children[15].style.height).not.toBe('4px');
    expect(elements.get('imcodes-mic-test-transcript')!.textContent).toBe('floating mic test');

    // Switching device persists uid and aborts + restarts listening cleanly
    selectEl.value = 'usb-1';
    selectEl.dispatchEvent('change');
    await vi.waitFor(() => {
      expect(setInputDeviceMock).toHaveBeenCalledWith('usb-1');
      expect(startListeningMock).toHaveBeenCalledTimes(2);
    });
    expect(stopListeningMock).toHaveBeenCalledWith({ abort: true });

    // Confirm menu item uses the exact 400ms download status polling interval inside floating overlay
    expect(injectedScript).toContain('setInterval(refreshModelStatus, 400)');
    expect(findMenuItem(
      buildAppMenuTemplate({
        platform: 'darwin',
        appName: 'IM.codes',
        locale: 'en',
        servers: [],
        activeOrigin: null,
        speechModelStatus: {
          selectedModel: 'system',
          activeBackend: 'system',
          state: 'idle',
          progress: 0,
          downloadedBytes: 0,
          totalBytes: 1000,
          mlxSupported: true,
          downloadingModel: 'qwen3-0.6b',
          models: {
            'qwen3-0.6b': { state: 'downloading', progress: 0.37125, downloadedBytes: 37125, totalBytes: 100000, modelDir: '/tmp/06' },
            'qwen3-1.7b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 2000, modelDir: '/tmp/17' },
          },
        },
        onSelectServer: () => {},
        onAddServer: () => {},
        onRemoveServer: () => {},
        onReload: () => {},
        onForceReload: () => {},
        onToggleDevTools: () => {},
        onClearSession: () => {},
        onBindFallback: () => {},
        onOpenDocs: () => {},
      }),
      'voice:status',
    )?.label).toBe('Status: Downloading (37.125%)…');

    // Closing overlay via × unsubscribes, stops active test listening, and removes DOM node
    elements.get('imcodes-mic-test-close')!.dispatchEvent('click');
    expect(elements.get(MIC_TEST_OVERLAY_ID)).toBeUndefined();
    expect(voiceSubscribers.size).toBe(0);
    expect(stopListeningMock).toHaveBeenLastCalledWith({ abort: true });
  });

  it('shows per-model readiness, download progress, and unsupported gating in the Voice menu', () => {
    const baseOpts = {
      platform: 'darwin' as const,
      appName: 'IM.codes',
      locale: 'en',
      servers: [],
      activeOrigin: null,
      onSelectServer: () => {},
      onAddServer: () => {},
      onRemoveServer: () => {},
      onReload: () => {},
      onForceReload: () => {},
      onToggleDevTools: () => {},
      onClearSession: () => {},
      onBindFallback: () => {},
      onOpenDocs: () => {},
    };

    const downloadingMenu = buildAppMenuTemplate({
      ...baseOpts,
      speechModelStatus: {
        selectedModel: 'system',
        activeBackend: 'system',
        state: 'downloading',
        progress: 0.42125,
        downloadedBytes: 42125,
        totalBytes: 100000,
        mlxSupported: true,
        downloadingModel: 'qwen3-0.6b',
        models: {
          'qwen3-0.6b': { state: 'downloading', progress: 0.42125, downloadedBytes: 42125, totalBytes: 100000, modelDir: '/m/06' },
          'qwen3-1.7b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 100000, modelDir: '/m/17' },
        },
      },
    });
    expect(findMenuItem(downloadingMenu, 'voice:model-system')?.checked).toBe(true);
    expect(findMenuItem(downloadingMenu, 'voice:model-qwen3-0.6b')?.checked).toBe(false);
    expect(findMenuItem(downloadingMenu, 'voice:model-qwen3-0.6b')?.enabled).toBe(false);
    expect(findMenuItem(downloadingMenu, 'voice:model-qwen3-0.6b')?.label).toContain('Downloading 42.125%');

    // Boundary check: NaN clamps to 0.000% and >1 clamps to 100.000%
    const clampedMenu = buildAppMenuTemplate({
      ...baseOpts,
      speechModelStatus: {
        selectedModel: 'system',
        activeBackend: 'system',
        state: 'downloading',
        progress: Number.NaN,
        downloadedBytes: 0,
        totalBytes: 100,
        mlxSupported: true,
        downloadingModel: 'qwen3-0.6b',
        models: {
          'qwen3-0.6b': { state: 'downloading', progress: 1.5, downloadedBytes: 150, totalBytes: 100, modelDir: '/m/06' },
          'qwen3-1.7b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 100, modelDir: '/m/17' },
        },
      },
    });
    expect(findMenuItem(clampedMenu, 'voice:model-qwen3-0.6b')?.label).toContain('Downloading 100.000%');
    expect(findMenuItem(clampedMenu, 'voice:status')?.label).toBe('Status: Downloading (100.000%)…');

    const nanMenu = buildAppMenuTemplate({
      ...baseOpts,
      speechModelStatus: {
        selectedModel: 'system',
        activeBackend: 'system',
        state: 'downloading',
        progress: Number.NaN,
        downloadedBytes: 0,
        totalBytes: 100,
        mlxSupported: true,
        downloadingModel: null,
      },
    });
    expect(findMenuItem(nanMenu, 'voice:status')?.label).toBe('Status: Downloading (0.000%)…');
    expect(findMenuItem(downloadingMenu, 'voice:model-qwen3-1.7b')?.checked).toBe(false);
    expect(findMenuItem(downloadingMenu, 'voice:model-qwen3-1.7b')?.enabled).toBe(true);
    expect(findMenuItem(downloadingMenu, 'voice:model-qwen3-1.7b')?.label).toContain('Not Downloaded');

    const readyMenu = buildAppMenuTemplate({
      ...baseOpts,
      speechModelStatus: {
        selectedModel: 'qwen3-0.6b',
        activeBackend: 'qwen3-0.6b',
        state: 'ready',
        progress: 1,
        downloadedBytes: 100,
        totalBytes: 100,
        mlxSupported: true,
        downloadingModel: null,
        models: {
          'qwen3-0.6b': { state: 'ready', progress: 1, downloadedBytes: 100, totalBytes: 100, modelDir: '/m/06' },
          'qwen3-1.7b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 100, modelDir: '/m/17' },
        },
      },
    });
    expect(findMenuItem(readyMenu, 'voice:model-system')?.checked).toBe(false);
    expect(findMenuItem(readyMenu, 'voice:model-qwen3-0.6b')?.checked).toBe(true);
    expect(findMenuItem(readyMenu, 'voice:model-qwen3-0.6b')?.enabled).toBe(true);
    expect(findMenuItem(readyMenu, 'voice:model-qwen3-0.6b')?.label).toContain('(Ready)');

    const unsupportedMenu = buildAppMenuTemplate({
      ...baseOpts,
      speechModelStatus: {
        selectedModel: 'system',
        activeBackend: 'system',
        state: 'unsupported',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 100,
        mlxSupported: false,
        downloadingModel: null,
        models: {
          'qwen3-0.6b': { state: 'unsupported', progress: 0, downloadedBytes: 0, totalBytes: 100, modelDir: '/m/06' },
          'qwen3-1.7b': { state: 'unsupported', progress: 0, downloadedBytes: 0, totalBytes: 100, modelDir: '/m/17' },
        },
      },
    });
    expect(findMenuItem(unsupportedMenu, 'voice:model-system')?.checked).toBe(true);
    expect(findMenuItem(unsupportedMenu, 'voice:model-qwen3-0.6b')?.checked).toBe(false);
    expect(findMenuItem(unsupportedMenu, 'voice:model-qwen3-0.6b')?.enabled).toBe(false);
    expect(findMenuItem(unsupportedMenu, 'voice:model-qwen3-0.6b')?.label).toContain('(Unsupported)');
    expect(findMenuItem(unsupportedMenu, 'voice:model-qwen3-1.7b')?.checked).toBe(false);
    expect(findMenuItem(unsupportedMenu, 'voice:model-qwen3-1.7b')?.enabled).toBe(false);
    expect(findMenuItem(unsupportedMenu, 'voice:model-qwen3-1.7b')?.label).toContain('(Unsupported)');
  });
});
