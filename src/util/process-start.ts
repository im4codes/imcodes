import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

export const PROCESS_START_BATCH = {
  MAX_PIDS_PER_SPAWN: 200,
  TIMEOUT_MS: 2_000,
} as const;

export interface ProcessStartDeps {
  execFile(command: string, args: string[], options: { timeout: number; windowsHide?: boolean }): Promise<{ stdout: string }>;
  platform: NodeJS.Platform;
  ownPid: number;
}

const defaultDeps: ProcessStartDeps = {
  execFile: (command, args, options) => execFileAsync(command, args, options),
  platform: process.platform,
  ownPid: process.pid,
};

/**
 * Start-time identity of a process, used to tell a registered pid from a
 * different process that reused it.
 *
 * The value is deliberately not cached per pid: a cached start time would
 * report a dead process's identity for whoever inherits its pid, which is
 * exactly the reuse the caller is trying to detect. Instead:
 *  - this process's own start time never changes, so it is read once;
 *  - reads requested in the same synchronous burst (an orphan sweep maps over
 *    every PID record) share one `ps` / PowerShell spawn instead of one each.
 * The strings are byte-identical to the previous per-pid output, because
 * persisted registry records compare against them.
 */
export class ProcessStartReader {
  private ownStart: Promise<string | undefined> | undefined;
  private pending = new Map<number, Array<(value: string | undefined) => void>>();
  private flushScheduled = false;

  constructor(private readonly deps: ProcessStartDeps = defaultDeps) {}

  read(pid: number): Promise<string | undefined> {
    // One malformed pid would fail the whole shared `ps` call, so it never joins a batch.
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined);
    if (pid === this.deps.ownPid) {
      if (!this.ownStart) {
        this.ownStart = this.spawnBatch([pid]).then((found) => {
          const value = found.get(pid);
          if (value === undefined) this.ownStart = undefined;
          return value;
        });
      }
      return this.ownStart;
    }
    return new Promise((resolve) => {
      const waiters = this.pending.get(pid);
      if (waiters) waiters.push(resolve);
      else this.pending.set(pid, [resolve]);
      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => { void this.flush(); });
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    this.flushScheduled = false;
    const pids = [...batch.keys()];
    for (let index = 0; index < pids.length; index += PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN) {
      const chunk = pids.slice(index, index + PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN);
      const found = await this.spawnBatch(chunk);
      for (const pid of chunk) {
        const value = found.get(pid);
        for (const resolve of batch.get(pid) ?? []) resolve(value);
      }
    }
  }

  private async spawnBatch(pids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    const list = pids.join(',');
    let stdout = '';
    try {
      if (this.deps.platform === 'win32') {
        const script = `Get-Process -Id ${list} -ErrorAction SilentlyContinue | ForEach-Object { try { "$($_.Id) $($_.StartTime.ToUniversalTime().Ticks)" } catch {} }`;
        ({ stdout } = await this.deps.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          timeout: PROCESS_START_BATCH.TIMEOUT_MS,
          windowsHide: true,
        }));
      } else {
        ({ stdout } = await this.deps.execFile('ps', ['-o', 'pid=,lstart=', '-p', list], { timeout: PROCESS_START_BATCH.TIMEOUT_MS }));
      }
    } catch (error) {
      // `ps -p` exits 1 when ANY listed pid is gone but still prints the rest.
      stdout = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
    }
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const value = match[2];
      if (this.deps.platform === 'win32' && !/^\d+$/.test(value)) continue;
      found.set(Number(match[1]), value);
    }
    return found;
  }
}

export const processStartReader = new ProcessStartReader();

export function readProcessStart(pid: number): Promise<string | undefined> {
  return processStartReader.read(pid);
}
