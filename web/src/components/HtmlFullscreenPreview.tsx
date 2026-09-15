import { createPortal } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { isHtmlPreviewPath } from '@shared/html-preview.js';
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

const HTML_PREVIEW_OBJECT_URL_RELEASE_DELAY_MS = 60_000;

export function openHtmlPreviewInNewWindow(preview: HtmlFullscreenPreviewState): boolean {
  if (preview.status !== 'ok' || typeof preview.content !== 'string'
    || !isHtmlPreviewPath(preview.path)) return false;
  if (typeof URL.createObjectURL !== 'function') return false;
  const result = createSafeHtmlPreviewDocument(preview.content);
  if (result.status !== 'ok') return false;

  const url = URL.createObjectURL(new Blob([result.srcDoc], { type: 'text/html;charset=utf-8' }));
  try {
    // `noopener` in the feature string makes some browsers return null even
    // when they created the window, so it cannot be used when closing the
    // owner depends on confirmed creation. Obtain the handle first, then sever
    // its opener synchronously.
    const opened = window.open(url, '_blank');
    if (!opened) {
      URL.revokeObjectURL(url);
      return false;
    }
    try { opened.opener = null; } catch { /* Browser policy may already isolate it. */ }

    // Owner cleanup must not revoke the token before the new window consumes
    // it. Release on the child's load, with a bounded fallback for browsers
    // that do not expose the cross-window event.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    };
    try { opened.addEventListener('load', release, { once: true }); } catch { /* fallback timer below */ }
    window.setTimeout(release, HTML_PREVIEW_OBJECT_URL_RELEASE_DELAY_MS);
    return true;
  } catch {
    URL.revokeObjectURL(url);
    return false;
  }
}

export function HtmlFullscreenPreview({ preview, onClose }: HtmlFullscreenPreviewProps) {
  const { t } = useTranslation();
  const openingRef = useRef(false);

  useEffect(() => {
    openingRef.current = false;
  }, [preview]);

  useEffect(() => {
    if (!preview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, preview]);

  if (!preview) return null;
  const canOpenInNewWindow = preview.status === 'ok' && typeof preview.content === 'string'
    && isHtmlPreviewPath(preview.path);
  const openInNewWindow = () => {
    if (openingRef.current) return;
    openingRef.current = true;
    if (openHtmlPreviewInNewWindow(preview)) {
      onClose();
      return;
    }
    openingRef.current = false;
  };

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
        onClick={openInNewWindow}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openInNewWindow();
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
