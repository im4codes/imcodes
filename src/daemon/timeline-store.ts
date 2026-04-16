/**
 * File-based timeline event store — one JSONL file per session.
 * Append-only writes, supports filtered reads for replay.
 * Storage: ~/.imcodes/timeline/{sessionName}.jsonl
 */

import { mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, openSync, readSync, fstatSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';

const TIMELINE_DIR = join(homedir(), '.imcodes', 'timeline');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EVENTS_PER_FILE = 5000;

/**
 * Read the last N lines from a file by reading backward from the end in chunks.
 * Much faster than readFileSync + split for large files when only tail is needed.
 */
function readTailLines(filePath: string, maxLines: number): string[] {
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

  private ensureDir(): void {
    if (this.initialized) return;
    try {
      mkdirSync(TIMELINE_DIR, { recursive: true });
    } catch { /* exists */ }
    this.initialized = true;
  }

  private filePath(sessionName: string): string {
    // Sanitize session name for filesystem
    const safe = sessionName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(TIMELINE_DIR, `${safe}.jsonl`);
  }

  /** Append a single event to the session's JSONL file. */
  append(event: TimelineEvent): void {
    this.ensureDir();
    try {
      appendFileSync(this.filePath(event.sessionId), JSON.stringify(event) + '\n');
    } catch (err) {
      logger.debug({ err, sessionId: event.sessionId }, 'TimelineStore: append failed');
    }
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

  /**
   * Truncate old events from a session file, keeping only the last N events.
   */
  truncate(sessionName: string, keepLast = MAX_EVENTS_PER_FILE): void {
    const filePath = this.filePath(sessionName);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const lines = raw.trimEnd().split('\n').filter(l => l.length > 0);
    if (lines.length <= keepLast) return;

    const kept = lines.slice(lines.length - keepLast);
    try {
      writeFileSync(filePath, kept.join('\n') + '\n');
      logger.info({ sessionName, before: lines.length, after: kept.length }, 'TimelineStore: truncated');
    } catch (err) {
      logger.debug({ err, sessionName }, 'TimelineStore: truncate write failed');
    }
  }

  /**
   * Truncate ALL session files that exceed MAX_EVENTS_PER_FILE.
   * Called on daemon startup to prevent unbounded growth.
   */
  truncateAll(): void {
    this.ensureDir();
    try {
      for (const file of readdirSync(TIMELINE_DIR)) {
        if (!file.endsWith('.jsonl')) continue;
        const sessionName = file.replace('.jsonl', '');
        this.truncate(sessionName);
      }
    } catch (err) {
      logger.debug({ err }, 'TimelineStore: truncateAll failed');
    }
  }

  /**
   * Delete JSONL files older than MAX_AGE_MS. Called on daemon startup.
   */
  cleanup(): void {
    this.ensureDir();
    const now = Date.now();
    try {
      for (const file of readdirSync(TIMELINE_DIR)) {
        if (!file.endsWith('.jsonl')) continue;
        const fullPath = join(TIMELINE_DIR, file);
        try {
          const stat = statSync(fullPath);
          if (now - stat.mtimeMs > MAX_AGE_MS) {
            unlinkSync(fullPath);
            logger.info({ file }, 'TimelineStore: deleted old file');
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      logger.debug({ err }, 'TimelineStore: cleanup failed');
    }
  }
}

export const timelineStore = new TimelineStore();
