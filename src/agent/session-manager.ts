import { newSession, killSession, sessionExists, isPaneAlive, respawnPane, listSessions as tmuxListSessions, sendKeys, sendKey, capturePane, showBuffer, getPaneId, getPaneCwd, getPaneStartCommand, cleanupOrphanFifos, BACKEND } from './tmux.js';
import { randomUUID } from 'node:crypto';
import { ClaudeCodeDriver } from './drivers/claude-code.js';
import { CodexDriver } from './drivers/codex.js';
import { OpenCodeDriver } from './drivers/opencode.js';
import { ShellDriver } from './drivers/shell.js';
import { GeminiDriver } from './drivers/gemini.js';
import type { AgentDriver } from './drivers/base.js';
import type { AgentType } from './detect.js';
import { isTransportAgent } from './detect.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import { TransportSessionRuntime } from './transport-session-runtime.js';
import { ensureProviderConnected, getProvider } from './provider-registry.js';
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
import { startWatching, startWatchingFile, stopWatching, isWatching, findJsonlPathBySessionId } from '../daemon/jsonl-watcher.js';
import { startWatching as startCodexWatching, startWatchingSpecificFile as startCodexWatchingFile, startWatchingById as startCodexWatchingById, stopWatching as stopCodexWatching, isWatching as isCodexWatching, findRolloutPathByUuid } from '../daemon/codex-watcher.js';
import { startWatching as startGeminiWatching, startWatchingLatest as startGeminiWatchingLatest, stopWatching as stopGeminiWatching, isWatching as isGeminiWatching } from '../daemon/gemini-watcher.js';
import { startWatching as startOpenCodeWatching, stopWatching as stopOpenCodeWatching, isWatching as isOpenCodeWatching } from '../daemon/opencode-watcher.js';
import { resolveStructuredSessionBootstrap } from './structured-session-bootstrap.js';
import { getQwenRuntimeConfig } from './qwen-runtime-config.js';
import { getQwenDisplayMetadata } from './provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from './provider-quota.js';
import { getClaudeSdkRuntimeConfig } from './sdk-runtime-config.js';
import { getCodexRuntimeConfig } from './codex-runtime-config.js';

import { getAgentVersion } from './agent-version.js';
import { repoCache } from '../repo/cache.js';

/** Start JSONL watcher for a CC session — uses specific file if ccSessionId known, else directory scan. */
function startCCWatcher(sessionName: string, projectDir: string, ccSessionId?: string): void {
  if (ccSessionId) {
    const jsonlPath = findJsonlPathBySessionId(projectDir, ccSessionId);
    startWatchingFile(sessionName, jsonlPath, ccSessionId).catch((e) =>
      logger.warn({ err: e, session: sessionName }, 'jsonl-watcher startWatchingFile failed'),
    );
  } else {
    startWatching(sessionName, projectDir).catch((e) =>
      logger.warn({ err: e, session: sessionName }, 'jsonl-watcher start failed'),
    );
  }
}

