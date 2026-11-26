import path from 'node:path';
import {
  BindCoordinator,
  sameOriginNamedCookie,
  type BindCoordinatorDeps,
  type CookiesChangeEventLike,
  type LaunchAgentIssue,
} from './bind.js';
import {
  PC_APP_LOCALE_COOKIE,
  PcAppLocaleStore,
  normalizePcAppLocale,
  parseLocaleCookieValue,
  tPcApp,
  type PcAppLocale,
} from './i18n.js';
import { buildAppMenuTemplate, type MenuItemOptionsLike } from './menu.js';
import { createPcAppMicTestController } from './mic-test.js';
import {
  attachWindowSecurityGuards,
  isAllowedExternalUrl,
  isSameActiveOrigin,
  MAIN_WINDOW_WEB_PREFERENCES,
  type SecuritySessionLike,
  type SecurityWebContentsLike,
} from './security.js';
import {
  buildWelcomeDataUrl,
  isDefaultServerOrigin,
  openAddServerPrompt,
  WELCOME_SUBMIT_ORIGIN,
  type PromptWindowFactory,
  type ServerPromptInput,
  type WelcomeDataUrlOptions,
} from './server-prompt.js';
import type { LocaleDefaultServerRule } from './build-config.js';
import { normalizeServerOrigin, ServerStore } from './servers.js';
import { WIN32_GPU_MIN_VRAM_MB } from './speech-models.js';
import { TrustedOriginController, type TrustedWindowLike } from './trust.js';
import type { PcAppAutoUpdaterController } from './auto-updater.js';
import {
  createPcAppDownloadController,
  type PcAppDownloadController,
  type PcAppDownloadSaveDialogResult,
} from './download-ipc.js';
import {
  createPcAppVoiceController,
  type PcAppIpcInvokeEventLike,
  type PcAppIpcMainLike,
  type PcAppVoiceControllerDeps,
} from './voice-ipc.js';

export const DOCS_HELP_URL = 'https://docs.im.codes';

export interface ShellWindowLike extends TrustedWindowLike {
  on(event: 'closed', listener: () => void): unknown;
  isMinimized?(): boolean;
  isFocused?(): boolean;
  restore?(): void;
  show?(): void;
  focus?(): void;
  webContents: TrustedWindowLike['webContents'] & SecurityWebContentsLike & {
    session: SecuritySessionLike & {
      cookies?: CookiesChangeEventLike;
      clearStorageData?(options?: { origin?: string }): Promise<void>;
    };
    on(event: 'did-navigate', listener: () => void): unknown;
    on(event: 'did-finish-load', listener: () => void): unknown;
    on(event: 'focus', listener: () => void): unknown;
    reload(): void;
    reloadIgnoringCache(): void;
    toggleDevTools(): void;
    executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
    send?(channel: string, ...args: unknown[]): void;
  };
}

