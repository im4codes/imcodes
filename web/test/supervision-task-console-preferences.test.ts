import { beforeEach, describe, expect, it } from 'vitest';
import {
  SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY,
  clampSupervisionTaskConsolePreferenceWidth,
  loadSupervisionTaskConsolePreferences,
  saveSupervisionTaskConsolePreferences,
  type SupervisionTaskConsoleWidthBounds,
} from '../src/supervision-task-console-preferences.js';

const BOUNDS: SupervisionTaskConsoleWidthBounds = {
  minWidth: 320,
  maxWidth: 720,
  defaultWidth: 420,
};

describe('supervision task console preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips the local open state and dragged width', () => {
    expect(saveSupervisionTaskConsolePreferences({ open: true, width: 584 }, BOUNDS)).toBe(true);

    expect(loadSupervisionTaskConsolePreferences(BOUNDS)).toEqual({
      open: true,
      width: 584,
    });
  });

  it('clamps restored and saved widths to the caller supplied desktop range', () => {
    expect(clampSupervisionTaskConsolePreferenceWidth(100, BOUNDS)).toBe(320);
    expect(clampSupervisionTaskConsolePreferenceWidth(900, BOUNDS)).toBe(720);

    localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      open: false,
      width: 999,
    }));
    expect(loadSupervisionTaskConsolePreferences(BOUNDS)).toEqual({ open: false, width: 720 });

    expect(saveSupervisionTaskConsolePreferences({ open: true, width: 40 }, BOUNDS)).toBe(true);
    expect(JSON.parse(localStorage.getItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1,
      open: true,
      width: 320,
    });
  });

  it.each([
    'not-json',
    JSON.stringify({ version: 2, open: true, width: 500 }),
    JSON.stringify({ version: 1, open: 'yes', width: 500 }),
    JSON.stringify({ version: 1, open: true, width: '500' }),
    JSON.stringify({ version: 1, open: true, width: null }),
  ])('fails safely for malformed persisted state: %s', (raw) => {
    localStorage.setItem(SUPERVISION_TASK_CONSOLE_PREFERENCES_STORAGE_KEY, raw);
    expect(loadSupervisionTaskConsolePreferences(BOUNDS)).toEqual({ open: false, width: 420 });
  });

  it('fails safely when browser storage cannot be read or written', () => {
    const unreadable = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    };
    const unwritable = {
      setItem: () => {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      },
    };

    expect(loadSupervisionTaskConsolePreferences(BOUNDS, unreadable)).toEqual({ open: false, width: 420 });
    expect(saveSupervisionTaskConsolePreferences({ open: true, width: 500 }, BOUNDS, unwritable)).toBe(false);
  });
});
