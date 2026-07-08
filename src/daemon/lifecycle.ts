import { loadStore, flushStore, listSessions, getSession, upsertSession, removeSession, type SessionRecord } from '../store/session-store.js';
import { restoreFromStore, setSessionEventCallback, setSessionPersistCallback, restartSession, respawnSession, initOnStartup, rebuildProviderRoutes, getTransportRuntime, unregisterProviderRoute } from '../agent/session-manager.js';
import { sessionExists, isPaneAlive, BACKEND, killSession } from '../agent/tmux.js';
import { detectRepo } from '../repo/detector.js';
import { repoCache, RepoCache } from '../repo/cache.js';
import { ServerLink } from './server-link.js';
import { handleWebCommand, setRouterContext, refreshCodexQuotaMetadata, refreshClaudeSdkSubQuotaMetadata } from './command-handler.js';
import { initFileTransfer, startCleanupTimer } from './file-transfer-handler.js';
import { notifySessionIdle, listP2pRuns, serializeP2pRun } from './p2p-orchestrator.js';
import { isP2pParticipantMemoryNoise } from './p2p-memory-filter.js';
import { handlePreviewBinaryFrame } from './preview-relay.js';
import { buildSessionList } from './session-list.js';
import { timelineEmitter } from './timeline-emitter.js';
import { isExecutionClone, sweepExecutionClones, destroyExecutionClone, resolveExecutionCloneRetentionMs } from './execution-clone.js';
import { EXECUTION_CLONE_TIMELINE } from '../../shared/execution-clone.js';
import { startLatencyTracer } from './latency-tracer.js';
import { supervisionAutomation } from './supervision-automation.js';
import { timelineStore } from './timeline-store.js';
import { getDefaultAckOutbox } from './ack-outbox.js';
import { startHookServer, drainQueue } from './hook-server.js';
import { initTempFileStore } from '../store/temp-file-store.js';
import { setupCCHooks } from '../agent/signal.js';
import type http from 'http';
import net from 'node:net';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadConfig, type Config } from '../config.js';
import { loadCredentials } from '../bind/bind-flow.js';
import { sendKeys } from '../agent/tmux.js';
import logger from '../util/logger.js';
import { recordDaemonStart } from '../util/daemon-status.js';
import { installDaemonRuntimeDiagnosticsProvider } from './runtime-diagnostics.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import { pickReadableSessionDisplay } from '../../shared/session-display.js';
import { buildWorkerSessionPersistBody, mergeWorkerSessionSnapshot, shouldPersistMainSessionToWorkerOnStartup } from './session-bootstrap.js';
import { replicatePendingProcessedContext } from '../context/processed-context-replication.js';
import { configureSharedContextRuntime } from '../context/shared-context-runtime.js';
import { fetchBackendSharedContextRuntimeConfig } from '../context/backend-runtime-config.js';
import { setContextModelRuntimeConfig } from '../context/context-model-config.js';
import { closeLiveContextMaterializationAdmission, LiveContextIngestion } from '../context/live-context-ingestion.js';
import { LocalSkillReviewWorker } from '../context/skill-review-worker.js';
import { resolveTransportContextBootstrap } from '../agent/runtime-context-bootstrap.js';
import { pruneLocalMemory } from '../context/memory-pruning.js';
import { backfillProjectionEmbeddings } from '../context/projection-embedding-maintenance.js';
import { getContextStoreClient } from '../store/context-store-worker-client.js';
import { setArchiveBackfillSchedulingEnabled } from '../store/archive-backfill-scheduling.js';
import { getResendCount } from './transport-resend-queue.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { isTransportAgent } from '../agent/detect.js';
import { TRANSPORT_SESSION_AGENT_TYPES } from '../../shared/agent-types.js';
import { DAEMON_VERSION } from '../util/version.js';
import { createWorkerSessionSyncRetrier, type WorkerSessionSyncRetrier, type WorkerSessionSyncRetryOutcome } from './worker-session-sync-retrier.js';
import {
  WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT,
  WORKER_SESSION_SYNC_STATUS,
  type WorkerSessionSyncStatus,
} from '../../shared/worker-session-snapshot.js';
import { buildWorkerSessionSyncPlan, type WorkerSessionSyncPlanInput } from './worker-session-sync-plan.js';
import { buildTransportQueueSnapshotPayload } from './transport-queue-projection.js';
import { getStaleSessionCompressionRun, resolveSessionCompressionWatchRuns } from '../context/summary-compressor.js';
import { normalizeActivityGeneration } from '../../shared/session-activity-types.js';
import type { TransportRuntimeDiagnosticSnapshot } from '../agent/transport-session-runtime.js';

function latestAssistantTextFromEvents(events: Array<{ type?: unknown; payload?: unknown }>): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'assistant.text') continue;
    const text = (event.payload as Record<string, unknown> | undefined)?.text;
    if (typeof text === 'string' && text.trim()) return text.slice(0, 200);
  }
  return undefined;
}

/** Get the last assistant.text from a session's timeline (for push notification context). */
export async function getLastAssistantText(sessionName: string): Promise<string | undefined> {
  const buffered = latestAssistantTextFromEvents(timelineEmitter.getBufferedEvents(sessionName));
  if (buffered) return buffered;

  try {
    const events = await timelineStore.readByTypesPreferred(sessionName, ['assistant.text'], { limit: 100 });
    return latestAssistantTextFromEvents(events);
  } catch { /* ignore */ }
  return undefined;
}

export function resolvePushDisplayContext(sessionName: string, sessions: SessionRecord[]): {
  project: string;
  label?: string;
  parentLabel?: string;
} {
  const byName = new Map(sessions.map((session) => [session.name, session] as const));
  const session = byName.get(sessionName);
  const label = pickReadableSessionDisplay([session?.label], sessionName);
  const visited = new Set<string>();
  let cursor = session;
  let parentLabel: string | undefined;

  while (cursor?.parentSession && !visited.has(cursor.parentSession)) {
    visited.add(cursor.parentSession);
    const parent = byName.get(cursor.parentSession);
    if (!parent) break;
    const readable = pickReadableSessionDisplay([parent.label, parent.projectName], parent.name);
    if (readable) {
      parentLabel = readable;
      break;
    }
    cursor = parent;
  }

  const project = pickReadableSessionDisplay(
    [label, parentLabel, session?.projectName],
    sessionName,
  ) ?? session?.projectName ?? sessionName;

  return {
    project,
    ...(label ? { label } : {}),
    ...(parentLabel ? { parentLabel } : {}),
  };
}

export interface DaemonContext {
  config: Config;
  serverLink: ServerLink | null;
  /** Persist a channel binding to D1 via CF Worker API. Returns false if not connected or request fails. */
  persistBinding(platform: string, channelId: string, botId: string, bindingType: string, target: string): Promise<boolean>;
  /** Remove a channel binding from D1 via CF Worker API. Returns false if not connected or request fails. */
  removeBinding(platform: string, channelId: string, botId: string): Promise<boolean>;
  /** Send a session event (started/stopped/error) to the CF Worker for relay to browsers. */
  sendSessionEvent(event: 'started' | 'stopped' | 'error', session: string, state: string): void;
}

let ctx: DaemonContext | null = null;

// ── Worker session sync helpers ────────────────────────────────────────────

const WORKER_SESSION_SYNC_TIMEOUT_MS = 5_000;
const STARTUP_WORKER_SESSION_SYNC_TIMEOUT_MS = 1_500;
const SERVER_LINK_STARTUP_GRACE_MS = 12_000;
const STARTUP_CONTEXT_REPLICATION_DELAY_MS = 90_000;
const STARTUP_TIMELINE_RETENTION_DELAY_MS = 120_000;
const STARTUP_MEMORY_PRUNING_DELAY_MS = 150_000;
const STARTUP_CONTEXT_BACKFILL_DELAY_MS = 180_000;
const STARTUP_SESSION_DB_PUSH_DELAY_MS = 210_000;
// Lowest-priority startup task: backfill persisted projection embeddings so the
// L3 semantic-recall rerank reads precomputed BLOBs instead of re-embedding on
// the hot path. Runs after everything else has settled.
const STARTUP_EMBEDDING_BACKFILL_DELAY_MS = 240_000;
const STARTUP_TRANSPORT_RESTORE_DELAY_MS = 45_000;
const STARTUP_TRANSPORT_SLOW_RESTORE_DELAY_MS = 90_000;
const TRANSPORT_SLOW_RESTORE_INTER_SESSION_DELAY_MS = 2_000;
const TRANSPORT_SLOW_RESTORE_PROVIDER_PAUSE_MS = 5_000;
const STARTUP_CONTEXT_BACKFILL_PAUSE_MS = 25;
const STARTUP_CONTEXT_BACKFILL_PAUSE_EVERY = 5;
const LOCAL_STARTUP_TRANSPORT_PROVIDER_IDS = TRANSPORT_SESSION_AGENT_TYPES.filter((providerId) => providerId !== 'openclaw');

function yieldToDaemonEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function pauseDaemonBackgroundWork(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function persistSessionToWorker(
  workerUrl: string,
  serverId: string,
  token: string,
  name: string,
  record: import('../store/session-store.js').SessionRecord,
): Promise<void> {
  if (isKnownTestSessionLike({
    name,
    projectName: record.projectName,
    projectDir: record.projectDir,
    parentSession: record.parentSession,
  })) {
    return;
  }
  try {
    const payload = buildWorkerSessionPersistBody(record);
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sessions/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`persistSessionToWorker non-ok response: ${res.status}`);
  } catch (e) {
    logger.warn({ err: e, name }, 'persistSessionToWorker: fetch failed');
    throw e;
  }
}

async function deleteSessionFromWorker(workerUrl: string, serverId: string, token: string, name: string): Promise<void> {
  try {
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
    });
    if (!res.ok) throw new Error(`deleteSessionFromWorker non-ok response: ${res.status}`);
  } catch (e) {
    logger.warn({ err: e, name }, 'deleteSessionFromWorker: fetch failed');
    throw e;
  }
}

