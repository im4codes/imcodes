/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { PcAppUpdateBanner } from '../../src/components/PcAppUpdateBanner.js';
import type { PcAppAutoUpdateStatus, PcAppBridge } from '../../src/native-platform.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const parts = Object.entries(opts)
        .filter(([k]) => k !== 'defaultValue')
        .map(([k, v]) => `${k}=${String(v)}`);
      return parts.length ? `${key}(${parts.join(',')})` : key;
    },
  }),
}));

const win = window as unknown as {
  __IMCODES_PC_APP__?: PcAppBridge;
  Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
};

const origUserAgent = navigator.userAgent;

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

beforeEach(() => {
  delete win.__IMCODES_PC_APP__;
  delete win.Capacitor;
  sessionStorage.clear();
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36');
});

afterEach(() => {
  cleanup();
  delete win.__IMCODES_PC_APP__;
  delete win.Capacitor;
  sessionStorage.clear();
  setUserAgent(origUserAgent);
});

describe('PcAppUpdateBanner', () => {
  it('renders nothing in normal browsers, Capacitor mobile apps, and unpackaged dev Electron', async () => {
    const onOpenDownloads = vi.fn();
    const web = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    expect(web.container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();
    cleanup();

    win.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
    const mobile = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    expect(mobile.container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();
    cleanup();

    delete win.Capacitor;
    win.__IMCODES_PC_APP__ = {
      isElectron: true,
      platform: 'darwin',
      downloads: { revealFile: async () => true },
      updater: {
        getStatus: async () => ({
          enabled: false,
          currentVersion: '0.1.4',
          state: 'unavailable',
          availableVersion: null,
          downloadedVersion: null,
          progress: null,
          error: null,
        }),
        quitAndInstall: async () => false,
        subscribe: () => () => {},
      },
    };
    const devElectron = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    await waitFor(() => {
      expect(devElectron.container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();
    });
  });

  it('shows auto-download progress, re-surfaces downloaded prompt after dismiss, deduplicates Restart & Update, and offers Retry + Reinstall on error', async () => {
    let listener: ((status: PcAppAutoUpdateStatus) => void) | null = null;
    const quitAndInstall = vi.fn(async () => true);
    const checkForUpdates = vi.fn(async () => ({
      enabled: true,
      currentVersion: '0.1.4',
      state: 'checking' as const,
      availableVersion: null,
      downloadedVersion: null,
      progress: null,
      error: null,
    }));
    const onOpenDownloads = vi.fn();

    win.__IMCODES_PC_APP__ = {
      isElectron: true,
      platform: 'win32',
      downloads: { revealFile: async () => true },
      updater: {
        getStatus: async () => ({
          enabled: true,
          currentVersion: '0.1.4',
          state: 'downloading',
          availableVersion: '0.1.5',
          downloadedVersion: null,
          progress: { percent: 42.4, bytesPerSecond: 1024, transferred: 424, total: 1000 },
          error: null,
        }),
        checkForUpdates,
        quitAndInstall,
        subscribe: (cb) => {
          listener = cb;
          return () => {
            listener = null;
          };
        },
      },
    };

    const { container, getByTestId } = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    await waitFor(() => {
      expect(getByTestId('pc-app-update-banner').getAttribute('data-update-state')).toBe('downloading');
    });
    expect(container.textContent).toContain('percent=42');

    // Dismiss downloading banner -> hidden cleanly
    fireEvent.click(getByTestId('pc-app-update-dismiss'));
    expect(container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();

    // Once update finishes downloading, actionable Restart & Update banner re-appears automatically
    listener!({
      enabled: true,
      currentVersion: '0.1.4',
      state: 'downloaded',
      availableVersion: '0.1.5',
      downloadedVersion: '0.1.5',
      progress: null,
      error: null,
    });
    await waitFor(() => {
      expect(getByTestId('pc-app-update-banner').getAttribute('data-update-state')).toBe('downloaded');
    });

    const restartBtn = getByTestId('pc-app-update-restart') as HTMLButtonElement;
    fireEvent.click(restartBtn);
    fireEvent.click(restartBtn);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(restartBtn.disabled).toBe(true);

    // Async install failure clears restarting and offers Retry + Reinstall; Retry re-checks & restores actionable install
    listener!({
      enabled: true,
      currentVersion: '0.1.4',
      state: 'error',
      availableVersion: null,
      downloadedVersion: null,
      progress: null,
      error: 'HTTP 502',
    });
    await waitFor(() => {
      expect(getByTestId('pc-app-update-banner').getAttribute('data-update-state')).toBe('error');
    });
    fireEvent.click(getByTestId('pc-app-update-retry'));
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId('pc-app-update-reinstall'));
    expect(onOpenDownloads).toHaveBeenCalledTimes(1);

    listener!({
      enabled: true,
      currentVersion: '0.1.4',
      state: 'downloaded',
      availableVersion: '0.1.5',
      downloadedVersion: '0.1.5',
      progress: null,
      error: null,
    });
    await waitFor(() => {
      expect(getByTestId('pc-app-update-banner').getAttribute('data-update-state')).toBe('downloaded');
    });
    const recoveredRestartBtn = getByTestId('pc-app-update-restart') as HTMLButtonElement;
    expect(recoveredRestartBtn.disabled).toBe(false);
    fireEvent.click(recoveredRestartBtn);
    fireEvent.click(recoveredRestartBtn);
    expect(quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it('shows outdated shell fallback when updater is enabled but downloads.revealFile or updater.quitAndInstall is missing', async () => {
    const onOpenDownloads = vi.fn();

    // Case 1: updater enabled & up_to_date, but downloads.revealFile is missing -> outdated prompt appears
    win.__IMCODES_PC_APP__ = {
      isElectron: true,
      platform: 'darwin',
      downloads: {},
      updater: {
        getStatus: async () => ({
          enabled: true,
          currentVersion: '0.1.3',
          state: 'up_to_date',
          availableVersion: null,
          downloadedVersion: null,
          progress: null,
          error: null,
        }),
        quitAndInstall: async () => true,
        subscribe: () => () => {},
      },
    };
    const missingReveal = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    await waitFor(() => {
      expect(missingReveal.getByTestId('pc-app-update-banner').getAttribute('data-update-state')).toBe('outdated');
    });
    fireEvent.click(missingReveal.getByTestId('pc-app-update-download-latest'));
    expect(onOpenDownloads).toHaveBeenCalledTimes(1);
    cleanup();

    // Case 2: updater exists (even state='downloaded') without quitAndInstall -> never shows broken Restart & Update, falls back to outdated
    win.__IMCODES_PC_APP__ = {
      isElectron: true,
      platform: 'win32',
      downloads: { revealFile: async () => true },
      updater: {
        getStatus: async () => ({
          enabled: true,
          currentVersion: '0.1.3',
          state: 'downloaded',
          availableVersion: '0.1.5',
          downloadedVersion: '0.1.5',
          progress: null,
          error: null,
        }),
        subscribe: () => () => {},
      },
    };
    const missingRestart = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    await waitFor(() => {
      expect(missingRestart.getByTestId('pc-app-update-banner').getAttribute('data-update-state')).toBe('outdated');
    });
    expect(missingRestart.container.querySelector('[data-testid="pc-app-update-restart"]')).toBeNull();
    fireEvent.click(missingRestart.getByTestId('pc-app-update-download-latest'));
    expect(onOpenDownloads).toHaveBeenCalledTimes(2);
    fireEvent.click(missingRestart.getByTestId('pc-app-update-later'));
    expect(sessionStorage.getItem('imcodes_pc_app_outdated_dismissed')).toBe('1');
    expect(missingRestart.container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();
  });

  it('prompts outdated Electron PC App shells to download latest and remembers dismissal per session', () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/45.3.3 Chrome/131.0.0.0 Safari/537.36');
    win.__IMCODES_PC_APP__ = {
      isElectron: true,
      platform: 'win32',
      downloads: {},
    };
    const onOpenDownloads = vi.fn();

    const first = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    const banner = first.getByTestId('pc-app-update-banner');
    expect(banner.getAttribute('data-update-state')).toBe('outdated');
    fireEvent.click(first.getByTestId('pc-app-update-download-latest'));
    expect(onOpenDownloads).toHaveBeenCalledTimes(1);

    fireEvent.click(first.getByTestId('pc-app-update-later'));
    expect(first.container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();
    expect(sessionStorage.getItem('imcodes_pc_app_outdated_dismissed')).toBe('1');
    cleanup();

    // Stays dismissed within same session on remount
    const second = render(<PcAppUpdateBanner onOpenDownloads={onOpenDownloads} />);
    expect(second.container.querySelector('[data-testid="pc-app-update-banner"]')).toBeNull();
  });
});
