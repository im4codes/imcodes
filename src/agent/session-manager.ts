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
import type { SessionInfoUpdate } from './transport-provider.js';
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
import { emitSessionInlineError } from '../daemon/session-error.js';
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
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import { isClaudeCodeFamily, isCodexFamily } from '../../shared/agent-types.js';
import { providerQuotaMetaEquals } from '../../shared/provider-quota.js';
import { resolveTransportContextBootstrap } from './runtime-context-bootstrap.js';
import { QWEN_AUTH_TYPES } from '../../shared/qwen-auth.js';

import { getAgentVersion } from './agent-version.js';
import { repoCache } from '../repo/cache.js';
import { closeSingleSession, collectProjectCloseTargets, type CloseFailure, type CloseTreeResult } from './session-close.js';
import { cleanupKnownTestTerminalSessions } from './startup-test-session-cleanup.js';
import { clearResend, drainResend, getResendCount } from '../daemon/transport-resend-queue.js';

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
  if (event === 'error') {
    emitSessionInlineError(session, state);
    timelineEmitter.emit(session, 'session.state', { state: event, error: state });
    return;
  }
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

export function persistSessionRecord(record: SessionRecord | null, name: string): void {
  emitSessionPersist(record, name);
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
  /** Transport thinking level for supported main sessions. */
  effort?: TransportEffortLevel;
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
  const { name, dir, brainType, workerTypes, fresh, extraEnv, ccPreset, label, effort } = config;

  await launchSession({ name: sessionName(name, 'brain'), projectName: name, role: 'brain', agentType: brainType, projectDir: dir, fresh, extraEnv, ccPreset, label, effort });

  for (let i = 0; i < workerTypes.length; i++) {
    const role = `w${i + 1}` as `w${number}`;
    await launchSession({ name: sessionName(name, role), projectName: name, role, agentType: workerTypes[i], projectDir: dir, fresh, label });
  }
}

function buildCloseFailureMessage(record: SessionRecord, failure: CloseFailure): string {
  const prefix = record.name.startsWith('deck_sub_') ? 'Sub-session' : 'Session';
  return `${prefix} close failed during ${failure.stage}: ${failure.message}`;
}

