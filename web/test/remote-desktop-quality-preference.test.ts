import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES,
} from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_QUALITY_STORAGE_KEY,
  loadRemoteDesktopQualityChoice,
  resolveRemoteDesktopQualityPreference,
  saveRemoteDesktopQualityChoice,
} from '../src/remote-desktop-quality-preference.js';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

describe('remote desktop quality choice', () => {
  it('defaults to Smooth and remembers each machine separately', () => {
    const storage = memoryStorage();
    expect(loadRemoteDesktopQualityChoice('mac', storage).mode).toBe(DEFAULT_REMOTE_DESKTOP_QUALITY_MODE);
    expect(DEFAULT_REMOTE_DESKTOP_QUALITY_MODE).toBe(REMOTE_DESKTOP_QUALITY_MODE.SMOOTH);

    const custom = { maxHeight: 1440, maxFps: 60, maxBitrateBps: 8_000_000, priority: 'resolution' } as const;
    saveRemoteDesktopQualityChoice('mac', { mode: REMOTE_DESKTOP_QUALITY_MODE.CUSTOM, custom }, storage);
    saveRemoteDesktopQualityChoice('laptop', {
      mode: REMOTE_DESKTOP_QUALITY_MODE.SAVER,
      custom: loadRemoteDesktopQualityChoice('laptop', storage).custom,
    }, storage);

    expect(loadRemoteDesktopQualityChoice('mac', storage)).toEqual({ mode: 'custom', custom });
    expect(resolveRemoteDesktopQualityPreference(loadRemoteDesktopQualityChoice('mac', storage))).toEqual(custom);
    expect(resolveRemoteDesktopQualityPreference(loadRemoteDesktopQualityChoice('laptop', storage)))
      .toEqual(REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES.saver);
  });

  it('falls back to defaults for corrupt or foreign stored values', () => {
    const storage = memoryStorage();
    storage.setItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY, '{not json');
    expect(loadRemoteDesktopQualityChoice('mac', storage).mode).toBe('smooth');
    storage.setItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY, JSON.stringify({
      version: 1,
      machines: {
        mac: { mode: 'ultra', custom: {} },
        pc: { mode: 'custom', custom: { maxHeight: 1080, maxFps: 30, maxBitrateBps: 3_300_000, priority: 'balanced' } },
      },
    }));
    expect(loadRemoteDesktopQualityChoice('mac', storage).mode).toBe('smooth');
    // A bitrate the picker cannot show is replaced, so the select never lies.
    expect(loadRemoteDesktopQualityChoice('pc', storage)).toMatchObject({
      mode: 'custom',
      custom: { maxBitrateBps: 0 },
    });
  });
});
