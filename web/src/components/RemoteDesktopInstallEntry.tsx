import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { usePwaInstall } from '../pwa-install.js';

/**
 * "Install as app": the way to a remote desktop window without an address strip. A pop-up window always keeps a read-only address bar
 * (every mainstream browser, by design, so a page cannot imitate another site's window); only an installed app window does not.
 *
 * Chromium hands the page an install prompt, so one click installs. Everywhere else (Safari, Firefox, anything else, or a Chromium that
 * has not offered the prompt yet) the click opens a short instruction for that browser -- for Firefox an honest note that its windows
 * keep the address bar. Hidden when the page already runs as an installed app.
 */
export function RemoteDesktopInstallEntry({ buttonClass = 'controlled-nodes-wall', compact = false }: { buttonClass?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const install = usePwaInstall();
  const [guideOpen, setGuideOpen] = useState(false);
  if (install.hidden) return null;

  const onClick = async () => {
    if (install.canPrompt) {
      const outcome = await install.prompt();
      // The browser answered by itself (installed, or the user declined): only an unusable prompt falls back to the instruction.
      if (outcome !== 'unavailable') return;
    }
    setGuideOpen((open) => !open);
  };

  return (
    <span class="remote-desktop-install-entry">
      <button
        type="button"
        class={buttonClass}
        data-testid="remote-desktop-install-app"
        aria-expanded={guideOpen}
        title={t('remote_desktop.install_app_hint')}
        aria-label={t('remote_desktop.install_app')}
        onClick={() => { void onClick(); }}
      >
        <span aria-hidden="true">⬇</span>{!compact && t('remote_desktop.install_app')}
      </button>
      {guideOpen && (
        <span class="remote-desktop-install-guide" role="note" data-testid="remote-desktop-install-guide">
          <span>{t(`remote_desktop.install_guide_${install.guidance}`)}</span>
          <button
            type="button"
            class="remote-desktop-install-guide-close"
            aria-label={t('remote_desktop.install_guide_close')}
            onClick={() => setGuideOpen(false)}
          >×</button>
        </span>
      )}
    </span>
  );
}
