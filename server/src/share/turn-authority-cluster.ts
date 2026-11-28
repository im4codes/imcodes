import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import type { ShareTarget } from '../../../shared/tab-sharing.js';
import { getPodIdentity } from '../util/pod-identity.js';
import logger from '../util/logger.js';

/** PostgreSQL NOTIFY/LISTEN channel carrying zero-persistence turn-authority verification RPCs across pods. */
export const TURN_AUTHORITY_CLUSTER_NOTIFY_CHANNEL = 'imcodes_turn_authority_rpc';
const DEFAULT_CLUSTER_RPC_TIMEOUT_MS = 400;
const DEFAULT_PG_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_PG_LISTEN_TIMEOUT_MS = 5_000;
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RemoteTurnAuthorityGrantMeta {
  tokenHash: string;
  serverId: string;
  rootSessionName: string;
  sessionName: string;
  projectName: string;
  actorUserId: string;
  ownerUserId: string;
  kind: 'owner' | 'participant';
  shareTarget?: ShareTarget;
  actionId: string;
  createdAt: number;
}

export type TurnAuthorityClusterLookupOutcome =
  | { found: true; ownerPodId: string; grant: RemoteTurnAuthorityGrantMeta }
  | { found: false; authoritative?: boolean };

export interface TurnAuthorityClusterVerifier {
  lookupGrant(
    tokenHash: string,
    serverId: string,
    now: number,
  ): Promise<TurnAuthorityClusterLookupOutcome | null>;
  confirmAndSlideGrant(
    ownerPodId: string,
    tokenHash: string,
    serverId: string,
    expectedCreatedAt: number,
    now: number,
  ): Promise<boolean>;
}

export interface LocalTurnAuthorityHostHandlers {
  lookupLocalGrant(
    tokenHash: string,
    serverId: string,
    now: number,
  ): { found: true; grant: RemoteTurnAuthorityGrantMeta } | { found: false; ownsConnectedDaemon: boolean };
  confirmAndSlideLocalGrant(
    tokenHash: string,
    serverId: string,
    expectedCreatedAt: number,
    now: number,
  ): boolean;
}

type RpcWireMessage =
  | {
      kind: 'lookup_req';
      requestId: string;
      replyPodId: string;
      tokenHash: string;
      serverId: string;
      now: number;
    }
  | {
      kind: 'lookup_res';
      requestId: string;
      targetPodId: string;
      ownerPodId: string;
      found: boolean;
      authoritative?: boolean;
      grant?: RemoteTurnAuthorityGrantMeta;
    }
  | {
      kind: 'confirm_req';
      requestId: string;
      replyPodId: string;
      targetPodId: string;
      tokenHash: string;
      serverId: string;
      expectedCreatedAt: number;
      now: number;
    }
  | {
      kind: 'confirm_res';
      requestId: string;
      targetPodId: string;
      ok: boolean;
    };

export interface PgNotifyListenerClient {
  connect(): Promise<unknown>;
  query: (sql: string) => Promise<unknown>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  end: () => Promise<unknown>;
}

