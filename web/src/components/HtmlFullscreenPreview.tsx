import { createPortal } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { HtmlSafePreview } from './HtmlSafePreview.js';

export type HtmlFullscreenPreviewState =
  | { status: 'loading'; path: string }
  | { status: 'ok'; path: string; content: string | null }
  | { status: 'error'; path: string; error: string };

interface HtmlFullscreenPreviewProps {
  preview: HtmlFullscreenPreviewState | null;
  onClose: () => void;
}

export function HtmlFullscreenPreview({ preview, onClose }: HtmlFullscreenPreviewProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!preview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, preview]);

  if (!preview) return null;

  return createPortal((
    <div
      class="html-fullscreen-preview"
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.html_preview_title')}
    >
      <button
        type="button"
        class="html-fullscreen-preview-close"
        onClick={onClose}
        title={t('common.close')}
        aria-label={t('common.close')}
      >
        ✕
      </button>
      <div class="html-fullscreen-preview-body">
        {preview.status === 'loading' && (
          <div class="html-fullscreen-preview-status">{t('file_browser.preview_loading')}</div>
        )}
        {preview.status === 'error' && (
          <div class="html-fullscreen-preview-status html-fullscreen-preview-error">
            {preview.error}
          </div>
        )}
        {preview.status === 'ok' && (
          <HtmlSafePreview path={preview.path} content={preview.content} />
        )}
      </div>
    </div>
  ), document.body);
}
