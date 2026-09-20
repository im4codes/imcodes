import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_MODE,
  REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES,
  isRemoteDesktopQualityPreference,
  legacyRemoteDesktopQualityPreference,
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
  it('defaults to Balanced and remembers each machine separately', () => {
    const storage = memoryStorage();
    expect(loadRemoteDesktopQualityChoice('mac', storage).mode).toBe(DEFAULT_REMOTE_DESKTOP_QUALITY_MODE);
    expect(DEFAULT_REMOTE_DESKTOP_QUALITY_MODE).toBe(REMOTE_DESKTOP_QUALITY_MODE.BALANCED);

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
    expect(loadRemoteDesktopQualityChoice('mac', storage).mode).toBe('balanced');
    storage.setItem(REMOTE_DESKTOP_QUALITY_STORAGE_KEY, JSON.stringify({
      version: 1,
      machines: {
        mac: { mode: 'hyper', custom: {} },
        pc: { mode: 'custom', custom: { maxHeight: 1080, maxFps: 30, maxBitrateBps: 3_300_000, priority: 'balanced' } },
      },
    }));
    expect(loadRemoteDesktopQualityChoice('mac', storage).mode).toBe('balanced');
    // A bitrate the picker cannot show is replaced, so the select never lies.
    expect(loadRemoteDesktopQualityChoice('pc', storage)).toMatchObject({
      mode: 'custom',
      custom: { maxBitrateBps: 0 },
    });
  });

  it('offers Ultra as 4K with a raised ceiling, and a 4K custom choice that is remembered', () => {
    const ultra = resolveRemoteDesktopQualityPreference({
      mode: REMOTE_DESKTOP_QUALITY_MODE.ULTRA,
      custom: loadRemoteDesktopQualityChoice('any', memoryStorage()).custom,
    });
    expect(ultra).toEqual({ maxHeight: 2160, maxFps: 30, maxBitrateBps: 30_000_000, priority: 'resolution' });
    expect(isRemoteDesktopQualityPreference(ultra)).toBe(true);

    const storage = memoryStorage();
    const custom = { maxHeight: 2160, maxFps: 30, maxBitrateBps: 20_000_000, priority: 'resolution' } as const;
    saveRemoteDesktopQualityChoice('mac', { mode: REMOTE_DESKTOP_QUALITY_MODE.CUSTOM, custom }, storage);
    expect(loadRemoteDesktopQualityChoice('mac', storage)).toEqual({ mode: 'custom', custom });
  });

  it('asks a worker without Ultra for the same rungs within its own ceiling', () => {
    expect(legacyRemoteDesktopQualityPreference(REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES.ultra))
      .toEqual({ maxHeight: 0, maxFps: 30, maxBitrateBps: 0, priority: 'resolution' });
    // Nothing else changes.
    expect(legacyRemoteDesktopQualityPreference(REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES.saver))
      .toEqual(REMOTE_DESKTOP_QUALITY_MODE_PREFERENCES.saver);
  });
});
