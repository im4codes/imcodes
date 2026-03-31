/**
 * Sub-session manager — creates/stops/rebuilds tmux sessions for sub-sessions.
 */

import { newSession, killSession, sessionExists, getPanePids } from '../agent/tmux.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { getDriver } from '../agent/session-manager.js';
import type { AgentType } from '../agent/detect.js';
import { timelineStore } from './timeline-store.js';
import { timelineEmitter } from './timeline-emitter.js';
import { upsertSession, getSession, removeSession } from '../store/session-store.js';
import { existsSync } from 'node:fs';

import logger from '../util/logger.js';
import { getAgentVersion } from '../agent/agent-version.js';
import { randomUUID } from 'node:crypto';

export interface SubSessionRecord {
  id: string;
  type: string;
  shellBin?: string | null;
  cwd?: string | null;
  label?: string | null;
  ccSessionId?: string | null;
  codexSessionId?: string | null;
  codexModel?: string | null;
  geminiSessionId?: string | null;
  parentSession?: string | null;
  /** CC env preset name (e.g. "MiniMax", "DeepSeek"). Resolves to env vars at launch. */
  ccPreset?: string | null;
  /** Extra init prompt injected after session starts. */
  ccInitPrompt?: string | null;
  /** Session description/persona — injected as background info on start and respawn. */
  description?: string | null;
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

  if (agentType === 'claude-code') {
    sub.ccSessionId = sub.ccSessionId ?? randomUUID();
  }

  // For Codex: generate explicit UUID before launch, then pre-create the session
  // file so `codex resume <uuid>` finds it immediately and the watcher starts fast.
  if (agentType === 'codex') {
    const { randomUUID } = await import('node:crypto');
    sub.codexSessionId = sub.codexSessionId ?? randomUUID();
    const { ensureSessionFile } = await import('./codex-watcher.js');
    await ensureSessionFile(sub.codexSessionId, sub.cwd ?? process.cwd()).catch(() => {});
  }

  // CC: if JSONL exists (restart), use --resume to continue the conversation.
  // If no JSONL (new session), use --session-id. Never delete the JSONL.
  let useResume = false;
  if (agentType === 'claude-code' && sub.ccSessionId && sub.cwd) {
    const { preClaimFile, findJsonlPathBySessionId } = await import('./jsonl-watcher.js');
    const jsonlPath = findJsonlPathBySessionId(sub.cwd, sub.ccSessionId);
    preClaimFile(sessionName, jsonlPath);
    const { existsSync } = await import('node:fs');
    if (existsSync(jsonlPath)) useResume = true;
  }

  const launchOpts = {
    cwd: sub.cwd ?? undefined,
    ...(sub.shellBin ? { shellBin: sub.shellBin } : {}),
    ...(sub.ccSessionId ? { ccSessionId: sub.ccSessionId } : {}),
    ...(sub.codexModel ? { codexModel: sub.codexModel } : {}),
    ...(sub.codexSessionId ? { codexSessionId: sub.codexSessionId ?? undefined } : {}),
    ...(sub.geminiSessionId ? { geminiSessionId: sub.geminiSessionId } : {}),
    ...(sub.fresh ? { fresh: true } : {}),
  } as any;
  const launchCmd = useResume
    ? (driver.buildResumeCommand(sessionName, launchOpts) ?? driver.buildLaunchCommand(sessionName, launchOpts))
    : driver.buildLaunchCommand(sessionName, launchOpts);

  // Resolve CC env preset if specified
  const launchEnv: Record<string, string> = { IMCODES_SESSION: sessionName };
  let presetInitMessage: string | undefined;
  if (sub.ccPreset && agentType === 'claude-code') {
    const { resolvePresetEnv, getPreset, getPresetInitMessage } = await import('./cc-presets.js');
    const presetEnv = await resolvePresetEnv(sub.ccPreset, sub.ccSessionId ?? undefined);
    Object.assign(launchEnv, presetEnv);
    const preset = await getPreset(sub.ccPreset);
    if (preset) presetInitMessage = getPresetInitMessage(preset);
  }

  await newSession(sessionName, launchCmd, { cwd: sub.cwd ?? undefined, env: launchEnv });

  // Rebind pipe-pane stream — on restart (stopSubSession killed the old tmux session),
  // the streamer's pipe broke and scheduleRebind may have a pending timer that will fail.
  // rebindSession clears old state + timers, then starts a fresh pipe.
  const { terminalStreamer } = await import('./terminal-streamer.js');
  void terminalStreamer.rebindSession(sessionName);