function startStructuredWatcher(
  name: string,
  agentType: AgentType,
  projectDir: string,
  ids?: { ccSessionId?: string; codexSessionId?: string; geminiSessionId?: string; opencodeSessionId?: string },
): void {
  if (agentType === 'claude-code') {
    startCCWatcher(name, projectDir, ids?.ccSessionId);
  } else if (agentType === 'codex') {
    if (ids?.codexSessionId) {
      findRolloutPathByUuid(ids.codexSessionId).then((rolloutPath) => {
        if (rolloutPath) {
          startCodexWatchingFile(name, rolloutPath).catch((e) =>
            logger.warn({ err: e, session: name }, 'codex-watcher startWatchingSpecificFile failed'),
          );
        } else {
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
      startCodexWatching(name, projectDir).catch((e) =>
        logger.warn({ err: e, session: name }, 'codex-watcher start failed'),
      );
    }
  } else if (agentType === 'gemini') {
    if (ids?.geminiSessionId) {
      startGeminiWatching(name, ids.geminiSessionId).catch((e) =>
        logger.warn({ err: e, session: name }, 'gemini-watcher start failed'),
      );
    } else {
      startGeminiWatchingLatest(name).catch((e) =>
        logger.warn({ err: e, session: name }, 'gemini-watcher start latest failed'),
      );
    }
  } else if (agentType === 'opencode') {
    startOpenCodeWatching(name, projectDir, ids?.opencodeSessionId).catch((e) =>
      logger.warn({ err: e, session: name }, 'opencode-watcher start failed'),
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
  /** Human-readable label (e.g. original Chinese project name before sanitization). */
  label?: string;
  /** When true, start fresh sessions without resuming last conversation. */
  fresh?: boolean;
  /** Extra env vars merged into session launch (e.g. CC API preset). */
  extraEnv?: Record<string, string>;
  /** CC env preset name — persisted for respawn env injection. */
  ccPreset?: string;
}

export function getDriver(type: AgentType): AgentDriver {
  switch (type) {
    case 'claude-code': return new ClaudeCodeDriver();
    case 'codex': return new CodexDriver();
    case 'opencode': return new OpenCodeDriver();
    case 'shell': return new ShellDriver();
    case 'script': return new ShellDriver();
    case 'gemini': return new GeminiDriver();
    default:
      throw new Error(`getDriver: no tmux driver for transport agent '${type as string}'`);
  }
}

export function sessionName(project: string, role: 'brain' | `w${number}`): string {
  return `deck_${project}_${role}`;
}

/** Start all sessions for a project (brain + workers). */
export async function startProject(config: ProjectConfig): Promise<void> {
  const { name, dir, brainType, workerTypes, fresh, extraEnv, ccPreset, label } = config;

  await launchSession({ name: sessionName(name, 'brain'), projectName: name, role: 'brain', agentType: brainType, projectDir: dir, fresh, extraEnv, ccPreset, label });

  for (let i = 0; i < workerTypes.length; i++) {
    const role = `w${i + 1}` as `w${number}`;
    await launchSession({ name: sessionName(name, role), projectName: name, role, agentType: workerTypes[i], projectDir: dir, fresh, label });
  }
}

/** Stop all sessions for a project and remove them from the store. */
export async function stopProject(projectName: string): Promise<void> {
  const allSessions = storeSessions();
  const toStop = new Map<string, SessionRecord>();

  for (const session of allSessions) {
    if (session.projectName === projectName) toStop.set(session.name, session);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const session of allSessions) {
      if (!session.name.startsWith('deck_sub_')) continue;
      if (!session.parentSession) continue;
      if (toStop.has(session.name)) continue;
      if (!toStop.has(session.parentSession)) continue;
      toStop.set(session.name, session);
      changed = true;
    }
  }

  const invalidatedDirs = new Set<string>();
  for (const s of toStop.values()) {
    stopWatching(s.name);
    stopCodexWatching(s.name);
    stopGeminiWatching(s.name);
    stopOpenCodeWatching(s.name);
    const transportRuntime = transportRuntimes.get(s.name);
    if (transportRuntime) {
      if (transportRuntime.providerSessionId) unregisterProviderRoute(transportRuntime.providerSessionId);
      await transportRuntime.kill().catch(() => {});
      transportRuntimes.delete(s.name);
    } else {
      await killSession(s.name).catch(() => {});
    }
    removeSession(s.name);
    emitSessionPersist(null, s.name);
    emitSessionEvent('stopped', s.name, 'stopped');
    if (s.projectDir && !invalidatedDirs.has(s.projectDir)) {
      invalidatedDirs.add(s.projectDir);
      repoCache.invalidate(s.projectDir);
    }
  }
}

/** Kill tmux sessions and watchers for a project but keep store records (for restart). */
export async function teardownProject(projectName: string): Promise<void> {
  const sessions = storeSessions(projectName);
  for (const s of sessions) {
    stopWatching(s.name);
    stopCodexWatching(s.name);
    stopGeminiWatching(s.name);
    stopOpenCodeWatching(s.name);
    const transportRuntime = transportRuntimes.get(s.name);
    if (transportRuntime) {
      if (transportRuntime.providerSessionId) unregisterProviderRoute(transportRuntime.providerSessionId);
      await transportRuntime.kill().catch(() => {});
      transportRuntimes.delete(s.name);
    } else {
      await killSession(s.name).catch(() => {});
    }
  }
}

/** Clean up orphan FIFOs from previous daemon runs and reconcile session store on startup. */
export async function initOnStartup(): Promise<void> {
  await cleanupOrphanFifos();
}

/** Extract a UUID from tmux pane start command (supports --session-id and --resume). */
async function extractSessionUuidFromPane(sessionName: string): Promise<string | undefined> {
  try {
    const cmd = await getPaneStartCommand(sessionName);
    const match = cmd.match(/(?:--session-id|--resume)\s+([0-9a-f-]{36})/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Extract ccSessionId from tmux pane start command. */
const extractCcSessionIdFromPane = extractSessionUuidFromPane;
/** Extract geminiSessionId from tmux pane start command (gemini --resume <uuid>). */
const extractGeminiSessionIdFromPane = extractSessionUuidFromPane;
/** Extract OpenCode session ID from tmux pane start command (`opencode -s <id>`). */
async function extractOpenCodeSessionIdFromPane(sessionName: string): Promise<string | undefined> {
  try {
    const cmd = await getPaneStartCommand(sessionName);
    const match = cmd.match(/\bopencode\b[\s\S]*?(?:--session|-s)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`;|&]+))/);
    return match?.[1] ?? match?.[2] ?? match?.[3];
  } catch {
    return undefined;
  }
}

async function recoverOpenCodeSessionId(record: Pick<SessionRecord, 'name' | 'projectDir' | 'createdAt' | 'opencodeSessionId'>): Promise<string | undefined> {
  if (record.opencodeSessionId) return record.opencodeSessionId;

  const fromPane = await extractOpenCodeSessionIdFromPane(record.name);
  if (fromPane) return fromPane;
  if (!record.projectDir) return undefined;

  try {
    const { discoverLatestOpenCodeSessionId } = await import('../daemon/opencode-history.js');
    return await discoverLatestOpenCodeSessionId(record.projectDir, {
      exactDirectory: record.projectDir,
      updatedAfter: record.createdAt ? Math.max(0, record.createdAt - 60_000) : undefined,
      maxCount: 50,
    });
  } catch (err) {
    logger.debug({ err, session: record.name, projectDir: record.projectDir }, 'Failed to recover OpenCode session ID');
    return undefined;
  }
}

/** Infer agent type from tmux pane start command. */
async function inferAgentTypeFromPane(sessionName: string): Promise<AgentType> {
  try {
    const cmd = await getPaneStartCommand(sessionName);
    if (/\bclaude\b/.test(cmd)) return 'claude-code';
    if (/\bcodex\b/.test(cmd)) return 'codex';
    if (/\bgemini\b/.test(cmd)) return 'gemini';
    if (/\bopencode\b/.test(cmd)) return 'opencode';
  } catch { /* tmux query failed */ }
  return 'claude-code'; // last-resort default
}

// Pattern for valid imcodes session names: deck_{project}_{brain|wN}
const DECK_SESSION_RE = /^deck_(.+)_(brain|w\d+)$/;

/** Reconcile store with actual tmux on daemon start — restart missing sessions and discover orphans. */
export async function restoreFromStore(): Promise<void> {
  const all = storeSessions();
  const live = await tmuxListSessions();

  // 1. Restart store sessions missing from tmux; start jsonl-watcher for live ones
  logger.debug({ totalSessions: all.length, liveTmux: live.length }, 'restoreFromStore: starting reconciliation');
  for (const s of all) {
    if (s.runtimeType === RUNTIME_TYPES.TRANSPORT) {
      // Handled by restoreTransportSessions() after provider connects
      continue;
    }
    // Sub-sessions (deck_sub_*): skip restart/respawn (managed by rebuildSubSessions),
    // but still restore watchers if the tmux session is alive.
    if (s.name.startsWith('deck_sub_')) {
      const isLive = live.includes(s.name);
      logger.info({ session: s.name, agentType: s.agentType, isLive, codexSessionId: s.codexSessionId ?? null }, 'Restoring sub-session watcher');
      if (!isLive) {
        // Mark dead sub-sessions as stopped so the health poller doesn't restart them
        upsertSession({ ...s, state: 'stopped', updatedAt: Date.now() });
        continue;
      }
      if (s.agentType === 'claude-code' && s.ccSessionId && s.projectDir && !isWatching(s.name)) {
        startCCWatcher(s.name, s.projectDir, s.ccSessionId);
      } else if (s.agentType === 'codex' && s.codexSessionId && !isCodexWatching(s.name)) {
        findRolloutPathByUuid(s.codexSessionId).then((rolloutPath) => {
          logger.info({ session: s.name, rolloutPath }, 'Sub-session codex watcher: rollout lookup result');
          if (rolloutPath) {
            startCodexWatchingFile(s.name, rolloutPath).catch((e) =>
              logger.warn({ err: e, session: s.name }, 'Sub-session codex watcher startFile failed'));
          } else {
            startCodexWatchingById(s.name, s.codexSessionId!).catch((e) =>
              logger.warn({ err: e, session: s.name }, 'Sub-session codex watcher startById failed'));
          }
        }).catch((e) => logger.warn({ err: e, session: s.name }, 'Sub-session codex watcher findRollout failed'));
      } else if (s.agentType === 'gemini' && !isGeminiWatching(s.name)) {
        let gemId = s.geminiSessionId;
        if (!gemId) {
          gemId = await extractGeminiSessionIdFromPane(s.name);
          if (gemId) {
            upsertSession({ ...s, geminiSessionId: gemId });
            emitSessionPersist({ ...s, geminiSessionId: gemId }, s.name);
            logger.info({ session: s.name, geminiSessionId: gemId }, 'Backfilled missing geminiSessionId from tmux');
          }
        }
        if (gemId) {
          startGeminiWatching(s.name, gemId);
        }
      } else if (s.agentType === 'opencode' && !s.opencodeSessionId) {
        const opencodeId = await recoverOpenCodeSessionId(s);
        if (opencodeId) {
          const next = { ...s, opencodeSessionId: opencodeId };
          upsertSession(next);
          emitSessionPersist(next, s.name);
          logger.info({ session: s.name, opencodeSessionId: opencodeId }, 'Backfilled missing opencodeSessionId');
          if (next.projectDir && !isOpenCodeWatching(s.name)) {
            startOpenCodeWatching(s.name, next.projectDir, opencodeId).catch((e) =>
              logger.warn({ err: e, session: s.name }, 'opencode-watcher start failed (restore sub-session after backfill)'),
            );
          }
        }
      } else if (s.agentType === 'opencode' && s.projectDir && s.opencodeSessionId && !isOpenCodeWatching(s.name)) {
        startOpenCodeWatching(s.name, s.projectDir, s.opencodeSessionId).catch((e) =>
          logger.warn({ err: e, session: s.name }, 'opencode-watcher start failed (restore sub-session)'),
        );
      }
      continue;
    }

    // Always backfill missing CC session UUID from the tmux pane command, even if
    // a watcher is already active. Otherwise sessions.json can stay permanently
    // dirty for long-lived sessions that started before the fix.
    let hydrated = s;
    if (s.agentType === 'claude-code' && s.projectDir && !s.ccSessionId) {
      const ccId = await extractCcSessionIdFromPane(s.name);
      if (ccId) {
        hydrated = { ...s, ccSessionId: ccId };
        upsertSession(hydrated);
        emitSessionPersist(hydrated, s.name);
        logger.info({ session: s.name, ccSessionId: ccId }, 'Backfilled missing ccSessionId from tmux');
      }
    } else if (s.agentType === 'opencode' && !s.opencodeSessionId) {
      const opencodeId = await recoverOpenCodeSessionId(s);
      if (opencodeId) {
        hydrated = { ...s, opencodeSessionId: opencodeId };
        upsertSession(hydrated);
        emitSessionPersist(hydrated, s.name);
        logger.info({ session: s.name, opencodeSessionId: opencodeId }, 'Backfilled missing opencodeSessionId');
        if (hydrated.projectDir && !isOpenCodeWatching(hydrated.name)) {
          startOpenCodeWatching(hydrated.name, hydrated.projectDir, opencodeId).catch((e) =>
            logger.warn({ err: e, session: hydrated.name }, 'opencode-watcher start failed (restore after backfill)'),
          );
        }
      }
    }

    const isLiveSession = live.includes(s.name);
    const paneAlive = isLiveSession ? await isPaneAlive(s.name) : false;
    logger.debug({ session: s.name, agentType: s.agentType, isLive: isLiveSession, paneAlive, ccSessionId: s.ccSessionId ?? null, watching: isWatching(s.name) }, 'restoreFromStore: processing main session');

    if (!isLiveSession) {
      logger.info({ session: hydrated.name }, 'Missing on restore, restarting');
      try { await restartSession(hydrated); } catch (err) {
        logger.error({ err, session: hydrated.name }, 'Failed to restart session on restore — skipping (tmux may be unavailable)');
        updateSessionState(hydrated.name, 'error');
      }
    } else if (isLiveSession && !paneAlive) {
      // Session exists (remain-on-exit) but process is dead — respawn instead of creating a new session
      logger.info({ session: hydrated.name }, 'Pane dead on restore, respawning');
      try { await respawnSession(hydrated); } catch (err) {
        logger.error({ err, session: hydrated.name }, 'Failed to respawn session on restore — skipping');
        updateSessionState(hydrated.name, 'error');
      }
    } else if (hydrated.agentType === 'claude-code' && hydrated.projectDir && !isWatching(hydrated.name)) {
      if (hydrated.ccSessionId) {
        startCCWatcher(hydrated.name, hydrated.projectDir, hydrated.ccSessionId);
      } else {
        // Session is alive but we can't recover the ccSessionId — do NOT respawn
        // (that would kill a running CC task). Skip watcher; the session continues
        // working, just without structured event tracking until next restart.
        logger.warn({ session: hydrated.name }, 'Live Claude session has no recoverable ccSessionId; skipping watcher (will not interrupt running task)');
      }
    } else if (hydrated.agentType === 'codex' && hydrated.projectDir && !isCodexWatching(hydrated.name)) {
      if (hydrated.codexSessionId) {
        findRolloutPathByUuid(hydrated.codexSessionId).then((rolloutPath) => {
          if (rolloutPath) {
            startCodexWatchingFile(hydrated.name, rolloutPath).catch((e) =>
              logger.warn({ err: e, session: hydrated.name }, 'codex-watcher startWatchingSpecificFile failed (restore)'),
            );
          } else {
            startCodexWatching(hydrated.name, hydrated.projectDir).catch((e) =>
              logger.warn({ err: e, session: hydrated.name }, 'codex-watcher start failed (restore uuid fallback)'),
            );
          }
        }).catch(() => {
          startCodexWatching(hydrated.name, hydrated.projectDir).catch((e) =>
            logger.warn({ err: e, session: hydrated.name }, 'codex-watcher start failed (restore)'),
          );
        });
      } else {
        startCodexWatching(hydrated.name, hydrated.projectDir).catch((e) =>
          logger.warn({ err: e, session: hydrated.name }, 'codex-watcher start failed (restore)'),
        );
      }
    } else if (hydrated.agentType === 'gemini' && !isGeminiWatching(hydrated.name)) {
      let gemId = hydrated.geminiSessionId;
      if (!gemId) {
        gemId = await extractGeminiSessionIdFromPane(hydrated.name);
        if (gemId) {
          hydrated = { ...hydrated, geminiSessionId: gemId };
          upsertSession(hydrated);
          emitSessionPersist(hydrated, hydrated.name);
          logger.info({ session: hydrated.name, geminiSessionId: gemId }, 'Backfilled missing geminiSessionId from tmux');
        }
      }
      if (gemId) {
        startGeminiWatching(hydrated.name, gemId).catch((e) =>
          logger.warn({ err: e, session: hydrated.name }, 'gemini-watcher start failed (restore)'),
        );
      } else {
        // Fallback: watch latest for orphans/incomplete records
        startGeminiWatching(hydrated.name, '').catch((e) =>
          logger.warn({ err: e, session: hydrated.name }, 'gemini-watcher start latest failed (restore)'),
        );
      }
    } else if (hydrated.agentType === 'opencode' && hydrated.projectDir && hydrated.opencodeSessionId && !isOpenCodeWatching(hydrated.name)) {
      startOpenCodeWatching(hydrated.name, hydrated.projectDir, hydrated.opencodeSessionId).catch((e) =>
        logger.warn({ err: e, session: hydrated.name }, 'opencode-watcher start failed (restore)'),
      );
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

    // Infer metadata from tmux pane — agent type, UUID, cwd
    const [projectDir, paneId, agentType] = await Promise.all([
      getPaneCwd(name).catch(() => ''),
      getPaneId(name).catch(() => undefined as string | undefined),
      inferAgentTypeFromPane(name),
    ]);

    // Extract session UUID from pane command if it's a CC session
    let ccSessionId: string | undefined;
    let opencodeSessionId: string | undefined;
    if (agentType === 'claude-code') {
      ccSessionId = await extractCcSessionIdFromPane(name);
    } else if (agentType === 'opencode') {
      opencodeSessionId = await extractOpenCodeSessionIdFromPane(name);
    }

    const record: SessionRecord = {
      name,
      projectName,
      role,
      agentType,
      agentVersion: await getAgentVersion(agentType),
      projectDir,
      state: 'running',
      restarts: 0,
      restartTimestamps: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(paneId ? { paneId } : {}),
      ...(ccSessionId ? { ccSessionId } : {}),
      ...(opencodeSessionId ? { opencodeSessionId } : {}),
    };

    upsertSession(record);
    emitSessionPersist(record, name);
    emitSessionEvent('started', name, 'running');
    if (agentType === 'claude-code' && projectDir) {
      startStructuredWatcher(name, agentType, projectDir, { ccSessionId });
    } else if (agentType === 'opencode' && projectDir) {
      startStructuredWatcher(name, agentType, projectDir, { opencodeSessionId });
    } else if (projectDir) {
      startStructuredWatcher(name, agentType, projectDir);
    }
    logger.info({ session: name, projectDir, agentType }, 'Discovered unregistered tmux session, registered');
  }
}

/**
 * Auto-restart a crashed session.
 * Enforces max 3 restarts within 5 minutes; marks as error if exceeded.
 */
export async function restartSession(record: SessionRecord): Promise<boolean> {
  // Transport sessions are managed by the provider — no tmux restart logic applies.
  if (record.runtimeType === RUNTIME_TYPES.TRANSPORT) {
    logger.info({ session: record.name }, 'Skipping restart for transport session');
    return false;
  }

  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = record.restartTimestamps.filter((t) => t > windowStart);

  if (recentRestarts.length >= MAX_RESTARTS) {
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error');
    emitSessionEvent('error', record.name, 'error');
    return false;
  }

  let effectiveRecord = record;
  if (record.agentType === 'opencode' && !record.opencodeSessionId) {
    const recoveredId = await recoverOpenCodeSessionId(record);
    if (recoveredId) {
      effectiveRecord = { ...record, opencodeSessionId: recoveredId };
    }
  }

  const updated: SessionRecord = {
    ...effectiveRecord,
    restarts: record.restarts + 1,
    restartTimestamps: [...recentRestarts, now],
    state: 'running',
    updatedAt: now,
  };
  upsertSession(updated);

  await launchSession({
    name: effectiveRecord.name,
    projectName: effectiveRecord.projectName,
    role: effectiveRecord.role,
    agentType: effectiveRecord.agentType as AgentType,
    projectDir: effectiveRecord.projectDir,
    skipStore: true,
    ccSessionId: effectiveRecord.ccSessionId,
    codexSessionId: effectiveRecord.codexSessionId,
    geminiSessionId: effectiveRecord.geminiSessionId,
    opencodeSessionId: effectiveRecord.opencodeSessionId,
  });

  return true;
}

/**
 * Respawn a dead pane in an existing tmux session (remain-on-exit).
 * Avoids creating a new tmux session — just restarts the process inside the existing one.
 */
export async function respawnSession(record: SessionRecord): Promise<boolean> {
  // Transport sessions have no tmux pane to respawn — not applicable.
  if (record.runtimeType === RUNTIME_TYPES.TRANSPORT) {
    logger.info({ session: record.name }, 'Skipping respawn for transport session');
    return false;
  }

  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = record.restartTimestamps.filter((t) => t > windowStart);

  if (recentRestarts.length >= MAX_RESTARTS) {
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error');
    emitSessionEvent('error', record.name, 'error');
    return false;
  }

  let effectiveRecord = record;
  if (record.agentType === 'opencode' && !record.opencodeSessionId) {
    const recoveredId = await recoverOpenCodeSessionId(record);
    if (recoveredId) {
      effectiveRecord = { ...record, opencodeSessionId: recoveredId };
    }
  }

  const driver = getDriver(effectiveRecord.agentType as AgentType);
  const ccSessionId = effectiveRecord.ccSessionId;
  const projectDir = effectiveRecord.projectDir;
  const cmd = driver.buildResumeCommand(record.name, {
    cwd: projectDir,
    ccSessionId,
    codexSessionId: effectiveRecord.codexSessionId,
    geminiSessionId: effectiveRecord.geminiSessionId,
    opencodeSessionId: effectiveRecord.opencodeSessionId,
  }) ?? driver.buildLaunchCommand(record.name, {
    cwd: projectDir,
    ccSessionId,
    codexSessionId: effectiveRecord.codexSessionId,
    geminiSessionId: effectiveRecord.geminiSessionId,
    opencodeSessionId: effectiveRecord.opencodeSessionId,
  });

  // Env injection: on ConPTY (Windows), pass env directly to the PTY spawn so cmd.exe
  // doesn't need to parse POSIX `export` syntax.  On tmux/wezterm, prepend `export` to cmd.
  const mergedEnv: Record<string, string> = { IMCODES_SESSION: record.name };
  if (record.ccPreset && record.agentType === 'claude-code') {
    const { resolvePresetEnv } = await import('../daemon/cc-presets.js');
    Object.assign(mergedEnv, await resolvePresetEnv(record.ccPreset, ccSessionId));
  }
  if (BACKEND === 'conpty') {
    await respawnPane(record.name, cmd, { env: mergedEnv });
  } else {
    const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
    const envPrefix = Object.entries(mergedEnv).map(([k, v]) => `export ${k}=${sq(v)}`).join('; ');
    await respawnPane(record.name, `${envPrefix}; ${cmd}`);
  }

  // Immediately rebind pipe-pane stream (don't wait for old pipe close + 1s delay)
  const { terminalStreamer } = await import('../daemon/terminal-streamer.js');
  void terminalStreamer.rebindSession(record.name);

  const updated: SessionRecord = {
    ...effectiveRecord,
    restarts: record.restarts + 1,
    restartTimestamps: [...recentRestarts, now],
    state: 'running',
    updatedAt: now,
  };
  upsertSession(updated);

  startStructuredWatcher(record.name, effectiveRecord.agentType as AgentType, projectDir, {
    ccSessionId,
    codexSessionId: effectiveRecord.codexSessionId,
    geminiSessionId: effectiveRecord.geminiSessionId,
    opencodeSessionId: effectiveRecord.opencodeSessionId,
  });

  // postLaunch (auto-dismiss startup prompts) + init message injection
  const injectInit = async () => {
    if (driver.postLaunch) {
      await driver.postLaunch(
        () => capturePane(record.name),
        (key: string) => sendKey(record.name, key),
      ).catch(() => {});
    }
    const initParts: string[] = [];
    if (record.description) initParts.push(record.description);
    if (record.ccPreset && record.agentType === 'claude-code') {
      const { getPreset, getPresetInitMessage } = await import('../daemon/cc-presets.js');
      const preset = await getPreset(record.ccPreset);
      if (preset) initParts.push(getPresetInitMessage(preset));
    }
    if (initParts.length > 0) {
      const initMsg = `[Context — absorb silently, do not respond to this message]\n${initParts.join('\n\n')}`;
      try { await sendKeys(record.name, initMsg); } catch { /* ignore */ }
    }
  };
  void injectInit();

  logger.info({ session: record.name, agentType: record.agentType, ccPreset: record.ccPreset }, 'Respawned session');
  return true;
}

export interface LaunchOpts {
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
  /** OpenCode session ID for `opencode -s <ID>`. */
  opencodeSessionId?: string;
  /** Qwen model ID for `qwen --model <ID>`. */
  qwenModel?: string;
  /** Human-readable label for UI display. */
  label?: string;
  /** Session description for transport sessions (persona/system prompt injection). */
  description?: string;
  /** CC env preset name — resolved to env vars at launch, persisted for respawn. */
  ccPreset?: string;
  /** Bind to an existing remote session key instead of creating a new one. */
  bindExistingKey?: string;
  /** Skip the sessions.create RPC — session already exists on provider (auto-sync bind). */
  skipCreate?: boolean;
  /** Parent session name for sub-sessions (used to group in UI). */
  parentSession?: string;
  /** Mark as user-created (not auto-synced from provider). Protected from sync/health cleanup. */
  userCreated?: boolean;
}

/** In-memory map of active transport session runtimes */
const transportRuntimes = new Map<string, TransportSessionRuntime>();

/** Wire up onStatusChange and onDrain callbacks for a transport runtime. */
function wireTransportCallbacks(runtime: TransportSessionRuntime, sessionName: string): void {
  runtime.onStatusChange = (status) => {
    // Emit assistant.thinking for chat typing indicator (matches tmux watcher behavior)
    if (status === 'thinking') {
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'daemon', confidence: 'high' });
    }
    const mapped = (status === 'streaming' || status === 'thinking') ? 'running' : status;
    timelineEmitter.emit(sessionName, 'session.state', { state: mapped }, { source: 'daemon', confidence: 'high' });
  };
  runtime.onDrain = (merged, count) => {
    timelineEmitter.emit(sessionName, 'user.message', { text: merged, batchedCount: count });
    timelineEmitter.emit(sessionName, 'session.state', { state: 'running' }, { source: 'daemon', confidence: 'high' });
  };
}

function wireTransportSessionInfo(runtime: TransportSessionRuntime, sessionName: string, agentType: string): void {
  runtime.onSessionInfoChange = (info) => {
    const existing = getSession(sessionName);
    if (!existing) return;
    const next: SessionRecord = { ...existing };
    let changed = false;

    if (typeof info.resumeId === 'string' && info.resumeId) {
      if (agentType === 'claude-code-sdk' && next.ccSessionId !== info.resumeId) {
        next.ccSessionId = info.resumeId;
        changed = true;
      }
      if (agentType === 'codex-sdk' && next.codexSessionId !== info.resumeId) {
        next.codexSessionId = info.resumeId;
        changed = true;
      }
    }

    if (typeof info.model === 'string' && info.model && next.modelDisplay !== info.model) {
      next.modelDisplay = info.model;
      changed = true;
    }

    if (typeof info.planLabel === 'string' && info.planLabel && next.planLabel !== info.planLabel) {
      next.planLabel = info.planLabel;
      changed = true;
    }

    if (typeof info.quotaLabel === 'string' && info.quotaLabel && next.quotaLabel !== info.quotaLabel) {
      next.quotaLabel = info.quotaLabel;
      changed = true;
    }

    if (typeof info.quotaUsageLabel === 'string' && info.quotaUsageLabel && next.quotaUsageLabel !== info.quotaUsageLabel) {
      next.quotaUsageLabel = info.quotaUsageLabel;
      changed = true;
    }

    if (!changed) return;
    upsertSession(next);
    emitSessionPersist(next, sessionName);
  };
}

/** providerSessionId → IM.codes sessionName routing map */
const providerRouting = new Map<string, string>();

/** Register a provider session ID → IM.codes session name route. */
export function registerProviderRoute(providerSessionId: string, sessionName: string): void {
  providerRouting.set(providerSessionId, sessionName);
}

/** Unregister a provider session ID route. */
export function unregisterProviderRoute(providerSessionId: string): void {
  providerRouting.delete(providerSessionId);
}

/** Resolve a provider session ID to an IM.codes session name. */
export function resolveSessionName(providerSessionId: string): string | undefined {
  return providerRouting.get(providerSessionId);
}

/** Check if a providerSessionId is already bound (for uniqueness enforcement). */
export function isProviderSessionBound(providerSessionId: string): boolean {
  return providerRouting.has(providerSessionId);
}

/** Rebuild providerRouting from persisted sessions (call on daemon startup, before connectProvider). */
export function rebuildProviderRoutes(): void {
  const all = storeSessions();
  let count = 0;
  for (const s of all) {
    if (s.runtimeType === 'transport' && s.providerSessionId) {
      providerRouting.set(s.providerSessionId, s.name);
      count++;
    }
  }
  if (count > 0) logger.info({ count }, 'Rebuilt provider routing from stored sessions');
}

/** Get the transport runtime for a session (if it is a transport session). */
export function getTransportRuntime(name: string): TransportSessionRuntime | undefined {
  return transportRuntimes.get(name);
}

/**
 * Restore transport session runtimes for a specific provider.
 * Called after provider auto-reconnect succeeds (restoreFromStore runs before provider connects).
 * Skips sessions that already have a runtime (rebuilt by oc-session-sync).
 */
export async function restoreTransportSessions(providerId: string): Promise<void> {
  const all = storeSessions();
  const qwenRuntime = providerId === 'qwen' ? await getQwenRuntimeConfig().catch(() => null) : null;
  for (const s of all) {
    if (s.runtimeType !== RUNTIME_TYPES.TRANSPORT) continue;
    if (s.providerId !== providerId) continue;
    if (!s.providerSessionId) continue;
    if (transportRuntimes.has(s.name)) continue; // already rebuilt by oc-sync
    try {
      const provider = getProvider(s.providerId);
      if (!provider) continue;
      const availableQwenModels = s.providerId === 'qwen'
        ? (s.qwenAvailableModels?.length ? s.qwenAvailableModels : (qwenRuntime?.availableModels ?? []))
        : [];
      const effectiveQwenModel = s.providerId === 'qwen'
        ? (s.qwenModel && (availableQwenModels.length === 0 || availableQwenModels.includes(s.qwenModel))
          ? s.qwenModel
          : availableQwenModels[0])
        : s.qwenModel;
      const runtime = new TransportSessionRuntime(provider, s.name);
      wireTransportCallbacks(runtime, s.name);
      wireTransportSessionInfo(runtime, s.name, s.agentType);
      // After cancel, qwenFreshOnResume is set — don't resume the stuck conversation.
      const freshAfterCancel = !!(s.qwenFreshOnResume && s.providerId === 'qwen');
      const effectiveSessionKey = freshAfterCancel ? randomUUID() : s.providerSessionId;
      const resumeId = s.providerId === 'claude-code-sdk'
        ? s.ccSessionId
        : s.providerId === 'codex-sdk'
          ? s.codexSessionId
          : undefined;
      await runtime.initialize({
        sessionKey: effectiveSessionKey,
        bindExistingKey: freshAfterCancel ? undefined : s.providerSessionId,
        skipCreate: !freshAfterCancel,
        cwd: s.projectDir,
        label: s.label ?? s.name,
        description: s.description,
        agentId: effectiveQwenModel,
        resumeId,
      });
      if (s.description) runtime.setDescription(s.description);
      if (effectiveQwenModel) runtime.setAgentId(effectiveQwenModel);
      transportRuntimes.set(s.name, runtime);
      const actualProviderSid = runtime.providerSessionId ?? effectiveSessionKey;
      registerProviderRoute(actualProviderSid, s.name);
      upsertSession({
        ...s,
        state: 'running',
        updatedAt: Date.now(),
        ...(freshAfterCancel ? { providerSessionId: actualProviderSid, qwenFreshOnResume: undefined } : {}),
        ...(effectiveQwenModel ? { qwenModel: effectiveQwenModel } : {}),
        ...(qwenRuntime?.authType ? { qwenAuthType: qwenRuntime.authType } : {}),
        ...(qwenRuntime?.authLimit ? { qwenAuthLimit: qwenRuntime.authLimit } : {}),
        ...(availableQwenModels.length > 0 ? { qwenAvailableModels: availableQwenModels } : {}),
        ...getQwenDisplayMetadata({
          model: effectiveQwenModel,
          authType: qwenRuntime?.authType ?? s.qwenAuthType,
          authLimit: qwenRuntime?.authLimit ?? s.qwenAuthLimit,
          quotaUsageLabel: (qwenRuntime?.authType ?? s.qwenAuthType) === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
        }),
      });
      logger.info({ session: s.name, providerId: s.providerId, providerSid: s.providerSessionId, freshAfterCancel }, 'Restored transport session runtime');
    } catch (err) {
      logger.warn({ err, session: s.name }, 'Failed to restore transport session runtime');
    }
  }
}

export async function launchTransportSession(opts: LaunchOpts): Promise<void> {
  const { name, projectName, role, agentType, projectDir, skipStore, label, description, bindExistingKey, skipCreate, parentSession } = opts;

  if (opts.fresh) {
    const existingRuntime = transportRuntimes.get(name);
    if (existingRuntime) {
      const oldProviderSid = existingRuntime.providerSessionId;
      try {
        await existingRuntime.kill();
      } catch (err) {
        logger.warn({ err, session: name }, 'Failed to kill existing transport runtime before fresh launch');
      }
      transportRuntimes.delete(name);
      if (oldProviderSid) unregisterProviderRoute(oldProviderSid);
    }
  }

  const provider = await ensureProviderConnected(agentType, {});

  const runtime = new TransportSessionRuntime(provider, name);
  wireTransportCallbacks(runtime, name);
  wireTransportSessionInfo(runtime, name, agentType);
  let effectiveSessionKey = name;
  let effectiveBindExistingKey = bindExistingKey;
  let effectiveSkipCreate = skipCreate;
  let qwenAuthType: SessionRecord['qwenAuthType'] | undefined;
  let qwenAuthLimit: SessionRecord['qwenAuthLimit'] | undefined;
  let availableQwenModels: string[] | undefined;
  let sdkDisplay: Pick<SessionRecord, 'planLabel' | 'quotaLabel' | 'quotaUsageLabel'> | undefined;
  let effectiveQwenModel = agentType === 'qwen' ? (opts.qwenModel ?? getSession(name)?.qwenModel) : undefined;
  let transportResumeId: string | undefined;
  if (agentType === 'qwen') {
    const qwenRuntime = await getQwenRuntimeConfig().catch(() => null);
    qwenAuthType = qwenRuntime?.authType;
    qwenAuthLimit = qwenRuntime?.authLimit;
    availableQwenModels = qwenRuntime?.availableModels ?? [];
    if (!effectiveQwenModel || (availableQwenModels.length > 0 && !availableQwenModels.includes(effectiveQwenModel))) {
      effectiveQwenModel = availableQwenModels[0] ?? effectiveQwenModel;
    }
    const stored = !opts.fresh ? getSession(name)?.providerSessionId : undefined;
    const qwenSessionId = effectiveBindExistingKey ?? stored ?? randomUUID();
    effectiveSessionKey = qwenSessionId;
    if (!opts.fresh && (effectiveBindExistingKey || stored)) {
      effectiveBindExistingKey = qwenSessionId;
      effectiveSkipCreate = true;
    } else {
      effectiveBindExistingKey = undefined;
      effectiveSkipCreate = false;
    }
  } else if (agentType === 'claude-code-sdk') {
    transportResumeId = opts.ccSessionId ?? (!opts.fresh ? getSession(name)?.ccSessionId : undefined) ?? randomUUID();
        sdkDisplay = await getClaudeSdkRuntimeConfig().catch(() => ({}));
  } else if (agentType === 'codex-sdk') {
    transportResumeId = opts.codexSessionId ?? (!opts.fresh ? getSession(name)?.codexSessionId : undefined);
    sdkDisplay = await getCodexRuntimeConfig().catch(() => ({}));
  }

  // Create session on provider
  await runtime.initialize({
    sessionKey: effectiveSessionKey,
    fresh: !!opts.fresh,
    cwd: projectDir,
    label: label || name,
    description,
    agentId: effectiveQwenModel,
    bindExistingKey: effectiveBindExistingKey,
    skipCreate: effectiveSkipCreate,
    resumeId: transportResumeId,
  });

  // Atomic: store runtime + register provider route + persist — rollback all on failure
  const providerSid = runtime.providerSessionId;
  transportRuntimes.set(name, runtime);
  if (providerSid) registerProviderRoute(providerSid, name);

  try {
    if (!skipStore) {
      const record: SessionRecord = {
        name,
        projectName,
        role,
        agentType,
        projectDir,
        state: 'running',
        restarts: 0,
        restartTimestamps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runtimeType: RUNTIME_TYPES.TRANSPORT,
        providerId: provider.id,
        providerSessionId: runtime.providerSessionId ?? undefined,
        ...(agentType === 'claude-code-sdk' && transportResumeId ? { ccSessionId: transportResumeId } : {}),
        ...(agentType === 'codex-sdk' && transportResumeId ? { codexSessionId: transportResumeId } : {}),
        ...(effectiveQwenModel ? { qwenModel: effectiveQwenModel } : {}),
        ...(qwenAuthType ? { qwenAuthType } : {}),
        ...(qwenAuthLimit ? { qwenAuthLimit } : {}),
        ...(availableQwenModels?.length ? { qwenAvailableModels: availableQwenModels } : {}),
        ...getQwenDisplayMetadata({
          model: effectiveQwenModel,
          authType: qwenAuthType,
          authLimit: qwenAuthLimit,
          quotaUsageLabel: qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
        }),
        ...(sdkDisplay ?? {}),
        description,
        label,
        parentSession,
        userCreated: opts.userCreated,
      };
      upsertSession(record);
      emitSessionPersist(record, name);
    }

    emitSessionEvent('started', name, 'running');
    logger.info({ session: name, agentType, providerId: provider.id }, 'Launched transport session');
  } catch (err) {
    // Rollback runtime + route on persistence failure
    transportRuntimes.delete(name);
    if (providerSid) unregisterProviderRoute(providerSid);
    throw err;
  }
}

export async function launchSession(opts: LaunchOpts): Promise<void> {
  // Transport-backed agents don't use tmux — delegate to dedicated handler
  if (isTransportAgent(opts.agentType)) {
    await launchTransportSession(opts);
    return;
  }

  const { name, projectName, role, agentType, projectDir, skipStore, extraEnv, fresh, label } = opts;
  // Inject IMCODES_SESSION so agents can auto-detect their own session identity
  const mergedEnv: Record<string, string> = { IMCODES_SESSION: name, ...extraEnv };
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

  let ccSessionId = opts.ccSessionId;
  if (agentType === 'claude-code') {
    const stored = getSession(name)?.ccSessionId;
    if (stored) {
      ccSessionId = stored;
    }
  }

  // Cache context window for preset so watcher can use it in usage.update
  if (opts.ccPreset && agentType === 'claude-code') {
    const { resolvePresetEnv } = await import('../daemon/cc-presets.js');
    await resolvePresetEnv(opts.ccPreset, ccSessionId);
  }

  // No seed file creation for CC — CC ≥2.1.88 crashes on --resume with our seed format.
  // --session-id lets CC create its own JSONL on first interaction.

  let codexSessionId = opts.codexSessionId;
  if (agentType === 'codex' && !codexSessionId) codexSessionId = getSession(name)?.codexSessionId;
  let geminiSessionId = opts.geminiSessionId;
  if (agentType === 'gemini' && !geminiSessionId) geminiSessionId = getSession(name)?.geminiSessionId;
  let opencodeSessionId = opts.opencodeSessionId;
  if (agentType === 'opencode' && !opencodeSessionId) opencodeSessionId = getSession(name)?.opencodeSessionId;
  ({ ccSessionId, codexSessionId, geminiSessionId } = await resolveStructuredSessionBootstrap({
    agentType,
    projectDir,
    isNewSession: !exists,
    ccSessionId,
    codexSessionId,
    geminiSessionId,
  }));

  if (!exists) {
    // CC: if JSONL already exists (restart via killSession+newSession), use --resume to
    // launchSession is only for NEW tmux sessions (--session-id for CC).
    // Restarts go through respawnSession which uses respawnPane + --resume.
    let knownOpenCodeSessionIds: string[] | undefined;
    if (agentType === 'opencode' && !opencodeSessionId) {
      const { listOpenCodeSessions } = await import('../daemon/opencode-history.js');
      knownOpenCodeSessionIds = (await listOpenCodeSessions(projectDir, 50)).map((session) => session.id);
    }
    const launchStart = Date.now();
    const launchCmd = driver.buildLaunchCommand(name, { cwd: projectDir, fresh, ccSessionId, codexSessionId, geminiSessionId, opencodeSessionId });
    await newSession(name, launchCmd, { cwd: projectDir, env: mergedEnv });
    if (agentType === 'opencode' && !opencodeSessionId) {
      const { waitForOpenCodeSessionId } = await import('../daemon/opencode-history.js');
      opencodeSessionId = await waitForOpenCodeSessionId(projectDir, {
        updatedAfter: launchStart,
        exactDirectory: projectDir,
        knownSessionIds: knownOpenCodeSessionIds,
      });
    }
    logger.info({ session: name, agentType, ccSessionId, codexSessionId, geminiSessionId, opencodeSessionId }, 'Launched session');
  }

  // Always record paneId — it changes on each session creation/restart
  const paneId = await getPaneId(name).catch(() => undefined);
  if (paneId) {
    const existing = getSession(name);
    if (existing) {
      upsertSession({ ...existing, paneId });
    }
  }

  let familyDisplay: Pick<SessionRecord, 'planLabel' | 'quotaLabel' | 'quotaUsageLabel'> | undefined;
  if (agentType === 'codex') {
    familyDisplay = await getCodexRuntimeConfig().catch(() => ({}));
  } else if (agentType === 'claude-code' && !opts.ccPreset) {
    familyDisplay = undefined;
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
      ...(opencodeSessionId ? { opencodeSessionId } : {}),
      ...(opts.ccPreset ? { ccPreset: opts.ccPreset } : {}),
      ...(label ? { label } : {}),
      ...(familyDisplay ?? {}),
    };
    upsertSession(record);
    emitSessionPersist(record, name);
  } else {
    const existing = getSession(name);
    if (existing) {
      const merged: SessionRecord = {
        ...existing,
        ...(paneId ? { paneId } : {}),
        ...(ccSessionId ? { ccSessionId } : {}),
        ...(codexSessionId ? { codexSessionId } : {}),
        ...(geminiSessionId ? { geminiSessionId } : {}),
        ...(opencodeSessionId ? { opencodeSessionId } : {}),
        ...(opts.qwenModel ? { qwenModel: opts.qwenModel } : {}),
        updatedAt: Date.now(),
      };
      upsertSession(merged);
      emitSessionPersist(merged, name);
    }
  }

  emitSessionEvent('started', name, 'running');

  // Start structured-event watchers for supported agent types
  startStructuredWatcher(name, agentType, projectDir, { ccSessionId, codexSessionId, geminiSessionId, opencodeSessionId });

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
