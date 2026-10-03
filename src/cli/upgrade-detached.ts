/**
 * `imcodes upgrade` on Linux/macOS: hand the install to the detached upgrade
 * script (the same one the daemon's server-driven upgrade runs) and follow its
 * log. The script outlives this process: an SSH session that drops, a terminal
 * that closes or a daemon-managed session that is restarted no longer takes an
 * `npm install -g` down with it (production incident on 215).
 */
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchWindowsUpgrade } from '../util/windows-upgrade-script.js';
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

  return followUpgrade({
    logFile: started.logFile,
    readResult: () => readResult(started.resultFile),
    childExited: () => childExited,
    write, pollMs, limit,
  });
}

interface FollowInput {
  logFile: string;
  /** How the run ended, once known. */
  readResult: () => UpgradeResult | null;
  /** The script process is gone (used when it died without writing a result). */
  childExited: () => boolean;
  write: (line: string) => void;
  pollMs: number;
  limit: number;
}

/** Stream the log as it grows until the run ends; resolves with the exit code. */
async function followUpgrade(input: FollowInput): Promise<number> {
  const { logFile, write, pollMs, limit } = input;
  let offset = 0;
  let pending = '';
  const flush = (): void => {
    if (!existsSync(logFile)) return;
    const size = statSync(logFile).size;
    if (size <= offset) return;
    const fd = openSync(logFile, 'r');
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
    const result = input.readResult();
    if (result) {
      flush();
      const { code, message } = describeUpgradeResult(result, logFile);
      write(message);
      return code;
    }
    if (input.childExited()) {
      // Exited without a result (killed hard): that is a failure, not a success.
      flush();
      const { code, message } = describeUpgradeResult(input.readResult() ?? 'failed', logFile);
      write(message);
      return code;
    }
    if (Date.now() > limit) {
      write(`Still running after the wait limit; the upgrade continues in the background. Log: ${logFile}`);
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** How the Windows runner's log says it ended ('ok' / 'failed'), or null while it runs. */
export function readWindowsUpgradeResult(logFile: string): UpgradeResult | null {
  let text = '';
  try { text = readFileSync(logFile, 'utf8'); } catch { return null; }
  if (text.includes('=== upgrade done')) return 'ok';
  if (text.includes('=== upgrade FAILED')) return 'failed';
  return null;
}

/**
 * `imcodes upgrade` on Windows: the same hand-off. The existing Windows runner (staged
 * alone into a scratch directory, started hidden through wscript) does the install, the
 * watchdog/daemon restart and the health check; this process only follows its log.
 */
export async function runDetachedWindowsUpgrade(
  input: { pkgSpec: string; targetVer: string; registry: string | null },
  deps: { write?: (line: string) => void; pollMs?: number; followLimitMs?: number; launch?: typeof launchWindowsUpgrade } = {},
): Promise<number> {
  const write = deps.write ?? ((line: string) => { console.log(line); });
  const launch = deps.launch ?? launchWindowsUpgrade;
  const scriptDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-'));
  const logFile = join(scriptDir, 'upgrade.log');
  launch({
    scriptDir,
    logFile,
    pkgSpec: input.pkgSpec,
    targetVer: input.targetVer,
    registryArg: input.registry ?? '-',
    currentVer: '', // an explicit request: no automatic downgrade guard
  });
  write(`Upgrade started in the background (it keeps going if this session ends). Log: ${logFile}`);
  return followUpgrade({
    logFile,
    readResult: () => readWindowsUpgradeResult(logFile),
    childExited: () => false,
    write,
    pollMs: deps.pollMs ?? 500,
    limit: Date.now() + (deps.followLimitMs ?? 30 * 60_000),
  });
}
