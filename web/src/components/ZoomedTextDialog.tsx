/**
 * ZoomedTextDialog — modal that displays a chat message's text content with
 * native text selection enabled. Used on touch devices where the chat view
 * disables `user-select` so that long-press triggers our custom Copy/Quote
 * menu rather than the native callout. Inside this dialog, selection is
 * re-enabled so the user can drag the iOS/Android selection handles to pick
 * out exactly the portion they want to copy.
 *
 * The dialog is intentionally simple: a scrollable `<pre>`-style block with
 * `white-space: pre-wrap`, a "Copy all" button, and a close affordance.
 * The text shown here is produced by `domNodeToPlainText`, so it already
 * carries the right paragraph/list/code-block structure.
 */
import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { copyToClipboard } from '../util/clipboard.js';

interface Props {
  /** Plain-text content to display. Newlines and indentation are honoured. */
  text: string;
  /** Closes the dialog. */
  onClose: () => void;
}

export function ZoomedTextDialog({ text, onClose }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // Close on Escape — desktop users with keyboards expect this even though
  // the dialog is primarily a mobile-affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = () => {
    copyToClipboard(text, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div
      class="dialog-overlay zoom-text-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        class="zoom-text-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zoom-text-dialog-title"
        onClick={(e: Event) => e.stopPropagation()}
      >
        <div class="zoom-text-header">
          <div class="zoom-text-title" id="zoom-text-dialog-title">{t('chat.zoom_title')}</div>
          <button
            type="button"
            class="zoom-text-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >×</button>
        </div>
        <div class="zoom-text-body">
          <pre class="zoom-text-content">{text}</pre>
        </div>
        <div class="zoom-text-hint">{t('chat.zoom_hint')}</div>
        <div class="zoom-text-actions">
          <button
            type="button"
            class={`zoom-text-btn${copied ? ' is-copied' : ''}`}
            onClick={handleCopy}
          >
            {copied ? t('common.copied') : t('chat.zoom_copy_all')}
          </button>
        </div>
      </div>
    </div>
  );
}
