/**
 * Timeline event store.
 *
 * JSONL remains the append-only compatibility log, but user-facing history
 * reads use the SQLite projection via `readPreferred` / `readByTypesPreferred`.
 * The direct JSONL `read` method is kept for legacy replay callers only.
 *
 * Storage: ~/.imcodes/timeline/{sessionName}.jsonl
 *
 * ## Contracts (async append, fire-and-forget from emit)
 *
 * `emit()` synchronous guarantees (handled by timeline-emitter):
 *   - Ring buffer push completes; `replay()` immediately sees it.
 *   - Handler broadcast completes; WS / projection sync listeners see it.
 *   - `recordTurnUsage` (better-sqlite3) writes synchronously.
 *
 * `emit()` does NOT guarantee:
 *   - JSONL file content visible to `read()` / `getLatest()` — those paths
 *     should prefer the ring buffer or `readPreferred` (SQLite mirror).
 *   - On SIGTERM, the last N pending appends may not all flush
 *     (`flushAll(5_000)` upper bound).
 *   - Cross-session emit order (per-session chain orders within a session
 *     only).
 *
 * Caller constraints:
 *   - Tests requiring synchronous visibility must call
 *     `await timelineStore.flushAll(...)` or `await timelineStore.flushSession(id)`.
 *   - Application code MUST NOT sleep "waiting for JSONL to flush" —
 *     prefer ring buffer / preferred APIs.
 */

import { mkdirSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { mkdir, appendFile, writeFile, readFile, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';
import { timelineProjection, type TimelineProjectionQueryOpts } from './timeline-projection.js';

export const TIMELINE_DIR = join(homedir(), '.imcodes', 'timeline');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EVENTS_PER_FILE = 5000;

/**
 * Read the last N lines from a file by reading backward from the end in chunks.
 * Much faster than readFileSync + split for large files when only tail is needed.
 */
export function readTailLines(filePath: string, maxLines: number): string[] {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return [];
  }

  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize === 0) return [];

    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const lines: string[] = [];
    let remaining = '';
    let position = fileSize;

    while (position > 0 && lines.length < maxLines) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, position);
      const chunk = buf.toString('utf-8') + remaining;
      const parts = chunk.split('\n');
      // First element is partial (or beginning of file) — save for next iteration
      remaining = parts[0];
      // Process complete lines from end to start
      for (let i = parts.length - 1; i >= 1; i--) {
        if (parts[i].length > 0) {
          lines.push(parts[i]);
          if (lines.length >= maxLines) break;
        }
      }
    }
    // Don't forget the final remaining piece (beginning of file)
    if (remaining.length > 0 && lines.length < maxLines) {
      lines.push(remaining);
    }
    return lines; // lines are in reverse order (newest first)
  } finally {
    closeSync(fd);
  }
}

class TimelineStore {
  private initialized = false;
  /**
   * Per-session async append chains. Each session has at most one
   * outstanding write Promise; appends are serialized per-session to
   * preserve in-file order. Cross-session writes run concurrently.
   */
  private sessionChains = new Map<string, Promise<void>>();

  private ensureDirSync(): void {
    if (this.initialized) return;
    try {
      mkdirSync(TIMELINE_DIR, { recursive: true });
    } catch { /* exists */ }
    this.initialized = true;
  }

  private async ensureDirAsync(): Promise<void> {
    if (this.initialized) return;
    try {
      await mkdir(TIMELINE_DIR, { recursive: true });
    } catch { /* exists */ }
    this.initialized = true;
  }

  filePath(sessionName: string): string {
    // Sanitize session name for filesystem
    const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(TIMELINE_DIR, `${safe}.jsonl`);
  }

  /**
   * Schedule an async append for the session. Returns the Promise that
   * resolves when the JSONL line lands on disk. Callers in the `emit()`
   * hot path treat the return value as fire-and-forget; tests and
   * shutdown can `await` for synchronous visibility.
   *
   * Failure handling: an individual append failure does not break the
   * session chain — subsequent writes continue regardless (same pattern
   * as ack-outbox `appendRecord`).
   */
  append(event: TimelineEvent): Promise<void> {
    const sessionId = event.sessionId;
    const prev = this.sessionChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(
      () => this.appendOne(event),
      () => this.appendOne(event), // continue chain on prior failure
    );
    this.sessionChains.set(sessionId, next);
    // Auto-prune the chain map once the tail settles — keeps `sessionChains.size`
    // bounded by truly-active sessions instead of accumulating forever.
    next.finally(() => {
      if (this.sessionChains.get(sessionId) === next) {
        this.sessionChains.delete(sessionId);
      }
    });
    return next;
  }

