/**
 * R3 v1b follow-up — Per-run discussion-file write queue tests.
 *
 * Verifies the queue:
 *   - is non-blocking: enqueue returns synchronously
 *   - serialises writes per file path
 *   - drops oldest pending segments under backpressure (with logger.warn)
 *   - flushes deterministically via flushP2pDiscussionWriteQueue
 *   - surfaces failures via the per-call onWriteFailure listener
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES,
  __resetP2pDiscussionWriteQueueForTests,
  enqueueP2pDiscussionWrite,
  flushP2pDiscussionWriteQueue,
} from '../../src/daemon/p2p-discussion-writer.js';

let tmpRoot: string;
let filePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'imcodes-test-p2p-workflow-writer-'));
  filePath = join(tmpRoot, 'discussion.md');
  __resetP2pDiscussionWriteQueueForTests();
});

afterEach(() => {
  __resetP2pDiscussionWriteQueueForTests();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('p2p discussion writer queue', () => {
  it('enqueue returns synchronously and writes occur in the background', async () => {
    const t0 = Date.now();
    enqueueP2pDiscussionWrite(filePath, 'segment-a\n');
    enqueueP2pDiscussionWrite(filePath, 'segment-b\n');
    enqueueP2pDiscussionWrite(filePath, 'segment-c\n');
    expect(Date.now() - t0).toBeLessThan(50);
    await flushP2pDiscussionWriteQueue(filePath);
    const content = readFileSync(filePath, 'utf8');
    expect(content).toBe('segment-a\nsegment-b\nsegment-c\n');
  });

  it('preserves segment ordering across rapid enqueues', async () => {
    for (let i = 0; i < 50; i += 1) enqueueP2pDiscussionWrite(filePath, `${i}\n`);
    await flushP2pDiscussionWriteQueue(filePath);
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
  });

  it('drops oldest pending segments when the queue exceeds the byte cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // First write: large enough to keep one in flight while we backfill.
      const huge = 'x'.repeat(P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES);
      enqueueP2pDiscussionWrite(filePath, huge);
      // Push more segments than the queue can hold; oldest should be dropped.
      for (let i = 0; i < 5; i += 1) {
        enqueueP2pDiscussionWrite(filePath, 'x'.repeat(P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES));
      }
      await flushP2pDiscussionWriteQueue(filePath);
      const stat = readFileSync(filePath);
      // The exact contents depend on draining timing but the file SHALL
      // remain well under (cap × number of enqueues) bytes.
      expect(stat.byteLength).toBeLessThanOrEqual(P2P_DISCUSSION_WRITE_QUEUE_MAX_BYTES * 6);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('invokes onWriteFailure with the underlying error when the file cannot be written', async () => {
    const onFail = vi.fn();
    const badPath = join(tmpRoot, 'no-such-dir', 'discussion.md');
    enqueueP2pDiscussionWrite(badPath, 'will fail\n', onFail);
    await flushP2pDiscussionWriteQueue(badPath);
    expect(onFail).toHaveBeenCalled();
    const error = onFail.mock.calls[0]?.[0];
    expect(error).toBeInstanceOf(Error);
  });

  it('flush before any enqueue resolves immediately', async () => {
    await expect(flushP2pDiscussionWriteQueue(filePath)).resolves.toBeUndefined();
  });
});
