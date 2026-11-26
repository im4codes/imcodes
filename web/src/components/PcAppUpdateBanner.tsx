import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  getPcAppBridge,
  isPcAppShellOutdated,
  type PcAppAutoUpdateStatus,
} from '../native-platform.js';

const OUTDATED_DISMISSED_STORAGE_KEY = 'imcodes_pc_app_outdated_dismissed';

interface Props {
  onOpenDownloads: () => void;
}

function readOutdatedDismissed(): boolean {
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(OUTDATED_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOutdatedDismissed(): void {
  try {
    sessionStorage?.setItem(OUTDATED_DISMISSED_STORAGE_KEY, '1');
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

export function PcAppUpdateBanner({ onOpenDownloads }: Props) {
  const { t } = useTranslation();
  const bridge = getPcAppBridge();
  const updater = bridge?.updater;
  const canRestartAndInstall = typeof updater?.quitAndInstall === 'function';
  const canRetryCheck = typeof updater?.checkForUpdates === 'function';
  const outdatedShell = isPcAppShellOutdated();

  const [status, setStatus] = useState<PcAppAutoUpdateStatus | null>(null);
  const [dismissedDownloadVersion, setDismissedDownloadVersion] = useState<string | null>(null);
  const [deferredReadyVersion, setDeferredReadyVersion] = useState<string | null>(null);
  const [dismissedErrorText, setDismissedErrorText] = useState<string | null>(null);
  const [outdatedDismissed, setOutdatedDismissed] = useState<boolean>(() => readOutdatedDismissed());
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!updater) {
      setStatus(null);
      setRestarting(false);
      return;
    }
    let cancelled = false;
    const applyStatus = (next: PcAppAutoUpdateStatus | null | undefined) => {
      if (cancelled || !next) return;
      setStatus(next);
      if (next.state !== 'downloaded') {
        setRestarting(false);
      }
    };
    void updater.getStatus?.().then(applyStatus).catch(() => {});
    const unsubscribe = updater.subscribe?.(applyStatus);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [updater]);

  const liveStatus = updater && status && status.enabled && status.state !== 'unavailable' ? status : null;

  if (liveStatus) {
    if (liveStatus.state === 'downloaded' && canRestartAndInstall) {
      const version = liveStatus.downloadedVersion ?? liveStatus.availableVersion ?? 'latest';
      if (deferredReadyVersion === version) return null;
      return (
        <aside
          class="pc-app-update-banner is-downloaded"
          role="status"
          aria-live="polite"
          data-testid="pc-app-update-banner"
          data-update-state="downloaded"
        >
          <div class="pc-app-update-copy">
            <div class="pc-app-update-title">
              {t('pc_app_update.downloaded_title', { version })}
            </div>
            <div class="pc-app-update-body">
              {t('pc_app_update.downloaded_body', { version })}
            </div>
          </div>
          <div class="pc-app-update-actions">
            <button
              type="button"
              class="btn btn-primary pc-app-update-primary"
              data-testid="pc-app-update-restart"
              disabled={restarting}
              onClick={() => {
                if (restarting) return;
                setRestarting(true);
                void Promise.resolve(updater.quitAndInstall?.()).then((startedInstall) => {
                  if (startedInstall === false) setRestarting(false);
                }).catch(() => {
                  setRestarting(false);
                });
              }}
            >
              {restarting ? t('pc_app_update.restarting') : t('pc_app_update.restart_and_update')}
            </button>
            <button
              type="button"
              class="btn pc-app-update-secondary"
              data-testid="pc-app-update-later"
              onClick={() => setDeferredReadyVersion(version)}
            >
              {t('pc_app_update.later')}
            </button>
          </div>
        </aside>
      );
    }

    if (liveStatus.state === 'available' || liveStatus.state === 'downloading') {
      const version = liveStatus.availableVersion ?? 'latest';
      if (dismissedDownloadVersion === version) return null;
      const percent = Math.max(0, Math.min(100, Math.round(liveStatus.progress?.percent ?? 0)));
      return (
        <aside
          class="pc-app-update-banner is-downloading"
          role="status"
          aria-live="polite"
          data-testid="pc-app-update-banner"
          data-update-state={liveStatus.state}
        >
          <div class="pc-app-update-copy">
            <div class="pc-app-update-title">
              {t('pc_app_update.downloading_title', { version })}
            </div>
            <div class="pc-app-update-body">
              {t('pc_app_update.downloading_body', { version, percent })}
            </div>
            <div
              class="pc-app-update-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div class="pc-app-update-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
          <div class="pc-app-update-actions">
            <button
              type="button"
              class="btn pc-app-update-secondary"
              data-testid="pc-app-update-dismiss"
              onClick={() => setDismissedDownloadVersion(version)}
            >
              {t('pc_app_update.dismiss')}
            </button>
          </div>
        </aside>
      );
    }

    if (liveStatus.state === 'error') {
      const errorText = liveStatus.error?.trim() || 'unknown';
      if (dismissedErrorText === errorText) return null;
      return (
        <aside
          class="pc-app-update-banner is-error"
          role="alert"
          data-testid="pc-app-update-banner"
          data-update-state="error"
        >
          <div class="pc-app-update-copy">
            <div class="pc-app-update-title">{t('pc_app_update.error_title')}</div>
            <div class="pc-app-update-body">{t('pc_app_update.error_body', { error: errorText })}</div>
          </div>
          <div class="pc-app-update-actions">
            {canRetryCheck && (
              <button
                type="button"
                class="btn btn-primary pc-app-update-primary"
                data-testid="pc-app-update-retry"
                onClick={() => {
                  setDismissedErrorText(null);
                  void updater.checkForUpdates?.();
                }}
              >
                {t('pc_app_update.retry')}
              </button>
            )}
            <button
              type="button"
              class="btn pc-app-update-secondary"
              data-testid="pc-app-update-reinstall"
              onClick={onOpenDownloads}
            >
              {t('pc_app_update.reinstall')}
            </button>
            <button
              type="button"
              class="btn pc-app-update-secondary"
              data-testid="pc-app-update-dismiss"
              onClick={() => setDismissedErrorText(errorText)}
            >
              {t('pc_app_update.dismiss')}
            </button>
          </div>
        </aside>
      );
    }
  }

  if (outdatedShell && !outdatedDismissed) {
    return (
      <aside
        class="pc-app-update-banner is-outdated"
        role="status"
        aria-live="polite"
        data-testid="pc-app-update-banner"
        data-update-state="outdated"
      >
        <div class="pc-app-update-copy">
          <div class="pc-app-update-title">{t('pc_app_update.outdated_title')}</div>
          <div class="pc-app-update-body">{t('pc_app_update.outdated_body')}</div>
        </div>
        <div class="pc-app-update-actions">
          <button
            type="button"
            class="btn btn-primary pc-app-update-primary"
            data-testid="pc-app-update-download-latest"
            onClick={onOpenDownloads}
          >
            {t('pc_app_update.download_latest')}
          </button>
          <button
            type="button"
            class="btn pc-app-update-secondary"
            data-testid="pc-app-update-later"
            onClick={() => {
              writeOutdatedDismissed();
              setOutdatedDismissed(true);
            }}
          >
            {t('pc_app_update.later')}
          </button>
        </div>
      </aside>
    );
  }

  return null;
}
