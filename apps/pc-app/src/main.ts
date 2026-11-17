import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { createPcAppShell } from './shell.js';

export async function startPcApp(): Promise<void> {
  await app.whenReady();

  const pcShell = createPcAppShell({
    platform: process.platform,
    appName: 'IM.codes',
    userDataDir: app.getPath('userData'),
    createMainWindow: (opts) => new BrowserWindow(opts),
    createPromptWindow: (opts) => {
      const parent = pcShell.getWindow();
      return new BrowserWindow({
        ...opts,
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
  });

  await pcShell.ensureWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void pcShell.ensureWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

void startPcApp();
