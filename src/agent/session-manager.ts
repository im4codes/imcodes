import { newSession, killSession, sessionExists, listSessions as tmuxListSessions, sendKeys, sendKey, capturePane, showBuffer, getPaneId, getPaneCwd, cleanupOrphanFifos } from './tmux.js';
import { ClaudeCodeDriver } from './drivers/claude-code.js';
import { CodexDriver } from './drivers/codex.js';
import { OpenCodeDriver } from './drivers/opencode.js';
import { ShellDriver } from './drivers/shell.js';
import { GeminiDriver } from './drivers/gemini.js';
import type { AgentDriver } from './drivers/base.js';
import type { AgentType } from './detect.js';
import { setupCCStopHook } from './signal.js';
import { setupCodexNotify, setupOpenCodePlugin } from './notify-setup.js';
import {
  getSession,
  upsertSession,
  removeSession,
  listSessions as storeSessions,
  updateSessionState,
  type SessionRecord,
} from '../store/session-store.js';
import logger from '../util/logger.js';
import { timelineEmitter } from '../daemon/timeline-emitter.js';
import { startWatching, startWatchingFile, stopWatching, isWatching, claudeProjectDir } from '../daemon/jsonl-watcher.js';
import { startWatching as startCodexWatching, startWatchingSpecificFile as startCodexWatchingFile, startWatchingById as startCodexWatchingById, stopWatching as stopCodexWatching, isWatching as isCodexWatching, findRolloutPathByUuid, extractNewRolloutUuid, ensureSessionFile as ensureCodexSessionFile } from '../daemon/codex-watcher.js';
import { startWatching as startGeminiWatching, startWatchingLatest as startGeminiWatchingLatest, stopWatching as stopGeminiWatching, isWatching as isGeminiWatching } from '../daemon/gemini-watcher.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getAgentVersion } from './agent-version.js';

/** Start JSONL watcher for a CC session — uses specific file if ccSessionId known, else directory scan. */
function startCCWatcher(sessionName: string, projectDir: string, ccSessionId?: string): void {
  if (ccSessionId) {
    const jsonlPath = join(claudeProjectDir(projectDir), `${ccSessionId}.jsonl`);
    startWatchingFile(sessionName, jsonlPath).catch((e) =>
      logger.warn({ err: e, session: sessionName }, 'jsonl-watcher startWatchingFile failed'),
    );
  } else {
    startWatching(sessionName, projectDir).catch((e) =>
      logger.warn({ err: e, session: sessionName }, 'jsonl-watcher start failed'),
    );
  }
}

// Restart loop prevention: max 3 restarts within 5 minutes
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;

type SessionEventCallback = (event: 'started' | 'stopped' | 'error', session: string, state: string) => void;
let _onSessionEvent: SessionEventCallback | null = null;

export function setSessionEventCallback(cb: SessionEventCallback): void {
  _onSessionEvent = cb;
}

function emitSessionEvent(event: 'started' | 'stopped' | 'error', session: string, state: string): void {
  try { _onSessionEvent?.(event, session, state); } catch { /* ignore */ }
  timelineEmitter.emit(session, 'session.state', { state: event });
}

/** Called after upsert (record provided) or remove (record=null, name provided). */
type SessionPersistCallback = (record: SessionRecord | null, name: string) => Promise<void>;
let _onSessionPersist: SessionPersistCallback | null = null;

export function setSessionPersistCallback(cb: SessionPersistCallback): void {
  _onSessionPersist = cb;
}

function emitSessionPersist(record: SessionRecord | null, name: string): void {
  _onSessionPersist?.(record, name).catch((e) => logger.warn({ err: e, name }, 'session persist callback failed'));
}

export interface ProjectConfig {
  name: string;
  dir: string;
  brainType: AgentType;
  workerTypes: AgentType[]; // one entry per worker slot
  /** When true, start fresh sessions without resuming last conversation. */
  fresh?: boolean;
}

export function getDriver(type: AgentType): AgentDriver {
  switch (type) {
    case 'claude-code': return new ClaudeCodeDriver();
    case 'codex': return new CodexDriver();
    case 'opencode': return new OpenCodeDriver();
    case 'shell': return new ShellDriver();
    case 'script': return new ShellDriver();
    case 'gemini': return new GeminiDriver();
  }
}

export function sessionName(project: string, role: 'brain' | `w${number}`): string {
  return `deck_${project}_${role}`;
}

