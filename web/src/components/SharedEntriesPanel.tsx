import { useTranslation } from 'react-i18next';
import type { SharedEntrySummary } from '../api.js';
import type { ShareTarget } from '../tab-sharing-ui.js';

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

export function SharedEntriesPanel({ entries, loading = false, error = null, openingEntryId = null, onOpen, onRefresh }: Props) {
  const { t } = useTranslation();
  return (
    <section class="shared-entries-panel" aria-label={t('share.sharedWithMe.title')}>
      <div class="shared-entries-header">
        <span>{t('share.sharedWithMe.title')}</span>
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
      </div>
      {error && <div class="shared-entries-error" role="alert">{error}</div>}
      {loading ? (
        <div class="shared-entries-empty">{t('common.loading')}</div>
      ) : entries.length === 0 ? (
        <div class="shared-entries-empty">{t('share.sharedWithMe.empty')}</div>
      ) : (
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
    </section>
  );
}
