import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tPcApp, type PcAppLocale } from './i18n.js';
import type { PcAppIpcInvokeEventLike, PcAppIpcMainLike } from './voice-ipc.js';

export const DEFAULT_PC_APP_UPDATE_URL = 'https://dl.im.codes/pc-app';
export const DEFAULT_STARTUP_CHECK_DELAY_MS = 5_000;
export const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_PROGRESS_THROTTLE_MS = 250;
export const DEFAULT_PROGRESS_MIN_DELTA_PCT = 2;

export const PC_APP_UPDATER_CHANNELS = Object.freeze({
  getStatus: 'imcodes:pc-updater:get-status',
  check: 'imcodes:pc-updater:check',
  download: 'imcodes:pc-updater:download',
  quitAndInstall: 'imcodes:pc-updater:quit-and-install',
  event: 'imcodes:pc-updater:event',
} as const);

export type PcAppAutoUpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up_to_date'
  | 'error'
  | 'unavailable';

export interface PcAppAutoUpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface PcAppAutoUpdateStatus {
  enabled: boolean;
  currentVersion: string;
  state: PcAppAutoUpdateState;
  availableVersion: string | null;
  downloadedVersion: string | null;
  progress: PcAppAutoUpdateProgress | null;
  error: string | null;
}

export interface AutoUpdaterInfoLike {
  version?: string;
}