export interface PcAppShellDeps {
  platform: NodeJS.Platform;
  appName: string;
  userDataDir: string;
  preloadPath?: string;
  ipcMain?: PcAppIpcMainLike;
  autoUpdater?: PcAppAutoUpdaterController | null;
  voiceDeps?: Partial<
    Pick<
      PcAppVoiceControllerDeps,
      | 'resourcesPath'
      | 'speechHelperPath'
      | 'mlxHelperPath'
      | 'speechModelsDir'
      | 'arch'
      | 'getMediaAccessStatus'
      | 'askForMediaAccess'
      | 'openSystemUrl'
      | 'runHelperSync'
      | 'runHelperAsync'
      | 'spawnHelper'
      | 'buildDevHelper'
      | 'isMlxSupported'
      | 'fetchModel'
      | 'mirrorOrigins'
      | 'customMirrors'
      | 'manifests'
      | 'locale'
      | 'timeZone'
      | 'onSpeechModelStatusChanged'
      | 'onInputDevicesChanged'
      | 'onVoiceEvent'
      | 'useResidentMlxWorker'
    >
  >;
  createMainWindow: (options: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    title: string;
    webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES & { preload?: string; backgroundThrottling?: boolean };
  }) => ShellWindowLike;
  createPromptWindow: PromptWindowFactory;
  setApplicationMenu: (template: MenuItemOptionsLike[]) => void;
  openExternal: (url: string) => Promise<void> | void;
  showSaveDialogSync: (win: ShellWindowLike, defaultPath: string) => string | undefined;
  showSaveDialog?: (sender: unknown, options: { defaultPath: string }) => Promise<PcAppDownloadSaveDialogResult>;
  showItemInFolder?: (filePath: string) => Promise<void> | void;
  getDefaultDownloadsDir?: () => string;
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
  focusApp?: () => void;
  promptAddServer?: () => Promise<ServerPromptInput | null>;
  detectLocalBoundOrigin?: () => string | { origin: string; label?: string } | null;
  welcomeLocale?: string;
  localeDefaultServers?: readonly LocaleDefaultServerRule[];
  onLocaleChanged?: (locale: PcAppLocale) => void;
  onOpenSettings?: () => void;
  onCheckForUpdates?: () => void;
  getGlobalVoiceEnabled?: () => boolean;
  onToggleGlobalVoice?: (enabled: boolean) => void;
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
  voice: ReturnType<typeof createPcAppVoiceController>;
  downloads: PcAppDownloadController;
  getLocale: () => PcAppLocale;
  getWindow: () => ShellWindowLike | null;
  getMainWindow: () => ShellWindowLike | null;
  ensureWindow: () => Promise<ShellWindowLike>;
  focusWindow: () => Promise<ShellWindowLike | null>;
  showServerPicker: () => Promise<void>;
  addAndSelectServer: (rawUrl: string, label?: string) => Promise<string>;
  selectServer: (origin: string) => Promise<string>;
  removeServer: (origin: string) => Promise<boolean>;
  rebuildMenu: () => void;
  checkLaunchAgent: () => Promise<LaunchAgentIssue>;
  dispose: () => Promise<void>;
}

/**
 * Create and manage the Electron PC App V1 window, server list switcher,
 * §4.7 security guards, and Phase B extension seams.
 */
