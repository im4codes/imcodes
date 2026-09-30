/**
 * `imcodes upgrade` on Linux/macOS: hand the install to the detached upgrade
 * script (the same one the daemon's server-driven upgrade runs) and follow its
 * log. The script outlives this process: an SSH session that drops, a terminal
 * that closes or a daemon-managed session that is restarted no longer takes an
 * `npm install -g` down with it (production incident on 215).
 */
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildPosixRestartCommand, launchPosixUpgrade, type PosixUpgradeScriptParams } from '../util/posix-upgrade-script.js';

/** How an upgrade script run ended (its `upgrade-result` file). */
export const UPGRADE_RESULTS = ['ok', 'noop', 'refused', 'skipped', 'rolled_back', 'failed'] as const;
export type UpgradeResult = typeof UPGRADE_RESULTS[number];

export interface DetachedUpgradeInput {
  pkgSpec: string;
  /** Pinned version, or `latest`. */
  targetVer: string;
  /** Registry base recorded for this machine, or null for npm's default. */
  registry: string | null;
  currentVer: string;
  platform: 'linux' | 'darwin';
  stateDir: string;
  home: string;
}

export interface DetachedUpgradeDeps {
  launch?: typeof launchPosixUpgrade;
  write?: (line: string) => void;
  pollMs?: number;
  /** Hard stop for following the log; the upgrade itself is not affected. */
  followLimitMs?: number;
  /** Test seam: extra/overriding script parameters. */
  scriptOverrides?: Partial<PosixUpgradeScriptParams>;
}

function readDaemonPid(stateDir: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function readResult(resultFile: string): UpgradeResult | null {
  try {
    const value = readFileSync(resultFile, 'utf8').trim();
    return (UPGRADE_RESULTS as readonly string[]).includes(value) ? (value as UpgradeResult) : null;
  } catch {
    return null;
  }
}

/** Exit code and closing line for each way the script can end. */
export function describeUpgradeResult(result: UpgradeResult, logFile: string): { code: number; message: string } {
  switch (result) {
    case 'ok': return { code: 0, message: 'Upgrade complete; the daemon was restarted on the new version.' };
    case 'noop': return { code: 0, message: 'Already up to date; nothing was changed.' };
    case 'refused': return { code: 0, message: 'The target is older than the running version; nothing was changed.' };
    case 'skipped': return { code: 1, message: 'Another upgrade is already running; this one did nothing. Try again when it has finished.' };
    case 'rolled_back': return { code: 1, message: `The new version could not start the daemon, so the previous version was restored and restarted. Details: ${logFile}` };
    default: return { code: 1, message: `Upgrade failed; the previous install was left in place. Details: ${logFile}` };
  }
}

/** Start the detached upgrade and follow it. Resolves with the process exit code. */
export async function runDetachedPosixUpgrade(input: DetachedUpgradeInput, deps: DetachedUpgradeDeps = {}): Promise<number> {
  const write = deps.write ?? ((line: string) => { console.log(line); });
  const launch = deps.launch ?? launchPosixUpgrade;
  const pollMs = deps.pollMs ?? 400;
  const limit = Date.now() + (deps.followLimitMs ?? 30 * 60_000);

  const started = launch({
    registryArg: input.registry ? `--registry ${input.registry}` : '',
    pkgSpec: input.pkgSpec,
    targetVer: input.targetVer,
    currentVer: input.currentVer,
    oldDaemonPid: readDaemonPid(input.stateDir),
    nodeBin: process.execPath,
    nodeDir: dirname(process.execPath),
    stateDir: input.stateDir,
    restartCmd: buildPosixRestartCommand({ platform: input.platform, home: input.home, stateDir: input.stateDir }),
    cleanupAfterSec: 24 * 60 * 60,
    // Someone asked for exactly this version: an older one is not a mistake to refuse.
    allowDowngrade: true,
    ...deps.scriptOverrides,
  });
  started.child.unref();
  let childExited = false;
  started.child.on('exit', () => { childExited = true; });
  write(`Upgrade started in the background (it keeps going if this session ends). Log: ${started.logFile}`);

  let offset = 0;
  let pending = '';
  const flush = (): void => {
    if (!existsSync(started.logFile)) return;
    const size = statSync(started.logFile).size;
    if (size <= offset) return;
    const fd = openSync(started.logFile, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      pending += buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) write(line);
  };

  for (;;) {
    flush();
    const result = readResult(started.resultFile);
    if (result) {
      flush();
      const { code, message } = describeUpgradeResult(result, started.logFile);
      write(message);
      return code;
    }
    if (childExited) {
      // Exited without the result file (killed hard): that is a failure, not a success.
      flush();
      const { code, message } = describeUpgradeResult(readResult(started.resultFile) ?? 'failed', started.logFile);
      write(message);
      return code;
    }
    if (Date.now() > limit) {
      write(`Still running after the wait limit; the upgrade continues in the background. Log: ${started.logFile}`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
