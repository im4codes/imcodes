import { loadStore, flushStore, listSessions, getSession, upsertSession, removeSession } from '../store/session-store.js';
import { restoreFromStore, setSessionEventCallback, setSessionPersistCallback, restartSession, respawnSession, initOnStartup } from '../agent/session-manager.js';
import { sessionExists, isPaneAlive } from '../agent/tmux.js';
import { detectMemoryBackend } from '../memory/detector.js';
import { detectRepo } from '../repo/detector.js';
import { repoCache, RepoCache } from '../repo/cache.js';
import { ServerLink } from './server-link.js';
import { handleWebCommand, setRouterContext } from './command-handler.js';
import { initFileTransfer, startCleanupTimer } from './file-transfer-handler.js';
import { notifySessionIdle, listP2pRuns } from './p2p-orchestrator.js';
import { timelineEmitter } from './timeline-emitter.js';
import { timelineStore } from './timeline-store.js';
import { startHookServer } from './hook-server.js';
import { setupCCHooks } from '../agent/signal.js';
import type http from 'http';
import net from 'node:net';
import { loadConfig, type Config } from '../config.js';
import { loadCredentials } from '../bind/bind-flow.js';
import { sendKeys } from '../agent/tmux.js';
import logger from '../util/logger.js';
import type { MemoryBackend } from '../memory/interface.js';
import type { RouterContext } from '../router/message-router.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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