/** Start all sessions for a project (brain + workers). */
export async function startProject(config: ProjectConfig): Promise<void> {
  const { name, dir, brainType, workerTypes, fresh } = config;

  await launchSession({ name: sessionName(name, 'brain'), projectName: name, role: 'brain', agentType: brainType, projectDir: dir, fresh });

  for (let i = 0; i < workerTypes.length; i++) {
    const role = `w${i + 1}` as `w${number}`;
    await launchSession({ name: sessionName(name, role), projectName: name, role, agentType: workerTypes[i], projectDir: dir, fresh });
  }
}

/** Stop all sessions for a project and remove them from the store. */
export async function stopProject(projectName: string): Promise<void> {
  const sessions = storeSessions(projectName);
  for (const s of sessions) {
    stopWatching(s.name);
    stopCodexWatching(s.name);
    stopGeminiWatching(s.name);
    await killSession(s.name).catch(() => {});
    removeSession(s.name);
    emitSessionPersist(null, s.name);
    emitSessionEvent('stopped', s.name, 'stopped');
  }
}

/** Kill tmux sessions and watchers for a project but keep store records (for restart). */
export async function teardownProject(projectName: string): Promise<void> {
  const sessions = storeSessions(projectName);
  for (const s of sessions) {
    stopWatching(s.name);
    stopCodexWatching(s.name);
    stopGeminiWatching(s.name);
    await killSession(s.name).catch(() => {});
  }
}

/** Clean up orphan FIFOs from previous daemon runs and reconcile session store on startup. */
export async function initOnStartup(): Promise<void> {
  await cleanupOrphanFifos();
}

// Pattern for valid imcodes session names: deck_{project}_{brain|wN}
const DECK_SESSION_RE = /^deck_(.+)_(brain|w\d+)$/;

/** Reconcile store with actual tmux on daemon start — restart missing sessions and discover orphans. */
export async function restoreFromStore(): Promise<void> {
  const all = storeSessions();
  const live = await tmuxListSessions();

  // 1. Restart store sessions missing from tmux; start jsonl-watcher for live ones
  for (const s of all) {
    if (s.state === 'stopped') continue;
    // Sub-sessions (deck_sub_*) are managed by rebuildSubSessions triggered by the browser.
    // Their JSONL watcher uses a specific file path via startWatchingFile.
    // Handling them here would fall back to directory scan (startWatching), stealing the main
    // session's JSONL file since sub-sessions have no ccSessionId in the session-store.
    if (s.name.startsWith('deck_sub_')) continue;
    if (!live.includes(s.name)) {
      logger.info({ session: s.name }, 'Missing on restore, restarting');
      await restartSession(s);
    } else if (s.agentType === 'claude-code' && s.projectDir && !isWatching(s.name)) {
      startCCWatcher(s.name, s.projectDir, s.ccSessionId);
    } else if (s.agentType === 'codex' && s.projectDir && !isCodexWatching(s.name)) {
      if (s.codexSessionId) {
        findRolloutPathByUuid(s.codexSessionId).then((rolloutPath) => {
          if (rolloutPath) {
            startCodexWatchingFile(s.name, rolloutPath).catch((e) =>
              logger.warn({ err: e, session: s.name }, 'codex-watcher startWatchingSpecificFile failed (restore)'),
            );
          } else {
            startCodexWatching(s.name, s.projectDir).catch((e) =>
              logger.warn({ err: e, session: s.name }, 'codex-watcher start failed (restore uuid fallback)'),
            );
          }
        }).catch(() => {
          startCodexWatching(s.name, s.projectDir).catch((e) =>
            logger.warn({ err: e, session: s.name }, 'codex-watcher start failed (restore)'),
          );
        });
      } else {
        startCodexWatching(s.name, s.projectDir).catch((e) =>
          logger.warn({ err: e, session: s.name }, 'codex-watcher start failed (restore)'),
        );
      }
    } else if (s.agentType === 'gemini' && !isGeminiWatching(s.name)) {
      if (s.geminiSessionId) {
        startGeminiWatching(s.name, s.geminiSessionId).catch((e) =>
          logger.warn({ err: e, session: s.name }, 'gemini-watcher start failed (restore)'),
        );
      } else {
        // Fallback: watch latest for orphans/incomplete records
        startGeminiWatching(s.name, '').catch((e) =>
          logger.warn({ err: e, session: s.name }, 'gemini-watcher start latest failed (restore)'),
        );
      }
    }
  }

  // 2. Discover tmux sessions unknown to the store (e.g. created before daemon started)
  const knownNames = new Set(all.map((s) => s.name));
  for (const name of live) {
    if (knownNames.has(name)) continue;
    const match = DECK_SESSION_RE.exec(name);
    if (!match) continue; // not a imcodes session

    const projectName = match[1];
    const role = match[2] as 'brain' | `w${number}`;

    // Infer metadata from tmux pane
    const [projectDir, paneId] = await Promise.all([
      getPaneCwd(name).catch(() => ''),
      getPaneId(name).catch(() => undefined as string | undefined),
    ]);

    const record: SessionRecord = {
      name,
      projectName,
      role,
      agentType: 'claude-code', // default; most common
      agentVersion: await getAgentVersion('claude-code'),
      projectDir,
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(paneId ? { paneId } : {}),
    };

    upsertSession(record);
    emitSessionPersist(record, name);
    emitSessionEvent('started', name, 'running');
    if (record.agentType === 'claude-code' && projectDir) {
      startCCWatcher(name, projectDir, record.ccSessionId);
    } else if (record.agentType === 'codex' && projectDir) {
      startCodexWatching(name, projectDir).catch((e) =>
        logger.warn({ err: e, session: name }, 'codex-watcher start failed (discover)'),
      );
    }
    logger.info({ session: name, projectDir }, 'Discovered unregistered tmux session, registered');
  }
}

