import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { ApiKeyManager } from '../components/ApiKeyManager.js';
import { ServerList } from '../components/ServerList.js';
import { GettingStarted } from '../components/GettingStarted.js';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';
import { VoiceLanguageSwitcher } from '../components/VoiceLanguageSwitcher.js';
import { PasskeyManager } from '../components/PasskeyManager.js';
import { DeleteAccount } from '../components/DeleteAccount.js';
import { SharedEntriesPanel } from '../components/SharedEntriesPanel.js';
import { apiFetch, type SharedEntrySummary } from '../api.js';

type DashboardTab = 'devices' | 'keys' | 'account';

interface Props {
  servers?: ServerInfo[];
  onSelectServer: (serverId: string, serverName: string) => void;
  onDeleteServer?: (server: ServerInfo) => void;
  onLogout: () => void;
  onOpenUsageSummary: () => void;
  onServersLoaded?: (servers: ServerInfo[]) => void;
  sharedEntries: SharedEntrySummary[];
  sharedEntriesLoading: boolean;
  sharedEntriesLoaded: boolean;
  sharedEntriesError: string | null;
  openingSharedEntryId: string | null;
  onOpenSharedEntry: (entry: SharedEntrySummary) => void;
  onRefreshSharedEntries: () => void;
}

interface ServerInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeatAt: number | null;
  daemonVersion?: string | null;
  latestDaemonVersion?: string | null;
  createdAt: number;
}

interface KeyInfo {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

const TAB_ORDER: DashboardTab[] = ['devices', 'keys', 'account'];

export function DashboardPage({
  servers: externalServers,
  onSelectServer,
  onDeleteServer,
  onLogout,
  onOpenUsageSummary,
  onServersLoaded,
  sharedEntries,
  sharedEntriesLoading,
  sharedEntriesLoaded,
  sharedEntriesError,
  openingSharedEntryId,
  onOpenSharedEntry,
  onRefreshSharedEntries,
}: Props) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<ServerInfo[]>(externalServers ?? []);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<DashboardTab>('devices');
  const [visitedTabs, setVisitedTabs] = useState<Set<DashboardTab>>(() => new Set(['devices']));
  const tabRefs = useRef<Partial<Record<DashboardTab, HTMLButtonElement | null>>>({});

  const selectTab = (nextTab: DashboardTab) => {
    setActiveTab(nextTab);
    setVisitedTabs((prev) => {
      if (prev.has(nextTab)) return prev;
      const next = new Set(prev);
      next.add(nextTab);
      return next;
    });
  };

  useEffect(() => {
    if (externalServers) {
      setServers(externalServers);
    }
  }, [externalServers]);

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

  const showSharedInventory = sharedEntriesLoading
    || sharedEntriesError !== null
    || sharedEntries.length > 0;
  const showGettingStarted = servers.length === 0
    && sharedEntriesLoaded
    && !sharedEntriesLoading
    && sharedEntriesError === null
    && sharedEntries.length === 0;
  const devicesBadgeCount = servers.length + sharedEntries.length;
  const activeKeysCount = keys.filter((k) => !k.revokedAt).length;

  const tabs: { id: DashboardTab; label: string; badge?: number }[] = [
    { id: 'devices', label: t('dashboard.tabs.devices'), badge: devicesBadgeCount },
    { id: 'keys', label: t('dashboard.tabs.api_keys'), badge: activeKeysCount },
    { id: 'account', label: t('dashboard.tabs.account') },
  ];

  const handleTabKeyDown = (current: DashboardTab, e: KeyboardEvent) => {
    const currentIndex = TAB_ORDER.indexOf(current);
    if (currentIndex === -1) return;
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % TAB_ORDER.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = TAB_ORDER.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const nextTab = TAB_ORDER[nextIndex];
    selectTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  return (
    <div class="dashboard-page">
      <header class="dashboard-header">
        <div class="dashboard-brand">
          <h1 class="dashboard-title">IM.codes</h1>
          <p class="dashboard-subtitle">{t('dashboard.subtitle')}</p>
        </div>
        <div class="dashboard-header-actions">
          <button type="button" class="btn btn-secondary dashboard-header-btn" onClick={onOpenUsageSummary}>
            {t('usageSummary.title')}
          </button>
          <LanguageSwitcher />
          <VoiceLanguageSwitcher />
          <button type="button" class="btn btn-secondary dashboard-header-btn" onClick={onLogout}>
            {t('dashboard.logout')}
          </button>
        </div>
      </header>

      {loading ? (
        <div class="dashboard-loading">{t('common.loading')}</div>
      ) : (
        <>
          <div class="dashboard-tabs" role="tablist" aria-label={t('dashboard.tabs.label')}>
            {tabs.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(el) => { tabRefs.current[tab.id] = el; }}
                  type="button"
                  role="tab"
                  id={`dashboard-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`dashboard-tabpanel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  class={`dashboard-tab${selected ? ' is-active' : ''}`}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(e) => handleTabKeyDown(tab.id, e)}
                >
                  <span class="dashboard-tab-label">{tab.label}</span>
                  {tab.badge !== undefined && (
                    <span class="dashboard-tab-badge">{tab.badge}</span>
                  )}
                </button>
              );
            })}
          </div>

          {visitedTabs.has('devices') && (
            <div
              role="tabpanel"
              id="dashboard-tabpanel-devices"
              aria-labelledby="dashboard-tab-devices"
              hidden={activeTab !== 'devices'}
              aria-hidden={activeTab !== 'devices'}
              class="dashboard-tabpanel"
            >
              <div class="dashboard-section-stack">
                {servers.length > 0 && (
                  <ServerList servers={servers} onSelectServer={onSelectServer} onDeleteServer={onDeleteServer} />
                )}
                {showSharedInventory && (
                  <SharedEntriesPanel
                    entries={sharedEntries}
                    loading={sharedEntriesLoading}
                    error={sharedEntriesError}
                    openingEntryId={openingSharedEntryId}
                    onOpen={onOpenSharedEntry}
                    onRefresh={onRefreshSharedEntries}
                  />
                )}
                {showGettingStarted && (
                  <GettingStarted keys={keys} onKeyCreated={loadData} onDeviceAppeared={loadData} />
                )}
              </div>
            </div>
          )}

          {visitedTabs.has('keys') && (
            <div
              role="tabpanel"
              id="dashboard-tabpanel-keys"
              aria-labelledby="dashboard-tab-keys"
              hidden={activeTab !== 'keys'}
              aria-hidden={activeTab !== 'keys'}
              class="dashboard-tabpanel"
            >
              <ApiKeyManager keys={keys} onKeysChanged={loadData} />
            </div>
          )}

          {visitedTabs.has('account') && (
            <div
              role="tabpanel"
              id="dashboard-tabpanel-account"
              aria-labelledby="dashboard-tab-account"
              hidden={activeTab !== 'account'}
              aria-hidden={activeTab !== 'account'}
              class="dashboard-tabpanel"
            >
              <div class="dashboard-section-stack">
                <PasskeyManager />
                <DeleteAccount onDeleted={onLogout} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
