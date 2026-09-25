/**
 * Daemon-side cache of the user's global supervision defaults.
 *
 * Automatic supervision has one account-level runtime selection shared by
 * every session. Session snapshots retain a compatibility mirror, but cannot
 * be authoritative because editing a different session would leave them
 * stale. The daemon therefore refreshes the user's current defaults at
 * startup, on WS reconnect, and every five seconds.
 *
 * PostgreSQL (via the server's `/supervision/user-defaults/daemon` route) is
 * the single source of truth. This module keeps two local mirrors of it:
 *
 *  - An in-memory value (`cachedSupervisorDefaults`), read synchronously by
 *    every consumer on every call -- this is what `getCachedSupervisorDefaults()`
 *    and `overlayCachedExecutionPools()` actually use.
 *  - A one-row SQLite table (`~/.imcodes/supervisor-defaults-cache.sqlite`),
 *    written every time a fetch actually changes the in-memory value, and
 *    read back ONCE at module load to seed the in-memory value immediately.
 *    Without this, a daemon that just restarted or just upgraded has an
 *    empty in-memory cache until its first successful round trip to the
 *    server completes -- ordinarily under a second, but a real gap during
 *    exactly the moments (restart, upgrade) most likely to also have a
 *    network hiccup. The disk copy closes that gap: it survives the
 *    process across a restart the way the in-memory value cannot.
 *
 * The cache is best-effort: fetch failures do not throw; the daemon falls
 * through to the session mirror until a successful fetch. Once populated
 * (from either source), the cache is authoritative for primary/backup
 * runtime, timeout, prompt version, global instructions, and -- once the
 * account has actually configured one -- the execution pools.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import logger from '../util/logger.js';
import { loadCredentials } from '../bind/bind-flow.js';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';
import {
  normalizeSupervisorDefaultConfig,
  type SessionSupervisionSnapshot,
  type SupervisorDefaultConfig,
} from '../../shared/supervision-config.js';

const require = createRequire(import.meta.url);
suppressSqliteExperimentalWarning();
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const DEFAULT_DB_PATH = join(homedir(), '.imcodes', 'supervisor-defaults-cache.sqlite');

function resolveDbPath(): string {
  return process.env.IMCODES_SUPERVISOR_DEFAULTS_CACHE_DB_PATH?.trim()
    || (process.env.VITEST ? ':memory:' : DEFAULT_DB_PATH);
}

let db: DatabaseSyncInstance | null = null;

function getDb(): DatabaseSyncInstance {
  if (db) return db;
  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const opened = new DatabaseSync(dbPath);
  opened.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS supervisor_defaults_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db = opened;
  return opened;
}

/** Best-effort: a locked or corrupt local file must never block startup. */
function loadCachedSupervisorDefaultsFromDisk(): SupervisorDefaultConfig | null {
  try {
    const row = getDb().prepare('SELECT value FROM supervisor_defaults_cache WHERE id = 1').get() as
      { value?: unknown } | undefined;
    if (!row || typeof row.value !== 'string') return null;
    return normalizeSupervisorDefaultConfig(JSON.parse(row.value));
  } catch (err) {
    logger.debug({ err }, 'supervisor-defaults-cache: disk read failed — starting cold');
    return null;
  }
}

/** Best-effort: a write failure keeps the in-memory value authoritative for this run. */
function persistCachedSupervisorDefaultsToDisk(value: SupervisorDefaultConfig): void {
  try {
    getDb().prepare(`
      INSERT INTO supervisor_defaults_cache (id, value, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  } catch (err) {
    logger.debug({ err }, 'supervisor-defaults-cache: disk write failed — keeping in-memory value only');
  }
}

let cachedSupervisorDefaults: SupervisorDefaultConfig | null = loadCachedSupervisorDefaultsFromDisk();
let lastFetchedAt = 0;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const SUPERVISOR_DEFAULTS_REFRESH_INTERVAL_MS = 5_000;

/**
 * True from the first failed/non-ok fetch until the next successful one.
 * Only the streak's first failure logs at warn -- every 5s retry after that
 * logs at debug, so a prolonged outage does not spam the log.
 */
let fetchFailing = false;

/** Exported for tests and for the WS-reconnect hook. */
export async function refreshSupervisorDefaultsCache(): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) {
    // Unbound daemon — nothing to fetch against.
    return;
  }
  try {
    const response = await fetch(
      `${creds.workerUrl}/api/server/${creds.serverId}/supervision/user-defaults/daemon`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${creds.token}` },
      },
    );
    if (!response.ok) {
      const log = fetchFailing ? logger.debug.bind(logger) : logger.warn.bind(logger);
      log({ status: response.status }, 'supervisor-defaults-cache: fetch non-ok — keeping previous value');
      fetchFailing = true;
      return;
    }
    const body = await response.json() as { defaults?: Partial<SupervisorDefaultConfig> | null };
    const next = normalizeSupervisorDefaultConfig(body?.defaults ?? null);
    if (JSON.stringify(next) !== JSON.stringify(cachedSupervisorDefaults)) {
      logger.info({
        backend: next.backend,
        model: next.model,
        backupConfigured: !!next.backupBackend,
        customInstructionsLength: next.customInstructions?.length ?? 0,
      }, 'supervisor-defaults-cache: defaults changed');
      // PostgreSQL remains the source of truth; this just mirrors the new
      // authoritative value locally so the next restart/upgrade does not
      // have to wait on a round trip to see it.
      persistCachedSupervisorDefaultsToDisk(next);
    }
    cachedSupervisorDefaults = next;
    lastFetchedAt = Date.now();
    fetchFailing = false;
  } catch (err) {
    const log = fetchFailing ? logger.debug.bind(logger) : logger.warn.bind(logger);
    log({ err }, 'supervisor-defaults-cache: fetch failed — keeping previous value');
    fetchFailing = true;
  }
}

