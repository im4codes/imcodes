import path from 'node:path';
import {
  BindCoordinator,
  type BindCoordinatorDeps,
  type CookiesChangeEventLike,
  type LaunchAgentIssue,
} from './bind.js';
import { buildAppMenuTemplate, type MenuItemOptionsLike } from './menu.js';
import {
  attachWindowSecurityGuards,
  isAllowedExternalUrl,
  MAIN_WINDOW_WEB_PREFERENCES,
  type SecuritySessionLike,
  type SecurityWebContentsLike,
} from './security.js';
import {
  buildWelcomeDataUrl,
  DEFAULT_SERVER_ORIGIN,
  openAddServerPrompt,
  WELCOME_SUBMIT_ORIGIN,
  type PromptWindowFactory,
  type ServerPromptInput,
  type WelcomeDataUrlOptions,
} from './server-prompt.js';
import { normalizeServerOrigin, ServerStore } from './servers.js';
import { TrustedOriginController, type TrustedWindowLike } from './trust.js';

export const DOCS_HELP_URL = 'https://docs.im.codes';

export interface ShellWindowLike extends TrustedWindowLike {
  on(event: 'closed', listener: () => void): unknown;
  webContents: TrustedWindowLike['webContents'] & SecurityWebContentsLike & {
    session: SecuritySessionLike & {
      cookies?: CookiesChangeEventLike;
      clearStorageData?(options?: { origin?: string }): Promise<void>;
    };
    on(event: 'did-navigate', listener: () => void): unknown;
    reload(): void;
    reloadIgnoringCache(): void;
    toggleDevTools(): void;
  };
}

export interface PcAppShellDeps {
  platform: NodeJS.Platform;
  appName: string;
  userDataDir: string;
  createMainWindow: (options: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    title: string;
    webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES;
  }) => ShellWindowLike;
  createPromptWindow: PromptWindowFactory;
  setApplicationMenu: (template: MenuItemOptionsLike[]) => void;
  openExternal: (url: string) => Promise<void> | void;
  showSaveDialogSync: (win: ShellWindowLike, defaultPath: string) => string | undefined;
  showMessageBox: (win: ShellWindowLike, options: {
    type: 'info' | 'question' | 'warning' | 'error';
    title: string;
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
  }) => Promise<{ response: number }>;
  showNotification?: (options: { title: string; body: string }) => void;
  promptAddServer?: () => Promise<ServerPromptInput | null>;
  detectLocalBoundOrigin?: () => string | { origin: string; label?: string } | null;
  welcomeLocale?: string;
  onBindFallback?: (trustedOrigin: string | null) => Promise<void> | void;
  bindDeps?: Partial<
    Omit<
      BindCoordinatorDeps,
      | 'platform'
      | 'getCurrentTrustedOrigin'
      | 'onDidNavigateTrustedOrigin'
      | 'showMessageBox'
      | 'showNotification'
      | 'onStateChanged'
    >
  >;
  externalDocsHosts?: readonly string[];
}

export interface PcAppShellInstance {
  store: ServerStore;
  controller: TrustedOriginController;
  bind: BindCoordinator;
  getWindow: () => ShellWindowLike | null;
  ensureWindow: () => Promise<ShellWindowLike>;
  showServerPicker: () => Promise<void>;
  addAndSelectServer: (rawUrl: string, label?: string) => Promise<string>;
  selectServer: (origin: string) => Promise<string>;
  removeServer: (origin: string) => Promise<boolean>;
  rebuildMenu: () => void;
  checkLaunchAgent: () => Promise<LaunchAgentIssue>;
}

/**
 * Create and manage the Electron PC App V1 window, server list switcher,
 * §4.7 security guards, and Phase B extension seams.
 */