/** Stop all sessions for a project and remove them from the store on confirmed success. */
export async function stopProject(
  projectName: string,
  serverLink?: { send(msg: object): void } | null,
): Promise<CloseTreeResult> {
  const targets = collectProjectCloseTargets(projectName, storeSessions());
  const invalidatedDirs = new Set<string>();
  const result: CloseTreeResult = { ok: true, closed: [], failed: [] };

  for (const record of targets) {
    const closeResult = await closeSingleSession(record, {
      emitStopping: () => {
        timelineEmitter.emit(record.name, 'session.state', { state: 'stopping' });
      },
      stopWatchers: () => {
        stopStructuredWatchers(record.name);
      },
      stopTransportRuntime: async () => {
        await stopTransportRuntimeSession(record.name);
      },
      killProcessRuntime: async () => {
        await killSession(record.name);
      },
      verifyClosed: async () => {
        if (record.runtimeType === RUNTIME_TYPES.TRANSPORT) {
          if (transportRuntimes.has(record.name)) throw new Error('transport runtime still registered');
          return;
        }
        if (await sessionExists(record.name)) throw new Error('session still exists after kill');
      },
      emitSuccess: async () => {
        if (record.name.startsWith('deck_sub_')) {
          timelineEmitter.emit(record.name, 'session.state', { state: 'stopped' });
          return;
        }
        emitSessionEvent('stopped', record.name, 'stopped');
      },
      persistSuccess: async () => {
        if (record.name.startsWith('deck_sub_')) {
          const id = record.name.replace(/^deck_sub_/, '');
          if (serverLink && id !== record.name) {
            serverLink.send({ type: 'subsession.closed', id, sessionName: record.name });
          }
        }
        removeSession(record.name);
        // Session is gone — drop any queued resend work so it can't replay into
        // a same-named session that gets created later.
        clearResend(record.name);
        emitSessionPersist(null, record.name);
        if (record.projectDir && !invalidatedDirs.has(record.projectDir)) {
          invalidatedDirs.add(record.projectDir);
          repoCache.invalidate(record.projectDir);
        }
      },
      emitFailure: async (_record, failure) => {
        emitSessionEvent('error', record.name, buildCloseFailureMessage(record, failure));
      },
      persistFailure: async (_record, failure) => {
        const next: SessionRecord = { ...record, state: 'error', updatedAt: Date.now() };
        upsertSession(next);
        emitSessionPersist(next, record.name);
        logger.warn({ session: record.name, stage: failure.stage, message: failure.message }, 'Project shutdown failed');
      },
    });

    result.closed.push(...closeResult.closed);
    result.failed.push(...closeResult.failed);
  }

  result.ok = result.failed.length === 0;
  return result;
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
  await cleanupKnownTestTerminalSessions();
  // Fire-and-forget: preload the transformers.js feature-extraction pipeline
  // so the first "Related history" semantic search doesn't pay the cold-load
  // cost (hundreds of ms to a few seconds). `isEmbeddingAvailable` swallows
  // errors internally, so a failure here just leaves the first real query to
  // attempt the load and fall back to plain SQL search.
  void (async () => {
    try {
      const { isEmbeddingAvailable } = await import('../context/embedding.js');
      const startedAt = Date.now();
      const ready = await isEmbeddingAvailable();
      logger.info({ ready, elapsedMs: Date.now() - startedAt }, 'Embedding pipeline warmup');
    } catch (err) {
      logger.debug({ err }, 'Embedding pipeline warmup failed (non-fatal)');
    }
  })();
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
        emitSessionEvent('error', hydrated.name, err instanceof Error ? err.message : String(err));
      }
    } else if (isLiveSession && !paneAlive) {
      // Session exists (remain-on-exit) but process is dead — respawn instead of creating a new session
      logger.info({ session: hydrated.name }, 'Pane dead on restore, respawning');
      try { await respawnSession(hydrated); } catch (err) {
        logger.error({ err, session: hydrated.name }, 'Failed to respawn session on restore — skipping');
        updateSessionState(hydrated.name, 'error');
        emitSessionEvent('error', hydrated.name, err instanceof Error ? err.message : String(err));
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
      state: 'idle',
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
    emitSessionEvent('started', name, 'idle');
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
    const message = `Restart loop detected: more than ${MAX_RESTARTS} restarts within 5 minutes`;
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error');
    emitSessionEvent('error', record.name, message);
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
    state: 'idle',
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
    const message = `Restart loop detected: more than ${MAX_RESTARTS} restarts within 5 minutes`;
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error');
    emitSessionEvent('error', record.name, message);
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
    state: 'idle',
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
  /** Provider-side durable resume identifier for shared local-sdk providers. */
  providerResumeId?: string;
  /** Qwen model ID for `qwen --model <ID>`. */
  qwenModel?: string;
  /** Unified requested transport model for launch/restore. */
  requestedModel?: string;
  /** Human-readable label for UI display. */
  label?: string;
  /** Reasoning/thinking effort for supported transport providers. */
  effort?: TransportEffortLevel;
  /** Provider-specific runtime config persisted outside top-level schema. */
  transportConfig?: Record<string, unknown>;
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

export interface SessionRelaunchOverrides {
  agentType?: AgentType;
  fresh?: boolean | null;
  projectDir?: string;
  label?: string | null;
  description?: string | null;
  requestedModel?: string | null;
  effort?: TransportEffortLevel | null;
  transportConfig?: Record<string, unknown> | null;
  ccPreset?: string | null;
}

export function getCompatibleSessionIds(
  record: Pick<SessionRecord, 'ccSessionId' | 'codexSessionId' | 'geminiSessionId' | 'opencodeSessionId'>,
  agentType: AgentType,
): Pick<LaunchOpts, 'ccSessionId' | 'codexSessionId' | 'geminiSessionId' | 'opencodeSessionId'> {
  return {
    ...(isClaudeCodeFamily(agentType) && record.ccSessionId ? { ccSessionId: record.ccSessionId } : {}),
    ...(isCodexFamily(agentType) && record.codexSessionId ? { codexSessionId: record.codexSessionId } : {}),
    ...(agentType === 'gemini' && record.geminiSessionId ? { geminiSessionId: record.geminiSessionId } : {}),
    ...(agentType === 'opencode' && record.opencodeSessionId ? { opencodeSessionId: record.opencodeSessionId } : {}),
  };
}

function stopStructuredWatchers(sessionName: string): void {
  stopWatching(sessionName);
  stopCodexWatching(sessionName);
  stopGeminiWatching(sessionName);
  stopOpenCodeWatching(sessionName);
}

export async function stopTransportRuntimeSession(sessionName: string): Promise<void> {
  const transportRuntime = transportRuntimes.get(sessionName);
  if (!transportRuntime) return;
  const providerSid = transportRuntime.providerSessionId;
  transportRuntimes.delete(sessionName);
  if (providerSid) unregisterProviderRoute(providerSid);
  await transportRuntime.kill();
}

async function teardownSessionRuntime(record: SessionRecord): Promise<void> {
  stopStructuredWatchers(record.name);
  const transportRuntime = transportRuntimes.get(record.name);
  if (transportRuntime) {
    await stopTransportRuntimeSession(record.name).catch(() => {});
    return;
  }
  await killSession(record.name).catch(() => {});
}

export async function relaunchSessionWithSettings(
  record: SessionRecord,
  overrides: SessionRelaunchOverrides = {},
): Promise<void> {
  const targetAgentType = (overrides.agentType ?? record.agentType) as AgentType;
  const targetFresh = overrides.fresh === true;
  const targetProjectDir = overrides.projectDir ?? record.projectDir;
  const targetLabel = overrides.label !== undefined ? overrides.label : (record.label ?? null);
  const targetDescription = overrides.description !== undefined ? overrides.description : (record.description ?? null);
  const targetRequestedModel = overrides.requestedModel !== undefined ? overrides.requestedModel : (record.requestedModel ?? null);
  const targetEffort = overrides.effort !== undefined ? overrides.effort : (record.effort ?? null);
  const targetTransportConfig = overrides.transportConfig !== undefined ? overrides.transportConfig : (record.transportConfig ?? null);
  const targetCcPreset = overrides.ccPreset !== undefined ? overrides.ccPreset : (record.ccPreset ?? null);
  const compatibleIds = targetFresh ? {} : getCompatibleSessionIds(record, targetAgentType);
  const preserveTransportBinding = record.runtimeType === RUNTIME_TYPES.TRANSPORT
    && record.agentType === targetAgentType
    // Qwen uses providerSessionId as its real resume key, so explicit restart must
    // preserve it. Claude/Codex SDKs keep their provider continuity in ccSessionId /
    // codexSessionId and therefore use a fresh local route key on relaunch.
    && targetAgentType !== 'claude-code-sdk'
    && targetAgentType !== 'codex-sdk'
    && targetAgentType !== 'copilot-sdk'
    && targetAgentType !== 'cursor-headless'
    && typeof record.providerSessionId === 'string'
    && record.providerSessionId.length > 0;

  await teardownSessionRuntime(record);

  await launchSession({
    name: record.name,
    projectName: record.projectName,
    role: record.role,
    agentType: targetAgentType,
    projectDir: targetProjectDir,
    label: targetLabel ?? undefined,
    description: targetDescription ?? undefined,
    requestedModel: targetRequestedModel ?? undefined,
    effort: targetEffort ?? undefined,
    transportConfig: targetTransportConfig ?? undefined,
    ccPreset: (targetAgentType === 'claude-code' || targetAgentType === 'claude-code-sdk' || targetAgentType === 'qwen')
      ? (targetCcPreset ?? undefined)
      : undefined,
    ...(preserveTransportBinding ? {
      bindExistingKey: record.providerSessionId,
      skipCreate: true,
    } : {}),
    ...compatibleIds,
    ...(record.parentSession ? { parentSession: record.parentSession } : {}),
    ...(record.userCreated ? { userCreated: true } : {}),
    ...(targetFresh ? { fresh: true } : {}),
  });
}

/** In-memory map of active transport session runtimes */
const transportRuntimes = new Map<string, TransportSessionRuntime>();

/** Wire up onStatusChange and onDrain callbacks for a transport runtime. */
function wireTransportCallbacks(runtime: TransportSessionRuntime, sessionName: string): void {
  const transportUserEventId = (clientMessageId: string) => `transport-user:${clientMessageId}`;
  runtime.onStatusChange = (status) => {
    // Emit assistant.thinking for chat typing indicator (matches tmux watcher behavior)
    if (status === 'thinking') {
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'daemon', confidence: 'high' });
    }
    const mapped = (status === 'streaming' || status === 'thinking') ? 'running' : status;
    // Include pending info only on idle — the authoritative "turn done, queue empty" signal.
    // During running/streaming, command-handler's 'queued' event is the sole queue-update
    // authority. This keeps queued messages visible in the UI until the drained turn completes.
    const payload: Record<string, unknown> = { state: mapped };
    if (mapped === 'idle') {
      payload.pendingCount = runtime.pendingCount;
      payload.pendingMessages = runtime.pendingMessages;
      payload.pendingMessageEntries = runtime.pendingEntries;
    }
    timelineEmitter.emit(sessionName, 'session.state', payload, { source: 'daemon', confidence: 'high' });
  };
  runtime.onDrain = (messages, merged, count) => {
    for (const entry of messages) {
      timelineEmitter.emit(
        sessionName,
        'user.message',
        { text: entry.text, clientMessageId: entry.clientMessageId, allowDuplicate: true },
        { source: 'daemon', confidence: 'high', eventId: transportUserEventId(entry.clientMessageId) },
      );
    }
    if (messages.length === 0) {
      timelineEmitter.emit(sessionName, 'user.message', { text: merged, batchedCount: count, allowDuplicate: true });
    }
    // Include authoritative pending state after drain. The drained messages have
    // been moved into the timeline via user.message emissions above, so they must
    // leave the queue UI simultaneously. The runtime's pending queue is now [] (or
    // contains any NEW messages queued since drain started).
    timelineEmitter.emit(sessionName, 'session.state', {
      state: 'running',
      pendingCount: runtime.pendingCount,
      pendingMessages: runtime.pendingMessages,
      pendingMessageEntries: runtime.pendingEntries,
    }, { source: 'daemon', confidence: 'high' });
  };
  runtime.onStartupMemoryInjected = () => {
    const existing = getSession(sessionName);
    if (!existing) return;
    if (existing.startupMemoryInjected === true) return;
    upsertSession({ ...existing, startupMemoryInjected: true, updatedAt: Date.now() });
    logger.info({ sessionName }, 'Persisted startupMemoryInjected flag');
  };
}

