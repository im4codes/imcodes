import { useState, useEffect } from 'preact/hooks';
import { ApiKeyManager } from '../components/ApiKeyManager.js';
import { ServerList } from '../components/ServerList.js';
import { GettingStarted } from '../components/GettingStarted.js';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
import { PasskeyManager } from '../components/PasskeyManager.js';
import { DeleteAccount } from '../components/DeleteAccount.js';
import { apiFetch } from '../api.js';

interface Props {
  onSelectServer: (serverId: string, serverName: string) => void;
  onLogout: () => void;
  onServersLoaded?: (servers: ServerInfo[]) => void;
}

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  createdAt: number;
}

interface KeyInfo {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export function DashboardPage({ onSelectServer, onLogout, onServersLoaded }: Props) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    try {
      const [serverRes, keyRes] = await Promise.all([
        apiFetch<{ servers: ServerInfo[] }>('/api/server'),
        apiFetch<{ keys: KeyInfo[] }>('/api/auth/user/me/keys'),
      ]);
      setServers(serverRes.servers);
      onServersLoaded?.(serverRes.servers);
      setKeys(keyRes.keys);
    } catch (err) {
      console.error('Failed to load dashboard data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>IM.codes</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <LanguageSwitcher />
          <button class="btn btn-secondary" style={{ fontSize: 12 }} onClick={onLogout}>Log Out</button>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#64748b' }}>Loading...</div>
      ) : (
        <>
          {servers.length === 0 ? (
            <GettingStarted keys={keys} onKeyCreated={loadData} onDeviceAppeared={loadData} />
          ) : (
            <ServerList servers={servers} onSelectServer={onSelectServer} />
          )}
          <ApiKeyManager keys={keys} onKeysChanged={loadData} />
          <PasskeyManager />
          <DeleteAccount onDeleted={onLogout} />
        </>
      )}
    </div>
  );
}
