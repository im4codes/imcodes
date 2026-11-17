import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuItemOptionsLike } from '../src/menu.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from '../src/security.js';
import { openAddServerPrompt } from '../src/server-prompt.js';
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
});
