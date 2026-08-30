import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadSubSessionDesktopLayout,
  saveSubSessionDesktopLayout,
  SUBSESSION_DESKTOP_LAYOUT,
  SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY,
} from '../src/subsession-desktop-layout-preference.js';

describe('desktop sub-session layout preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to horizontal and round-trips the versioned vertical enum', () => {
    expect(loadSubSessionDesktopLayout()).toBe(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);

    saveSubSessionDesktopLayout(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);

    expect(JSON.parse(localStorage.getItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1,
      layout: SUBSESSION_DESKTOP_LAYOUT.VERTICAL,
    });
    expect(loadSubSessionDesktopLayout()).toBe(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
  });

  it.each([
    'not-json',
    JSON.stringify({ version: 2, layout: 'vertical' }),
    JSON.stringify({ version: 1, layout: 'diagonal' }),
    JSON.stringify({ version: 1 }),
    JSON.stringify(null),
  ])('fails safely to horizontal for malformed state: %s', (raw) => {
    localStorage.setItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY, raw);
    expect(loadSubSessionDesktopLayout()).toBe(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);
  });

  it('fails softly when browser storage is unavailable', () => {
    expect(loadSubSessionDesktopLayout({ getItem: () => { throw new DOMException('blocked'); } }))
      .toBe(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);
    expect(() => saveSubSessionDesktopLayout(
      SUBSESSION_DESKTOP_LAYOUT.VERTICAL,
      { setItem: () => { throw new DOMException('quota'); } },
    )).not.toThrow();
  });
});