async function deleteSubSessionFromWorker(workerUrl: string, serverId: string, token: string, id: string): Promise<void> {
  try {
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sub-sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
    });
    if (!res.ok) throw new Error(`deleteSubSessionFromWorker non-ok response: ${res.status}`);
  } catch (e) {
    logger.warn({ err: e, id }, 'deleteSubSessionFromWorker: fetch failed');
    throw e;
  }
}

async function dropLocalSession(session: SessionRecord): Promise<void> {
  const [{ stopWatching }, codexWatcher, geminiWatcher] = await Promise.all([
    import('./jsonl-watcher.js'),
    import('./codex-watcher.js'),
    import('./gemini-watcher.js'),
  ]);
  stopWatching(session.name);
  codexWatcher.stopWatching(session.name);
  geminiWatcher.stopWatching(session.name);

  const transportRuntime = getTransportRuntime(session.name);
  if (transportRuntime) {
    if (transportRuntime.providerSessionId) unregisterProviderRoute(transportRuntime.providerSessionId);
    await transportRuntime.kill().catch(() => {});
  } else {
    await killSession(session.name).catch(() => {});
  }

  removeSession(session.name);
}

interface WorkerSessionSyncOutcome extends WorkerSessionSyncRetryOutcome {
  status: WorkerSessionSyncStatus;
  retryable: boolean;
  snapshotComplete: boolean;
  remoteSessionCount?: number;
  remoteSubSessionCount?: number;
  prunedCount?: number;
  syncedCount?: number;
  pendingMissingCount?: number;
  remoteTestDeletedCount?: number;
  skippedMainPrune?: boolean;
  skippedSubSessionPrune?: boolean;
  startupPushAllowedNames?: string[];
  issues?: string[];
}

async function fetchLegacyWorkerSessionSnapshot(
  workerUrl: string,
  serverId: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<WorkerSessionSyncPlanInput | WorkerSessionSyncOutcome> {
  const [sessionRes, subRes] = await Promise.all([
    fetch(`${workerUrl}/api/server/${serverId}/sessions`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    }),
    fetch(`${workerUrl}/api/server/${serverId}/sub-sessions`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    }),
  ]);

  if (!sessionRes.ok) {
    logger.warn({ status: sessionRes.status }, 'syncSessionsFromWorker: legacy sessions fetch failed');
    return {
      ok: false,
      status: WORKER_SESSION_SYNC_STATUS.FAILED,
      retryable: true,
      snapshotComplete: false,
      reason: `sessions_http_${sessionRes.status}`,
    };
  }
  if (!subRes.ok) {
    logger.warn({ status: subRes.status }, 'syncSessionsFromWorker: legacy sub-session fetch failed');
    return {
      ok: false,
      status: WORKER_SESSION_SYNC_STATUS.FAILED,
      retryable: true,
      snapshotComplete: false,
      reason: `sub_sessions_http_${subRes.status}`,
    };
  }

  const data = await sessionRes.json() as { sessions?: unknown };
  const subData = await subRes.json() as { subSessions?: unknown };
  return {
    source: 'legacy',
    sessions: data.sessions,
    subSessions: subData.subSessions,
  };
}

interface WorkerSessionSyncOptions {
  timeoutMs?: number;
}

