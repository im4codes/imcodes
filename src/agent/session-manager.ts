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
import { buildTransportResumeLaunchOpts } from './transport-resume-opts.js';
import { RUNTIME_TYPES } from './session-runtime.js';
import { TransportSessionRuntime } from './transport-session-runtime.js';
import { ensureProviderConnected, getProvider } from './provider-registry.js';
import { PROVIDER_ERROR_CODES, type SessionInfoUpdate } from './transport-provider.js';
import { setupCCStopHook } from './signal.js';
import { setupCodexNotify, setupOpenCodePlugin } from './notify-setup.js';
import {
  getSession,
  upsertSession,
  removeSession,
  listSessions as storeSessions,
  updateSessionState,
  type SessionRecord,
  type SessionState,
} from '../store/session-store.js';
import logger from '../util/logger.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { timelineEmitter } from '../daemon/timeline-emitter.js';
import { timelineStore } from '../daemon/timeline-store.js';
import { emitSessionInlineError } from '../daemon/session-error.js';
import { startWatching, startWatchingFile, stopWatching, isWatching, findJsonlPathBySessionId } from '../daemon/jsonl-watcher.js';
import { startWatching as startCodexWatching, startWatchingSpecificFile as startCodexWatchingFile, startWatchingById as startCodexWatchingById, stopWatching as stopCodexWatching, isWatching as isCodexWatching, findRolloutPathByUuid } from '../daemon/codex-watcher.js';
import { startWatching as startGeminiWatching, startWatchingLatest as startGeminiWatchingLatest, stopWatching as stopGeminiWatching, isWatching as isGeminiWatching } from '../daemon/gemini-watcher.js';
import { startWatching as startOpenCodeWatching, stopWatching as stopOpenCodeWatching, isWatching as isOpenCodeWatching } from '../daemon/opencode-watcher.js';
import { resolveStructuredSessionBootstrap } from './structured-session-bootstrap.js';
import { getQwenRuntimeConfig } from './qwen-runtime-config.js';
import { getQwenDisplayMetadata } from './provider-display.js';
import { getQwenOAuthQuotaUsageLabel } from './provider-quota.js';
import { getClaudeSdkRuntimeConfig, normalizeClaudeSdkModelForProvider } from './sdk-runtime-config.js';
import { peekClaudeUsageQuotaCached } from './claude-usage-quota.js';
import { getCodexRuntimeConfig } from './codex-runtime-config.js';
import { mergeCodexDisplayMetadata } from './codex-display.js';
import type { TransportEffortLevel } from '../../shared/effort-levels.js';
import { isClaudeCodeFamily, isCodexFamily } from '../../shared/agent-types.js';
import { providerQuotaMetaEquals } from '../../shared/provider-quota.js';
import { resolveTransportContextBootstrap } from './runtime-context-bootstrap.js';
import { QWEN_AUTH_TYPES } from '../../shared/qwen-auth.js';
import { TIMELINE_SUPPRESS_PUSH_FIELD } from '../../shared/push-notifications.js';
import { IMCODES_SESSION_ENV, IMCODES_SESSION_LABEL_ENV } from '../../shared/imcodes-send.js';
import { buildCodexLifecycleTerminalMetadata, type ActivityGenerationLike } from '../../shared/session-activity-types.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_STATUS,
  buildSdkSubagentSafeDetail,
  parseSdkSubagentDetail,
  type SdkSubagentDetail,
} from '../../shared/sdk-subagent-status.js';

import { getAgentVersion } from './agent-version.js';
import { repoCache } from '../repo/cache.js';
import { closeSingleSession, collectProjectCloseTargets, type CloseFailure, type CloseTreeResult } from './session-close.js';
import { cleanupKnownTestTerminalSessions } from './startup-test-session-cleanup.js';
import { clearResend, drainResend, getResendCount, getResendEntries, listFreshResendQueues } from '../daemon/transport-resend-queue.js';
import { preserveTransportRuntimeQueuesToResend } from '../daemon/transport-resend-preservation.js';
import { getTransportQueueRevision, observeTransportQueueRevision } from '../daemon/transport-queue-revision.js';
import { appendTransportEvent, replayTransportHistory } from '../daemon/transport-history.js';
import { materializeMasterSummary } from '../context/materialization-coordinator.js';
import { serializeContextNamespace } from '../context/context-keys.js';
import { registerMasterCompaction } from '../daemon/master-compaction-registry.js';
import type { DaemonTransportQueuesSnapshot } from '../util/daemon-status.js';

const DEFAULT_CODEX_SDK_STARTUP_MODEL = 'gpt-5.5';

function isStoredTransportSession(record: Pick<SessionRecord, 'runtimeType' | 'agentType'>): boolean {
  return record.runtimeType === RUNTIME_TYPES.TRANSPORT
    || isTransportAgent(record.agentType as AgentType);
}

function shouldStartFreshCodexThreadAfterInterruptedRestore(
  record: Pick<SessionRecord, 'providerId' | 'agentType' | 'state' | 'codexSessionId'>,
): boolean {
  return (record.providerId ?? record.agentType) === 'codex-sdk'
    && record.state === 'running'
    && typeof record.codexSessionId === 'string'
    && record.codexSessionId.trim().length > 0;
}

function shouldAutoRelaunchTransportRuntimeAfterError(
  providerError: TransportSessionRuntime['lastProviderError'],
): boolean {
  if (!providerError) return false;
  if (providerError.code === PROVIDER_ERROR_CODES.CONNECTION_LOST) return true;
  // Codex SDK can occasionally keep an internal "running turn" marker even
  // though the daemon has no active work left. Manual daemon restart clears the
  // stale provider state; treat repeated recoverable "already busy" failures as
  // the same relaunchable provider-wedged condition instead of leaving the UI in
  // a bare error state forever.
  return providerError.code === PROVIDER_ERROR_CODES.PROVIDER_ERROR
    && /already busy|session is busy|provider is busy/i.test(providerError.message);
}

function sanitizeCodexSdkStartupModel(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const isClaudeModel = lower.startsWith('opus')
    || lower.startsWith('sonnet')
    || lower.startsWith('haiku')
    || lower.startsWith('claude')
    || lower.includes('/opus')
    || lower.includes('-opus')
    || lower.includes('_opus')
    || lower.includes('/sonnet')
    || lower.includes('-sonnet')
    || lower.includes('_sonnet')
    || lower.includes('/haiku')
    || lower.includes('-haiku')
    || lower.includes('_haiku')
    || lower.includes('claude-')
    || lower.includes('claude_');
  return isClaudeModel ? DEFAULT_CODEX_SDK_STARTUP_MODEL : trimmed;
}

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

