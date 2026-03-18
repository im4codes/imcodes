interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  createdAt: number;
}

interface Props {
  servers: ServerInfo[];
  onSelectServer: (serverId: string, serverName: string) => void;
}

function isOnline(server: ServerInfo): boolean {
  if (server.status === 'offline') return false;
  if (!server.lastHeartbeatAt) return false;
  return Date.now() - server.lastHeartbeatAt < 2 * 60 * 1000;
}

export function ServerList({ servers, onSelectServer }: Props) {
  if (servers.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#64748b', border: '1px dashed #334155', borderRadius: 8 }}>
        No devices yet. Run <code>imcodes bind &lt;name&gt;</code> to add one.
      </div>
    );
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Devices</h2>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
        {servers.map((s) => {
          const online = isOnline(s);
          return (
            <div key={s.id} style={{ background: '#1e293b', borderRadius: 8, padding: 16, border: '1px solid #334155' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, color: '#e2e8f0' }}>{s.name}</span>
                <span style={{ fontSize: 12, color: online ? '#22c55e' : '#64748b' }}>
                  {online ? '● Online' : '○ Offline'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 12 }}>
                Added {new Date(s.createdAt).toLocaleDateString()}
              </div>
              {online && (
                <button class="btn btn-primary" style={{ width: '100%' }} onClick={() => onSelectServer(s.id, s.name)}>
                  Connect
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
