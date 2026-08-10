import { useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { FeatureAnnouncement as FeatureAnnouncementDefinition } from '../feature-announcements.js';
import {
  DEFAULT_FEATURE_ANNOUNCEMENT_PREFERENCE,
  FEATURE_ANNOUNCEMENTS_PREF_KEY,
  dismissFeatureAnnouncement,
  nextFeatureAnnouncement,
  shouldShowFeatureAnnouncement,
  type FeatureAnnouncementPreference,
} from '../feature-announcements.js';
import { useSyncedPreference } from '../hooks/useSyncedPreference.js';

interface Props {
  announcement: FeatureAnnouncementDefinition | null;
  open: boolean;
  onDismiss: () => void;
}

export function FeatureAnnouncement({ announcement, open, onDismiss }: Props) {
  const { t } = useTranslation();
  if (!open || !announcement) return null;

  return (
    <aside
      class="feature-announcement"
      role="dialog"
      aria-live="polite"
      aria-label={t('featureAnnouncements.label')}
      data-testid="feature-announcement"
      data-announcement-id={announcement.id}
      data-announcement-version={announcement.version}
    >
      <div class="feature-announcement-message">
        <span class="feature-announcement-icon" aria-hidden="true">📌</span>
        <span>{t(announcement.messageKey)}</span>
      </div>
      <button type="button" class="feature-announcement-dismiss" onClick={onDismiss}>
        {t('featureAnnouncements.dismiss')}
      </button>
    </aside>
  );
}

interface HostProps {
  userId: string;
  sessionsLoaded: boolean;
  hasActiveSession: boolean;
  blockedByModal: boolean;
  onPendingChange?: (pending: boolean) => void;
}

/** Owns the generic registry + per-account, server-synced acknowledgement state. */
export function FeatureAnnouncementHost({
  userId,
  sessionsLoaded,
  hasActiveSession,
  blockedByModal,
  onPendingChange,
}: HostProps) {
  const [pref, setPref, hydrated] = useSyncedPreference<FeatureAnnouncementPreference>(
    FEATURE_ANNOUNCEMENTS_PREF_KEY,
    DEFAULT_FEATURE_ANNOUNCEMENT_PREFERENCE,
    0,
    userId,
  );
  const announcement = nextFeatureAnnouncement(pref);

  useEffect(() => {
    onPendingChange?.(!hydrated || announcement !== null);
  }, [announcement, hydrated, onPendingChange]);

  return (
    <FeatureAnnouncement
      announcement={announcement}
      open={shouldShowFeatureAnnouncement({
        announcement,
        preferenceHydrated: hydrated,
        sessionsLoaded,
        hasActiveSession,
        blockedByModal,
      })}
      onDismiss={() => {
        if (!announcement) return;
        setPref((previous) => dismissFeatureAnnouncement(previous, announcement));
      }}
    />
  );
}
