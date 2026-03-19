/**
 * Sub-session manager — creates/stops/rebuilds tmux sessions for sub-sessions.
 */

import { newSession, killSession, sessionExists } from '../agent/tmux.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { getDriver } from '../agent/session-manager.js';
import type { AgentType } from '../agent/detect.js';
import { timelineStore } from './timeline-store.js';
import { timelineEmitter } from './timeline-emitter.js';
import { upsertSession, getSession } from '../store/session-store.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import logger from '../util/logger.js';
import { getAgentVersion } from '../agent/agent-version.js';

export interface SubSessionRecord {
  id: string;
  type: string;
  shellBin?: string | null;
  cwd?: string | null;
  ccSessionId?: string | null;
  codexSessionId?: string | null;
  codexModel?: string | null;
  geminiSessionId?: string | null;
  fresh?: boolean;
  _fileSnapshot?: Set<string>;
  _onGeminiDiscovered?: (sessionId: string) => void;
}

export function subSessionName(id: string): string { return `deck_sub_${id}`; }

export async function startSubSession(sub: SubSessionRecord): Promise<void> {
  const sessionName = subSessionName(sub.id);
  const agentType = sub.type as AgentType;
  const driver = getDriver(agentType);
  const agentVersion = await getAgentVersion(agentType, sub.shellBin ?? undefined);

  if (await sessionExists(sessionName)) return;

  // For Codex: generate explicit UUID before launch, then pre-create the session
  // file so `codex resume <uuid>` finds it immediately and the watcher starts fast.
  if (agentType === 'codex') {
    const { randomUUID } = await import('node:crypto');
    sub.codexSessionId = sub.codexSessionId ?? randomUUID();
    const { ensureSessionFile } = await import('./codex-watcher.js');
    await ensureSessionFile(sub.codexSessionId, sub.cwd ?? process.cwd()).catch(() => {});
  }

  const launchCmd = driver.buildLaunchCommand(sessionName, {
    cwd: sub.cwd ?? undefined,
    ...(sub.shellBin ? { shellBin: sub.shellBin } : {}),
    ...(sub.ccSessionId ? { ccSessionId: sub.ccSessionId } : {}),
    ...(sub.codexModel ? { codexModel: sub.codexModel } : {}),
    ...(sub.codexSessionId ? { codexSessionId: sub.codexSessionId ?? undefined } : {}),
    ...(sub.geminiSessionId ? { geminiSessionId: sub.geminiSessionId } : {}),
    ...(sub.fresh ? { fresh: true } : {}),
  } as any);

  await newSession(sessionName, launchCmd, { cwd: sub.cwd ?? undefined });
  timelineEmitter.emit(sessionName, 'session.state', { state: 'started' });

  upsertSession({
    name: sessionName, projectName: sessionName, agentType: sub.type, agentVersion, role: 'w1', state: 'running',
    projectDir: sub.cwd ?? '', ccSessionId: sub.ccSessionId ?? undefined,
    codexSessionId: sub.codexSessionId ?? undefined,
    restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now()
  });

  // Start Watchers
  if (agentType === 'claude-code' && sub.ccSessionId && sub.cwd) {
    const { startWatchingFile, claudeProjectDir } = await import('./jsonl-watcher.js');
    startWatchingFile(sessionName, path.join(claudeProjectDir(sub.cwd), `${sub.ccSessionId}.jsonl`));
  } else if (agentType === 'codex' && sub.codexSessionId) {
    const { startWatchingById } = await import('./codex-watcher.js');
    void startWatchingById(sessionName, sub.codexSessionId, sub.codexModel ?? undefined);
  } else if (agentType === 'gemini') {
    const { startWatching, startWatchingDiscovered } = await import('./gemini-watcher.js');
    if (sub.geminiSessionId) {
      startWatching(sessionName, sub.geminiSessionId);
    } else if (sub._fileSnapshot) {
      startWatchingDiscovered(sessionName, sub._fileSnapshot, sub._onGeminiDiscovered);
    }
  }
}

/** Kill all processes running inside a tmux session's panes before killing the session itself.
 *  This prevents orphan agent processes that hold session UUIDs after the tmux session is gone. */
async function killSessionProcesses(sessionName: string): Promise<void> {
  try {
    const { stdout } = await execAsync(`tmux list-panes -t ${sessionName} -F '#{pane_pid}'`);
    const pids = stdout.trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      // Kill all children of the shell (the actual agent process), then the shell itself
      await execAsync(`pkill -9 -P ${pid}`).catch(() => {});
      await execAsync(`kill -9 ${pid}`).catch(() => {});
    }
  } catch { /* session may not exist or have no panes */ }
}