function mergeSessionContextBootstrap(next: SessionRecord, info: SessionInfoUpdate): boolean {
  let changed = false;

  const sameDiagnostics = (a: string[] | undefined, b: string[] | undefined): boolean => {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
  };

  if ('contextNamespace' in info) {
    const incomingNamespace = info.contextNamespace;
    if (JSON.stringify(next.contextNamespace ?? null) !== JSON.stringify(incomingNamespace ?? null)) {
      next.contextNamespace = incomingNamespace;
      changed = true;
    }
  }
  if ('contextNamespaceDiagnostics' in info) {
    if (!sameDiagnostics(next.contextNamespaceDiagnostics, info.contextNamespaceDiagnostics)) {
      next.contextNamespaceDiagnostics = info.contextNamespaceDiagnostics ? [...info.contextNamespaceDiagnostics] : undefined;
      changed = true;
    }
  }
  if ('contextRemoteProcessedFreshness' in info && next.contextRemoteProcessedFreshness !== info.contextRemoteProcessedFreshness) {
    next.contextRemoteProcessedFreshness = info.contextRemoteProcessedFreshness;
    changed = true;
  }
  if ('contextLocalProcessedFreshness' in info && next.contextLocalProcessedFreshness !== info.contextLocalProcessedFreshness) {
    next.contextLocalProcessedFreshness = info.contextLocalProcessedFreshness;
    changed = true;
  }
  if ('contextRetryExhausted' in info && next.contextRetryExhausted !== info.contextRetryExhausted) {
    next.contextRetryExhausted = info.contextRetryExhausted;
    changed = true;
  }
  if ('contextSharedPolicyOverride' in info) {
    if (JSON.stringify(next.contextSharedPolicyOverride ?? null) !== JSON.stringify(info.contextSharedPolicyOverride ?? null)) {
      next.contextSharedPolicyOverride = info.contextSharedPolicyOverride;
      changed = true;
    }
  }

  return changed;
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
      if ((agentType === 'cursor-headless' || agentType === 'copilot-sdk') && next.providerResumeId !== info.resumeId) {
        next.providerResumeId = info.resumeId;
        changed = true;
      }
      if (agentType === 'qwen' && next.providerSessionId !== info.resumeId) {
        if (next.providerSessionId) unregisterProviderRoute(next.providerSessionId);
        next.providerSessionId = info.resumeId;
        registerProviderRoute(info.resumeId, sessionName);
        changed = true;
      }
    }

    if (typeof info.model === 'string' && info.model) {
      if (next.activeModel !== info.model) {
        next.activeModel = info.model;
        changed = true;
      }
      if (next.modelDisplay !== info.model) {
        next.modelDisplay = info.model;
        changed = true;
      }
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

    if (info.quotaMeta !== undefined && !providerQuotaMetaEquals(next.quotaMeta, info.quotaMeta)) {
      next.quotaMeta = info.quotaMeta;
      changed = true;
    }

    if (typeof info.effort === 'string' && next.effort !== info.effort) {
      next.effort = info.effort;
      changed = true;
    }

    changed = mergeSessionContextBootstrap(next, info) || changed;

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
      let availableQwenModels = s.providerId === 'qwen'
        ? (s.qwenAvailableModels?.length ? s.qwenAvailableModels : (qwenRuntime?.availableModels ?? []))
        : [];
      const requestedTransportModel = s.requestedModel ?? s.qwenModel;
      const runtime = new TransportSessionRuntime(provider, s.name);
      wireTransportCallbacks(runtime, s.name);
      wireTransportSessionInfo(runtime, s.name, s.agentType);
      // After cancel, qwenFreshOnResume is set — don't resume the stuck conversation.
      const freshAfterCancel = !!(s.qwenFreshOnResume && s.providerId === 'qwen');
      const needsEphemeralRouteKey = s.providerId === 'claude-code-sdk'
        || s.providerId === 'codex-sdk'
        || s.providerId === 'cursor-headless'
        || s.providerId === 'copilot-sdk';
      const effectiveSessionKey = freshAfterCancel || needsEphemeralRouteKey ? randomUUID() : s.providerSessionId;
      const resumeId = s.providerId === 'claude-code-sdk'
        ? s.ccSessionId
        : s.providerId === 'codex-sdk'
          ? s.codexSessionId
          : (s.providerId === 'cursor-headless' || s.providerId === 'copilot-sdk')
            ? s.providerResumeId
            : undefined;
      let extraEnv: Record<string, string> | undefined;
      let systemPrompt: string | undefined;
      let transportSettings: string | Record<string, unknown> | undefined;
      let effectiveRequestedModel = requestedTransportModel;
      const resolveRuntimeContextBootstrap = () => resolveTransportContextBootstrap({
        projectDir: s.projectDir,
        transportConfig: getSession(s.name)?.transportConfig ?? s.transportConfig ?? {},
        startupMemoryAlreadyInjected: s.startupMemoryInjected === true,
      });
      const contextBootstrap = await resolveRuntimeContextBootstrap();
      runtime.setContextBootstrapResolver(resolveRuntimeContextBootstrap);
      if (s.providerId === 'claude-code-sdk' && s.ccPreset) {
        const { resolvePresetEnv, getPresetTransportOverrides } = await import('../daemon/cc-presets.js');
        extraEnv = await resolvePresetEnv(s.ccPreset, s.ccSessionId ?? undefined);
        const presetOverrides = await getPresetTransportOverrides(s.ccPreset);
        if (!effectiveRequestedModel && presetOverrides.model) effectiveRequestedModel = presetOverrides.model;
        systemPrompt = presetOverrides.systemPrompt;
      } else if (s.providerId === 'qwen' && s.ccPreset) {
        const { getQwenPresetTransportConfig } = await import('../daemon/cc-presets.js');
        const presetConfig = await getQwenPresetTransportConfig(s.ccPreset);
        extraEnv = { ...(extraEnv ?? {}), ...presetConfig.env };
        // Preset is authoritative: its model overrides any stored value (e.g. a
        // pre-preset session persisted `qwenModel: 'coder-model'` that is no
        // longer valid under --auth-type anthropic). Restricting the available
        // list to the preset model prevents the downstream fallback from
        // reverting to the OAuth `coder-model` placeholder.
        if (presetConfig.model) {
          effectiveRequestedModel = presetConfig.model;
          availableQwenModels = [presetConfig.model];
        }
        transportSettings = presetConfig.settings;
        // Override the qwen CLI's built-in "I am Qwen Code" identity with the
        // preset's runtime-facts prompt — without this, the model introduces
        // itself as Qwen / 通义千问 even when the turn is served by MiniMax.
        if (presetConfig.systemPrompt) systemPrompt = presetConfig.systemPrompt;
      }
      if (s.providerId === 'qwen'
        && (!effectiveRequestedModel || (availableQwenModels.length > 0 && !availableQwenModels.includes(effectiveRequestedModel)))) {
        effectiveRequestedModel = availableQwenModels[0] ?? effectiveRequestedModel;
      }
      await runtime.initialize({
        sessionKey: effectiveSessionKey,
        bindExistingKey: freshAfterCancel ? undefined : (needsEphemeralRouteKey ? s.providerSessionId : s.providerSessionId),
        skipCreate: !freshAfterCancel && !!s.providerSessionId,
        ...(extraEnv ? { env: extraEnv } : {}),
        cwd: s.projectDir,
        label: s.label ?? s.name,
        description: s.description,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(transportSettings ? { settings: transportSettings } : {}),
        contextNamespace: contextBootstrap.namespace,
        contextNamespaceDiagnostics: contextBootstrap.diagnostics,
        contextRemoteProcessedFreshness: contextBootstrap.remoteProcessedFreshness,
        contextLocalProcessedFreshness: contextBootstrap.localProcessedFreshness,
        contextRetryExhausted: contextBootstrap.retryExhausted,
        contextSharedPolicyOverride: contextBootstrap.sharedPolicyOverride,
        agentId: effectiveRequestedModel,
        resumeId,
        effort: s.effort,
        // Restore path: only re-inject startup memory if the prior run hadn't
        // yet delivered it (e.g. daemon crashed mid-first-turn). Otherwise the
        // conversation already has its history preamble and we must not repeat it.
        startupMemoryAlreadyInjected: s.startupMemoryInjected === true,
      });
      if (s.description) runtime.setDescription(s.description);
      if (systemPrompt) runtime.setSystemPrompt(systemPrompt);
      if (effectiveRequestedModel) runtime.setAgentId(effectiveRequestedModel);
      if (s.effort) runtime.setEffort(s.effort);
      transportRuntimes.set(s.name, runtime);
      const actualProviderSid = runtime.providerSessionId ?? effectiveSessionKey;
      registerProviderRoute(actualProviderSid, s.name);
      upsertSession({
        ...s,
        state: 'idle',
        updatedAt: Date.now(),
        ...((freshAfterCancel || s.providerSessionId !== actualProviderSid)
          ? { providerSessionId: actualProviderSid, ...(freshAfterCancel ? { qwenFreshOnResume: undefined } : {}) }
          : {}),
        contextNamespace: contextBootstrap.namespace,
        contextNamespaceDiagnostics: contextBootstrap.diagnostics,
        contextRemoteProcessedFreshness: contextBootstrap.remoteProcessedFreshness,
        contextLocalProcessedFreshness: contextBootstrap.localProcessedFreshness,
        contextRetryExhausted: contextBootstrap.retryExhausted,
        contextSharedPolicyOverride: contextBootstrap.sharedPolicyOverride,
        requestedModel: effectiveRequestedModel ?? s.requestedModel,
        activeModel: effectiveRequestedModel ?? s.activeModel ?? s.modelDisplay,
        modelDisplay: effectiveRequestedModel ?? s.modelDisplay,
        // Preserve transportConfig exactly via ...s spread — never force `{}` which
        // would wipe user-set supervision settings on every daemon restart.
        ...(effectiveRequestedModel && s.providerId === 'qwen' ? { qwenModel: effectiveRequestedModel } : {}),
        // When a qwen preset is active we're running `qwen --auth-type anthropic`
        // against a user-provided API key (BYO tier). The user-level
        // `~/.qwen/settings.json` tier labels ("Free", "No longer available")
        // are misleading in that context, so override them for preset sessions.
        qwenAuthType: (s.providerId === 'qwen' && s.ccPreset)
          ? QWEN_AUTH_TYPES.API_KEY
          : (qwenRuntime?.authType ?? s.qwenAuthType),
        qwenAuthLimit: (s.providerId === 'qwen' && s.ccPreset)
          ? undefined
          : (qwenRuntime?.authLimit ?? s.qwenAuthLimit),
        ...(availableQwenModels.length > 0 ? { qwenAvailableModels: availableQwenModels } : {}),
        ...getQwenDisplayMetadata({
          model: effectiveRequestedModel,
          authType: (s.providerId === 'qwen' && s.ccPreset)
            ? QWEN_AUTH_TYPES.API_KEY
            : (qwenRuntime?.authType ?? s.qwenAuthType),
          authLimit: (s.providerId === 'qwen' && s.ccPreset)
            ? undefined
            : (qwenRuntime?.authLimit ?? s.qwenAuthLimit),
          quotaUsageLabel: (s.providerId === 'qwen' && s.ccPreset)
            ? undefined
            : ((qwenRuntime?.authType ?? s.qwenAuthType) === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined),
        }),
      });
      logger.info({ session: s.name, providerId: s.providerId, providerSid: s.providerSessionId, freshAfterCancel }, 'Restored transport session runtime');

      // Drain messages that arrived while the provider was offline. The
      // enqueue path deliberately did NOT emit a user.message event (the
      // agent hadn't seen the message yet), so emit it HERE — exactly when
      // runtime.send() returns 'sent' and the entry really is dispatched to
      // the agent. If the runtime queues it internally (returns 'queued'),
      // leave the optimistic pending bubble in place; it will be reconciled
      // once the turn actually fires.
      // Failures are logged and entries dropped to avoid retry loops.
      const pendingCount = getResendCount(s.name);
      if (pendingCount > 0) {
        logger.info({ session: s.name, pendingCount }, 'Draining transport resend queue after reconnect');
        void drainResend(s.name, (entry) => {
          const attachments = entry.attachments ?? [];
          const result = attachments.length > 0
            ? runtime.send(entry.text, entry.commandId, attachments)
            : runtime.send(entry.text, entry.commandId);
          if (result === 'sent') {
            timelineEmitter.emit(
              s.name,
              'user.message',
              {
                text: entry.text,
                allowDuplicate: true,
                commandId: entry.commandId,
                clientMessageId: entry.commandId,
                ...(attachments.length > 0 ? { attachments } : {}),
              },
              { source: 'daemon', confidence: 'high', eventId: `transport-user:${entry.commandId}` },
            );
          }
          return result;
        }).catch((err) => logger.warn({ err, session: s.name }, 'transport resend drain failed'));
      }
    } catch (err) {
      logger.warn({ err, session: s.name }, 'Failed to restore transport session runtime');
    }
  }
}

