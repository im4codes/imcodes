import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { subscribeCloudDocsWindowBlocked } from '../cloud-docs-window-notice.js';

export const CLOUD_DOCS_WINDOW_BLOCKED_NOTICE_MS = 12_000;

/**
 * Surfaces a non-blocking alert when popping Cloud Docs out to a new window is blocked by the browser.
 */
export function CloudDocsWindowBlockedNotice() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const unsubscribe = subscribeCloudDocsWindowBlocked(() => {
      setVisible(true);
      clear();
      timer.current = setTimeout(() => setVisible(false), CLOUD_DOCS_WINDOW_BLOCKED_NOTICE_MS);
    });
    return () => {
      unsubscribe();
      clear();
    };
  }, []);

  if (!visible) return null;

  return (
    <div class="remote-desktop-window-blocked cloud-docs-window-blocked" role="alert" data-testid="cloud-docs-window-blocked">
      <span class="remote-desktop-window-blocked-text">{t('cloud_docs.window_blocked')}</span>
      <button
        type="button"
        class="remote-desktop-window-blocked-dismiss"
        aria-label={t('cloud_docs.window_blocked_dismiss')}
        onClick={() => setVisible(false)}
      >×</button>
    </div>
  );
}
