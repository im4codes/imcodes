/**
 * The Full Disk Access probe of the macOS daemon, and the record `imcodes doctor` reads. The decisions and the wording are
 * shared/macos-full-disk-access.ts; this file touches the system.
 *
 * It asks the question the user cares about -- "can the processes the daemon starts read protected places?" -- by actually opening a
 * file only Full Disk Access can open, from the daemon itself and from inside the tmux server the agents live in. No log reading,
 * no TCC database parsing, and nothing here needs the aiDesk app.
 */
import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MACOS_FDA_PANE_STATE,
  MACOS_FDA_PROBE_PATH,
  MACOS_FDA_STATUS_FILE,
  classifyMacosNodeInstall,
  fdaStateFromOpenError,
  parseMacosFdaStatusRecord,
  type MacosFdaPaneState,
  type MacosFdaState,
  type MacosFdaStatusRecord,
} from '../../shared/macos-full-disk-access.js';

const TMUX_PROBE_TIMEOUT_MS = 5_000;
const PANE_ANSWER = { GRANTED: 'imcodes-fda-granted', DENIED: 'imcodes-fda-denied' } as const;

/** Can THIS process open the file that needs Full Disk Access? */
export function probeFullDiskAccess(probePath: string = MACOS_FDA_PROBE_PATH): MacosFdaState {
  try {
    closeSync(openSync(probePath, 'r'));
    return fdaStateFromOpenError(undefined);
  } catch (error) {
    return fdaStateFromOpenError((error as NodeJS.ErrnoException).code);
  }
}

type ExecFileText = (file: string, args: readonly string[], timeoutMs: number) => Promise<string>;

const defaultExecFileText: ExecFileText = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, [...args], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

/**
 * Can a process inside the running tmux server open it? `run-shell` is run by the SERVER, so the answer is the server's own
 * attribution -- the one every pane and agent inherits -- not that of this client. (A pane takes its attribution from the process
 * that started the server: a server that is older than the grant keeps denying until it is restarted.)
 */
export async function probeTmuxPaneFullDiskAccess(exec: ExecFileText = defaultExecFileText, probePath: string = MACOS_FDA_PROBE_PATH): Promise<MacosFdaPaneState> {
  try {
    await exec('tmux', ['list-sessions'], TMUX_PROBE_TIMEOUT_MS);
  } catch (error) {
    const text = `${(error as { stderr?: unknown }).stderr ?? ''} ${(error as Error).message}`;
    return /no server running|error connecting to|No such file or directory/iu.test(text) ? MACOS_FDA_PANE_STATE.NO_SERVER : MACOS_FDA_PANE_STATE.UNKNOWN;
  }
  try {
    const escaped = probePath.replace(/'/gu, "'\\''");
    const command = `if head -c 1 '${escaped}' >/dev/null 2>&1; then echo ${PANE_ANSWER.GRANTED}; else echo ${PANE_ANSWER.DENIED}; fi`;
    const answer = await exec('tmux', ['run-shell', command], TMUX_PROBE_TIMEOUT_MS);
    if (answer.includes(PANE_ANSWER.GRANTED)) return MACOS_FDA_PANE_STATE.GRANTED;
    if (answer.includes(PANE_ANSWER.DENIED)) return MACOS_FDA_PANE_STATE.DENIED;
    return MACOS_FDA_PANE_STATE.UNKNOWN;
  } catch {
    return MACOS_FDA_PANE_STATE.UNKNOWN;
  }
}

/** The file Full Disk Access is keyed to: the REAL path of the node binary running this process. */
export function runningNodeIdentity(execPath: string = process.execPath): { nodePath: string; nodeKind: MacosFdaStatusRecord['nodeKind'] } {
  let nodePath = execPath;
  try { nodePath = realpathSync(execPath); } catch { /* the path as given */ }
  return { nodePath, nodeKind: classifyMacosNodeInstall(nodePath) };
}

export function macosFdaStatusPath(stateDir: string): string {
  return join(stateDir, MACOS_FDA_STATUS_FILE);
}

export function readMacosFdaStatus(stateDir: string): MacosFdaStatusRecord | undefined {
  try {
    return parseMacosFdaStatusRecord(readFileSync(macosFdaStatusPath(stateDir), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeMacosFdaStatus(stateDir: string, record: MacosFdaStatusRecord): void {
  mkdirSync(stateDir, { recursive: true });
  const path = macosFdaStatusPath(stateDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** Probe from the running daemon and record the answer for `imcodes doctor`. Never throws. */
export async function recordMacosFdaStatus(stateDir: string, now: () => number = Date.now): Promise<MacosFdaStatusRecord | undefined> {
  try {
    const record: MacosFdaStatusRecord = {
      version: 1,
      checkedAtMs: now(),
      pid: process.pid,
      ...runningNodeIdentity(),
      daemon: probeFullDiskAccess(),
      pane: await probeTmuxPaneFullDiskAccess(),
    };
    writeMacosFdaStatus(stateDir, record);
    return record;
  } catch {
    return undefined;
  }
}
