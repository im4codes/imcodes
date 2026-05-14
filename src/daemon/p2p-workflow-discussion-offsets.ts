/**
 * P2P workflow discussion read offsets (Tasks 5.4 / 12.4).
 *
 * Implements per-(run, source) incremental discussion reads using the shape
 * defined in `shared/p2p-workflow-types.ts::P2pDiscussionReadOffset`:
 *
 *   { byteOffset, sha256Prefix, sizeAtOffset }
 *
 * On size/hash mismatch (rotation, truncation, divergent prefix bytes) the
 * runtime resets to a safe full bounded read or fails closed depending on the
 * declared source policy. State lives entirely in the daemon process — it is
 * private runtime state, never persisted or projected to the public surface.
 */
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import {
  makeP2pWorkflowDiagnostic,
  makeP2pWorkflowWarning,
  type P2pWorkflowDiagnostic,
} from '../../shared/p2p-workflow-diagnostics.js';

/** First 16 hex chars of sha256(file contents read so far). */
const SHA256_PREFIX_HEX_LENGTH = 16;
/** Default bounded read cap matches the existing daemon discussion read budget. */
const DEFAULT_MAX_BYTES = 256 * 1024;

export interface RecordedReadOffset {
  byteOffset: number;
  /** First 16 hex chars of sha256(file contents read so far). */
  sha256Prefix: string;
  /** File size at the time the offset was recorded. */
  sizeAtOffset: number;
  recordedAt: string;
}

export type ReadDiscussionResetReason =
  | 'fresh'
  | 'mismatch_safe_reset'
  | 'mismatch_fail_closed'
  | 'incremental';

export interface ReadDiscussionResult {
  /** UTF-8 text from the resolved offset (or full bounded read on mismatch). */
  content: string;
  /** Updated offset after this read (may be unchanged on fail-closed). */
  newOffset: RecordedReadOffset;
  reset: ReadDiscussionResetReason;
  diagnostics: P2pWorkflowDiagnostic[];
}

export type ReadDiscussionMismatchPolicy = 'fail' | 'reset';

export interface ReadDiscussionArgs {
  runId: string;
  /** Logical source key, e.g. discussion file path or `file_reference` source id. */
  sourceKey: string;
  /** Absolute path within the repo/project root. Caller is responsible for sandboxing. */
  filePath: string;
  /** Source missing/mismatch policy: `'fail'` fails closed, `'reset'` returns a safe bounded read. */
  policy: ReadDiscussionMismatchPolicy;
  /** Optional bounded read cap (defaults to 256 KiB). */
  maxBytes?: number;
}

interface OffsetMapValue {
  offset: RecordedReadOffset;
}

// Per-run, per-source offset state. Map<runId, Map<sourceKey, { offset }>>.
const READ_OFFSETS = new Map<string, Map<string, OffsetMapValue>>();

function bucketFor(runId: string): Map<string, OffsetMapValue> {
  let bucket = READ_OFFSETS.get(runId);
  if (!bucket) {
    bucket = new Map();
    READ_OFFSETS.set(runId, bucket);
  }
  return bucket;
}

export function getRecordedReadOffset(runId: string, sourceKey: string): RecordedReadOffset | null {
  const bucket = READ_OFFSETS.get(runId);
  if (!bucket) return null;
  const entry = bucket.get(sourceKey);
  return entry ? { ...entry.offset } : null;
}

export function clearReadOffsetsForRun(runId: string): void {
  READ_OFFSETS.delete(runId);
}

export function __resetReadOffsetsForTests(): void {
  READ_OFFSETS.clear();
}

interface ReadRangeResult {
  bytesRead: number;
  text: string;
  prefixHashFull: string;
}

async function readRange(
  filePath: string,
  start: number,
  end: number,
  prefixHashSeed: string | null,
): Promise<ReadRangeResult> {
  const length = Math.max(0, end - start);
  if (length === 0) {
    return { bytesRead: 0, text: '', prefixHashFull: prefixHashSeed ?? '' };
  }
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const slice = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
    const text = slice.toString('utf8');
    let prefixHashFull = prefixHashSeed ?? '';
    if (start === 0 && bytesRead > 0) {
      // Hashes the entire returned slice (full bounded read or fresh first read).
      prefixHashFull = createHash('sha256').update(slice).digest('hex');
    }
    return { bytesRead, text, prefixHashFull };
  } finally {
    await handle.close();
  }
}

