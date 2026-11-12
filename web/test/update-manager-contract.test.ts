import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

const isNativeMock = vi.fn();
const getServerUrlMock = vi.fn();
const notifyAppReadyMock = vi.fn();
const downloadMock = vi.fn();
const setBundleMock = vi.fn();
const addListenerMock = vi.fn();
const preferencesGetMock = vi.fn();
const preferencesSetMock = vi.fn();

vi.mock('../src/native.js', () => ({
  isNative: (...args: unknown[]) => isNativeMock(...args),
  getServerUrl: (...args: unknown[]) => getServerUrlMock(...args),
}));

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    notifyAppReady: (...args: unknown[]) => notifyAppReadyMock(...args),
    download: (...args: unknown[]) => downloadMock(...args),
    set: (...args: unknown[]) => setBundleMock(...args),
  },
}), { virtual: true });

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (...args: unknown[]) => addListenerMock(...args),
  },
}), { virtual: true });

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (...args: unknown[]) => preferencesGetMock(...args),
    set: (...args: unknown[]) => preferencesSetMock(...args),
  },
}), { virtual: true });

describe('update manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    isNativeMock.mockReturnValue(true);
    getServerUrlMock.mockResolvedValue('https://deck.test');
    notifyAppReadyMock.mockResolvedValue(undefined);
    downloadMock.mockResolvedValue({ id: 'bundle-2' });
    setBundleMock.mockResolvedValue(undefined);
    preferencesGetMock.mockResolvedValue({ value: '1' });
    preferencesSetMock.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/app-build.json') {
        return {
          ok: true,
          json: async () => ({
            buildId: 'local-1',
            buildTime: '2026-05-10T00:00:00.000Z',
            builtAt: '2026-05-10T00:00:00.000Z',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          version: 2,
          sha256: 'abc',
          url: '/api/updates/bundle.zip',
          buildTime: '2026-05-11T00:00:00.000Z',
        }),
      };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does nothing outside native shells and only initializes once', async () => {
    isNativeMock.mockReturnValue(false);
    const { initUpdateManager } = await import('../src/update-manager.js');

    await initUpdateManager();
    await initUpdateManager();

    expect(notifyAppReadyMock).not.toHaveBeenCalled();
    expect(addListenerMock).not.toHaveBeenCalled();
  });

  it('downloads and applies a newer manifest on cold start, then checks again on resume', async () => {
    const { initUpdateManager } = await import('../src/update-manager.js');

    await initUpdateManager();
    await initUpdateManager();

    expect(notifyAppReadyMock).toHaveBeenCalledTimes(1);
    expect(addListenerMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith('https://deck.test/api/updates/manifest.json', { cache: 'no-cache' });
    expect(downloadMock).toHaveBeenCalledWith({
      url: 'https://deck.test/api/updates/bundle.zip',
      version: '2',
    });
    expect(preferencesSetMock).toHaveBeenCalledWith({
      key: 'deck_ota_version',
      value: '2',
    });
    expect(setBundleMock).toHaveBeenCalledWith({ id: 'bundle-2' });

    const resume = addListenerMock.mock.calls[0]?.[1] as (state: { isActive: boolean }) => void;
    preferencesGetMock.mockResolvedValueOnce({ value: '2' });
    resume({ isActive: false });
    resume({ isActive: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloadMock).toHaveBeenCalledTimes(1);
  });

  it('silently skips missing servers, stale manifests, fetch failures, and download failures', async () => {
    getServerUrlMock.mockResolvedValueOnce('');
    const { initUpdateManager } = await import('../src/update-manager.js');
    await initUpdateManager();

    const resume = addListenerMock.mock.calls[0]?.[1] as (state: { isActive: boolean }) => void;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloadMock).not.toHaveBeenCalled();

    getServerUrlMock.mockResolvedValue('https://deck.test');
    preferencesGetMock.mockResolvedValueOnce({ value: '3' });
    resume({ isActive: true });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(downloadMock).not.toHaveBeenCalled();

    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    resume({ isActive: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloadMock).not.toHaveBeenCalled();

    preferencesGetMock.mockResolvedValueOnce({ value: '0' });
    downloadMock.mockRejectedValueOnce(new Error('bad zip'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resume({ isActive: true });
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[OTA] Download failed:', expect.any(Error)));
  });

  it('skips OTA download when local /app-build.json buildTime is newer than or equal to remote manifest.buildTime, and falls back safely when missing or invalid', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/app-build.json') {
        return {
          ok: true,
          json: async () => ({
            buildId: 'native-newer',
            buildTime: '2026-11-11T20:44:00.000Z',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          version: 5,
          sha256: 'stale-ota',
          url: '/api/updates/bundle.zip',
          buildTime: '2026-11-11T12:33:09.000Z',
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { initUpdateManager } = await import('../src/update-manager.js');
    await initUpdateManager();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/app-build.json', { cache: 'no-cache' }));
    expect(downloadMock).not.toHaveBeenCalled();
    expect(setBundleMock).not.toHaveBeenCalled();

    const resume = addListenerMock.mock.calls[0]?.[1] as (state: { isActive: boolean }) => void;

    // Equal timestamp (via builtAt fallback) must also skip OTA download
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/app-build.json') {
        return {
          ok: true,
          json: async () => ({
            buildId: 'native-equal',
            builtAt: '2026-11-11T20:44:00.000Z',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          version: 5,
          sha256: 'equal-ota',
          url: '/api/updates/bundle.zip',
          buildTime: '2026-11-11T20:44:00.000Z',
        }),
      };
    });
    resume({ isActive: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(downloadMock).not.toHaveBeenCalled();

    // Missing /app-build.json (404) or invalid timestamp falls back safely and allows newer version download
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/app-build.json') {
        return {
          ok: true,
          json: async () => ({
            buildId: 'invalid-date',
            buildTime: 'not-a-valid-timestamp',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          version: 5,
          sha256: 'valid-ota',
          url: '/api/updates/bundle.zip',
          buildTime: '2026-11-11T21:00:00.000Z',
        }),
      };
    });
    resume({ isActive: true });
    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));

    const pbxproj = readFileSync(join(WEB_ROOT, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
    // App and ShareActionExtension each have Debug and Release configurations.
    expect(pbxproj.match(/CURRENT_PROJECT_VERSION = 1\.2;/g)).toHaveLength(4);
    expect(pbxproj.match(/MARKETING_VERSION = 1\.2;/g)).toHaveLength(4);
    expect(pbxproj).not.toContain('CURRENT_PROJECT_VERSION = 1.1;');
    expect(pbxproj).not.toContain('MARKETING_VERSION = 1.1;');
  });
});
