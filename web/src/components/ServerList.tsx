import { useTranslation } from 'react-i18next';

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
  onSelectServer: (serverId: string, serverName: string) => void;
  onDeleteServer?: (server: ServerInfo) => void;
}

function isOnline(server: ServerInfo): boolean {
  if (server.status === 'offline') return false;
  if (!server.lastHeartbeatAt) return false;
  return Date.now() - server.lastHeartbeatAt < 2 * 60 * 1000;
}

export function ServerList({ servers, onSelectServer, onDeleteServer }: Props) {
  const { t } = useTranslation();
  if (servers.length === 0) {
    return (
      <div class="dashboard-empty">
        {t('server.list_empty')} <code>imcodes bind &lt;name&gt;</code>
      </div>
    );
  }

  return (
    <section class="dashboard-card">
      <div class="dashboard-card-header">
        <h2 class="dashboard-card-title">{t('server.devices')}</h2>
      </div>
      <div class="dashboard-server-grid">
        {servers.map((s) => {
          const online = isOnline(s);
          return (
            <div key={s.id} class="dashboard-server-card">
              <div class="dashboard-server-card-top">
                <span class="dashboard-server-name">{s.name}</span>
                <span class="dashboard-server-status" style={{ color: online ? '#22c55e' : '#64748b' }}>
                  {online ? `● ${t('server.online')}` : `○ ${t('server.offline')}`}
                </span>
              </div>
              <div class="dashboard-server-date">
                {t('server.added_on', { date: new Date(s.createdAt).toLocaleDateString() })}
              </div>
              {(online || onDeleteServer) && (
                <div class="dashboard-server-actions">
                  {online && (
                    <button class="btn btn-primary" style={{ flex: 1 }} onClick={() => onSelectServer(s.id, s.name)}>
                      {t('serverSetup.connect')}
                    </button>
                  )}
                  {onDeleteServer && (
                    <button
                      type="button"
                      class="btn btn-secondary"
                      data-testid={`delete-server-${s.id}`}
                      style={{
                        flex: online ? '0 0 auto' : 1,
                        color: '#f87171',
                        borderColor: 'rgba(248, 113, 113, 0.35)',
                      }}
                      onClick={() => onDeleteServer(s)}
                    >
                      {t('common.delete')}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
