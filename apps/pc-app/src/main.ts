import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Notification,
  screen,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import electronUpdater from 'electron-updater';
import { createPcAppAutoUpdater } from './auto-updater.js';
import { createPcAppGlobalVoice, type PcAppGlobalVoiceController } from './global-voice.js';
import { tPcApp } from './i18n.js';
import { createPcAppShell, type PcAppShellInstance } from './shell.js';
import { createPcAppVoiceHud } from './voice-hud.js';

function resolveRuntimeIconPath(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '../../build/icon.png'),
    join(process.resourcesPath ?? '', 'build', 'icon.png'),
  ];
  return candidates.find((p) => existsSync(p));
}

function resolveRuntimePreloadPath(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(moduleDir, 'preload.cjs');
  return existsSync(candidate) ? candidate : undefined;
}

export async function startPcApp(): Promise<void> {
  await app.whenReady();

  const appVersion = app.getVersion();
  if (appVersion) {
    process.env.IMCODES_PC_APP_VERSION = appVersion;
  }

  const runtimeIconPath = resolveRuntimeIconPath();
  if (process.platform === 'darwin' && runtimeIconPath && !app.isPackaged) {
    app.dock?.setIcon(runtimeIconPath);
  }

  let shellInstance: PcAppShellInstance | null = null;
  let globalVoice: PcAppGlobalVoiceController | null = null;
  const voiceHud = createPcAppVoiceHud({
    getLocale: () => shellInstance?.getLocale() ?? app.getLocale(),
    getWebContents: () => shellInstance?.getMainWindow()?.webContents ?? null,
  });
  const autoUpdaterController = createPcAppAutoUpdater({
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: appVersion,
    updater: app.isPackaged ? electronUpdater.autoUpdater : undefined,
    getLocale: () => shellInstance?.getLocale() ?? app.getLocale(),
    showMessageBox: async (options) => {
      const win = shellInstance?.getMainWindow() as unknown as BrowserWindow | null;
      if (win && !win.isDestroyed()) {
        return dialog.showMessageBox(win, options);
      }
      return dialog.showMessageBox(options);
    },
    sendToRenderer: (channel, payload) => {
      if (!shellInstance?.controller.currentTrustedOrigin()) return;
      const win = shellInstance.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send?.(channel, payload);
      }
    },
  });

  const pcShell = createPcAppShell({
    platform: process.platform,
    appName: 'IM.codes',
    userDataDir: app.getPath('userData'),
    welcomeLocale: app.getLocale(),
    preloadPath: resolveRuntimePreloadPath(),
    ipcMain,
    autoUpdater: autoUpdaterController,
    onLocaleChanged: (locale) => voiceHud.setLocale(locale),
    onCheckForUpdates: () => {
      void autoUpdaterController.checkForUpdatesManual();
    },
    getGlobalVoiceEnabled: () => globalVoice?.isEnabled() ?? true,
    onToggleGlobalVoice: (enabled) => {
      void globalVoice?.setEnabled(enabled).then((nextEnabled) => {
        if (nextEnabled && process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
          promptAccessibilityPermission(false);
        }
      });
    },
    voiceDeps: {
      resourcesPath: process.resourcesPath,
      speechModelsDir: join(app.getPath('appData'), 'imcodes-pc-app', 'speech-models'),
      locale: app.getLocale(),
      getMediaAccessStatus: process.platform === 'darwin'
        ? (mediaType) => systemPreferences.getMediaAccessStatus(mediaType)
        : undefined,
      askForMediaAccess: process.platform === 'darwin'
        ? (mediaType) => systemPreferences.askForMediaAccess(mediaType)
        : undefined,
      openSystemUrl: (url) => shell.openExternal(url),
      useResidentMlxWorker: true,
      onVoiceEvent: (ev) => voiceHud.handleEvent(ev),
    },
    createMainWindow: (opts) =>
      new BrowserWindow({
        ...opts,
        ...(runtimeIconPath ? { icon: runtimeIconPath } : {}),
      }),
    createPromptWindow: (opts) => {
      const parent = pcShell.getWindow();
      return new BrowserWindow({
        ...opts,
        ...(runtimeIconPath ? { icon: runtimeIconPath } : {}),
        ...(parent && !parent.isDestroyed() ? { parent: parent as unknown as BrowserWindow } : {}),
      });
    },
    setApplicationMenu: (template) => {
      const menu = Menu.buildFromTemplate(template as MenuItemConstructorOptions[]);
      Menu.setApplicationMenu(menu);
    },
    openExternal: (url) => shell.openExternal(url),
    showSaveDialogSync: (win, defaultPath) =>
      dialog.showSaveDialogSync(win as unknown as BrowserWindow, { defaultPath }),
    getDefaultDownloadsDir: () => app.getPath('downloads'),
    showSaveDialog: async (sender, { defaultPath }) => {
      const ownerWin =
        BrowserWindow.fromWebContents(sender as WebContents) ??
        (pcShell.getMainWindow() as unknown as BrowserWindow | null);
      const res = ownerWin && !ownerWin.isDestroyed()
        ? await dialog.showSaveDialog(ownerWin, { defaultPath })
        : await dialog.showSaveDialog({ defaultPath });
      return { canceled: res.canceled, filePath: res.filePath };
    },
    showItemInFolder: (filePath) => {
      shell.showItemInFolder(filePath);
    },
    showMessageBox: (win, options) =>
      dialog.showMessageBox(win as unknown as BrowserWindow, options),
    showNotification: ({ title, body }) => {
      if (Notification.isSupported()) {
        const notification = new Notification({ title, body });
        notification.on('click', () => {
          void pcShell.focusWindow();
        });
        notification.show();
      }
    },
    focusApp: () => {
      if (process.platform === 'darwin') {
        app.focus({ steal: true });
      } else {
        app.focus();
      }
    },
    bindDeps: {
      resourcesPath: process.resourcesPath,
    },
  });

  shellInstance = pcShell;
  voiceHud.setLocale(pcShell.getLocale());

  const ACCESSIBILITY_SETTINGS_URL =
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  let lastAccessibilityPromptAt = 0;
  function promptAccessibilityPermission(copiedToClipboard: boolean): void {
    if (process.platform !== 'darwin') return;
    const now = Date.now();
    if (now - lastAccessibilityPromptAt < 30_000) return;
    lastAccessibilityPromptAt = now;
    try {
      systemPreferences.isTrustedAccessibilityClient(true);
    } catch {
      // Ignore prompt errors if Accessibility API is unavailable.
    }
    if (Notification.isSupported()) {
      const locale = pcShell.getLocale();
      const notification = new Notification({
        title: tPcApp(locale, 'globalVoice.accessibilityDenied.title'),
        body: tPcApp(
          locale,
          copiedToClipboard
            ? 'globalVoice.accessibilityDenied.bodyCopied'
            : 'globalVoice.accessibilityDenied.body',
        ),
      });
      notification.on('click', () => {
        void shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
      });
      notification.show();
    }
    void shell.openExternal(ACCESSIBILITY_SETTINGS_URL).catch(() => {});
  }

  globalVoice = createPcAppGlobalVoice({
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    getLocale: () => pcShell.getLocale(),
    getMainWindow: () => pcShell.getMainWindow(),
    getSpeechHelperPath: () => pcShell.voice.getSpeechHelperPath(),
    voice: pcShell.voice,
    createOverlayWindow: (opts) => new BrowserWindow(opts),
    getOverlayWorkArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    onStateChanged: () => pcShell.rebuildMenu(),
    log: (message) => pcShell.voice.appendLog(message),
    onAccessibilityDenied: (text) => {
      if (text) {
        clipboard.writeText(text);
      }
      promptAccessibilityPermission(Boolean(text));
    },
    onUipiDenied: (text) => {
      if (text) {
        clipboard.writeText(text);
      }
      if (Notification.isSupported()) {
        const locale = pcShell.getLocale();
        new Notification({
          title: tPcApp(locale, 'globalVoice.uipiDenied.title'),
          body: tPcApp(locale, 'globalVoice.uipiDenied.bodyCopied'),
        }).show();
      }
    },
  });
  pcShell.rebuildMenu();
  globalVoice.start();

  await pcShell.ensureWindow();
  await pcShell.checkLaunchAgent();
  autoUpdaterController.start();

  app.on('before-quit', () => {
    autoUpdaterController.dispose();
    void globalVoice?.dispose();
    voiceHud.dispose();
    void pcShell.dispose();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void pcShell.ensureWindow();
    } else {
      void pcShell.focusWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

void startPcApp();