export function createPcAppShell(deps: PcAppShellDeps): PcAppShellInstance {
  const store = new ServerStore(deps.userDataDir);
  let mainWindow: ShellWindowLike | null = null;
  const controller = new TrustedOriginController(store, () => mainWindow);
  const bind = new BindCoordinator({
    keptBindingStorePath: path.join(deps.userDataDir, 'kept-bindings.json'),
    ...(deps.bindDeps ?? {}),
    platform: deps.platform,
    getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
    onDidNavigateTrustedOrigin: (listener) => controller.onDidNavigateTrustedOrigin(listener),
    showMessageBox: async (options) => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : await ensureWindow();
      return deps.showMessageBox(win, options);
    },
    showNotification: deps.showNotification ?? (() => {}),
    onStateChanged: () => rebuildMenu(),
  });

  const openDocsSafely = (url: string) => {
    if (isAllowedExternalUrl(url, deps.externalDocsHosts)) {
      return deps.openExternal(url);
    }
    return undefined;
  };

  const detectLocalBoundServer = (): { origin: string; label?: string } | null => {
    if (deps.detectLocalBoundOrigin) {
      try {
        const raw = deps.detectLocalBoundOrigin();
        if (!raw) return null;
        const originRaw = typeof raw === 'string' ? raw : raw.origin;
        const origin = normalizeServerOrigin(originRaw);
        const label = typeof raw === 'string' ? undefined : raw.label?.trim() || undefined;
        return { origin, ...(label ? { label } : {}) };
      } catch {
        return null;
      }
    }
    try {
      const summary = bind.getBoundSummary();
      if (!summary?.workerUrl) return null;
      const origin = normalizeServerOrigin(summary.workerUrl);
      const label = summary.serverName?.trim() || undefined;
      return { origin, ...(label ? { label } : {}) };
    } catch {
      return null;
    }
  };

  const loadWelcomeScreen = async (
    win: ShellWindowLike,
    extra?: Pick<WelcomeDataUrlOptions, 'initialUrl' | 'initialLabel' | 'errorMessage'>,
  ) => {
    controller.clearActiveOrigin();
    await win.loadURL(
      buildWelcomeDataUrl({
        servers: store.list(),
        detectedServer: detectLocalBoundServer(),
        locale: deps.welcomeLocale,
        ...extra,
      }),
    );
  };

  const loadWelcomeOrLastServer = async (win: ShellWindowLike) => {
    const lastOrigin = store.getLastOrigin();
    if (lastOrigin && store.trustedOrigins().has(lastOrigin)) {
      await controller.selectServer(lastOrigin);
      return;
    }
    await loadWelcomeScreen(win);
  };

  const showServerPicker = async () => {
    const win = await ensureWindow();
    await loadWelcomeScreen(win);
    rebuildMenu();
  };

  const handleAddServer = async () => {
    const win = await ensureWindow();
    const promptFn = deps.promptAddServer ?? (() => openAddServerPrompt(deps.createPromptWindow));
    const input = await promptFn();
    if (!input) return;
    const saved = store.addServer(input.origin, input.label);
    await controller.selectServer(saved.origin);
    rebuildMenu();
    void win;
  };

  const handleSelectServer = async (origin: string): Promise<string> => {
    await ensureWindow();
    const selected = await controller.selectServer(origin);
    rebuildMenu();
    return selected;
  };

  const handleRemoveServer = async (origin: string) => {
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      const { response } = await deps.showMessageBox(win, {
        type: 'question',
        title: 'Remove Server',
        message: `Remove ${origin} from saved servers?`,
        buttons: ['Cancel', 'Remove'],
        defaultId: 1,
        cancelId: 0,
      });
      if (response !== 1) return;
    }

    const wasActive = controller.getActiveOrigin() === origin;
    const removed = store.removeServer(origin);
    if (!removed) return;

    if (wasActive && mainWindow && !mainWindow.isDestroyed()) {
      const next = store.getLastOrigin();
      if (next && store.trustedOrigins().has(next)) {
        await controller.selectServer(next);
      } else {
        await loadWelcomeScreen(mainWindow);
      }
    }
    rebuildMenu();
  };

  const handleBindFallback = async () => {
    const origin = controller.currentTrustedOrigin();
    if (deps.onBindFallback) {
      await deps.onBindFallback(origin);
      return;
    }
    await bind.triggerManualBind();
  };

  const handleClearSession = async () => {
    const origin = controller.currentTrustedOrigin();
    if (origin) {
      bind.clearAskedState(origin);
    }
    await controller.clearSession(origin ?? undefined);
    if (origin && mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(origin);
    }
  };

  const rebuildMenu = () => {
    const template = buildAppMenuTemplate({
      platform: deps.platform,
      appName: deps.appName,
      servers: store.list(),
      activeOrigin: controller.getActiveOrigin(),
      boundServer: bind.getBoundSummary(),
      onSelectServer: (origin) => void handleSelectServer(origin),
      onAddServer: () => void handleAddServer(),
      onSwitchServer: () => void showServerPicker(),
      onRemoveServer: (origin) => void handleRemoveServer(origin),
      onReload: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reload();
        }
      },
      onForceReload: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      },
      onToggleDevTools: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.toggleDevTools();
        }
      },
      onClearSession: () => void handleClearSession(),
      onBindFallback: () => void handleBindFallback(),
      onOpenDocs: () => void openDocsSafely(DOCS_HELP_URL),
    });
    deps.setApplicationMenu(template);
  };

  const ensureWindow = async (): Promise<ShellWindowLike> => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow;
    }

    const win = deps.createMainWindow({
      width: 1280,
      height: 820,
      minWidth: 800,
      minHeight: 560,
      title: deps.appName,
      webPreferences: MAIN_WINDOW_WEB_PREFERENCES,
    });
    mainWindow = win;

    attachWindowSecurityGuards({
      webContents: win.webContents,
      session: win.webContents.session,
      getActiveOrigin: () => controller.getActiveOrigin(),
      getTrustedOrigins: () => controller.trustedOrigins(),
      getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
      openExternal: openDocsSafely,
      promptSavePathSync: (suggestedFilename) => {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        return deps.showSaveDialogSync(mainWindow, suggestedFilename) ?? null;
      },
      externalDocsHosts: deps.externalDocsHosts,
    });

    win.webContents.on('will-navigate', (event, rawTarget) => {
      let parsed: URL;
      try {
        parsed = new URL(rawTarget);
      } catch {
        return;
      }
      if (parsed.origin !== WELCOME_SUBMIT_ORIGIN) {
        return;
      }
      event.preventDefault();
      // Only honor welcome virtual navigation while on the sandboxed welcome data: page (no active remote origin).
      if (controller.getActiveOrigin() !== null || !win.webContents.getURL().startsWith('data:text/html')) {
        return;
      }

      if (parsed.pathname === '/connect') {
        const rawUrl = parsed.searchParams.get('url') ?? '';
        void (async () => {
          try {
            const origin = normalizeServerOrigin(rawUrl);
            if (!store.trustedOrigins().has(origin)) {
              const detected = detectLocalBoundServer();
              const label = detected?.origin === origin ? detected.label : undefined;
              store.addServer(origin, label);
            }
            await controller.selectServer(origin);
            rebuildMenu();
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await loadWelcomeScreen(win, { initialUrl: rawUrl, errorMessage });
          }
        })();
        return;
      }

      if (parsed.pathname === '/add') {
        const rawUrl = parsed.searchParams.get('url') ?? '';
        const rawLabel = parsed.searchParams.get('label') ?? '';
        const cleanLabel = rawLabel.trim() || undefined;
        void (async () => {
          try {
            const origin = normalizeServerOrigin(rawUrl);
            store.addServer(origin, cleanLabel);
            await controller.selectServer(origin);
            rebuildMenu();
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await loadWelcomeScreen(win, {
              initialUrl: rawUrl,
              initialLabel: rawLabel,
              errorMessage,
            });
          }
        })();
        return;
      }

      if (parsed.pathname === '/remove') {
        const rawUrl = parsed.searchParams.get('url') ?? '';
        void (async () => {
          try {
            const origin = normalizeServerOrigin(rawUrl);
            if (origin !== DEFAULT_SERVER_ORIGIN) {
              store.removeServer(origin);
            }
          } catch {
            // Ignore malformed remove target
          }
          await loadWelcomeScreen(win);
          rebuildMenu();
        })();
      }
    });

    win.webContents.on('did-navigate', () => {
      controller.notifyDidNavigate();
    });

    if (win.webContents.session.cookies) {
      bind.attachCookies(win.webContents.session.cookies);
    }

    win.on('closed', () => {
      if (mainWindow === win) {
        mainWindow = null;
      }
    });

    rebuildMenu();
    await loadWelcomeOrLastServer(win);
    rebuildMenu();
    return win;
  };

  return {
    store,
    controller,
    bind,
    getWindow: () => mainWindow,
    ensureWindow,
    showServerPicker,
    addAndSelectServer: async (rawUrl, label) => {
      await ensureWindow();
      const saved = store.addServer(rawUrl, label);
      const origin = await controller.selectServer(saved.origin);
      rebuildMenu();
      return origin;
    },
    selectServer: handleSelectServer,
    removeServer: async (origin) => {
      const removed = store.removeServer(origin);
      if (removed) rebuildMenu();
      return removed;
    },
    rebuildMenu,
    checkLaunchAgent: () => bind.checkLaunchAgentOnStartup(),
  };
}
