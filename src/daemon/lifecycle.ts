import { loadStore, flushStore, listSessions, upsertSession, removeSession } from '../store/session-store.js';
import { restoreFromStore, setSessionEventCallback, setSessionPersistCallback, restartSession, initOnStartup } from '../agent/session-manager.js';
import { sessionExists } from '../agent/tmux.js';
import { detectMemoryBackend } from '../memory/detector.js';
import { ServerLink } from './server-link.js';
import { handleWebCommand, setRouterContext } from './command-handler.js';
import { timelineEmitter } from './timeline-emitter.js';
import { timelineStore } from './timeline-store.js';
import { startHookServer } from './hook-server.js';
import { setupCCHooks } from '../agent/signal.js';
import type http from 'http';
import { loadConfig, type Config } from '../config.js';
import { loadCredentials } from '../bind/bind-flow.js';
import { sendKeys } from '../agent/tmux.js';
import logger from '../util/logger.js';
import type { MemoryBackend } from '../memory/interface.js';
import type { RouterContext } from '../router/message-router.js';

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
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'syncSessionsFromWorker: non-ok response');
      return;
    }
    const data = await res.json() as { sessions: Array<{ name: string; project_name: string; role: string; agent_type: string; project_dir: string; state: string }> };
    let count = 0;
    for (const s of data.sessions) {
      if (s.state === 'stopped') continue; // skip stopped sessions
      upsertSession({
        name: s.name,
        projectName: s.project_name,
        role: s.role as 'brain' | `w${number}`,
        agentType: s.agent_type,
        projectDir: s.project_dir,
        state: s.state as import('../store/session-store.js').SessionState,
        restarts: 0,
        restartTimestamps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      count++;
    }
    logger.info({ count }, 'Sessions synced from D1');
  } catch (e) {
    logger.warn({ err: e }, 'syncSessionsFromWorker: fetch failed');
  }
}

/** Startup sequence: config → store → memory → sessions → server link */
export async function startup(): Promise<DaemonContext> {
  logger.info('Daemon starting');

  const config = await loadConfig();
  logger.info({ config: config.daemon }, 'Config loaded');

  await loadStore();
  logger.info('Session store loaded');

  await initOnStartup();
  logger.info('Startup cleanup done');

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

  await restoreFromStore();
  logger.info('Sessions reconciled');

  let serverLink: ServerLink | null = null;
  if (creds) {
    serverLink = new ServerLink({ workerUrl: workerUrl!, serverId, token });
    serverLink.onMessage((msg) => {
      handleWebCommand(msg, serverLink!);
    });
    serverLink.connect();
  }

  // Wire session events → ServerLink so the browser sees them
  setSessionEventCallback((event, session, state) => {
    if (!serverLink) return;
    try { serverLink.send({ type: 'session_event', event, session, state }); } catch { /* not connected */ }
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
      serverLink!.sendTimelineEvent(event);
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
        const agentType = (await import('../store/session-store.js')).getSession(sessionName)?.agentType;
        const chunkedAgents = new Set(['codex', 'gemini', 'opencode', 'shell', 'script']);
        const opts = agentType && chunkedAgents.has(agentType) ? { chunked: true } : undefined;
        await sendKeys(sessionName, text, opts);
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
        serverLink.send({ type: 'session.idle', session: payload.session, project: projectName, agentType: payload.agentType });
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
  return ctx;
}

/** Shutdown sequence: flush store, disconnect WS, exit cleanly */
export async function shutdown(exitCode = 0): Promise<void> {
  logger.info('Daemon shutting down');

  try {
    if (healthTimer) clearInterval(healthTimer);
    hookServer?.close();
    ctx?.serverLink?.disconnect();
    await flushStore();
    logger.info('Store flushed');
  } catch (e) {
    logger.error({ err: e }, 'Error during shutdown');
  }

  // tmux sessions are intentionally NOT killed — they keep running
  logger.info('Daemon stopped (tmux sessions left running)');
  process.exit(exitCode);
}

const HEALTH_POLL_MS = 30_000;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let hookServer: http.Server | null = null;

/** Periodically check all running sessions; restart any that have disappeared. */
function startHealthPoller(): void {
  healthTimer = setInterval(async () => {
    const sessions = listSessions();
    for (const s of sessions) {
      if (s.state === 'stopped' || s.state === 'error') continue;
      try {
        const alive = await sessionExists(s.name);
        if (!alive) {
          logger.warn({ session: s.name }, 'Session missing, attempting restart');
          await restartSession(s);
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
