import { useTranslation } from 'react-i18next';

export interface NewDevicePushPromptServer {
  id: string;
  name: string;
}

interface Props {
  server: NewDevicePushPromptServer | null;
  busy?: boolean;
  onEnable: () => void;
  onKeepMuted: () => void;
  onDismiss: () => void;
}

/**
 * Non-blocking prompt shown when a newly bound owned server appears after initial sync,
 * allowing the user to opt in to push notifications or explicitly keep it muted.
 */
export function NewDevicePushPrompt({ server, busy = false, onEnable, onKeepMuted, onDismiss }: Props) {
  const { t } = useTranslation();
  if (!server) return null;

  return (
    <div
      class="new-device-push-prompt"
      role="region"
      aria-label={t('server.new_device_push_prompt', { name: server.name })}
      data-testid="new-device-push-prompt"
    >
      <div class="new-device-push-prompt-row">
        <span class="new-device-push-prompt-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </svg>
        </span>
        <span class="new-device-push-prompt-text">
          {t('server.new_device_push_prompt', { name: server.name })}
        </span>
        <button
          type="button"
          class="new-device-push-prompt-close"
          data-testid="new-device-push-dismiss"
          aria-label={t('common.close', { defaultValue: 'Close' })}
          disabled={busy}
          onClick={onDismiss}
        >
          ×
        </button>
      </div>
      <div class="new-device-push-prompt-actions">
        <button
          type="button"
          class="btn btn-primary new-device-push-prompt-btn"
          data-testid="new-device-push-enable"
          disabled={busy}
          onClick={onEnable}
        >
          {t('server.new_device_push_enable')}
        </button>
        <button
          type="button"
          class="btn btn-secondary new-device-push-prompt-btn"
          data-testid="new-device-push-mute"
          disabled={busy}
          onClick={onKeepMuted}
        >
          {t('server.new_device_push_keep_muted')}
        </button>
      </div>
    </div>
  );
}
