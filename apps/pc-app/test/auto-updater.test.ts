import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPcAppAutoUpdater,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_PC_APP_UPDATE_URL,
  DEFAULT_STARTUP_CHECK_DELAY_MS,
  readBundledAutoUpdateFeedUrl,
  resolveAutoUpdateFeedUrl,
  type AutoUpdateMessageBoxOptions,
  type AutoUpdaterLike,
} from '../src/auto-updater.js';
import { tPcApp } from '../src/i18n.js';

class MockUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  feedConfigs: Array<{ provider: 'generic'; url: string }> = [];
  checkCalls = 0;
  quitAndInstallCalls: Array<{ isSilent?: boolean; isForceRunAfter?: boolean }> = [];
  checkImpl: () => Promise<unknown> = async () => null;

  setFeedURL(options: { provider: 'generic'; url: string }): void {
    this.feedConfigs.push(options);
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    return this.checkImpl();
  }

  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.quitAndInstallCalls.push({ isSilent, isForceRunAfter });
  }
}

describe('PC App shell-only auto-updater', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates IMCODES_PC_APP_UPDATE_URL fail-closed (HTTPS only, no credentials)', () => {
    expect(resolveAutoUpdateFeedUrl(undefined)).toBe(DEFAULT_PC_APP_UPDATE_URL);
    expect(resolveAutoUpdateFeedUrl('')).toBe(DEFAULT_PC_APP_UPDATE_URL);
    expect(resolveAutoUpdateFeedUrl('   ')).toBe(DEFAULT_PC_APP_UPDATE_URL);
    expect(resolveAutoUpdateFeedUrl('https://dl.im.codes/pc-app/')).toBe('https://dl.im.codes/pc-app');
    expect(resolveAutoUpdateFeedUrl('https://updates.example.com/custom/')).toBe('https://updates.example.com/custom');

    expect(resolveAutoUpdateFeedUrl('http://dl.im.codes/pc-app')).toBeNull();
    expect(resolveAutoUpdateFeedUrl('file:///tmp/pc-app')).toBeNull();
    expect(resolveAutoUpdateFeedUrl('not-a-url')).toBeNull();
    expect(resolveAutoUpdateFeedUrl('https://user:pass@dl.im.codes/pc-app')).toBeNull();
    expect(resolveAutoUpdateFeedUrl('https://token@dl.im.codes/pc-app')).toBeNull();
  });

  it('stays disabled when unpackaged, opted out, or given an invalid non-HTTPS URL', async () => {
    const updater = new MockUpdater();
    const dialogs: AutoUpdateMessageBoxOptions[] = [];

    const unpackaged = createPcAppAutoUpdater({
      isPackaged: false,
      updater,
      getLocale: () => 'en',
      showMessageBox: async (opts) => {
        dialogs.push(opts);
        return { response: 0 };
      },
    });
    expect(unpackaged.enabled).toBe(false);
    expect(unpackaged.feedUrl).toBeNull();
    unpackaged.start();
    expect(updater.feedConfigs).toHaveLength(0);
    await unpackaged.checkForUpdatesManual();
    expect(updater.checkCalls).toBe(0);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.title).toBe(tPcApp('en', 'updater.unavailable.title'));
    unpackaged.dispose();

    const optedOut = createPcAppAutoUpdater({
      isPackaged: true,
      env: { IMCODES_PC_APP_DISABLE_AUTO_UPDATE: '1' },
      updater,
      getLocale: () => 'en',
      showMessageBox: async () => ({ response: 0 }),
    });
    expect(optedOut.enabled).toBe(false);
    optedOut.start();
    expect(updater.feedConfigs).toHaveLength(0);

    const logger = { warn: vi.fn(), error: vi.fn() };
    const badUrl = createPcAppAutoUpdater({
      isPackaged: true,
      env: { IMCODES_PC_APP_UPDATE_URL: 'http://insecure.example/pc-app' },
      updater,
      logger,
      getLocale: () => 'en',
      showMessageBox: async () => ({ response: 0 }),
    });
    expect(badUrl.enabled).toBe(false);
    expect(badUrl.feedUrl).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    badUrl.start();
    expect(updater.feedConfigs).toHaveLength(0);
  });

  it('schedules startup + 4h periodic silent checks, handles errors silently, and cleans timers on dispose()', async () => {
    vi.useFakeTimers();
    const updater = new MockUpdater();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const dialogs: AutoUpdateMessageBoxOptions[] = [];

    updater.checkImpl = async () => {
      const err = new Error('net::ERR_INTERNET_DISCONNECTED');
      updater.emit('error', err);
      throw err;
    };

    const controller = createPcAppAutoUpdater({
      isPackaged: true,
      env: {},
      updater,
      logger,
      getLocale: () => 'en',
      showMessageBox: async (opts) => {
        dialogs.push(opts);
        return { response: 0 };
      },
    });

    expect(controller.enabled).toBe(true);
    expect(controller.feedUrl).toBe(DEFAULT_PC_APP_UPDATE_URL);
    controller.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.feedConfigs).toEqual([{ provider: 'generic', url: DEFAULT_PC_APP_UPDATE_URL }]);
    expect(updater.checkCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_STARTUP_CHECK_DELAY_MS);
    expect(updater.checkCalls).toBe(1);
    expect(dialogs).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS);
    expect(updater.checkCalls).toBe(2);
    expect(dialogs).toHaveLength(0);

    controller.dispose();
    await vi.advanceTimersByTimeAsync(DEFAULT_CHECK_INTERVAL_MS * 2);
    expect(updater.checkCalls).toBe(2);
  });

  it('guards concurrent checks and shows localized manual dialogs for up-to-date, downloading, error, and restart prompt', async () => {
    const updater = new MockUpdater();
    const dialogs: AutoUpdateMessageBoxOptions[] = [];
    let nextDialogResponse = 0;

    const controller = createPcAppAutoUpdater({
      isPackaged: true,
      env: { IMCODES_PC_APP_UPDATE_URL: 'https://dl.im.codes/pc-app/' },
      updater,
      logger: { error: vi.fn() },
      getLocale: () => 'zh-CN',
      showMessageBox: async (opts) => {
        dialogs.push(opts);
        return { response: nextDialogResponse };
      },
    });

    // 1. Manual up-to-date
    updater.checkImpl = async () => {
      updater.emit('update-not-available', { version: '0.1.0' });
      return null;
    };
    await controller.checkForUpdatesManual();
    expect(dialogs.at(-1)?.title).toBe(tPcApp('zh-CN', 'updater.upToDate.title'));

    // 2. Concurrent check deduplication
    let releaseCheck!: () => void;
    updater.checkImpl = () => new Promise<null>((resolve) => {
      releaseCheck = () => {
        updater.emit('update-available', { version: '0.2.0' });
        resolve(null);
      };
    });
    const p1 = controller.checkForUpdatesManual();
    const p2 = controller.checkForUpdatesManual();
    expect(updater.checkCalls).toBe(2);
    releaseCheck();
    await Promise.all([p1, p2]);
    expect(dialogs.at(-1)?.title).toBe(tPcApp('zh-CN', 'updater.downloading.title'));
    expect(dialogs.at(-1)?.message).toContain('0.2.0');

    // 3. Manual error displays single error dialog even when both 'error' event and promise rejection occur
    dialogs.length = 0;
    updater.checkImpl = async () => {
      const err = new Error('HTTP 503');
      updater.emit('error', err);
      throw err;
    };
    await controller.checkForUpdatesManual();
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.type).toBe('error');
    expect(dialogs[0]?.message).toContain('HTTP 503');

    // 4. Download finished -> Later leaves quitAndInstall uncalled; Restart & Update calls quitAndInstall(false, true)
    dialogs.length = 0;
    nextDialogResponse = 1;
    updater.emit('update-downloaded', { version: '0.2.0' });
    await vi.waitFor(() => {
      expect(dialogs).toHaveLength(1);
    });
    expect(dialogs[0]?.buttons).toEqual([
      tPcApp('zh-CN', 'updater.downloaded.restartNow'),
      tPcApp('zh-CN', 'updater.downloaded.later'),
    ]);
    expect(updater.quitAndInstallCalls).toHaveLength(0);

    // Re-checking manually after deferring immediately re-prompts restart without extra network check
    nextDialogResponse = 0;
    await controller.checkForUpdatesManual();
    expect(updater.checkCalls).toBe(3);
    expect(updater.quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
    controller.dispose();
  });

  it('reads bundled app-update.yml feed URL for channel isolation (dev/pc-app) while allowing env override', () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'imcodes-pc-app-res-'));
    try {
      expect(readBundledAutoUpdateFeedUrl(resourcesDir)).toBeUndefined();
      writeFileSync(
        join(resourcesDir, 'app-update.yml'),
        'provider: generic\nurl: https://dl.im.codes/dev/pc-app\nupdaterCacheDirName: imcodes-pc-app-updater\n',
        'utf8',
      );
      expect(readBundledAutoUpdateFeedUrl(resourcesDir)).toBe('https://dl.im.codes/dev/pc-app');

      const devUpdater = new MockUpdater();
      const devController = createPcAppAutoUpdater({
        isPackaged: true,
        env: {},
        resourcesPath: resourcesDir,
        updater: devUpdater,
        getLocale: () => 'en',
        showMessageBox: async () => ({ response: 0 }),
      });
      expect(devController.enabled).toBe(true);
      expect(devController.feedUrl).toBe('https://dl.im.codes/dev/pc-app');
      devController.start();
      expect(devUpdater.feedConfigs).toEqual([{ provider: 'generic', url: 'https://dl.im.codes/dev/pc-app' }]);
      devController.dispose();

      const overrideUpdater = new MockUpdater();
      const overrideController = createPcAppAutoUpdater({
        isPackaged: true,
        env: { IMCODES_PC_APP_UPDATE_URL: 'https://dl.im.codes/pc-app/' },
        resourcesPath: resourcesDir,
        updater: overrideUpdater,
        getLocale: () => 'en',
        showMessageBox: async () => ({ response: 0 }),
      });
      expect(overrideController.feedUrl).toBe('https://dl.im.codes/pc-app');
      overrideController.start();
      expect(overrideUpdater.feedConfigs).toEqual([{ provider: 'generic', url: 'https://dl.im.codes/pc-app' }]);
      overrideController.dispose();
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true });
    }
  });

  it('tracks live update status, throttles download-progress, deduplicates quitAndInstall, and uses silent install on win32 vs interactive on darwin', async () => {
    expect(DEFAULT_STARTUP_CHECK_DELAY_MS).toBe(5_000);
    let nowMs = 1_000;
    const pushedEvents: unknown[] = [];

    const makeHarness = (platform: NodeJS.Platform) => {
      const updater = new MockUpdater();
      const controller = createPcAppAutoUpdater({
        isPackaged: true,
        platform,
        currentVersion: '0.1.4',
        updater,
        now: () => nowMs,
        getLocale: () => 'en',
        showMessageBox: async () => ({ response: 1 }),
        sendToRenderer: (ch, payload) => {
          pushedEvents.push({ ch, payload });
        },
      });
      return { updater, controller };
    };

    const { updater: winUpdater, controller: winController } = makeHarness('win32');
    const seenStates: string[] = [];
    const seenPercents: number[] = [];
    const unsub = winController.subscribe((s) => {
      seenStates.push(s.state);
      if (s.progress) seenPercents.push(s.progress.percent);
    });

    expect(winController.getStatus()).toEqual({
      enabled: true,
      currentVersion: '0.1.4',
      state: 'idle',
      availableVersion: null,
      downloadedVersion: null,
      progress: null,
      error: null,
    });

    winUpdater.checkImpl = async () => {
      winUpdater.emit('checking-for-update');
      winUpdater.emit('update-available', { version: '0.1.5' });
      // Progress throttle: 1% -> emits on enter downloading; 1.5% at +50ms suppressed; 4% (>=2%) emits; 100% always emits
      winUpdater.emit('download-progress', { percent: 1, bytesPerSecond: 1000, transferred: 100, total: 10000 });
      nowMs += 50;
      winUpdater.emit('download-progress', { percent: 1.5, bytesPerSecond: 1000, transferred: 150, total: 10000 });
      nowMs += 50;
      winUpdater.emit('download-progress', { percent: 4, bytesPerSecond: 2000, transferred: 400, total: 10000 });
      nowMs += 300;
      winUpdater.emit('download-progress', { percent: 4.5, bytesPerSecond: 2000, transferred: 450, total: 10000 });
      winUpdater.emit('download-progress', { percent: 100, bytesPerSecond: 5000, transferred: 10000, total: 10000 });
      return null;
    };

    await winController.checkForUpdates();
    expect(seenPercents).toEqual([1, 4, 4.5, 100]);
    expect(winController.quitAndInstall()).toBe(false); // Not yet downloaded

    winUpdater.emit('update-downloaded', { version: '0.1.5' });
    expect(winController.getStatus()).toEqual({
      enabled: true,
      currentVersion: '0.1.4',
      state: 'downloaded',
      availableVersion: '0.1.5',
      downloadedVersion: '0.1.5',
      progress: null,
      error: null,
    });
    expect(seenStates).toContain('downloaded');
    expect(pushedEvents.length).toBeGreaterThan(0);

    // Duplicate quitAndInstall calls only trigger once; win32 passes isSilent=true, isForceRunAfter=true
    expect(winController.quitAndInstall()).toBe(true);
    expect(winController.quitAndInstall()).toBe(false);
    expect(winUpdater.quitAndInstallCalls).toEqual([{ isSilent: true, isForceRunAfter: true }]);
    unsub();
    winController.dispose();

    // macOS passes isSilent=false, isForceRunAfter=true
    const { updater: macUpdater, controller: macController } = makeHarness('darwin');
    await macController.checkForUpdates();
    macUpdater.emit('update-downloaded', { version: '0.1.5' });
    expect(macController.quitAndInstall()).toBe(true);
    expect(macUpdater.quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
    macController.dispose();
  });

  it('enforces trusted-origin IPC guards on all pc-updater channels', async () => {
    const updater = new MockUpdater();
    const handlers = new Map<string, (ev: { sender: unknown; senderFrame?: { url?: string } }) => Promise<unknown> | unknown>();
    const fakeIpc = {
      handle: (ch: string, fn: (ev: { sender: unknown; senderFrame?: { url?: string } }) => Promise<unknown> | unknown) => {
        handlers.set(ch, fn);
      },
      removeHandler: (ch: string) => {
        handlers.delete(ch);
      },
    };
    const controller = createPcAppAutoUpdater({
      isPackaged: true,
      platform: 'win32',
      currentVersion: '0.1.4',
      updater,
      getLocale: () => 'en',
      showMessageBox: async () => ({ response: 1 }),
    });
    const trustedSender = { id: 1 };
    controller.registerIpc(fakeIpc, (ev) => ev.sender === trustedSender);
    expect(handlers.size).toBe(4);

    // Untrusted origin rejected on every channel
    for (const ch of [
      'imcodes:pc-updater:get-status',
      'imcodes:pc-updater:check',
      'imcodes:pc-updater:download',
      'imcodes:pc-updater:quit-and-install',
    ]) {
      let threw = false;
      try {
        await handlers.get(ch)!({ sender: { id: 2 } });
      } catch (err) {
        threw = err instanceof Error && err.message === 'Untrusted origin';
      }
      expect(threw, ch).toBe(true);
    }

    // Trusted origin works
    const status = await handlers.get('imcodes:pc-updater:get-status')!({ sender: trustedSender });
    expect((status as { currentVersion: string }).currentVersion).toBe('0.1.4');
    await handlers.get('imcodes:pc-updater:check')!({ sender: trustedSender });
    expect(updater.checkCalls).toBe(1);
    updater.emit('update-downloaded', { version: '0.1.5' });
    const installed = await handlers.get('imcodes:pc-updater:quit-and-install')!({ sender: trustedSender });
    expect(installed).toBe(true);
    expect(updater.quitAndInstallCalls).toEqual([{ isSilent: true, isForceRunAfter: true }]);

    controller.unregisterIpc(fakeIpc);
    expect(handlers.size).toBe(0);
    controller.dispose();
  });

  it('recovers from sync and async quitAndInstall failures so retry re-checks, re-downloads, and installs once cleanly', async () => {
    const updater = new MockUpdater();
    let failSyncQuit = true;
    updater.quitAndInstall = ((isSilent?: boolean, isForceRunAfter?: boolean) => {
      updater.quitAndInstallCalls.push({ isSilent, isForceRunAfter });
      if (failSyncQuit) {
        throw new Error('NSIS spawn failed');
      }
    });

    const controller = createPcAppAutoUpdater({
      isPackaged: true,
      platform: 'win32',
      currentVersion: '0.1.4',
      updater,
      getLocale: () => 'en',
      showMessageBox: async () => ({ response: 1 }),
    });

    let checkRound = 0;
    updater.checkImpl = async () => {
      checkRound += 1;
      updater.emit('checking-for-update');
      updater.emit('update-available', { version: '0.1.6' });
      updater.emit('download-progress', { percent: 100, bytesPerSecond: 1000, transferred: 100, total: 100 });
      updater.emit('update-downloaded', { version: '0.1.6' });
      return null;
    };

    // Cycle 1: downloaded -> sync quitAndInstall throw releases installing/downloadedVersion and enables Retry
    await controller.checkForUpdates();
    expect(updater.checkCalls).toBe(1);
    expect(controller.getStatus().state).toBe('downloaded');
    expect(controller.quitAndInstall()).toBe(false);
    expect(controller.getStatus()).toMatchObject({
      state: 'error',
      downloadedVersion: null,
      error: 'NSIS spawn failed',
    });

    // Retry re-checks & re-downloads (count increments to 2)
    failSyncQuit = false;
    await controller.checkForUpdates();
    expect(updater.checkCalls).toBe(2);
    expect(controller.getStatus()).toMatchObject({
      state: 'downloaded',
      downloadedVersion: '0.1.6',
      error: null,
    });

    // Cycle 2: quitAndInstall returns true then emits async updater error -> Retry still works and install succeeds once
    expect(controller.quitAndInstall()).toBe(true);
    expect(controller.quitAndInstall()).toBe(false); // Deduplicated while installing in flight
    updater.emit('error', new Error('Updater helper crashed'));
    expect(controller.getStatus()).toMatchObject({
      state: 'error',
      downloadedVersion: null,
      error: 'Updater helper crashed',
    });

    await controller.checkForUpdates();
    expect(updater.checkCalls).toBe(3);
    expect(controller.getStatus().state).toBe('downloaded');

    expect(controller.quitAndInstall()).toBe(true);
    expect(controller.quitAndInstall()).toBe(false); // Double-click still only calls once
    expect(updater.quitAndInstallCalls).toHaveLength(3);
    controller.dispose();
  });
});
