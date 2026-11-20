import type { BoundServerSummary } from './bind.js';
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
          label: 'No servers saved',
          enabled: false,
        },
      ];

  const removeSubmenu: MenuItemOptionsLike[] = servers.map((srv) => ({
    id: `remove:${srv.origin}`,
    label: formatServerLabel(srv),
    click: () => onRemoveServer(srv.origin),
  }));

  const serverMenu: MenuItemOptionsLike = {
    label: 'Server',
    submenu: [
      ...serverItems,
      { type: 'separator' },
      ...(onSwitchServer
        ? [{
            id: 'server:switch',
            label: 'Switch Server…',
            accelerator: 'CmdOrCtrl+Shift+S',
            click: onSwitchServer,
          } satisfies MenuItemOptionsLike]
        : []),
      {
        id: 'server:add',
        label: 'Add Server…',
        accelerator: 'CmdOrCtrl+Shift+N',
        click: onAddServer,
      },
      {
        id: 'server:remove-menu',
        label: 'Remove Server',
        enabled: servers.length > 0,
        submenu: removeSubmenu,
      },
      { type: 'separator' },
      {
        id: 'server:bind-fallback',
        label: boundServer
          ? `Rebind Machine (${boundServer.serverName} · ${boundServer.workerUrl})…`
          : 'Bind This Machine…',
        enabled: Boolean(activeOrigin),
        click: onBindFallback,
      },
      {
        id: 'server:clear-session',
        label: 'Clear Current Server Session',
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
        { role: 'about' },
        { type: 'separator' },
        {
          id: 'app:settings',
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          enabled: settingsEnabled ?? Boolean(activeOrigin),
          click: () => onOpenSettings?.(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push(
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { id: 'view:reload', label: 'Reload', accelerator: 'CmdOrCtrl+R', click: onReload },
        { id: 'view:force-reload', label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: onForceReload },
        { id: 'view:devtools', label: 'Toggle Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: onToggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    serverMenu,
    {
      label: 'Window',
      submenu: platform === 'darwin'
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
    {
      label: 'Help',
      submenu: [
        {
          id: 'help:docs',
          label: 'IM.codes Documentation',
          click: onOpenDocs,
        },
      ],
    },
  );

  return template;
}