/** Full global runtime used authoritatively by every supervised session. */
export function getCachedSupervisorDefaults(): SupervisorDefaultConfig | null {
  return cachedSupervisorDefaults;
}

/** When was the last SUCCESSFUL fetch? 0 means never (a disk-seeded cold-start value counts as never fetched THIS run). */
export function getSupervisorDefaultsCacheAgeMs(): number {
  return lastFetchedAt === 0 ? Infinity : Date.now() - lastFetchedAt;
}

/** Keep global runtime edits live without requiring a daemon reconnect. */
export function startSupervisorDefaultsCacheRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshSupervisorDefaultsCache();
  }, SUPERVISOR_DEFAULTS_REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

export function stopSupervisorDefaultsCacheRefresh(): void {
  if (!refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * Overlay the cached account-level execution pool onto a snapshot, when the
 * account has actually configured one.
 *
 * The pool is account-level policy keyed by model/agentType capability, not
 * by which session happens to hold it. Unlike backend/model (which
 * normalizeSupervisorDefaultConfig always fills with a concrete value), an
 * account that never configured a pool still reports 'legacy_unconfigured'
 * here; overlaying that state would regress a session whose own
 * transportConfig already has a real pool, so it is applied only once the
 * cache itself is genuinely 'configured'. Kept in this leaf module (no
 * dependency on the daemon's other supervision files) so both the automation
 * loop and send-tool's task-dispatch pool-eligibility check can share it
 * without a static import between those two large, otherwise-decoupled files.
 */
export function overlayCachedExecutionPools<T extends Pick<SessionSupervisionSnapshot, 'executionPools'>>(
  snapshot: T,
): T {
  const cached = cachedSupervisorDefaults;
  if (!cached || cached.executionPools.state !== 'configured') return snapshot;
  return { ...snapshot, executionPools: cached.executionPools };
}

/**
 * Human-readable reason the pool decision fell through to a session's local
 * mirror instead of the account-level cache, or undefined when the cache
 * itself is genuinely 'configured' (nothing fell back). A caller that already
 * knows it is reporting on a pool decision -- an allowlist gap, a pick miss --
 * should surface this alongside that report: the mirror can look "configured"
 * while badly stale, and that is otherwise invisible to the session owner.
 */
export function describeSupervisorDefaultsSyncGap(): string | undefined {
  if (cachedSupervisorDefaults?.executionPools.state === 'configured') return undefined;
  // A fetch has actually succeeded and confirmed the account has no pool at
  // all -- that is a real, current answer, not a sync problem. Only claim a
  // sync gap when there either has never been a successful fetch, or the
  // most recent attempt failed and the last known-good answer is now stale.
  if (cachedSupervisorDefaults && !fetchFailing) {
    return "no account-level pool configured; using this session's local copy";
  }
  const ageMs = getSupervisorDefaultsCacheAgeMs();
  const age = ageMs === Infinity ? 'never' : `${Math.round(ageMs / 1000)}s ago`;
  return `account pool not synced from server (last successful fetch: ${age}); using this session's local copy`;
}

/** Test-only hook. Resets cache state (memory and disk) between tests. */
export function __resetSupervisorDefaultsCacheForTests(): void {
  stopSupervisorDefaultsCacheRefresh();
  cachedSupervisorDefaults = null;
  lastFetchedAt = 0;
  fetchFailing = false;
  try {
    db?.prepare('DELETE FROM supervisor_defaults_cache').run();
  } catch {
    // A missing/closed db here is fine; nothing to clear.
  }
}

/** Test-only hook for exercising consumers without making an HTTP request. */
export function __setCachedSupervisorDefaultsForTests(
  defaults: Partial<SupervisorDefaultConfig> | null,
): void {
  cachedSupervisorDefaults = defaults ? normalizeSupervisorDefaultConfig(defaults) : null;
  lastFetchedAt = defaults ? Date.now() : 0;
}

/**
 * Test-only hook: reload the in-memory value from disk, exactly as module
 * load does. Lets tests exercise the cold-start path without re-importing
 * the module (module state would otherwise be a fresh singleton per file
 * anyway, but this makes the restart behavior directly assertable).
 */
export function __reloadSupervisorDefaultsCacheFromDiskForTests(): void {
  cachedSupervisorDefaults = loadCachedSupervisorDefaultsFromDisk();
  lastFetchedAt = 0;
}
