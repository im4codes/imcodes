import type { BoundServerSummary } from './bind.js';
import {
  normalizePcAppLocale,
  tPcApp,
  type PcAppLocale,
  type PcAppMessageKey,
} from './i18n.js';
import type { SavedServer } from './servers.js';

export interface MenuItemOptionsLike {
  id?: string;
  label?: string;
  role?: string;
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
  accelerator?: string;
  click?: () => void;
  submenu?: MenuItemOptionsLike[];
}

export interface AppMenuOptions {
  platform: NodeJS.Platform;
  appName: string;
  locale?: PcAppLocale | string;
  servers: SavedServer[];
  activeOrigin: string | null;
  boundServer?: BoundServerSummary | null;
  onSelectServer: (origin: string) => void;
  onAddServer: () => void;
  onSwitchServer?: () => void;
  onRemoveServer: (origin: string) => void;
  onReload: () => void;
  onForceReload: () => void;
  onToggleDevTools: () => void;
  onClearSession: () => void;
  onBindFallback: () => void;
  onOpenDocs: () => void;
  onOpenSettings?: () => void;
  settingsEnabled?: boolean;
}

function formatServerLabel(server: SavedServer): string {
  return server.label ? `${server.label} (${server.origin})` : server.origin;
}

/**
 * Build the native Electron application menu with the V1 server switcher,
 * edit/view shortcuts, Phase B bind fallback entry, and allowlisted docs link.
 */
export function buildAppMenuTemplate(options: AppMenuOptions): MenuItemOptionsLike[] {
  const {
    platform,
    appName,
    servers,
    activeOrigin,
    boundServer,
    onSelectServer,
    onAddServer,
    onSwitchServer,
    onRemoveServer,
    onReload,
    onForceReload,
    onToggleDevTools,
    onClearSession,
    onBindFallback,
    onOpenDocs,
    onOpenSettings,
    settingsEnabled,
  } = options;

  const locale = normalizePcAppLocale(options.locale);
  const t = (key: PcAppMessageKey, vars?: Record<string, string | number>) => tPcApp(locale, key, vars);

  const serverItems: MenuItemOptionsLike[] = servers.length > 0
    ? servers.map((srv) => ({
        id: `server:${srv.origin}`,
        label: formatServerLabel(srv),
        type: 'radio',
        checked: srv.origin === activeOrigin,
        click: () => onSelectServer(srv.origin),
      }))
    : [
        {
          id: 'server:none',
          label: t('menu.server.none'),
          enabled: false,
        },
      ];

  const removeSubmenu: MenuItemOptionsLike[] = servers.map((srv) => ({
    id: `remove:${srv.origin}`,
    label: formatServerLabel(srv),
    click: () => onRemoveServer(srv.origin),
  }));

  const serverMenu: MenuItemOptionsLike = {
    label: t('menu.server.label'),
    submenu: [
      ...serverItems,
      { type: 'separator' },
      ...(onSwitchServer
        ? [{
            id: 'server:switch',
            label: t('menu.server.switch'),
            accelerator: 'CmdOrCtrl+Shift+S',
            click: onSwitchServer,
          } satisfies MenuItemOptionsLike]
        : []),
      {
        id: 'server:add',
        label: t('menu.server.add'),
        accelerator: 'CmdOrCtrl+Shift+N',
        click: onAddServer,
      },
      {
        id: 'server:remove-menu',
        label: t('menu.server.remove'),
        enabled: servers.length > 0,
        submenu: removeSubmenu,
      },
      { type: 'separator' },
      {
        id: 'server:bind-fallback',
        label: boundServer
          ? t('menu.server.rebind', {
              serverName: boundServer.serverName,
              workerUrl: boundServer.workerUrl,
            })
          : t('menu.server.bind'),
        enabled: Boolean(activeOrigin),
        click: onBindFallback,
      },
      {
        id: 'server:clear-session',
        label: t('menu.server.clearSession'),
        enabled: Boolean(activeOrigin),
        click: onClearSession,
      },
    ],
  };

  const template: MenuItemOptionsLike[] = [];

  if (platform === 'darwin') {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: t('menu.app.about', { appName }) },
        { type: 'separator' },
        {
          id: 'app:settings',
          label: t('menu.app.settings'),
          accelerator: 'CmdOrCtrl+,',
          enabled: settingsEnabled ?? Boolean(activeOrigin),
          click: () => onOpenSettings?.(),
        },
        { type: 'separator' },
        { role: 'services', label: t('menu.app.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.app.hide', { appName }) },
        { role: 'hideOthers', label: t('menu.app.hideOthers') },
        { role: 'unhide', label: t('menu.app.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.app.quit', { appName }) },
      ],
    });
  }

  template.push(
    {
      label: t('menu.edit.label'),
      submenu: [
        { role: 'undo', label: t('menu.edit.undo') },
        { role: 'redo', label: t('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.edit.cut') },
        { role: 'copy', label: t('menu.edit.copy') },
        { role: 'paste', label: t('menu.edit.paste') },
        { role: 'selectAll', label: t('menu.edit.selectAll') },
      ],
    },
    {
      label: t('menu.view.label'),
      submenu: [
        { id: 'view:reload', label: t('menu.view.reload'), accelerator: 'CmdOrCtrl+R', click: onReload },
        { id: 'view:force-reload', label: t('menu.view.forceReload'), accelerator: 'CmdOrCtrl+Shift+R', click: onForceReload },
        { id: 'view:devtools', label: t('menu.view.devTools'), accelerator: 'Alt+CmdOrCtrl+I', click: onToggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.view.resetZoom') },
        { role: 'zoomIn', label: t('menu.view.zoomIn') },
        { role: 'zoomOut', label: t('menu.view.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.view.toggleFullScreen') },
      ],
    },
    serverMenu,
    {
      label: t('menu.window.label'),
      submenu: platform === 'darwin'
        ? [
            { role: 'minimize', label: t('menu.window.minimize') },
            { role: 'zoom', label: t('menu.window.zoom') },
            { type: 'separator' },
            { role: 'front', label: t('menu.window.front') },
          ]
        : [
            { role: 'minimize', label: t('menu.window.minimize') },
            { role: 'close', label: t('menu.window.close') },
          ],
    },
    {
      label: t('menu.help.label'),
      submenu: [
        {
          id: 'help:docs',
          label: t('menu.help.docs'),
          click: onOpenDocs,
        },
      ],
    },
  );

  return template;
}
