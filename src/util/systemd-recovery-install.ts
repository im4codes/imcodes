import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  RECOVERY_SERVICE_UNIT,
  RECOVERY_TIMER_UNIT,
  renderRecoveryService,
  renderRecoveryTimer,
} from './systemd-unit.js';

/**
 * Install/refresh/remove the shipped external recovery trigger.
 *
 * Idempotent by construction: unit files are rewritten only when their content
 * actually changes, and `daemon-reload`/`enable` run only when something changed
 * or the timer is not yet enabled. Re-running an install or an upgrade therefore
 * costs nothing and cannot restart anything.
 */

export interface RecoveryUnitDeps {
  serviceDir: string;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  removeFile: (path: string) => void;
  exists: (path: string) => boolean;
  isTimerEnabled: () => boolean;
  runSystemctl: (args: string[]) => void;
}

export interface RecoveryInstallOutcome {
  serviceWritten: boolean;
  timerWritten: boolean;
  reloaded: boolean;
  enabled: boolean;
}

export function defaultRecoveryUnitDeps(): RecoveryUnitDeps {
  const serviceDir = join(homedir(), '.config', 'systemd', 'user');
  return {
    serviceDir,
    readFile: (path) => {
      try { return readFileSync(path, 'utf8'); } catch { return null; }
    },
    writeFile: (path, content) => {
      mkdirSync(serviceDir, { recursive: true });
      writeFileSync(path, content, 'utf8');
    },
    removeFile: (path) => { try { unlinkSync(path); } catch { /* already absent */ } },
    exists: (path) => existsSync(path),
    isTimerEnabled: () => {
      try {
        return execFileSync('systemctl', ['--user', 'is-enabled', RECOVERY_TIMER_UNIT], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === 'enabled';
      } catch {
        return false;
      }
    },
    runSystemctl: (args) => {
      // Installation must never report the recovery trigger as enabled when
      // daemon-reload/enable actually failed. Callers already surface install
      // failures; swallowing this error would leave the production wedge
      // silently unfixed.
      execFileSync('systemctl', ['--user', ...args], { stdio: 'ignore' });
    },
  };
}

export function installRecoveryUnits(
  execStart: string,
  deps: RecoveryUnitDeps = defaultRecoveryUnitDeps(),
): RecoveryInstallOutcome {
  const servicePath = join(deps.serviceDir, RECOVERY_SERVICE_UNIT);
  const timerPath = join(deps.serviceDir, RECOVERY_TIMER_UNIT);
  const serviceBody = renderRecoveryService(execStart);
  const timerBody = renderRecoveryTimer();

  const serviceWritten = deps.readFile(servicePath) !== serviceBody;
  if (serviceWritten) deps.writeFile(servicePath, serviceBody);
  const timerWritten = deps.readFile(timerPath) !== timerBody;
  if (timerWritten) deps.writeFile(timerPath, timerBody);

  const changed = serviceWritten || timerWritten;
  if (changed) deps.runSystemctl(['daemon-reload']);

  // Enabling an already-enabled timer is a no-op for systemd, but skipping it
  // keeps a re-run genuinely side-effect free.
  const alreadyEnabled = deps.isTimerEnabled();
  const enabled = changed || !alreadyEnabled;
  if (enabled) deps.runSystemctl(['enable', '--now', RECOVERY_TIMER_UNIT]);

  return { serviceWritten, timerWritten, reloaded: changed, enabled };
}

export function removeRecoveryUnits(
  deps: RecoveryUnitDeps = defaultRecoveryUnitDeps(),
): { removed: string[] } {
  const removed: string[] = [];
  const servicePath = join(deps.serviceDir, RECOVERY_SERVICE_UNIT);
  const timerPath = join(deps.serviceDir, RECOVERY_TIMER_UNIT);
  if (deps.exists(timerPath) || deps.exists(servicePath)) {
    deps.runSystemctl(['disable', '--now', RECOVERY_TIMER_UNIT]);
  }
  for (const [path, unit] of [[timerPath, RECOVERY_TIMER_UNIT], [servicePath, RECOVERY_SERVICE_UNIT]] as const) {
    if (!deps.exists(path)) continue;
    deps.removeFile(path);
    removed.push(unit);
  }
  if (removed.length > 0) deps.runSystemctl(['daemon-reload']);
  return { removed };
}
