import { mkdirSync, watch, watchFile, unwatchFile } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * Watches the retention config directory (atomic-rename safe) and falls back to
 * stat-based `watchFile` polling when OS inotify instances are exhausted (`EMFILE`/`ENOSPC`).
 */
export function startRetentionSettingsWatcher({
  configPath,
  retryMs,
  onSchedule,
  isStopped = () => false,
  fsOps = { mkdirSync, watch, watchFile, unwatchFile },
  debounceMs = 50,
  watchFileIntervalMs = 200,
  onWarn = (err) => console.warn('SQLite history retention settings watcher failed; will retry:', err.message),
}) {
  let watcher;
  let watchFileActive = false;
  let debounceTimer;
  let retryTimer;
  let stoppedLocally = false;

  const stopped = () => stoppedLocally || isStopped();

  const triggerDebounce = () => {
    if (stopped()) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!stopped()) onSchedule();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  const retry = (err) => {
    watcher?.close();
    watcher = undefined;
    if (stopped()) return;
    const code = err?.code;
    if (code === 'EMFILE' || code === 'ENOSPC') {
      // Fall back to stat-based watchFile when OS inotify instances are exhausted.
      if (!watchFileActive) {
        watchFileActive = true;
        fsOps.watchFile(configPath, { persistent: false, interval: watchFileIntervalMs }, triggerDebounce);
      }
      onSchedule();
      return;
    }
    onWarn(err instanceof Error ? err : new Error(String(err)));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(arm, retryMs);
    retryTimer.unref?.();
  };

  const arm = () => {
    if (stopped()) return;
    try {
      fsOps.mkdirSync(dirname(configPath), { recursive: true });
      const targetName = basename(configPath);
      watcher = fsOps.watch(dirname(configPath), { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && name.toString() !== targetName) return;
        triggerDebounce();
      });
      watcher.on('error', retry);
      if (!stopped()) onSchedule();
    } catch (err) {
      retry(err instanceof Error ? err : new Error(String(err)));
    }
  };

  arm();

  return {
    stop() {
      stoppedLocally = true;
      clearTimeout(debounceTimer);
      clearTimeout(retryTimer);
      watcher?.close();
      watcher = undefined;
      if (watchFileActive) {
        fsOps.unwatchFile(configPath, triggerDebounce);
        watchFileActive = false;
      }
    },
  };
}
