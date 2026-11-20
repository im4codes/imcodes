import { WebSocket } from 'ws';
import {
  GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS,
  GLOBAL_TASK_MODE_MSG,
  GLOBAL_TASK_NOTIFY_CHANNEL,
  GLOBAL_TASK_PG_NOTIFY_MAX_BYTES,
  serializeBoundedPgNotifyPayload,
  truncateGlobalBrainText,
  type GlobalTaskBrainTextEvent,
  type GlobalTaskServerFrame,
  type GlobalTaskSummaryRow,
} from '../../../shared/global-task-mode.js';
import type { Database } from '../db/client.js';
import {
  emitGlobalTaskPgNotify,
  getGlobalTaskSummaryForServerTask,
  getServerMetaForGlobalTask,
  listGlobalTaskSnapshotForUser,
  resolveAuthorizedFullServersForUser,
} from '../db/global-task-summaries.js';
import logger from '../util/logger.js';

interface ClientSubscription {
  ws: WebSocket;
  userId: string;
  db: Database;
  serverIds: Set<string>;
  mutedServerIds: Set<string>;
}

type GlobalTaskNotifyEnvelope =
  | { kind: 'task'; serverId: string; taskId: string; ts: number }
  | {
    kind: 'brain_text';
    serverId: string;
    serverName: string;
    sessionName: string;
    projectName?: string;
    eventId: string;
    text: string;
    ts: number;
  }
  | { kind: 'server_state'; serverId: string; online: boolean; ts: number };

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const MAX_MUTED_IDS = 1000;

function safeSendWs(ws: WebSocket, frame: GlobalTaskServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket closed between check and send; close handler cleans it up.
  }
}

export class GlobalTaskHub {
  private clients = new Map<WebSocket, ClientSubscription>();
  private listenerClient: {
    on(event: string, fn: (...args: any[]) => void): void;
    query(sql: string): Promise<unknown>;
    end(): Promise<void>;
  } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private running = false;
  private startGeneration = 0;
  private pgListening = false;
  private connectionString: string | undefined;
  private db: Database | undefined;

  isPgListening(): boolean {
    return this.pgListening;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(connectionString?: string, db?: Database): Promise<void> {
    this.connectionString = connectionString;
    this.db = db;
    this.running = true;
    const gen = ++this.startGeneration;
    if (!connectionString) {
      this.pgListening = false;
      return;
    }
    await this.connectPgListener(gen);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.startGeneration += 1;
    this.pgListening = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.listenerClient;
    this.listenerClient = null;
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
    for (const [ws] of [...this.clients]) {
      this.clients.delete(ws);
      try { ws.close(1001, 'server shutting down'); } catch { /* ignore */ }
    }
  }

  private async connectPgListener(gen: number): Promise<void> {
    if (!this.running || gen !== this.startGeneration || !this.connectionString) return;
    try {
      const pgModule = await import('pg');
      if (!this.running || gen !== this.startGeneration) return;
      const driver = (pgModule as {
        default?: { Client: new (opts: { connectionString: string }) => NonNullable<GlobalTaskHub['listenerClient']> };
        Client?: new (opts: { connectionString: string }) => NonNullable<GlobalTaskHub['listenerClient']>;
      }).default ?? (pgModule as unknown as { Client: new (opts: { connectionString: string }) => NonNullable<GlobalTaskHub['listenerClient']> });

      const client = new driver.Client!({ connectionString: this.connectionString });
      this.listenerClient = client;

      client.on('notification', (msg: { channel?: string; payload?: string }) => {
        if (msg.channel !== GLOBAL_TASK_NOTIFY_CHANNEL || !msg.payload) return;
        void this.handleNotifyPayload(msg.payload).catch((err) => {
          logger.warn({ err }, 'Failed handling global task pg_notify payload');
        });
      });

      const onDisconnect = () => {
        if (this.listenerClient === client) {
          this.listenerClient = null;
          this.pgListening = false;
          try { void client.end(); } catch { /* ignore */ }
          this.schedulePgReconnect(gen);
        }
      };

      client.on('error', (err: unknown) => {
        logger.warn({ err }, 'Global task LISTEN connection error');
        onDisconnect();
      });
      client.on('end', () => {
        onDisconnect();
      });

      await (client as unknown as { connect(): Promise<void> }).connect();
      if (!this.running || gen !== this.startGeneration) {
        try { await client.end(); } catch { /* ignore */ }
        return;
      }
      await client.query(`LISTEN ${GLOBAL_TASK_NOTIFY_CHANNEL}`);
      this.pgListening = true;
      this.reconnectAttempts = 0;
    } catch (err) {
      this.pgListening = false;
      this.listenerClient = null;
      logger.warn({ err }, 'Global task PG LISTEN setup failed — using in-process dispatch until reconnect');
      this.schedulePgReconnect(gen);
    }
  }

  private schedulePgReconnect(gen: number): void {
    if (!this.running || gen !== this.startGeneration || !this.connectionString) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectPgListener(gen);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async handleConnection(ws: WebSocket, userId: string, db: Database): Promise<void> {
    if (!this.db) this.db = db;
    const sub: ClientSubscription = {
      ws,
      userId,
      db,
      serverIds: new Set<string>(),
      mutedServerIds: new Set<string>(),
    };
    this.clients.set(ws, sub);

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === GLOBAL_TASK_MODE_MSG.PING) {
        safeSendWs(ws, { type: GLOBAL_TASK_MODE_MSG.PONG });
        return;
      }
      if (msg.type === GLOBAL_TASK_MODE_MSG.SET_FILTER) {
        const rawMuted = Array.isArray(msg.mutedServerIds) ? msg.mutedServerIds : [];
        const nextMuted = new Set<string>();
        for (const item of rawMuted) {
          if (typeof item === 'string' && item.trim()) {
            nextMuted.add(item.trim());
            if (nextMuted.size >= MAX_MUTED_IDS) break;
          }
        }
        sub.mutedServerIds = nextMuted;
        void this.sendSnapshotToClient(sub).catch((err) => {
          logger.warn({ err, userId }, 'Failed to refresh snapshot after set_filter');
        });
        return;
      }
      if (msg.type === GLOBAL_TASK_MODE_MSG.REFRESH) {
        void this.sendSnapshotToClient(sub).catch((err) => {
          logger.warn({ err, userId }, 'Failed to refresh snapshot');
        });
      }
    });

