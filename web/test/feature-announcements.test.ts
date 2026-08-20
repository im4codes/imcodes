import { describe, expect, it } from 'vitest';
import {
  FEATURE_ANNOUNCEMENTS,
  dismissFeatureAnnouncement,
  featureAnnouncementKey,
  nextFeatureAnnouncement,
  shouldShowFeatureAnnouncement,
  type FeatureAnnouncement,
} from '../src/feature-announcements.js';

describe('feature announcement registry', () => {
  it('keeps every registered feature version uniquely addressable', () => {
    const keys = FEATURE_ANNOUNCEMENTS.map(featureAnnouncementKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shows registered announcements once, in order', () => {
    const announcements: FeatureAnnouncement[] = [
      { id: 'first', version: 1, messageKey: 'first' },
      { id: 'second', version: 1, messageKey: 'second' },
    ];
    const first = nextFeatureAnnouncement({ dismissed: [] }, announcements);
    expect(first?.id).toBe('first');

    const afterFirst = dismissFeatureAnnouncement({ dismissed: [] }, first!);
    expect(afterFirst).toEqual({ dismissed: ['first@1'] });
    expect(nextFeatureAnnouncement(afterFirst, announcements)?.id).toBe('second');

    const afterSecond = dismissFeatureAnnouncement(afterFirst, announcements[1]!);
    expect(nextFeatureAnnouncement(afterSecond, announcements)).toBeNull();
    expect(dismissFeatureAnnouncement(afterSecond, announcements[1]!)).toEqual(afterSecond);
  });

  it('uses id + version so an important feature update can be announced again', () => {
    const v1 = { id: 'pins', version: 1, messageKey: 'pins.v1' };
    const v2 = { id: 'pins', version: 2, messageKey: 'pins.v2' };
    expect(featureAnnouncementKey(v1)).toBe('pins@1');
    expect(nextFeatureAnnouncement({ dismissed: ['pins@1'] }, [v1, v2])).toEqual(v2);
  });

  it('keeps malformed persisted data fail-open without throwing', () => {
    expect(nextFeatureAnnouncement({ dismissed: null as unknown as string[] }, FEATURE_ANNOUNCEMENTS)).toEqual(FEATURE_ANNOUNCEMENTS[0]);
    expect(dismissFeatureAnnouncement(undefined, FEATURE_ANNOUNCEMENTS[0]!)).toEqual({ dismissed: ['message-pins@1'] });
  });

  it('waits for preference hydration and a usable chat before showing', () => {
    const announcement = FEATURE_ANNOUNCEMENTS[0]!;
    const base = {
      announcement,
      preferenceHydrated: true,
      sessionsLoaded: true,
      hasActiveSession: true,
      blockedByModal: false,
    };
    expect(shouldShowFeatureAnnouncement(base)).toBe(true);
    expect(shouldShowFeatureAnnouncement({ ...base, preferenceHydrated: false })).toBe(false);
    expect(shouldShowFeatureAnnouncement({ ...base, sessionsLoaded: false })).toBe(false);
    expect(shouldShowFeatureAnnouncement({ ...base, hasActiveSession: false })).toBe(false);
    expect(shouldShowFeatureAnnouncement({ ...base, blockedByModal: true })).toBe(false);
    expect(shouldShowFeatureAnnouncement({ ...base, announcement: null })).toBe(false);
  });
});