export function createPcAppShell(deps: PcAppShellDeps): PcAppShellInstance {
  const store = new ServerStore(deps.userDataDir);
  const localeStore = new PcAppLocaleStore(deps.userDataDir);
  let lastPersistedLocale: PcAppLocale | null = localeStore.load();
  let activeLocale: PcAppLocale =
    lastPersistedLocale ?? normalizePcAppLocale(deps.welcomeLocale ?? Intl.DateTimeFormat().resolvedOptions().locale);
  let mainWindow: ShellWindowLike | null = null;
  const controller = new TrustedOriginController(store, () => mainWindow);
  const bind = new BindCoordinator({
    keptBindingStorePath: path.join(deps.userDataDir, 'kept-bindings.json'),
    ...(deps.bindDeps ?? {}),
    platform: deps.platform,
    locale: activeLocale,
    getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
    onDidNavigateTrustedOrigin: (listener) => controller.onDidNavigateTrustedOrigin(listener),
    showMessageBox: async (options) => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : await ensureWindow();
      return deps.showMessageBox(win, options);
    },
    showNotification: deps.showNotification ?? (() => {}),
    onStateChanged: () => rebuildMenu(),
  });

  const openExternalSafely = (url: string) => {
    if (isAllowedExternalUrl(url, deps.externalDocsHosts)) {
      return Promise.resolve(deps.openExternal(url)).catch(() => {});
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
        locale: activeLocale,
        ...(deps.localeDefaultServers ? { localeDefaultServers: deps.localeDefaultServers } : {}),
        ...extra,
      }),
    );
  };

  const applyLocale = async (nextLocale: PcAppLocale, persist = true) => {
    if (persist && nextLocale !== lastPersistedLocale) {
      localeStore.save(nextLocale);
      lastPersistedLocale = nextLocale;
    }
    if (nextLocale === activeLocale) return;
    activeLocale = nextLocale;
    bind.setLocale(activeLocale);
    deps.onLocaleChanged?.(activeLocale);
    rebuildMenu();
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      controller.getActiveOrigin() === null &&
      mainWindow.webContents.getURL().startsWith('data:text/html')
    ) {
      await loadWelcomeScreen(mainWindow);
    }
  };

  const syncLocaleFromOriginCookies = async (origin: string) => {
    const win = mainWindow;
    const cookiesApi = win && !win.isDestroyed() ? win.webContents.session.cookies : undefined;
    if (!cookiesApi) return;
    try {
      const found = await cookiesApi.get({ url: origin, name: PC_APP_LOCALE_COOKIE });
      const matching = found.find(
        (c) =>
          c.name === PC_APP_LOCALE_COOKIE &&
          Boolean(c.value) &&
          (!c.domain || sameOriginNamedCookie(c, origin, PC_APP_LOCALE_COOKIE)),
      );
      if (!matching?.value) return;
      const parsed = parseLocaleCookieValue(matching.value);
      if (parsed) {
        await applyLocale(parsed, true);
      }
    } catch {
      // Ignore transient session cookie read failures.
    }
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
    const promptFn =
      deps.promptAddServer ??
      (() => openAddServerPrompt(deps.createPromptWindow, { locale: activeLocale }));
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
        title: tPcApp(activeLocale, 'dialog.removeServer.title'),
        message: tPcApp(activeLocale, 'dialog.removeServer.message', { origin }),
        buttons: [
          tPcApp(activeLocale, 'common.cancel'),
          tPcApp(activeLocale, 'common.remove'),
        ],
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

  const handleOpenSettings = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!controller.currentTrustedOrigin()) return;
    void mainWindow.webContents
      .executeJavaScript?.('window.dispatchEvent(new CustomEvent("imcodes:open-settings"))', true)
      ?.catch(() => {});
  };

  const rebuildMenu = () => {
    const template = buildAppMenuTemplate({
      platform: deps.platform,
      appName: deps.appName,
      locale: activeLocale,
      servers: store.list(),
      activeOrigin: controller.getActiveOrigin(),
      boundServer: bind.getBoundSummary(),
      speechModelStatus: voice?.getSpeechModelStatusSync(),
      onSelectSpeechModel: (model) => {
        void (async () => {
          let nextModel = model;
          if (deps.platform === 'win32' && model === 'qwen3-1.7b') {
            const st = voice.getSpeechModelStatusSync();
            const vramMb = st.vramMb;
            if (typeof vramMb === 'number' && vramMb < WIN32_GPU_MIN_VRAM_MB && mainWindow && !mainWindow.isDestroyed()) {
              const vramLabel = vramMb > 0 ? `${(vramMb / 1024).toFixed(1)} GB (${st.gpuName ?? 'GPU'})` : '0 GB (CPU)';
              const { response } = await deps.showMessageBox(mainWindow, {
                type: 'warning',
                title: tPcApp(activeLocale, 'menu.voice.lowVramDialog.title'),
                message: tPcApp(activeLocale, 'menu.voice.lowVramDialog.message', { vram: vramLabel }),
                buttons: [
                  tPcApp(activeLocale, 'menu.voice.lowVramDialog.cancel'),
                  tPcApp(activeLocale, 'menu.voice.lowVramDialog.confirm'),
                ],
                defaultId: 0,
                cancelId: 0,
              });
              if (response !== 1) {
                nextModel = 'qwen3-0.6b';
              }
            }
          }
          await voice.setSpeechModel(nextModel);
          rebuildMenu();
        })();
      },
      inputDevices: voice?.getInputDevicesSync(),
      selectedInputDevice: voice?.getSelectedInputDevice(),
      onSelectInputDevice: (uid) => {
        voice.setSelectedInputDevice(uid);
        rebuildMenu();
      },
      onRefreshInputDevices: () => {
        void voice.getInputDevices().then(() => rebuildMenu());
      },
      onOpenMicTest: () => {
        void micTest.open();
      },
      globalVoiceEnabled: deps.getGlobalVoiceEnabled?.(),
      onToggleGlobalVoice: deps.onToggleGlobalVoice,
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
      onOpenDocs: () => void openExternalSafely(DOCS_HELP_URL),
      onOpenSettings: deps.onOpenSettings ?? handleOpenSettings,
      onCheckForUpdates: deps.onCheckForUpdates,
      settingsEnabled: Boolean(controller.currentTrustedOrigin()),
    });
    deps.setApplicationMenu(template);
  };

  const voice = createPcAppVoiceController({
    platform: deps.platform,
    userDataDir: deps.userDataDir,
    resourcesPath: deps.voiceDeps?.resourcesPath ?? deps.bindDeps?.resourcesPath,
    isMainWebContents: (sender) => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === sender),
    getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
    getActiveOrigin: () => controller.getActiveOrigin(),
    getTrustedOrigins: () => store.trustedOrigins(),
    getLocalBoundServerId: () => bind.getBoundServerIdForOrigin(controller.currentTrustedOrigin()),
    getSenderUrl: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : ''),
    sendToRenderer: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send?.(channel, payload);
      }
    },
    onSpeechModelStatusChanged: () => rebuildMenu(),
    onInputDevicesChanged: () => rebuildMenu(),
    ...(deps.voiceDeps ?? {}),
  });
  const micTest = createPcAppMicTestController({
    getMainWindow: () => mainWindow,
    getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
    getLocale: () => activeLocale,
    stopListening: (options) => voice.stopListening({ ...options, source: 'in-app' }),
  });
  const allowedDownloadWebContents = new Set<unknown>();
  const downloads = createPcAppDownloadController({
    isAllowedWebContents: (sender) => {
      if (allowedDownloadWebContents.has(sender)) return true;
      return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === sender);
    },
    getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
    getActiveOrigin: () => controller.getActiveOrigin(),
    getTrustedOrigins: () => store.trustedOrigins(),
    getSenderUrl: (sender) => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents === sender) {
        return mainWindow.webContents.getURL();
      }
      return '';
    },
    getDefaultDownloadsDir: deps.getDefaultDownloadsDir,
    showSaveDialog: async (sender, options) => {
      if (deps.showSaveDialog) {
        return deps.showSaveDialog(sender, options);
      }
      if (!mainWindow || mainWindow.isDestroyed()) {
        return { canceled: true };
      }
      const chosen = deps.showSaveDialogSync(mainWindow, options.defaultPath);
      return chosen ? { canceled: false, filePath: chosen } : { canceled: true };
    },
    showItemInFolder: async (filePath) => {
      await deps.showItemInFolder?.(filePath);
    },
  });
  const isTrustedMainWindowSender = (event: PcAppIpcInvokeEventLike): boolean => {
    const sender = event?.sender;
    if (!sender || typeof sender !== 'object') return false;
    if (typeof (sender as { isDestroyed?: unknown }).isDestroyed === 'function' && (sender as { isDestroyed: () => boolean }).isDestroyed()) {
      return false;
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== sender) return false;
    if (!controller.currentTrustedOrigin()) return false;
    const activeOrigin = controller.getActiveOrigin();
    const trustedOrigins = store.trustedOrigins();
    if (!activeOrigin || !trustedOrigins.has(activeOrigin)) return false;
    const frameUrl = typeof event.senderFrame?.url === 'string' ? event.senderFrame.url : '';
    const wcUrl = mainWindow.webContents.getURL();
    if (!frameUrl && !wcUrl) return false;
    if (frameUrl && !isSameActiveOrigin(frameUrl, activeOrigin, trustedOrigins)) return false;
    if (wcUrl && !isSameActiveOrigin(wcUrl, activeOrigin, trustedOrigins)) return false;
    return true;
  };
  if (deps.ipcMain) {
    voice.registerIpc(deps.ipcMain);
    downloads.registerIpc(deps.ipcMain);
    deps.autoUpdater?.registerIpc(deps.ipcMain, isTrustedMainWindowSender);
  }
  if (deps.platform === 'darwin' || deps.platform === 'win32') {
    void voice.getSpeechModelStatus().then(() => rebuildMenu());
    void voice.warmSelectedSpeechModel();
    void voice.getInputDevices();
  }

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
      webPreferences: deps.preloadPath
        ? { ...MAIN_WINDOW_WEB_PREFERENCES, backgroundThrottling: false, preload: deps.preloadPath }
        : { ...MAIN_WINDOW_WEB_PREFERENCES, backgroundThrottling: false },
    });
    mainWindow = win;

    attachWindowSecurityGuards({
      webContents: win.webContents,
      session: win.webContents.session,
      getActiveOrigin: () => controller.getActiveOrigin(),
      getTrustedOrigins: () => controller.trustedOrigins(),
      getCurrentTrustedOrigin: () => controller.currentTrustedOrigin(),
      openExternal: openExternalSafely,
      promptSavePathSync: (suggestedFilename) => {
        if (!mainWindow || mainWindow.isDestroyed()) return null;
        return deps.showSaveDialogSync(mainWindow, suggestedFilename) ?? null;
      },
      onTrustedMediaPermissionRequest: () => voice.ensureMediaAccessOnWebPermissionRequest(),
      onWebContentsAdded: (wc) => {
        allowedDownloadWebContents.add(wc);
      },
      onWebContentsRemoved: (wc) => {
        allowedDownloadWebContents.delete(wc);
        void downloads.cleanupWebContents(wc);
      },
      onWebContentsNavigatedAway: (wc) => {
        void downloads.cleanupWebContents(wc);
      },
      preloadPath: deps.preloadPath,
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
            if (!isDefaultServerOrigin(origin, activeLocale, deps.localeDefaultServers)) {
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
      void voice.stopRemoteSession({ sessionId: '*', abort: true });
      if (!controller.currentTrustedOrigin()) {
        void voice.stopListening({ abort: true });
      }
      void downloads.cleanupOriginMismatch(controller.currentTrustedOrigin());
      rebuildMenu();
    });

    (win.webContents as { on?: (event: string, listener: () => void) => unknown }).on?.('render-process-gone', () => {
      void voice.stopRemoteSession({ sessionId: '*', abort: true });
    });

    win.webContents.on('did-finish-load', () => {
      const origin = controller.currentTrustedOrigin();
      if (origin) {
        void syncLocaleFromOriginCookies(origin);
      }
    });

    win.webContents.on('focus', () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized?.()) {
        win.restore?.();
      }
    });

    if (win.webContents.session.cookies) {
      bind.attachCookies(win.webContents.session.cookies);
      win.webContents.session.cookies.on('changed', (_event, cookie, _cause, removed) => {
        if (removed) return;
        const origin = controller.currentTrustedOrigin();
        if (!origin) return;
        if (!sameOriginNamedCookie(cookie, origin, PC_APP_LOCALE_COOKIE)) return;
        const parsed = parseLocaleCookieValue(cookie.value);
        if (parsed) {
          void applyLocale(parsed, true);
        }
      });
    }

    controller.onDidNavigateTrustedOrigin((origin) => {
      void syncLocaleFromOriginCookies(origin);
    });

    win.on('closed', () => {
      // Closing the window only cleans up window-scoped state; voice stays alive
      // across macOS window closes and is disposed by shell.dispose() on app quit.
      void micTest.dispose();
      void voice.stopRemoteSession({ sessionId: '*', abort: true });
      void downloads.cleanupOriginMismatch(null);
      allowedDownloadWebContents.clear();
      if (mainWindow === win) {
        mainWindow = null;
      }
    });

    rebuildMenu();
    await loadWelcomeOrLastServer(win);
    rebuildMenu();
    return win;
  };

  const focusWindow = async (): Promise<ShellWindowLike | null> => {
    const win = await ensureWindow();
    if (win.isDestroyed()) return null;
    if (win.isMinimized?.()) {
      win.restore?.();
    }
    win.show?.();
    win.focus?.();
    deps.focusApp?.();
    return win;
  };

  let disposePromise: Promise<void> | null = null;
  const dispose = async (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      allowedDownloadWebContents.clear();
      mainWindow = null;
      await Promise.allSettled([
        micTest.dispose(),
        voice.dispose(),
        downloads.dispose(),
      ]);
      if (deps.ipcMain) {
        voice.unregisterIpc(deps.ipcMain);
        downloads.unregisterIpc(deps.ipcMain);
        deps.autoUpdater?.unregisterIpc(deps.ipcMain);
      }
    })();
    return disposePromise;
  };

  return {
    store,
    controller,
    bind,
    voice,
    downloads,
    getLocale: () => activeLocale,
    getWindow: () => mainWindow,
    getMainWindow: () => mainWindow,
    ensureWindow,
    focusWindow,
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
    dispose,
  };
}
