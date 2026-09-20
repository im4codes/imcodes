import { useTranslation } from 'react-i18next';
import { useRef, useState } from 'preact/hooks';
import type { SharedEntrySummary } from '../api.js';
import type { ShareTarget } from '../tab-sharing-ui.js';
import {
  loadSharedEntriesPanelCollapsed,
  saveSharedEntriesPanelCollapsed,
} from '../shared-entries-panel-preference.js';

interface Props {
  entries: SharedEntrySummary[];
  loading?: boolean;
  error?: string | null;
  openingEntryId?: string | null;
  onOpen: (entry: SharedEntrySummary) => void;
  onRefresh: () => void;
}

function targetKindLabelKey(target: ShareTarget): string {
  if (target.kind === 'server') return 'share.sharedWithMe.kind.server';
  if (target.kind === 'main') return 'share.sharedWithMe.kind.tab';
  return 'share.sharedWithMe.kind.subsession';
}

let nextSharedEntriesPanelId = 0;

export function SharedEntriesPanel({ entries, loading = false, error = null, openingEntryId = null, onOpen, onRefresh }: Props) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(loadSharedEntriesPanelCollapsed);
  const bodyId = useRef<string | null>(null);
  if (bodyId.current === null) {
    nextSharedEntriesPanelId += 1;
    bodyId.current = `shared-entries-body-${nextSharedEntriesPanelId}`;
  }
  const canCollapse = !loading && entries.length > 0;

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
            <span class="shared-entries-count">{t('share.sharedWithMe.count', { count: entries.length })}</span>
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
      <div id={bodyId.current} class="shared-entries-body" hidden={canCollapse && collapsed}>
        {loading ? (
          <div class="shared-entries-empty">{t('common.loading')}</div>
        ) : entries.length === 0 ? (
          <div class="shared-entries-empty">{t('share.sharedWithMe.empty')}</div>
        ) : !collapsed && (
          <div class="shared-entries-list">
            {entries.map((entry) => (
              <button
                key={entry.id}
                class="shared-entry-row"
                type="button"
                onClick={() => onOpen(entry)}
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
      </div>
    </section>
  );
}
