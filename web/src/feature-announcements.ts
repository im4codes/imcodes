export interface FeatureAnnouncement {
  /** Stable feature identity. Bump `version` to announce a material update again. */
  id: string;
  version: number;
  messageKey: string;
}

export interface FeatureAnnouncementPreference {
  dismissed: string[];
}

export const FEATURE_ANNOUNCEMENTS_PREF_KEY = 'feature_announcements';

export const DEFAULT_FEATURE_ANNOUNCEMENT_PREFERENCE: FeatureAnnouncementPreference = {
  dismissed: [],
};

/**
 * Ordered oldest to newest so users see at most one concise announcement at a
 * time. Adding an important feature only requires one registry entry and its
 * translated message.
 */
export const FEATURE_ANNOUNCEMENTS: readonly FeatureAnnouncement[] = [
  {
    id: 'message-pins',
    version: 1,
    messageKey: 'featureAnnouncements.messagePins',
  },
];

export function featureAnnouncementKey(announcement: Pick<FeatureAnnouncement, 'id' | 'version'>): string {
  return `${announcement.id}@${announcement.version}`;
}

function dismissedKeys(pref: FeatureAnnouncementPreference | null | undefined): Set<string> {
  if (!pref || !Array.isArray(pref.dismissed)) return new Set();
  return new Set(pref.dismissed.filter((value): value is string => typeof value === 'string'));
}

export function nextFeatureAnnouncement(
  pref: FeatureAnnouncementPreference | null | undefined,
  announcements: readonly FeatureAnnouncement[] = FEATURE_ANNOUNCEMENTS,
): FeatureAnnouncement | null {
  const dismissed = dismissedKeys(pref);
  return announcements.find((announcement) => !dismissed.has(featureAnnouncementKey(announcement))) ?? null;
}

export function dismissFeatureAnnouncement(
  pref: FeatureAnnouncementPreference | null | undefined,
  announcement: Pick<FeatureAnnouncement, 'id' | 'version'>,
): FeatureAnnouncementPreference {
  const dismissed = dismissedKeys(pref);
  dismissed.add(featureAnnouncementKey(announcement));
  return { dismissed: [...dismissed] };
}

export function shouldShowFeatureAnnouncement(options: {
  announcement: FeatureAnnouncement | null;
  preferenceHydrated: boolean;
  sessionsLoaded: boolean;
  hasActiveSession: boolean;
  blockedByModal: boolean;
}): boolean {
  return options.preferenceHydrated
    && options.sessionsLoaded
    && options.hasActiveSession
    && options.announcement !== null
    && !options.blockedByModal;
}