export interface DaemonContext {
  config: Config;
  memory: MemoryBackend | null;
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
  try {
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sessions/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
      body: JSON.stringify({
        projectName: record.projectName,
        projectRole: record.role,
        agentType: record.agentType,
        agentVersion: record.agentVersion,
        projectDir: record.projectDir,
        state: record.state,
      }),
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

/** On startup: pull sessions from D1 and populate the local store so restoreFromStore can rebuild tmux. */
async function syncSessionsFromWorker(workerUrl: string, serverId: string, token: string): Promise<void> {
  try {
    const res = await fetch(`${workerUrl}/api/server/${serverId}/sessions`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Server-Id': serverId },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'syncSessionsFromWorker: non-ok response');
      return;
    }
    const data = await res.json() as { sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; project_dir: string; state: string }> };
    let count = 0;
    for (const s of data.sessions) {
      if (s.state === 'stopped') continue; // skip stopped sessions
      const existing = getSession(s.name);
      // Merge with existing local record to preserve fields not stored in server DB
      // (ccSessionId, codexSessionId, geminiSessionId, restarts, etc.)
      upsertSession({
        ...(existing ?? {}),
        name: s.name,
        projectName: s.project_name,
        role: s.role as 'brain' | `w${number}`,
        agentType: s.agent_type,
        projectDir: s.project_dir,
        state: s.state as import('../store/session-store.js').SessionState,
        restarts: existing?.restarts ?? 0,
        restartTimestamps: existing?.restartTimestamps ?? [],
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
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
  const p = sockPath ?? path.join(os.homedir(), '.imcodes', 'daemon.sock');
  fs.mkdirSync(path.dirname(p), { recursive: true });

  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Socket exists — check if another daemon is actually alive
        const client = net.connect(p, () => {
          // Connection succeeded → another daemon is running
          client.destroy();
          reject(new Error(`Another imcodes daemon is already running. Use 'imcodes restart' to restart it.`));
        });
        client.on('error', () => {
          // Connection failed → stale socket from a crashed process, reclaim it
          try { fs.unlinkSync(p); } catch { /* ignore */ }
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
  const p = sockPath ?? path.join(os.homedir(), '.imcodes', 'daemon.sock');
  try { fs.unlinkSync(p); } catch { /* ignore */ }
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

  await initOnStartup();
  logger.info('Startup cleanup done');

  // Initialize file transfer: create upload dir + clean expired files
  await initFileTransfer();
  startCleanupTimer();
  logger.info('File transfer initialized');

  // Clean up old timeline files (>7 days)
  timelineStore.cleanup();

  const { backend: memory, mode } = await detectMemoryBackend();
  logger.info({ mode }, 'Memory backend selected');

  const creds = await loadCredentials();

  // No fallback: a valid serverId is required for the WS endpoint (/api/server/:id/ws)
  // and for the auth handshake. Without stored credentials from `imcodes bind`, we
  // cannot connect to the CF Worker.
  const workerUrl = creds?.workerUrl;
  const serverId = creds?.serverId ?? '';
  const token = creds?.token ?? '';

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

  let serverLink: ServerLink | null = null;
  if (creds) {
    serverLink = new ServerLink({ workerUrl: workerUrl!, serverId, token });
    serverLink.onMessage((msg) => {
      handleWebCommand(msg, serverLink!);
    });
    serverLink.connect();

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
        const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled']);
        if (TERMINAL.has(run.status)) continue;
        try { serverLink.send({ type: 'p2p.run_save', run }); } catch { /* ignore */ }
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
            ccSessionId: session.ccSessionId ?? null,
            geminiSessionId: session.geminiSessionId ?? null,
            parentSession: session.parentSession ?? null,
          });
        } catch { /* ignore */ }
      }
    }, 3_000); // delay to ensure WS auth handshake completes first
  }

  // Wire session events → ServerLink so the browser sees them
  setSessionEventCallback((event, session, state) => {
    if (!serverLink) return;
    try { serverLink.send({ type: 'session_event', event, session, state }); } catch { /* not connected */ }

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

  // Wire timeline idle events → P2P orchestrator (covers all agent types: CC, codex, gemini, etc.)
  timelineEmitter.on((e) => {
    if (e.type === 'session.state' && (e.payload as Record<string, unknown>).state === 'idle') {
      notifySessionIdle(e.sessionId);
    }
  });

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
      if (s.state !== 'stopped') {
        await persistSessionToWorker(workerUrl!, serverId, token, s.name, s);
      }
    }
    if (localSessions.filter((s) => s.state !== 'stopped').length > 0) {
      logger.info({ count: localSessions.filter((s) => s.state !== 'stopped').length }, 'Pushed local sessions to server DB on startup');
    }
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

  // Forward all timeline events to connected browsers via ServerLink
  if (serverLink) {
    timelineEmitter.on((event) => {
      // For session.state idle, attach lastText so push notifications have context
      if (event.type === 'session.state' && (event.payload as Record<string, unknown>).state === 'idle') {
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
      const record = listSessions().find((s) => s.name === payload.session);
      const projectName = record?.projectName ?? payload.session;
      if (payload.event === 'idle') {
        // notifySessionIdle is handled by the unified timeline listener below
        // Include last assistant text for push notification context
        const lastText = getLastAssistantText(payload.session);
        serverLink.send({ type: 'session.idle', session: payload.session, project: projectName, agentType: payload.agentType, ...(lastText ? { lastText } : {}) });
      } else if (payload.event === 'notification') {
        serverLink.send({ type: 'session.notification', session: payload.session, project: projectName, title: payload.title, message: payload.message });
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

  ctx = { config, memory, serverLink, persistBinding, removeBinding, sendSessionEvent };
  setupSignalHandlers();
  startHealthPoller();

  logger.info('Daemon started');

  void autoReconnectProviders();

  return ctx;
}

async function autoReconnectProviders(): Promise<void> {
  try {
    // Dynamic import to avoid loading WS deps when not needed
    const { loadConfig: loadOcConfig } = await import('../agent/openclaw-config.js');
    const { connectProvider } = await import('../agent/provider-registry.js');

    const ocConfig = await loadOcConfig();
    if (ocConfig) {
      logger.info({ url: ocConfig.url }, 'Auto-reconnecting to OpenClaw gateway...');
      try {
        await connectProvider('openclaw', {
          url: ocConfig.url,
          token: ocConfig.token,
          agentId: ocConfig.agentId,
        });
        logger.info('OpenClaw gateway reconnected');
      } catch (err) {
        logger.warn({ err }, 'OpenClaw auto-reconnect failed — will retry on next connect command');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Provider auto-reconnect check failed');
  }
}

/** Shutdown sequence: flush store, disconnect WS, release lock, exit cleanly */
export async function shutdown(exitCode = 0): Promise<void> {
  logger.info('Daemon shutting down');

  try {
    const { disconnectAll } = await import('../agent/provider-registry.js');
    await disconnectAll();
  } catch { /* ignore */ }

  try {
    if (healthTimer) clearInterval(healthTimer);
    hookServer?.close();
    ctx?.serverLink?.disconnect();
    await flushStore();
    logger.info('Store flushed');
  } catch (e) {
    logger.error({ err: e }, 'Error during shutdown');
  }

  if (lockServer) releaseInstanceLock(lockServer);

  // tmux sessions are intentionally NOT killed — they keep running
  logger.info('Daemon stopped (tmux sessions left running)');
  process.exit(exitCode);
}

const HEALTH_POLL_MS = 30_000;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let hookServer: http.Server | null = null;

/** Periodically check all running sessions; restart any that have disappeared or died. */
function startHealthPoller(): void {
  healthTimer = setInterval(async () => {
    const sessions = listSessions();
    for (const s of sessions) {
      if (s.state === 'stopped' || s.state === 'error') continue;
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

function setupSignalHandlers(): void {
  const handler = () => shutdown(0);
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    shutdown(1);
  });
}

export function getDaemonContext(): DaemonContext {
  if (!ctx) throw new Error('Daemon not started');
  return ctx;
}
