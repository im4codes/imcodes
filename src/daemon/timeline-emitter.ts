/**
 * Timeline event bus — per-session seq counter, ring buffer, replay.
 * Singleton: import { timelineEmitter } from './timeline-emitter.js'
 */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import { tmpdir } from 'os';
import { performance } from 'node:perf_hooks';
import type { TimelineEvent, TimelineEventType, TimelineSource, TimelineConfidence } from './timeline-event.js';
import { timelineStore } from './timeline-store.js';
import { preferTimelineEvent } from '../shared/timeline/merge.js';
import { isMemoryNoiseTurn } from '../../shared/memory-noise-patterns.js';
import { recordTurnUsage } from '../store/context-store.js';
import { getSession } from '../store/session-store.js';
import logger from '../util/logger.js';
import { recordTimelineEmit } from './latency-tracer.js';
import { TIMELINE_RESPONSE_SOURCES, type TimelineResponseSource } from '../../shared/timeline-protocol.js';
import { isSessionModelSwitchCommandText } from '../../shared/session-control-commands.js';

/** Pattern matching temp file instruction: "Read and execute all instructions in @<path>" */
const TEMP_FILE_RE = /^Read and execute all instructions in @(.+\.imcodes-prompt-[0-9a-f]+\.md)$/;
/**
 * Maximum size for inlining a temp-file user.message into the event payload.
 *
 * The `readFileSync` call below runs on the daemon main thread inside the
 * high-frequency `emit()` hot path. For tiny prompt files (the common case)
 * the cost is sub-millisecond, but pathological tmux paste paths can push
 * many MB of text through this route. Cap at 64 KiB and fall back to the
 * original `@<path>` ref text — web clients can resolve the body via the
 * file-preview pool out-of-band. PR-B may extend this to push the read into
 * the calling routers entirely; this guard alone removes the worst-case
 * 50ms+ main-thread stall.
 */
