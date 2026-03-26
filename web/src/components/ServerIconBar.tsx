import { useTranslation } from 'react-i18next';

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
}

interface Props {
  servers: ServerInfo[];
  activeServerId: string | null;
  onSelectServer: (id: string, name: string) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onSettings?: () => void;
  onHome?: () => void;
  isAdmin?: boolean;
  onAdmin?: () => void;
}

function getInitial(name: string): string {
  return (name || '?').charAt(0).toUpperCase();
}

export function ServerIconBar({ servers, activeServerId, onSelectServer, sidebarCollapsed, onToggleSidebar, onSettings, onHome, isAdmin, onAdmin }: Props) {
  const { t } = useTranslation();

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
      {servers.map((server) => {
        const isActive = server.id === activeServerId;
        const isOnline = server.status !== 'offline' && server.lastHeartbeatAt != null && Date.now() - server.lastHeartbeatAt < 60_000;
        return (
          <button
            key={server.id}
            class={`server-icon${isActive ? ' server-icon-active' : ''}`}
            title={server.name}
            aria-label={server.name}
            aria-pressed={isActive}
            onClick={() => onSelectServer(server.id, server.name)}
          >
            <span class="server-icon-letter">{getInitial(server.name)}</span>
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
