/**
 * File-based timeline event store — one JSONL file per session.
 * Append-only writes, supports filtered reads for replay.
 * Storage: ~/.imcodes/timeline/{sessionName}.jsonl
 */

import { mkdirSync, appendFileSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { TimelineEvent } from './timeline-event.js';
import logger from '../util/logger.js';

const TIMELINE_DIR = join(homedir(), '.imcodes', 'timeline');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_EVENTS_PER_FILE = 5000;

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
   */
  read(sessionName: string, opts?: { epoch?: number; afterSeq?: number; afterTs?: number; limit?: number }): TimelineEvent[] {
    const filePath = this.filePath(sessionName);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = raw.trimEnd().split('\n');
    const events: TimelineEvent[] = [];

    // Read from the end for efficiency when limit is set
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const event = JSON.parse(lines[i]) as TimelineEvent;
        if (opts?.epoch !== undefined && event.epoch !== opts.epoch) continue;
        if (opts?.afterSeq !== undefined && event.seq <= opts.afterSeq) continue;
        if (opts?.afterTs !== undefined && event.ts <= opts.afterTs) continue;
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
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const lines = raw.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      try {
        const event = JSON.parse(lines[i]) as TimelineEvent;
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