  private async appendOne(event: TimelineEvent): Promise<void> {
    await this.ensureDirAsync();
    try {
      await appendFile(this.filePath(event.sessionId), JSON.stringify(event) + '\n');
      void timelineProjection.recordAppendedEvent(event).catch((err) => {
        logger.debug({ err, sessionId: event.sessionId, eventId: event.eventId }, 'TimelineProjection: append mirror failed');
      });
    } catch (err) {
      logger.debug({ err, sessionId: event.sessionId }, 'TimelineStore: append failed');
    }
  }

  /**
   * Wait for all pending per-session append chains to settle.
   * Resolves on full drain or `timeoutMs`, whichever comes first. Logs a
   * warn line if the timeout fires while writes remain in flight.
   * Used by SIGTERM shutdown to bound flush latency.
   */
  async flushAll(timeoutMs: number): Promise<void> {
    const start = Date.now();
    const snapshot = [...this.sessionChains.values()];
    if (snapshot.length === 0) return;
    const drain = Promise.allSettled(snapshot).then(() => undefined);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      const result = await Promise.race([drain.then(() => 'drained' as const), timeout]);
      if (result === 'timeout') {
        logger.warn({
          pendingSessions: this.sessionChains.size,
          elapsedMs: Date.now() - start,
          timeoutMs,
        }, 'TimelineStore: flushAll timed out');
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Wait for a single session's append chain to settle. Used by tests
   * that need synchronous visibility after a few `emit()` calls.
   */
  async flushSession(sessionId: string): Promise<void> {
    const chain = this.sessionChains.get(sessionId);
    if (!chain) return;
    await chain.catch(() => undefined);
  }

  /** Number of sessions with at least one outstanding append. */
  getPendingSessionCount(): number {
    return this.sessionChains.size;
  }

  /**
   * Read events for a session, optionally filtering by epoch, afterSeq, and afterTs.
   * Returns events sorted by ts ascending.
   *
   * Uses reverse-read from file tail for efficiency — only reads as many lines
   * as needed instead of loading the entire file.
   */
  read(sessionName: string, opts?: { epoch?: number; afterSeq?: number; afterTs?: number; beforeTs?: number; limit?: number }): TimelineEvent[] {
    const filePath = this.filePath(sessionName);
    // Read more lines than limit to account for filtered-out events.
    // For most queries (no epoch/afterTs filter), 2x is plenty.
    const readLimit = Math.max((opts?.limit ?? 200) * 3, 1000);
    const rawLines = readTailLines(filePath, readLimit);
    if (rawLines.length === 0) return [];

    const events: TimelineEvent[] = [];

    // rawLines are already in reverse order (newest first) from readTailLines
    for (const line of rawLines) {
      try {
        const event = JSON.parse(line) as TimelineEvent;
        if (opts?.epoch !== undefined && event.epoch !== opts.epoch) continue;
        if (opts?.afterSeq !== undefined && event.seq <= opts.afterSeq) continue;
        if (opts?.afterTs !== undefined && event.ts <= opts.afterTs) continue;
        if (opts?.beforeTs !== undefined && event.ts >= opts.beforeTs) continue;
        events.push(event);
        if (opts?.limit && events.length >= opts.limit) break;
      } catch { /* skip corrupt lines */ }
    }

    return events.reverse(); // restore ts order
  }

  async readPreferred(
    sessionName: string,
    opts?: { afterTs?: number; beforeTs?: number; limit?: number },
  ): Promise<TimelineEvent[]> {
    return await timelineProjection.queryHistory({
      sessionId: sessionName,
      afterTs: opts?.afterTs,
      beforeTs: opts?.beforeTs,
      limit: opts?.limit,
    }) ?? [];
  }

  async readByTypesPreferred(
    sessionName: string,
    types: TimelineEvent['type'][],
    opts?: TimelineProjectionQueryOpts,
  ): Promise<TimelineEvent[]> {
    return await timelineProjection.queryByTypes({
      sessionId: sessionName,
      types,
      afterTs: opts?.afterTs,
      beforeTs: opts?.beforeTs,
      limit: opts?.limit,
    }) ?? [];
  }

  async readCompletedTextTail(sessionName: string, limit = 50): Promise<TimelineEvent[]> {
    return await timelineProjection.queryCompletedTextTail(sessionName, limit) ?? [];
  }

  /**
   * Get the latest epoch and seq for a session (from the last line).
   */
  getLatest(sessionName: string): { epoch: number; seq: number } | null {
    const filePath = this.filePath(sessionName);
    const lines = readTailLines(filePath, 5); // read last few lines in case some are corrupt
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TimelineEvent;
        return { epoch: event.epoch, seq: event.seq };
      } catch { /* skip */ }
    }
    return null;
  }

