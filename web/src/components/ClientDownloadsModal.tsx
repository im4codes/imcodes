import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  buildQrMatrixPath,
  isDownloadApiUrl,
  isPcAppClient,
  openExternalDownloadUrl,
  openPcAppDownloadUrl,
  resolveClientDownloadUrls,
  type AndroidVariant,
} from '../client-downloads.js';
import { isNative } from '../native.js';

interface Props {
  open: boolean;
  onClose: () => void;
}

function AppleLogoSvg() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.96 6.32c.68-.83 1.14-1.98 1.01-3.13-.98.04-2.16.65-2.86 1.47-.63.72-1.18 1.9-1.03 3.02 1.09.09 2.2-.54 2.88-1.36Z" />
    </svg>
  );
}

function WindowsLogoSvg() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M3 3h8.5v8.5H3V3Zm9.5 0H21v8.5h-8.5V3ZM3 12.5h8.5V21H3v-8.5Zm9.5 0H21V21h-8.5v-8.5Z" />
    </svg>
  );
}

function LinuxLogoSvg() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2c-2.2 0-3.6 1.6-3.6 4.1 0 1.3.3 2.3.2 3.1-.1.9-1.3 2.4-2.2 4.1-.8 1.5-1.1 3-.7 4.2.3.8 1 1.3 1.7 1.4-.2.4-.5.9-.5 1.3 0 .8.9 1.3 2.3 1.3 1 0 1.8-.3 2.2-.8h1.2c.4.5 1.2.8 2.2.8 1.4 0 2.3-.5 2.3-1.3 0-.4-.3-.9-.5-1.3.7-.1 1.4-.6 1.7-1.4.4-1.2.1-2.7-.7-4.2-.9-1.7-2.1-3.2-2.2-4.1-.1-.8.2-1.8.2-3.1C15.6 3.6 14.2 2 12 2Zm-1.5 3.4c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9Zm3 0c.4 0 .7.4.7.9s-.3.9-.7.9-.7-.4-.7-.9.3-.9.7-.9ZM12 7.5c1 .1 1.7.5 1.7 1s-.8.9-1.7.9-1.7-.4-1.7-.9.7-.9 1.7-1Zm0 3c1.8 0 3.2 2.1 3.2 4.8 0 1.4-.6 2.5-1.4 3.1-.5.4-1.1.5-1.8.5s-1.3-.1-1.8-.5c-.8-.6-1.4-1.7-1.4-3.1 0-2.7 1.4-4.8 3.2-4.8Z" />
    </svg>
  );
}

function AndroidLogoSvg() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.61 5.95 18 3.55a.45.45 0 0 0-.16-.61.45.45 0 0 0-.61.16L15.81 5.55A8.46 8.46 0 0 0 12 4.72c-1.38 0-2.67.3-3.81.83L6.77 3.1a.45.45 0 0 0-.61-.16.45.45 0 0 0-.16.61l1.39 2.4A7.64 7.64 0 0 0 4 12h16a7.64 7.64 0 0 0-3.39-6.05ZM8.5 9.8a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Zm7 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6ZM4 13v5.5A1.5 1.5 0 0 0 5.5 20H7v2a1.25 1.25 0 0 0 2.5 0v-2h5v2a1.25 1.25 0 0 0 2.5 0v-2h1.5a1.5 1.5 0 0 0 1.5-1.5V13H4Zm-2.25 0A1.25 1.25 0 0 0 .5 14.25v3.5a1.25 1.25 0 0 0 2.5 0v-3.5A1.25 1.25 0 0 0 1.75 13Zm20.5 0A1.25 1.25 0 0 0 21 14.25v3.5a1.25 1.25 0 0 0 2.5 0v-3.5A1.25 1.25 0 0 0 22.25 13Z" />
    </svg>
  );
}

function QrCodeSvg({ value, label, testId }: { value: string; label: string; testId: string }) {
  const qr = useMemo(() => buildQrMatrixPath(value, 3), [value]);
  return (
    <div class="client-downloads-qr-frame" data-testid={testId} data-qr-value={value}>
      <svg
        width="136"
        height="136"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        shape-rendering="crispEdges"
        role="img"
        aria-label={label}
      >
        <rect width={qr.size} height={qr.size} fill="#ffffff" />
        <path d={qr.path} fill="#0f172a" />
      </svg>
    </div>
  );
}

function handleExternalClick(e: MouseEvent, url: string) {
  if (isNative()) {
    e.preventDefault();
    void openExternalDownloadUrl(url);
    return;
  }
  if (isPcAppClient() && isDownloadApiUrl(url)) {
    e.preventDefault();
    void openPcAppDownloadUrl(url);
  }
}