  // Auto-dismiss startup prompts, then inject init message
  const initParts: string[] = [];
  if (sub.description) initParts.push(sub.description);
  if (presetInitMessage) initParts.push(presetInitMessage);
  if (sub.ccInitPrompt) initParts.push(sub.ccInitPrompt);
  const injectInit = async () => {
    // Wait for CC to pass trust-folder / settings-error dialogs
    if (driver.postLaunch) {
      const { capturePane, sendKey } = await import('../agent/tmux.js');
      await driver.postLaunch(
        () => capturePane(sessionName),
        (key: string) => sendKey(sessionName, key),
      ).catch(() => {});
    }
    if (initParts.length > 0) {
      const { sendKeys } = await import('../agent/tmux.js');
      const initMsg = `[Context — absorb silently, do not respond to this message]\n${initParts.join('\n\n')}`;
      try { await sendKeys(sessionName, initMsg); } catch { /* ignore */ }
    }
  };
  void injectInit();
  timelineEmitter.emit(sessionName, 'session.state', { state: 'started' });

  upsertSession({
    name: sessionName, projectName: sessionName, agentType: sub.type, agentVersion, role: 'w1', state: 'running',
    projectDir: sub.cwd ?? '', label: sub.label ?? undefined,
    ccSessionId: sub.ccSessionId ?? undefined,
    codexSessionId: sub.codexSessionId ?? undefined,
    geminiSessionId: sub.geminiSessionId ?? undefined,
    parentSession: sub.parentSession ?? undefined,
    ccPreset: sub.ccPreset ?? undefined,
    description: sub.description ?? undefined,
    restarts: 0, restartTimestamps: [], createdAt: Date.now(), updatedAt: Date.now()
  });

