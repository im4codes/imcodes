/**
 * Timeline event bus — per-session seq counter, ring buffer, replay.
 * Singleton: import { timelineEmitter } from './timeline-emitter.js'
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, basename } from 'path';
import type { TimelineEvent, TimelineEventType, TimelineSource, TimelineConfidence } from './timeline-event.js';
import { timelineStore } from './timeline-store.js';

/** Pattern matching temp file instruction: "Read and execute all instructions in @<path>" */
const TEMP_FILE_RE = /^Read and execute all instructions in @(.+\.imcodes-prompt-[0-9a-f]+\.md)$/;
/** Only allow reading temp files from /tmp or project directories (prevent path traversal). */
function isTrustedTempPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  const name = basename(resolved);
  // Must match the exact temp file naming pattern
  if (!/^\.imcodes-prompt-[0-9a-f]+\.md$/.test(name)) return false;
  // Must be in /tmp or a project directory (no .. traversal)
  if (resolved.startsWith('/tmp/') || resolved.startsWith('/private/tmp/')) return true;
  // Project directory: resolved path should not contain .. and file is at root of some dir
  if (filePath !== resolved) return false; // path contained .. or was relative
  return true;
}

const MAX_BUFFER = 500;

export class TimelineEmitter {
  private seqMap = new Map<string, number>();
  private buffer = new Map<string, TimelineEvent[]>();
  private handlers = new Set<(e: TimelineEvent) => void>();
  /** Track last session.state per session to deduplicate repeated idle events */
  private lastSessionState = new Map<string, string>();
  /** Track recent user.message per session to deduplicate (text → timestamp) */
  private recentUserMsg = new Map<string, { text: string; ts: number }>();
  /** Daemon startup timestamp — changes on restart, used for epoch-based seq continuity */
  readonly epoch = Date.now();

  emit(
    sessionId: string,
    type: TimelineEventType,
    payload: Record<string, unknown>,
    opts?: { source?: TimelineSource; confidence?: TimelineConfidence; eventId?: string; ts?: number },
  ): TimelineEvent | null {
    // Deduplicate session.state — skip repeated same-state events to avoid UI flicker,
    // but still return a synthetic event so callers (store updates, idle callbacks) proceed.
    if (type === 'session.state') {
      const state = String(payload.state ?? '');
      if (this.lastSessionState.get(sessionId) === state) {
        // State unchanged — don't emit to handlers/UI, but return event for caller
        return { eventId: '', sessionId, ts: Date.now(), seq: 0, epoch: this.epoch, source: opts?.source ?? 'daemon', confidence: opts?.confidence ?? 'high', type, payload } as TimelineEvent;
      }
      this.lastSessionState.set(sessionId, state);
    }

    // Deduplicate user.message — skip if same session + same text within 5s
    if (type === 'user.message') {
      const text = String(payload.text ?? '');

      // Resolve temp file references: replace instruction with actual file content
      const tempMatch = text.match(TEMP_FILE_RE);
      if (tempMatch && isTrustedTempPath(tempMatch[1])) {
        try {
          const content = readFileSync(tempMatch[1], 'utf-8');
          payload = { ...payload, text: content, tempFile: tempMatch[1] };
        } catch { /* file already cleaned up or unreadable — keep original text */ }
      }

      const key = sessionId;
      const resolvedText = String(payload.text ?? '');
      const prev = this.recentUserMsg.get(key);
      const now = Date.now();
      if (prev && prev.text === resolvedText && now - prev.ts < 5_000) return null;
      this.recentUserMsg.set(key, { text: resolvedText, ts: now });
    }

    const seq = (this.seqMap.get(sessionId) ?? 0) + 1;
    this.seqMap.set(sessionId, seq);

    const ts = opts?.ts ?? Date.now();
    const eventId = opts?.eventId ?? createHash('sha1')
      .update(`${sessionId}\0${type}\0${ts}\0${JSON.stringify(payload)}`)
      .digest('hex')
      .slice(0, 24);

    const event: TimelineEvent = {
      eventId,
      sessionId,
      ts,
      seq,
      epoch: this.epoch,
      source: opts?.source ?? 'daemon',
      confidence: opts?.confidence ?? 'high',
      type,
      payload,
    };

    // Ring buffer
    let buf = this.buffer.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffer.set(sessionId, buf);
    }
    buf.push(event);
    if (buf.length > MAX_BUFFER) {
      buf.splice(0, buf.length - MAX_BUFFER);
    }

    // Persist to disk
    timelineStore.append(event);

    // Notify handlers
    for (const h of this.handlers) {
      try { h(event); } catch { /* ignore */ }
    }

    return event;
  }

  on(handler: (e: TimelineEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /**
   * Replay events after a given seq for a session.
   * Tries ring buffer first, falls back to file store for older events.
   * Returns { events, truncated } where truncated=true if requested events fell off both buffer and file.
   */
  replay(sessionId: string, afterSeq: number): { events: TimelineEvent[]; truncated: boolean } {
    const buf = this.buffer.get(sessionId) ?? [];

    // Try ring buffer first
    if (buf.length > 0 && (afterSeq + 1) >= buf[0].seq) {
      // Ring buffer has all the requested events
      const events = buf.filter(e => e.seq > afterSeq);
      return { events, truncated: false };
    }

    // Ring buffer doesn't have old enough events — read from file store
    const fileEvents = timelineStore.read(sessionId, { epoch: this.epoch, afterSeq });
    return { events: fileEvents, truncated: false };
  }
}

export const timelineEmitter = new TimelineEmitter();