async function computePrefixHash(filePath: string, byteOffset: number): Promise<string> {
  if (byteOffset <= 0) return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const handle = await open(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const chunkSize = 64 * 1024;
    let remaining = byteOffset;
    let position = 0;
    const buffer = Buffer.allocUnsafe(chunkSize);
    while (remaining > 0) {
      const toRead = Math.min(chunkSize, remaining);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead <= 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function recordOffset(
  runId: string,
  sourceKey: string,
  byteOffset: number,
  sizeAtOffset: number,
  prefixHashFull: string,
): RecordedReadOffset {
  const offset: RecordedReadOffset = {
    byteOffset,
    sha256Prefix: prefixHashFull.slice(0, SHA256_PREFIX_HEX_LENGTH),
    sizeAtOffset,
    recordedAt: new Date().toISOString(),
  };
  bucketFor(runId).set(sourceKey, { offset });
  return { ...offset };
}

/**
 * Read a discussion file with per-(run, source) incremental offset tracking.
 *
 * - First read or no prior offset → bounded read from byte 0, record offset, returns `fresh`.
 * - Prior offset matches (size ≥ recorded sizeAtOffset AND sha256Prefix of bytes
 *   `0..byteOffset` matches) → bounded read of bytes `byteOffset..min(EOF, byteOffset+maxBytes)`,
 *   advance offset to the actual end of the consumed range, returns `incremental`.
 * - Mismatch + `policy === 'reset'` → bounded read from byte 0, record fresh
 *   offset, returns `mismatch_safe_reset` + warning diagnostic.
 * - Mismatch + `policy === 'fail'` → throws + returns `mismatch_fail_closed`
 *   with an error diagnostic; the recorded offset is **not** advanced.
 */
export async function readP2pDiscussionWithOffset(args: ReadDiscussionArgs): Promise<ReadDiscussionResult> {
  const { runId, sourceKey, filePath, policy } = args;
  const maxBytes = Math.max(1, args.maxBytes ?? DEFAULT_MAX_BYTES);

  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;

  const previous = bucketFor(runId).get(sourceKey)?.offset ?? null;

  // Fresh path: no prior offset → bounded full read from byte 0.
  if (!previous) {
    const end = Math.min(fileSize, maxBytes);
    const range = await readRange(filePath, 0, end, null);
    const newOffset = recordOffset(runId, sourceKey, range.bytesRead, fileSize, range.prefixHashFull);
    return { content: range.text, newOffset, reset: 'fresh', diagnostics: [] };
  }

  // Mismatch detection — file shrank below recorded sizeAtOffset, or the prefix
  // hash of the bytes preceding the offset diverges (rotation / rewrite).
  let mismatch = fileSize < previous.sizeAtOffset || fileSize < previous.byteOffset;
  let prefixHashFull = '';
  if (!mismatch) {
    prefixHashFull = await computePrefixHash(filePath, previous.byteOffset);
    if (prefixHashFull.slice(0, SHA256_PREFIX_HEX_LENGTH) !== previous.sha256Prefix) {
      mismatch = true;
    }
  }

  if (mismatch) {
    if (policy === 'fail') {
      // Reuse `missing_context_source` (`['bind','execute']`) — no dedicated
      // offset-mismatch code exists in `P2P_WORKFLOW_DIAGNOSTIC_CODES`; this is
      // the closest applicable code per the source-policy semantics.
      const diagnostic = makeP2pWorkflowDiagnostic('missing_context_source', 'execute', {
        runId,
        fieldPath: `discussionOffset.${sourceKey}`,
        summary: 'Discussion source diverged from recorded read offset; failing closed per policy.',
      });
      const error = new Error('discussion_read_offset_mismatch') as Error & { code?: string };
      error.code = 'discussion_read_offset_mismatch';
      throw Object.assign(error, {
        diagnostic,
        result: {
          // Caller wraps the throw for transport; this preserves the contract
          // shape so a catcher that wants to surface it can recover gracefully.
          content: '',
          newOffset: { ...previous },
          reset: 'mismatch_fail_closed' as ReadDiscussionResetReason,
          diagnostics: [diagnostic],
        } satisfies ReadDiscussionResult,
      });
    }
    // policy === 'reset' → safe bounded re-read from byte 0.
    const end = Math.min(fileSize, maxBytes);
    const range = await readRange(filePath, 0, end, null);
    const newOffset = recordOffset(runId, sourceKey, range.bytesRead, fileSize, range.prefixHashFull);
    const diagnostic = makeP2pWorkflowWarning('missing_context_source', 'execute', {
      runId,
      fieldPath: `discussionOffset.${sourceKey}`,
      summary: 'Discussion source diverged from recorded read offset; safely reset to full bounded read.',
    });
    return { content: range.text, newOffset, reset: 'mismatch_safe_reset', diagnostics: [diagnostic] };
  }

  // Incremental path: read [byteOffset, min(EOF, byteOffset + maxBytes)).
  const start = previous.byteOffset;
  const end = Math.min(fileSize, start + maxBytes);
  const range = await readRange(filePath, start, end, prefixHashFull);
  const consumed = range.bytesRead;
  const advancedOffset = start + consumed;
  // Recompute prefix hash over the new prefix [0, advancedOffset).
  const newPrefixFull = consumed === 0
    ? prefixHashFull
    : await computePrefixHash(filePath, advancedOffset);
  const newOffset = recordOffset(runId, sourceKey, advancedOffset, fileSize, newPrefixFull);
  return { content: range.text, newOffset, reset: 'incremental', diagnostics: [] };
}
