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
import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { positionChatActionMenu } from '../chat-action-menu-position.js';
import { copyToClipboard } from '../util/clipboard.js';
import { selectionToPlainText } from '../util/dom-to-text.js';

interface Props {
  /** Plain-text content to display. Newlines and indentation are honoured. */
  text: string;
  /** Closes the dialog. */
  onClose: () => void;
  /** Quotes the currently selected text back into the composer. */
  onQuote?: (text: string) => void;
}

interface SelectionMenuState {
  text: string;
  x: number;
  y: number;
}

export function ZoomedTextDialog({ text, onClose, onQuote }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLPreElement>(null);

  // Close on Escape — desktop users with keyboards expect this even though
  // the dialog is primarily a mobile-affordance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectionMenu(null);
        return;
      }

      const range = sel.getRangeAt(0);
      const contentEl = contentRef.current;
      const dialogEl = dialogRef.current;
      if (!contentEl || !dialogEl || !contentEl.contains(range.commonAncestorContainer)) {
        setSelectionMenu(null);
        return;
      }

      const selectedText = selectionToPlainText(sel) || sel.toString().trim();
      if (!selectedText) {
        setSelectionMenu(null);
        return;
      }

      const rect = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : null;
      const fallbackRect = contentEl.getBoundingClientRect();
      const anchorClientX = rect && rect.width > 0 ? rect.left + rect.width / 2 : fallbackRect.left + fallbackRect.width / 2;
      const anchorClientY = rect && rect.height > 0 ? rect.top : fallbackRect.top + 12;
      setSelectionMenu({
        ...positionChatActionMenu(anchorClientX, anchorClientY, dialogEl.getBoundingClientRect()),
        text: selectedText,
      });
      setCopied(false);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  const handleCopy = () => {
    copyToClipboard(text, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const handleCopySelection = () => {
    if (!selectionMenu?.text) return;
    copyToClipboard(selectionMenu.text, () => {
      setCopied(true);
      setTimeout(() => {
        setSelectionMenu(null);
        setCopied(false);
      }, 1000);
    });
  };

  const handleQuoteSelection = () => {
    if (!selectionMenu?.text || !onQuote) return;
    onQuote(selectionMenu.text);
    setSelectionMenu(null);
    window.getSelection()?.removeAllRanges();
    onClose();
  };

  return (
    <div
      class="dialog-overlay zoom-text-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
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
          <pre ref={contentRef} class="zoom-text-content">{text}</pre>
        </div>
        {selectionMenu && (
          <div
            class="chat-sel-menu zoom-text-selection-menu"
            style={{ left: `${selectionMenu.x}px`, top: `${selectionMenu.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class={`chat-sel-btn${copied ? ' copied' : ''}`}
              onClick={handleCopySelection}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            {onQuote && (
              <button
                type="button"
                class="chat-sel-btn"
                onClick={handleQuoteSelection}
              >
                {t('common.quote', 'Quote')}
              </button>
            )}
          </div>
        )}
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
