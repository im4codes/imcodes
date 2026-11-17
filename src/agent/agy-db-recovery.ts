import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { suppressSqliteExperimentalWarning } from '../util/suppress-sqlite-warning.js';

const DEFAULT_RECOVERY_TIMEOUT_MS = 60_000;
const STDERR_CAPTURE_LIMIT_BYTES = 512;
const STDERR_SUMMARY_MAX_CHARS = 160;
const SQLITE_BUSY_OR_ACCESS_ERRCODES = new Set([
  3, // SQLITE_PERM
  5, // SQLITE_BUSY
  6, // SQLITE_LOCKED
  8, // SQLITE_READONLY
  14, // SQLITE_CANTOPEN
]);
const POSIX_NON_CORRUPT_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY']);

export type AgyDbRecoveryReason =
  | 'healthy'
  | 'missing'
  | 'busy_or_unreadable'
  | 'invalid_path'
  | 'sqlite3_enoent'
  | 'sqlite3_timeout'
  | 'sqlite3_failed'
  | 'integrity_failed'
  | 'missing_core_tables'
  | 'backup_failed'
  | 'replace_failed'
  | 'recovered';

export type AgyDbRecoveryFailedStep = 'recover' | 'import' | 'wal' | 'integrity' | 'schema' | 'backup' | 'replace';

export interface AgyDbRecoveryResult {
  recovered: boolean;
  reason: AgyDbRecoveryReason;
  failedStep?: AgyDbRecoveryFailedStep;
  exitCode?: number | null;
  stderrSummary?: string;
}

export interface AgyDbRecoveryOptions {
  sqliteBinary?: string;
  timeoutMs?: number;
}

const inFlightRecoveries = new Map<string, Promise<AgyDbRecoveryResult>>();

export function isValidAgyConversationId(id: string): boolean {
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);
}

export function agyConversationDbPath(home: string, conversationId: string): string | undefined {
  if (!home || !path.isAbsolute(home) || !isValidAgyConversationId(conversationId)) return undefined;
  return path.join(home, '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);
}

function getDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  suppressSqliteExperimentalWarning();
  const mod = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  return mod.DatabaseSync;
}

function isNonCorruptOpenError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const record = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (typeof record.code === 'string' && POSIX_NON_CORRUPT_CODES.has(record.code)) return true;
  if (typeof record.errcode === 'number' && SQLITE_BUSY_OR_ACCESS_ERRCODES.has(record.errcode)) return true;
  const msg = typeof record.message === 'string' ? record.message : '';
  return /database is locked|unable to open database file/i.test(msg);
}