export function shouldMaterializeMasterOnSessionStop(record: Pick<SessionRecord, 'name' | 'role' | 'parentSession' | 'contextNamespace'>): boolean {
  return !record.name.startsWith('deck_sub_')
    && record.role === 'brain'
    && !record.parentSession
    && !!record.contextNamespace;
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

export async function persistSessionRecordAwaited(record: SessionRecord | null, name: string): Promise<void> {
  await _onSessionPersist?.(record, name);
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
        if (shouldMaterializeMasterOnSessionStop(record)) {
          const registration = registerMasterCompaction(
            () => materializeMasterSummary(record.name, record.contextNamespace),
            {
              sessionName: record.name,
              ...(record.contextNamespace ? { namespaceKey: serializeContextNamespace(record.contextNamespace) } : {}),
            },
          );
          if (!registration.skipped) {
            registration.promise.catch((err) => {
                logger.warn({ err, session: record.name }, 'master summary materialization failed on session stop');
            });
          }
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
        // Session is gone — free its in-memory timeline ring buffer + dedup maps
        // (otherwise they leak for every session that ever ran), and drop any
        // queued resend work so it can't replay into a same-named session later.
        timelineEmitter.forgetSession(record.name);
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
        const next: SessionRecord = {
          ...record,
          state: 'error',
          error: buildCloseFailureMessage(record, failure),
          updatedAt: Date.now(),
        };
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
      const preservation = preserveTransportRuntimeQueuesToResend(s.name, transportRuntime);
      if (preservation.preservedCount > 0) {
        logger.info(
          { sessionName: s.name, ...preservation },
          'teardownProject preserved transport runtime queues before restart-oriented kill',
        );
      }
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
  // Each step is isolated: a failure here (e.g. tmux not ready at boot) must
  // never crash the daemon. The daemon stays alive with degraded startup state
  // and retries operations lazily when used. See daemon-NEVER-die policy in
  // src/index.ts.
  try {
    await cleanupOrphanFifos();
  } catch (err) {
    logger.warn({ err }, 'cleanupOrphanFifos failed — daemon continues');
  }
  try {
    await cleanupKnownTestTerminalSessions();
  } catch (err) {
    logger.warn({ err }, 'cleanupKnownTestTerminalSessions failed — daemon continues');
  }
  // Execution clones are ephemeral and their parent runs live in daemon memory
  // (not reattachable after a restart). Sweep ALL execution clones on startup so
  // no orphan worker is resurrected by the health poller. Dynamic import avoids a
  // static init-time cycle (execution-clone → subsession-manager → session-manager).
  try {
    const { sweepExecutionClones, destroyExecutionClone } = await import('../daemon/execution-clone.js');
    await sweepExecutionClones(Date.now(), {
      isCloneParentTerminal: () => true, // every clone is orphaned after restart → sweep all
      isRunning: () => false,
      destroy: (target, reason) => destroyExecutionClone({ target, reason, bypassAuth: true }),
    });
  } catch (err) {
    logger.warn({ err }, 'execution-clone startup sweep failed — daemon continues');
  }
  // Embedding warmup is intentionally scheduled by daemon lifecycle after the
  // ServerLink startup grace window. Loading transformers here can occupy the
  // Node main thread long enough for the server auth handshake to time out on
  // session-heavy hosts.
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
    if (isStoredTransportSession(s)) {
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
        const message = err instanceof Error ? err.message : String(err);
        updateSessionState(hydrated.name, 'error', message);
        emitSessionEvent('error', hydrated.name, message);
      }
    } else if (isLiveSession && !paneAlive) {
      // Session exists (remain-on-exit) but process is dead — respawn instead of creating a new session
      logger.info({ session: hydrated.name }, 'Pane dead on restore, respawning');
      try { await respawnSession(hydrated); } catch (err) {
        logger.error({ err, session: hydrated.name }, 'Failed to respawn session on restore — skipping');
        const message = err instanceof Error ? err.message : String(err);
        updateSessionState(hydrated.name, 'error', message);
        emitSessionEvent('error', hydrated.name, message);
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
  if (isStoredTransportSession(record)) {
    logger.info({ session: record.name }, 'Skipping restart for transport session');
    return false;
  }

  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = record.restartTimestamps.filter((t) => t > windowStart);

  if (recentRestarts.length >= MAX_RESTARTS) {
    const message = `Restart loop detected: more than ${MAX_RESTARTS} restarts within 5 minutes`;
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error', message);
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
  if (isStoredTransportSession(record)) {
    logger.info({ session: record.name }, 'Skipping respawn for transport session');
    return false;
  }

  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  const recentRestarts = record.restartTimestamps.filter((t) => t > windowStart);

  if (recentRestarts.length >= MAX_RESTARTS) {
    const message = `Restart loop detected: more than ${MAX_RESTARTS} restarts within 5 minutes`;
    logger.error({ session: record.name }, 'Restart loop detected — marking as error');
    updateSessionState(record.name, 'error', message);
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
    // codexSessionId; Kimi uses providerResumeId, so these providers use a fresh
    // local route key on relaunch.
    && targetAgentType !== 'claude-code-sdk'
    && targetAgentType !== 'codex-sdk'
    && targetAgentType !== 'copilot-sdk'
    && targetAgentType !== 'cursor-headless'
    && targetAgentType !== 'kimi-sdk'
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
    ...((targetAgentType === 'copilot-sdk' || targetAgentType === 'cursor-headless' || targetAgentType === 'kimi-sdk') && record.providerResumeId
      ? { providerResumeId: record.providerResumeId }
      : {}),
    ...compatibleIds,
    ...(record.parentSession ? { parentSession: record.parentSession } : {}),
    ...(record.userCreated ? { userCreated: true } : {}),
    ...(targetFresh ? { fresh: true } : {}),
  });
}

/** In-memory map of active transport session runtimes */
const transportRuntimes = new Map<string, TransportSessionRuntime>();
const transportErrorRecoveryInFlight = new Map<string, Promise<boolean>>();

function previewTransportQueueText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export function collectTransportQueueDiagnostics(nowMs: number = Date.now()): DaemonTransportQueuesSnapshot {
  const resendQueues = listFreshResendQueues(nowMs);
  const resendBySession = new Map(resendQueues.map((queue) => [queue.sessionName, queue.entries]));
  const sessionNames = new Set<string>([
    ...transportRuntimes.keys(),
    ...resendQueues.map((queue) => queue.sessionName),
  ]);
  for (const session of storeSessions()) {
    if (isStoredTransportSession(session)) {
      sessionNames.add(session.name);
    }
  }

  const sessions = [...sessionNames].sort().map((sessionName) => {
    const runtime = transportRuntimes.get(sessionName);
    const record = getSession(sessionName);
    runtime?.drainPendingIfIdle?.('transport-queue-diagnostics');
    const runtimeSnapshot = runtime?.getDiagnosticSnapshot(nowMs);
    const resendEntries = resendBySession.get(sessionName) ?? [];
    return {
      sessionName,
      ...(record?.agentType ? { agentType: record.agentType } : {}),
      ...(runtimeSnapshot?.status ? { status: runtimeSnapshot.status } : {}),
      ...(typeof runtimeSnapshot?.sending === 'boolean' ? { sending: runtimeSnapshot.sending } : {}),
      pendingCount: runtimeSnapshot?.pendingCount ?? 0,
      ...(runtimeSnapshot ? { pendingVersion: runtimeSnapshot.pendingVersion } : {}),
      ...(runtimeSnapshot ? { activeDispatchCount: runtimeSnapshot.activeDispatchCount } : {}),
      ...(runtimeSnapshot ? { stalePendingRecoveryActive: runtimeSnapshot.stalePendingRecoveryActive } : {}),
      ...(runtimeSnapshot ? { providerSessionBound: runtimeSnapshot.providerSessionBound } : {}),
      ...(runtimeSnapshot ? { lastActivityAt: runtimeSnapshot.lastActivityAt } : {}),
      ...(runtimeSnapshot ? { lastActivityAgeMs: runtimeSnapshot.lastActivityAgeMs } : {}),
      resendCount: resendEntries.length,
      ...(resendEntries.length
        ? {
            resendEntries: resendEntries.map((entry) => ({
              commandId: entry.commandId,
              queuedAt: entry.queuedAt,
              ageMs: Math.max(0, nowMs - entry.queuedAt),
              textPreview: previewTransportQueueText(entry.text),
            })),
          }
        : {}),
    };
  });

  return {
    sessionCount: sessions.length,
    totalPendingCount: sessions.reduce((sum, session) => sum + session.pendingCount, 0),
    totalResendCount: sessions.reduce((sum, session) => sum + session.resendCount, 0),
    totalActiveDispatchCount: sessions.reduce((sum, session) => sum + (session.activeDispatchCount ?? 0), 0),
    sessions,
  };
}

/**
 * How many transport sessions to restore concurrently on startup / reconnect.
 * Each restore is ~1s of mostly-I/O wait (a 2.5s-timeout context bootstrap plus
 * the provider's resume RPC), so a sequential restore of ~30 sessions takes
 * ~30s of wall-clock before they are usable again. On hosts with 100+
 * persisted transport sessions, however, overlapping restore work starves
 * ServerLink heartbeats during daemon startup. Keep the default serial and let
 * deployments that want more parallelism opt in with
 * IMCODES_TRANSPORT_RESTORE_CONCURRENCY.
 */
const TRANSPORT_RESTORE_CONCURRENCY = (() => {
  const raw = Number(process.env.IMCODES_TRANSPORT_RESTORE_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1;
})();
const TRANSPORT_RESTORE_INTER_SESSION_DELAY_MS = (() => {
  const raw = Number(process.env.IMCODES_TRANSPORT_RESTORE_INTER_SESSION_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 75;
})();
const transportErrorRecoveryTimestamps = new Map<string, number[]>();

function pauseBetweenTransportRestores(index: number, delayMs = TRANSPORT_RESTORE_INTER_SESSION_DELAY_MS): Promise<void> {
  if (index <= 0) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildTransportSessionEnv(
  sessionName: string,
  label: string | null | undefined,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  return {
    ...(extraEnv ?? {}),
    [IMCODES_SESSION_ENV]: sessionName,
    [IMCODES_SESSION_LABEL_ENV]: label?.trim() || sessionName,
  };
}

async function loadBoundServerIdForManagedMcp(): Promise<string | undefined> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const credentials = await loadCredentials();
    return typeof credentials?.serverId === 'string' && credentials.serverId.trim()
      ? credentials.serverId.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

// IM.codes identity + Generated Image Reporting prompts now live in
// `shared/transport-runtime-prompts.ts` and are injected at the
// assembly layer via `runtime.setSessionIdentity`. They are NOT subject
// to the 300-char user-authored cap that bounds `description` /
// `systemPrompt`. See p2p audit 37bfbb85-430 N-A.

async function recoverTransportRuntimeAfterError(
  sessionName: string,
  runtime: TransportSessionRuntime,
): Promise<boolean> {
  const existingRecovery = transportErrorRecoveryInFlight.get(sessionName);
  if (existingRecovery) return existingRecovery;

  const recovery = (async () => {
    const record = getSession(sessionName);
    if (!record || !isStoredTransportSession(record)) {
      return false;
    }

    const providerError = runtime.lastProviderError;
    if (!shouldAutoRelaunchTransportRuntimeAfterError(providerError)) {
      logger.warn(
        {
          sessionName,
          providerError,
          status: runtime.getStatus(),
          pendingCount: runtime.pendingCount,
          activeDispatchCount: runtime.activeDispatchEntries.length,
        },
        'Transport runtime error did not indicate a relaunchable provider failure; skipping provider relaunch',
      );
      return false;
    }

    const preservation = preserveTransportRuntimeQueuesToResend(sessionName, runtime);
    const pendingCount = preservation.afterCount;
    logger.warn(
      {
        sessionName,
        providerError,
        ...preservation,
      },
      'Transport provider failure — preserving queues and relaunching provider runtime',
    );

    const now = Date.now();
    const windowStart = now - RESTART_WINDOW_MS;
    const recentRecoveries = (transportErrorRecoveryTimestamps.get(sessionName) ?? []).filter((ts) => ts > windowStart);
    if (recentRecoveries.length >= MAX_RESTARTS) {
      logger.error({ sessionName, ...preservation }, 'Transport error recovery loop detected — refusing auto-restart');
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: `⚠️ Transport recovery stopped after ${MAX_RESTARTS} automatic restart attempts in 5 minutes.`,
        streaming: false,
        memoryExcluded: true,
      }, { source: 'daemon', confidence: 'high' });
      if (pendingCount > 0) {
        const queued = getResendEntries(sessionName);
        timelineEmitter.emit(sessionName, 'session.state', {
          state: 'queued',
          pendingCount,
          pendingMessages: queued.map((entry) => entry.text),
          pendingMessageEntries: queued.map((entry) => ({ clientMessageId: entry.commandId, text: entry.text })),
          pendingMessageVersion: getTransportQueueRevision(sessionName) ?? observeTransportQueueRevision(sessionName, undefined),
        }, { source: 'daemon', confidence: 'high' });
      }
      return false;
    }
    transportErrorRecoveryTimestamps.set(sessionName, [...recentRecoveries, now]);

    if (pendingCount > 0) {
      const queued = getResendEntries(sessionName);
      const recoveryReason = providerError?.code === PROVIDER_ERROR_CODES.CONNECTION_LOST
        ? 'Provider connection lost'
        : 'Provider became stuck busy';
      timelineEmitter.emit(sessionName, 'assistant.text', {
        text: `⏳ ${recoveryReason} — auto-resending ${pendingCount} queued message${pendingCount === 1 ? '' : 's'} after recovery.`,
        streaming: false,
        memoryExcluded: true,
      }, { source: 'daemon', confidence: 'high' });
      timelineEmitter.emit(sessionName, 'session.state', {
        state: 'queued',
        pendingCount,
        pendingMessages: queued.map((entry) => entry.text),
        pendingMessageEntries: queued.map((entry) => ({ clientMessageId: entry.commandId, text: entry.text })),
        pendingMessageVersion: getTransportQueueRevision(sessionName) ?? observeTransportQueueRevision(sessionName, undefined),
      }, { source: 'daemon', confidence: 'high' });
    }

    await stopTransportRuntimeSession(sessionName).catch((err) => {
      logger.warn({ err, sessionName }, 'Failed to stop errored transport runtime before auto-restart');
    });

    await launchTransportSession({
      name: record.name,
      projectName: record.projectName,
      role: record.role,
      agentType: record.agentType as AgentType,
      projectDir: record.projectDir,
      label: record.label,
      description: record.description,
      requestedModel: record.requestedModel,
      effort: record.effort,
      transportConfig: record.transportConfig,
      ccPreset: (record.agentType === 'claude-code-sdk' || record.agentType === 'qwen') ? record.ccPreset : undefined,
      // Qwen-compatible API providers can reject a resumed conversation when
      // their persisted tool-call chain is invalid (e.g. "tool call result
      // does not follow tool call"). Auto-recovery must rotate the provider
      // conversation instead of binding the same poisoned qwen session again.
      ...(record.agentType === 'qwen' ? { fresh: true } : {}),
      ...(record.agentType === 'claude-code-sdk' && record.ccSessionId ? { ccSessionId: record.ccSessionId } : {}),
      ...(record.agentType === 'codex-sdk' && record.codexSessionId ? { codexSessionId: record.codexSessionId } : {}),
      ...((record.agentType === 'cursor-headless' || record.agentType === 'copilot-sdk' || record.agentType === 'kimi-sdk') && record.providerResumeId
        ? { providerResumeId: record.providerResumeId }
        : {}),
      ...(record.agentType === 'openclaw' && record.providerSessionId ? { bindExistingKey: record.providerSessionId } : {}),
      ...(record.parentSession ? { parentSession: record.parentSession } : {}),
      ...(record.userCreated ? { userCreated: true } : {}),
    });
    return true;
  })().catch((err) => {
    logger.error({ err, sessionName }, 'Transport auto-restart after error failed');
    timelineEmitter.emit(sessionName, 'assistant.text', {
      text: `⚠️ Auto-restart failed: ${err instanceof Error ? err.message : String(err)}`,
      streaming: false,
      memoryExcluded: true,
    }, { source: 'daemon', confidence: 'high' });
    return false;
  }).finally(() => {
    transportErrorRecoveryInFlight.delete(sessionName);
  });

  transportErrorRecoveryInFlight.set(sessionName, recovery);
  return recovery;
}

/** Wire up onStatusChange and onDrain callbacks for a transport runtime. */
/**
 * Drain the transport resend queue for `sessionName`, re-sending each queued
 * user message through `runtime` and emitting a `user.message` timeline event on
 * a successful 'sent'. TTL-expired entries are dropped with a single
 * user-visible summary (audit 0419d1ac-1f4).
 *
 * Single source of truth for the re-send + emit logic (repo rule: never copy
 * code). Three callers:
 *   - `restoreTransportSessions` — drain after a daemon-restart reconnect.
 *   - the launch path — drain after a fresh `launchTransportSession`.
 *   - `runtime.onProviderSessionReady` — drain when the provider session binds.
 *     This closes the window where Auto-Deliver enqueues a prompt to resend
 *     (because `awaitTransportRuntime` timed out mid-relaunch, or the provider
 *     session was nulled on disconnect) and the one-shot launch/restore drains
 *     have already run — without this the entry would sit in resend until the
 *     next restart. Manual sends never hit this because the user resends.
 *
 * `await`ed by the launch/restore callers so their relaunch lock is not released
 * until the queue has transferred into the runtime (R-Drain fix, audit
 * cae1de69-826). Idempotent: `drainResend` deletes the queue synchronously
 * before dispatch, so the overlapping launch + provider-ready drains re-deliver
 * each entry at most once.
 */
async function drainTransportResendQueueIntoRuntime(
  runtime: TransportSessionRuntime,
  sessionName: string,
  context: 'reconnect' | 'launch' | 'provider-ready',
): Promise<void> {
  const pendingCount = getResendCount(sessionName);
  if (pendingCount === 0) return;
  logger.info({ session: sessionName, pendingCount, context }, 'Draining transport resend queue');
  try {
    await drainResend(
      sessionName,
      (entry) => {
        const attachments = entry.attachments ?? [];
        const sharedMetadata = entry.sharedActor ? { sharedActor: entry.sharedActor } : undefined;
        const result = entry.messagePreamble
          ? (sharedMetadata
              ? runtime.send(
                entry.text,
                entry.commandId,
                attachments.length > 0 ? attachments : undefined,
                entry.messagePreamble,
                {
                  ...sharedMetadata,
                  ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
                  ...(entry.historyCommitted ? { historyCommitted: true } : {}),
                },
              )
              : runtime.send(
                entry.text,
                entry.commandId,
                attachments.length > 0 ? attachments : undefined,
                entry.messagePreamble,
                {
                  ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
                  ...(entry.historyCommitted ? { historyCommitted: true } : {}),
                },
              ))
          : (attachments.length > 0
              ? (sharedMetadata
                  ? runtime.send(entry.text, entry.commandId, attachments, undefined, {
                    ...sharedMetadata,
                    ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
                    ...(entry.historyCommitted ? { historyCommitted: true } : {}),
                  })
                  : runtime.send(entry.text, entry.commandId, attachments, undefined, {
                    ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
                    ...(entry.historyCommitted ? { historyCommitted: true } : {}),
                  }))
              : (sharedMetadata
                  ? runtime.send(entry.text, entry.commandId, undefined, undefined, {
                    ...sharedMetadata,
                    ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
                    ...(entry.historyCommitted ? { historyCommitted: true } : {}),
                  })
                  : runtime.send(entry.text, entry.commandId, undefined, undefined, {
                    ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
                    ...(entry.historyCommitted ? { historyCommitted: true } : {}),
                  })));
        if (result === 'sent' && !entry.timelineCommitted) {
          timelineEmitter.emit(
            sessionName,
            'user.message',
            {
              text: entry.text,
              allowDuplicate: true,
              commandId: entry.commandId,
              clientMessageId: entry.commandId,
              pendingMessageVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
            },
            { source: 'daemon', confidence: 'high', eventId: `transport-user:${entry.commandId}` },
          );
          timelineEmitter.emit(sessionName, 'session.state', {
            state: 'running',
            pendingCount: runtime.pendingCount,
            pendingMessages: runtime.pendingMessages,
            pendingMessageEntries: runtime.pendingEntries,
            pendingMessageVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
          }, { source: 'daemon', confidence: 'high' });
        } else if (result === 'sent') {
          timelineEmitter.emit(sessionName, 'session.state', {
            state: 'running',
            pendingCount: runtime.pendingCount,
            pendingMessages: runtime.pendingMessages,
            pendingMessageEntries: runtime.pendingEntries,
            pendingMessageVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
          }, { source: 'daemon', confidence: 'high' });
        } else if (result === 'queued') {
          timelineEmitter.emit(sessionName, 'session.state', {
            state: 'queued',
            pendingCount: runtime.pendingCount,
            pendingMessages: runtime.pendingMessages,
            pendingMessageEntries: runtime.pendingEntries,
            pendingMessageVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
          }, { source: 'daemon', confidence: 'high' });
        }
        return result;
      },
      // N-R6 fix (audit 0419d1ac-1f4) — surface a single user-visible summary
      // when one or more queued messages were dropped for exceeding
      // RESEND_EXPIRY_MS. The web client's queued reconciliation has already
      // added these commandIds to `settledCommandIdsRef`, so a per-entry
      // `command.ack error` would be swallowed by `markOptimisticFailed`'s
      // settle guard. The `assistant.text` summary is the only path the user sees.
      ({ expiredCount }) => {
        const minutes = Math.round((5 * 60 * 1000) / 60_000); // RESEND_EXPIRY_MS / minute
        timelineEmitter.emit(
          sessionName,
          'assistant.text',
          {
            text: `⚠️ ${expiredCount} 条排队消息超过 ${minutes} 分钟未送达，已丢弃。请重新发送。`,
            streaming: false,
            memoryExcluded: true,
          },
          { source: 'daemon', confidence: 'high' },
        );
      },
      ({ failedCount }) => {
        timelineEmitter.emit(
          sessionName,
          'assistant.text',
          {
            text: `⚠️ ${failedCount} 条排队消息重连后仍未能送达，已停止自动重发。请重新发送。`,
            streaming: false,
            memoryExcluded: true,
          },
          { source: 'daemon', confidence: 'high' },
        );
      },
    );
    timelineEmitter.emit(sessionName, 'session.state', {
      state: runtime.pendingCount > 0 ? 'queued' : (runtime.sending ? 'running' : 'idle'),
      pendingCount: runtime.pendingCount,
      pendingMessages: runtime.pendingMessages,
      pendingMessageEntries: runtime.pendingEntries,
      pendingMessageVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
    }, { source: 'daemon', confidence: 'high' });
  } catch (err) {
    logger.warn({ err, session: sessionName, context }, 'transport resend drain failed');
  }
}

function wireTransportCallbacks(runtime: TransportSessionRuntime, sessionName: string): void {
  const transportUserEventId = (clientMessageId: string) => `transport-user:${clientMessageId}`;
  const persistTransportState = (state: unknown, error?: string): void => {
    if (state !== 'running' && state !== 'idle' && state !== 'error') return;
    const existing = getSession(sessionName);
    if (!existing) return;
    const normalizedError = state === 'error' && typeof error === 'string' && error.trim()
      ? error.trim()
      : undefined;
    if (existing.state === state && (existing.error ?? undefined) === normalizedError) return;
    const next: SessionRecord = {
      ...existing,
      state: state as SessionState,
      ...(normalizedError ? { error: normalizedError } : { error: undefined }),
      updatedAt: Date.now(),
    };
    upsertSession(next);
    emitSessionPersist(next, sessionName);
  };
  runtime.onStatusChange = (status) => {
    // Emit assistant.thinking for chat typing indicator (matches tmux watcher behavior)
    if (status === 'thinking') {
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'daemon', confidence: 'high' });
    }
    const mapped = (status === 'streaming' || status === 'thinking' || status === 'tool_running') ? 'running' : status;
    // Include pending info only on idle — the authoritative "turn done, queue empty" signal.
    // During running/streaming, command-handler's 'queued' event is the sole queue-update
    // authority. This keeps queued messages visible in the UI until the drained turn completes.
    const activity = runtime.getDiagnosticSnapshot();
    const effectiveMapped = mapped === 'idle' && activity.blockingWorkCount > 0 ? 'running' : mapped;
    const providerError = runtime.lastProviderError;
    persistTransportState(effectiveMapped, mapped === 'error' ? providerError?.message : undefined);
    const payload: Record<string, unknown> = { state: effectiveMapped };
    if (effectiveMapped === 'running') {
      payload.activityGeneration = activity.activityGeneration;
      payload.blockingWorkCount = activity.blockingWorkCount;
      payload.activeWorkCount = activity.blockingWorkCount;
      payload.activeToolCount = activity.activeToolCount;
      payload.busyReasons = activity.busyReasons;
    }
    if (effectiveMapped === 'idle') {
      payload.authoritative = true;
      payload.activityGeneration = activity.activityGeneration;
      payload.blockingWorkCount = 0;
      payload.activeWorkCount = 0;
      payload.activeToolCount = 0;
      payload.busyReasons = [];
      payload.decisionReason = 'activity_reconciler_clear';
      payload.clearInputs = [
        { source: 'transport-runtime', reason: 'clear', count: 0 },
      ];
      payload.pendingCount = runtime.pendingCount;
      payload.pendingMessages = runtime.pendingMessages;
      payload.pendingMessageEntries = runtime.pendingEntries;
      payload.pendingVersion = observeTransportQueueRevision(sessionName, runtime.pendingVersion);
      payload.pendingMessageVersion = payload.pendingVersion;
    } else if (mapped === 'error' && providerError?.message) {
      payload.error = providerError.message;
    }
    timelineEmitter.emit(sessionName, 'session.state', payload, { source: 'daemon', confidence: 'high' });
    if (status === 'error') {
      void recoverTransportRuntimeAfterError(sessionName, runtime);
    }
  };
  runtime.onDrain = (messages, merged, count, metadata) => {
    // The post-drain queue version. Stamped on the per-entry user.message
    // events AND the cleared session.state below so the UI advances its
    // baseline even if one of those events is lost on a weak network — a
    // stale pre-drain snapshot can then never resurrect these entries.
    const drainedVersion = observeTransportQueueRevision(sessionName, runtime.pendingVersion);
    for (const entry of messages) {
      timelineEmitter.emit(
        sessionName,
        'user.message',
        {
          text: entry.text,
          clientMessageId: entry.clientMessageId,
          allowDuplicate: true,
          pendingMessageVersion: drainedVersion,
          ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
        },
        { source: 'daemon', confidence: 'high', eventId: transportUserEventId(entry.clientMessageId) },
      );
    }
    if (messages.length === 0 && count === 0) {
      timelineEmitter.emit(sessionName, 'user.message', { text: merged, batchedCount: count, allowDuplicate: true, pendingMessageVersion: drainedVersion });
    }
    // Include authoritative pending state after drain. The drained messages have
    // been moved into the timeline via user.message emissions above, so they must
    // leave the queue UI simultaneously. The runtime's pending queue is now [] (or
    // contains any NEW messages queued since drain started).
    persistTransportState('running');
    timelineEmitter.emit(sessionName, 'session.state', {
      state: 'running',
      activityGeneration: metadata.activityGeneration,
      drainMetadata: metadata,
      pendingCount: runtime.pendingCount,
      pendingMessages: runtime.pendingMessages,
      pendingMessageEntries: runtime.pendingEntries,
      pendingVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
      pendingMessageVersion: observeTransportQueueRevision(sessionName, runtime.pendingVersion),
    }, { source: 'daemon', confidence: 'high' });
  };
  runtime.onProviderSessionReady = () => {
    // The provider session just bound (initialize/reconnect completed). Drain
    // any messages enqueued to resend while the runtime was not yet ready —
    // notably Auto-Deliver prompts that took the resend path because
    // `awaitTransportRuntime` raced the relaunch. Fire-and-forget: the launch/
    // restore drains are the awaited ones; this is the mid-life safety net.
    void drainTransportResendQueueIntoRuntime(runtime, sessionName, 'provider-ready');
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
      if ((agentType === 'cursor-headless' || agentType === 'copilot-sdk' || agentType === 'kimi-sdk') && next.providerResumeId !== info.resumeId) {
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

    // For claude-code-sdk the proactive /api/oauth/usage quota (5h + weekly) is the
    // source of truth when available; the rate_limit_event quota carried in `info`
    // is 5h-only while healthy and must NOT clobber the richer 7d picture (mirrors
    // the Option-B override in buildSessionList). This handler's emitSessionPersist
    // broadcasts to the web in real time, so without this the 7d line flickers away
    // on every rate_limit_event. Fall back to `info` (Option A) only when no
    // proactive snapshot with a weekly window exists.
    let effQuotaLabel = info.quotaLabel;
    let effQuotaMeta = info.quotaMeta;
    if (agentType === 'claude-code-sdk') {
      const proactive = peekClaudeUsageQuotaCached();
      if (proactive?.quotaMeta?.secondary) {
        effQuotaLabel = proactive.quotaLabel;
        effQuotaMeta = proactive.quotaMeta;
      }
    }

    if (typeof effQuotaLabel === 'string' && effQuotaLabel && next.quotaLabel !== effQuotaLabel) {
      next.quotaLabel = effQuotaLabel;
      changed = true;
    }

    if (typeof info.quotaUsageLabel === 'string' && info.quotaUsageLabel && next.quotaUsageLabel !== info.quotaUsageLabel) {
      next.quotaUsageLabel = info.quotaUsageLabel;
      changed = true;
    }

    if (effQuotaMeta !== undefined && !providerQuotaMetaEquals(next.quotaMeta, effQuotaMeta)) {
      next.quotaMeta = effQuotaMeta;
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

/**
 * providerSessionIds that belong to **out-of-band callers** (e.g.
 * `supervision-broker`, `summary-compressor`) which drive the provider
 * directly and attach their own `onComplete`/`onError` listeners filtered
 * by sid. Their deltas must be silently dropped by `transport-relay`
 * rather than warn-logged per-delta, because there's no IM.codes
 * user-facing session to relay them to. Caller owns mark/unmark lifecycle.
 */
const ephemeralProviderSids = new Set<string>();

/** Register a provider session ID → IM.codes session name route. */
export function registerProviderRoute(providerSessionId: string, sessionName: string): void {
  providerRouting.set(providerSessionId, sessionName);
}

/** Unregister a provider session ID route. */
export function unregisterProviderRoute(providerSessionId: string): void {
  providerRouting.delete(providerSessionId);
}

/**
 * Mark a providerSessionId as belonging to an ephemeral out-of-band caller
 * (supervision decision, summary compression, etc.). `transport-relay`
 * will drop this sid's deltas silently instead of warning. The caller is
 * responsible for calling `unmarkEphemeralProviderSid` when the session
 * ends (typically in a finally block alongside `provider.endSession`).
 */
export function markEphemeralProviderSid(providerSessionId: string): void {
  ephemeralProviderSids.add(providerSessionId);
}

/** Release an ephemeral providerSessionId marking. Idempotent. */
export function unmarkEphemeralProviderSid(providerSessionId: string): void {
  ephemeralProviderSids.delete(providerSessionId);
}

/** Is this providerSessionId a known ephemeral/out-of-band sid? */
export function isEphemeralProviderSid(providerSessionId: string): boolean {
  return ephemeralProviderSids.has(providerSessionId);
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

type RestoreOpenToolCall = {
  id: string;
  tool?: string;
  activityGeneration?: ActivityGenerationLike;
};

type RestoreOpenSdkSubagentCall = RestoreOpenToolCall & {
  detail: SdkSubagentDetail;
  key: string;
  turnId?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readTransportToolCallId(event: Record<string, unknown>): string | null {
  for (const key of ['toolCallId', 'toolUseId', 'callId', 'id']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

async function reconcileTransportRestoreOrphanTools(sessionName: string, runtime: TransportSessionRuntime): Promise<number> {
  let events: Record<string, unknown>[] = [];
  try {
    events = await replayTransportHistory(sessionName);
  } catch (err) {
    logger.warn({ err, sessionName }, 'transport restore orphan reconcile could not read transport history');
    return 0;
  }
  if (events.length === 0) return 0;

  const openTools = new Map<string, RestoreOpenToolCall>();
  for (const event of events) {
    if (event.type !== 'tool.call' && event.type !== 'tool.result') continue;
    const id = readTransportToolCallId(event);
    if (!id) continue;
    if (event.type === 'tool.call') {
      openTools.set(id, {
        id,
        ...(typeof event.tool === 'string' && event.tool.trim() ? { tool: event.tool.trim() } : {}),
        ...(event.activityGeneration !== undefined ? { activityGeneration: event.activityGeneration as ActivityGenerationLike } : {}),
      });
    } else {
      openTools.delete(id);
    }
  }
  if (openTools.size === 0) return 0;

  const fallbackActivityGeneration = runtime.getDiagnosticSnapshot().activityGeneration;
  let closed = 0;
  for (const tool of openTools.values()) {
    const activityGeneration = tool.activityGeneration ?? fallbackActivityGeneration;
    const metadata = buildCodexLifecycleTerminalMetadata({
      sessionId: sessionName,
      terminalStatus: 'stale',
      terminalReason: 'daemon_restart_orphan',
      activityGeneration,
      toolCallId: tool.id,
      synthetic: true,
      source: 'daemon_synthetic',
      decisionReason: 'restore_reconnect_orphan_reconcile',
    });
    const payload: Record<string, unknown> = {
      toolCallId: tool.id,
      ...(tool.tool ? { tool: tool.tool } : {}),
      ...metadata,
    };
    timelineEmitter.emit(sessionName, 'tool.result', payload, {
      source: 'daemon',
      confidence: 'high',
      eventId: metadata.idempotencyKey,
    });
    await appendTransportEvent(sessionName, {
      type: 'tool.result',
      sessionId: sessionName,
      ...payload,
    });
    closed++;
  }
  logger.info({ sessionName, closed }, 'transport restore reconciled orphan tool calls');
  return closed;
}

async function reconcileTimelineRestoreOrphanSdkSubagents(sessionName: string, runtime: TransportSessionRuntime): Promise<number> {
  let events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  try {
    const timelineEvents = await timelineStore.readByTypesPreferred(sessionName, ['tool.call', 'tool.result'], { limit: 200 });
    events = timelineEvents.map((event) => ({ type: event.type, payload: event.payload }));
  } catch (err) {
    logger.warn({ err, sessionName }, 'transport restore sdk orphan reconcile could not read timeline history');
    return 0;
  }
  if (events.length === 0) return 0;

  const openSdk = new Map<string, RestoreOpenSdkSubagentCall>();
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    const parsed = parseSdkSubagentDetail(payload.detail);
    if (parsed.kind !== 'ok') continue;
    const id = readTransportToolCallId(payload);
    if (!id) continue;
    const key = parsed.detail.meta.canonicalKey || id;
    if (event.type === 'tool.call' && parsed.detail.meta.active && !parsed.detail.meta.terminal) {
      openSdk.set(key, {
        key,
        id,
        detail: parsed.detail,
        ...(typeof payload.tool === 'string' && payload.tool.trim() ? { tool: payload.tool.trim() } : {}),
        ...(payload.activityGeneration !== undefined ? { activityGeneration: payload.activityGeneration as ActivityGenerationLike } : {}),
        ...(typeof payload.turnId === 'string' && payload.turnId.trim() ? { turnId: payload.turnId.trim() } : {}),
      });
    } else if (event.type === 'tool.result' || parsed.detail.meta.terminal) {
      openSdk.delete(key);
      openSdk.delete(id);
    }
  }
  if (openSdk.size === 0) return 0;

  const fallbackActivityGeneration = runtime.getDiagnosticSnapshot().activityGeneration;
  let closed = 0;
  for (const tool of openSdk.values()) {
    const staleDetail = buildSdkSubagentSafeDetail({
      ...tool.detail,
      output: tool.detail.output ?? 'stale after daemon restart',
      meta: {
        ...tool.detail.meta,
        normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
        rawStatus: 'daemon_restart_orphan',
        active: false,
        terminal: true,
        diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.STALE_WITHOUT_TERMINAL,
        ...(typeof tool.detail.meta.runningChildCount === 'number' ? { runningChildCount: 0 } : {}),
      },
    }, { allowRaw: false, sessionId: sessionName });
    const itemKind = staleDetail.meta.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT
      ? 'codex_collaboration'
      : 'sdk_subagent';
    const metadata = buildCodexLifecycleTerminalMetadata({
      sessionId: sessionName,
      terminalStatus: 'stale',
      terminalReason: 'daemon_restart_orphan',
      activityGeneration: tool.activityGeneration ?? fallbackActivityGeneration,
      toolCallId: tool.id,
      ...(tool.turnId ? { turnId: tool.turnId } : {}),
      itemKind,
      synthetic: true,
      source: 'daemon_synthetic',
      decisionReason: 'restore_reconnect_orphan_reconcile',
    });
    timelineEmitter.emit(sessionName, 'tool.result', {
      toolCallId: tool.id,
      ...(tool.tool ? { tool: tool.tool } : {}),
      ...metadata,
      output: staleDetail.output,
      detail: staleDetail,
    }, {
      source: 'daemon',
      confidence: 'high',
      eventId: `transport-tool:${sessionName}:${tool.id}:restore-orphan-result`,
      hidden: true,
    });
    closed += 1;
  }
  logger.info({ sessionName, closed }, 'transport restore reconciled orphan sdk sub-agent rows');
  return closed;
}

/**
 * Restore transport session runtimes for a specific provider.
 * Called after provider auto-reconnect succeeds (restoreFromStore runs before provider connects).
 * Skips sessions that already have a runtime (rebuilt by oc-session-sync).
 */
export async function restoreTransportSessions(
  providerId: string,
  options: { onlyWithPendingResend?: boolean; concurrency?: number; interSessionDelayMs?: number } = {},
): Promise<void> {
  const all = storeSessions();
  const qwenRuntime = providerId === 'qwen' ? await getQwenRuntimeConfig().catch(() => null) : null;
  const restoreConcurrency = Number.isFinite(options.concurrency) && (options.concurrency ?? 0) >= 1
    ? Math.trunc(options.concurrency!)
    : TRANSPORT_RESTORE_CONCURRENCY;
  const restoreInterSessionDelayMs = Number.isFinite(options.interSessionDelayMs) && (options.interSessionDelayMs ?? -1) >= 0
    ? Math.trunc(options.interSessionDelayMs!)
    : TRANSPORT_RESTORE_INTER_SESSION_DELAY_MS;
  // Restore with BOUNDED CONCURRENCY rather than one-at-a-time. Each session's
  // restore is ~1s of mostly-I/O wait (context bootstrap has a 2.5s timeout +
  // the provider's resume RPC), so a sequential loop over ~30 transport
  // sessions takes ~30s of wall-clock before they are usable again after a
  // daemon restart / reconnect. A few in flight overlaps those waits and cuts
  // it to a few seconds. Safe to parallelize: runtime.initialize mutates only
  // its own instance; the codex/cc app-server RPC layer is id-correlated
  // (concurrent requests don't cross-talk) and createSession does not spawn a
  // process; node:sqlite is synchronous so memory/context reads serialise on
  // the main thread anyway; every store write is keyed by session name.
  type Restorable = SessionRecord & { providerId: string; providerSessionId: string };
  const pending = all.filter((s) =>
    isStoredTransportSession(s)
    && (s.providerId ?? s.agentType) === providerId
    && !!s.providerSessionId
    && (!options.onlyWithPendingResend || getResendCount(s.name) > 0),
  ).map((s) => ({ ...s, providerId, providerSessionId: s.providerSessionId! } as Restorable));
  const restoreOne = async (s: Restorable, index: number): Promise<void> => {
    await pauseBetweenTransportRestores(index, restoreInterSessionDelayMs);
    const existingRuntime = transportRuntimes.get(s.name);
    if (existingRuntime?.providerSessionId) return; // already rebuilt by oc-sync / warm restore
    if (existingRuntime) {
      const preservation = preserveTransportRuntimeQueuesToResend(s.name, existingRuntime);
      if (preservation.preservedCount > 0) {
        logger.info({ sessionName: s.name, ...preservation }, 'preserved unbound transport runtime queues before restore');
      }
      await stopTransportRuntimeSession(s.name).catch((err) => {
        logger.warn({ err, session: s.name }, 'Failed to stop unbound transport runtime before restore');
      });
    }
    try {
      const provider = getProvider(s.providerId);
      if (!provider) return;
      let availableQwenModels = s.providerId === 'qwen'
        ? (s.qwenAvailableModels?.length ? s.qwenAvailableModels : (qwenRuntime?.availableModels ?? []))
        : [];
      let requestedTransportModel = s.requestedModel ?? s.qwenModel;
      if (s.providerId === 'codex-sdk') {
        requestedTransportModel = sanitizeCodexSdkStartupModel(requestedTransportModel);
      } else if (s.providerId === 'claude-code-sdk' && requestedTransportModel) {
        // Resolve the picker alias (e.g. "fable") to the documented API id before the
        // SDK sees it — symmetric with the model-change path (command-handler) and the
        // codex branch above. Without this, a restored session passed the raw alias and
        // the SDK rejected it ("model (fable) may not exist"). Idempotent for ids.
        requestedTransportModel = normalizeClaudeSdkModelForProvider(requestedTransportModel);
      }
      const runtime = new TransportSessionRuntime(provider, s.name);
      wireTransportCallbacks(runtime, s.name);
      wireTransportSessionInfo(runtime, s.name, s.agentType);
      // After cancel, qwenFreshOnResume is set — don't resume the stuck conversation.
      const freshAfterCancel = !!(s.qwenFreshOnResume && s.providerId === 'qwen');
      const freshAfterInterruptedCodexRestore = shouldStartFreshCodexThreadAfterInterruptedRestore(s);
      const freshOnRestore = freshAfterCancel || freshAfterInterruptedCodexRestore;
      const needsEphemeralRouteKey = s.providerId === 'claude-code-sdk'
        || s.providerId === 'codex-sdk'
        || s.providerId === 'cursor-headless'
        || s.providerId === 'copilot-sdk'
        || s.providerId === 'kimi-sdk';
      const effectiveSessionKey = freshOnRestore || needsEphemeralRouteKey ? randomUUID() : s.providerSessionId;
      const resumeId = s.providerId === 'claude-code-sdk'
        ? s.ccSessionId
        : s.providerId === 'codex-sdk'
          ? (freshAfterInterruptedCodexRestore ? undefined : s.codexSessionId)
          : (s.providerId === 'cursor-headless' || s.providerId === 'copilot-sdk' || s.providerId === 'kimi-sdk')
            ? s.providerResumeId
            : undefined;
      const preserveStartupMemoryOnRestore = s.startupMemoryInjected === true && !freshAfterInterruptedCodexRestore;
      if (freshAfterInterruptedCodexRestore) {
        logger.warn({
          session: s.name,
          providerId: s.providerId,
          previousCodexSessionId: s.codexSessionId,
          previousProviderSessionId: s.providerSessionId,
        }, 'Codex SDK restore found interrupted running session; starting fresh thread');
      }
      let extraEnv: Record<string, string> | undefined;
      let systemPrompt: string | undefined;
      let transportSettings: string | Record<string, unknown> | undefined;
      let effectiveRequestedModel = requestedTransportModel;
      let restoredPresetContextWindow = s.presetContextWindow;
      let qwenPresetUsesApiKey = false;
      const resolveRuntimeContextBootstrap = () => resolveTransportContextBootstrap({
        projectDir: s.projectDir,
        transportConfig: getSession(s.name)?.transportConfig ?? s.transportConfig ?? {},
        startupMemoryAlreadyInjected: preserveStartupMemoryOnRestore,
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
        const presetModels = presetConfig.availableModels ?? [];
        if (presetModels.length) availableQwenModels = presetModels;
        const presetPreferredModel = presetConfig.model ?? presetModels[0];
        if (presetPreferredModel && (!effectiveRequestedModel || !presetModels.length || !presetModels.includes(effectiveRequestedModel))) {
          effectiveRequestedModel = presetPreferredModel;
        }
        transportSettings = presetConfig.settings;
        qwenPresetUsesApiKey = !!presetConfig.settings;
        restoredPresetContextWindow = presetConfig.contextWindow ?? restoredPresetContextWindow;
        // Override the qwen CLI's built-in "I am Qwen Code" identity with the
        // preset's runtime-facts prompt — without this, the model introduces
        // itself as Qwen / 通义千问 even when the turn is served by MiniMax.
        if (presetConfig.systemPrompt) systemPrompt = presetConfig.systemPrompt;
      }
      if (s.providerId === 'qwen'
        && !s.ccPreset
        && (!effectiveRequestedModel || (availableQwenModels.length > 0 && !availableQwenModels.includes(effectiveRequestedModel)))) {
        effectiveRequestedModel = availableQwenModels[0] ?? effectiveRequestedModel;
      }
      const boundServerId = await loadBoundServerIdForManagedMcp();
      await runtime.initialize({
        sessionKey: effectiveSessionKey,
        sessionName: s.name,
        projectName: s.projectName,
        serverId: boundServerId,
        fresh: freshOnRestore,
        bindExistingKey: freshOnRestore ? undefined : (needsEphemeralRouteKey ? s.providerSessionId : s.providerSessionId),
        skipCreate: !freshOnRestore && !!s.providerSessionId,
        env: buildTransportSessionEnv(s.name, s.label, extraEnv),
        cwd: s.projectDir,
        label: s.label ?? s.name,
        description: s.description,
        // User-authored systemPrompt only; the IM.codes identity block and
        // Generated Image Reporting protocol are injected at the assembly
        // layer (peer-level with `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE`) via
        // `runtime.initialize` -> `setSessionIdentity`. They are NOT
        // subject to `clampUserSessionText`'s 300-char cap. See p2p
        // audit 37bfbb85-430 N-A.
        systemPrompt,
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
        startupMemoryAlreadyInjected: preserveStartupMemoryOnRestore,
      });
      if (s.description) runtime.setDescription(s.description);
      if (systemPrompt) runtime.setSystemPrompt(systemPrompt);
      runtime.setSessionIdentity(s.name, s.label);
      if (effectiveRequestedModel) runtime.setAgentId(effectiveRequestedModel);
      if (s.effort) runtime.setEffort(s.effort);
      transportRuntimes.set(s.name, runtime);
      const actualProviderSid = runtime.providerSessionId ?? effectiveSessionKey;
      registerProviderRoute(actualProviderSid, s.name);
      const restoredRecord: SessionRecord = {
        ...s,
        state: 'idle',
        updatedAt: Date.now(),
        ...(freshAfterInterruptedCodexRestore
          ? { codexSessionId: undefined, startupMemoryInjected: undefined, recentInjectionHistory: undefined }
          : {}),
        ...((freshOnRestore || s.providerSessionId !== actualProviderSid)
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
        qwenAuthType: (s.providerId === 'qwen' && s.ccPreset && qwenPresetUsesApiKey)
          ? QWEN_AUTH_TYPES.API_KEY
          : (qwenRuntime?.authType ?? s.qwenAuthType),
        qwenAuthLimit: (s.providerId === 'qwen' && s.ccPreset && qwenPresetUsesApiKey)
          ? undefined
          : (qwenRuntime?.authLimit ?? s.qwenAuthLimit),
        ...(availableQwenModels.length > 0 ? { qwenAvailableModels: availableQwenModels } : {}),
        ...(restoredPresetContextWindow ? { presetContextWindow: restoredPresetContextWindow } : {}),
        ...getQwenDisplayMetadata({
          model: effectiveRequestedModel,
          authType: (s.providerId === 'qwen' && s.ccPreset && qwenPresetUsesApiKey)
            ? QWEN_AUTH_TYPES.API_KEY
            : (qwenRuntime?.authType ?? s.qwenAuthType),
          authLimit: (s.providerId === 'qwen' && s.ccPreset && qwenPresetUsesApiKey)
            ? undefined
            : (qwenRuntime?.authLimit ?? s.qwenAuthLimit),
          quotaUsageLabel: (s.providerId === 'qwen' && s.ccPreset && qwenPresetUsesApiKey)
            ? undefined
            : ((qwenRuntime?.authType ?? s.qwenAuthType) === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined),
        }),
      };
      upsertSession(restoredRecord);
      emitSessionPersist(restoredRecord, s.name);
      await reconcileTransportRestoreOrphanTools(s.name, runtime);
      await reconcileTimelineRestoreOrphanSdkSubagents(s.name, runtime);
      const restoredActivity = runtime.getDiagnosticSnapshot();
      timelineEmitter.emit(s.name, 'session.state', {
        state: 'idle',
        activityGeneration: restoredActivity.activityGeneration,
        blockingWorkCount: restoredActivity.blockingWorkCount,
        activeWorkCount: restoredActivity.blockingWorkCount,
        activeToolCount: restoredActivity.activeToolCount,
        busyReasons: restoredActivity.busyReasons,
        decisionReason: 'restore_reconnect_observed',
        [TIMELINE_SUPPRESS_PUSH_FIELD]: true,
        pendingCount: runtime.pendingCount,
        pendingMessages: runtime.pendingMessages,
        pendingMessageEntries: runtime.pendingEntries,
        pendingVersion: observeTransportQueueRevision(s.name, runtime.pendingVersion),
        pendingMessageVersion: observeTransportQueueRevision(s.name, runtime.pendingVersion),
      }, { source: 'daemon', confidence: 'high' });
      logger.info({
        session: s.name,
        providerId: s.providerId,
        providerSid: s.providerSessionId,
        freshAfterCancel,
        freshAfterInterruptedCodexRestore,
      }, 'Restored transport session runtime');

      // Drain messages that arrived while the provider was offline. The
      // enqueue path deliberately did NOT emit a user.message event (the
      // agent hadn't seen the message yet), so emit it HERE — exactly when
      // runtime.send() returns 'sent' and the entry really is dispatched to
      // the agent. If the runtime queues it internally (returns 'queued'),
      // leave the optimistic pending bubble in place; it will be reconciled
      // once the turn actually fires.
      // Failures are logged and entries dropped to avoid retry loops.
      //
      // R-Drain fix (audit cae1de69-826) — `await drainResend(...)` instead
      // of `void drainResend(...)`. The dispatcher is synchronous and
      // `runtime.send()` synchronously sets `_sending=true` via
      // `_dispatchTurn`, so the current race window is effectively zero
      // (verified in transport-session-runtime.ts:376-462). The change is
      // defensive: it ensures the resend queue has been fully transferred
      // into either `_sending`/active state or `runtime._pendingMessages`
      // before `restoreTransportSessions` returns. This protects against
      // future refactors that might insert an `await` between
      // `transportRuntimes.set` and `drainResend`, which WOULD reintroduce
      // a real race window letting msg-2 arrive at `handleSend` while
      // `_sending` is still false.
      await drainTransportResendQueueIntoRuntime(runtime, s.name, 'reconnect');
    } catch (err) {
      logger.warn({ err, session: s.name }, 'Failed to restore transport session runtime');
    }
  };
  // restoreOne swallows its own errors above, so mapWithConcurrency never
  // rejects — one bad session can't abort the rest of the restore.
  logger.info({
    providerId,
    count: pending.length,
    concurrency: restoreConcurrency,
    interSessionDelayMs: restoreInterSessionDelayMs,
  }, 'Restoring transport session runtimes');
  await mapWithConcurrency(pending, restoreConcurrency, restoreOne);
  logger.info({ providerId, count: pending.length }, 'Transport session runtime restore completed');
}

/**
 * Coalesces concurrent launches for the same session name. The runtime is only
 * registered in `transportRuntimes` at the END of the async launch, so callers
 * that dedup with `getTransportRuntime(name)` (e.g. `rebuildSubSessions`, which
 * the server re-fires on every WS reconnect) all observe "no runtime yet" when
 * they overlap and ALL launch. On an unstable WS this produces a launch storm
 * (10-13x the same sub-session) that blocks the event loop, which starves
 * heartbeats and triggers MORE reconnects+rebuilds — a vicious cycle that
 * prevents real sessions (e.g. brain) from keeping a runtime. Serialize per
 * session name so the second caller coalesces onto the first instead of
 * duplicating it; the synchronous get→set window has no await so two concurrent
 * callers cannot both observe "no in-flight".
 */
const transportLaunchInFlight = new Map<string, Promise<void>>();

export async function launchTransportSession(opts: LaunchOpts): Promise<void> {
  const { name } = opts;
  const inFlight = transportLaunchInFlight.get(name);
  if (inFlight) {
    await inFlight.catch(() => {});
    // A non-fresh caller only needs the session up: if the prior launch
    // registered a runtime, we're done. A fresh caller must proceed (it
    // intentionally tears down + recreates).
    if (!opts.fresh && transportRuntimes.has(name)) return;
  }
  const launch = launchTransportSessionInner(opts);
  const tracked = launch.then(() => {}, () => {});
  transportLaunchInFlight.set(name, tracked);
  try {
    await launch;
  } finally {
    if (transportLaunchInFlight.get(name) === tracked) transportLaunchInFlight.delete(name);
  }
}

async function launchTransportSessionInner(opts: LaunchOpts): Promise<void> {
  const { name, projectName, role, agentType, projectDir, skipStore, label, description, bindExistingKey, skipCreate } = opts;
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
  if (agentType === 'codex-sdk') {
    requestedTransportModel = sanitizeCodexSdkStartupModel(requestedTransportModel);
  } else if (agentType === 'claude-code-sdk' && requestedTransportModel) {
    // Resolve the picker alias (e.g. "fable") to the documented API id at launch —
    // symmetric with the restore path and command-handler's model-change path.
    requestedTransportModel = normalizeClaudeSdkModelForProvider(requestedTransportModel);
  }
  // Preserve existing transportConfig (including supervision) when opts doesn't override.
  // Only fall through to `undefined` if nothing is set — never force `{}`, which would
  // strip supervision on restart/relaunch.
  const effectiveTransportConfig: Record<string, unknown> | undefined =
    opts.transportConfig ?? existing?.transportConfig;
  // Sticky fields — fall back to the stored record when the caller didn't pass
  // them (e.g. daemon restart → rebuildSubSessions, provider auto-reconnect).
  // Without this, reconstructing the SessionRecord below clobbers the preset
  // and causes Qwen to revert from the preset model (MiniMax-M2 / GLM / Kimi …)
  // back to the OAuth `coder-model` placeholder. `opts.fresh` (from /clear or
  // explicit reset) still wins — same rule applied to transportConfig above.
  const effectiveCcPreset: string | undefined =
    opts.ccPreset ?? (!opts.fresh ? existing?.ccPreset : undefined);
  const effectiveUserCreated: boolean | undefined =
    opts.userCreated ?? (!opts.fresh ? existing?.userCreated : undefined);
  const effectiveParentSession: string | undefined =
    opts.parentSession ?? (!opts.fresh ? existing?.parentSession : undefined);
  // recentInjectionHistory is maintained out-of-band by recent-injection-history.ts.
  // If we don't carry it forward, upsertSession below wipes the dedup ring buffer
  // and previously-injected memories get re-injected into the same conversation.
  const preservedRecentInjectionHistory: string[][] | undefined =
    !opts.fresh ? existing?.recentInjectionHistory : undefined;
  let transportResumeId: string | undefined;
  let transportEnv: Record<string, string> | undefined = opts.extraEnv;
  let presetContextWindow: number | undefined = !opts.fresh ? existing?.presetContextWindow : undefined;
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
      if (effectiveCcPreset) {
        const { getQwenPresetTransportConfig } = await import('../daemon/cc-presets.js');
        const presetConfig = await getQwenPresetTransportConfig(effectiveCcPreset);
        transportEnv = { ...(transportEnv ?? {}), ...presetConfig.env };
        if (presetConfig.availableModels?.length) availableQwenModels = presetConfig.availableModels;
        if (!requestedTransportModel || (availableQwenModels.length > 0 && !availableQwenModels.includes(requestedTransportModel))) {
          requestedTransportModel = presetConfig.model ?? availableQwenModels[0] ?? requestedTransportModel;
        }
        presetContextWindow = presetConfig.contextWindow;
        if (presetConfig.settings) transportSettings = presetConfig.settings;
        if (presetConfig.systemPrompt) transportSystemPrompt = presetConfig.systemPrompt;
        if (presetConfig.settings) {
          qwenAuthType = QWEN_AUTH_TYPES.API_KEY;
          qwenAuthLimit = undefined;
        }
    }
    if (!effectiveCcPreset && (!requestedTransportModel || (availableQwenModels.length > 0 && !availableQwenModels.includes(requestedTransportModel)))) {
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
    if (effectiveCcPreset) {
      const { resolvePresetEnv, getPresetTransportOverrides } = await import('../daemon/cc-presets.js');
      transportEnv = { ...(transportEnv ?? {}), ...(await resolvePresetEnv(effectiveCcPreset, transportResumeId)) };
      const presetOverrides = await getPresetTransportOverrides(effectiveCcPreset);
      if (!requestedTransportModel && presetOverrides.model) requestedTransportModel = presetOverrides.model;
      presetContextWindow = presetOverrides.contextWindow;
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
    sdkDisplay = mergeCodexDisplayMetadata(
      await getCodexRuntimeConfig({ probe: false }).catch(() => ({})),
      existing,
    );
  } else if (agentType === 'cursor-headless' || agentType === 'copilot-sdk' || agentType === 'kimi-sdk') {
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
  const boundServerId = await loadBoundServerIdForManagedMcp();
  await runtime.initialize({
    sessionKey: effectiveSessionKey,
    sessionName: name,
    projectName,
    serverId: boundServerId,
    fresh: !!opts.fresh,
    env: buildTransportSessionEnv(name, label, transportEnv),
    cwd: projectDir,
    label: label || name,
    description,
    // User-authored only. Identity + image-reporting are injected at
    // the assembly layer via `SessionConfig.sessionName` / `label` ->
    // `runtime.setSessionIdentity`, peer-level with
    // `MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE` and outside the 300-char user
    // cap. See p2p audit 37bfbb85-430 N-A.
    systemPrompt: transportSystemPrompt,
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
        ...((agentType === 'copilot-sdk' || agentType === 'cursor-headless' || agentType === 'kimi-sdk') && transportResumeId
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
        ...(effectiveCcPreset ? { ccPreset: effectiveCcPreset } : {}),
        ...(presetContextWindow ? { presetContextWindow } : {}),
        label,
        parentSession: effectiveParentSession,
        userCreated: effectiveUserCreated,
        // Preserve the flag across session.restart / runtime rebuild so we
        // don't re-inject startup memory into a conversation that already
        // received it. /clear wipes it because `opts.fresh === true`.
        ...(preserveStartupMemoryInject ? { startupMemoryInjected: true } : {}),
        // Carry the dedup ring buffer over so previously-injected memories
        // are not re-injected into the same conversation after a rebuild.
        // recent-injection-history.ts owns writes; we just avoid clobbering.
        ...(preservedRecentInjectionHistory && preservedRecentInjectionHistory.length > 0
          ? { recentInjectionHistory: preservedRecentInjectionHistory }
          : {}),
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
  //
  // R-Drain fix (audit cae1de69-826) — `await drainResend(...)` so the
  // launch promise (and the per-session relaunch lock held by
  // `runExclusiveSessionRelaunch`) does not resolve until the resend
  // queue has been fully transferred into the runtime. See the matching
  // change in `restoreTransportSessions` above for the full rationale.
  await drainTransportResendQueueIntoRuntime(runtime, name, 'launch');
}

const pendingResendRelaunches = new Set<string>();

/**
 * Ensure a transport session that has NO live, provider-bound runtime gets
 * (re)launched so its transport resend queue drains. This mirrors the recovery
 * the manual send path performs inline (command-handler: enqueueResend +
 * `runExclusiveSessionRelaunch` → `resumeTransportRuntimeAfterLoss`).
 *
 * Callers that deliver OUTSIDE that send path MUST call this after enqueueing to
 * resend — notably the Auto-Deliver orchestrator targeting a *deferred* transport
 * sub-session. `rebuildSubSessions` defers sub-session runtimes until first send
 * ("rebuild deferred until first send"), so a sub may have no runtime at all;
 * without this, an Auto-Deliver prompt enqueued to resend would sit there forever
 * because nothing ever creates the runtime to fire the drain. This is exactly why
 * manual sends delivered but Auto-Deliver stuck in the queue.
 *
 * No-ops when the runtime is already bound. De-duped per session; the launch
 * coalescing inside `launchTransportSession` (which drains the resend queue on
 * success) is the final concurrency guard.
 */
export async function ensureTransportRuntimeForPendingResend(sessionName: string): Promise<void> {
  if (pendingResendRelaunches.has(sessionName)) return;
  const record = getSession(sessionName);
  if (!record || !isTransportAgent(record.agentType as AgentType)) return;
  const runtime = getTransportRuntime(sessionName);
  if (runtime && runtime.providerSessionId) return; // already bound — nothing to recover
  pendingResendRelaunches.add(sessionName);
  try {
    if (runtime) {
      // Registered but unbound (half-dead — e.g. post-cancel / mid-init error):
      // preserve its queued work into resend and stop it before relaunch.
      const preservation = preserveTransportRuntimeQueuesToResend(sessionName, runtime);
      if (preservation.preservedCount > 0) {
        logger.info({ sessionName, ...preservation }, 'preserved transport runtime queues before pending-resend relaunch');
      }
      await stopTransportRuntimeSession(sessionName).catch(() => {});
    }
    await launchTransportSession(buildTransportResumeLaunchOpts(record));
  } catch (err) {
    logger.error({ err, sessionName }, 'ensureTransportRuntimeForPendingResend failed');
  } finally {
    pendingResendRelaunches.delete(sessionName);
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
    familyDisplay = mergeCodexDisplayMetadata(
      await getCodexRuntimeConfig({ probe: false }).catch(() => ({})),
      getSession(name),
    );
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