/**
 * Auto-restart a crashed session.
 * Enforces max 3 restarts within 5 minutes; marks as error if exceeded.
 */
export async function restartSession(record: SessionRecord): Promise<boolean> {
  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = record.restartTimestamps.filter((t) => t > windowStart);

  if (recentRestarts.length >= MAX_RESTARTS) {
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error');
    emitSessionEvent('error', record.name, 'error');
    return false;
  }

  const updated: SessionRecord = {
    ...record,
    restarts: record.restarts + 1,
    restartTimestamps: [...recentRestarts, now],
    state: 'running',
    updatedAt: now,
  };
  upsertSession(updated);

  await launchSession({
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: record.agentType as AgentType,
    projectDir: record.projectDir,
    skipStore: true,
    ccSessionId: record.ccSessionId,
    codexSessionId: record.codexSessionId,
  });

  return true;
}

interface LaunchOpts {
  name: string;
  projectName: string;
  role: 'brain' | `w${number}`;
  agentType: AgentType;
  projectDir: string;
  skipStore?: boolean;
  extraEnv?: Record<string, string>;
  /** When true, start fresh without resuming last conversation. */
  fresh?: boolean;
  /** CC session UUID for --session-id / --resume. Generated if absent for CC sessions. */
  ccSessionId?: string;
  /** Codex session UUID for `codex resume <UUID>`. */
  codexSessionId?: string;
  /** Gemini session UUID for `gemini --resume <UUID>`. */
  geminiSessionId?: string;
}