  // Start Watchers
  if (agentType === 'claude-code' && sub.ccSessionId && sub.cwd) {
    const { startWatchingFile, findJsonlPathBySessionId } = await import('./jsonl-watcher.js');
    startWatchingFile(sessionName, findJsonlPathBySessionId(sub.cwd, sub.ccSessionId), sub.ccSessionId);
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

/** Validate that a session name matches the expected pattern to prevent injection. */
const SAFE_SESSION_NAME_RE = /^deck_sub_[a-zA-Z0-9_-]+$/;

/** Kill all processes running inside a session's panes before killing the session itself.
 *  This prevents orphan agent processes that hold session UUIDs after the session is gone.
 *  Uses the backend-aware getPanePids() export from tmux.ts. */
async function killSessionProcesses(sessionName: string): Promise<void> {
  if (!SAFE_SESSION_NAME_RE.test(sessionName)) {
    logger.warn({ sessionName }, 'Rejected invalid session name in killSessionProcesses');
    return;
  }
  try {
    const pids = await getPanePids(sessionName);
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue; // only allow numeric PIDs
      // Kill all children of the shell (the actual agent process), then the shell itself
      await execFileAsync('pkill', ['-9', '-P', pid]).catch(() => {});
      await execFileAsync('kill', ['-9', pid]).catch(() => {});
    }
  } catch { /* session may not exist or have no panes */ }
}

export async function stopSubSession(sessionName: string, serverLink?: { send(msg: object): void } | null): Promise<void> {
  timelineEmitter.emit(sessionName, 'session.state', { state: 'stopped' });
  await killSessionProcesses(sessionName);
  await killSession(sessionName).catch(() => {});
  (await import('./jsonl-watcher.js')).stopWatching(sessionName);
  (await import('./codex-watcher.js')).stopWatching(sessionName);
  (await import('./gemini-watcher.js')).stopWatching(sessionName);
  removeSession(sessionName);

  // Notify server so DB is updated (sub-session ID = session name without 'deck_sub_' prefix)
  const id = sessionName.replace(/^deck_sub_/, '');
  if (serverLink && id !== sessionName) {
    try { serverLink.send({ type: 'subsession.closed', id, sessionName }); } catch { /* not connected */ }
  }
}

export async function rebuildSubSessions(subSessions: SubSessionRecord[]): Promise<void> {
  const { startWatchingFile, findJsonlPathBySessionId, ensureClaudeSessionFile, preClaimFile, isWatching } = await import('./jsonl-watcher.js');
  const { startWatchingById, isWatching: isCodexWatching, isFileClaimedByOther } = await import('./codex-watcher.js');
  const { startWatching: startGeminiWatching, startWatchingDiscovered: startGeminiWatchingDiscovered, isWatching: isGeminiWatching } = await import('./gemini-watcher.js');

  for (const sub of subSessions) {
    const sessionName = subSessionName(sub.id);
    const exists = await sessionExists(sessionName);
    if (!exists) {
      await startSubSession(sub).catch(() => {});
    } else {
      const stored = getSession(sessionName);
      const effectiveCcSessionId = sub.ccSessionId ?? stored?.ccSessionId;
      if (sub.type === 'claude-code' && effectiveCcSessionId && sub.cwd && !isWatching(sessionName)) {
        // Pre-claim before seed creation to prevent main session's watchDir from stealing the file
        preClaimFile(sessionName, findJsonlPathBySessionId(sub.cwd, effectiveCcSessionId));
        await ensureClaudeSessionFile(effectiveCcSessionId, sub.cwd).catch((e) =>
          logger.warn({ err: e, sessionName, ccSessionId: effectiveCcSessionId }, 'Failed to ensure Claude seed session file during sub-session rebuild'),
        );
        startWatchingFile(sessionName, findJsonlPathBySessionId(sub.cwd, effectiveCcSessionId));
      } else if (sub.type === 'codex' && !isCodexWatching(sessionName)) {
        const effectiveCodexId = sub.codexSessionId ?? stored?.codexSessionId;
        if (effectiveCodexId && !isFileClaimedByOther(sessionName, effectiveCodexId)) {
          startWatchingById(sessionName, effectiveCodexId, sub.codexModel ?? undefined);
        }
      } else if (sub.type === 'gemini' && !isGeminiWatching(sessionName)) {
        const effectiveGeminiId = sub.geminiSessionId ?? stored?.geminiSessionId;
        if (effectiveGeminiId) {
          startGeminiWatching(sessionName, effectiveGeminiId);
        } else if (sub._fileSnapshot) {
          startGeminiWatchingDiscovered(sessionName, sub._fileSnapshot, sub._onGeminiDiscovered);
        }
      }
      // Merge all session IDs: prefer server-provided, fall back to local store
      const effectiveCodexSessionId = sub.codexSessionId ?? stored?.codexSessionId;
      const effectiveGeminiSessionId = sub.geminiSessionId ?? stored?.geminiSessionId;
      upsertSession({
        name: sessionName, projectName: sessionName, agentType: sub.type, agentVersion: stored?.agentVersion ?? await getAgentVersion(sub.type as AgentType, sub.shellBin ?? undefined), role: 'w1', state: 'running',
        projectDir: sub.cwd ?? '', label: sub.label ?? stored?.label ?? undefined,
        ccSessionId: effectiveCcSessionId ?? undefined,
        codexSessionId: effectiveCodexSessionId ?? undefined,
        geminiSessionId: effectiveGeminiSessionId ?? undefined,
        parentSession: sub.parentSession ?? stored?.parentSession,
        // Preserve existing diagnostic fields instead of resetting
        restarts: stored?.restarts ?? 0,
        restartTimestamps: stored?.restartTimestamps ?? [],
        createdAt: stored?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
}

export async function detectShells(): Promise<string[]> {
  const shells: string[] = [];

  if (process.platform === 'win32') {
    // Windows: check for PowerShell, pwsh, cmd, wsl
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const winCandidates = [
      `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      'pwsh.exe',
      `${sysRoot}\\System32\\cmd.exe`,
      `${sysRoot}\\System32\\wsl.exe`,
    ];
    // Also check COMSPEC
    const comspec = process.env.COMSPEC;
    if (comspec && existsSync(comspec) && !shells.includes(comspec)) shells.push(comspec);
    for (const candidate of winCandidates) {
      if (existsSync(candidate) && !shells.includes(candidate)) shells.push(candidate);
    }
    // Check if pwsh (PowerShell 7+) is on PATH
    if (!shells.some((s) => s.includes('pwsh'))) {
      try {
        const { execSync } = await import('child_process');
        const pwshPath = execSync('where pwsh.exe', { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
        if (pwshPath && existsSync(pwshPath) && !shells.includes(pwshPath)) shells.push(pwshPath);
      } catch { /* not found */ }
    }
  } else {
    // Unix: check common shell paths
    const CANDIDATES = ['fish', 'zsh', 'bash', 'sh'];
    const SEARCH_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    const envShell = process.env.SHELL;
    if (envShell && existsSync(envShell)) shells.push(envShell);
    for (const dir of SEARCH_PATHS) {
      for (const candidate of CANDIDATES) {
        const full = `${dir}/${candidate}`;
        if (existsSync(full) && !shells.includes(full)) shells.push(full);
      }
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