/** On startup/retry: pull sessions from D1 and populate the local store so restoreFromStore can rebuild runtimes. */
export async function syncSessionsFromWorker(
  workerUrl: string,
  serverId: string,
  token: string,
  options: WorkerSessionSyncOptions = {},
): Promise<WorkerSessionSyncOutcome> {
  try {
    const timeoutMs = options.timeoutMs ?? WORKER_SESSION_SYNC_TIMEOUT_MS;
    const headers = { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId };
    const snapshotRes = await fetch(`${workerUrl}/api/server/${serverId}/${WORKER_SESSION_SNAPSHOT_ROUTE_SEGMENT}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
    });

    let planInput: WorkerSessionSyncPlanInput | WorkerSessionSyncOutcome;
    if (snapshotRes.ok) {
      planInput = { source: 'snapshot', response: await snapshotRes.json() as unknown };
    } else if (snapshotRes.status === 404) {
      logger.warn({ status: snapshotRes.status }, 'syncSessionsFromWorker: snapshot endpoint unavailable; falling back to degraded legacy list sync');
      planInput = await fetchLegacyWorkerSessionSnapshot(workerUrl, serverId, headers, timeoutMs);
    } else {
      let response: unknown;
      try {
        response = await snapshotRes.json() as unknown;
      } catch {
        response = null;
      }
      if (response && typeof response === 'object' && 'complete' in response) {
        planInput = { source: 'snapshot', response };
      } else {
        logger.warn({ status: snapshotRes.status }, 'syncSessionsFromWorker: snapshot fetch failed');
        return {
          ok: false,
          status: WORKER_SESSION_SYNC_STATUS.FAILED,
          retryable: true,
          snapshotComplete: false,
          reason: `session_snapshot_http_${snapshotRes.status}`,
        };
      }
    }
    if ('status' in planInput) {
      return planInput;
    }

    const localSessions = listSessions();
    const plan = buildWorkerSessionSyncPlan(planInput, serverId, localSessions);
    if (plan.status !== WORKER_SESSION_SYNC_STATUS.APPLIED) {
      logger.warn({
        reason: plan.reason,
        issues: plan.issues,
        remoteSessionCount: plan.remoteSessionCount,
        remoteSubSessionCount: plan.remoteSubSessionCount,
      }, 'syncSessionsFromWorker: snapshot degraded; destructive sync and startup push disabled');
    }

    let count = 0;
    for (const s of plan.mainUpserts) {
      const existing = getSession(s.name);
      upsertSession(mergeWorkerSessionSnapshot(existing, s));
      count++;
    }
    let remoteTestDeletedCount = 0;
    if (plan.status === WORKER_SESSION_SYNC_STATUS.APPLIED) {
      await Promise.all([
        ...plan.remoteTestSessions.map(async (session) => {
          await deleteSessionFromWorker(workerUrl, serverId, token, session.name);
          remoteTestDeletedCount++;
        }),
        ...plan.remoteTestSubSessions.map(async (subSession) => {
          await deleteSubSessionFromWorker(workerUrl, serverId, token, subSession.id);
          remoteTestDeletedCount++;
        }),
      ]);
    }
    logger.info({
      count,
      status: plan.status,
      snapshotComplete: plan.snapshotComplete,
      pendingMissingCount: plan.pendingMissingCount,
      remoteTestDeletedCount,
    }, 'Sessions synced from worker snapshot');
    return {
      ok: plan.status === WORKER_SESSION_SYNC_STATUS.APPLIED,
      status: plan.status,
      retryable: plan.retryable,
      snapshotComplete: plan.snapshotComplete,
      reason: plan.reason,
      remoteSessionCount: plan.remoteSessionCount,
      remoteSubSessionCount: plan.remoteSubSessionCount,
      prunedCount: 0,
      syncedCount: count,
      pendingMissingCount: plan.pendingMissingCount,
      remoteTestDeletedCount,
      skippedMainPrune: plan.pendingMissingCount > 0 || plan.status !== WORKER_SESSION_SYNC_STATUS.APPLIED,
      skippedSubSessionPrune: plan.pendingMissingCount > 0 || plan.status !== WORKER_SESSION_SYNC_STATUS.APPLIED,
      startupPushAllowedNames: plan.startupPushAllowedNames,
      issues: plan.issues,
    };
  } catch (e) {
    logger.warn({ err: e }, 'syncSessionsFromWorker: fetch failed');
    return {
      ok: false,
      status: WORKER_SESSION_SYNC_STATUS.FAILED,
      retryable: true,
      snapshotComplete: false,
      reason: e instanceof Error ? e.message : 'fetch_failed',
    };
  }
}

let workerSessionSyncRetrier: WorkerSessionSyncRetrier | null = null;

function scheduleDaemonStartupBackgroundTask(label: string, task: () => Promise<void>, delayMs = 0): void {
  const timer = setTimeout(() => {
    void task().catch((err) => {
      logger.warn({ err }, `${label} failed`);
    });
  }, delayMs);
  timer.unref?.();
}

/** Write PID file so restart can reliably find the old process. */
function writePidFile(): void {
  const pidPath = path.join(os.homedir(), '.imcodes', 'daemon.pid');
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  } catch { /* best-effort */ }
}

let lockServer: net.Server | null = null;

/** Acquire a single-instance lock via Unix domain socket.
 *  If another daemon is already running, the socket is in use and we exit.
 *  The lock auto-releases when the process exits (even on crash).
 *  @param sockPath — override for testing; defaults to ~/.imcodes/daemon.sock */
export async function acquireInstanceLock(sockPath?: string): Promise<net.Server> {
  // Windows: use a named pipe instead of Unix domain socket (UDS has path length limits and AV issues)
  const p = process.platform === 'win32'
    ? '\\\\.\\pipe\\imcodes-daemon-lock'
    : (sockPath ?? path.join(os.homedir(), '.imcodes', 'daemon.sock'));

  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Socket/pipe exists — check if another daemon is actually alive
        const client = net.connect(p, () => {
          // Connection succeeded → another daemon is running
          client.destroy();
          reject(new Error(`Another imcodes daemon is already running. Use 'imcodes restart' to restart it.`));
        });
        client.on('error', () => {
          // Connection failed → stale socket from a crashed process, reclaim it
          if (process.platform !== 'win32') {
            try { fs.unlinkSync(p); } catch { /* ignore */ }
          }
          server.listen(p, () => resolve(server));
        });
      } else {
        reject(err);
      }
    });

    server.listen(p, () => resolve(server));
  });
}

/** Release a single-instance lock. */
export function releaseInstanceLock(server: net.Server, sockPath?: string): void {
  server.close();
  if (process.platform !== 'win32') {
    const p = sockPath ?? path.join(os.homedir(), '.imcodes', 'daemon.sock');
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

/** Startup sequence: config → store → memory → sessions → server link */
export async function startup(): Promise<DaemonContext> {
  logger.info({
    version: DAEMON_VERSION,
    buildSha: process.env.IMCODES_BUILD_SHA ?? process.env.GIT_COMMIT ?? process.env.SOURCE_VERSION ?? 'unknown',
    changeId: 'memory-system-1.1-foundations',
  }, 'Daemon starting');
  lockServer = await acquireInstanceLock();
  writePidFile();
  installDaemonRuntimeDiagnosticsProvider();
  // Captures an initial heap snapshot into the runtime status; subsequent
  // refreshes ride the heartbeat write (no dedicated timer / extra I/O).
  recordDaemonStart({ version: DAEMON_VERSION });

  const config = await loadConfig();
  logger.info({ config: config.daemon }, 'Config loaded');

  await loadStore();
  logger.info('Session store loaded');

  await initTempFileStore();
  logger.info('Temp file store initialized');

  // Rebuild provider routing from persisted transport sessions BEFORE any connectProvider()
  rebuildProviderRoutes();

  await initOnStartup();
  logger.info('Startup cleanup done');

  // Initialize file transfer: create upload dir + clean expired files
  await initFileTransfer();
  startCleanupTimer();
  logger.info('File transfer initialized');

  // Clean up old timeline files (>7 days) and truncate oversized ones.
  //
  // Both calls walk every JSONL file in ~/.imcodes/timeline. With a backlog
  // of 50–100 oversized sessions (~5 MB each) the synchronous pre-R3 path
  // blocked the daemon main thread for 5–20 s before `ready`. Keep this as
  // delayed background retention so the ServerLink auth/proof window gets
  // first claim on the event loop on session-heavy hosts.
  const runTimelineStartupRetention = async (): Promise<void> => {
    try {
      const start = Date.now();
      await timelineStore.cleanup();
      await timelineStore.truncateAll();
      logger.info({ elapsedMs: Date.now() - start }, 'TimelineStore: startup cleanup + truncateAll completed (background)');
    } catch (err) {
      logger.warn({ err }, 'TimelineStore: startup cleanup/truncateAll background failed');
    }
  };

  // Archive stale local memory projections (recent_summary with no hits after 30 days)
  const runStartupMemoryPruning = async (): Promise<void> => {
    await yieldToDaemonEventLoop();
    // `pruneLocalMemory` already routes through the worker (in-process fallback
    // when cold), so call it directly — no second client hop needed.
    await pruneLocalMemory();
  };

  const runStartupEmbeddingBackfill = async (): Promise<void> => {
    await yieldToDaemonEventLoop();
    // One-time, low-priority, bounded backfill. Best-effort: the function never
    // throws and quietly no-ops when the embedding model is unavailable.
    const result = await backfillProjectionEmbeddings();
    if (result.filled > 0 || result.remaining > 0) {
      logger.info(result, 'projection embedding backfill completed (background)');
    }
  };

  const creds = await loadCredentials();

  // No fallback: a valid serverId is required for the WS endpoint (/api/server/:id/ws)
  // and for the auth handshake. Without stored credentials from `imcodes bind`, we
  // cannot connect to the CF Worker.
  const workerUrl = creds?.workerUrl;
  const serverId = creds?.serverId ?? '';
  const token = creds?.token ?? '';
  configureSharedContextRuntime(creds ? { workerUrl: workerUrl!, serverId, token } : null);
  // Warm the context-store worker at boot so front-of-turn recall + store access
  // run off the daemon main thread. Skipped under test (the in-process path is
  // used there, matching the embedding engine's test behavior); recall callers
  // fall back to in-process automatically until the worker reports ready.
  if (!(process.env.VITEST || process.env.NODE_ENV === 'test')) {
    getContextStoreClient().start();
    // The worker is now the single long-lived DB owner — let it (not the
    // main-thread connection) run the archive-backfill timer.
    setArchiveBackfillSchedulingEnabled(false);
  }
  if (creds) {
    try {
      const runtimeConfig = await fetchBackendSharedContextRuntimeConfig({ workerUrl: workerUrl!, serverId, token });
      setContextModelRuntimeConfig(runtimeConfig);
    } catch (err) {
      logger.warn({ err, serverId }, 'shared-context runtime config bootstrap failed');
    }
    // Prime the supervisor global-defaults cache so the very first
    // supervision dispatch after startup uses the current custom
    // instructions even if no session's cached snapshot carries them.
    // Fire-and-forget: failure just means the daemon falls through to
    // the snapshot mirror. The WS-reconnect hook below keeps it fresh.
    void (async () => {
      try {
        const { refreshSupervisorDefaultsCache } = await import('./supervisor-defaults-cache.js');
        await refreshSupervisorDefaultsCache();
      } catch (err) {
        logger.debug({ err }, 'supervisor-defaults-cache: startup prime failed');
      }
    })();
  }

  // Sync sessions from D1 before restoring tmux sessions. A transient
  // DNS/server failure here must not be lifecycle-fatal, but it must also
  // not be one-shot: the retry loop below will keep pulling until a healthy
  // snapshot is applied and then reconcile runtimes.
  let startupWorkerSessionSyncOutcome: WorkerSessionSyncOutcome | null = null;
  if (creds) {
    startupWorkerSessionSyncOutcome = await syncSessionsFromWorker(workerUrl!, serverId, token, {
      timeoutMs: STARTUP_WORKER_SESSION_SYNC_TIMEOUT_MS,
    });
  }

  try {
    await restoreFromStore();
    logger.info('Sessions reconciled');
  } catch (err) {
    // restoreFromStore must NEVER crash the daemon — log and continue.
    // Sessions may not be restored, but daemon stays alive for WS/heartbeat.
    logger.error({ err }, 'restoreFromStore failed — daemon continues without session restore');
  }

  // Initialize the command.ack outbox before serverLink connects so any
  // pending acks from a previous process life get flushed on first open.
  try {
    await getDefaultAckOutbox().init();
    logger.info('AckOutbox ready');
  } catch (err) {
    logger.error({ err }, 'AckOutbox init failed — daemon continues (acks will be best-effort)');
  }

  // Do not warm the transformers.js embedding model during daemon startup.
  // On session-heavy hosts the native model load can occupy the Node main
  // thread long enough for ServerLink heartbeat/proof windows to go silent.
  // Semantic recall already lazy-loads the model on first use and falls back
  // safely if the model is unavailable.

  const skillReviewWorker = new LocalSkillReviewWorker();
  const liveContextIngestion = new LiveContextIngestion({
    sessionLookup: getSession,
    skillReviewScheduler: skillReviewWorker,
    shouldIngestTimelineEvent: (event, session) => !isP2pParticipantMemoryNoise(event, session, listP2pRuns()),
    resolveBootstrap: (session) => {
      const latest = getSession(session.name) ?? session;
      if (latest.contextNamespace) {
        return Promise.resolve({
          namespace: latest.contextNamespace,
          diagnostics: latest.contextNamespaceDiagnostics ?? ['namespace:persisted-session'],
          ...(latest.contextRemoteProcessedFreshness ? { remoteProcessedFreshness: latest.contextRemoteProcessedFreshness } : {}),
          ...(latest.contextLocalProcessedFreshness ? { localProcessedFreshness: latest.contextLocalProcessedFreshness } : {}),
          ...(latest.contextRetryExhausted !== undefined ? { retryExhausted: latest.contextRetryExhausted } : {}),
          ...(latest.contextSharedPolicyOverride ? { sharedPolicyOverride: latest.contextSharedPolicyOverride } : {}),
        });
      }
      return resolveTransportContextBootstrap({
        projectDir: latest.projectDir,
        transportConfig: latest.transportConfig ?? {},
        startupMemoryAlreadyInjected: true,
      });
    },
    onError: (err, event) => {
      logger.warn({ err, session: event.sessionId, type: event.type }, 'Live context ingestion failed');
    },
  });

  let serverLink: ServerLink | null = null;
  let scheduleServerLinkRestoreBroadcast: (() => void) | null = null;
  if (creds) {
    serverLink = new ServerLink({ workerUrl: workerUrl!, serverId, token });
    serverLink.onMessage((msg) => {
      handleWebCommand(msg, serverLink!);
    });
    serverLink.onBinaryMessage((data) => {
      handlePreviewBinaryFrame(data, serverLink!);
    });

    // Expose to the global error handlers in src/index.ts so uncaught
    // exceptions can be surfaced to browsers via daemon.error broadcasts.
    (globalThis as typeof globalThis & {
      __imcodesGlobalServerLink?: ServerLink;
    }).__imcodesGlobalServerLink = serverLink;

    // Broadcast cached repo detections after connect so browsers that missed
    // the initial repo.detected push (e.g. connected late, reconnected) get the data.
    scheduleServerLinkRestoreBroadcast = () => {
      const timer = setTimeout(() => {
        if (!serverLink) return;
        for (const session of listSessions()) {
          const dir = session.projectDir;
          if (!dir) continue;
          const cacheKey = RepoCache.buildKey(dir, 'detect');
          const cached = repoCache.get(cacheKey);
          if (cached) {
            try { serverLink.send({ type: 'repo.detected', projectDir: dir, context: cached }); } catch { /* ignore */ }
          }
        }
        // Re-broadcast active P2P runs so browsers get state after reconnect
        for (const run of listP2pRuns()) {
          if (P2P_TERMINAL_RUN_STATUSES.has(run.status)) continue;
          try { serverLink.send({ type: 'p2p.run_save', run: serializeP2pRun(run) }); } catch { /* ignore */ }
        }
        // Re-sync all sub-sessions (including idle ones) so server DB and
        // frontend stay in sync. The previous `state === 'running'` filter
        // left idle sub-sessions with `state: 'unknown'` in the web sidebar
        // after WS reconnect, which rendered as a stuck gray dot that only
        // flipped to the correct color when the next live state transition
        // happened — sometimes never, for genuinely-quiet sessions.
        // Only skip terminal states that should have been cleaned up already.
        for (const session of listSessions()) {
          if (!session.name.startsWith('deck_sub_')) continue;
          if (session.state === 'stopped') continue;
          const sessionType = typeof session.agentType === 'string' && session.agentType ? session.agentType : null;
          if (!sessionType) {
            logger.warn({ sessionName: session.name }, 'Skipping subsession.sync during lifecycle restore without agentType');
            continue;
          }
          const id = session.name.slice('deck_sub_'.length);
          const transportRuntime = getTransportRuntime(session.name);
          try {
            serverLink.send({
              type: 'subsession.sync',
              id,
              // Including state here fixes "sidebar sub-session dot stuck
              // gray after reconnect" — see buildSubSessionSync for the
              // equivalent fix on the regular sync path.
              state: session.state ?? null,
              sessionType,
              cwd: session.projectDir || null,
              label: session.label ?? null,
              ccSessionId: session.ccSessionId ?? null,
              geminiSessionId: session.geminiSessionId ?? null,
              parentSession: session.parentSession ?? null,
              ccPresetId: session.ccPreset ?? null,
              description: session.description ?? null,
              runtimeType: session.runtimeType ?? null,
              providerId: session.providerId ?? null,
              providerSessionId: session.providerSessionId ?? null,
              qwenModel: session.qwenModel ?? null,
              qwenAuthType: session.qwenAuthType ?? null,
              qwenAvailableModels: session.qwenAvailableModels ?? null,
              codexAvailableModels: session.codexAvailableModels ?? null,
              requestedModel: session.requestedModel ?? null,
              activeModel: session.activeModel ?? session.modelDisplay ?? null,
              modelDisplay: session.modelDisplay ?? null,
              planLabel: session.planLabel ?? null,
              quotaLabel: session.quotaLabel ?? null,
              quotaUsageLabel: session.quotaUsageLabel ?? null,
              quotaMeta: session.quotaMeta ?? null,
              effort: session.effort ?? null,
              transportConfig: session.transportConfig ?? null,
              ...(transportRuntime ? buildTransportQueueSnapshotPayload(session.name, 'lifecycle') : {}),
            });
          } catch { /* ignore */ }
        }
      }, 3_000); // delay to ensure WS auth handshake completes first
      timer.unref?.();
    };
  }

  // Wire session events → ServerLink so the browser sees them
  setSessionEventCallback((event, session, state) => {
    if (!serverLink) return;
    try { serverLink.send({ type: 'session_event', event, session, state }); } catch { /* not connected */ }
    void buildSessionList().then((sessions) => {
      try {
        serverLink.send({
          type: 'session_list',
          daemonVersion: serverLink.daemonVersion,
          sessions,
        });
      } catch { /* not connected */ }
    });

    // Background repo detection on session start
    if (event === 'started') {
      const record = getSession(session);
      const projectDir = record?.projectDir;
      if (projectDir) {
        const cacheKey = RepoCache.buildKey(projectDir, 'detect');
        const cached = repoCache.get(cacheKey);
        if (!cached) {
          detectRepo(projectDir)
            .then((context) => {
              repoCache.set(cacheKey, context, projectDir, context.status !== 'ok');
              try { serverLink!.send({ type: 'repo.detected', projectDir, context }); } catch { /* not connected */ }
              logger.debug({ projectDir, status: context.status }, 'Background repo detection complete');
            })
            .catch((err) => {
              logger.warn({ err, projectDir }, 'Background repo detection failed');
            });
        }
      }
    }
  });

  // Wire timeline idle events → P2P orchestrator + queued message drain (covers all agent types: CC, codex, gemini, etc.)
  timelineEmitter.on((e) => {
    liveContextIngestion.handleTimelineEvent(e);
    if (e.type === 'session.state' && (e.payload as Record<string, unknown>).state === 'idle') {
      notifySessionIdle(e.sessionId);
      void drainQueue(e.sessionId);
    }
  });

  const backfillLiveContextFromTimeline = async (): Promise<void> => {
    const startedAt = Date.now();
    let sessionsSeen = 0;
    let sessionsBackfilled = 0;
    for (const session of listSessions()) {
      sessionsSeen += 1;
      if (sessionsSeen > 1) await yieldToDaemonEventLoop();
      // SQLite projection is the sole chat-history read source — no JSONL
      // `read()` fallback. That synchronous main-thread read was an event-loop
      // saturation amplifier under load (and JSONL is now write/backup-only).
      // Startup backfill is best-effort: if the projection is briefly
      // unavailable for a session, skip it — live ingestion plus the
      // self-healing projection worker will catch it up.
      let history: Awaited<ReturnType<typeof timelineStore.readPreferred>> = [];
      try {
        history = await timelineStore.readPreferred(session.name, { limit: 100 });
      } catch (err) {
        logger.warn({ err, session: session.name }, 'Startup backfill: projection read failed; skipping session (no JSONL fallback)');
        continue;
      }
      if (history.length === 0) continue;
      sessionsBackfilled += 1;
      try {
        await liveContextIngestion.backfillSessionFromEvents(session.name, history);
      } catch (err) {
        logger.warn({ err, session: session.name }, 'Shared-context timeline backfill failed');
      }
      if (sessionsBackfilled % STARTUP_CONTEXT_BACKFILL_PAUSE_EVERY === 0) {
        await pauseDaemonBackgroundWork(STARTUP_CONTEXT_BACKFILL_PAUSE_MS);
      } else {
        await yieldToDaemonEventLoop();
      }
    }
    logger.info(
      { sessionsSeen, sessionsBackfilled, elapsedMs: Date.now() - startedAt },
      'Shared-context startup timeline backfill completed (background)',
    );
  };
  let pushLocalSessionsToWorkerOnStartup: (() => Promise<void>) | null = null;

  // Wire session persist → D1 via Worker API
  if (creds) {
    setSessionPersistCallback(async (record, name) => {
      if (record) {
        await persistSessionToWorker(workerUrl!, serverId, token, name, record);
      } else {
        await deleteSessionFromWorker(workerUrl!, serverId, token, name);
      }
    });

    // Push all active sessions from local store to DB on startup.
    // Covers the case where DB was cleared while the daemon was running
    // (or route was misconfigured and persists silently failed).
    //
    // F1 fix (audit cae1de69-826) — per-entry try/catch + warn-continue.
    // Previously the loop ran `await persistSessionToWorker(...)` with no
    // try/catch; after the session-group-clone PR (cf7d8196) made
    // `persistSessionToWorker` throw on non-2xx / fetch failure, ANY
    // single push failure (server 5xx, network blip, DB conflict) would
    // abort the entire bootstrap function BEFORE `autoReconnectProviders`
    // (~200 lines later) had a chance to run. The end result was a
    // "half-started zombie" daemon with the WS up but no transport
    // runtimes restored, which directly produced the "bot stays asleep,
    // no SDK output" symptom reported by the user.
    //
    // Worker DB sync is a remote-visibility concern, not a local-runtime
    // dependency. It must NEVER block transport runtime recovery.
    pushLocalSessionsToWorkerOnStartup = async (): Promise<void> => {
      const localSessions = listSessions();
      const persistableSessions = localSessions.filter(shouldPersistMainSessionToWorkerOnStartup);
      const syncOutcome = startupWorkerSessionSyncOutcome;
      if (!syncOutcome || syncOutcome.status !== WORKER_SESSION_SYNC_STATUS.APPLIED) {
        if (persistableSessions.length > 0) {
          logger.warn({
            count: persistableSessions.length,
            syncStatus: syncOutcome?.status,
            reason: syncOutcome?.reason,
          }, 'startup: suppressing local main session DB push until worker snapshot is trusted');
        }
        return;
      }
      const allowedNames = new Set(syncOutcome.startupPushAllowedNames ?? []);
      const pushableSessions = persistableSessions.filter((session) => allowedNames.has(session.name));
      const suppressedCount = persistableSessions.length - pushableSessions.length;
      let pushFailures = 0;
      for (const [index, s] of pushableSessions.entries()) {
        if (index > 0) await yieldToDaemonEventLoop();
        try {
          await persistSessionToWorker(workerUrl!, serverId, token, s.name, s);
        } catch (err) {
          pushFailures += 1;
          logger.warn(
            { err, session: s.name },
            'startup: persistSessionToWorker failed (continuing daemon bootstrap)',
          );
        }
      }
      if (persistableSessions.length > 0) {
        logger.info(
          {
            count: pushableSessions.length,
            skipped: localSessions.length - persistableSessions.length,
            suppressed: suppressedCount,
            failures: pushFailures,
          },
          'Pushed trusted local main sessions to server DB on startup (background)',
        );
      }
    };
    scheduleDaemonStartupBackgroundTask(
      'initial processed-context replication',
      async () => {
        await replicatePendingProcessedContext({ workerUrl: workerUrl!, serverId, token });
      },
      STARTUP_CONTEXT_REPLICATION_DELAY_MS,
    );
  }

  async function persistBinding(platform: string, channelId: string, botId: string, bindingType: string, target: string): Promise<boolean> {
    if (!workerUrl || !serverId || !token) return false;
    try {
      const res = await fetch(`${workerUrl}/api/server/${serverId}/bindings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ platform, channelId, botId, bindingType, target }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, platform, channelId }, 'persistBinding: worker returned error');
        return false;
      }
      return true;
    } catch (e) {
      logger.warn({ err: e, platform, channelId }, 'persistBinding: fetch failed');
      return false;
    }
  }

  async function removeBinding(platform: string, channelId: string, botId: string): Promise<boolean> {
    if (!workerUrl || !serverId || !token) return false;
    try {
      const res = await fetch(`${workerUrl}/api/server/${serverId}/bindings`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ platform, channelId, botId }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status, platform, channelId }, 'removeBinding: worker returned error');
        return false;
      }
      return true;
    } catch (e) {
      logger.warn({ err: e, platform, channelId }, 'removeBinding: fetch failed');
      return false;
    }
  }

  function sendSessionEvent(event: 'started' | 'stopped' | 'error', session: string, state: string): void {
    if (!serverLink) return;
    try {
      serverLink.send({ type: 'session_event', event, session, state });
    } catch (e) {
      logger.warn({ err: e, event, session }, 'Failed to send session event');
    }
  }

  // Forward all timeline events to connected browsers via ServerLink.
  // Dedup by eventId so history replays (daemon restart, JSONL rotation) don't
  // re-send events that browsers already received.
  if (serverLink) {
    const sentEventIds = new Set<string>();
    const DEDUP_MAX = 2000;

    timelineEmitter.on((event) => {
      // Transport streaming events reuse the same eventId for in-place replacement
      // (typewriter effect). Don't dedup them — every delta AND the final event
      // must reach the browser. The `transport:` prefix identifies these events.
      const isTransportStream = event.eventId?.startsWith('transport:') ?? false;
      if (event.eventId && sentEventIds.has(event.eventId) && !isTransportStream) return;
      if (event.eventId) {
        sentEventIds.add(event.eventId);
        if (sentEventIds.size > DEDUP_MAX) {
          // Evict oldest entries (Sets iterate in insertion order)
          const it = sentEventIds.values();
          for (let i = 0; i < DEDUP_MAX / 2; i++) it.next();
          const keep = new Set<string>();
          for (const v of it) keep.add(v);
          sentEventIds.clear();
          for (const v of keep) sentEventIds.add(v);
        }
      }
      // For session.state idle, attach lastText so push notifications have context
      // Skip shell/script — they are always idle, no useful notification
      if (event.type === 'session.state' && (event.payload as Record<string, unknown>).state === 'idle') {
        const rec = listSessions().find((s) => s.name === event.sessionId);
        if (rec?.agentType === 'shell' || rec?.agentType === 'script') return;
        void getLastAssistantText(event.sessionId).then((lastText) => {
          serverLink!.send({ type: 'timeline.event', event, ...(lastText ? { lastText } : {}) });
        }).catch(() => {
          serverLink!.send({ type: 'timeline.event', event });
        });
      } else {
        serverLink!.sendTimelineEvent(event);
      }
    });
  }

  // Set up router context so inbound chat messages can be dispatched to routeMessage
  if (serverLink) {
    setRouterContext({
      sendOutbound: async (channelId, platform, botId, content) => {
        if (!workerUrl || !token) {
          logger.warn({ platform, channelId }, 'sendOutbound: no worker credentials');
          return;
        }
        try {
          const res = await fetch(`${workerUrl}/api/outbound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ platform, botId, channelId, content }),
          });
          if (!res.ok) {
            logger.warn({ status: res.status, platform, channelId }, 'sendOutbound: worker returned error');
          }
        } catch (e) {
          logger.warn({ err: e, platform, channelId }, 'sendOutbound failed');
        }
      },
      sendToSession: async (sessionName, text) => {
        const record = (await import('../store/session-store.js')).getSession(sessionName);
        const cwd = record?.agentType === 'gemini' ? record?.projectDir : undefined;
        await sendKeys(sessionName, text, cwd ? { cwd } : undefined);
      },
      persistBinding,
      removeBinding,
    });
  }

  // Start local hook server — agents POST here via CC hooks / notify plugins.
  // Port is auto-discovered (saved across restarts); hook scripts are rewritten with actual port.
  const hookResult = await startHookServer((payload) => {
    if (!serverLink) return;
    try {
      const sessions = listSessions();
      const record = sessions.find((s) => s.name === payload.session);
      const display = resolvePushDisplayContext(payload.session, sessions);
      if (payload.event === 'idle') {
        // Shell/script sessions are always "idle" — skip to avoid noise
        if (record?.agentType === 'shell' || record?.agentType === 'script') return;
        // notifySessionIdle is handled by the unified timeline listener below
        // Include last assistant text for push notification context
        void getLastAssistantText(payload.session).then((lastText) => {
          serverLink.send({
            type: 'session.idle',
            session: payload.session,
            project: display.project,
            agentType: payload.agentType,
            ...(lastText ? { lastText } : {}),
            ...(display.label ? { label: display.label } : {}),
            ...(display.parentLabel ? { parentLabel: display.parentLabel } : {}),
          });
        }).catch(() => {
          serverLink.send({
            type: 'session.idle',
            session: payload.session,
            project: display.project,
            agentType: payload.agentType,
            ...(display.label ? { label: display.label } : {}),
            ...(display.parentLabel ? { parentLabel: display.parentLabel } : {}),
          });
        });
      } else if (payload.event === 'notification') {
        serverLink.send({
          type: 'session.notification',
          session: payload.session,
          project: display.project,
          agentType: record?.agentType ?? '',
          title: payload.title,
          message: payload.message,
          ...(display.label ? { label: display.label } : {}),
          ...(display.parentLabel ? { parentLabel: display.parentLabel } : {}),
        });
      } else if (payload.event === 'tool_start') {
        serverLink.send({ type: 'session.tool', session: payload.session, tool: payload.tool });
      } else if (payload.event === 'tool_end') {
        serverLink.send({ type: 'session.tool', session: payload.session, tool: null });
      }
    } catch { /* not connected */ }
  });
  hookServer = hookResult.server;
  // Rewrite all CC hook scripts with the actual port (may differ from last run)
  await setupCCHooks().catch((e) => logger.warn({ err: e }, 'CC hook setup failed'));

  supervisionAutomation.init();
  supervisionAutomation.setServerLink(serverLink);

  ctx = { config, serverLink, persistBinding, removeBinding, sendSessionEvent };
  setupSignalHandlers();
  startHealthPoller();
  startCodexQuotaPoller(serverLink);
  startContextReplicationPoller(workerUrl, serverId, token);
  startContextMaterializationPoller(liveContextIngestion);
  startGcPoller();
  startEventLoopDelayMonitor();
  startLatencyTracer();

  logger.info('Daemon started');

  if (serverLink) {
    serverLink.connect();
    scheduleServerLinkRestoreBroadcast?.();
  }

  const startupBackgroundBaseDelayMs = creds ? SERVER_LINK_STARTUP_GRACE_MS : 0;
  scheduleDaemonStartupBackgroundTask(
    'timeline retention startup cleanup',
    runTimelineStartupRetention,
    startupBackgroundBaseDelayMs + STARTUP_TIMELINE_RETENTION_DELAY_MS,
  );
  scheduleDaemonStartupBackgroundTask(
    'startup local memory pruning',
    runStartupMemoryPruning,
    startupBackgroundBaseDelayMs + STARTUP_MEMORY_PRUNING_DELAY_MS,
  );
  scheduleDaemonStartupBackgroundTask(
    'transport provider auto-reconnect',
    autoReconnectProviders,
    startupBackgroundBaseDelayMs + STARTUP_TRANSPORT_RESTORE_DELAY_MS,
  );
  scheduleDaemonStartupBackgroundTask(
    'transport runtime slow warm restore',
    slowWarmRestoreTransportProviders,
    startupBackgroundBaseDelayMs + STARTUP_TRANSPORT_SLOW_RESTORE_DELAY_MS,
  );
  if (creds && startupWorkerSessionSyncOutcome && startupWorkerSessionSyncOutcome.retryable) {
    workerSessionSyncRetrier?.stop();
    workerSessionSyncRetrier = createWorkerSessionSyncRetrier({
      sync: () => syncSessionsFromWorker(workerUrl!, serverId, token),
      onRecovered: (outcome) => {
        startupWorkerSessionSyncOutcome = outcome;
        return reconcileRuntimesAfterWorkerSessionSync(serverLink, outcome);
      },
      logger,
    });
    workerSessionSyncRetrier.start(startupWorkerSessionSyncOutcome.reason ?? 'startup_sync_failed');
  }
  scheduleDaemonStartupBackgroundTask(
    'shared-context startup timeline backfill',
    backfillLiveContextFromTimeline,
    startupBackgroundBaseDelayMs + STARTUP_CONTEXT_BACKFILL_DELAY_MS,
  );
  if (pushLocalSessionsToWorkerOnStartup) {
    scheduleDaemonStartupBackgroundTask(
      'startup local main session DB push',
      pushLocalSessionsToWorkerOnStartup,
      startupBackgroundBaseDelayMs + STARTUP_SESSION_DB_PUSH_DELAY_MS,
    );
  }
  scheduleDaemonStartupBackgroundTask(
    'startup projection embedding backfill',
    runStartupEmbeddingBackfill,
    startupBackgroundBaseDelayMs + STARTUP_EMBEDDING_BACKFILL_DELAY_MS,
  );

  return ctx;
}

async function reconcileRuntimesAfterWorkerSessionSync(
  serverLink: ServerLink | null,
  outcome: WorkerSessionSyncOutcome,
): Promise<void> {
  logger.info({
    status: outcome.status,
    snapshotComplete: outcome.snapshotComplete,
    retryable: outcome.retryable,
    remoteSessionCount: outcome.remoteSessionCount,
    remoteSubSessionCount: outcome.remoteSubSessionCount,
    syncedCount: outcome.syncedCount,
    prunedCount: outcome.prunedCount,
    pendingMissingCount: outcome.pendingMissingCount,
    remoteTestDeletedCount: outcome.remoteTestDeletedCount,
    skippedMainPrune: outcome.skippedMainPrune,
    skippedSubSessionPrune: outcome.skippedSubSessionPrune,
  }, 'Worker session sync retry succeeded; reconciling local runtimes');

  rebuildProviderRoutes();
  await restoreFromStore();
  await autoReconnectProviders();

  if (serverLink) {
    try {
      const sessions = await buildSessionList();
      serverLink.send({
        type: 'session_list',
        daemonVersion: serverLink.daemonVersion,
        sessions,
      });
    } catch (err) {
      logger.warn({ err }, 'Worker session sync recovery session_list broadcast failed');
    }
  }
}

function hasRestorableLocalTransportSessions(
  providerId: string,
  options: { onlyWithPendingResend?: boolean; onlyMissingRuntime?: boolean } = {},
): boolean {
  return listSessions().some((s) => {
    const effectiveProviderId = s.providerId ?? s.agentType;
    if (!(s.runtimeType === 'transport' || isTransportAgent(s.agentType))) return false;
    if (effectiveProviderId !== providerId) return false;
    if (!s.providerSessionId) return false;
    if (options.onlyWithPendingResend && getResendCount(s.name) === 0) return false;
    if (options.onlyMissingRuntime && getTransportRuntime(s.name)?.providerSessionId) return false;
    return true;
  });
}

let slowTransportWarmRestoreInFlight: Promise<void> | null = null;

async function slowWarmRestoreTransportProviders(): Promise<void> {
  if (slowTransportWarmRestoreInFlight) return slowTransportWarmRestoreInFlight;
  const task = (async () => {
    const { ensureProviderConnected } = await import('../agent/provider-registry.js');
    const { restoreTransportSessions } = await import('../agent/session-manager.js');
    let restoredProviderCount = 0;

    for (const providerId of LOCAL_STARTUP_TRANSPORT_PROVIDER_IDS) {
      if (!hasRestorableLocalTransportSessions(providerId, { onlyMissingRuntime: true })) continue;
      if (restoredProviderCount > 0) {
        await pauseDaemonBackgroundWork(TRANSPORT_SLOW_RESTORE_PROVIDER_PAUSE_MS);
      }
      try {
        restoredProviderCount += 1;
        logger.info({ providerId }, 'Starting delayed transport runtime warm restore');
        await ensureProviderConnected(providerId, {});
        await restoreTransportSessions(providerId, {
          concurrency: 1,
          interSessionDelayMs: TRANSPORT_SLOW_RESTORE_INTER_SESSION_DELAY_MS,
        });
      } catch (err) {
        logger.warn({ err, providerId }, 'Delayed transport runtime warm restore failed');
      }
    }
  })();
  slowTransportWarmRestoreInFlight = task;
  try {
    await task;
  } finally {
    if (slowTransportWarmRestoreInFlight === task) slowTransportWarmRestoreInFlight = null;
  }
}

async function autoReconnectProviders(): Promise<void> {
  try {
    // Dynamic import to avoid loading WS deps when not needed
    const { loadConfig: loadOcConfig } = await import('../agent/openclaw-config.js');
    const { connectProvider, ensureProviderConnected } = await import('../agent/provider-registry.js');
    const { restoreTransportSessions } = await import('../agent/session-manager.js');

    let restoredProviderCount = 0;
    for (const providerId of LOCAL_STARTUP_TRANSPORT_PROVIDER_IDS) {
      if (!hasRestorableLocalTransportSessions(providerId, { onlyWithPendingResend: true })) continue;
      if (restoredProviderCount > 0) await yieldToDaemonEventLoop();
      try {
        restoredProviderCount += 1;
        await ensureProviderConnected(providerId, {});
        await restoreTransportSessions(providerId, { onlyWithPendingResend: true });
      } catch (err) {
        logger.warn({ err, providerId }, 'Local transport provider auto-connect failed');
      }
    }

    const ocConfig = await loadOcConfig();
    if (ocConfig) {
      // Retry forever with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s cap
      let delay = 1_000;
      let attempt = 0;
      while (true) {
        attempt++;
        logger.info({ url: ocConfig.url, attempt, nextDelayMs: delay }, 'Auto-reconnecting to OpenClaw gateway...');
        try {
          await connectProvider('openclaw', {
            url: ocConfig.url,
            token: ocConfig.token,
            agentId: ocConfig.agentId,
          });
          logger.info('OpenClaw gateway reconnected');
          try {
            await restoreTransportSessions('openclaw', { onlyWithPendingResend: true });
          } catch (e) {
            logger.warn({ err: e }, 'Failed to restore transport sessions after provider connect');
          }
          return; // success
        } catch (err) {
          logger.warn({ err, attempt }, 'OpenClaw auto-reconnect failed — retrying');
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, 30_000);
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Provider auto-reconnect check failed');
  }
}

/** Shutdown sequence: flush store, disconnect WS, release lock, exit cleanly */
export async function shutdown(exitCode = 0): Promise<void> {
  logger.info('Daemon shutting down');

  // Kill all ConPTY sessions (they don't survive daemon exit like tmux)
  if ((BACKEND as string) === 'conpty') {
    try {
      const conpty = await import('../agent/conpty.js');
      const names: string[] = conpty.conptyListSessions();
      for (const name of names) {
        try {
          conpty.conptyKillSession(name);
        } catch (e) {
          logger.warn({ err: e, session: name }, 'Failed to kill ConPTY session during shutdown');
        }
      }
    } catch { /* conpty not available */ }
  }

  try {
    const { terminalStreamer } = await import('./terminal-streamer.js');
    await terminalStreamer.destroyAsync();
  } catch (err) {
    logger.warn({ err }, 'Daemon shutdown terminal streamer drain failed');
  }

  try {
    const { stopAcceptingMasterCompactions, drainMasterCompactions } = await import('./master-compaction-registry.js');
    const { awaitCompressionIdle, stopAcceptingCompression } = await import('../context/summary-compressor.js');
    if (contextMaterializationTimer) {
      clearInterval(contextMaterializationTimer);
      contextMaterializationTimer = null;
    }
    closeLiveContextMaterializationAdmission('shutdown');
    stopAcceptingCompression('shutdown');
    stopAcceptingMasterCompactions('shutdown');
    const masterDrain = await drainMasterCompactions(5_000);
    if (masterDrain.registeredDuringDrain > 0) {
      logger.error(masterDrain, 'Daemon shutdown observed master compactions registered during drain');
    }
    if (masterDrain.remainingFromSnapshot > 0) {
      logger.warn(masterDrain, 'Daemon shutdown continuing with master compactions still in flight');
    } else if (masterDrain.drained > 0) {
      logger.info(masterDrain, 'Daemon shutdown drained master compactions');
    }
    const compressionDrain = await awaitCompressionIdle(5_000);
    if (!compressionDrain.state.idle) {
      logger.warn(compressionDrain.state, 'Daemon shutdown continuing with compression queue still active');
    }
  } catch (err) {
    logger.warn({ err }, 'Daemon shutdown memory drain failed');
  }

  // Flush the async timeline pipeline before terminating the projection
  // worker. `flushAll` waits for per-session JSONL append chains; `drain`
  // then waits for SQLite mirror writes to settle. Both are bounded so a
  // hung disk cannot block shutdown indefinitely (matches the
  // `drainMasterCompactions(5_000)` style above).
  try {
    const { timelineProjection } = await import('./timeline-projection.js');
    const timelineFlushStart = Date.now();
    await timelineStore.flushAll(5_000);
    await timelineProjection.drain(2_000);
    logger.info({
      elapsedMs: Date.now() - timelineFlushStart,
      pendingSessions: timelineStore.getPendingSessionCount(),
      pendingProjection: timelineProjection.getPendingCount(),
    }, 'Daemon shutdown: timeline pipeline drained');
  } catch (err) {
    logger.warn({ err }, 'Daemon shutdown timeline drain failed');
  }

  try {
    const { disconnectAll } = await import('../agent/provider-registry.js');
    await disconnectAll();
  } catch { /* ignore */ }

  try {
    const { shutdownDefaultPreviewReadCoordinatorForDaemon } = await import('./file-preview-read-coordinator.js');
    await shutdownDefaultPreviewReadCoordinatorForDaemon();
  } catch (err) {
    logger.warn({ errorKind: err instanceof Error ? err.name : typeof err }, 'Daemon shutdown preview read drain failed');
  }

  try {
    const { shutdownDefaultTimelineHistoryWorkerPoolForDaemon } = await import('./timeline-history-pool.js');
    await shutdownDefaultTimelineHistoryWorkerPoolForDaemon();
  } catch (err) {
    logger.warn({ errorKind: err instanceof Error ? err.name : typeof err }, 'Daemon shutdown timeline history worker drain failed');
  }

  try {
    const { shutdownDefaultFsListWorkerPoolForDaemon } = await import('./fs-list-pool.js');
    await shutdownDefaultFsListWorkerPoolForDaemon();
  } catch (err) {
    logger.warn({ errorKind: err instanceof Error ? err.name : typeof err }, 'Daemon shutdown fs list worker drain failed');
  }

  try {
    const { shutdownDefaultFsGitStatusWorkerPoolForDaemon } = await import('./fs-git-status-pool.js');
    await shutdownDefaultFsGitStatusWorkerPoolForDaemon();
  } catch (err) {
    logger.warn({ errorKind: err instanceof Error ? err.name : typeof err }, 'Daemon shutdown fs git status worker drain failed');
  }

  try {
    if (healthTimer) clearInterval(healthTimer);
    if (codexQuotaTimer) clearInterval(codexQuotaTimer);
    if (contextReplicationTimer) clearInterval(contextReplicationTimer);
    if (contextMaterializationTimer) clearInterval(contextMaterializationTimer);
    if (gcTimer) clearInterval(gcTimer);
    if (eventLoopDelayTimer) clearInterval(eventLoopDelayTimer);
    workerSessionSyncRetrier?.stop();
    workerSessionSyncRetrier = null;
    hookServer?.close();
    ctx?.serverLink?.disconnect();
    configureSharedContextRuntime(null);
    await flushStore();
    logger.info('Store flushed');
  } catch (e) {
    logger.error({ err: e }, 'Error during shutdown');
  }

  if (lockServer) releaseInstanceLock(lockServer);

  if ((BACKEND as string) === 'conpty') {
    logger.info('Daemon stopped (ConPTY sessions killed)');
  } else {
    // tmux/wezterm sessions are intentionally NOT killed — they keep running
    logger.info('Daemon stopped (tmux sessions left running)');
  }
  process.exit(exitCode);
}

const HEALTH_POLL_MS = 30_000;
// Last-resort recovery for a transport turn that has gone silent (no provider
// output) long enough to look like a stuck PHANTOM. This must stay above normal
// long-thinking latency, but not so high that a memory-compression/app-server
// finalize miss leaves the UI "working" for a whole operator session. Active
// tool calls still use the runtime's longer tool-aware floor.
const TRANSPORT_STALE_ACTIVE_TURN_RECOVERY_MS = 5 * 60_000;
const MEMORY_COMPRESSION_AUTO_CONTINUE_AFTER_MS = 6 * 60_000;
const CODEX_STALE_ACTIVE_TURN_AUTO_CONTINUE_AFTER_MS = 12 * 60_000;
const CODEX_QUOTA_REFRESH_MS = 60_000;
const CONTEXT_REPLICATION_POLL_MS = 30_000;
const CONTEXT_MATERIALIZATION_POLL_MS = 15_000;
/** Periodic V8 major-GC trigger (5 min by default; tuneable via env).
 *  See `startGcPoller()` for the rationale.
 */
const GC_POLL_MS = parseInt(process.env.IMCODES_GC_POLL_MS ?? '300000', 10);
let healthTimer: ReturnType<typeof setInterval> | null = null;
const memoryCompressionAutoContinuedRunIds = new Set<string>();
const codexAutoContinuedActivityGenerations = new Set<string>();
let codexQuotaTimer: ReturnType<typeof setInterval> | null = null;
let contextReplicationTimer: ReturnType<typeof setInterval> | null = null;
let contextMaterializationTimer: ReturnType<typeof setInterval> | null = null;
let gcTimer: ReturnType<typeof setInterval> | null = null;
let eventLoopDelayTimer: ReturnType<typeof setInterval> | null = null;
let hookServer: http.Server | null = null;

/** Mark an execution clone whose tmux pane has died as completed so the GC
 *  retention reap can later remove it. Execution clones are NEVER respawned —
 *  a dead clone pane means the worker ended. Retention is the configured
 *  duration persisted at create (`resolveExecutionCloneRetentionMs`), falling
 *  back to the parser default for old/rolling records. */
function completeExecutionCloneOnPaneDeath(s: SessionRecord): void {
  const meta = s.executionCloneMetadata;
  if (!meta || meta.completedAt || meta.cleanupState === 'destroying' || meta.cleanupState === 'destroyed') return;
  const now = Date.now();
  upsertSession({
    ...s,
    state: 'stopped',
    updatedAt: now,
    executionCloneMetadata: {
      ...meta,
      completedAt: now,
      retentionExpiresAt: now + resolveExecutionCloneRetentionMs(meta),
      cleanupState: 'collecting',
    },
  });
  timelineEmitter.emit(s.name, EXECUTION_CLONE_TIMELINE.TERMINAL, {
    sessionName: s.name,
    parentRunId: meta.parentRunId,
    reason: 'pane_death',
  });
}

/** Per-session health check. Exported so the execution-clone respawn-skip and
 *  the sweep can be asserted deterministically without the 30s tick (task 3.9). */
export async function checkSessionHealth(s: SessionRecord): Promise<void> {
  if (s.state === 'stopped' || s.state === 'error') return;
  // Execution clones are ephemeral: NEVER auto-respawn (this is the real
  // destroy-safety mechanism — teardown is not atomic). On pane death, mark for
  // the retention reap instead of resurrecting the worker.
  if (isExecutionClone(s)) {
    if (s.runtimeType === 'transport' || isTransportAgent(s.agentType)) return; // no pane; bounded by hard-timeout / orchestrator / restart sweep
    try {
      const exists = await sessionExists(s.name);
      if (!exists || !(await isPaneAlive(s.name))) completeExecutionCloneOnPaneDeath(s);
    } catch { /* ignore */ }
    return;
  }
  // Transport sessions have no tmux pane — skip tmux health checks.
  // Belt-and-suspenders: also check agentType so records persisted before
  // the runtimeType field existed (or written by an older daemon) don't
  // fall through and trigger a tmux restart loop on transport sessions.
  if (s.runtimeType === 'transport' || isTransportAgent(s.agentType)) return;
  // Sub-sessions: auto-restart dead panes, mark stopped if tmux session gone entirely
  if (s.name.startsWith('deck_sub_')) {
    try {
      const exists = await sessionExists(s.name);
      if (!exists) {
        logger.info({ session: s.name }, 'Sub-session gone, marking stopped');
        upsertSession({ ...s, state: 'stopped', updatedAt: Date.now() });
      } else if (!(await isPaneAlive(s.name))) {
        logger.warn({ session: s.name }, 'Sub-session pane dead, respawning');
        await respawnSession(s);
      }
    } catch { /* ignore */ }
    return;
  }
  try {
    const exists = await sessionExists(s.name);
    if (!exists) {
      logger.warn({ session: s.name }, 'Session missing, attempting restart');
      await restartSession(s);
    } else if (!(await isPaneAlive(s.name))) {
      logger.warn({ session: s.name }, 'Pane dead, respawning');
      await respawnSession(s);
    }
  } catch (err) {
    logger.warn({ session: s.name, err }, 'Health check error');
  }
}

/** Sweep expired execution clones on each health tick (task 3.6). Three branches:
 *  (1) creator-gone orphan sweep — the orchestrator session that created the clone
 *  is gone/stopped/errored, so no owner remains to collect the worker's results;
 *  (2) running clones past their hard timeout are stopped+destroyed; (3) completed
 *  clones past their retention window are reaped. This is a creator-gone orphan
 *  sweep + retention/hardTimeout backstop, NOT a full parent-run-terminal sweep:
 *  registry absence is ambiguous (runs are DELETED on completion) so it can never
 *  prove terminality and is never used here. Creator liveness is the only positive
 *  terminal signal and covers all parent stages. Daemon restart sweeps ALL clones
 *  (see initOnStartup). */
export async function runExecutionCloneSweep(now: number): Promise<void> {
  await sweepExecutionClones(now, {
    // Positive terminal signal: the clone's creator session is provably gone.
    // Unknown/alive creator → protect (fall back to retention/hardTimeout).
    isCloneParentTerminal: (rec) => {
      const creator = rec.executionCloneMetadata?.createdBySessionName;
      if (!creator) return false; // no creator info → protect
      const s = getSession(creator);
      return !s || s.state === 'stopped' || s.state === 'error';
    },
    isRunning: (r) => !r.executionCloneMetadata?.completedAt && r.state !== 'stopped' && r.state !== 'error',
    destroy: (target, reason) => destroyExecutionClone({ target, reason, bypassAuth: true }),
  });
}

/** Periodically check all running sessions; restart any that have disappeared or died. */
function startHealthPoller(): void {
  healthTimer = setInterval(async () => {
    const sessions = listSessions();
    for (const s of sessions) {
      await checkSessionHealth(s);
      let memoryCompressionRecovered = false;
      try {
        memoryCompressionRecovered = await recoverMemoryCompressionStalledSession(s.name);
      } catch (err) {
        logger.warn({ err, sessionName: s.name }, 'memory compression auto-continue watchdog failed');
      }
      let codexRecovered = false;
      if (!memoryCompressionRecovered) {
        codexRecovered = await recoverCodexStalledSession(s).catch((err) => {
          logger.warn({ err, sessionName: s.name }, 'codex stale-turn auto-continue watchdog failed');
          return false;
        });
      }
      // Safety net: settle a phantom (silent-but-"active") transport turn to
      // idle — and drain any queued work — so the session can't stay "working"
      // forever. Fires whether or not anything is queued.
      try {
        if (shouldRunGenericSilentActiveTurnRecovery(s, memoryCompressionRecovered || codexRecovered)) {
          getTransportRuntime(s.name)?.recoverSilentActiveTurn({
            reason: 'health-poll-stale-active-turn',
            staleMs: TRANSPORT_STALE_ACTIVE_TURN_RECOVERY_MS,
          });
        }
      } catch (err) {
        logger.warn({ err, sessionName: s.name }, 'transport stale-active-turn recovery sweep error');
      }
      // Safety net: rehydrate transport-queue rows that survive only in SQLite
      // (a message queued behind an in-flight turn before a restart, then the
      // runtime was rebuilt with an empty in-memory queue) and drain them. The
      // restore-path rehydrate in restoreTransportSessions can be missed when the
      // runtime was already bound by another path or an intervening await threw,
      // so this poller reconciles the desync within one cycle regardless of how
      // the runtime came to exist. Idempotent: during normal operation the store
      // rows are already in _pendingMessages and dedup by clientMessageId +
      // delivery tombstone skips them, so it only acts on genuine orphans.
      try {
        const rehydrateRuntime = getTransportRuntime(s.name);
        if (rehydrateRuntime && rehydrateRuntime.rehydratePendingFromStore() > 0) {
          rehydrateRuntime.drainPendingIfIdle('health-poll-sqlite-rehydrate');
        }
      } catch (err) {
        logger.warn({ err, sessionName: s.name }, 'transport queue rehydrate sweep error');
      }
    }
    try {
      await runExecutionCloneSweep(Date.now());
    } catch (err) {
      logger.warn({ err }, 'Execution-clone sweep error');
    }
  }, HEALTH_POLL_MS);
}


function isTransportDiagnosticActive(diagnostic: TransportRuntimeDiagnosticSnapshot): boolean {
  return diagnostic.sending
    || diagnostic.activeDispatchCount > 0
    || diagnostic.blockingWorkCount > 0
    || diagnostic.status === 'thinking'
    || diagnostic.status === 'streaming'
    || diagnostic.status === 'tool_running'
    || diagnostic.status === 'permission';
}

function isCodexTransportSession(s: Pick<SessionRecord, 'agentType' | 'providerId'>): boolean {
  return s.agentType === 'codex-sdk' || s.providerId === 'codex-sdk';
}

export function shouldRunGenericSilentActiveTurnRecovery(
  s: Pick<SessionRecord, 'agentType' | 'providerId'>,
  recoveredByContinueWatchdog = false,
): boolean {
  if (recoveredByContinueWatchdog) return false;
  // Codex silent-turn recovery is owned by recoverCodexStalledSession(), which
  // stops the stale turn and sends a front-of-queue `continue`. The generic
  // settle-only recovery runs earlier and would otherwise swallow the stale turn
  // before the Codex continuation branch can fire.
  return !isCodexTransportSession(s);
}

function rememberCodexAutoContinuedGeneration(generationKey: string): void {
  codexAutoContinuedActivityGenerations.add(generationKey);
  while (codexAutoContinuedActivityGenerations.size > 512) {
    const oldest = codexAutoContinuedActivityGenerations.values().next().value;
    if (oldest === undefined) break;
    codexAutoContinuedActivityGenerations.delete(oldest);
  }
}

export async function recoverCodexStalledSession(
  s: Pick<SessionRecord, 'name' | 'agentType' | 'providerId'>,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!isCodexTransportSession(s)) return false;
  const runtime = getTransportRuntime(s.name);
  if (!runtime) return false;
  const diagnostic = runtime.getDiagnosticSnapshot(nowMs);
  if (!isTransportDiagnosticActive(diagnostic)) return false;
  // Do not kill a legitimate long-running provider tool. This watchdog is for
  // Codex turns that have made no visible progress, not for shell/test/build
  // tools that can be quiet while doing real work.
  if (diagnostic.activeToolCount > 0) return false;
  if (diagnostic.lastActivityAgeMs < CODEX_STALE_ACTIVE_TURN_AUTO_CONTINUE_AFTER_MS) return false;

  const generationKey = normalizeActivityGeneration(diagnostic.activityGeneration)
    ?? `${s.name}:unknown:${diagnostic.pendingVersion}`;
  if (codexAutoContinuedActivityGenerations.has(generationKey)) return false;
  rememberCodexAutoContinuedGeneration(generationKey);

  const commandId = `auto-codex-stale-continue:${generationKey}`;
  logger.warn(
    {
      sessionName: s.name,
      generationKey,
      ageMs: diagnostic.lastActivityAgeMs,
      staleMs: CODEX_STALE_ACTIVE_TURN_AUTO_CONTINUE_AFTER_MS,
      diagnostic,
    },
    'codex watchdog stopping stale active turn and sending continue',
  );
  timelineEmitter.emit(
    s.name,
    'assistant.text',
    {
      text: '⚠️ Codex watchdog stopped a stale turn after 12 minutes with no activity and sent `continue`.',
      streaming: false,
      automation: true,
      memoryExcluded: true,
    },
    { source: 'daemon', confidence: 'high' },
  );

  timelineEmitter.emit(
    s.name,
    'user.message',
    {
      text: 'continue',
      clientMessageId: commandId,
      allowDuplicate: true,
    },
    { source: 'daemon', confidence: 'high', eventId: `transport-user:${commandId}` },
  );
  const sendResult = runtime.send('continue', commandId, undefined, undefined, {
    queuePlacement: 'front',
    timelineCommitted: true,
  });
  if (sendResult === 'queued') await runtime.cancel();
  return true;
}

export async function recoverMemoryCompressionStalledSession(
  sessionName: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const run = getStaleSessionCompressionRun(
    sessionName,
    nowMs,
    MEMORY_COMPRESSION_AUTO_CONTINUE_AFTER_MS,
  );
  if (!run) return false;
  if (memoryCompressionAutoContinuedRunIds.has(run.runId)) return false;

  const runtime = getTransportRuntime(sessionName);
  if (!runtime) return false;
  const diagnostic = runtime.getDiagnosticSnapshot(nowMs);
  if (diagnostic.activeToolCount > 0) return false;
  if (!isTransportDiagnosticActive(diagnostic)) {
    resolveSessionCompressionWatchRuns(sessionName);
    return false;
  }

  memoryCompressionAutoContinuedRunIds.add(run.runId);
  const commandId = `auto-memory-compression-continue:${run.runId}`;
  logger.warn(
    {
      sessionName,
      runId: run.runId,
      trigger: run.trigger,
      eventCount: run.eventCount,
      ageMs: Math.max(0, nowMs - run.startedAt),
      diagnostic,
    },
    'memory compression watchdog stopping stale active turn and sending continue',
  );
  timelineEmitter.emit(
    sessionName,
    'assistant.text',
    {
      text: '⚠️ Memory compression watchdog stopped a stale turn after 6 minutes and sent `continue`.',
      streaming: false,
      automation: true,
      memoryExcluded: true,
    },
    { source: 'daemon', confidence: 'high' },
  );

  timelineEmitter.emit(
    sessionName,
    'user.message',
    {
      text: 'continue',
      clientMessageId: commandId,
      allowDuplicate: true,
    },
    { source: 'daemon', confidence: 'high', eventId: `transport-user:${commandId}` },
  );
  const sendResult = runtime.send('continue', commandId, undefined, undefined, {
    queuePlacement: 'front',
    timelineCommitted: true,
  });
  if (sendResult === 'queued') await runtime.cancel();
  resolveSessionCompressionWatchRuns(sessionName);
  return true;
}

function startCodexQuotaPoller(serverLink: ServerLink | null): void {
  if (!serverLink) return;
  codexQuotaTimer = setInterval(() => {
    void refreshCodexQuotaMetadata(serverLink).catch((err) => {
      logger.warn({ err }, 'Codex quota refresh failed');
    });
    // claude-code-sdk sub-sessions are excluded from session_list (which carries
    // the Option-B 5h+weekly override for main sessions), so push a periodic
    // subsession.sync to keep their 7d quota line fresh — mirrors the codex subs.
    void refreshClaudeSdkSubQuotaMetadata(serverLink).catch((err) => {
      logger.warn({ err }, 'Claude SDK sub-session quota refresh failed');
    });
  }, CODEX_QUOTA_REFRESH_MS);
}

function startContextReplicationPoller(workerUrl: string | undefined, serverId: string, token: string): void {
  if (!workerUrl || !serverId || !token) return;
  contextReplicationTimer = setInterval(() => {
    void replicatePendingProcessedContext({ workerUrl, serverId, token }).catch((err) => {
      logger.warn({ err }, 'Processed-context replication failed');
    });
  }, CONTEXT_REPLICATION_POLL_MS);
}

function startContextMaterializationPoller(liveContextIngestion: LiveContextIngestion): void {
  contextMaterializationTimer = setInterval(() => {
    void (async () => {
      await liveContextIngestion.flushAllRetryBuffers();
      await liveContextIngestion.flushDueTargets();
    })().catch((err) => {
      logger.warn({ err }, 'Context materialization poll failed');
    });
  }, CONTEXT_MATERIALIZATION_POLL_MS);
}

/**
 * Periodically force a V8 major GC.
 *
 * Why: production daemon on a self-hosted server (211) was OOM-crashing
 * every 1–9 hours despite holding only ~218 MB of *live* objects. Manual
 * SIGUSR2 (which forces a heap-snapshot pre-GC) shrunk RSS from 2755 MB
 * → 1976 MB in one shot — i.e. ~780 MB of *unreachable* garbage was
 * sitting in V8's old generation waiting for major GC. With V8's default
 * heap limit of 4 GB, major GC only triggers when heap pressure forces
 * it, by which point the daemon is already at the edge of OOM. If a
 * legitimate spike in live data (e.g. a large transformers tokenizer
 * batch) lands during that window, V8 aborts the process with
 * "Reached heap limit Allocation failed".
 *
 * The bigger heap limit (`--max-old-space-size=12288` env override on
 * 211) keeps the daemon alive but doesn't fix the underlying behavior
 * — major GC still runs lazily, RSS climbs to many GB before
 * collection, and each major GC pause is multi-second on a fat heap
 * (looks like "the daemon went offline" to the operator). Forcing a
 * GC every few minutes keeps RSS bounded near actual live size and
 * keeps GC pauses short.
 *
 * Requires `--expose-gc`. Without it, `globalThis.gc` is undefined and
 * the poller is a silent no-op (so this is safe to ship without
 * mandating the flag — the worst case is we don't get the speedup).
 */
function startGcPoller(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    logger.info('GC poller: --expose-gc not enabled, skipping (set NODE_OPTIONS to "--expose-gc --max-old-space-size=N" to enable)');
    return;
  }
  if (!Number.isFinite(GC_POLL_MS) || GC_POLL_MS < 30_000) {
    logger.info({ requested: process.env.IMCODES_GC_POLL_MS }, 'GC poller: interval clamped or invalid, defaulting to 5 min');
  }
  const intervalMs = Number.isFinite(GC_POLL_MS) && GC_POLL_MS >= 30_000 ? GC_POLL_MS : 300_000;
  gcTimer = setInterval(() => {
    const t0 = Date.now();
    const before = process.memoryUsage().rss;
    try {
      gc();
    } catch (err) {
      logger.warn({ err }, 'GC poller: gc() threw');
      return;
    }
    const after = process.memoryUsage().rss;
    const elapsed = Date.now() - t0;
    // Only log meaningful GCs (freed > 50 MB or took > 200 ms) to avoid
    // chatty logs on quiet daemons.
    if (before - after > 50 * 1024 * 1024 || elapsed > 200) {
      logger.info(
        { rssBeforeMB: (before / 1024 / 1024) | 0, rssAfterMB: (after / 1024 / 1024) | 0, elapsedMs: elapsed },
        'GC poller: forced major GC',
      );
    }
  }, intervalMs);
  logger.info({ intervalMs }, 'GC poller: started');
}

/**
 * Event-loop delay sampler. Emits a warn log every minute if the p99
 * loop lag exceeds 50 ms in the last sampling window — a direct
 * proxy for "is anything blocking the daemon main thread?". The
 * histogram is `unref`'d so it never holds the process alive.
 *
 * After the async timeline refactor (PR-A), this metric should sit
 * near zero except during cron / GC bursts. A persistently high p99
 * signals that another sync I/O path slipped in.
 */
function startEventLoopDelayMonitor(): void {
  let monitor: ReturnType<typeof monitorEventLoopDelay>;
  try {
    monitor = monitorEventLoopDelay({ resolution: 20 });
    monitor.enable();
  } catch (err) {
    logger.debug({ err }, 'event-loop-delay: monitor unavailable (perf_hooks missing)');
    return;
  }
  eventLoopDelayTimer = setInterval(() => {
    const p99ms = monitor.percentile(99) / 1e6;
    const meanMs = monitor.mean / 1e6;
    if (p99ms > 50) {
      logger.warn({
        p99ms: Number(p99ms.toFixed(1)),
        meanMs: Number(meanMs.toFixed(1)),
        pendingSessions: timelineStore.getPendingSessionCount(),
      }, 'event-loop-delay: high p99 (>50ms) — main thread blocked recently');
    }
    monitor.reset();
  }, 60_000);
  if (typeof eventLoopDelayTimer.unref === 'function') {
    eventLoopDelayTimer.unref();
  }
  logger.info({ intervalMs: 60_000, warnThresholdMs: 50 }, 'event-loop-delay: monitor started');
}

function setupSignalHandlers(): void {
  const handler = () => shutdown(0);
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  // NOTE: uncaughtException / unhandledRejection are handled in src/index.ts
  // with a "daemon stays alive" policy.  We must NOT register a shutdown
  // handler here — that would override the keep-alive behavior and let any
  // stray error take the daemon down.
}

export function getDaemonContext(): DaemonContext {
  if (!ctx) throw new Error('Daemon not started');
  return ctx;
}
