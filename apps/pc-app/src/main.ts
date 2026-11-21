import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
} from 'electron';
import { createPcAppShell } from './shell.js';

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

  const runtimeIconPath = resolveRuntimeIconPath();
  if (process.platform === 'darwin' && runtimeIconPath && !app.isPackaged) {
    app.dock?.setIcon(runtimeIconPath);
  }

  const pcShell = createPcAppShell({
    platform: process.platform,
    appName: 'IM.codes',
    userDataDir: app.getPath('userData'),
    welcomeLocale: app.getLocale(),
    preloadPath: resolveRuntimePreloadPath(),
    ipcMain,
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

  await pcShell.ensureWindow();
  await pcShell.checkLaunchAgent();

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
