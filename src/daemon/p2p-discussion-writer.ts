/**
 * Per-run non-blocking discussion-file writer.
 *
 * R3 v1b follow-up (W2) — `appendFile(run.contextFilePath, segment)` was
 * previously awaited on the script / logic dispatch hot path. With large
 * NDJSON outputs that introduces visible latency before the executor can
 * advance to the next round. We now hand writes to a per-run serialized
 * queue: the dispatcher returns immediately, the queue drains in the
 * background, and failures surface via `addHelperDiagnostic` / logger.warn
 * (preserving the D-O3 spec: in-memory `authoritativeSegment` is the
 * verdict source-of-truth; the discussion file is best-effort audit).
 *
 * The queue is bounded by byte budget per run — once exceeded, oldest
 * pending segments are dropped with a single warning so a runaway
 * producer can't OOM the daemon. The queue writes serially per file
 * path so segments stay ordered.
 */

import { appendFile } from 'node:fs/promises';
import logger from '../util/logger.js';

export const P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB pending per run

interface RunQueue {
  pendingSegments: string[];
  pendingBytes: number;
  draining: boolean;
  /** Notified after each drain step; tests can `await` it. */
  drainPromise: Promise<void>;
  resolveDrain: () => void;
  /** Invoked after each successful append (test hook). */
  onWriteFailure?: (error: unknown) => void;
  /**
   * R3 v2 PR-ζ (M1) — Invoked when the queue drops a pending segment due
   * to backpressure (cap exceeded). Allows the orchestrator to surface a
   * `P2P_DISCUSSION_WRITE_FAILED` helper diagnostic so audit gaps are
   * visible to web/UI, not just buried in daemon logs.
   */
  onSegmentDropped?: (droppedBytes: number, queuedBytes: number) => void;
}

const queues = new Map<string, RunQueue>();

export interface P2pDiscussionWriteQueueSnapshot {
  filePath: string;
  pendingSegments: number;
  pendingBytes: number;
  draining: boolean;
}

export function listP2pDiscussionWriteQueueSnapshots(): P2pDiscussionWriteQueueSnapshot[] {
  return [...queues.entries()].map(([filePath, queue]) => ({
    filePath,
    pendingSegments: queue.pendingSegments.length,
    pendingBytes: queue.pendingBytes,
    draining: queue.draining,
  }));
}

function makeDrainPromise(queue: RunQueue): void {
  let resolve!: () => void;
  queue.drainPromise = new Promise<void>((res) => { resolve = res; });
  queue.resolveDrain = resolve;
}

function getOrCreateQueue(filePath: string): RunQueue {
  let queue = queues.get(filePath);
  if (!queue) {
    queue = {
      pendingSegments: [],
      pendingBytes: 0,
      draining: false,
      drainPromise: Promise.resolve(),
      resolveDrain: () => {},
    };
    makeDrainPromise(queue);
    queues.set(filePath, queue);
  }
  return queue;
}

/**
 * Enqueue a discussion-file write. Returns immediately — the caller does
 * NOT await disk I/O. `onWriteFailure` (when supplied) is invoked once
 * per failed write so the orchestrator can surface a helper diagnostic
 * with the run's `currentRoundAttempt` context.
 */
export function enqueueP2pDiscussionWrite(
  filePath: string,
  segment: string,
  onWriteFailure?: (error: unknown) => void,
  onSegmentDropped?: (droppedBytes: number, queuedBytes: number) => void,
): void {
  if (segment.length === 0) return;
  const queue = getOrCreateQueue(filePath);
  if (onWriteFailure) queue.onWriteFailure = onWriteFailure;
  if (onSegmentDropped) queue.onSegmentDropped = onSegmentDropped;
  // Backpressure: if pending buffer exceeds cap, drop oldest segments.
  // We never drop the newest write; that's the one carrying the latest
  // executor decision and the most useful audit data.
  while (queue.pendingBytes + segment.length > P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES && queue.pendingSegments.length > 0) {
    const dropped = queue.pendingSegments.shift()!;
    queue.pendingBytes -= dropped.length;
    logger.warn(
      { filePath, droppedBytes: dropped.length, queuedBytes: queue.pendingBytes },
      'P2P: discussion write queue full, dropping oldest pending segment',
    );
    // R3 v2 PR-ζ (M1) — surface drop to the orchestrator so a helper
    // diagnostic appears in the run state (web/UI can render it).
    try { queue.onSegmentDropped?.(dropped.length, queue.pendingBytes); } catch { /* swallow listener errors */ }
  }
  queue.pendingSegments.push(segment);
  queue.pendingBytes += segment.length;
  if (!queue.draining) {
    queue.draining = true;
    void drain(filePath, queue);
  }
}

/**
 * R3 v2 PR-ζ (A6 / O4) — Drop the queue for `filePath`. Called by the
 * orchestrator's terminal cleanup hook so the per-run queue Map does NOT
 * leak run objects via the `onWriteFailure` / `onSegmentDropped`
 * closures. Pending segments are flushed best-effort first; failure is
 * swallowed (run is terminal, no consumer to notify).
 */
export async function dropP2pDiscussionWriteQueue(filePath: string): Promise<void> {
  const queue = queues.get(filePath);
  if (!queue) return;
  try {
    if (queue.draining || queue.pendingSegments.length > 0) {
      await queue.drainPromise;
    }
  } catch {
    // ignore — best effort
  }
  queues.delete(filePath);
}

async function drain(filePath: string, queue: RunQueue): Promise<void> {
  while (queue.pendingSegments.length > 0) {
    // Coalesce: write all pending segments in one call so we minimise
    // open() / fsync() syscalls and keep ordering trivially correct.
    const batch = queue.pendingSegments.join('');
    queue.pendingSegments = [];
    queue.pendingBytes = 0;
    try {
      await appendFile(filePath, batch, 'utf8');
    } catch (error) {
      logger.warn(
        { filePath, error: error instanceof Error ? error.message : String(error) },
        'P2P: discussion write failed (queue)',
      );
      try { queue.onWriteFailure?.(error); } catch { /* swallow listener errors */ }
    }
  }
  queue.draining = false;
  // Wake up flush waiters and prepare a fresh promise for the next batch.
  const resolve = queue.resolveDrain;
  makeDrainPromise(queue);
  resolve();
}

/**
 * Wait until the queue for `filePath` is empty. Returned promise resolves
 * once the next drain cycle finishes; callers awaiting before any
 * enqueue may resolve immediately. Used by tests + by run shutdown when
 * we want to guarantee the discussion file is up-to-date before
 * producing the final summary.
 */
export async function flushP2pDiscussionWriteQueue(filePath: string): Promise<void> {
  const queue = queues.get(filePath);
  if (!queue) return;
  if (!queue.draining && queue.pendingSegments.length === 0) return;
  await queue.drainPromise;
}

/** Test-only: drop all queues (between tests). */
export function __resetP2pDiscussionWriteQueueForTests(): void {
  queues.clear();
}