const MAX_TEMP_FILE_INLINE_BYTES = 64 * 1024;
/** Only allow reading temp files from /tmp or project directories (prevent path traversal). */
function isTrustedTempPath(filePath: string): boolean {
  const resolved = resolve(filePath);
  const name = basename(resolved);
  // Must match the exact temp file naming pattern
  if (!/^\.imcodes-prompt-[0-9a-f]+\.md$/.test(name)) return false;
  // Must be in /tmp or a project directory (no .. traversal)
  const tmp = tmpdir();
  if (resolved.startsWith(tmp + '/') || resolved.startsWith(tmp + '\\') || resolved.startsWith('/tmp/') || resolved.startsWith('/private/tmp/')) return true;
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
    opts?: { source?: TimelineSource; confidence?: TimelineConfidence; eventId?: string; ts?: number; hidden?: boolean },
  ): TimelineEvent | null {
    const traceStart = performance.now();
    let traceTempFileMs = 0;
    let traceEventIdHashMs = 0;
    let traceEventIdPayloadBytes: number | undefined;
    let traceAppendScheduleMs = 0;
    let traceUsageMs = 0;
    let traceHandlersMs = 0;
    let traceHandlerCount = 0;
    const finishTrace = (result: 'event' | 'null' | 'synthetic') => {
      recordTimelineEmit({
        sessionId,
        type,
        result,
        durationMs: performance.now() - traceStart,
        ...(traceTempFileMs > 0 ? { tempFileMs: Number(traceTempFileMs.toFixed(3)) } : {}),
        ...(traceEventIdHashMs > 0 ? { eventIdHashMs: Number(traceEventIdHashMs.toFixed(3)) } : {}),
        ...(traceEventIdPayloadBytes !== undefined ? { eventIdPayloadBytes: traceEventIdPayloadBytes } : {}),
        ...(traceAppendScheduleMs > 0 ? { appendScheduleMs: Number(traceAppendScheduleMs.toFixed(3)) } : {}),
        ...(traceUsageMs > 0 ? { usageMs: Number(traceUsageMs.toFixed(3)) } : {}),
        ...(traceHandlersMs > 0 ? { handlersMs: Number(traceHandlersMs.toFixed(3)) } : {}),
        handlerCount: traceHandlerCount,
        stableEventId: opts?.eventId != null,
      });
    };

    // Deduplicate session.state — skip repeated same-state events to avoid UI flicker,
    // but still return a synthetic event so callers (store updates, idle callbacks) proceed.
    //
    // Structured queue authority fields bypass state-only dedupe. Legacy
    // diagnostic fields such as pendingCount/pendingMessages must not trigger
    // queue mutation delivery.
    if (type === 'session.state') {
      const state = String(payload.state ?? '');
      const hasQueueMutation = Array.isArray(payload.pendingMessageEntries)
        || Array.isArray(payload.transportPendingMessageEntries)
        || Array.isArray(payload.failedMessageEntries)
        || typeof payload.queueEpoch === 'string'
        || typeof payload.queueAuthorityId === 'string'
        || typeof payload.pendingMessageVersion === 'number'
        || typeof payload.transportPendingMessageVersion === 'number'
        || typeof payload.resetReason === 'string'
        || typeof payload.dropReason === 'string'
        || typeof payload.degradedReason === 'string'
        || typeof payload.queueError === 'string'
        || 'error' in payload;
      if (!hasQueueMutation && this.lastSessionState.get(sessionId) === state) {
        // State unchanged AND no queue/error snapshot — don't emit to
        // handlers/UI, but still return synthetic event for caller.
        finishTrace('synthetic');
        return { eventId: '', sessionId, ts: Date.now(), seq: 0, epoch: this.epoch, source: opts?.source ?? 'daemon', confidence: opts?.confidence ?? 'high', type, payload } as TimelineEvent;
      }
      this.lastSessionState.set(sessionId, state);
    }

    // Reset same-state dedup on visible activity so the next idle is meaningful
    // even if the previous state was already idle. Auto-continue / compact-tail
    // paths can emit assistant/tool activity without a fresh user.message or a
    // running transition; if we keep the old `idle` fingerprint, the final idle
    // is swallowed and the UI can stay in a fake-working state until refresh.
    if (
      type === 'user.message'
      || type === 'assistant.text'
      || type === 'tool.call'
      || type === 'tool.result'
      || (type === 'agent.status' && payload.status)
    ) {
      this.lastSessionState.delete(sessionId);
    }

    // Deduplicate user.message — skip if same session + same text within 5s
    if (type === 'user.message') {
      const text = String(payload.text ?? '');
      const allowDuplicate = payload.allowDuplicate === true;

      // Model selection is operational session metadata, not durable project
      // knowledge. Keep the command visible in the timeline while preventing
      // both live ingestion and later history backfill from learning it.
      if (isSessionModelSwitchCommandText(text)) {
        payload = { ...payload, memoryExcluded: true };
      }

      // Resolve temp file references: replace instruction with actual file content.
      // Guard with a `statSync` size check so an oversized paste does not block
      // the emit() main thread on a multi-MB `readFileSync`. `statSync` itself
      // is < 1ms — within our budget. PR-B follow-up: push the read fully
      // into the caller (route handler) so emit() never reads files.
      const tempMatch = text.match(TEMP_FILE_RE);
      if (tempMatch && isTrustedTempPath(tempMatch[1])) {
        const tempStart = performance.now();
        try {
          const tempPath = tempMatch[1];
          const stat = statSync(tempPath);
          if (stat.size > MAX_TEMP_FILE_INLINE_BYTES) {
            logger.warn({
              sessionId,
              path: tempPath,
              size: stat.size,
              maxBytes: MAX_TEMP_FILE_INLINE_BYTES,
            }, 'timeline-emitter: temp file exceeds inline size; keeping @ref text');
            // Surface the ref so downstream consumers (UI / file-preview)
            // can still resolve the body out-of-band.
            payload = { ...payload, tempFile: tempPath, tempFileSize: stat.size };
          } else {
            const content = readFileSync(tempPath, 'utf-8');
            payload = { ...payload, text: content, tempFile: tempPath };
          }
        } catch { /* file already cleaned up or unreadable — keep original text */ }
        finally {
          traceTempFileMs += performance.now() - tempStart;
        }
      }

      const key = sessionId;
      const resolvedText = String(payload.text ?? '');
      if (!allowDuplicate) {
        const prev = this.recentUserMsg.get(key);
        const now = Date.now();
        if (prev && prev.text === resolvedText && now - prev.ts < 5_000) {
          finishTrace('null');
          return null;
        }
        this.recentUserMsg.set(key, { text: resolvedText, ts: now });
      }
    }

    if (type === 'assistant.text' && typeof payload.text === 'string' && isMemoryNoiseTurn(payload.text)) {
      payload = {
        ...payload,
        memoryExcluded: true,
        assistantKind: typeof payload.assistantKind === 'string' ? payload.assistantKind : 'error',
      };
    }

    const seq = (this.seqMap.get(sessionId) ?? 0) + 1;
    this.seqMap.set(sessionId, seq);

    let ts = opts?.ts ?? Date.now();
    // Anchor a stable-eventId event to its FIRST-seen ts. Streaming assistant
    // text and its terminal update (⚠️ Turn cancelled / completion / error)
    // share one eventId; without this, a late terminal update — e.g. a delayed
    // stop-settle — is stamped with "now" and sinks below whatever the user
    // sent right after pressing Stop, flipping their order in the timeline
    // (both live via preferTimelineEvent and on reload from the persisted ts).
    const stableEventId = opts?.eventId;
    if (stableEventId != null) {
      const prior = this.buffer.get(sessionId)?.find((e) => e.eventId === stableEventId);
      if (prior && prior.ts < ts) ts = prior.ts;
    }
    let eventId: string;
    if (opts?.eventId) {
      eventId = opts.eventId;
    } else {
      const hashStart = performance.now();
      const payloadJson = JSON.stringify(payload);
      traceEventIdPayloadBytes = Buffer.byteLength(payloadJson);
      eventId = createHash('sha1')
        .update(`${sessionId}\0${type}\0${ts}\0${payloadJson}`)
        .digest('hex')
        .slice(0, 24);
      traceEventIdHashMs += performance.now() - hashStart;
    }

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
      ...(opts?.hidden ? { hidden: true } : {}),
    };

    // Ring buffer — stable eventId events replace in-place (streaming delta updates).
    //
    // Invariant: buffer is maintained in monotonically-non-decreasing seq order.
    // `replay()` relies on `buf[0].seq` as the earliest available seq to decide
    // ring-buffer vs JSONL fallback. If we left a replaced entry at its old
    // index after merging in a higher-seq update, `buf[0].seq` could leap
    // forward and force unnecessary JSONL reads — which became a latent
    // correctness bug once `timelineStore.append` went async (PR-A C1):
    // callers like supervision-automation reading via `replay()` would fall
    // through to a JSONL file that hadn't been written yet. We therefore
    // remove the replaced entry from its current index and push the merged
    // event at the end so the buffer stays seq-sorted.
    let buf = this.buffer.get(sessionId);
    if (!buf) {
      buf = [];
      this.buffer.set(sessionId, buf);
    }
    const isStableUpdate = opts?.eventId != null;
    if (isStableUpdate) {
      const existingIdx = buf.findIndex((e) => e.eventId === eventId);
      if (existingIdx >= 0) {
        const merged = preferTimelineEvent(buf[existingIdx]!, event);
        // Splice out the old slot, then push the merged event so it lands at
        // the tail. `seq` on the merged event is the higher of the two by
        // `preferTimelineEvent`'s rules, which keeps the buffer sorted.
        buf.splice(existingIdx, 1);
        buf.push(merged);
      } else {
        buf.push(event);
      }
    } else {
      buf.push(event);
    }
    if (buf.length > MAX_BUFFER) {
      buf.splice(0, buf.length - MAX_BUFFER);
    }

    // Persist to disk — skip intermediate streaming events (streaming: true with stable eventId)
    // to avoid JSONL bloat; the final version (streaming: false) will be persisted by onComplete
    const isStreamingDelta = isStableUpdate && payload.streaming === true;
    if (!isStreamingDelta) {
      const appendStart = performance.now();
      timelineStore.append(event);
      traceAppendScheduleMs += performance.now() - appendStart;
      // Mirror per-turn `usage.update` into SQLite so operators can query
      // historical token spend without parsing JSONL. Best-effort — failures
      // never escape (recordTurnUsage swallows internally + extra try/catch).
      // Final-only: streaming deltas don't reach here.
      //
      // Round-2 audit (0699ea64-3e6 finding A1): synchronous call + eventId
      // idempotency key. Replaced the previous `void import(...).then(...)`
      // pattern — there is no real cyclic dependency on context-store, and
      // the .then deferred path lost rows under SIGTERM races. Passing
      // `eventId` lets the partial UNIQUE index swallow replay duplicates
      // (e.g. gemini-watcher's deterministic stableId on daemon restart).
      if (type === 'usage.update') {
        const usageStart = performance.now();
        try {
          const sessionRecord = getSession(sessionId);
          const parentSessionName = sessionRecord?.parentSession ?? null;
          recordTurnUsage({
            createdAt: ts,
            sessionName: sessionId,
            agentType: typeof payload.agentType === 'string' ? payload.agentType : null,
            provider: typeof payload.provider === 'string' ? payload.provider : null,
            model: typeof payload.model === 'string' ? payload.model : null,
            sessionKind: parentSessionName ? 'sub' : 'main',
            parentSessionName,
            metadataCompleteness: parentSessionName || !sessionId.startsWith('deck_sub_') ? 'complete' : 'partial',
            inputTokens: typeof payload.inputTokens === 'number' ? payload.inputTokens : 0,
            cacheTokens: typeof payload.cacheTokens === 'number' ? payload.cacheTokens : 0,
            outputTokens: typeof payload.outputTokens === 'number' ? payload.outputTokens : 0,
            contextWindow: typeof payload.contextWindow === 'number' ? payload.contextWindow : null,
            costUsd: typeof payload.costUsd === 'number' ? payload.costUsd : null,
            eventId,
          });
        } catch { /* swallow — telemetry must never escape */ }
        finally {
          traceUsageMs += performance.now() - usageStart;
        }
      }
    }

    // Notify handlers
    const handlersStart = performance.now();
    for (const h of this.handlers) {
      traceHandlerCount += 1;
      try { h(event); } catch { /* ignore */ }
    }
    traceHandlersMs += performance.now() - handlersStart;

    finishTrace('event');
    return event;
  }

  on(handler: (e: TimelineEvent) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** Return a copy of the live in-memory buffer for readers that need the
   * just-emitted event before the async timeline projection catches up. */
  getBufferedEvents(sessionId: string): TimelineEvent[] {
    return [...(this.buffer.get(sessionId) ?? [])];
  }

  /**
   * Replay events after a given seq for a session.
   *
   * Fast path: when the ring buffer's earliest entry already covers
   * `afterSeq + 1`, serve directly from memory — no JSONL hit. This is
   * the common case for tight WS reconnect windows and for in-process
   * readers (e.g. supervision-automation) that emit and read in the
   * same tick.
   *
   * Slow path: when older events were evicted from the buffer, read
   * the JSONL tail and MERGE with the live buffer so callers see both
   * historic events (from disk) and the still-in-buffer head — even
   * when `timelineStore.append` writes are still in flight (PR-A C1
   * made appends async; without this merge the slow path would lose
   * any event whose JSONL write hadn't landed yet).
   */
  replay(sessionId: string, afterSeq: number): { events: TimelineEvent[]; truncated: boolean; source: TimelineResponseSource } {
    const buf = this.buffer.get(sessionId) ?? [];

    // Fast path — buffer covers everything from afterSeq+1 forward.
    if (buf.length > 0 && (afterSeq + 1) >= buf[0].seq) {
      const events = buf.filter(e => e.seq > afterSeq);
      return { events, truncated: false, source: TIMELINE_RESPONSE_SOURCES.RING_BUFFER };
    }

    // Slow path — buffer alone can't satisfy the request. Read JSONL
    // tail for the historic portion, then layer in any buffer event
    // not already present on disk (handles async-append in-flight
    // writes + buffer in-place stable-eventId updates).
    const fileEvents = timelineStore.read(sessionId, { epoch: this.epoch, afterSeq });
    if (buf.length === 0) {
      return { events: fileEvents, truncated: false, source: TIMELINE_RESPONSE_SOURCES.JSONL_TAIL };
    }
    const seen = new Set<string>();
    for (const e of fileEvents) seen.add(`${e.epoch}:${e.seq}`);
    const merged: TimelineEvent[] = [...fileEvents];
    for (const e of buf) {
      if (e.seq <= afterSeq) continue;
      const key = `${e.epoch}:${e.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
    }
    merged.sort((a, b) => a.seq - b.seq);
    return { events: merged, truncated: false, source: TIMELINE_RESPONSE_SOURCES.RING_BUFFER_JSONL };
  }

  /**
   * Drop all in-memory state for a session that has been permanently removed
   * (stopped/closed). Without this the per-session ring buffer + seq/state/
   * dedup maps are retained for EVERY session that ever emitted — an unbounded
   * leak as sub-sessions and discussion sessions churn (the daemon climbs to
   * multiple GB and eventually wedges). The on-disk timeline (timelineStore) is
   * untouched, so deep history still replays from it via the slow path.
   */
  forgetSession(sessionId: string): void {
    this.buffer.delete(sessionId);
    this.seqMap.delete(sessionId);
    this.lastSessionState.delete(sessionId);
    this.recentUserMsg.delete(sessionId);
  }
}

export const timelineEmitter = new TimelineEmitter();
