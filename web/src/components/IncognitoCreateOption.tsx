import { useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { supportsSessionIncognito } from '@shared/session-incognito-types.js';

export interface IncognitoCreateOptionProps {
  incognito: boolean;
  canIncognito: boolean;
  agentType: string;
  onChange: (checked: boolean) => void;
}

/** Compact incognito toggle row with default-collapsed explanation details. */
export function IncognitoCreateOption({
  incognito,
  canIncognito,
  agentType,
  onChange,
}: IncognitoCreateOptionProps) {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  const unsupported = !canIncognito || (incognito && !supportsSessionIncognito(agentType));
  const detailsLabel = t('session.incognito_details_toggle', 'Incognito details');

  return (
    <div class={`incognito-create-option${incognito ? ' is-active' : ''}`}>
      <div class="incognito-create-option-row">
        <label class={`incognito-toggle-btn${incognito ? ' is-active' : ''}`}>
          <input
            type="checkbox"
            checked={incognito}
            disabled={!canIncognito}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <span>🕶️ {t('session.incognito')}</span>
        </label>
        <button
          type="button"
          class="incognito-help-toggle"
          aria-expanded={helpOpen}
          aria-label={detailsLabel}
          title={detailsLabel}
          onClick={() => setHelpOpen((prev) => !prev)}
        >
          <span aria-hidden="true">{helpOpen ? '▾' : '?'}</span>
        </button>
      </div>
      {helpOpen && (
        <div class="incognito-help-body">
          <p>{incognito ? t('session.incognito_hint') : t('session.incognito_available')}</p>
          {unsupported && <p role="status">{t('session.incognito_unsupported')}</p>}
        </div>
      )}
    </div>
  );
}
