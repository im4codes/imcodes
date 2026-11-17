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
  openAddServerPrompt,
  type PromptWindowFactory,
  type ServerPromptInput,
} from './server-prompt.js';
import { ServerStore } from './servers.js';
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

  const loadWelcomeOrLastServer = async (win: ShellWindowLike) => {
    const lastOrigin = store.getLastOrigin();
    if (lastOrigin && store.trustedOrigins().has(lastOrigin)) {
      await controller.selectServer(lastOrigin);
      return;
    }
    controller.clearActiveOrigin();
    await win.loadURL(buildWelcomeDataUrl(store.list().length));
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
        controller.clearActiveOrigin();
        await mainWindow.loadURL(buildWelcomeDataUrl(store.list().length));
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