export async function launchSession(opts: LaunchOpts): Promise<void> {
  const { name, projectName, role, agentType, projectDir, skipStore, extraEnv, fresh } = opts;
  const driver = getDriver(agentType);
  const agentVersion = await getAgentVersion(agentType);

  // Configure agent-specific hooks/signals
  if (agentType === 'claude-code') {
    await setupCCStopHook().catch((e) => logger.warn({ err: e }, 'CC hook setup failed'));
  } else if (agentType === 'codex') {
    await setupCodexNotify(projectDir, name).catch((e) => logger.warn({ err: e }, 'Codex notify setup failed'));
  } else if (agentType === 'opencode') {
    const oc = driver as OpenCodeDriver;
    await oc.ensurePermissions(projectDir).catch((e) => logger.warn({ err: e }, 'OpenCode permissions failed'));
    await setupOpenCodePlugin(projectDir, name).catch((e) => logger.warn({ err: e }, 'OpenCode plugin setup failed'));
  }

  const exists = await sessionExists(name);

  // For CC sessions: resolve ccSessionId only when actually launching a new tmux session.
  // If the session already exists in tmux, use the stored UUID (if any) but don't generate
  // a fresh one — that would point startWatchingFile at a non-existent file.
  let ccSessionId = opts.ccSessionId;
  if (agentType === 'claude-code') {
    const stored = getSession(name)?.ccSessionId;
    if (stored) {
      ccSessionId = stored;
    } else if (!exists) {
      // Launching fresh — generate UUID now so JSONL path is deterministic
      ccSessionId = ccSessionId ?? randomUUID();
    }
    // If exists and no stored UUID: ccSessionId stays undefined → fall back to dir scan
  }

  // For Codex sessions: resolve codexSessionId from opts or store.
  // If the stored UUID's rollout file no longer exists on disk, clear it so we
  // launch fresh and capture a new UUID (avoids an infinite resume-crash loop).
  let codexSessionId = opts.codexSessionId;
  if (agentType === 'codex' && !codexSessionId) {
    codexSessionId = getSession(name)?.codexSessionId;
  }
  if (agentType === 'codex' && codexSessionId) {
    const rolloutPath = await findRolloutPathByUuid(codexSessionId);
    if (!rolloutPath) {
      // File missing (e.g. cleaned up or new day) — pre-create it so
      // `codex resume <uuid>` can find it and the watcher starts immediately.
      await ensureCodexSessionFile(codexSessionId, projectDir).catch((e) => {
        logger.warn({ err: e, session: name, codexSessionId }, 'Failed to pre-create Codex session file');
      });
    }
  }

  // For Gemini sessions: resolve geminiSessionId from opts or store.
  // If launching fresh, run a one-shot stream-json probe to obtain the UUID
  // generated by Gemini, then reuse it for all subsequent --resume launches.
  let geminiSessionId = opts.geminiSessionId;
  if (agentType === 'gemini') {
    if (!geminiSessionId) {
      geminiSessionId = getSession(name)?.geminiSessionId;
    }
    if (!geminiSessionId && !exists) {
      try {
        const geminiDriver = driver as import('./drivers/gemini.js').GeminiDriver;
        geminiSessionId = await geminiDriver.resolveSessionId(projectDir);
        logger.info({ session: name, geminiSessionId }, 'Resolved Gemini session ID');
        // Inject project memory directly into the session file (not via sent message)
        if (geminiSessionId) {
          const { injectGeminiMemory } = await import('../daemon/memory-inject.js');
          injectGeminiMemory(geminiSessionId, projectDir).catch((e) =>
            logger.warn({ err: e, session: name }, 'Gemini memory injection failed (non-fatal)'),
          );
        }
      } catch (e) {
        logger.warn({ err: e, session: name }, 'Failed to resolve Gemini session ID — launching without --resume');
      }
    }
  }

  if (!exists) {
    // For CC sessions with an existing JSONL file: use --resume instead of --session-id.
    // Claude 2.1+ rejects --session-id when the UUID already has a JSONL on disk ("already in use").
    let launchCmd: string;
    if (agentType === 'claude-code' && ccSessionId && !fresh) {
      const jsonlPath = join(claudeProjectDir(projectDir), `${ccSessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        launchCmd = driver.buildResumeCommand(name, { cwd: projectDir, ccSessionId }) ?? driver.buildLaunchCommand(name, { cwd: projectDir, fresh, ccSessionId, codexSessionId, geminiSessionId });
      } else {
        launchCmd = driver.buildLaunchCommand(name, { cwd: projectDir, fresh, ccSessionId, codexSessionId, geminiSessionId });
      }
    } else {
      launchCmd = driver.buildLaunchCommand(name, { cwd: projectDir, fresh, ccSessionId, codexSessionId, geminiSessionId });
    }
    await newSession(name, launchCmd, { cwd: projectDir, env: extraEnv });
    logger.info({ session: name, agentType, ccSessionId, codexSessionId, geminiSessionId }, 'Launched session');
  }

  // Always record paneId — it changes on each session creation/restart
  const paneId = await getPaneId(name).catch(() => undefined);
  if (paneId) {
    const existing = getSession(name);
    if (existing) {
      upsertSession({ ...existing, paneId });
    }
  }

  // For Codex fresh launch: capture UUID from rollout file immediately after start
  if (agentType === 'codex' && !codexSessionId && !exists) {
    const launchTime = Date.now();
    try {
      codexSessionId = await extractNewRolloutUuid(projectDir, launchTime) || undefined;
      if (codexSessionId) {
        logger.info({ session: name, codexSessionId }, 'Codex session UUID captured');
      }
    } catch (e) {
      logger.warn({ err: e, session: name }, 'Codex UUID extraction failed');
    }
  }

  if (!skipStore) {
    const existing = getSession(name);
    const record: SessionRecord = {
      name,
      projectName,
      role,
      agentType,
      agentVersion,
      projectDir,
      state: 'running',
      restarts: existing?.restarts ?? 0,
      restartTimestamps: existing?.restartTimestamps ?? [],
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      paneId,
      ...(ccSessionId ? { ccSessionId } : {}),
      ...(codexSessionId ? { codexSessionId } : {}),
      ...(geminiSessionId ? { geminiSessionId } : {}),
    };
    upsertSession(record);
    emitSessionPersist(record, name);
  }

  emitSessionEvent('started', name, 'running');

  // Start structured-event watchers for supported agent types
  if (agentType === 'claude-code') {
    startCCWatcher(name, projectDir, ccSessionId);
  } else if (agentType === 'codex') {
    if (codexSessionId) {
      // UUID already known — watch the specific file
      findRolloutPathByUuid(codexSessionId).then((rolloutPath) => {
        if (rolloutPath) {
          startCodexWatchingFile(name, rolloutPath).catch((e) =>
            logger.warn({ err: e, session: name }, 'codex-watcher startWatchingSpecificFile failed'),
          );
        } else {
          // UUID known but file not found yet — fall back to dir scan
          startCodexWatching(name, projectDir).catch((e) =>
            logger.warn({ err: e, session: name }, 'codex-watcher start failed (uuid fallback)'),
          );
        }
      }).catch(() => {
        startCodexWatching(name, projectDir).catch((e) =>
          logger.warn({ err: e, session: name }, 'codex-watcher start failed'),
        );
      });
    } else {
      // No UUID — use dir scan
      startCodexWatching(name, projectDir).catch((e) =>
        logger.warn({ err: e, session: name }, 'codex-watcher start failed'),
      );
    }
  } else if (agentType === 'gemini') {
    if (geminiSessionId) {
      startGeminiWatching(name, geminiSessionId).catch((e) =>
        logger.warn({ err: e, session: name }, 'gemini-watcher start failed'),
      );
    } else {
      // resolveSessionId failed — fall back to watching the most recently modified file
      startGeminiWatchingLatest(name).catch((e) =>
        logger.warn({ err: e, session: name }, 'gemini-watcher start latest failed'),
      );
    }
  }

  // Auto-dismiss startup prompts (trust folder, settings errors, update dialogs)
  if (driver.postLaunch) {
    driver.postLaunch(
      () => capturePane(name),
      (key) => sendKey(name, key),
    ).catch((e) => logger.warn({ err: e, session: name }, 'postLaunch failed'));
  }
}

/** Bound ops for a session (used by status poller / response collector). */
export function getSessionOps(name: string) {
  return {
    capturePane: () => capturePane(name),
    sendKeys: (keys: string) => sendKeys(name, keys),
    showBuffer: () => showBuffer(),
  };
}

export interface AutoFixProjectConfig {
  projectName: string;
  projectDir: string;
  coderType: AgentType;
  auditorType: AgentType;
  /** Feature branch already checked out in projectDir. */
  featureBranch: string;
}

/**
 * Start sessions for auto-fix mode:
 * - w1 (coder) session: launched in projectDir (feature branch already checked out)
 * - brain session: launched with audit-enhanced system prompt env var so the brain dispatcher
 *   can call registerAutoFixExtensions() on startup
 */
export async function startAutoFixProject(config: AutoFixProjectConfig): Promise<{
  coderSession: string;
  auditorSession: string;
}> {
  const { projectName, projectDir, coderType, auditorType, featureBranch } = config;

  const coderSession = sessionName(projectName, 'w1');
  const auditorSession = sessionName(projectName, 'brain');

  // Worker (coder) session — regular launch in feature branch dir
  await launchSession({
    name: coderSession,
    projectName,
    role: 'w1',
    agentType: coderType,
    projectDir,
  });

  // Brain (auditor) session — set RCC_AUTOFIX_MODE=1 so brain dispatcher enables audit commands
  await launchSession({
    name: auditorSession,
    projectName,
    role: 'brain',
    agentType: auditorType,
    projectDir,
    extraEnv: { RCC_AUTOFIX_MODE: '1', RCC_AUTOFIX_BRANCH: featureBranch },
  });

  logger.info({ projectName, coderSession, auditorSession, featureBranch }, 'Auto-fix sessions started');

  return { coderSession, auditorSession };
}
