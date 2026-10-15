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
      <div style={{ padding: 24, textAlign: 'center', color: '#64748b', border: '1px dashed #334155', borderRadius: 8 }}>
        {t('server.list_empty')} <code>imcodes bind &lt;name&gt;</code>
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>{t('server.devices')}</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {servers.map((s) => {
          const online = isOnline(s);
          return (
            <div key={s.id} style={{ background: '#1e293b', borderRadius: 8, padding: 16, border: '1px solid #334155' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{s.name}</span>
                <span style={{ fontSize: 12, color: online ? '#22c55e' : '#64748b' }}>
                  {online ? `● ${t('server.online')}` : `○ ${t('server.offline')}`}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
                {t('server.added_on', { date: new Date(s.createdAt).toLocaleDateString() })}
              </div>
              {(online || onDeleteServer) && (
                <div style={{ display: 'flex', gap: 8 }}>
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
    </div>
  );
}