export function ClientDownloadsModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [androidVariant, setAndroidVariant] = useState<AndroidVariant>('fcm');

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const urls = resolveClientDownloadUrls();
  const androidUrl = androidVariant === 'fcm' ? urls.androidFcm : urls.androidNoFcm;

  return (
    <div
      class="dialog-overlay client-downloads-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-downloads-title"
      data-testid="client-downloads-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="dialog client-downloads-dialog">
        <div class="dialog-header client-downloads-header">
          <div>
            <h2 id="client-downloads-title">{t('client_downloads.title')}</h2>
            <p class="client-downloads-subtitle">{t('client_downloads.subtitle')}</p>
          </div>
          <button
            type="button"
            class="dialog-close"
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="client-downloads-close"
          >
            ✕
          </button>
        </div>

        <div class="dialog-body client-downloads-body">
          <section class="client-downloads-section">
            <h3 class="client-downloads-section-title">{t('client_downloads.desktop_section')}</h3>
            <div class="client-downloads-desktop-grid">
              <div class="client-downloads-card" data-platform="macos">
                <div class="client-downloads-card-head">
                  <span class="client-downloads-os-logo client-downloads-os-apple">
                    <AppleLogoSvg />
                  </span>
                  <span class="client-downloads-os-name">{t('client_downloads.mac_title')}</span>
                </div>
                <div class="client-downloads-actions">
                  <a
                    class="client-downloads-btn"
                    href={urls.macArm64}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="download-link-mac-arm64"
                    onClick={(e) => handleExternalClick(e, urls.macArm64)}
                  >
                    {t('client_downloads.mac_arm64')}
                  </a>
                  <a
                    class="client-downloads-btn"
                    href={urls.macIntel}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="download-link-mac-intel"
                    onClick={(e) => handleExternalClick(e, urls.macIntel)}
                  >
                    {t('client_downloads.mac_intel')}
                  </a>
                </div>
              </div>

              <div class="client-downloads-card" data-platform="windows">
                <div class="client-downloads-card-head">
                  <span class="client-downloads-os-logo client-downloads-os-windows">
                    <WindowsLogoSvg />
                  </span>
                  <span class="client-downloads-os-name">{t('client_downloads.win_title')}</span>
                </div>
                <div class="client-downloads-actions">
                  <a
                    class="client-downloads-btn"
                    href={urls.windows}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="download-link-win"
                    onClick={(e) => handleExternalClick(e, urls.windows)}
                  >
                    {t('client_downloads.win_installer')}
                  </a>
                </div>
              </div>

              <div class="client-downloads-card" data-platform="linux">
                <div class="client-downloads-card-head">
                  <span class="client-downloads-os-logo client-downloads-os-linux">
                    <LinuxLogoSvg />
                  </span>
                  <span class="client-downloads-os-name">{t('client_downloads.linux_title')}</span>
                </div>
                <div class="client-downloads-actions">
                  <a
                    class="client-downloads-btn"
                    href={urls.linuxDeb}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="download-link-linux-deb"
                    onClick={(e) => handleExternalClick(e, urls.linuxDeb)}
                  >
                    {t('client_downloads.linux_deb')}
                  </a>
                  <a
                    class="client-downloads-btn"
                    href={urls.linuxSh}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="download-link-linux-sh"
                    onClick={(e) => handleExternalClick(e, urls.linuxSh)}
                  >
                    {t('client_downloads.linux_sh')}
                  </a>
                </div>
              </div>
            </div>
          </section>

          <section class="client-downloads-section">
            <h3 class="client-downloads-section-title">{t('client_downloads.mobile_section')}</h3>
            <div class="client-downloads-mobile-grid">
              <div class="client-downloads-card client-downloads-mobile-card" data-platform="android">
                <div class="client-downloads-card-head">
                  <span class="client-downloads-os-logo client-downloads-os-android">
                    <AndroidLogoSvg />
                  </span>
                  <div class="client-downloads-os-meta">
                    <span class="client-downloads-os-name">{t('client_downloads.android_title')}</span>
                    <span class="client-downloads-os-sub">{t('client_downloads.scan_hint')}</span>
                  </div>
                </div>
                <div class="client-downloads-variant-tabs" role="group" aria-label={t('client_downloads.android_title')}>
                  <button
                    type="button"
                    class={`client-downloads-variant-btn${androidVariant === 'fcm' ? ' active' : ''}`}
                    aria-pressed={androidVariant === 'fcm'}
                    data-testid="android-variant-fcm"
                    onClick={() => setAndroidVariant('fcm')}
                  >
                    {t('client_downloads.android_fcm')}
                  </button>
                  <button
                    type="button"
                    class={`client-downloads-variant-btn${androidVariant === 'no-fcm' ? ' active' : ''}`}
                    aria-pressed={androidVariant === 'no-fcm'}
                    data-testid="android-variant-nofcm"
                    onClick={() => setAndroidVariant('no-fcm')}
                  >
                    {t('client_downloads.android_nofcm')}
                  </button>
                </div>
                <QrCodeSvg
                  value={androidUrl}
                  label={t('client_downloads.android_qr_alt')}
                  testId="download-qr-android"
                />
                <a
                  class="client-downloads-btn client-downloads-btn-full"
                  href={androidUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="download-link-android"
                  onClick={(e) => handleExternalClick(e, androidUrl)}
                >
                  {t('client_downloads.android_download_apk')}
                </a>
              </div>

              <div class="client-downloads-card client-downloads-mobile-card" data-platform="ios">
                <div class="client-downloads-card-head">
                  <span class="client-downloads-os-logo client-downloads-os-apple">
                    <AppleLogoSvg />
                  </span>
                  <div class="client-downloads-os-meta">
                    <span class="client-downloads-os-name">{t('client_downloads.ios_title')}</span>
                    <span class="client-downloads-os-sub">{t('client_downloads.ios_subtitle')}</span>
                  </div>
                </div>
                <QrCodeSvg
                  value={urls.iosAppStore}
                  label={t('client_downloads.ios_qr_alt')}
                  testId="download-qr-ios"
                />
                <a
                  class="client-downloads-btn client-downloads-btn-full"
                  href={urls.iosAppStore}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="download-link-ios"
                  onClick={(e) => handleExternalClick(e, urls.iosAppStore)}
                >
                  {t('client_downloads.ios_open_store')}
                </a>
              </div>
            </div>
          </section>

          <div class="client-downloads-footer">
            <span>{t('client_downloads.archive_note_prefix')} </span>
            <a
              href={urls.githubReleases}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="download-link-github-releases"
              onClick={(e) => handleExternalClick(e, urls.githubReleases)}
            >
              {t('client_downloads.archive_link')}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