export interface AutoUpdaterProgressLike {
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
}

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(options: { provider: 'generic'; url: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate?(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: AutoUpdaterInfoLike) => void): unknown;
  on(event: 'update-not-available', listener: (info: AutoUpdaterInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (info: AutoUpdaterProgressLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: AutoUpdaterInfoLike) => void): unknown;
  on(event: 'error', listener: (error: Error, message?: string) => void): unknown;
}

export interface AutoUpdateMessageBoxOptions {
  type: 'info' | 'question' | 'warning' | 'error';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface AutoUpdateLoggerLike {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface PcAppAutoUpdaterDeps {
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  currentVersion?: string;
  env?: Record<string, string | undefined>;
  resourcesPath?: string;
  updater?: AutoUpdaterLike | null;
  getLocale: () => PcAppLocale | string;
  showMessageBox: (options: AutoUpdateMessageBoxOptions) => Promise<{ response: number }>;
  sendToRenderer?: (channel: string, payload: PcAppAutoUpdateStatus) => void;
  logger?: AutoUpdateLoggerLike;
  startupDelayMs?: number;
  checkIntervalMs?: number;
  progressThrottleMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface PcAppAutoUpdaterController {
  readonly enabled: boolean;
  readonly feedUrl: string | null;
  getStatus(): PcAppAutoUpdateStatus;
  start(): void;
  checkForUpdatesManual(): Promise<void>;
  checkForUpdates(): Promise<PcAppAutoUpdateStatus>;
  downloadUpdate(): Promise<PcAppAutoUpdateStatus>;
  quitAndInstall(): boolean;
  subscribe(listener: (status: PcAppAutoUpdateStatus) => void): () => void;
  registerIpc(
    ipcMain: PcAppIpcMainLike,
    isTrustedSender: (event: PcAppIpcInvokeEventLike) => boolean,
  ): void;
  unregisterIpc(ipcMain: PcAppIpcMainLike): void;
  dispose(): void;
}

/**
 * Validate `IMCODES_PC_APP_UPDATE_URL` override fail-closed:
 * returns `DEFAULT_PC_APP_UPDATE_URL` when unset/empty, normalized HTTPS URL when valid,
 * or `null` when non-HTTPS, credential-bearing, or malformed.
 */
export function resolveAutoUpdateFeedUrl(rawUrl?: string | null): string | null {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!raw) return DEFAULT_PC_APP_UPDATE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    return null;
  }
  return raw.replace(/\/+$/u, '');
}

export function readBundledAutoUpdateFeedUrl(resourcesPath?: string): string | undefined {
  const dir = typeof resourcesPath === 'string' ? resourcesPath.trim() : '';
  if (!dir) return undefined;
  const appUpdateYml = join(dir, 'app-update.yml');
  if (!existsSync(appUpdateYml)) return undefined;
  try {
    const content = readFileSync(appUpdateYml, 'utf8');
    const match = /^\s*url:\s*(.+?)\s*$/mu.exec(content);
    if (!match?.[1]) return undefined;
    const raw = match[1].replace(/^['"]|['"]$/gu, '').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create the shell-only `electron-updater` controller for packaged PC App builds.
 * Disabled cleanly when unpackaged, opted out via `IMCODES_PC_APP_DISABLE_AUTO_UPDATE=1`,
 * or given an invalid feed URL.
 */
export function createPcAppAutoUpdater(deps: PcAppAutoUpdaterDeps): PcAppAutoUpdaterController {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const currentVersion = typeof deps.currentVersion === 'string' && deps.currentVersion.trim()
    ? deps.currentVersion.trim()
    : '0.0.0';
  const logger = deps.logger ?? console;
  const nowFn = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  const startupDelayMs = deps.startupDelayMs ?? DEFAULT_STARTUP_CHECK_DELAY_MS;
  const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const progressThrottleMs = deps.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS;

  const optedOut = env.IMCODES_PC_APP_DISABLE_AUTO_UPDATE === '1';
  const envOverride = env.IMCODES_PC_APP_UPDATE_URL?.trim();
  const bundledUrl = envOverride ? undefined : readBundledAutoUpdateFeedUrl(deps.resourcesPath ?? process.resourcesPath);
  const resolvedUrl = resolveAutoUpdateFeedUrl(envOverride || bundledUrl);
  if (deps.isPackaged && !optedOut && !resolvedUrl) {
    logger.warn?.('[pc-app auto-updater] Invalid IMCODES_PC_APP_UPDATE_URL; auto-update disabled');
  }

  const updater = deps.isPackaged && !optedOut && resolvedUrl ? (deps.updater ?? null) : null;
  const enabled = Boolean(updater);
  const feedUrl = enabled ? resolvedUrl : null;

  let started = false;
  let disposed = false;
  let listenersAttached = false;
  let activeCheck: Promise<void> | null = null;
  let manualPending = false;
  let manualOutcomeHandled = false;
  let checkErrorEmitted = false;
  let downloadedVersion: string | null = null;
  let restartPromptOpen = false;
  let installing = false;
  let lastProgressEmitAt = 0;
  let lastProgressEmitPercent = -1;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let registeredIpc: PcAppIpcMainLike | null = null;
  const listeners = new Set<(status: PcAppAutoUpdateStatus) => void>();

  let status: PcAppAutoUpdateStatus = {
    enabled,
    currentVersion,
    state: enabled ? 'idle' : 'unavailable',
    availableVersion: null,
    downloadedVersion: null,
    progress: null,
    error: null,
  };

  const snapshotStatus = (): PcAppAutoUpdateStatus => ({
    ...status,
    progress: status.progress ? { ...status.progress } : null,
  });

  const emitStatus = (): void => {
    if (disposed) return;
    const snap = snapshotStatus();
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch {
        // Ignore subscriber errors.
      }
    }
    try {
      deps.sendToRenderer?.(PC_APP_UPDATER_CHANNELS.event, snap);
    } catch {
      // Ignore renderer send failures during teardown.
    }
  };

  const setStatus = (patch: Partial<PcAppAutoUpdateStatus>, emit = true): void => {
    status = {
      ...status,
      ...patch,
    };
    if (emit) emitStatus();
  };

  const failUpdate = (err: unknown): string => {
    installing = false;
    downloadedVersion = null;
    lastProgressEmitAt = 0;
    lastProgressEmitPercent = -1;
    const message = err instanceof Error ? err.message : String(err);
    setStatus({
      state: 'error',
      downloadedVersion: null,
      progress: null,
      error: message,
    });
    return message;
  };

  const triggerQuitAndInstall = (): boolean => {
    if (disposed || !enabled || !updater || installing || !downloadedVersion) {
      return false;
    }
    installing = true;
    try {
      updater.quitAndInstall(platform === 'win32', true);
      return true;
    } catch (err) {
      logger.error?.('[pc-app auto-updater] quitAndInstall failed:', err);
      failUpdate(err);
      return false;
    }
  };

  const promptRestartToUpdate = async (version: string): Promise<void> => {
    if (disposed || restartPromptOpen || installing || !updater) return;
    restartPromptOpen = true;
    try {
      const locale = deps.getLocale();
      const { response } = await deps.showMessageBox({
        type: 'info',
        title: tPcApp(locale, 'updater.downloaded.title'),
        message: tPcApp(locale, 'updater.downloaded.message', { version }),
        buttons: [
          tPcApp(locale, 'updater.downloaded.restartNow'),
          tPcApp(locale, 'updater.downloaded.later'),
        ],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        triggerQuitAndInstall();
      }
    } catch (err) {
      logger.error?.('[pc-app auto-updater] Failed to display update-ready prompt', err);
    } finally {
      restartPromptOpen = false;
    }
  };

  const showManualInfo = async (
    titleKey: 'updater.upToDate.title' | 'updater.downloading.title' | 'updater.unavailable.title',
    messageKey: 'updater.upToDate.message' | 'updater.downloading.message' | 'updater.unavailable.message',
    vars?: Record<string, string | number>,
  ): Promise<void> => {
    if (disposed) return;
    const locale = deps.getLocale();
    await deps.showMessageBox({
      type: 'info',
      title: tPcApp(locale, titleKey),
      message: tPcApp(locale, messageKey, vars),
      buttons: [tPcApp(locale, 'common.ok')],
      defaultId: 0,
      cancelId: 0,
    });
  };

  const showManualError = async (err: unknown): Promise<void> => {
    if (disposed) return;
    const locale = deps.getLocale();
    const errorText = err instanceof Error ? err.message : String(err);
    await deps.showMessageBox({
      type: 'error',
      title: tPcApp(locale, 'updater.error.title'),
      message: tPcApp(locale, 'updater.error.message', { error: errorText }),
      buttons: [tPcApp(locale, 'common.ok')],
      defaultId: 0,
      cancelId: 0,
    });
  };

  const normalizeProgress = (info?: AutoUpdaterProgressLike): PcAppAutoUpdateProgress => {
    const rawPercent = typeof info?.percent === 'number' && Number.isFinite(info.percent) ? info.percent : 0;
    const percent = Math.max(0, Math.min(100, rawPercent));
    const bytesPerSecond = typeof info?.bytesPerSecond === 'number' && Number.isFinite(info.bytesPerSecond)
      ? Math.max(0, info.bytesPerSecond)
      : 0;
    const transferred = typeof info?.transferred === 'number' && Number.isFinite(info.transferred)
      ? Math.max(0, info.transferred)
      : 0;
    const total = typeof info?.total === 'number' && Number.isFinite(info.total)
      ? Math.max(0, info.total)
      : 0;
    return { percent, bytesPerSecond, transferred, total };
  };

  const ensureConfigured = (): AutoUpdaterLike | null => {
    if (!updater || !feedUrl || disposed) return null;
    if (!listenersAttached) {
      listenersAttached = true;
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.setFeedURL({ provider: 'generic', url: feedUrl });

      updater.on('checking-for-update', () => {
        if (disposed || downloadedVersion) return;
        if (status.state !== 'checking' || status.error !== null) {
          setStatus({ state: 'checking', error: null });
        }
      });

      updater.on('update-available', (info) => {
        if (disposed) return;
        const version = info?.version?.trim() || 'latest';
        if (!downloadedVersion) {
          lastProgressEmitAt = 0;
          lastProgressEmitPercent = -1;
          setStatus({
            state: 'available',
            availableVersion: version,
            progress: null,
            error: null,
          });
        }
        if (!manualPending || manualOutcomeHandled) return;
        manualOutcomeHandled = true;
        void showManualInfo('updater.downloading.title', 'updater.downloading.message', { version });
      });

      updater.on('download-progress', (info) => {
        if (disposed || downloadedVersion) return;
        const progress = normalizeProgress(info);
        const now = nowFn();
        const enteringDownloading = status.state !== 'downloading';
        const reachedComplete = progress.percent >= 100 && lastProgressEmitPercent < 100;
        const elapsedOk = now - lastProgressEmitAt >= progressThrottleMs;
        const deltaOk = Math.abs(progress.percent - lastProgressEmitPercent) >= DEFAULT_PROGRESS_MIN_DELTA_PCT;
        const shouldEmit = enteringDownloading || reachedComplete || elapsedOk || deltaOk;
        setStatus({ state: 'downloading', progress, error: null }, false);
        if (shouldEmit) {
          lastProgressEmitAt = now;
          lastProgressEmitPercent = progress.percent;
          emitStatus();
        }
      });

      updater.on('update-not-available', () => {
        if (disposed) return;
        if (!downloadedVersion) {
          setStatus({
            state: 'up_to_date',
            availableVersion: null,
            progress: null,
            error: null,
          });
        }
        if (!manualPending || manualOutcomeHandled) return;
        manualOutcomeHandled = true;
        void showManualInfo('updater.upToDate.title', 'updater.upToDate.message');
      });

      updater.on('update-downloaded', (info) => {
        if (disposed) return;
        const version = info?.version?.trim() || status.availableVersion || 'latest';
        downloadedVersion = version;
        lastProgressEmitAt = 0;
        lastProgressEmitPercent = -1;
        setStatus({
          state: 'downloaded',
          availableVersion: status.availableVersion ?? version,
          downloadedVersion: version,
          progress: null,
          error: null,
        });
        void promptRestartToUpdate(version);
      });

      updater.on('error', (err) => {
        logger.error?.('[pc-app auto-updater] Update error:', err);
        if (disposed) return;
        checkErrorEmitted = true;
        failUpdate(err);
        if (!manualPending || manualOutcomeHandled) return;
        manualOutcomeHandled = true;
        void showManualError(err);
      });
    }
    return updater;
  };

  const runCheck = async (manual: boolean): Promise<void> => {
    const activeUpdater = ensureConfigured();
    if (!activeUpdater) return;
    if (manual) {
      manualPending = true;
    }
    if (activeCheck) {
      await activeCheck;
      return;
    }
    manualOutcomeHandled = false;
    checkErrorEmitted = false;
    if (!downloadedVersion) {
      setStatus({ state: 'checking', error: null });
    }
    activeCheck = (async () => {
      try {
        await activeUpdater.checkForUpdates();
      } catch (err) {
        logger.error?.('[pc-app auto-updater] checkForUpdates failed:', err);
        if (!disposed && !checkErrorEmitted) {
          failUpdate(err);
        }
        if (!disposed && manualPending && !manualOutcomeHandled) {
          manualOutcomeHandled = true;
          await showManualError(err);
        }
      } finally {
        activeCheck = null;
        manualPending = false;
        manualOutcomeHandled = false;
        checkErrorEmitted = false;
      }
    })();
    await activeCheck;
  };

  const unrefTimer = (handle: unknown): void => {
    if (handle && typeof handle === 'object' && 'unref' in handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
  };

  const assertTrustedSender = (
    event: PcAppIpcInvokeEventLike,
    isTrustedSender: (event: PcAppIpcInvokeEventLike) => boolean,
  ): void => {
    if (!isTrustedSender(event)) {
      throw new Error('Untrusted origin');
    }
  };

  const unregisterIpc = (ipcMain: PcAppIpcMainLike): void => {
    if (!ipcMain.removeHandler) return;
    for (const channel of [
      PC_APP_UPDATER_CHANNELS.getStatus,
      PC_APP_UPDATER_CHANNELS.check,
      PC_APP_UPDATER_CHANNELS.download,
      PC_APP_UPDATER_CHANNELS.quitAndInstall,
    ]) {
      ipcMain.removeHandler(channel);
    }
    if (registeredIpc === ipcMain) {
      registeredIpc = null;
    }
  };

  const controller: PcAppAutoUpdaterController = {
    enabled,
    feedUrl,
    getStatus: snapshotStatus,
    start(): void {
      if (started || disposed) return;
      const activeUpdater = ensureConfigured();
      if (!activeUpdater) return;
      started = true;
      startupTimer = setTimeoutFn(() => {
        startupTimer = null;
        void runCheck(false);
      }, startupDelayMs);
      unrefTimer(startupTimer);

      intervalTimer = setIntervalFn(() => {
        void runCheck(false);
      }, checkIntervalMs);
      unrefTimer(intervalTimer);
    },
    async checkForUpdatesManual(): Promise<void> {
      if (disposed) return;
      if (!enabled) {
        await showManualInfo('updater.unavailable.title', 'updater.unavailable.message');
        return;
      }
      if (downloadedVersion) {
        await promptRestartToUpdate(downloadedVersion);
        return;
      }
      await runCheck(true);
    },
    async checkForUpdates(): Promise<PcAppAutoUpdateStatus> {
      if (disposed || !enabled) return snapshotStatus();
      if (downloadedVersion) return snapshotStatus();
      await runCheck(false);
      return snapshotStatus();
    },
    async downloadUpdate(): Promise<PcAppAutoUpdateStatus> {
      if (disposed || !enabled) return snapshotStatus();
      if (downloadedVersion) return snapshotStatus();
      const activeUpdater = ensureConfigured();
      if (!activeUpdater) return snapshotStatus();
      try {
        if (typeof activeUpdater.downloadUpdate === 'function') {
          await activeUpdater.downloadUpdate();
        } else if (status.state === 'idle' || status.state === 'error' || status.state === 'up_to_date') {
          await runCheck(false);
        }
      } catch (err) {
        logger.error?.('[pc-app auto-updater] downloadUpdate failed:', err);
        if (!disposed) {
          failUpdate(err);
        }
      }
      return snapshotStatus();
    },
    quitAndInstall(): boolean {
      return triggerQuitAndInstall();
    },
    subscribe(listener: (nextStatus: PcAppAutoUpdateStatus) => void): () => void {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    registerIpc(ipcMain, isTrustedSender): void {
      if (registeredIpc === ipcMain) return;
      if (registeredIpc) {
        unregisterIpc(registeredIpc);
      }
      registeredIpc = ipcMain;
      ipcMain.handle(PC_APP_UPDATER_CHANNELS.getStatus, (event) => {
        assertTrustedSender(event, isTrustedSender);
        return snapshotStatus();
      });
      ipcMain.handle(PC_APP_UPDATER_CHANNELS.check, async (event) => {
        assertTrustedSender(event, isTrustedSender);
        return controller.checkForUpdates();
      });
      ipcMain.handle(PC_APP_UPDATER_CHANNELS.download, async (event) => {
        assertTrustedSender(event, isTrustedSender);
        return controller.downloadUpdate();
      });
      ipcMain.handle(PC_APP_UPDATER_CHANNELS.quitAndInstall, (event) => {
        assertTrustedSender(event, isTrustedSender);
        return triggerQuitAndInstall();
      });
    },
    unregisterIpc,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (startupTimer !== null) {
        clearTimeoutFn(startupTimer);
        startupTimer = null;
      }
      if (intervalTimer !== null) {
        clearIntervalFn(intervalTimer);
        intervalTimer = null;
      }
      if (registeredIpc) {
        unregisterIpc(registeredIpc);
      }
      listeners.clear();
    },
  };

  return controller;
}
