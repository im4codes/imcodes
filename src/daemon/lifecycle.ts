import { loadStore, flushStore, listSessions, getSession, upsertSession, removeSession, type SessionRecord } from '../store/session-store.js';
import { restoreFromStore, setSessionEventCallback, setSessionPersistCallback, restartSession, respawnSession, initOnStartup, rebuildProviderRoutes, getTransportRuntime, unregisterProviderRoute } from '../agent/session-manager.js';
import { sessionExists, isPaneAlive, BACKEND, killSession } from '../agent/tmux.js';
import { detectRepo } from '../repo/detector.js';
import { repoCache, RepoCache } from '../repo/cache.js';
import { ServerLink } from './server-link.js';
import { handleWebCommand, setRouterContext, refreshCodexQuotaMetadata } from './command-handler.js';
import { initFileTransfer, startCleanupTimer } from './file-transfer-handler.js';
import { notifySessionIdle, listP2pRuns, serializeP2pRun } from './p2p-orchestrator.js';
import { handlePreviewBinaryFrame } from './preview-relay.js';
import { buildSessionList } from './session-list.js';
import { timelineEmitter } from './timeline-emitter.js';
import { supervisionAutomation } from './supervision-automation.js';
import { timelineStore } from './timeline-store.js';
import { getDefaultAckOutbox } from './ack-outbox.js';
import { startHookServer, drainQueue } from './hook-server.js';
import { initTempFileStore } from '../store/temp-file-store.js';
import { setupCCHooks } from '../agent/signal.js';
import type http from 'http';
import net from 'node:net';
import { loadConfig, type Config } from '../config.js';
import { loadCredentials } from '../bind/bind-flow.js';
import { sendKeys } from '../agent/tmux.js';
import logger from '../util/logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import { pickReadableSessionDisplay } from '../../shared/session-display.js';
import { buildWorkerSessionPersistBody, mergeWorkerSessionSnapshot } from './session-bootstrap.js';
import { replicatePendingProcessedContext } from '../context/processed-context-replication.js';
import { configureSharedContextRuntime } from '../context/shared-context-runtime.js';
import { fetchBackendSharedContextRuntimeConfig } from '../context/backend-runtime-config.js';
import { setContextModelRuntimeConfig } from '../context/context-model-config.js';
import { LiveContextIngestion } from '../context/live-context-ingestion.js';
import { resolveTransportContextBootstrap } from '../agent/runtime-context-bootstrap.js';
import { pruneLocalMemory } from '../context/memory-pruning.js';
import { isKnownTestSessionLike } from '../../shared/test-session-guard.js';
import { isTransportAgent } from '../agent/detect.js';

/** Get the last assistant.text from a session's timeline (for push notification context). */
function getLastAssistantText(sessionName: string): string | undefined {
  try {
    const events = timelineStore.read(sessionName, { limit: 100 });
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'assistant.text') {
        const text = (events[i].payload as Record<string, unknown>)?.text;
        if (typeof text === 'string' && text.trim()) return text.slice(0, 200);
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function resolvePushDisplayContext(sessionName: string, sessions: SessionRecord[]): {
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
    if (!res.ok) logger.warn({ status: res.status, name }, 'persistSessionToWorker: non-ok response');
  } catch (e) {
    logger.warn({ err: e, name }, 'persistSessionToWorker: fetch failed');
  }
}

async function deleteSessionFromWorker(workerUrl: string, serverId: string, token: string, name: string): Promise<void> {
  try {
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
    });
    if (!res.ok) logger.warn({ status: res.status, name }, 'deleteSessionFromWorker: non-ok response');
  } catch (e) {
    logger.warn({ err: e, name }, 'deleteSessionFromWorker: fetch failed');
  }
}

