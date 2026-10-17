import type pg from 'pg';
import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Database } from '../db/client.js';
import { MACHINE_GROUP_INVALIDATION as POLICY, type MachineGroupInvalidationScope } from '../../../shared/machine-group-invalidation.js';

interface InvalidationRow {
  id: string;
  team_id: string | null;
  server_id: string | null;
  actor_id: string | null;
}
const runtimes = new WeakMap<Database, MachineGroupInvalidationRuntime>();
const databaseNow = '(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint';

/** Embedded single-process apps have no distributed runtime. Production installs it BEFORE accepting connections. */
export function machineGroupInvalidationReady(db: Database | null): boolean {
  if (!db) return false;
  const runtime = runtimes.get(db);
  return runtime === undefined || runtime.ready();
}

export class MachineGroupRevalidationPending extends HTTPException {
  constructor(readonly eventId: string) {
    super(503, { res: Response.json({ error: POLICY.PENDING, applied: true, eventId }, { status: 503 }) });
  }
}

/** Commit-ordered revision, independent of notification delivery. Old SQL snapshots cannot borrow a later revoke. */
export async function machineGroupInvalidationRevision(db: Database): Promise<number> {
  if (!runtimes.has(db)) return 0; // Embedded single-process apps use their synchronous local epoch.
  const row = await db.queryOne<{ revision: number }>('SELECT revision FROM machine_group_invalidation_epoch WHERE singleton = TRUE');
  if (!row) throw new Error(POLICY.UNAVAILABLE);
  return row.revision;
}

