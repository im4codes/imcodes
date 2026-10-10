import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { isServerOnline } from '../server-selection.js';
import type { SharedStateSummary } from '../tab-sharing-ui.js';
import { SharedStateIndicator } from './SharedStateIndicator.js';
import { isDaemonUpgradeAvailable } from '@shared/daemon-upgrade.js';
import { buildServerIconLabels } from '@shared/server-icon-label.js';

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  daemonVersion?: string | null;
  latestDaemonVersion?: string | null;
  createdAt: number;
}

interface Props {
  servers: ServerInfo[];
  activeServerId: string | null;
  onSelectServer: (id: string, name: string) => void;
  onServerContextMenu?: (server: ServerInfo, x: number, y: number) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onSettings?: () => void;
  onHome?: () => void;
  isAdmin?: boolean;
  onAdmin?: () => void;
  sharedServerStates?: ReadonlyMap<string, SharedStateSummary>;
  returnHintServerId?: string | null;
}

export function ServerIconBar({ servers, activeServerId, onSelectServer, onServerContextMenu, sidebarCollapsed, onToggleSidebar, onSettings, onHome, isAdmin, onAdmin, sharedServerStates, returnHintServerId = null }: Props) {
  const { t } = useTranslation();
  // One short label per server, unique across the list; recomputed when a server is added, renamed or removed.
  const namesKey = servers.map((server) => server.name).join('\u0000');
  const labels = useMemo(() => buildServerIconLabels(servers.map((server) => server.name)), [namesKey]);

  return (
    <div class="server-icon-bar" role="navigation" aria-label={t('sidebar.serverNav')}>
      {/* Sidebar toggle — always visible */}
      {onToggleSidebar && (
        <button
          class="server-icon sidebar-toggle-icon"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
        >
          {sidebarCollapsed ? '☰' : '‹'}
        </button>
      )}
      {servers.map((server, index) => {
        const label = labels[index]!;
        const isActive = server.id === activeServerId;
        const isOnline = isServerOnline(server);
        const sharedState = sharedServerStates?.get(server.id) ?? null;
        return (
          <button
            key={server.id}
            class={`server-icon server-icon-server${isActive ? ' server-icon-active' : ''}${server.id === returnHintServerId ? ' server-icon-return-hint' : ''}`}
            title={server.name}
            aria-label={server.name}
            aria-pressed={isActive}
            onClick={() => onSelectServer(server.id, server.name)}
            onContextMenu={(e: MouseEvent) => { e.preventDefault(); onServerContextMenu?.(server, e.clientX, e.clientY); }}
          >
            <span class={`server-icon-letter server-icon-label-${label.size}`} aria-hidden="true">
              {label.lines.map((line, lineIndex) => <span key={lineIndex} class="server-icon-line">{line}</span>)}
            </span>
            <SharedStateIndicator state={sharedState} iconOnly variant="shared-out" />
            {isDaemonUpgradeAvailable(server.daemonVersion, server.latestDaemonVersion) && (
              <span class="server-icon-upgrade" aria-label={t('server.daemon_upgrade_available')} title={t('server.daemon_upgrade_available')}>↥</span>
            )}
            <span
              class="server-icon-dot"
              style={{ background: isOnline ? '#4ade80' : '#475569' }}
              aria-hidden="true"
            />
          </button>
        );
      })}

      {/* Spacer — push bottom icons down */}
      <div style={{ flex: 1 }} />

      {/* Bottom icons: admin, settings, home */}
      {isAdmin && onAdmin && (
        <button class="server-icon" onClick={onAdmin} title={t('common.admin', 'Admin')}>
          🛡
        </button>
      )}
      {onSettings && (
        <button class="server-icon" onClick={onSettings} title={t('common.settings', 'Settings')}>
          ⚙
        </button>
      )}
      {onHome && (
        <button class="server-icon" onClick={onHome} title={t('common.home', 'Home')}>
          ⌂
        </button>
      )}
    </div>
  );
}
