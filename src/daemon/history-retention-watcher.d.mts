export interface RetentionSettingsWatcherFsOps {
  mkdirSync: typeof import('node:fs').mkdirSync;
  watch: typeof import('node:fs').watch;
  watchFile: typeof import('node:fs').watchFile;
  unwatchFile: typeof import('node:fs').unwatchFile;
}

export interface RetentionSettingsWatcherOptions {
  configPath: string;
  retryMs: number;
  onSchedule: () => void;
  isStopped?: () => boolean;
  fsOps?: RetentionSettingsWatcherFsOps;
  debounceMs?: number;
  watchFileIntervalMs?: number;
  onWarn?: (err: Error) => void;
}

export interface RetentionSettingsWatcherHandle {
  stop: () => void;
}

export function startRetentionSettingsWatcher(
  options: RetentionSettingsWatcherOptions,
): RetentionSettingsWatcherHandle;