async function checkDbHealth(dbPath: string): Promise<'missing' | 'healthy' | 'busy_or_unreadable' | 'corrupt'> {
  let info;
  try {
    info = await stat(dbPath);
  } catch {
    return 'missing';
  }
  if (!info.isFile()) return 'missing';
  // A zero-byte file has no SQLite pages to recover; treat it as non-corrupt so
  // recovery does not replace it with an empty schema or destroy caller state.
  if (info.size === 0) return 'healthy';

  const DatabaseSync = getDatabaseSync();
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>;
    if (rows.length === 1 && rows[0]?.quick_check === 'ok') {
      return 'healthy';
    }
    return 'corrupt';
  } catch (err) {
    if (isNonCorruptOpenError(err)) return 'busy_or_unreadable';
    return 'corrupt';
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

function waitForChildExit(child: ChildProcess): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
}> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: { code: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException }) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    child.once('error', (err) => finish({ code: null, signal: null, error: err as NodeJS.ErrnoException }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

function collectStderrTail(stream: Readable | null, maxBytes = STDERR_CAPTURE_LIMIT_BYTES): () => string {
  let buf = Buffer.alloc(0);
  if (stream) {
    stream.on('data', (chunk: Buffer | string) => {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const combined = Buffer.concat([buf, piece]);
      buf = combined.length > maxBytes ? combined.subarray(combined.length - maxBytes) : combined;
    });
  }
  return () => buf.toString('utf8');
}

function sanitizeSqliteStderr(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    // Strip quoted and unquoted Windows/POSIX filesystem paths before any diagnostic surfaces.
    .replace(/(["'])[^"'\r\n]*[\\/][^"'\r\n]*\1/g, '[path]')
    .replace(/[A-Za-z]:[\\/][^\s:;,)'"]+/g, '[path]')
    .replace(/(?:^|(?<=[\s:=('"[]))\/(?:[^\s:;,)'"]+)+/g, '[path]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!sanitized) return undefined;
  return sanitized.length > STDERR_SUMMARY_MAX_CHARS
    ? sanitized.slice(0, STDERR_SUMMARY_MAX_CHARS)
    : sanitized;
}

function buildFailureResult(
  reason: AgyDbRecoveryReason,
  diag?: {
    failedStep?: AgyDbRecoveryFailedStep;
    exitCode?: number | null;
    stderrSummary?: string;
  },
): AgyDbRecoveryResult {
  return {
    recovered: false,
    reason,
    ...(diag?.failedStep ? { failedStep: diag.failedStep } : {}),
    ...(diag?.exitCode !== undefined ? { exitCode: diag.exitCode } : {}),
    ...(diag?.stderrSummary ? { stderrSummary: diag.stderrSummary } : {}),
  };
}

interface RecoverStreamFailure {
  ok: false;
  reason: 'sqlite3_enoent' | 'sqlite3_timeout' | 'sqlite3_failed';
  failedStep: 'recover' | 'import';
  exitCode?: number | null;
  stderrSummary?: string;
  /** True only when subprocesses finished without timeout, ENOENT, signal kill, or pipe crash. */
  allowOutputVerification?: boolean;
}

async function runSqliteRecoverStream(
  dbPath: string,
  tmpPath: string,
  sqliteBinary: string,
  timeoutMs: number,
): Promise<{ ok: true } | RecoverStreamFailure> {
  const recoverChild = spawn(sqliteBinary, ['-batch', dbPath, '.recover'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const importChild = spawn(sqliteBinary, ['-batch', tmpPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Drain auxiliary pipes with bounded stderr tail capture so neither child can block on a full 64KB buffer.
  const readRecoverStderr = collectStderrTail(recoverChild.stderr);
  const readImportStderr = collectStderrTail(importChild.stderr);
  importChild.stdout.resume();

  let timedOut = false;
  let pipeError: unknown;

  const safeKill = (child: ChildProcess): void => {
    // Only signal processes that actually spawned a valid positive PID and are still alive.
    // Calling child.kill() on a ChildProcess whose handle never received a PID can hit pid 0 (process group).
    if (typeof child.pid === 'number' && child.pid > 0 && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }
  };

  const killChildren = (): void => {
    safeKill(recoverChild);
    safeKill(importChild);
  };

  const recoverWait = waitForChildExit(recoverChild);
  const importWait = waitForChildExit(importChild);

  recoverChild.once('error', () => {
    recoverChild.stdout.destroy();
    importChild.stdin.destroy();
    killChildren();
  });
  importChild.once('error', () => {
    recoverChild.stdout.destroy();
    importChild.stdin.destroy();
    killChildren();
  });

  const timer = setTimeout(() => {
    timedOut = true;
    recoverChild.stdout.destroy();
    importChild.stdin.destroy();
    killChildren();
  }, timeoutMs);
  timer.unref?.();

  const pipePromise = pipeline(recoverChild.stdout, importChild.stdin).catch((err) => {
    pipeError = err;
    killChildren();
  });

  try {
    const [recoverRes, importRes] = await Promise.all([recoverWait, importWait, pipePromise]);
    const recoverStderr = sanitizeSqliteStderr(readRecoverStderr());
    const importStderr = sanitizeSqliteStderr(readImportStderr());

    if (timedOut) {
      return {
        ok: false,
        reason: 'sqlite3_timeout',
        failedStep: 'recover',
        exitCode: recoverRes.code ?? importRes.code ?? null,
        stderrSummary: recoverStderr ?? importStderr,
      };
    }
    if (recoverRes.error?.code === 'ENOENT') {
      return { ok: false, reason: 'sqlite3_enoent', failedStep: 'recover', exitCode: null };
    }
    if (importRes.error?.code === 'ENOENT') {
      return { ok: false, reason: 'sqlite3_enoent', failedStep: 'import', exitCode: null };
    }
    if (recoverRes.error || importRes.error || pipeError) {
      const failedStep: 'recover' | 'import' = recoverRes.error ? 'recover' : 'import';
      return {
        ok: false,
        reason: 'sqlite3_failed',
        failedStep,
        exitCode: failedStep === 'recover' ? recoverRes.code : importRes.code,
        stderrSummary: failedStep === 'recover' ? (recoverStderr ?? importStderr) : (importStderr ?? recoverStderr),
      };
    }
    if (recoverRes.signal !== null || importRes.signal !== null) {
      const failedStep: 'recover' | 'import' = recoverRes.signal !== null ? 'recover' : 'import';
      return {
        ok: false,
        reason: 'sqlite3_failed',
        failedStep,
        exitCode: failedStep === 'recover' ? recoverRes.code : importRes.code,
        stderrSummary: failedStep === 'recover' ? (recoverStderr ?? importStderr) : (importStderr ?? recoverStderr),
      };
    }
    if (recoverRes.code !== 0) {
      return {
        ok: false,
        reason: 'sqlite3_failed',
        failedStep: 'recover',
        exitCode: recoverRes.code,
        stderrSummary: recoverStderr ?? importStderr,
        allowOutputVerification: true,
      };
    }
    if (importRes.code !== 0) {
      return {
        ok: false,
        reason: 'sqlite3_failed',
        failedStep: 'import',
        exitCode: importRes.code,
        stderrSummary: importStderr ?? recoverStderr,
        allowOutputVerification: true,
      };
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

async function finalizeAndVerifyRecoveredDb(
  tmpPath: string,
): Promise<{ ok: true } | { ok: false; reason: 'integrity_failed' | 'missing_core_tables'; failedStep: 'wal' | 'integrity' | 'schema' }> {
  const DatabaseSync = getDatabaseSync();
  let db: import('node:sqlite').DatabaseSync | undefined;
  let currentStep: 'wal' | 'integrity' | 'schema' = 'wal';
  try {
    db = new DatabaseSync(tmpPath);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE);');
    const journalRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
    if (String(journalRow?.journal_mode ?? '').toLowerCase() !== 'wal') {
      return { ok: false, reason: 'integrity_failed', failedStep: 'wal' };
    }

    currentStep = 'integrity';
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check?: unknown }>;
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
      return { ok: false, reason: 'integrity_failed', failedStep: 'integrity' };
    }

    currentStep = 'schema';
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('steps', 'trajectory_meta')")
      .all() as Array<{ name?: unknown }>;
    const tableNames = new Set(tables.map((row) => String(row.name ?? '')));
    if (!tableNames.has('steps') || !tableNames.has('trajectory_meta')) {
      return { ok: false, reason: 'missing_core_tables', failedStep: 'schema' };
    }
    db.prepare('SELECT 1 FROM steps LIMIT 1').get();
    db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 1').get();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    return { ok: true };
  } catch {
    return { ok: false, reason: currentStep === 'schema' ? 'missing_core_tables' : 'integrity_failed', failedStep: currentStep };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
}

async function performRecovery(
  dbPath: string,
  options?: AgyDbRecoveryOptions,
): Promise<AgyDbRecoveryResult> {
  const health = await checkDbHealth(dbPath);
  if (health !== 'corrupt') {
    return { recovered: false, reason: health };
  }

  const sqliteBinary = options?.sqliteBinary ?? 'sqlite3';
  const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const tmpPath = `${dbPath}.recovering-${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  const backupPath = `${dbPath}.corrupt`;

  const cleanupTemp = async (): Promise<void> => {
    await Promise.all([
      rm(tmpPath, { force: true }).catch(() => {}),
      rm(`${tmpPath}-wal`, { force: true }).catch(() => {}),
      rm(`${tmpPath}-shm`, { force: true }).catch(() => {}),
    ]);
  };

  try {
    const streamResult = await runSqliteRecoverStream(dbPath, tmpPath, sqliteBinary, timeoutMs);
    if (!streamResult.ok) {
      const tmpStat = streamResult.allowOutputVerification ? await stat(tmpPath).catch(() => null) : null;
      if (!tmpStat?.isFile() || tmpStat.size === 0) {
        return buildFailureResult(streamResult.reason, {
          failedStep: streamResult.failedStep,
          exitCode: streamResult.exitCode,
          stderrSummary: streamResult.stderrSummary,
        });
      }
      // Some sqlite3 builds (e.g. macOS 26.7.2) exit non-zero after encountering a corrupt B-tree page
      // even after writing a valid recovered database; accept only if DatabaseSync verifies integrity + schema.
      const fallbackVerify = await finalizeAndVerifyRecoveredDb(tmpPath);
      if (!fallbackVerify.ok) {
        return buildFailureResult('sqlite3_failed', {
          failedStep: streamResult.failedStep,
          exitCode: streamResult.exitCode,
          stderrSummary: streamResult.stderrSummary,
        });
      }
    } else {
      if (Date.now() > deadline) {
        return buildFailureResult('sqlite3_timeout', { failedStep: 'wal' });
      }
      const verifyResult = await finalizeAndVerifyRecoveredDb(tmpPath);
      if (!verifyResult.ok) {
        return buildFailureResult(verifyResult.reason, { failedStep: verifyResult.failedStep });
      }
    }

    try {
      await copyFile(dbPath, backupPath);
      await chmod(backupPath, 0o600).catch(() => {});
    } catch {
      return buildFailureResult('backup_failed', { failedStep: 'backup' });
    }

    try {
      await Promise.all([
        rm(`${tmpPath}-wal`, { force: true }),
        rm(`${tmpPath}-shm`, { force: true }),
        rm(`${dbPath}-wal`, { force: true }),
        rm(`${dbPath}-shm`, { force: true }),
      ]);
      await chmod(tmpPath, 0o600).catch(() => {});
      await rename(tmpPath, dbPath);
    } catch {
      return buildFailureResult('replace_failed', { failedStep: 'replace' });
    }

    return { recovered: true, reason: 'recovered' };
  } finally {
    await cleanupTemp();
  }
}

/**
 * Inspect and reactively self-heal a corrupted Antigravity conversation SQLite
 * database using `sqlite3 .recover`. Never touches healthy, missing, or locked
 * databases, and deduplicates concurrent recoveries per `dbPath` in-process.
 */
export async function recoverAgyConversationDbIfCorrupt(
  dbPath: string,
  options?: AgyDbRecoveryOptions,
): Promise<AgyDbRecoveryResult> {
  if (!dbPath || !path.isAbsolute(dbPath) || !dbPath.endsWith('.db')) {
    return { recovered: false, reason: 'invalid_path' };
  }
  const key = path.resolve(dbPath);
  const existing = inFlightRecoveries.get(key);
  if (existing) return existing;

  const task = performRecovery(key, options).finally(() => {
    if (inFlightRecoveries.get(key) === task) {
      inFlightRecoveries.delete(key);
    }
  });
  inFlightRecoveries.set(key, task);
  return task;
}
