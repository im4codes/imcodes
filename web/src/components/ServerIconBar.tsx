import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { getServerPresence } from '../unified-server-projection.js';
import type { SharedStateSummary } from '../tab-sharing-ui.js';
import type { SharedEntrySummary } from '../api.js';
import { SharedStateIndicator } from './SharedStateIndicator.js';
import { PushStatusBadge } from './PushStatusBadge.js';
import { isDaemonUpgradeAvailable } from '@shared/daemon-upgrade.js';
import { buildServerIconLabels } from '@shared/server-icon-label.js';

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  daemonVersion?: string | null;
  latestDaemonVersion?: string | null;
  createdAt?: number;
  isSharedIn?: boolean;
  sharedEntry?: SharedEntrySummary;
}

interface Props {
  servers: ServerInfo[];
  activeServerId: string | null;
  onSelectServer: (id: string, name: string) => void;
  onOpenSharedEntry?: (entry: SharedEntrySummary) => void;
  onServerContextMenu?: (server: ServerInfo, x: number, y: number) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onSettings?: () => void;
  onHome?: () => void;
  isAdmin?: boolean;
  onAdmin?: () => void;
  sharedServerStates?: ReadonlyMap<string, SharedStateSummary>;
  returnHintServerId?: string | null;
  pinnedServerIds?: ReadonlySet<string>;
  pushEnabledServerIds?: ReadonlySet<string>;
}

export function ServerIconBar({
  servers,
  activeServerId,
  onSelectServer,
  onOpenSharedEntry,
  onServerContextMenu,
  sidebarCollapsed,
  onToggleSidebar,
  onSettings,
  onHome,
  isAdmin,
  onAdmin,
  sharedServerStates,
  returnHintServerId = null,
  pinnedServerIds,
  pushEnabledServerIds,
}: Props) {
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
        const presence = getServerPresence(server);
        const presenceColor = presence === 'online' ? '#4ade80' : presence === 'offline' ? '#475569' : '#94a3b8';
        const presenceLabel = presence === 'online'
          ? t('server.online', { defaultValue: 'Online' })
          : presence === 'offline'
            ? t('server.offline', { defaultValue: 'Offline' })
            : t('server.status_unknown', { defaultValue: 'Status unknown' });
        const sharedState = sharedServerStates?.get(server.id) ?? null;
        const isPinned = pinnedServerIds?.has(server.id) ?? false;
        const isSharedIn = Boolean(server.isSharedIn);
        return (
          <button
            key={server.id}
            class={`server-icon server-icon-server${isActive ? ' server-icon-active' : ''}${server.id === returnHintServerId ? ' server-icon-return-hint' : ''}${isSharedIn ? ' server-icon-shared-in' : ''}`}
            title={server.name}
            aria-label={server.name}
            aria-pressed={isActive}
            onClick={() => {
              if (isSharedIn) {
                if (server.sharedEntry && onOpenSharedEntry) {
                  onOpenSharedEntry(server.sharedEntry);
                }
                return;
              }
              onSelectServer(server.id, server.name);
            }}
            onContextMenu={(e: MouseEvent) => {
              e.preventDefault();
              if (!isSharedIn) {
                onServerContextMenu?.(server, e.clientX, e.clientY);
              }
            }}
          >
            <span class={`server-icon-letter server-icon-label-${label.size}`} aria-hidden="true">
              {label.lines.map((line, lineIndex) => <span key={lineIndex} class="server-icon-line">{line}</span>)}
            </span>
            <span
              class="server-icon-accessible-name"
              style={{
                position: 'absolute',
                width: 1,
                height: 1,
                padding: 0,
                margin: -1,
                overflow: 'hidden',
                clip: 'rect(0,0,0,0)',
                whiteSpace: 'nowrap',
                border: 0,
              }}
            >
              {server.name}
            </span>
            {isPinned && (
              <span
                class="server-icon-pin"
                aria-label={t('session.pinned', { defaultValue: 'Pinned' })}
                title={t('session.pinned', { defaultValue: 'Pinned' })}
              >
                📌
              </span>
            )}
            {isSharedIn ? (
              <SharedStateIndicator variant="shared-in" iconOnly />
            ) : (
              <SharedStateIndicator state={sharedState} iconOnly variant="shared-out" />
            )}
            {!isSharedIn && isDaemonUpgradeAvailable(server.daemonVersion, server.latestDaemonVersion) && (
              <span class="server-icon-upgrade" aria-label={t('server.daemon_upgrade_available')} title={t('server.daemon_upgrade_available')}>↥</span>
            )}
            {!isSharedIn && pushEnabledServerIds && (
              <PushStatusBadge enabled={pushEnabledServerIds.has(server.id)} />
            )}
            <span
              class={`server-icon-dot server-icon-dot-${presence}`}
              style={{ background: presenceColor }}
              title={presenceLabel}
              aria-label={presenceLabel}
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
