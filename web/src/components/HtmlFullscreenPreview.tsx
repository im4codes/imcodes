import { createPortal } from 'preact/compat';
import { useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { HtmlSafePreview } from './HtmlSafePreview.js';
import { createSafeHtmlPreviewDocument } from '../util/html-safe-preview.js';

export type HtmlFullscreenPreviewState =
  | { status: 'loading'; path: string }
  | { status: 'ok'; path: string; content: string | null }
  | { status: 'error'; path: string; error: string };

interface HtmlFullscreenPreviewProps {
  preview: HtmlFullscreenPreviewState | null;
  onClose: () => void;
}

export function openHtmlPreviewInNewWindow(preview: HtmlFullscreenPreviewState): boolean {
  if (preview.status !== 'ok' || typeof preview.content !== 'string') return false;
  if (typeof URL.createObjectURL !== 'function') return false;
  const result = createSafeHtmlPreviewDocument(preview.content);
  if (result.status !== 'ok') return false;

  const url = URL.createObjectURL(new Blob([result.srcDoc], { type: 'text/html;charset=utf-8' }));
  try {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      URL.revokeObjectURL(url);
      return false;
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch {
    URL.revokeObjectURL(url);
    return false;
  }
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
  const canOpenInNewWindow = preview.status === 'ok' && typeof preview.content === 'string';

  return createPortal((
    <div
      class="html-fullscreen-preview"
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.html_preview_title')}
    >
      <button
        type="button"
        class="html-fullscreen-preview-open-window"
        onClick={() => {
          if (openHtmlPreviewInNewWindow(preview)) onClose();
        }}
        disabled={!canOpenInNewWindow}
        title={t('chat.html_preview_open_new_window')}
        aria-label={t('chat.html_preview_open_new_window')}
      >
        ↗
      </button>
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
