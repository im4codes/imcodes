import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAuthoritySocketReachable,
  probeProcessLiveness,
  readInstanceLockMetadata,
} from './instance-lock.js';
import {
  RECOVERY_MIN_INTERVAL_MS,
  readRecoveryStamp,
  recoverFalseActiveDaemonService,
  removeInstanceLockArtifacts,
  writeRecoveryStamp,
  type ServiceRecoveryDeps,
  type ServiceRecoveryOutcome,
  type SystemdUnitView,
} from './service-recovery.js';

/**
 * Wires {@link recoverFalseActiveDaemonService} to the real system.
 *
 * This is what the shipped `imcodes-recovery.service` oneshot executes. It runs
 * as its own systemd unit, outside `imcodes.service`'s cgroup, because the whole
 * point is that nothing inside the wedged unit can act — a zombie main process
 * cannot execute its own recovery code.
 */

const DAEMON_UNIT = 'imcodes';
const CGROUP_MOUNT = '/sys/fs/cgroup';

function systemctlShow(property: string): string {
  try {
    return execFileSync('systemctl', ['--user', 'show', DAEMON_UNIT, '-p', property, '--value'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function readUnitView(): SystemdUnitView | null {
  const activeState = systemctlShow('ActiveState');
  if (!activeState) return null;
  return {
    activeState,
    subState: systemctlShow('SubState'),
    mainPid: Number.parseInt(systemctlShow('MainPID'), 10) || 0,
  };
}

/**
 * PIDs accounted to the daemon unit's own cgroup.
 *
 * The path is taken from systemd's `ControlGroup` property rather than being
 * reconstructed, so a slice layout that differs from the common
 * `user@<uid>.service/app.slice` shape cannot silently widen the target set.
 */
function readCgroupPids(): number[] | null {
  const controlGroup = systemctlShow('ControlGroup');
  if (!controlGroup.startsWith('/') || controlGroup === '/') return null;
  try {
    return readFileSync(join(CGROUP_MOUNT, controlGroup, 'cgroup.procs'), 'utf8')
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch {
    // An unreadable cgroup means we cannot prove which processes are residual,
    // so we report none rather than guessing at a wider kill set.
    return null;
  }
}

export function buildShippedRecoveryDeps(
  overrides: Partial<ServiceRecoveryDeps> = {},
): ServiceRecoveryDeps {
  return {
    readUnit: readUnitView,
    probeLiveness: probeProcessLiveness,
    authoritySocketReachable: () => isAuthoritySocketReachable(),
    listCgroupPids: readCgroupPids,
    signalPid: (pid, signal) => { try { process.kill(pid, signal); } catch { /* already gone */ } },
    readLockMetadata: () => readInstanceLockMetadata(),
    removeLockArtifacts: () => removeInstanceLockArtifacts(),
    restartUnit: () => {
      execFileSync('systemctl', ['--user', 'restart', DAEMON_UNIT], { stdio: 'ignore' });
    },
    readRecoveryStamp: () => readRecoveryStamp(),
    writeRecoveryStamp: (stamp) => writeRecoveryStamp(stamp),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    selfPid: process.pid,
    ...overrides,
  };
}

/**
 * One bounded recovery attempt. Safe to invoke on a schedule: it performs at
 * most one restart per {@link RECOVERY_MIN_INTERVAL_MS} window and returns
 * `none` for every state that is not provably the false-active one.
 */
export async function runShippedServiceRecovery(
  overrides: Partial<ServiceRecoveryDeps> = {},
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceRecoveryOutcome> {
  // The false-active state is a systemd/cgroup phenomenon; there is nothing to
  // detect or repair anywhere else.
  if (platform !== 'linux') return { action: 'none', reason: 'unsupported-platform' };
  return recoverFalseActiveDaemonService(buildShippedRecoveryDeps(overrides));
}

export { RECOVERY_MIN_INTERVAL_MS };
