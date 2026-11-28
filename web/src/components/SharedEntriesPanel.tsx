import { useTranslation } from 'react-i18next';
import { useMemo, useRef, useState } from 'preact/hooks';
import type { SharedEntrySummary } from '../api.js';
import type { ShareTarget } from '../tab-sharing-ui.js';
import {
  loadSharedEntriesPanelCollapsed,
  saveSharedEntriesPanelCollapsed,
} from '../shared-entries-panel-preference.js';

export interface GroupParticipantServerSummary {
  id: string;
  name: string;
  isOwner?: boolean;
  blockMyPrivateDevices?: boolean;
}

interface Props {
  entries: SharedEntrySummary[];
  groupServers?: GroupParticipantServerSummary[];
  loading?: boolean;
  error?: string | null;
  openingEntryId?: string | null;
  onOpen: (entry: SharedEntrySummary) => void;
  onRefresh: () => void;
  onTogglePrivateDeviceBlock?: (serverId: string, blockPrivateDevices: boolean) => Promise<void> | void;
}

function targetKindLabelKey(target: ShareTarget): string {
  if (target.kind === 'server') return 'share.sharedWithMe.kind.server';
  if (target.kind === 'main') return 'share.sharedWithMe.kind.tab';
  return 'share.sharedWithMe.kind.subsession';
}

let nextSharedEntriesPanelId = 0;

export function SharedEntriesPanel({
  entries,
  groupServers = [],
  loading = false,
  error = null,
  openingEntryId = null,
  onOpen,
  onRefresh,
  onTogglePrivateDeviceBlock,
}: Props) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(loadSharedEntriesPanelCollapsed);
  const [inFlightOverrides, setInFlightOverrides] = useState<Record<string, boolean>>({});
  const [savingServerId, setSavingServerId] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const bodyId = useRef<string | null>(null);
  if (bodyId.current === null) {
    nextSharedEntriesPanelId += 1;
    bodyId.current = `shared-entries-body-${nextSharedEntriesPanelId}`;
  }

  const participantServers = useMemo(() => {
    const byServer = new Map<string, { serverId: string; serverName: string; blocked: boolean }>();
    for (const entry of entries) {
      if (entry.status !== 'active') continue;
      if (entry.role !== 'participant' && entry.target.kind !== 'server') continue;
      if (byServer.has(entry.serverId)) continue;
      const inFlight = Object.prototype.hasOwnProperty.call(inFlightOverrides, entry.serverId)
        ? inFlightOverrides[entry.serverId]
        : undefined;
      byServer.set(entry.serverId, {
        serverId: entry.serverId,
        serverName: entry.serverName || entry.serverId,
        blocked: inFlight ?? (entry.blockMyPrivateDevices === true),
      });
    }
    for (const srv of groupServers) {
      if (srv.isOwner === true || byServer.has(srv.id)) continue;
      const inFlight = Object.prototype.hasOwnProperty.call(inFlightOverrides, srv.id)
        ? inFlightOverrides[srv.id]
        : undefined;
      byServer.set(srv.id, {
        serverId: srv.id,
        serverName: srv.name || srv.id,
        blocked: inFlight ?? (srv.blockMyPrivateDevices === true),
      });
    }
    return [...byServer.values()];
  }, [entries, groupServers, inFlightOverrides]);

  const hasContent = entries.length > 0 || participantServers.length > 0;
  const canCollapse = !loading && hasContent;

  const togglePrivateDevicePolicy = async (serverId: string, nextBlocked: boolean): Promise<void> => {
    if (savingServerId) return;
    setSavingServerId(serverId);
    setPolicyError(null);
    setInFlightOverrides((prev) => ({ ...prev, [serverId]: nextBlocked }));
    try {
      await onTogglePrivateDeviceBlock?.(serverId, nextBlocked);
    } catch (err) {
      setPolicyError(err instanceof Error ? err.message : String(err || 'policy_update_failed'));
    } finally {
      setInFlightOverrides((prev) => {
        const next = { ...prev };
        delete next[serverId];
        return next;
      });
      setSavingServerId(null);
    }
  };

  const toggleCollapsed = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    saveSharedEntriesPanelCollapsed(next);
  };

  return (
    <section class="shared-entries-panel" aria-label={t('share.sharedWithMe.title')}>
      <div class="shared-entries-header">
        <span class="shared-entries-heading">
          <span class="shared-entries-heading-text">{t('share.sharedWithMe.title')}</span>
          {canCollapse && collapsed && (
            <span class="shared-entries-count">{t('share.sharedWithMe.count', { count: entries.length || participantServers.length })}</span>
          )}
        </span>
        <span class="shared-entries-header-actions">
          {canCollapse && (
            <button
              class="shared-entries-toggle"
              type="button"
              onClick={toggleCollapsed}
              aria-expanded={!collapsed}
              aria-controls={bodyId.current}
              title={t(collapsed ? 'share.sharedWithMe.expand' : 'share.sharedWithMe.collapse')}
              aria-label={t(collapsed ? 'share.sharedWithMe.expand' : 'share.sharedWithMe.collapse')}
            >
              <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            </button>
          )}
          <button
            class="shared-entries-refresh"
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title={t('share.sharedWithMe.refresh')}
            aria-label={t('share.sharedWithMe.refresh')}
          >
            ↻
          </button>
        </span>
      </div>
      {error && <div class="shared-entries-error" role="alert">{error}</div>}
      {policyError && <div class="shared-entries-error" role="alert">{policyError}</div>}
      <div id={bodyId.current} class="shared-entries-body" hidden={canCollapse && collapsed}>
        {loading ? (
          <div class="shared-entries-empty">{t('common.loading')}</div>
        ) : !hasContent ? (
          <div class="shared-entries-empty">{t('share.sharedWithMe.empty')}</div>
        ) : !collapsed && (
          <>
            {entries.length > 0 && (
              <div class="shared-entries-list">
                {entries.map((entry) => (
                  <button
                    key={entry.id}
                    class="shared-entry-row"
                    type="button"
                    onClick={() => {
                      if (openingEntryId === entry.id) return;
                      onOpen(entry);
                    }}
                    disabled={openingEntryId === entry.id}
                  >
                    <span class="shared-entry-main">
                      <span class="shared-entry-title">{entry.targetLabel}</span>
                      <span class="shared-entry-subtitle">{entry.serverName}</span>
                    </span>
                    <span class="shared-entry-meta">
                      <span>{t(targetKindLabelKey(entry.target))}</span>
                      <span>{t(`share.role.${entry.role}`)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {participantServers.length > 0 && (
              <div class={`shared-private-policy-list${entries.length === 0 ? ' is-standalone' : ''}`}>
                {participantServers.map((srv) => (
                  <label
                    key={srv.serverId}
                    class="shared-private-policy-row"
                    data-testid={`shared-private-policy-${srv.serverId}`}
                    title={t('share.privateDeviceBlock.shortHelp', { server: srv.serverName })}
                  >
                    <input
                      type="checkbox"
                      checked={srv.blocked}
                      disabled={savingServerId === srv.serverId}
                      onChange={() => void togglePrivateDevicePolicy(srv.serverId, !srv.blocked)}
                    />
                    <span class="shared-private-policy-text">
                      <span class="shared-private-policy-label">{t('share.privateDeviceBlock.label')}</span>
                      {participantServers.length > 1 && (
                        <span class="shared-private-policy-server">{srv.serverName}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
