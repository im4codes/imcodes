import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getPanePids } from './tmux.js';
import type { SessionRecord } from '../store/session-store.js';
import logger from '../util/logger.js';

const execFileAsync = promisify(execFile);
const SAFE_IMCODES_SESSION_RE = /^deck_[a-zA-Z0-9_-]+$/;

export type CloseStage =
  | 'collect'
  | 'watchers'
  | 'runtime'
  | 'processes'
  | 'tmux'
  | 'verify'
  | 'persist'
  | 'events';

export interface CloseFailure {
  sessionName: string;
  stage: CloseStage;
  message: string;
}

export interface CloseTreeResult {
  ok: boolean;
  closed: string[];
  failed: CloseFailure[];
}

interface CloseSingleHooks {
  emitStopping(record: SessionRecord): Promise<void> | void;
  stopWatchers(record: SessionRecord): Promise<void> | void;
  stopTransportRuntime(record: SessionRecord): Promise<void> | void;
  killProcessRuntime(record: SessionRecord): Promise<void> | void;
  verifyClosed(record: SessionRecord): Promise<void> | void;
  emitSuccess(record: SessionRecord): Promise<void> | void;
  persistSuccess(record: SessionRecord): Promise<void> | void;
  emitFailure(record: SessionRecord, failure: CloseFailure): Promise<void> | void;
  persistFailure(record: SessionRecord, failure: CloseFailure): Promise<void> | void;
}

async function recordStageFailure(
  failures: CloseFailure[],
  record: SessionRecord,
  stage: CloseStage,
  action: () => Promise<void> | void,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ sessionName: record.name, stage, message });
  }
}

function shouldKillChildProcesses(record: SessionRecord): boolean {
  return record.runtimeType !== 'transport';
}

export async function killSessionProcesses(sessionName: string): Promise<void> {
  if (!SAFE_IMCODES_SESSION_RE.test(sessionName)) {
    logger.warn({ sessionName }, 'Rejected invalid session name in killSessionProcesses');
    return;
  }
  try {
    const pids = await getPanePids(sessionName);
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/F', '/T', '/PID', pid], { windowsHide: true }).catch(() => {});
        continue;
      }
      await execFileAsync('pkill', ['-9', '-P', pid]).catch(() => {});
      await execFileAsync('kill', ['-9', pid]).catch(() => {});
    }
  } catch {
    // Session may not exist or backend may not expose pane PIDs.
  }
}

export async function closeSingleSession(record: SessionRecord, hooks: CloseSingleHooks): Promise<CloseTreeResult> {
  const failures: CloseFailure[] = [];

  await recordStageFailure(failures, record, 'events', () => hooks.emitStopping(record));
  await recordStageFailure(failures, record, 'watchers', () => hooks.stopWatchers(record));

  if (record.runtimeType === 'transport') {
    await recordStageFailure(failures, record, 'runtime', () => hooks.stopTransportRuntime(record));
  } else {
    if (shouldKillChildProcesses(record)) {
      await recordStageFailure(failures, record, 'processes', () => killSessionProcesses(record.name));
    }
    await recordStageFailure(failures, record, 'tmux', () => hooks.killProcessRuntime(record));
  }

  await recordStageFailure(failures, record, 'verify', () => hooks.verifyClosed(record));

  if (failures.length === 0) {
    await recordStageFailure(failures, record, 'persist', () => hooks.persistSuccess(record));
    if (failures.length === 0) {
      await recordStageFailure(failures, record, 'events', () => hooks.emitSuccess(record));
    }
  }

  if (failures.length > 0) {
    const primaryFailure = failures[0];
    await recordStageFailure(failures, record, 'events', () => hooks.emitFailure(record, primaryFailure));
    await recordStageFailure(failures, record, 'persist', () => hooks.persistFailure(record, primaryFailure));
  }

  return {
    ok: failures.length === 0,
    closed: failures.length === 0 ? [record.name] : [],
    failed: failures,
  };
}

export function collectProjectCloseTargets(projectName: string, sessions: SessionRecord[]): SessionRecord[] {
  const toStop = new Map<string, SessionRecord>();

  for (const session of sessions) {
    if (session.projectName === projectName) toStop.set(session.name, session);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const session of sessions) {
      if (!session.name.startsWith('deck_sub_')) continue;
      if (!session.parentSession) continue;
      if (toStop.has(session.name)) continue;
      if (!toStop.has(session.parentSession)) continue;
      toStop.set(session.name, session);
      changed = true;
    }
  }

  const depthCache = new Map<string, number>();
  const depthOf = (session: SessionRecord): number => {
    const cached = depthCache.get(session.name);
    if (cached !== undefined) return cached;
    if (!session.parentSession || !toStop.has(session.parentSession)) {
      depthCache.set(session.name, 0);
      return 0;
    }
    const parent = toStop.get(session.parentSession);
    if (!parent) {
      depthCache.set(session.name, 0);
      return 0;
    }
    const depth = depthOf(parent) + 1;
    depthCache.set(session.name, depth);
    return depth;
  };

  return [...toStop.values()].sort((a, b) => depthOf(b) - depthOf(a));
}
