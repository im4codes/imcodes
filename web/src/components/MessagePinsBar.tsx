import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ComponentChildren } from 'preact';
import type { MessagePin } from '@shared/message-pins.js';
import { ZoomedTextDialog } from './ZoomedTextDialog.js';

export type MessagePinPreviewMode = 'rendered' | 'text';

interface Props {
  pins: MessagePin[];
  currentSessionName: string;
  loading?: boolean;
  mutating?: boolean;
  error?: string | null;
  locateError?: boolean;
  onLocate: (pin: MessagePin) => void;
  onQuote?: (text: string) => void;
  previewMode?: MessagePinPreviewMode;
  onPreviewModeChange?: (mode: MessagePinPreviewMode) => void;
  renderPreview?: (text: string) => ComponentChildren;
  onUnpin: (pin: MessagePin) => void;
  onDismissError?: () => void;
}
export function MessagePinsBar({
  pins,
  currentSessionName,
  loading = false,
  mutating = false,
  error,
  locateError = false,
  onLocate,
  onQuote,
  previewMode = 'rendered',
  onPreviewModeChange,
  renderPreview,
  onUnpin,
  onDismissError,
}: Props) {
  const { t, i18n } = useTranslation();
  const barRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [previewPin, setPreviewPin] = useState<MessagePin | null>(null);
  const [tab, setTab] = useState<'current' | 'all'>('current');
  const currentPins = useMemo(
    () => pins.filter((pin) => pin.sessionName === currentSessionName),
    [currentSessionName, pins],
  );
  const visiblePins = tab === 'current' ? currentPins : pins;

  useLayoutEffect(() => {
    if (!expanded) return;
    const closeOutside = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    document.addEventListener('click', closeOutside);
    return () => document.removeEventListener('click', closeOutside);
  }, [expanded]);

  return (
    <section ref={barRef} class={`message-pins-bar${expanded ? ' expanded' : ''}`} aria-label={t('messagePins.title')}>
      <button
        type="button"
        class="message-pins-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={t('messagePins.summary', { current: currentPins.length, total: pins.length })}
        title={t('messagePins.summary', { current: currentPins.length, total: pins.length })}
        data-testid="message-pins-trigger"
      >
        <span aria-hidden="true">📌</span>
        <span class="message-pins-count">{currentPins.length}/{pins.length}</span>
      </button>
      {expanded && (
        <div class="message-pins-panel">
          <div class="message-pins-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'current'} class={tab === 'current' ? 'active' : ''} onClick={() => setTab('current')}>
              {t('messagePins.currentTab', { count: currentPins.length })}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'all'} class={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>
              {t('messagePins.allTab', { count: pins.length })}
            </button>
          </div>
          {(error || locateError) && (
            <button type="button" class="message-pins-error" onClick={onDismissError}>
              {locateError ? t('messagePins.locateFailed') : t('messagePins.requestFailed')}
            </button>
          )}
          {loading ? (
            <div class="message-pins-empty">{t('common.loading')}</div>
          ) : visiblePins.length === 0 ? (
            <div class="message-pins-empty">{t(tab === 'current' ? 'messagePins.noCurrent' : 'messagePins.noPins')}</div>
          ) : (
            <div class="message-pins-list">
              {visiblePins.map((pin) => (
                <div class="message-pin-row" key={pin.id}>
                  <button type="button" class="message-pin-open" onClick={() => {
                    setExpanded(false);
                    setPreviewPin(pin);
                  }}>
                    {tab === 'all' && <span class="message-pin-session">{pin.sessionName}</span>}
                    <span class="message-pin-text">{pin.text}</span>
                    <span class="message-pin-meta">
                      {pin.eventType === 'user.message' ? t('messagePins.userMessage') : t('messagePins.assistantMessage')}
                      {' · '}
                      {new Date(pin.eventTs).toLocaleString(i18n.resolvedLanguage || i18n.language)}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="message-pin-remove"
                    onClick={() => onUnpin(pin)}
                    disabled={mutating}
                    title={t('messagePins.unpin')}
                    aria-label={t('messagePins.unpin')}
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {previewPin && (
        <ZoomedTextDialog
          text={previewPin.text}
          title={t('messagePins.previewTitle')}
          subtitle={`${previewPin.sessionName} · ${new Date(previewPin.eventTs).toLocaleString(i18n.resolvedLanguage || i18n.language)}`}
          copyLabel={t('common.copy')}
          messagePreviewLayout
          onClose={() => setPreviewPin(null)}
          renderedContent={previewMode === 'rendered' && renderPreview
            ? renderPreview(previewPin.text)
            : undefined}
          viewControls={renderPreview && onPreviewModeChange ? (
            <div class="zoom-text-mode-switch" role="group" aria-label={t('messagePins.previewMode')}>
              <button
                type="button"
                class={previewMode === 'rendered' ? 'active' : ''}
                aria-pressed={previewMode === 'rendered'}
                onClick={() => onPreviewModeChange('rendered')}
              >
                {t('messagePins.renderedMode')}
              </button>
              <button
                type="button"
                class={previewMode === 'text' ? 'active' : ''}
                aria-pressed={previewMode === 'text'}
                onClick={() => onPreviewModeChange('text')}
              >
                {t('messagePins.textMode')}
              </button>
            </div>
          ) : undefined}
          actions={(
            <>
              {onQuote && (
                <button
                  type="button"
                  class="zoom-text-btn"
                  onClick={() => {
                    onQuote(previewPin.text);
                    setPreviewPin(null);
                  }}
                >
                  {t('common.quote')}
                </button>
              )}
              <button
                type="button"
                class="zoom-text-btn"
                onClick={() => {
                  const pin = previewPin;
                  setPreviewPin(null);
                  onLocate(pin);
                }}
              >
                {t('messagePins.jump')}
              </button>
            </>
          )}
        />
      )}
    </section>
  );
}
