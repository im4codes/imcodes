import { WebSocket } from 'ws';
import {
  GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS,
  GLOBAL_TASK_MODE_MSG,
  GLOBAL_TASK_NOTIFY_CHANNEL,
  GLOBAL_TASK_PG_NOTIFY_MAX_BYTES,
  serializeBoundedPgNotifyPayload,
  truncateGlobalBrainText,
  type GlobalTaskBrainTextEvent,
  type GlobalTaskNotificationEvent,
  type GlobalTaskServerFrame,
  type GlobalTaskSummaryRow,
} from '../../../shared/global-task-mode.js';
import type { PushNotificationType } from '../../../shared/push-notifications.js';
import type { Database } from '../db/client.js';
import { pushStreamHub, type PushStreamHub } from './push-stream-hub.js';
import {
  emitGlobalTaskPgNotify,
  getGlobalTaskSummaryForServerTask,
  getServerMetaForGlobalTask,
  listGlobalTaskSnapshotForUser,
  resolveAuthorizedFullServersForUser,
} from '../db/global-task-summaries.js';
import { evaluateUserAccess, loadUserAccess } from '../security/user-status.js';
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
  | { kind: 'server_state'; serverId: string; online: boolean; ts: number }
  | {
    kind: 'notification';
    userId: string;
    eventId: string;
    title: string;
    body: string;
    notificationType?: PushNotificationType;
    serverId?: string;
    session?: string;
    taskId?: string;
    eventType?: string;
    ts: number;
  }
  | {
    kind: 'push_stream';
    userId: string;
    eventId: string;
    title: string;
    body: string;
    notificationType?: PushNotificationType;
    badge?: number;
    data?: Record<string, string>;
    ts: number;
  }
  | {
    kind: 'push_credential_revoked';
    userId: string;
    keyId?: string;
    allApiKeys?: boolean;
    sessionHash?: string;
    minIssuedAtMs?: number;
    ts: number;
  }
  | { kind: 'access_changed'; userId?: string; serverId?: string; ts: number };

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
  private pushStreamTarget: PushStreamHub;

  constructor(options?: { pushStreamHub?: PushStreamHub }) {
    this.pushStreamTarget = options?.pushStreamHub ?? pushStreamHub;
  }

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
   * Collect distinct active user IDs holding live Global Task Mode connections.
   */
  collectLiveUserIds(out: Set<string>): void {
    for (const sub of this.clients.values()) {
      if (sub.ws.readyState === WebSocket.OPEN) out.add(sub.userId);
    }
  }

  hasLiveUserSocket(userId: string): boolean {
    for (const sub of this.clients.values()) {
      if (sub.ws.readyState === WebSocket.OPEN && sub.userId === userId) return true;
    }
    return false;
  }

  /**
   * Immediately close live Global Task Mode sockets belonging to disabled/inactive accounts.
   */
  closeInactiveUserSockets(inactiveUserIds: ReadonlySet<string>): number {
    if (inactiveUserIds.size === 0) return 0;
    let closed = 0;
    for (const [ws, sub] of [...this.clients]) {
      if (!inactiveUserIds.has(sub.userId)) continue;
      this.clients.delete(ws);
      closed += 1;
      try { ws.close(1008, 'account_inactive'); } catch { /* ignore */ }
    }
    return closed;
  }

  /**
   * Re-sync a specific user's authorized servers and push a fresh filtered snapshot if access changed.
   */
  async refreshUserAuthorization(userId: string, pushSnapshotIfChanged = true): Promise<void> {
    const subs = [...this.clients.values()].filter((sub) => sub.userId === userId);
    if (subs.length === 0) return;
    await this.syncSubscriptionsBatch(subs, pushSnapshotIfChanged, pushSnapshotIfChanged);
  }

  /**
   * Re-sync clients when membership or server access for `serverId` / `userId` changes.
   */
  async notifyAccessChanged(
    db: Database | null,
    scope: { userId?: string; serverId?: string },
  ): Promise<void> {
    const activeDb = db ?? this.db ?? null;
    const envelope: GlobalTaskNotifyEnvelope = {
      kind: 'access_changed',
      ...(scope.userId ? { userId: scope.userId } : {}),
      ...(scope.serverId ? { serverId: scope.serverId } : {}),
      ts: Date.now(),
    };
    await emitGlobalTaskPgNotify(activeDb, JSON.stringify(envelope));
    if (!this.pgListening) {
      await this.applyAccessChanged(scope);
    }
  }

  async handleMachineGroupInvalidation(
    db: Database,
    scope: { actorId?: string; serverId?: string },
  ): Promise<void> {
    if (!this.db) this.db = db;
    await this.applyAccessChanged({ userId: scope.actorId, serverId: scope.serverId });
  }

  private async applyAccessChanged(scope: { userId?: string; serverId?: string }): Promise<void> {
    if (this.clients.size === 0) return;
    const targets = [...this.clients.values()].filter((sub) => {
      if (scope.userId && sub.userId !== scope.userId) return false;
      return true;
    });
    if (targets.length === 0) return;
    await this.syncSubscriptionsBatch(targets, true, true);
  }

  private async syncSubscriptionsBatch(
    subs: ClientSubscription[],
    pushSnapshotOnLoss: boolean,
    pushSnapshotOnGain: boolean,
  ): Promise<void> {
    const authCache = new Map<string, { allowed: boolean; serverIds: Set<string> }>();
    for (const sub of subs) {
      if (sub.ws.readyState !== WebSocket.OPEN || !this.clients.has(sub.ws)) continue;
      let resolved = authCache.get(sub.userId);
      if (!resolved) {
        const userAccess = await loadUserAccess(sub.db, sub.userId);
        const decision = evaluateUserAccess(userAccess, undefined);
        if (!decision.ok) {
          resolved = { allowed: false, serverIds: new Set<string>() };
        } else {
          const servers = await resolveAuthorizedFullServersForUser(sub.db, sub.userId);
          resolved = { allowed: true, serverIds: new Set(servers.map((s) => s.id)) };
        }
        authCache.set(sub.userId, resolved);
      }

      if (!resolved.allowed) {
        this.clients.delete(sub.ws);
        try { sub.ws.close(1008, 'account_inactive'); } catch { /* ignore */ }
        continue;
      }

      const lostAccess = [...sub.serverIds].some((id) => !resolved.serverIds.has(id));
      const gainedAccess = [...resolved.serverIds].some((id) => !sub.serverIds.has(id));
      sub.serverIds = new Set(resolved.serverIds);
      if ((lostAccess && pushSnapshotOnLoss) || (gainedAccess && pushSnapshotOnGain)) {
        await this.sendSnapshotToClient(sub);
      }
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
      if (row) await this.broadcastTaskUpsert(row);
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
      await this.broadcastBrainText({
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
      await this.broadcastServerState(serverId, online);
    }
  }

  async notifyPushNotification(
    db: Database | null,
    input: {
      userId: string;
      eventId: string;
      title: string;
      body: string;
      notificationType?: PushNotificationType;
      serverId?: string;
      session?: string;
      taskId?: string;
      eventType?: string;
      ts?: number;
    },
  ): Promise<void> {
    if (!input.userId || !input.eventId || !input.title) return;
    const activeDb = db ?? this.db ?? null;
    const notifyObj: Record<string, unknown> = {
      kind: 'notification',
      userId: input.userId,
      eventId: input.eventId,
      title: input.title,
      body: input.body ?? '',
      ...(input.notificationType ? { notificationType: input.notificationType } : {}),
      ...(input.serverId ? { serverId: input.serverId } : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ts: Number(input.ts ?? Date.now()) || Date.now(),
    };
    const boundedJson = serializeBoundedPgNotifyPayload(notifyObj, 'body', GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);
    await emitGlobalTaskPgNotify(activeDb, boundedJson);

    if (!this.pgListening) {
      const parsed = JSON.parse(boundedJson) as Extract<GlobalTaskNotifyEnvelope, { kind: 'notification' }>;
      await this.broadcastUserNotification(parsed.userId, {
        eventId: parsed.eventId,
        title: parsed.title,
        body: parsed.body,
        ...(parsed.notificationType ? { notificationType: parsed.notificationType } : {}),
        ...(parsed.serverId ? { serverId: parsed.serverId } : {}),
        ...(parsed.session ? { session: parsed.session } : {}),
        ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
        ...(parsed.eventType ? { eventType: parsed.eventType } : {}),
        ts: parsed.ts,
      });
    }
  }

  async notifyPushStream(
    db: Database | null,
    input: {
      userId: string;
      eventId: string;
      title: string;
      body: string;
      notificationType?: PushNotificationType;
      badge?: number;
      data?: Record<string, string>;
      ts?: number;
    },
  ): Promise<void> {
    if (!input.userId || !input.eventId || !input.title) return;
    const activeDb = db ?? this.db ?? null;
    const notifyObj: Record<string, unknown> = {
      kind: 'push_stream',
      userId: input.userId,
      eventId: input.eventId,
      title: input.title,
      body: input.body ?? '',
      ...(input.notificationType ? { notificationType: input.notificationType } : {}),
      ...(input.badge != null ? { badge: input.badge } : {}),
      ...(input.data ? { data: input.data } : {}),
      ts: Number(input.ts ?? Date.now()) || Date.now(),
    };
    const boundedJson = serializeBoundedPgNotifyPayload(notifyObj, 'body', GLOBAL_TASK_PG_NOTIFY_MAX_BYTES);
    await emitGlobalTaskPgNotify(activeDb, boundedJson);

    if (!this.pgListening) {
      const parsed = JSON.parse(boundedJson) as Extract<GlobalTaskNotifyEnvelope, { kind: 'push_stream' }>;
      this.pushStreamTarget.publish(parsed.userId, {
        id: parsed.eventId,
        title: parsed.title,
        body: parsed.body,
        ...(parsed.notificationType ? { type: parsed.notificationType } : {}),
        ...(parsed.badge != null ? { badge: parsed.badge } : {}),
        ...(parsed.data ? { data: parsed.data } : {}),
      });
    }
  }

  async notifyPushCredentialRevoked(
    db: Database | null,
    input: {
      userId: string;
      keyId?: string;
      allApiKeys?: boolean;
      sessionHash?: string;
      minIssuedAtMs?: number;
    },
  ): Promise<void> {
    if (!input.userId) return;
    const activeDb = db ?? this.db ?? null;
    const envelope: GlobalTaskNotifyEnvelope = {
      kind: 'push_credential_revoked',
      userId: input.userId,
      ...(input.keyId ? { keyId: input.keyId } : {}),
      ...(input.allApiKeys ? { allApiKeys: true } : {}),
      ...(input.sessionHash ? { sessionHash: input.sessionHash } : {}),
      ...(typeof input.minIssuedAtMs === 'number' ? { minIssuedAtMs: input.minIssuedAtMs } : {}),
      ts: Date.now(),
    };
    await emitGlobalTaskPgNotify(activeDb, JSON.stringify(envelope));

    if (!this.pgListening) {
      this.applyPushCredentialRevoked(envelope);
    }
  }

  private applyPushCredentialRevoked(
    input: {
      userId: string;
      keyId?: string;
      allApiKeys?: boolean;
      sessionHash?: string;
      minIssuedAtMs?: number;
    },
  ): void {
    if (input.keyId) {
      this.pushStreamTarget.closeByApiKey(input.userId, input.keyId);
    }
    if (input.allApiKeys) {
      this.pushStreamTarget.closeByAllUserApiKeys(input.userId);
    }
    if (input.sessionHash || typeof input.minIssuedAtMs === 'number') {
      this.pushStreamTarget.closeByJwtSession(input.userId, {
        ...(input.sessionHash ? { sessionHash: input.sessionHash } : {}),
        ...(typeof input.minIssuedAtMs === 'number' ? { minIssuedAtMs: input.minIssuedAtMs } : {}),
      });
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
      if (row) await this.broadcastTaskUpsert(row);
      return;
    }

    if (parsed.kind === 'brain_text') {
      const text = truncateGlobalBrainText(parsed.text, GLOBAL_TASK_BRAIN_TEXT_MAX_CHARS);
      if (!text || !parsed.serverId || !parsed.sessionName || !parsed.eventId) return;
      await this.broadcastBrainText({
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
      await this.broadcastServerState(parsed.serverId, Boolean(parsed.online));
      return;
    }

    if (parsed.kind === 'notification') {
      if (!parsed.userId || !parsed.eventId || !parsed.title) return;
      await this.broadcastUserNotification(parsed.userId, {
        eventId: parsed.eventId,
        title: parsed.title,
        body: typeof parsed.body === 'string' ? parsed.body : '',
        ...(parsed.notificationType ? { notificationType: parsed.notificationType } : {}),
        ...(parsed.serverId ? { serverId: parsed.serverId } : {}),
        ...(parsed.session ? { session: parsed.session } : {}),
        ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
        ...(parsed.eventType ? { eventType: parsed.eventType } : {}),
        ts: Number(parsed.ts ?? Date.now()) || Date.now(),
      });
      return;
    }

    if (parsed.kind === 'push_stream') {
      if (!parsed.userId || !parsed.eventId || !parsed.title) return;
      this.pushStreamTarget.publish(parsed.userId, {
        id: parsed.eventId,
        title: parsed.title,
        body: typeof parsed.body === 'string' ? parsed.body : '',
        ...(parsed.notificationType ? { type: parsed.notificationType } : {}),
        ...(typeof parsed.badge === 'number' ? { badge: parsed.badge } : {}),
        ...(parsed.data ? { data: parsed.data } : {}),
      });
      return;
    }

    if (parsed.kind === 'push_credential_revoked') {
      if (!parsed.userId) return;
      this.applyPushCredentialRevoked(parsed);
      return;
    }

    if (parsed.kind === 'access_changed') {
      await this.applyAccessChanged({ userId: parsed.userId, serverId: parsed.serverId });
    }
  }

  private async collectAuthorizedRecipients(
    serverId: string,
    respectMuted: boolean,
  ): Promise<ClientSubscription[]> {
    const candidates = [...this.clients.values()].filter((sub) => {
      if (sub.ws.readyState !== WebSocket.OPEN) return false;
      if (!sub.serverIds.has(serverId)) return false;
      return true;
    });
    if (candidates.length === 0) return [];

    // Re-verify live DB access for every candidate user before delivering any event
    // so team_members removal, server revocation, or account disablement stops pushes
    // immediately even across pods or direct DB updates, and purges stale client caches.
    await this.syncSubscriptionsBatch(candidates, true, false);

    return candidates.filter((sub) => (
      this.clients.has(sub.ws)
      && sub.ws.readyState === WebSocket.OPEN
      && sub.serverIds.has(serverId)
      && (!respectMuted || !sub.mutedServerIds.has(serverId))
    ));
  }

  private async broadcastTaskUpsert(task: GlobalTaskSummaryRow): Promise<void> {
    const recipients = await this.collectAuthorizedRecipients(task.serverId, true);
    if (recipients.length === 0) return;
    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.UPSERT, task };
    for (const sub of recipients) {
      safeSendWs(sub.ws, frame);
    }
  }

  private async broadcastBrainText(event: GlobalTaskBrainTextEvent): Promise<void> {
    const recipients = await this.collectAuthorizedRecipients(event.serverId, true);
    if (recipients.length === 0) return;
    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.BRAIN_TEXT, event };
    for (const sub of recipients) {
      safeSendWs(sub.ws, frame);
    }
  }

  private async broadcastServerState(serverId: string, online: boolean): Promise<void> {
    const recipients = await this.collectAuthorizedRecipients(serverId, false);
    if (recipients.length === 0) return;
    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.SERVER_STATE, serverId, online };
    for (const sub of recipients) {
      safeSendWs(sub.ws, frame);
    }
  }

  private async broadcastUserNotification(userId: string, event: GlobalTaskNotificationEvent): Promise<void> {
    const candidates = [...this.clients.values()].filter(
      (sub) => sub.ws.readyState === WebSocket.OPEN && sub.userId === userId,
    );
    if (candidates.length === 0) return;

    const activeDb = candidates[0]!.db;
    const userAccess = await loadUserAccess(activeDb, userId);
    const decision = evaluateUserAccess(userAccess, undefined);
    if (!decision.ok) {
      for (const sub of candidates) {
        this.clients.delete(sub.ws);
        try { sub.ws.close(1008, 'account_inactive'); } catch { /* ignore */ }
      }
      return;
    }

    const frame: GlobalTaskServerFrame = { type: GLOBAL_TASK_MODE_MSG.NOTIFICATION, event };
    for (const sub of candidates) {
      if (this.clients.has(sub.ws) && sub.ws.readyState === WebSocket.OPEN) {
        safeSendWs(sub.ws, frame);
      }
    }
  }
}

export const globalTaskHub = new GlobalTaskHub();
