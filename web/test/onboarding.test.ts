import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEW_USER_GUIDE_PREF,
  shouldMarkNewUserGuidePending,
  shouldShowNewUserGuidePrompt,
  type NewUserGuidePref,
} from '../src/onboarding.js';

describe('new user onboarding gating', () => {
  it('marks guide pending only after first main session appears following an empty loaded state', () => {
    const pref: NewUserGuidePref = { ...DEFAULT_NEW_USER_GUIDE_PREF };

    expect(shouldMarkNewUserGuidePending(pref, false, 0, false)).toBe(false);
    expect(shouldMarkNewUserGuidePending(pref, true, 0, true)).toBe(false);
    expect(shouldMarkNewUserGuidePending(pref, true, 1, false)).toBe(false);
    expect(shouldMarkNewUserGuidePending(pref, true, 1, true)).toBe(true);
  });

  it('does not re-mark guide pending after completion or permanent dismissal', () => {
    expect(
      shouldMarkNewUserGuidePending(
        { pending: false, completed: true, disabled: false },
        true,
        1,
        true,
      ),
    ).toBe(false);

    expect(
      shouldMarkNewUserGuidePending(
        { pending: false, completed: false, disabled: true },
        true,
        1,
        true,
      ),
    ).toBe(false);
    expect(
      shouldMarkNewUserGuidePending(
        { pending: true, completed: false, disabled: false },
        true,
        1,
        true,
      ),
    ).toBe(false);
  });

  it('shows prompt only while pending for an account with at least one main session', () => {
    expect(
      shouldShowNewUserGuidePrompt(
        { pending: true, completed: false, disabled: false },
        true,
        1,
      ),
    ).toBe(true);

    expect(
      shouldShowNewUserGuidePrompt(
        { pending: true, completed: false, disabled: false },
        false,
        1,
      ),
    ).toBe(false);
    expect(
      shouldShowNewUserGuidePrompt(
        { pending: true, completed: false, disabled: false },
        true,
        0,
      ),
    ).toBe(false);
    expect(
      shouldShowNewUserGuidePrompt(
        { pending: false, completed: false, disabled: false },
        true,
        1,
      ),
    ).toBe(false);
    expect(
      shouldShowNewUserGuidePrompt(
        { pending: true, completed: true, disabled: false },
        true,
        1,
      ),
    ).toBe(false);
    expect(
      shouldShowNewUserGuidePrompt(
        { pending: true, completed: false, disabled: true },
        true,
        1,
      ),
    ).toBe(false);
  });
});
