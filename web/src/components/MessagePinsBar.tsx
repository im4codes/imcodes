import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { ComponentChildren } from 'preact';
import { MESSAGE_PIN_EVENT_TYPES, type MessagePin, type MessagePinEventType } from '@shared/message-pins.js';
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
  renderPreview?: (text: string, closePreview: () => void) => ComponentChildren;
  resolvePinText?: (pin: MessagePin) => string;
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
  resolvePinText,
  onUnpin,
  onDismissError,
}: Props) {
  const { t, i18n } = useTranslation();
  const barRef = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [previewPin, setPreviewPin] = useState<MessagePin | null>(null);
  const [tab, setTab] = useState<'current' | 'all'>('current');
  const [query, setQuery] = useState('');
  const [eventType, setEventType] = useState<'all' | MessagePinEventType>('all');
  const currentPins = useMemo(
    () => pins.filter((pin) => pin.sessionName === currentSessionName),
    [currentSessionName, pins],
  );
  const scopePins = tab === 'current' ? currentPins : pins;
  const visiblePins = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return scopePins.filter((pin) => (
      (eventType === 'all' || pin.eventType === eventType)
      && (!needle
        || (resolvePinText?.(pin) || pin.text).toLocaleLowerCase().includes(needle)
        || pin.sessionName.toLocaleLowerCase().includes(needle))
    ));
  }, [eventType, query, resolvePinText, scopePins]);
  const filtersActive = query.trim().length > 0 || eventType !== 'all';
  const previewText = previewPin
    ? (resolvePinText?.(previewPin) || previewPin.text)
    : '';

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
          <div class="message-pins-filters">
            <input
              type="search"
              value={query}
              onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
              placeholder={t('messagePins.searchPlaceholder')}
              aria-label={t('messagePins.searchLabel')}
            />
            <select
              value={eventType}
              onInput={(event) => setEventType((event.currentTarget as HTMLSelectElement).value as 'all' | MessagePinEventType)}
              aria-label={t('messagePins.filterLabel')}
            >
              <option value="all">{t('messagePins.filterAll')}</option>
              <option value={MESSAGE_PIN_EVENT_TYPES.USER}>{t('messagePins.userMessage')}</option>
              <option value={MESSAGE_PIN_EVENT_TYPES.ASSISTANT}>{t('messagePins.assistantMessage')}</option>
            </select>
          </div>
          {(error || locateError) && (
            <button type="button" class="message-pins-error" onClick={onDismissError}>
              {locateError ? t('messagePins.locateFailed') : t('messagePins.requestFailed')}
            </button>
          )}
          {loading ? (
            <div class="message-pins-empty">{t('common.loading')}</div>
          ) : visiblePins.length === 0 ? (
            <div class="message-pins-empty">{t(filtersActive
              ? 'messagePins.noMatches'
              : tab === 'current' ? 'messagePins.noCurrent' : 'messagePins.noPins')}</div>
          ) : (
            <div class="message-pins-list">
              {visiblePins.map((pin) => (
                <div class="message-pin-row" key={pin.id}>
                  <button type="button" class="message-pin-open" onClick={() => {
                    setExpanded(false);
                    setPreviewPin(pin);
                  }}>
                    {tab === 'all' && <span class="message-pin-session">{pin.sessionName}</span>}
                    <span class="message-pin-text">{resolvePinText?.(pin) || pin.text}</span>
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
          text={previewText}
          title={t('messagePins.previewTitle')}
          subtitle={`${previewPin.sessionName} · ${new Date(previewPin.eventTs).toLocaleString(i18n.resolvedLanguage || i18n.language)}`}
          copyLabel={t('common.copy')}
          messagePreviewLayout
          onClose={() => setPreviewPin(null)}
          renderedContent={previewMode === 'rendered' && renderPreview
            ? renderPreview(previewText, () => setPreviewPin(null))
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
                    onQuote(previewText);
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