export async function launchTransportSession(opts: LaunchOpts): Promise<void> {
  const { name, projectName, role, agentType, projectDir, skipStore, label, description, bindExistingKey, skipCreate, parentSession } = opts;
  const existing = getSession(name);
  const inheritedClaudeResumeId = opts.ccSessionId ?? (!opts.fresh ? existing?.ccSessionId : undefined);
  const shouldResumeClaudeCliConversation = agentType === 'claude-code-sdk'
    && existing?.agentType === 'claude-code'
    && existing?.runtimeType !== RUNTIME_TYPES.TRANSPORT
    && typeof inheritedClaudeResumeId === 'string'
    && inheritedClaudeResumeId.length > 0;

  if (opts.fresh) {
    const existingRuntime = transportRuntimes.get(name);
    if (existingRuntime) {
      const oldProviderSid = existingRuntime.providerSessionId;
      transportRuntimes.delete(name);
      if (oldProviderSid) unregisterProviderRoute(oldProviderSid);
      try {
        await existingRuntime.kill();
      } catch (err) {
        logger.warn({ err, session: name }, 'Failed to kill existing transport runtime before fresh launch');
      }
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
  let sdkDisplay: Pick<SessionRecord, 'planLabel' | 'quotaLabel' | 'quotaUsageLabel' | 'quotaMeta'> | undefined;
  let transportSystemPrompt: string | undefined;
  let transportSettings: string | Record<string, unknown> | undefined;
  const storedRequestedModel = !opts.fresh ? existing?.requestedModel : undefined;
  const storedProviderResumeId = !opts.fresh ? existing?.providerResumeId : undefined;
  let requestedTransportModel = opts.requestedModel ?? storedRequestedModel ?? (agentType === 'qwen' ? (opts.qwenModel ?? existing?.qwenModel) : undefined);
  // Preserve existing transportConfig (including supervision) when opts doesn't override.
  // Only fall through to `undefined` if nothing is set — never force `{}`, which would
  // strip supervision on restart/relaunch.
  const effectiveTransportConfig: Record<string, unknown> | undefined =
    opts.transportConfig ?? existing?.transportConfig;
  let transportResumeId: string | undefined;
  let transportEnv: Record<string, string> | undefined = opts.extraEnv;
  // Declared HERE (before the bootstrap resolver closes over it) because
  // `resolveTransportContextBootstrap` reads it to decide whether to skip
  // startup-memory DB queries entirely for restarts. Previously declared
  // below, causing a TDZ `Cannot access before initialization` at launch —
  // see commit f13c511 which moved the read site without moving the decl.
  const preserveStartupMemoryInject = !opts.fresh && existing?.startupMemoryInjected === true;
  const resolveRuntimeContextBootstrap = () => resolveTransportContextBootstrap({
    projectDir,
    transportConfig: getSession(name)?.transportConfig ?? effectiveTransportConfig ?? {},
    startupMemoryAlreadyInjected: preserveStartupMemoryInject,
  });
  const contextBootstrap = await resolveRuntimeContextBootstrap();
  runtime.setContextBootstrapResolver(resolveRuntimeContextBootstrap);
  if (agentType === 'qwen') {
    const qwenRuntime = await getQwenRuntimeConfig().catch(() => null);
    qwenAuthType = qwenRuntime?.authType;
    qwenAuthLimit = qwenRuntime?.authLimit;
    availableQwenModels = qwenRuntime?.availableModels ?? [];
    if (opts.ccPreset) {
      const { getQwenPresetTransportConfig } = await import('../daemon/cc-presets.js');
      const presetConfig = await getQwenPresetTransportConfig(opts.ccPreset);
      transportEnv = { ...(transportEnv ?? {}), ...presetConfig.env };
      // Preset is authoritative — its model overrides any stored/requested
      // model, and we restrict the available list so the fallback below can't
      // revert to the OAuth placeholder (`coder-model`). We're spawning qwen
      // with `--auth-type anthropic` against a BYO API key, so the OAuth tier
      // labels ("Free", "No longer available") don't apply — clear them.
      if (presetConfig.model) {
        requestedTransportModel = presetConfig.model;
        availableQwenModels = [presetConfig.model];
      }
      if (presetConfig.settings) transportSettings = presetConfig.settings;
      if (presetConfig.systemPrompt) transportSystemPrompt = presetConfig.systemPrompt;
      qwenAuthType = QWEN_AUTH_TYPES.API_KEY;
      qwenAuthLimit = undefined;
    }
    if (!requestedTransportModel || (availableQwenModels.length > 0 && !availableQwenModels.includes(requestedTransportModel))) {
      requestedTransportModel = availableQwenModels[0] ?? requestedTransportModel;
    }
    const stored = !opts.fresh ? existing?.providerSessionId : undefined;
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
    effectiveSessionKey = randomUUID();
    effectiveBindExistingKey = undefined;
    transportResumeId = opts.ccSessionId ?? (!opts.fresh ? getSession(name)?.ccSessionId : undefined) ?? randomUUID();
    if (!opts.fresh && transportResumeId) {
      effectiveSkipCreate = true;
    }
    // Switching from Claude CLI -> SDK must resume the inherited conversation.
    // Re-creating with the same sessionId makes Claude reject the turn with
    // "Session ID ... is already in use", which is what users were seeing.
    if (shouldResumeClaudeCliConversation) {
      effectiveSkipCreate = true;
    }
    if (opts.ccPreset) {
      const { resolvePresetEnv, getPresetTransportOverrides } = await import('../daemon/cc-presets.js');
      transportEnv = { ...(transportEnv ?? {}), ...(await resolvePresetEnv(opts.ccPreset, transportResumeId)) };
      const presetOverrides = await getPresetTransportOverrides(opts.ccPreset);
      if (!requestedTransportModel && presetOverrides.model) requestedTransportModel = presetOverrides.model;
      transportSystemPrompt = presetOverrides.systemPrompt;
    }
    if (requestedTransportModel) {
      transportSettings = {
        model: requestedTransportModel,
        availableModels: [requestedTransportModel],
      };
    }
    sdkDisplay = await getClaudeSdkRuntimeConfig().catch(() => ({}));
  } else if (agentType === 'codex-sdk') {
    effectiveSessionKey = randomUUID();
    effectiveBindExistingKey = undefined;
    transportResumeId = opts.codexSessionId ?? (!opts.fresh ? getSession(name)?.codexSessionId : undefined);
    if (!opts.fresh && transportResumeId) {
      effectiveSkipCreate = true;
    }
    sdkDisplay = await getCodexRuntimeConfig().catch(() => ({}));
  } else if (agentType === 'cursor-headless' || agentType === 'copilot-sdk') {
    effectiveSessionKey = randomUUID();
    effectiveBindExistingKey = undefined;
    transportResumeId = opts.providerResumeId ?? storedProviderResumeId;
    if (transportResumeId) {
      effectiveSkipCreate = true;
    }
  }

  // `preserveStartupMemoryInject` is declared earlier so the bootstrap
  // resolver closure can read it without hitting a TDZ. When launching
  // against an existing session record (e.g. session.restart without
  // /clear) we honor the previously-persisted inject flag — the
  // conversation already has its history preamble. `opts.fresh` is the
  // authoritative "force fresh" signal from /clear or explicit user action.

  // Create session on provider
      await runtime.initialize({
    sessionKey: effectiveSessionKey,
    fresh: !!opts.fresh,
    ...(transportEnv ? { env: transportEnv } : {}),
    cwd: projectDir,
    label: label || name,
    description,
    ...(transportSystemPrompt ? { systemPrompt: transportSystemPrompt } : {}),
    ...(transportSettings ? { settings: transportSettings } : {}),
    contextNamespace: contextBootstrap.namespace,
    contextNamespaceDiagnostics: contextBootstrap.diagnostics,
    contextRemoteProcessedFreshness: contextBootstrap.remoteProcessedFreshness,
    contextLocalProcessedFreshness: contextBootstrap.localProcessedFreshness,
    contextRetryExhausted: contextBootstrap.retryExhausted,
    contextSharedPolicyOverride: contextBootstrap.sharedPolicyOverride,
    agentId: requestedTransportModel,
    bindExistingKey: effectiveBindExistingKey,
    skipCreate: effectiveSkipCreate,
    resumeId: transportResumeId,
        effort: opts.effort,
    startupMemoryAlreadyInjected: preserveStartupMemoryInject,
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
        state: 'idle',
        restarts: 0,
        restartTimestamps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        runtimeType: RUNTIME_TYPES.TRANSPORT,
        providerId: provider.id,
        providerSessionId: runtime.providerSessionId ?? undefined,
        ...((agentType === 'copilot-sdk' || agentType === 'cursor-headless') && transportResumeId
          ? { providerResumeId: transportResumeId }
          : {}),
        ...(agentType === 'claude-code-sdk' && transportResumeId ? { ccSessionId: transportResumeId } : {}),
        ...(agentType === 'codex-sdk' && transportResumeId ? { codexSessionId: transportResumeId } : {}),
        contextNamespace: contextBootstrap.namespace,
        contextNamespaceDiagnostics: contextBootstrap.diagnostics,
        contextRemoteProcessedFreshness: contextBootstrap.remoteProcessedFreshness,
        contextLocalProcessedFreshness: contextBootstrap.localProcessedFreshness,
        contextRetryExhausted: contextBootstrap.retryExhausted,
        contextSharedPolicyOverride: contextBootstrap.sharedPolicyOverride,
        requestedModel: requestedTransportModel,
        activeModel: requestedTransportModel,
        modelDisplay: requestedTransportModel,
        // Only write transportConfig when we actually have one — avoid writing `{}`
        // which would clobber a concurrently-set supervision config on the next
        // load cycle. The existing config is already carried via effectiveTransportConfig.
        ...(effectiveTransportConfig ? { transportConfig: effectiveTransportConfig } : {}),
        ...(requestedTransportModel && agentType === 'qwen' ? { qwenModel: requestedTransportModel } : {}),
        ...(qwenAuthType ? { qwenAuthType } : {}),
        ...(qwenAuthLimit ? { qwenAuthLimit } : {}),
        ...(availableQwenModels?.length ? { qwenAvailableModels: availableQwenModels } : {}),
        ...getQwenDisplayMetadata({
          model: requestedTransportModel,
          authType: qwenAuthType,
          authLimit: qwenAuthLimit,
          quotaUsageLabel: qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
        }),
        ...(sdkDisplay ?? {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        description,
        ...(opts.ccPreset ? { ccPreset: opts.ccPreset } : {}),
        label,
        parentSession,
        userCreated: opts.userCreated,
        // Preserve the flag across session.restart / runtime rebuild so we
        // don't re-inject startup memory into a conversation that already
        // received it. /clear wipes it because `opts.fresh === true`.
        ...(preserveStartupMemoryInject ? { startupMemoryInjected: true } : {}),
      };
      upsertSession(record);
      emitSessionPersist(record, name);
    }

    emitSessionEvent('started', name, 'idle');
    logger.info({ session: name, agentType, providerId: provider.id }, 'Launched transport session');
  } catch (err) {
    // Rollback runtime + route on persistence failure
    transportRuntimes.delete(name);
    if (providerSid) unregisterProviderRoute(providerSid);
    throw err;
  }

  // Drain any messages queued while the runtime was being (re)built — e.g. if a
  // relaunch stopped the old runtime and the user typed during the gap.
  // Emits user.message on 'sent' for the same reason the reconnect drain
  // does: the enqueue path skipped the emit so the timeline doesn't lie,
  // and now the turn is actually firing.
  const pendingResendCount = getResendCount(name);
  if (pendingResendCount > 0) {
    logger.info({ session: name, pendingCount: pendingResendCount }, 'Draining transport resend queue after launch');
    void drainResend(name, (entry) => {
      const attachments = entry.attachments ?? [];
      const result = attachments.length > 0
        ? runtime.send(entry.text, entry.commandId, attachments)
        : runtime.send(entry.text, entry.commandId);
      if (result === 'sent') {
        timelineEmitter.emit(
          name,
          'user.message',
          {
            text: entry.text,
            allowDuplicate: true,
            commandId: entry.commandId,
            clientMessageId: entry.commandId,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          { source: 'daemon', confidence: 'high', eventId: `transport-user:${entry.commandId}` },
        );
      }
      return result;
    }).catch((err) => logger.warn({ err, session: name }, 'transport resend drain (launch) failed'));
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
  if (agentType === 'claude-code' && !fresh) {
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
  if (agentType === 'codex' && !fresh && !codexSessionId) codexSessionId = getSession(name)?.codexSessionId;
  let geminiSessionId = opts.geminiSessionId;
  if (agentType === 'gemini' && !fresh && !geminiSessionId) geminiSessionId = getSession(name)?.geminiSessionId;
  let opencodeSessionId = opts.opencodeSessionId;
  if (agentType === 'opencode' && !fresh && !opencodeSessionId) opencodeSessionId = getSession(name)?.opencodeSessionId;
  ({ ccSessionId, codexSessionId, geminiSessionId } = await resolveStructuredSessionBootstrap({
    sessionName: name,
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

  let familyDisplay: Pick<SessionRecord, 'planLabel' | 'quotaLabel' | 'quotaUsageLabel' | 'quotaMeta'> | undefined;
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
      state: 'idle',
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
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
      ...(opts.userCreated ? { userCreated: true } : {}),
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
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.parentSession ? { parentSession: opts.parentSession } : {}),
        ...(opts.userCreated ? { userCreated: true } : {}),
        updatedAt: Date.now(),
      };
      upsertSession(merged);
      emitSessionPersist(merged, name);
    }
  }

  emitSessionEvent('started', name, 'idle');

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
