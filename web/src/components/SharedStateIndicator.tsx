import { useTranslation } from 'react-i18next';
import type { SharedStateSummary } from '../tab-sharing-ui.js';

interface Props {
  state?: SharedStateSummary | null;
  compact?: boolean;
}

export function SharedStateIndicator({ state, compact = false }: Props) {
  const { t } = useTranslation();
  if (!state) return null;

  const role = state.effectiveRole ? t(`share.role.${state.effectiveRole}`) : t('share.role.viewer');
  const status = state.status ? t(`share.status.${state.status}`) : t('share.status.active');
  const scope = state.scopeLabel?.trim() || t('share.scope.current');
  const label = compact
    ? t('share.indicatorCompact', { role, status })
    : t('share.indicator', { scope, role, status });

  return (
    <span class="share-state-indicator" aria-label={label} title={label}>
      <span class="share-state-dot" aria-hidden="true" />
      <span class="share-state-text">{compact ? role : label}</span>
    </span>
  );
}
