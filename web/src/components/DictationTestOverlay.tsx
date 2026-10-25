import { useEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
}

export function DictationTestOverlay({ open, value, onChange, onSend, onCancel }: Props) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(value.length, value.length);
    }
  }, [open]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div class="dictation-test-overlay" data-testid="dictation-test-overlay" role="dialog" aria-modal="true" aria-label={t('voice.dictation_test_title')}>
      <div class="dictation-test-dialog">
        <div class="dictation-test-header">
          <strong>{t('voice.dictation_test_title')}</strong>
          <button type="button" class="dictation-test-close" onClick={onCancel} aria-label={t('voice.dictation_test_cancel')}>×</button>
        </div>
        <p class="dictation-test-hint">{t('voice.dictation_test_hint')}</p>
        <textarea
          ref={inputRef}
          data-testid="dictation-test-input"
          class="dictation-test-input"
          value={value}
          onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          aria-label={t('voice.dictation_test_input_label')}
          rows={4}
        />
        <div class="dictation-test-actions">
          <button type="button" class="btn btn-secondary" onClick={onCancel}>{t('voice.dictation_test_cancel')}</button>
          <button type="button" class="btn btn-primary" onClick={onSend} disabled={!value.trim()}>{t('voice.dictation_test_send')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
