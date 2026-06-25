import { useTranslation } from 'react-i18next';
import type { SharedStateSummary } from '../tab-sharing-ui.js';

interface Props {
  state?: SharedStateSummary | null;
  compact?: boolean;
  iconOnly?: boolean;
  variant?: 'access' | 'shared-out';
}

export function SharedStateIndicator({ state, compact = false, iconOnly = false, variant }: Props) {
  const { t } = useTranslation();
  if (!state) return null;
  const resolvedVariant = variant ?? (state.outgoing ? 'shared-out' : 'access');

  const role = state.effectiveRole ? t(`share.role.${state.effectiveRole}`) : t('share.role.viewer');
  const status = state.status ? t(`share.status.${state.status}`) : t('share.status.active');
  const scope = state.scopeLabel?.trim() || t('share.scope.current');
  const label = resolvedVariant === 'shared-out'
    ? t('share.indicatorSharedOut')
    : compact
    ? t('share.indicatorCompact', { role, status })
    : t('share.indicator', { scope, role, status });
  const classes = [
    'share-state-indicator',
    compact ? 'share-state-indicator-compact' : '',
    iconOnly ? 'share-state-indicator-icon-only' : '',
    resolvedVariant === 'shared-out' ? 'share-state-indicator-shared-out' : '',
  ].filter(Boolean).join(' ');

  return (
    <span class={classes} aria-label={label} title={label}>
      <span class="share-state-icon" aria-hidden="true">👥</span>
      {!iconOnly && <span class="share-state-text">{resolvedVariant === 'shared-out' ? label : compact ? role : label}</span>}
    </span>
  );
}
