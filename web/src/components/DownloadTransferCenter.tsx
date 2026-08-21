import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  DOWNLOAD_TRANSFER_STATUS,
  cancelDownloadTransfer,
  clearFinishedDownloadTransfers,
  dismissDownloadTransfer,
  getDownloadTransfers,
  subscribeDownloadTransfers,
  type DownloadTransferItem,
} from '../download-transfer-store.js';
import { formatTransferBytes } from '../util/transfer-format.js';

const DOWNLOAD_NAME_MIDDLE_ELLIPSIS_THRESHOLD = 36;
const DOWNLOAD_NAME_TRAILING_CHARACTERS = 20;

function splitDownloadName(name: string): { leading: string; trailing: string | null } {
  const characters = Array.from(name);
  if (characters.length <= DOWNLOAD_NAME_MIDDLE_ELLIPSIS_THRESHOLD) {
    return { leading: name, trailing: null };
  }
  return {
    leading: characters.slice(0, -DOWNLOAD_NAME_TRAILING_CHARACTERS).join(''),
    trailing: characters.slice(-DOWNLOAD_NAME_TRAILING_CHARACTERS).join(''),
  };
}

function terminal(item: DownloadTransferItem): boolean {
  return item.status === DOWNLOAD_TRANSFER_STATUS.HANDED_OFF
    || item.status === DOWNLOAD_TRANSFER_STATUS.COMPLETED
    || item.status === DOWNLOAD_TRANSFER_STATUS.CANCELED
    || item.status === DOWNLOAD_TRANSFER_STATUS.FAILED;
}

export function DownloadTransferCenter() {
  const { t } = useTranslation();
  const [items, setItems] = useState(getDownloadTransfers);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const sync = () => setItems(getDownloadTransfers());
    const unsubscribe = subscribeDownloadTransfers(sync);
    sync();
    return unsubscribe;
  }, []);
  if (items.length === 0) return null;

  const running = items.filter((item) => !terminal(item)).length;
  const hasFinished = items.some(terminal);
  return (
    <section class="download-transfer-center" aria-label={t('downloads.title')}>
      <header class="download-transfer-header">
        <button
          type="button"
          class="download-transfer-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          title={t(collapsed ? 'downloads.expand' : 'downloads.collapse')}
        >
          <span class="download-transfer-title-icon" aria-hidden="true">⇩</span>
          <span class="download-transfer-title">{t('downloads.title')}</span>
          {running > 0 && <span class="download-transfer-count">{running}</span>}
          <span aria-hidden="true">{collapsed ? '▴' : '▾'}</span>
        </button>
        {hasFinished && !collapsed && (
          <button type="button" class="download-transfer-clear" onClick={clearFinishedDownloadTransfers}>
            {t('downloads.clear_finished')}
          </button>
        )}
      </header>
      {!collapsed && (
        <div class="download-transfer-list" aria-live="polite">
          {items.map((item) => {
            const isTerminal = terminal(item);
            const knownTotal = item.totalBytes !== null && item.totalBytes > 0;
            const percent = knownTotal ? Math.min(100, Math.round((item.loadedBytes / item.totalBytes!) * 100)) : null;
            const displayName = splitDownloadName(item.name);
            return (
              <article class="download-transfer-row" key={item.id} data-status={item.status}>
                <div class="download-transfer-row-heading">
                  <span class="download-transfer-name" title={item.name} data-testid="download-transfer-name">
                    <span class="download-transfer-name-leading">{displayName.leading}</span>
                    {displayName.trailing !== null && (
                      <span class="download-transfer-name-trailing">{displayName.trailing}</span>
                    )}
                  </span>
                  <span class={`download-transfer-route route-${item.route}`}>{t(`downloads.route.${item.route}`)}</span>
                </div>
                <div class="download-transfer-status-line">
                  <span>{t(`downloads.status.${item.status}`)}</span>
                  {percent !== null && <span>{percent}%</span>}
                </div>
                {!isTerminal && (
                  <div
                    class={`download-transfer-progress${knownTotal ? '' : ' indeterminate'}`}
                    role="progressbar"
                    aria-label={t('downloads.progress_aria', { name: item.name })}
                    aria-valuemin={knownTotal ? 0 : undefined}
                    aria-valuemax={knownTotal ? 100 : undefined}
                    aria-valuenow={percent ?? undefined}
                  >
                    {knownTotal && <span style={{ width: `${percent}%` }} />}
                    {!knownTotal && <span />}
                  </div>
                )}
                <div class="download-transfer-details">
                  <span>
                    {item.totalBytes === null
                      ? formatTransferBytes(item.loadedBytes)
                      : t('downloads.transferred', {
                        transferred: formatTransferBytes(item.loadedBytes),
                        total: formatTransferBytes(item.totalBytes),
                      })}
                  </span>
                  {!isTerminal && (
                    <span>{item.speedBps > 0
                      ? t('downloads.speed', { speed: formatTransferBytes(item.speedBps) })
                      : t('downloads.speed_calculating')}</span>
                  )}
                </div>
                <div class="download-transfer-actions">
                  {isTerminal ? (
                    <button type="button" onClick={() => dismissDownloadTransfer(item.id)}>{t('downloads.dismiss')}</button>
                  ) : (
                    <button type="button" onClick={() => cancelDownloadTransfer(item.id)}>{t('downloads.cancel')}</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