/** Atomic mutation+durable intent. A success is not reported until every captured live pod has fenced its old snapshots. */
export async function mutateMachineGroupAccess(
  db: Database, scope: MachineGroupInvalidationScope,
  mutate: (transaction: Database) => Promise<unknown>,
  applyLocal: (scope: MachineGroupInvalidationScope) => Promise<void>,
): Promise<void> {
  const runtime = runtimes.get(db);
  if (!runtime) { // Explicit embedded/test mode: all its sockets are in this process.
    await mutate(db);
    await applyLocal(scope);
    return;
  }
  const eventId = randomUUID();
  await db.transaction(async (tx) => {
    // Serialize mutation commits, not sequence allocation: an earlier allocation cannot commit after and hide behind a later revision.
    await tx.execute('UPDATE machine_group_invalidation_epoch SET revision = revision + 1 WHERE singleton = TRUE');
    await mutate(tx);
    await tx.execute(
      `INSERT INTO machine_group_invalidations (id, created_at, team_id, server_id, actor_id, recipients)
       VALUES ($1, ${databaseNow}, $2, $3, $4,
         ARRAY(SELECT id FROM machine_group_invalidation_receivers WHERE expires_at > ${databaseNow}))`,
      [eventId, scope.teamId ?? null, scope.serverId ?? null, scope.actorId ?? null],
    );
    await tx.query('SELECT pg_notify($1, $2)', [POLICY.CHANNEL, eventId]);
  });
  // Even the publishing pod may own no node. It still waits for the other pods' durable receipts.
  runtime.wake();
  const end = performance.now() + POLICY.WAIT_TIMEOUT_MS;
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MachineGroupRevalidationPending(eventId)), Math.max(0, end - performance.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    await bounded(applyLocal(scope));
    while (performance.now() < end) {
      const row = await bounded(db.queryOne<{ complete: boolean }>(
        'SELECT recipients <@ acknowledgements AS complete FROM machine_group_invalidations WHERE id = $1', [eventId],
      ));
      if (row?.complete) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch {
    // Also bound local fencing and receipt queries: a stalled connection is not a successful fence.
    throw new MachineGroupRevalidationPending(eventId);
  }
  // Mutation is durably applied, but NEVER a success pretending an offline receiver acknowledged.
  throw new MachineGroupRevalidationPending(eventId);
}

/** LISTEN is a fast wake only. Durable per-recipient polling survives a dropped notification/reconnect. */
export class MachineGroupInvalidationRuntime {
  readonly receiverId = randomUUID();
  private stopped = true;
  private healthyUntil = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listener: pg.Client | null = null;
  private listenerGeneration = 0;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private nextCleanup = 0;

  constructor(
    private readonly db: Database,
    private readonly apply: (scope: MachineGroupInvalidationScope) => Promise<void>,
    private readonly unavailable: () => void,
    private readonly connectionString?: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  ready(): boolean { return !this.stopped && performance.now() < this.healthyUntil; }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    runtimes.set(this.db, this);
    await this.tick(); // Register/restore before ANY HTTP/WS admission on this pod.
    if (!this.ready()) throw new Error(POLICY.UNAVAILABLE);
    this.timer = setInterval(() => {
      if (!this.ready()) this.unavailable(); // Includes a hung DB query and recovery after a paused process.
      this.wake();
    }, POLICY.POLL_MS);
    this.timer.unref?.();
    if (this.connectionString) void this.listen();
  }

  wake(): void { void this.tick(); }

  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = this.poll().catch((error) => {
      this.healthyUntil = 0;
      this.unavailable(); // Synchronous epoch fence/close, before retry or lease expiration.
      this.onError(error);
    }).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.wake(); }
    });
    return this.running;
  }

  private async poll(): Promise<void> {
    // DB clock determines fleet liveness; local monotonic clock stops a paused pod from serving a buffered old read after its lease.
    await this.db.execute(
      `INSERT INTO machine_group_invalidation_receivers (id, expires_at) VALUES ($1, ${databaseNow} + $2)
       ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at`, [this.receiverId, POLICY.RECEIVER_LEASE_MS],
    );
    const healthyUntil = performance.now() + POLICY.AUTHORITY_HEALTH_MS - POLICY.POLL_MS;
    const events = await this.db.query<InvalidationRow>(
      `SELECT id, team_id, server_id, actor_id FROM machine_group_invalidations
       WHERE recipients @> ARRAY[$1]::text[] AND NOT recipients <@ acknowledgements
         AND NOT acknowledgements @> ARRAY[$1]::text[] ORDER BY created_at, id LIMIT $2`,
      [this.receiverId, POLICY.BATCH_SIZE],
    );
    for (const event of events) {
      if (this.stopped) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.apply({ teamId: event.team_id ?? undefined, serverId: event.server_id ?? undefined, actorId: event.actor_id ?? undefined }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(POLICY.UNAVAILABLE)), POLICY.APPLY_TIMEOUT_MS); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      if (this.stopped) return;
      await this.db.execute(
        `UPDATE machine_group_invalidations SET acknowledgements = array_append(acknowledgements, $2)
         WHERE id = $1 AND NOT acknowledgements @> ARRAY[$2]::text[]`, [event.id, this.receiverId],
      );
    }
    this.healthyUntil = healthyUntil;
    if (events.length === POLICY.BATCH_SIZE) this.again = true;
    if (performance.now() >= this.nextCleanup) {
      this.nextCleanup = performance.now() + 60_000;
      await this.db.execute(`DELETE FROM machine_group_invalidations WHERE created_at < ${databaseNow} - $1`, [POLICY.RETENTION_MS]);
      await this.db.execute(`DELETE FROM machine_group_invalidation_receivers WHERE expires_at < ${databaseNow} - $1`, [POLICY.RETENTION_MS]);
    }
  }

  private async listen(): Promise<void> {
    if (this.stopped || !this.connectionString) return;
    const generation = ++this.listenerGeneration;
    const current = () => !this.stopped && this.listenerGeneration === generation;
    let client: pg.Client | null = null;
    const retry = () => {
      if (!current() || (client && this.listener !== client)) return;
      this.listener = null;
      if (client) void client.end().catch(() => {});
      if (!this.reconnect) {
        this.reconnect = setTimeout(() => { this.reconnect = null; void this.listen(); }, POLICY.POLL_MS);
        this.reconnect.unref?.();
      }
    };
    try {
      // Thin bridge/router consumers need only readiness/revision, not the
      // server's optional notification driver. Polling remains authoritative.
      const { default: driver } = await import('pg');
      if (!current()) return; // stop (or stop/start) may have won during loading.
      client = new driver.Client({ connectionString: this.connectionString, application_name: `${POLICY.LISTENER_APPLICATION_PREFIX}${this.receiverId}` });
      this.listener = client;
      client.on('notification', (notification) => {
        if (current() && this.listener === client && notification.channel === POLICY.CHANNEL) this.wake();
      });
      client.on('error', retry);
      client.on('end', retry);
      await client.connect();
      if (!current() || this.listener !== client) { await client.end().catch(() => {}); return; }
      await client.query(`LISTEN ${POLICY.CHANNEL}`);
      if (current() && this.listener === client) this.wake();
    }
    catch { retry(); } // Poller remains authoritative, even when LISTEN is unavailable.
  }

  async stop(): Promise<void> {
    this.stopped = true;
    ++this.listenerGeneration; // Invalidate imports/connects from this lifecycle.
    this.healthyUntil = 0;
    this.unavailable(); // Close/fence this pod BEFORE it stops being a required receiver.
    if (this.timer) clearInterval(this.timer);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.timer = this.reconnect = null;
    const listener = this.listener; this.listener = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        await listener?.end().catch(() => {});
        await this.running;
        await this.db.transaction(async (tx) => {
          await tx.execute(`UPDATE machine_group_invalidations SET acknowledgements = array_append(acknowledgements, $1)
            WHERE recipients @> ARRAY[$1]::text[] AND NOT acknowledgements @> ARRAY[$1]::text[]`, [this.receiverId]);
          await tx.execute('DELETE FROM machine_group_invalidation_receivers WHERE id = $1', [this.receiverId]);
        });
      })(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(POLICY.UNAVAILABLE)), POLICY.APPLY_TIMEOUT_MS);
      })]);
    } catch (error) {
      // Already fenced. A DB outage may leave this receiver required until its conservative lease expires, never a fake ack.
      this.onError(error);
    } finally { if (timer) clearTimeout(timer); }
    // Keep stopped authority in the WeakMap: shutdown must NOT revert to embedded-mode allow.
  }
}
