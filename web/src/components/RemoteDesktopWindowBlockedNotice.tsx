import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { subscribeRemoteDesktopWindowBlocked } from '../remote-desktop-window-notice.js';
import { RemoteDesktopInstallEntry } from './RemoteDesktopInstallEntry.js';

/** How long the notice stays when nobody closes it: long enough to read the advice and click the install entry. */
export const REMOTE_DESKTOP_WINDOW_BLOCKED_NOTICE_MS = 15_000;

/**
 * The one place that tells the user a remote desktop window was blocked. Mounted once per page (the main app and the standalone windows);
 * every opener publishes through remote-desktop-window-notice.ts, so the three buttons that used to fail silently need no code of their own.
 * The advice is the two ways out: allow pop-ups for this site, or install the remote desktop as an app (an app window is not a pop-up).
 */
export function RemoteDesktopWindowBlockedNotice() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
    const unsubscribe = subscribeRemoteDesktopWindowBlocked(() => {
      setVisible(true);
      clear();
      timer.current = setTimeout(() => setVisible(false), REMOTE_DESKTOP_WINDOW_BLOCKED_NOTICE_MS);
    });
    return () => { unsubscribe(); clear(); };
  }, []);

  if (!visible) return null;
  return (
    <div class="remote-desktop-window-blocked" role="alert" data-testid="remote-desktop-window-blocked">
      <span class="remote-desktop-window-blocked-text">{t('remote_desktop.window_blocked')}</span>
      <RemoteDesktopInstallEntry buttonClass="remote-desktop-window-blocked-install" />
      <button
        type="button"
        class="remote-desktop-window-blocked-dismiss"
        aria-label={t('remote_desktop.window_blocked_dismiss')}
        onClick={() => setVisible(false)}
      >×</button>
    </div>
  );
}