export async function stopSubSession(sessionName: string): Promise<void> {
  timelineEmitter.emit(sessionName, 'session.state', { state: 'stopped' });
  await killSessionProcesses(sessionName);
  await killSession(sessionName).catch(() => {});
  (await import('./jsonl-watcher.js')).stopWatching(sessionName);
  (await import('./codex-watcher.js')).stopWatching(sessionName);
  (await import('./gemini-watcher.js')).stopWatching(sessionName);
}

export async function rebuildSubSessions(subSessions: SubSessionRecord[]): Promise<void> {
  const { startWatchingFile, claudeProjectDir, isWatching } = await import('./jsonl-watcher.js');
  const { startWatchingById, isWatching: isCodexWatching, isFileClaimedByOther } = await import('./codex-watcher.js');
  const { startWatching: startGeminiWatching, startWatchingDiscovered: startGeminiWatchingDiscovered, isWatching: isGeminiWatching } = await import('./gemini-watcher.js');

  for (const sub of subSessions) {
    const sessionName = subSessionName(sub.id);
    const exists = await sessionExists(sessionName);
    if (!exists) {
      await startSubSession(sub).catch(() => {});
    } else {
      const stored = getSession(sessionName);
      if (sub.type === 'claude-code' && sub.ccSessionId && sub.cwd && !isWatching(sessionName)) {
        startWatchingFile(sessionName, path.join(claudeProjectDir(sub.cwd), `${sub.ccSessionId}.jsonl`));
      } else if (sub.type === 'codex' && !isCodexWatching(sessionName)) {
        const uuid = stored?.codexSessionId;
        if (uuid && !isFileClaimedByOther(sessionName, uuid)) {
          startWatchingById(sessionName, uuid, sub.codexModel ?? undefined);
        }
      } else if (sub.type === 'gemini' && !isGeminiWatching(sessionName)) {
        if (sub.geminiSessionId) {
          startGeminiWatching(sessionName, sub.geminiSessionId);
        } else if (sub._fileSnapshot) {
          startGeminiWatchingDiscovered(sessionName, sub._fileSnapshot, sub._onGeminiDiscovered);
        }
      }
      upsertSession({
        name: sessionName, projectName: sessionName, agentType: sub.type, agentVersion: stored?.agentVersion ?? await getAgentVersion(sub.type as AgentType, sub.shellBin ?? undefined), role: 'w1', state: 'running',
        projectDir: sub.cwd ?? '', ccSessionId: sub.ccSessionId ?? undefined,
        codexSessionId: stored?.codexSessionId,
        restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now()
      });
    }
  }
}

export async function detectShells(): Promise<string[]> {
  const CANDIDATES = ['fish', 'zsh', 'bash', 'sh'];
  const SEARCH_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const shells: string[] = [];
  const envShell = process.env.SHELL;
  if (envShell && existsSync(envShell)) shells.push(envShell);
  for (const dir of SEARCH_PATHS) {
    for (const candidate of CANDIDATES) {
      const full = `${dir}/${candidate}`;
      if (existsSync(full) && !shells.includes(full)) shells.push(full);
    }
  }
  return shells;
}

export async function readSubSessionResponse(sessionName: string): Promise<{ status: 'working' | 'idle'; response?: string }> {
  const { capturePane } = await import('../agent/tmux.js');
  const { detectStatus } = await import('../agent/detect.js');
  const lines = await capturePane(sessionName).catch(() => []);
  if (!(await sessionExists(sessionName))) return { status: 'idle', response: '' };
  const { getSession } = await import('../store/session-store.js');
  const record = getSession(sessionName);
  const agentType = (record?.agentType ?? 'shell') as AgentType;
  const status = (agentType === 'codex' || agentType === 'gemini') && record?.state
    ? (record.state === 'idle' ? 'idle' : 'thinking')
    : detectStatus(lines, agentType);
  if (status !== 'idle') return { status: 'working' };
  const events = timelineStore.read(sessionName);
  const lastUserMsgIdx = events.map((e) => e.type).lastIndexOf('user.message');
  const responseEvents = lastUserMsgIdx >= 0 ? events.slice(lastUserMsgIdx + 1) : events;
  const textParts = responseEvents.filter((e) => e.type === 'assistant.text').map((e) => String(e.payload.text ?? ''));
  return { status: 'idle', response: textParts.length > 0 ? textParts.join('\n') : lines.join('\n') };
}