async function deleteSubSessionFromWorker(workerUrl: string, serverId: string, token: string, id: string): Promise<void> {
  try {
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sub-sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
    });
    if (!res.ok) logger.warn({ status: res.status, id }, 'deleteSubSessionFromWorker: non-ok response');
  } catch (e) {
    logger.warn({ err: e, id }, 'deleteSubSessionFromWorker: fetch failed');
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

/** On startup: pull sessions from D1 and populate the local store so restoreFromStore can rebuild tmux. */
async function syncSessionsFromWorker(workerUrl: string, serverId: string, token: string): Promise<void> {
  try {
    const headers = { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId };
    const [sessionRes, subRes] = await Promise.all([
      fetch(`${workerUrl}/api/server/${serverId}/sessions`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }),
      fetch(`${workerUrl}/api/server/${serverId}/sub-sessions`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }),
    ]);

    if (!sessionRes.ok) {
      logger.warn({ status: sessionRes.status }, 'syncSessionsFromWorker: non-ok response');
      return;
    }
    if (!subRes.ok) {
      logger.warn({ status: subRes.status }, 'syncSessionsFromWorker: sub-session fetch failed');
      return;
    }

    const data = await sessionRes.json() as { sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; project_dir: string; state: string; label?: string | null; requested_model?: string | null; active_model?: string | null; effort?: SessionRecord['effort'] | null; transport_config?: Record<string, unknown> | string | null }> };
    const subData = await subRes.json() as { subSessions: Array<{ id: string; cwd?: string | null; parent_session?: string | null }> };
    const remoteTestSessions = data.sessions.filter((session) => isKnownTestSessionLike({
      name: session.name,
      projectName: session.project_name,
      projectDir: session.project_dir,
    }));
    const remoteTestSubSessions = subData.subSessions.filter((subSession) => isKnownTestSessionLike({
      name: subSession.id ? `deck_sub_${subSession.id}` : undefined,
      cwd: subSession.cwd,
      parentSession: subSession.parent_session,
    }));
    await Promise.all([
      ...remoteTestSessions.map((session) => deleteSessionFromWorker(workerUrl, serverId, token, session.name)),
      ...remoteTestSubSessions.map((subSession) => deleteSubSessionFromWorker(workerUrl, serverId, token, subSession.id)),
    ]);
    const remoteSessionNames = new Set(
      data.sessions
        .filter((s) => !isKnownTestSessionLike({ name: s.name, projectName: s.project_name, projectDir: s.project_dir }))
        .filter((s) => s.state !== 'stopped')
        .map((s) => s.name),
    );
    const remoteSubSessionNames = new Set(
      subData.subSessions
        .filter((s) => !isKnownTestSessionLike({ name: s.id ? `deck_sub_${s.id}` : undefined, cwd: s.cwd, parentSession: s.parent_session }))
        .map((s) => `deck_sub_${s.id}`),
    );

    const localSessions = listSessions();
    const staleLocal = localSessions.filter((session) => {
      if (session.name.startsWith('deck_sub_')) return !remoteSubSessionNames.has(session.name);
      return !remoteSessionNames.has(session.name);
    });

    for (const session of staleLocal) {
      await dropLocalSession(session);
    }
    if (staleLocal.length > 0) {
      logger.info({ count: staleLocal.length, sessions: staleLocal.map((s) => s.name) }, 'Pruned local sessions missing from server state');
    }

    let count = 0;
    for (const s of data.sessions) {
      if (isKnownTestSessionLike({ name: s.name, projectName: s.project_name, projectDir: s.project_dir })) continue;
      if (s.state === 'stopped') continue; // skip stopped sessions
      const existing = getSession(s.name);
      upsertSession(mergeWorkerSessionSnapshot(existing, s));
      count++;
    }
    logger.info({ count }, 'Sessions synced from D1');
  } catch (e) {
    logger.warn({ err: e }, 'syncSessionsFromWorker: fetch failed');
  }
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
  logger.info('Daemon starting');
  lockServer = await acquireInstanceLock();
  writePidFile();

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

  // Clean up old timeline files (>7 days) and truncate oversized ones
  timelineStore.cleanup();
  timelineStore.truncateAll();

  // Archive stale local memory projections (recent_summary with no hits after 30 days)
  pruneLocalMemory();

  const creds = await loadCredentials();

  // No fallback: a valid serverId is required for the WS endpoint (/api/server/:id/ws)
  // and for the auth handshake. Without stored credentials from `imcodes bind`, we
  // cannot connect to the CF Worker.
  const workerUrl = creds?.workerUrl;
  const serverId = creds?.serverId ?? '';
  const token = creds?.token ?? '';
  configureSharedContextRuntime(creds ? { workerUrl: workerUrl!, serverId, token } : null);
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

  // Sync sessions from D1 before restoring tmux sessions
  if (creds) {
    await syncSessionsFromWorker(workerUrl!, serverId, token);
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

  // Warm up the transformers.js embedding model in the background so the
  // first user send after daemon start doesn't pay the ~16s cold-load latency
  // inside prependLocalMemory(). Fire-and-forget — the recall path falls
  // through safely if this is still in flight when the first message arrives.
  void (async () => {
    try {
      const { generateEmbedding } = await import('../context/embedding.js');
      const t0 = Date.now();
      await generateEmbedding('warmup');
      logger.info({ ms: Date.now() - t0 }, 'Embedding model warmed up');
    } catch (err) {
      // Non-fatal: semantic recall falls back to substring match if the
      // model never loads.
      logger.warn({ err }, 'Embedding model warmup failed — semantic recall will be lazy');
    }
  })();

  const liveContextIngestion = new LiveContextIngestion({
    sessionLookup: getSession,
    resolveBootstrap: (session) => resolveTransportContextBootstrap({
      projectDir: session.projectDir,
      transportConfig: getSession(session.name)?.transportConfig ?? session.transportConfig ?? {},
    }),
    onError: (err, event) => {
      logger.warn({ err, session: event.sessionId, type: event.type }, 'Live context ingestion failed');
    },
  });

  let serverLink: ServerLink | null = null;
  if (creds) {
    serverLink = new ServerLink({ workerUrl: workerUrl!, serverId, token });
    serverLink.onMessage((msg) => {
      handleWebCommand(msg, serverLink!);
    });
    serverLink.onBinaryMessage((data) => {
      handlePreviewBinaryFrame(data, serverLink!);
    });
    serverLink.connect();

    // Expose to the global error handlers in src/index.ts so uncaught
    // exceptions can be surfaced to browsers via daemon.error broadcasts.
    (globalThis as typeof globalThis & {
      __imcodesGlobalServerLink?: ServerLink;
    }).__imcodesGlobalServerLink = serverLink;

    // Broadcast cached repo detections after connect so browsers that missed
    // the initial repo.detected push (e.g. connected late, reconnected) get the data.
    setTimeout(() => {
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
      // Re-sync all active sub-sessions so server DB and frontend stay in sync
      for (const session of listSessions()) {
        if (!session.name.startsWith('deck_sub_')) continue;
        if (session.state !== 'running') continue;
        const id = session.name.slice('deck_sub_'.length);
        try {
          serverLink.send({
            type: 'subsession.sync',
            id,
            sessionType: session.agentType,
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
            requestedModel: session.requestedModel ?? null,
            activeModel: session.activeModel ?? session.modelDisplay ?? null,
            modelDisplay: session.modelDisplay ?? null,
            planLabel: session.planLabel ?? null,
            quotaLabel: session.quotaLabel ?? null,
            quotaUsageLabel: session.quotaUsageLabel ?? null,
            effort: session.effort ?? null,
            transportConfig: session.transportConfig ?? null,
          });
        } catch { /* ignore */ }
      }
    }, 3_000); // delay to ensure WS auth handshake completes first
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

  for (const session of listSessions()) {
    const history = timelineStore.read(session.name, { limit: 100 });
    if (history.length === 0) continue;
    void liveContextIngestion.backfillSessionFromEvents(session.name, history).catch((err) => {
      logger.warn({ err, session: session.name }, 'Shared-context timeline backfill failed');
    });
  }

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
    const localSessions = listSessions();
    for (const s of localSessions) {
      if (s.state !== 'stopped' && !isKnownTestSessionLike({
        name: s.name,
        projectName: s.projectName,
        projectDir: s.projectDir,
        parentSession: s.parentSession,
      })) {
        await persistSessionToWorker(workerUrl!, serverId, token, s.name, s);
      }
    }
    if (localSessions.filter((s) => s.state !== 'stopped').length > 0) {
      logger.info({ count: localSessions.filter((s) => s.state !== 'stopped').length }, 'Pushed local sessions to server DB on startup');
    }
    void replicatePendingProcessedContext({ workerUrl: workerUrl!, serverId, token }).catch((err) => {
      logger.warn({ err }, 'Initial processed-context replication failed');
    });
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
        const lastText = getLastAssistantText(event.sessionId);
        serverLink!.send({ type: 'timeline.event', event, ...(lastText ? { lastText } : {}) });
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
        const lastText = getLastAssistantText(payload.session);
        serverLink.send({
          type: 'session.idle',
          session: payload.session,
          project: display.project,
          agentType: payload.agentType,
          ...(lastText ? { lastText } : {}),
          ...(display.label ? { label: display.label } : {}),
          ...(display.parentLabel ? { parentLabel: display.parentLabel } : {}),
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

  logger.info('Daemon started');

  void autoReconnectProviders();

  return ctx;
}

async function autoReconnectProviders(): Promise<void> {
  try {
    // Dynamic import to avoid loading WS deps when not needed
    const { listSessions } = await import('../store/session-store.js');
    const { loadConfig: loadOcConfig } = await import('../agent/openclaw-config.js');
    const { connectProvider, ensureProviderConnected } = await import('../agent/provider-registry.js');
    const { restoreTransportSessions } = await import('../agent/session-manager.js');

    for (const providerId of ['qwen', 'claude-code-sdk', 'codex-sdk', 'cursor-headless', 'copilot-sdk'] as const) {
      if (!listSessions().some((s) => s.runtimeType === 'transport' && s.providerId === providerId)) continue;
      try {
        await ensureProviderConnected(providerId, {});
        await restoreTransportSessions(providerId);
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
            await restoreTransportSessions('openclaw');
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
    const { disconnectAll } = await import('../agent/provider-registry.js');
    await disconnectAll();
  } catch { /* ignore */ }

  try {
    if (healthTimer) clearInterval(healthTimer);
    if (codexQuotaTimer) clearInterval(codexQuotaTimer);
    if (contextReplicationTimer) clearInterval(contextReplicationTimer);
    if (contextMaterializationTimer) clearInterval(contextMaterializationTimer);
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
const CODEX_QUOTA_REFRESH_MS = 60_000;
const CONTEXT_REPLICATION_POLL_MS = 30_000;
const CONTEXT_MATERIALIZATION_POLL_MS = 15_000;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let codexQuotaTimer: ReturnType<typeof setInterval> | null = null;
let contextReplicationTimer: ReturnType<typeof setInterval> | null = null;
let contextMaterializationTimer: ReturnType<typeof setInterval> | null = null;
let hookServer: http.Server | null = null;

/** Periodically check all running sessions; restart any that have disappeared or died. */
function startHealthPoller(): void {
  healthTimer = setInterval(async () => {
    const sessions = listSessions();
    for (const s of sessions) {
      if (s.state === 'stopped' || s.state === 'error') continue;
      // Transport sessions have no tmux pane — skip tmux health checks.
      // Belt-and-suspenders: also check agentType so records persisted before
      // the runtimeType field existed (or written by an older daemon) don't
      // fall through and trigger a tmux restart loop on transport sessions.
      if (s.runtimeType === 'transport' || isTransportAgent(s.agentType)) continue;
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
        continue;
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
  }, HEALTH_POLL_MS);
}

function startCodexQuotaPoller(serverLink: ServerLink | null): void {
  if (!serverLink) return;
  codexQuotaTimer = setInterval(() => {
    void refreshCodexQuotaMetadata(serverLink).catch((err) => {
      logger.warn({ err }, 'Codex quota refresh failed');
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
    void liveContextIngestion.flushDueTargets().catch((err) => {
      logger.warn({ err }, 'Context materialization poll failed');
    });
  }, CONTEXT_MATERIALIZATION_POLL_MS);
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
