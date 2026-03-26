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
}

function getInitial(name: string): string {
  return (name || '?').charAt(0).toUpperCase();
}

export function ServerIconBar({ servers, activeServerId, onSelectServer }: Props) {
  const { t } = useTranslation();

  // Auto-hide when only 1 server configured
  if (servers.length <= 1) return null;

  return (
    <div class="server-icon-bar" role="navigation" aria-label={t('sidebar.serverNav')}>
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
    </div>
  );
}
