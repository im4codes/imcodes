import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCallback);

export const PROCESS_START_BATCH = {
  MAX_PIDS_PER_SPAWN: 200,
  TIMEOUT_MS: 2_000,
} as const;

/** sysconf(_SC_CLK_TCK) is 100 on every Linux architecture the daemon runs on. */
export const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export interface ProcessStartDeps {
  execFile(command: string, args: string[], options: { timeout: number; windowsHide?: boolean }): Promise<{ stdout: string }>;
  readFile(path: string): Promise<string>;
  platform: NodeJS.Platform;
  ownPid: number;
}

const defaultDeps: ProcessStartDeps = {
  execFile: (command, args, options) => execFileAsync(command, args, options),
  readFile: (path) => readFile(path, 'utf8'),
  platform: process.platform,
  ownPid: process.pid,
};

interface PidColumn {
  /** `ps -o <column>=` name. */
  posix: string;
  /** PowerShell expression over `$_` (a Process); single quotes only, Windows mangles embedded double quotes. */
  windows: string;
}

const START_COLUMN: PidColumn = { posix: 'lstart', windows: '$_.StartTime.ToUniversalTime().Ticks.ToString()' };
const CPU_COLUMN: PidColumn = {
  posix: 'time',
  windows: '$_.TotalProcessorTime.TotalMilliseconds.ToString([System.Globalization.CultureInfo]::InvariantCulture)',
};

/** ONE spawn that answers `column` for every pid in `pids`; pids that are gone are simply absent. */
async function queryPidColumn(deps: ProcessStartDeps, column: PidColumn, pids: readonly number[]): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const list = pids.join(',');
  let stdout = '';
  try {
    if (deps.platform === 'win32') {
      const script = `Get-Process -Id ${list} -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Id.ToString() + ' ' + ${column.windows} } catch {} }`;
      ({ stdout } = await deps.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: PROCESS_START_BATCH.TIMEOUT_MS,
        windowsHide: true,
      }));
    } else {
      ({ stdout } = await deps.execFile('ps', ['-o', `pid=,${column.posix}=`, '-p', list], { timeout: PROCESS_START_BATCH.TIMEOUT_MS }));
    }
  } catch (error) {
    // `ps -p` exits 1 when ANY listed pid is gone but still prints the rest.
    stdout = typeof (error as { stdout?: unknown }).stdout === 'string' ? (error as { stdout: string }).stdout : '';
  }
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    if (deps.platform === 'win32' && !/^\d+(?:\.\d+)?$/.test(match[2])) continue;
    found.set(Number(match[1]), match[2]);
  }
  return found;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

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
    if (!validPid(pid)) return Promise.resolve(undefined);
    if (pid === this.deps.ownPid) {
      if (!this.ownStart) {
        this.ownStart = queryPidColumn(this.deps, START_COLUMN, [pid]).then((found) => {
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
      const found = await queryPidColumn(this.deps, START_COLUMN, chunk);
      for (const pid of chunk) {
        const value = found.get(pid);
        for (const resolve of batch.get(pid) ?? []) resolve(value);
      }
    }
  }
}

const PS_CPU_TIME = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;

/** `ps -o time=` (`[[dd-]hh:]mm:ss[.cc]`) to milliseconds; null when it is not that shape. */
export function parsePsCpuTimeMillis(text: string): number | null {
  const match = PS_CPU_TIME.exec(text.trim());
  if (!match) return null;
  return ((((Number(match[1] ?? 0) * 24) + Number(match[2] ?? 0)) * 60 + Number(match[3])) * 60 + Number(match[4])) * 1_000;
}

/** utime+stime of `/proc/<pid>/stat` in milliseconds; the comm field may itself contain spaces and parentheses. */
export function parseProcStatCpuMillis(stat: string): number | null {
  const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  const utime = Number(afterComm[11]);
  const stime = Number(afterComm[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return ((utime + stime) * 1_000) / LINUX_CLOCK_TICKS_PER_SECOND;
}

/**
 * Cumulative CPU time of many processes for one watchdog tick.
 *
 * Linux reads `/proc/<pid>/stat` (no fork at all); everything else answers
 * every pid with ONE `ps` / PowerShell spawn instead of one per process. A pid
 * that is gone, unreadable or unparsable is absent from the result, exactly as
 * the old per-pid sampler returned null for it.
 */
export class ProcessCpuReader {
  constructor(private readonly deps: ProcessStartDeps = defaultDeps) {}

  async read(pids: readonly number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    const unique = [...new Set(pids.filter(validPid))];
    let spawnPids = unique;
    if (this.deps.platform === 'linux') {
      spawnPids = [];
      for (let index = 0; index < unique.length; index += PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN) {
        const chunk = unique.slice(index, index + PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN);
        await Promise.all(chunk.map(async (pid) => {
          try {
            const cpu = parseProcStatCpuMillis(await this.deps.readFile(`/proc/${pid}/stat`));
            if (cpu !== null) result.set(pid, cpu);
          } catch (error) {
            // A vanished process is a definitive "gone"; anything else (no /proc, hidepid) falls back to ps.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ESRCH') spawnPids.push(pid);
          }
        }));
      }
    }
    for (let index = 0; index < spawnPids.length; index += PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN) {
      const found = await queryPidColumn(this.deps, CPU_COLUMN, spawnPids.slice(index, index + PROCESS_START_BATCH.MAX_PIDS_PER_SPAWN));
      for (const [pid, raw] of found) {
        const cpu = this.deps.platform === 'win32' ? Number(raw) : parsePsCpuTimeMillis(raw);
        if (cpu !== null && Number.isFinite(cpu) && cpu >= 0) result.set(pid, cpu);
      }
    }
    return result;
  }
}

export const processStartReader = new ProcessStartReader();
export const processCpuReader = new ProcessCpuReader();

export function readProcessStart(pid: number): Promise<string | undefined> {
  return processStartReader.read(pid);
}

export function readProcessCpuMillis(pids: readonly number[]): Promise<Map<number, number>> {
  return processCpuReader.read(pids);
}
