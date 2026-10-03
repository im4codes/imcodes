import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadRemoteDesktopZoomPreference,
  REMOTE_DESKTOP_ZOOM_PREFERENCE_STORAGE_KEY_PREFIX,
  saveRemoteDesktopZoomPreference,
} from '../src/remote-desktop-zoom-preference.js';

describe('remote desktop zoom preference', () => {
  beforeEach(() => localStorage.clear());

  it('has nothing saved for a machine that was never adjusted', () => {
    expect(loadRemoteDesktopZoomPreference('server-1')).toBeNull();
  });

  it('round-trips the viewScale and zoom ratio for one machine', () => {
    saveRemoteDesktopZoomPreference('server-1', { viewScale: 'actual', scale: 2.5 });

    expect(JSON.parse(localStorage.getItem(`${REMOTE_DESKTOP_ZOOM_PREFERENCE_STORAGE_KEY_PREFIX}server-1`)!))
      .toEqual({ version: 1, viewScale: 'actual', scale: 2.5 });
    expect(loadRemoteDesktopZoomPreference('server-1')).toEqual({ viewScale: 'actual', scale: 2.5 });
  });

  it('keeps each machine\'s remembered scale independent', () => {
    saveRemoteDesktopZoomPreference('server-1', { viewScale: 'actual', scale: 3 });
    saveRemoteDesktopZoomPreference('server-2', { viewScale: 'fit', scale: 1.5 });

    expect(loadRemoteDesktopZoomPreference('server-1')).toEqual({ viewScale: 'actual', scale: 3 });
    expect(loadRemoteDesktopZoomPreference('server-2')).toEqual({ viewScale: 'fit', scale: 1.5 });
  });

  it.each([
    'not-json',
    JSON.stringify({ version: 2, viewScale: 'fit', scale: 1 }),
    JSON.stringify({ version: 1, viewScale: 'zoomed', scale: 1 }),
    JSON.stringify({ version: 1, viewScale: 'fit', scale: 'big' }),
    JSON.stringify({ version: 1, viewScale: 'fit', scale: Number.NaN }),
    JSON.stringify({ version: 1, viewScale: 'fit' }),
    JSON.stringify(null),
  ])('fails safely to no remembered preference for malformed state: %s', (raw) => {
    localStorage.setItem(`${REMOTE_DESKTOP_ZOOM_PREFERENCE_STORAGE_KEY_PREFIX}server-1`, raw);
    expect(loadRemoteDesktopZoomPreference('server-1')).toBeNull();
  });

  it('fails softly when browser storage is unavailable', () => {
    expect(loadRemoteDesktopZoomPreference('server-1', {
      getItem: () => { throw new DOMException('blocked'); },
    })).toBeNull();
    expect(() => saveRemoteDesktopZoomPreference(
      'server-1',
      { viewScale: 'fit', scale: 1 },
      { setItem: () => { throw new DOMException('quota'); } },
    )).not.toThrow();
  });
});
