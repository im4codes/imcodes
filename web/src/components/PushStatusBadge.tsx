import { useTranslation } from 'react-i18next';

interface Props {
  enabled: boolean;
  variant?: 'corner' | 'inline';
}

/**
 * Compact push-notification status badge for server items.
 * - Enabled: crisp speaker icon (小喇叭)
 * - Muted: crisp ban / prohibited circle-slash icon
 */
export function PushStatusBadge({ enabled, variant = 'corner' }: Props) {
  const { t } = useTranslation();
  const label = enabled
    ? t('server.notifications_enabled_badge', { defaultValue: 'Push notifications enabled' })
    : t('server.notifications_muted_badge', { defaultValue: 'Push notifications muted' });
  const className = [
    'server-icon-push-badge',
    variant === 'inline' ? 'server-icon-push-badge-inline' : '',
    enabled ? 'is-enabled' : 'is-muted',
  ].filter(Boolean).join(' ');

  return (
    <span class={className} title={label} aria-label={label} data-push-state={enabled ? 'enabled' : 'muted'}>
      {enabled ? (
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <line x1="5.64" y1="5.64" x2="18.36" y2="18.36" />
        </svg>
      )}
    </span>
  );
}
