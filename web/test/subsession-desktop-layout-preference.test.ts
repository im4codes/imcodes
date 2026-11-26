import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadSubSessionDesktopDockSide,
  loadSubSessionDesktopLayout,
  saveSubSessionDesktopDockSide,
  saveSubSessionDesktopLayout,
  SUBSESSION_DESKTOP_DOCK_SIDE,
  SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY,
  SUBSESSION_DESKTOP_LAYOUT,
  SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY,
} from '../src/subsession-desktop-layout-preference.js';

describe('desktop sub-session layout preference', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to vertical without saving and round-trips an explicit horizontal override', () => {
    expect(loadSubSessionDesktopLayout()).toBe(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
    expect(localStorage.getItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY)).toBeNull();

    saveSubSessionDesktopLayout(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);

    expect(JSON.parse(localStorage.getItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1,
      layout: SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL,
    });
    expect(loadSubSessionDesktopLayout()).toBe(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);
  });

  it('preserves an expanded-card fallback only for missing layout, not corrupt or explicit layout', () => {
    expect(loadSubSessionDesktopLayout(localStorage, SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL))
      .toBe(SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL);
    saveSubSessionDesktopLayout(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
    expect(loadSubSessionDesktopLayout(localStorage, SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL))
      .toBe(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
    localStorage.setItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY, 'broken');
    expect(loadSubSessionDesktopLayout(localStorage, SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL))
      .toBe(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
  });

  it.each([
    'not-json',
    JSON.stringify({ version: 2, layout: 'vertical' }),
    JSON.stringify({ version: 1, layout: 'diagonal' }),
    JSON.stringify({ version: 1 }),
    JSON.stringify(null),
  ])('fails safely to vertical for malformed state: %s', (raw) => {
    localStorage.setItem(SUBSESSION_DESKTOP_LAYOUT_STORAGE_KEY, raw);
    expect(loadSubSessionDesktopLayout()).toBe(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
  });

  it('fails softly when browser storage is unavailable', () => {
    expect(loadSubSessionDesktopLayout({ getItem: () => { throw new DOMException('blocked'); } }))
      .toBe(SUBSESSION_DESKTOP_LAYOUT.VERTICAL);
    expect(() => saveSubSessionDesktopLayout(
      SUBSESSION_DESKTOP_LAYOUT.HORIZONTAL,
      { setItem: () => { throw new DOMException('quota'); } },
    )).not.toThrow();
  });

  it('defaults the vertical rail left without saving and round-trips an explicit right side', () => {
    expect(loadSubSessionDesktopDockSide()).toBe(SUBSESSION_DESKTOP_DOCK_SIDE.LEFT);
    expect(localStorage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY)).toBeNull();

    saveSubSessionDesktopDockSide(SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT);

    expect(JSON.parse(localStorage.getItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY)!)).toEqual({
      version: 1,
      side: SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT,
    });
    expect(loadSubSessionDesktopDockSide()).toBe(SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT);
  });

  it.each([
    'left',
    JSON.stringify('left'),
    JSON.stringify({ side: 'left' }),
    JSON.stringify({ version: 0, side: 'left' }),
    JSON.stringify({ version: 1, dockSide: 'left' }),
    JSON.stringify({ version: 1, side: 'center' }),
    JSON.stringify(null),
  ])('migrates legacy or malformed dock state safely to left: %s', (raw) => {
    localStorage.setItem(SUBSESSION_DESKTOP_DOCK_SIDE_STORAGE_KEY, raw);
    expect(loadSubSessionDesktopDockSide()).toBe(SUBSESSION_DESKTOP_DOCK_SIDE.LEFT);
  });

  it('fails softly to the left when dock-side storage is unavailable', () => {
    expect(loadSubSessionDesktopDockSide({ getItem: () => { throw new DOMException('blocked'); } }))
      .toBe(SUBSESSION_DESKTOP_DOCK_SIDE.LEFT);
    expect(() => saveSubSessionDesktopDockSide(
      SUBSESSION_DESKTOP_DOCK_SIDE.RIGHT,
      { setItem: () => { throw new DOMException('quota'); } },
    )).not.toThrow();
  });
});
