import { useTranslation } from 'react-i18next';
import {
  REMOTE_DESKTOP_WEB_READINESS,
  resolveRemoteDesktopWebReadiness,
} from '../remote-desktop-profile.js';

export interface RemoteDesktopReadinessProps {
  capabilities: readonly unknown[] | undefined;
  compact?: boolean;
  /** Live route signal; never upgrades capability-derived readiness. */
  accessibilityUnavailable?: boolean;
}

/**
 * Capability-derived readiness only. This surface intentionally has no OS
 * prop so descriptive machine metadata can never grant remote-desktop UI.
 */
export function RemoteDesktopReadiness({
  capabilities,
  compact = false,
  accessibilityUnavailable = false,
}: RemoteDesktopReadinessProps) {
  const { t } = useTranslation();
  const readiness = resolveRemoteDesktopWebReadiness(capabilities);
  if (readiness.platform !== 'macos') return null;

  const unsupportedProfile = readiness.kind === REMOTE_DESKTOP_WEB_READINESS.UNSUPPORTED_PROFILE;
  const screenRecordingRequired = readiness.kind
    === REMOTE_DESKTOP_WEB_READINESS.SCREEN_RECORDING_REQUIRED;
  const accessibilityReady = readiness.accessibilityReady === true && !accessibilityUnavailable;
  const viewOnly = readiness.viewOnly || accessibilityUnavailable;
  const displayedKind = accessibilityUnavailable
    ? REMOTE_DESKTOP_WEB_READINESS.VIEW_ONLY
    : readiness.kind;

  return (
    <section
      class={`remote-desktop-readiness${compact ? ' is-compact' : ''}`}
      data-readiness={displayedKind}
      aria-label={t('remote_desktop.macos_readiness_title')}
    >
      <strong>{t('remote_desktop.macos_readiness_title')}</strong>
      {unsupportedProfile ? (
        <p class="remote-desktop-readiness-error" role="status">
          {t('remote_desktop.macos_profile_unsupported')}
        </p>
      ) : (
        <>
          <div class="remote-desktop-readiness-permissions">
            <span data-permission="screen-recording">
              <b>{t('remote_desktop.macos_screen_recording')}</b>
              <i class={readiness.screenRecordingReady ? 'is-ready' : 'is-required'}>
                {t(readiness.screenRecordingReady
                  ? 'remote_desktop.macos_permission_ready'
                  : 'remote_desktop.macos_permission_required')}
              </i>
            </span>
            <span data-permission="accessibility">
              <b>{t('remote_desktop.macos_accessibility')}</b>
              <i class={accessibilityReady ? 'is-ready' : 'is-required'}>
                {t(accessibilityReady
                  ? 'remote_desktop.macos_permission_ready'
                  : 'remote_desktop.macos_permission_required')}
              </i>
            </span>
          </div>
          {screenRecordingRequired && (
            <p>{t('remote_desktop.macos_screen_recording_guidance')}</p>
          )}
          {viewOnly && (
            <p>{t('remote_desktop.macos_view_only')}</p>
          )}
          {!accessibilityReady && readiness.accessibilityReady !== null && !screenRecordingRequired && (
            <p>{t('remote_desktop.macos_accessibility_guidance')}</p>
          )}
          {accessibilityReady && (
            <p>{t('remote_desktop.macos_control_ready')}</p>
          )}
          {(readiness.unsupportedActions.lockScreen
            || readiness.unsupportedActions.capturePrivacy
            || readiness.unsupportedActions.displayControl) && (
            <div class="remote-desktop-readiness-unsupported">
              <span>{t('remote_desktop.macos_unsupported_actions')}</span>
              <ul>
                {readiness.unsupportedActions.lockScreen && (
                  <li>{t('remote_desktop.macos_unsupported_lock_screen')}</li>
                )}
                {readiness.unsupportedActions.capturePrivacy && (
                  <li>{t('remote_desktop.macos_unsupported_capture_privacy')}</li>
                )}
                {readiness.unsupportedActions.displayControl && (
                  <li>{t('remote_desktop.macos_unsupported_display_control')}</li>
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