    const cleanup = () => {
      this.clients.delete(ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    try {
      await this.sendSnapshotToClient(sub);
    } catch (err) {
      logger.warn({ err, userId }, 'Initial global-tasks snapshot send failed');
    }
  }

  private async sendSnapshotToClient(sub: ClientSubscription): Promise<void> {
    if (sub.ws.readyState !== WebSocket.OPEN) return;
    const snapshot = await listGlobalTaskSnapshotForUser(sub.db, sub.userId, [...sub.mutedServerIds]);
    sub.serverIds = new Set(snapshot.servers.map((s) => s.id));
    if (sub.ws.readyState !== WebSocket.OPEN) return;
    safeSendWs(sub.ws, {
      type: GLOBAL_TASK_MODE_MSG.SNAPSHOT,
      ...snapshot,
    });
  }

  /**
   * Recompute authorized servers for connected clients of a user (e.g. after team/server change).
   */
  async refreshUserAuthorization(userId: string): Promise<void> {
    for (const sub of this.clients.values()) {
      if (sub.userId !== userId) continue;
      const servers = await resolveAuthorizedFullServersForUser(sub.db, userId);
      sub.serverIds = new Set(servers.map((s) => s.id));
    }
  }

  async notifyTaskUpdated(
    db: Database | null,
    serverId: string,
    taskId: string,
    fallbackRow?: GlobalTaskSummaryRow,
  ): Promise<void> {
    const activeDb = db ?? this.db ?? null;
    const envelope: GlobalTaskNotifyEnvelope = {
      kind: 'task',
      serverId,
      taskId,
      ts: Date.now(),
    };
    await emitGlobalTaskPgNotify(activeDb, JSON.stringify(envelope));

    if (!this.pgListening) {
      const row = activeDb
        ? (await getGlobalTaskSummaryForServerTask(activeDb, serverId, taskId)) ?? fallbackRow ?? null
        : (fallbackRow ?? null);
      if (row) this.broadcastTaskUpsert(row);
    }
  }

  async notifyBrainText(
    db: Database | null,
    input: Omit<GlobalTaskBrainTextEvent, 'serverName'> & { serverName?: string },
  ): Promise<void> {
    const activeDb = db ?? this.db ?? null;
    const truncated = truncateGlobalBrainText(input.text, GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS);
    if (!truncated) return;

    let serverName = input.serverName?.trim() || '';
    if (!serverName && activeDb) {
      const meta = await getServerMetaForGlobalTask(activeDb, input.serverId);
      if (!meta) return;
      serverName = meta.name;
    }
    if (!serverName) serverName = input.serverId;

    const notifyObj: Record<string, unknown> = {
      kind: 'brain_text',
      serverId: input.serverId,
      serverName,
      sessionName: input.sessionName,
      ...(input.projectName ? { projectName: input.projectName } : {}),
      eventId: input.eventId,
      text: truncated,
      ts: input.ts,
    };
    const boundedJson = serializeBoundedPgNotifyPayload(notifyObj, 'text', GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);
    await emitGlobalTaskPgNotify(activeDb, boundedJson);

    if (!this.pgListening) {
      const parsed = JSON.parse(boundedJson) as Extract<GlobalTaskNotifyEnvelope, { kind: 'brain_text' }>;
      this.broadcastBrainText({
        serverId: parsed.serverId,
        serverName: parsed.serverName,
        sessionName: parsed.sessionName,
        ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
        eventId: parsed.eventId,
        text: parsed.text,
        ts: parsed.ts,
      });
    }
  }

  async notifyServerState(db: Database | null, serverId: string, online: boolean): Promise<void> {
    const activeDb = db ?? this.db ?? null;
    const envelope: GlobalTaskNotifyEnvelope = {
      kind: 'server_state',
      serverId,
      online,
      ts: Date.now(),
    };
    await emitGlobalTaskPgNotify(activeDb, JSON.stringify(envelope));

    if (!this.pgListening) {
      this.broadcastServerState(serverId, online);
    }
  }

  async handleNotifyPayload(rawPayload: string, dbOverride?: Database): Promise<void> {
    let parsed: GlobalTaskNotifyEnvelope;
    try {
      parsed = JSON.parse(rawPayload) as GlobalTaskNotifyEnvelope;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.kind === 'task') {
      const activeDb = dbOverride ?? this.db ?? this.clients.values().next().value?.db;
      if (!activeDb || !parsed.serverId || !parsed.taskId) return;
      const row = await getGlobalTaskSummaryForServerTask(activeDb, parsed.serverId, parsed.taskId);
      if (row) this.broadcastTaskUpsert(row);
      return;
    }

    if (parsed.kind === 'brain_text') {
      const text = truncateGlobalBrainText(parsed.text, GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS);
      if (!text || !parsed.serverId || !parsed.sessionName || !parsed.eventId) return;
      this.broadcastBrainText({
        serverId: parsed.serverId,
        serverName: parsed.serverName || parsed.serverId,
        sessionName: parsed.sessionName,
        ...(parsed.projectName ? { projectName: parsed.projectName } : {}),
        eventId: parsed.eventId,
        text,
        ts: Number(parsed.ts ?? Date.now()) || Date.now(),
      });
      return;
    }

    if (parsed.kind === 'server_state' && parsed.serverId) {
      this.broadcastServerState(parsed.serverId, Boolean(parsed.online));
    }
  }

  private broadcastTaskUpsert(task: GlobalTaskSummaryRow): void {
    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.UPSERT, task };
    for (const sub of this.clients.values()) {
      if (!sub.serverIds.has(task.serverId)) continue;
      if (sub.mutedServerIds.has(task.serverId)) continue;
      safeSendWs(sub.ws, frame);
    }
  }

  private broadcastBrainText(event: GlobalTaskBrainTextEvent): void {
    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT, event };
    for (const sub of this.clients.values()) {
      if (!sub.serverIds.has(event.serverId)) continue;
      if (sub.mutedServerIds.has(event.serverId)) continue;
      safeSendWs(sub.ws, frame);
    }
  }

  private broadcastServerState(serverId: string, online: boolean): void {
    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.SERVER_STATE, serverId, online };
    for (const sub of this.clients.values()) {
      if (!sub.serverIds.has(serverId)) continue;
      safeSendWs(sub.ws, frame);
    }
  }
}

export const globalTaskHub = new GlobalTaskHub();