  async getLatestPreferred(sessionName: string): Promise<{ epoch: number; seq: number } | null> {
    return await timelineProjection.getLatest(sessionName);
  }

  /**
   * Truncate old events from a session file, keeping only the last N events.
   *
   * Async + atomic: waits for any in-flight per-session append chain to
   * settle, writes the trimmed body to a `.tmp` file, and renames it
   * over the live file. After the rename the session chain head is
   * reset so subsequent appends open a fresh fd against the new inode.
   */
  async truncate(sessionName: string, keepLast = MAX_EVENTS_PER_FILE): Promise<void> {
    const filePath = this.filePath(sessionName);
    // 1) Wait for any pending appends so they reach the live file *before*
    //    we read its tail and rewrite it. Without this we could lose
    //    fresh events to the rename.
    const chain = this.sessionChains.get(sessionName);
    if (chain) {
      await chain.catch(() => undefined);
    }

    const newestFirst = readTailLines(filePath, keepLast + 1);
    if (newestFirst.length <= keepLast) return;

    const kept = newestFirst.slice(0, keepLast).reverse();
    const tmpPath = `${filePath}.tmp`;
    try {
      await writeFile(tmpPath, kept.join('\n') + '\n', 'utf-8');
      await rename(tmpPath, filePath);
      void timelineProjection.pruneSessionToAuthoritative(sessionName, keepLast).catch((err) => {
        logger.debug({ err, sessionName }, 'TimelineProjection: prune after truncate failed');
      });
      logger.info({ sessionName, after: kept.length }, 'TimelineStore: truncated');
      // 2) Reset chain head — subsequent appends start a fresh fd against
      //    the new file. POSIX `appendFile` re-opens by path each call, so
      //    the rename is transparent, but clearing the cached promise
      //    avoids holding a settled chain forever.
      this.sessionChains.delete(sessionName);
    } catch (err) {
      logger.debug({ err, sessionName }, 'TimelineStore: truncate write failed');
      // Best-effort tmp cleanup; ignore errors (file may not exist).
      try { await unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * Truncate ALL session files that exceed MAX_EVENTS_PER_FILE.
   * Called on daemon startup to prevent unbounded growth. Yields the
   * event loop between sessions so a backlog of large files does not
   * stall daemon startup.
   */
  async truncateAll(): Promise<void> {
    this.ensureDirSync();
    let files: string[];
    try {
      files = readdirSync(TIMELINE_DIR);
    } catch (err) {
      logger.debug({ err }, 'TimelineStore: truncateAll readdir failed');
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionName = file.replace('.jsonl', '');
      try {
        await this.truncate(sessionName);
      } catch (err) {
        logger.debug({ err, sessionName }, 'TimelineStore: truncateAll item failed');
      }
      // Yield event loop so other tasks (WS, timers, worker pool dispatch)
      // can run between large file rewrites.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Delete JSONL files older than MAX_AGE_MS. Called on daemon startup.
   * Async + setImmediate yield between files for the same reason as
   * `truncateAll`.
   */
  async cleanup(): Promise<void> {
    this.ensureDirSync();
    const now = Date.now();
    let files: string[];
    try {
      files = readdirSync(TIMELINE_DIR);
    } catch (err) {
      logger.debug({ err }, 'TimelineStore: cleanup readdir failed');
      return;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = join(TIMELINE_DIR, file);
      try {
        const stat = statSync(fullPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          await unlink(fullPath);
          const sessionName = file.replace('.jsonl', '');
          void timelineProjection.deleteSession(sessionName).catch((err) => {
            logger.debug({ err, sessionName }, 'TimelineProjection: delete after cleanup failed');
          });
          logger.info({ file }, 'TimelineStore: deleted old file');
        }
      } catch { /* skip */ }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    void timelineProjection.checkpointIfNeeded().catch((err) => {
      logger.debug({ err }, 'TimelineProjection: cleanup checkpoint failed');
    });
  }
}

export const timelineStore = new TimelineStore();