function isPostgresUrl(connectionString: string | undefined): connectionString is string {
  if (!connectionString) return false;
  const trimmed = connectionString.trim().toLowerCase();
  return trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pure in-memory cross-pod turn-authority verifier backed by PostgreSQL LISTEN/NOTIFY
 * (sending only `tokenHash`, never raw `trg_` tokens, with zero database or disk writes).
 */
export class PgNotifyTurnAuthorityCluster implements TurnAuthorityClusterVerifier {
  private readonly getPodId: () => string;
  private readonly rpcTimeoutMs: number;
  private readonly pgClientFactory?: (connectionString: string) => PgNotifyListenerClient;
  private readonly retiredClients = new WeakSet<PgNotifyListenerClient>();

  private hostHandlers: LocalTurnAuthorityHostHandlers | null = null;
  private db: Pick<Database, 'query'> | null = null;
  private listenerClient: PgNotifyListenerClient | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private startGeneration = 0;
  private running = false;

  private readonly pendingLookups = new Map<string, {
    resolve: (outcome: TurnAuthorityClusterLookupOutcome) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly pendingConfirms = new Map<string, {
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(options?: {
    podId?: () => string;
    rpcTimeoutMs?: number;
    pgClientFactory?: (connectionString: string) => PgNotifyListenerClient;
  }) {
    this.getPodId = options?.podId ?? getPodIdentity;
    this.rpcTimeoutMs = options?.rpcTimeoutMs ?? DEFAULT_CLUSTER_RPC_TIMEOUT_MS;
    this.pgClientFactory = options?.pgClientFactory;
  }

  bindLocalHandlers(handlers: LocalTurnAuthorityHostHandlers | null): void {
    this.hostHandlers = handlers;
  }

  async start(connectionString: string | undefined, db: Pick<Database, 'query'>): Promise<void> {
    this.db = db;
    this.running = true;
    const generation = ++this.startGeneration;
    if (!isPostgresUrl(connectionString)) return;
    await this.connectListener(connectionString, generation);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.startGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pendingLookups) {
      clearTimeout(pending.timer);
      pending.resolve({ found: false });
    }
    this.pendingLookups.clear();
    for (const [, pending] of this.pendingConfirms) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingConfirms.clear();
    const client = this.listenerClient;
    this.listenerClient = null;
    if (client) {
      this.retiredClients.add(client);
      await client.end().catch(() => {});
    }
    this.db = null;
  }

  private async connectListener(connectionString: string, generation: number): Promise<void> {
    if (!this.running || this.startGeneration !== generation) return;
    let client: PgNotifyListenerClient | null = null;
    try {
      if (this.pgClientFactory) {
        client = this.pgClientFactory(connectionString);
      } else {
        const { Client } = await import('pg');
        client = new Client({ connectionString }) as unknown as PgNotifyListenerClient;
      }
      if (!this.running || this.startGeneration !== generation) {
        await client.end().catch(() => {});
        return;
      }
      client.on('notification', (msg: { channel?: string; payload?: string }) => {
        if (msg.channel !== TURN_AUTHORITY_CLUSTER_NOTIFY_CHANNEL || !msg.payload) return;
        this.handleRawWirePayload(msg.payload);
      });
      client.on('error', (err: unknown) => {
        if (client && this.retiredClients.has(client)) return;
        logger.warn({ err }, 'TurnAuthorityCluster PG listener error; scheduling reconnect');
        this.scheduleReconnect(connectionString, generation);
      });
      client.on('end', () => {
        if (client && this.retiredClients.has(client)) return;
        if (!this.running || this.startGeneration !== generation) return;
        this.scheduleReconnect(connectionString, generation);
      });
      await withTimeout(client.connect(), DEFAULT_PG_CONNECT_TIMEOUT_MS, 'turn_authority_pg_connect_timeout');
      await withTimeout(
        client.query(`LISTEN ${TURN_AUTHORITY_CLUSTER_NOTIFY_CHANNEL}`),
        DEFAULT_PG_LISTEN_TIMEOUT_MS,
        'turn_authority_pg_listen_timeout',
      );
      if (!this.running || this.startGeneration !== generation) {
        this.retiredClients.add(client);
        await client.end().catch(() => {});
        return;
      }
      this.listenerClient = client;
      this.reconnectAttempts = 0;
    } catch (err) {
      logger.warn({ err }, 'TurnAuthorityCluster failed to attach PG listener');
      if (client) {
        this.retiredClients.add(client);
        await client.end().catch(() => {});
      }
      this.scheduleReconnect(connectionString, generation);
    }
  }

  private scheduleReconnect(connectionString: string, generation: number): void {
    if (!this.running || this.startGeneration !== generation || this.reconnectTimer) return;
    const oldClient = this.listenerClient;
    this.listenerClient = null;
    if (oldClient) {
      this.retiredClients.add(oldClient);
      void oldClient.end().catch(() => {});
    }
    const delayMs = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener(connectionString, generation);
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async publish(msg: RpcWireMessage): Promise<void> {
    if (!this.db) return;
    await this.db.query('SELECT pg_notify($1, $2)', [
      TURN_AUTHORITY_CLUSTER_NOTIFY_CHANNEL,
      JSON.stringify(msg),
    ]);
  }

  /** Exposed for unit tests driving raw RPC payloads cleanly. */
  handleRawWirePayload(raw: string): void {
    let parsed: RpcWireMessage;
    try {
      parsed = JSON.parse(raw) as RpcWireMessage;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const myPodId = this.getPodId();

    if (parsed.kind === 'lookup_req') {
      if (parsed.replyPodId === myPodId || !this.hostHandlers) return;
      const local = this.hostHandlers.lookupLocalGrant(parsed.tokenHash, parsed.serverId, parsed.now);
      if (local.found) {
        void this.publish({
          kind: 'lookup_res',
          requestId: parsed.requestId,
          targetPodId: parsed.replyPodId,
          ownerPodId: myPodId,
          found: true,
          grant: local.grant,
        }).catch(() => {});
      } else if (local.ownsConnectedDaemon) {
        void this.publish({
          kind: 'lookup_res',
          requestId: parsed.requestId,
          targetPodId: parsed.replyPodId,
          ownerPodId: myPodId,
          found: false,
          authoritative: true,
        }).catch(() => {});
      }
      return;
    }

    if (parsed.kind === 'lookup_res') {
      if (parsed.targetPodId !== myPodId) return;
      const pending = this.pendingLookups.get(parsed.requestId);
      if (!pending) return;
      if (parsed.found && parsed.grant) {
        clearTimeout(pending.timer);
        this.pendingLookups.delete(parsed.requestId);
        pending.resolve({ found: true, ownerPodId: parsed.ownerPodId, grant: parsed.grant });
      } else if (parsed.authoritative) {
        clearTimeout(pending.timer);
        this.pendingLookups.delete(parsed.requestId);
        pending.resolve({ found: false, authoritative: true });
      }
      return;
    }

    if (parsed.kind === 'confirm_req') {
      if (parsed.targetPodId !== myPodId || !this.hostHandlers) return;
      const ok = this.hostHandlers.confirmAndSlideLocalGrant(
        parsed.tokenHash,
        parsed.serverId,
        parsed.expectedCreatedAt,
        parsed.now,
      );
      void this.publish({
        kind: 'confirm_res',
        requestId: parsed.requestId,
        targetPodId: parsed.replyPodId,
        ok,
      }).catch(() => {});
      return;
    }

    if (parsed.kind === 'confirm_res') {
      if (parsed.targetPodId !== myPodId) return;
      const pending = this.pendingConfirms.get(parsed.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingConfirms.delete(parsed.requestId);
      pending.resolve(Boolean(parsed.ok));
    }
  }

  async lookupGrant(
    tokenHash: string,
    serverId: string,
    now: number,
  ): Promise<TurnAuthorityClusterLookupOutcome | null> {
    if (!this.db || !this.listenerClient) return null;
    const requestId = randomUUID();
    const wait = new Promise<TurnAuthorityClusterLookupOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingLookups.delete(requestId);
        resolve({ found: false });
      }, this.rpcTimeoutMs);
      timer.unref?.();
      this.pendingLookups.set(requestId, { resolve, timer });
    });
    try {
      await this.publish({
        kind: 'lookup_req',
        requestId,
        replyPodId: this.getPodId(),
        tokenHash,
        serverId,
        now,
      });
    } catch {
      const pending = this.pendingLookups.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingLookups.delete(requestId);
      }
      return { found: false };
    }
    return wait;
  }

  async confirmAndSlideGrant(
    ownerPodId: string,
    tokenHash: string,
    serverId: string,
    expectedCreatedAt: number,
    now: number,
  ): Promise<boolean> {
    if (!this.db || !this.listenerClient) return false;
    const requestId = randomUUID();
    const wait = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingConfirms.delete(requestId);
        resolve(false);
      }, this.rpcTimeoutMs);
      timer.unref?.();
      this.pendingConfirms.set(requestId, { resolve, timer });
    });
    try {
      await this.publish({
        kind: 'confirm_req',
        requestId,
        replyPodId: this.getPodId(),
        targetPodId: ownerPodId,
        tokenHash,
        serverId,
        expectedCreatedAt,
        now,
      });
    } catch {
      const pending = this.pendingConfirms.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingConfirms.delete(requestId);
      }
      return false;
    }
    return wait;
  }
}

export const defaultTurnAuthorityCluster = new PgNotifyTurnAuthorityCluster();
