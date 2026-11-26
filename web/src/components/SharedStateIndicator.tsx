import { useTranslation } from 'react-i18next';
import type { SharedStateSummary } from '../tab-sharing-ui.js';

interface Props {
  state?: SharedStateSummary | null;
  compact?: boolean;
  iconOnly?: boolean;
  variant?: 'access' | 'shared-out' | 'shared-in';
}

export function SharedStateIndicator({ state, compact = false, iconOnly = false, variant }: Props) {
  const { t } = useTranslation();
  if (!state && variant !== 'shared-in') return null;
  const resolvedVariant = variant ?? (state?.outgoing ? 'shared-out' : 'access');

  const role = state?.effectiveRole ? t(`share.role.${state.effectiveRole}`) : t('share.role.viewer');
  const status = state?.status ? t(`share.status.${state.status}`) : t('share.status.active');
  const scope = state?.scopeLabel?.trim() || t('share.scope.current');
  const label = resolvedVariant === 'shared-out'
    ? t('share.indicatorSharedOut')
    : resolvedVariant === 'shared-in'
    ? t('share.indicatorSharedIn')
    : compact
    ? t('share.indicatorCompact', { role, status })
    : t('share.indicator', { scope, role, status });
  const classes = [
    'share-state-indicator',
    compact ? 'share-state-indicator-compact' : '',
    iconOnly ? 'share-state-indicator-icon-only' : '',
    resolvedVariant === 'shared-out' ? 'share-state-indicator-shared-out' : '',
    resolvedVariant === 'shared-in' ? 'share-state-indicator-shared-in' : '',
  ].filter(Boolean).join(' ');

  return (
    <span class={classes} aria-label={label} title={label}>
      {resolvedVariant === 'shared-in' ? (
        <svg
          class="share-state-icon share-state-icon-return"
          viewBox="0 0 16 16"
          width="11"
          height="11"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 13 2 9 6 5" />
          <path d="M14 4v2a3 3 0 0 1-3 3H2" />
        </svg>
      ) : (
        <span class="share-state-icon" aria-hidden="true">👥</span>
      )}
      {!iconOnly && <span class="share-state-text">{resolvedVariant === 'shared-out' || resolvedVariant === 'shared-in' ? label : compact ? role : label}</span>}
    </span>
  );
}
