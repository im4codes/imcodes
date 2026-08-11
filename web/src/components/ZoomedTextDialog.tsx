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
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { useTranslation } from 'react-i18next';
import { positionChatActionMenu } from '../chat-action-menu-position.js';
import { useVerticalResize } from '../hooks/useVerticalResize.js';
import { copyToClipboard } from '../util/clipboard.js';
import { selectionToPlainText } from '../util/dom-to-text.js';
import { selectionSignature } from '../util/selection-signature.js';

interface Props {
  /** Plain-text content to display. Newlines and indentation are honoured. */
  text: string;
  /** Closes the dialog. */
  onClose: () => void;
  /** Quotes the currently selected text back into the composer. */
  onQuote?: (text: string) => void;
  /** Optional context-specific title used when this dialog previews an item. */
  title?: string;
  /** Optional context line shown above the message body. */
  subtitle?: string;
  /** Context actions rendered before the built-in copy action. */
  actions?: ComponentChildren;
  /** Optional toolbar rendered between the context line and message body. */
  viewControls?: ComponentChildren;
  /** Rich rendering of the same source text; plain mode omits this prop. */
  renderedContent?: ComponentChildren;
  /** Override the built-in "Copy all" label for preview-style dialogs. */
  copyLabel?: string;
  /** Applies the pinned-preview width and locally persisted height behavior. */
  messagePreviewLayout?: boolean;
}

interface SelectionMenuState {
  text: string;
  x: number;
  y: number;
}

const MESSAGE_PREVIEW_HEIGHT_KEY = 'message_pin_preview_height';
const MESSAGE_PREVIEW_MIN_HEIGHT = 280;

function viewportHeight(): number {
  if (typeof window === 'undefined') return 800;
  return window.visualViewport?.height ?? window.innerHeight ?? 800;
}

function clampMessagePreviewHeight(value: number): number {
  const max = Math.max(MESSAGE_PREVIEW_MIN_HEIGHT, viewportHeight() - 32);
  return Math.min(max, Math.max(MESSAGE_PREVIEW_MIN_HEIGHT, Math.round(value)));
}

function readMessagePreviewHeight(): number {
  const fallback = clampMessagePreviewHeight(viewportHeight() * 0.6);
  try {
    const stored = Number(localStorage.getItem(MESSAGE_PREVIEW_HEIGHT_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampMessagePreviewHeight(stored) : fallback;
  } catch {
    return fallback;
  }
}

export function ZoomedTextDialog({
  text,
  onClose,
  onQuote,
  title,
  subtitle,
  actions,
  viewControls,
  renderedContent,
  copyLabel,
  messagePreviewLayout = false,
}: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const [messagePreviewHeight, setMessagePreviewHeight] = useState(readMessagePreviewHeight);
  const persistMessagePreviewHeight = useCallback((height: number) => {
    if (!messagePreviewLayout) return;
    const clamped = clampMessagePreviewHeight(height);
    setMessagePreviewHeight(clamped);
    try { localStorage.setItem(MESSAGE_PREVIEW_HEIGHT_KEY, String(clamped)); } catch { /* geometry is best-effort */ }
  }, [messagePreviewLayout]);
  const {
    height: liveMessagePreviewHeight,
    onMouseDown: onResizeMouseDown,
    onTouchStart: onResizeTouchStart,
  } = useVerticalResize({
    height: messagePreviewHeight,
    minHeight: MESSAGE_PREVIEW_MIN_HEIGHT,
    onResize: persistMessagePreviewHeight,
  });

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
    let lastSelectionSignature = '';
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        lastSelectionSignature = '';
        setSelectionMenu(null);
        return;
      }
      const signature = selectionSignature(sel);
      if (signature && signature === lastSelectionSignature) return;

      const range = sel.getRangeAt(0);
      const contentEl = contentRef.current;
      const dialogEl = dialogRef.current;
      if (!contentEl || !dialogEl || !contentEl.contains(range.commonAncestorContainer)) {
        lastSelectionSignature = '';
        setSelectionMenu(null);
        return;
      }
      lastSelectionSignature = signature;

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

  // Portal to <body>. The overlay is `position: fixed; z-index: 9999`, but it
  // renders inside ChatView, so that number only ranks it against its siblings
  // within whatever stacking context an ancestor established. `.mobile-server-bar`
  // is `position: relative; z-index: 6500` much higher up the tree, which puts
  // the entire chat subtree — this dialog included — beneath it: the dialog's
  // header, and the close button in it, disappeared under the app bar. At the
  // body level the 9999 finally competes where it was meant to.
  return createPortal((
    <div
      class="dialog-overlay zoom-text-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        class={`zoom-text-dialog${messagePreviewLayout ? ' zoom-text-dialog-message-preview' : ''}`}
        style={messagePreviewLayout ? { height: `${liveMessagePreviewHeight}px` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="zoom-text-dialog-title"
        onClick={(e: Event) => e.stopPropagation()}
      >
        <div class="zoom-text-header">
          <div class="zoom-text-title" id="zoom-text-dialog-title">{title ?? t('chat.zoom_title')}</div>
          <button
            type="button"
            class="zoom-text-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >×</button>
        </div>
        {subtitle && <div class="zoom-text-subtitle">{subtitle}</div>}
        {viewControls}
        <div class="zoom-text-body">
          {renderedContent ? (
            <div ref={(element) => { contentRef.current = element; }} class="zoom-text-content zoom-text-content-rendered">{renderedContent}</div>
          ) : (
            <pre ref={(element) => { contentRef.current = element; }} class="zoom-text-content">{text}</pre>
          )}
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
          {actions}
          <button
            type="button"
            class={`zoom-text-btn${copied ? ' is-copied' : ''}`}
            onClick={handleCopy}
          >
            {copied ? t('common.copied') : (copyLabel ?? t('chat.zoom_copy_all'))}
          </button>
        </div>
        {messagePreviewLayout && (
          <div
            class="zoom-text-resize-handle"
            onMouseDown={onResizeMouseDown}
            onTouchStart={onResizeTouchStart}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  ), document.body);
}
