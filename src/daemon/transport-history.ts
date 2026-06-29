/**
 * Transport session JSONL history — local cache for transport-backed agent messages.
 * Each session gets a JSONL file at ~/.imcodes/transport/{sessionKey}.jsonl
 * Provides append (on each event) and replay (on browser subscribe).
 */

import { appendFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TIMELINE_PAYLOAD_BUDGET_BYTES } from '../../shared/timeline-payload-budget.js';
import logger from '../util/logger.js';

const TRANSPORT_DIR = join(homedir(), '.imcodes', 'transport');
const MAX_REPLAY_LINES = 200;
export const TRANSPORT_HISTORY_REPLAY_BUDGET_BYTES = TIMELINE_PAYLOAD_BUDGET_BYTES.CHAT_HISTORY_TRACE_HARD_LIMIT;
/**
 * Reverse-read chunk size for the tail-N-lines scan. Small enough to
 * short-circuit on sessions with tiny messages, large enough to cover a
 * few dense tool-output lines per read so we rarely need more than one
 * syscall.
 */
const TAIL_CHUNK_BYTES = 64 * 1024; // 64 KiB per read
/**
 * Hard ceiling on how much of a transport JSONL we'll ever pull in to
 * extract the last {@link MAX_REPLAY_LINES} entries.
 *
 * Daemon file stores grow unbounded — on a 211 production daemon we saw
 * 170MB+ per session after a week of runtime. The previous impl called
 * `readFile(full)` then `.split('\n').slice(-200)`, so every browser
 * subscribe / session resume allocated a ~170MB JS string (~340MB V8
 * UTF-16) plus a full per-line array. Concurrent subscribes from
 * multiple browsers compounded that into multi-GB transient spikes and
 * ~80MB/min sustained RSS growth on the daemon.
 *
 * With the reverse-chunk tail read we normally stop well before this
 * cap — but pathological JSONL with a handful of multi-MB tool-output
 * lines could otherwise read back to the start of a huge file. 16 MiB
 * is enough headroom for 200 tail entries even with 80KB-avg lines.
 */
const MAX_TAIL_BYTES = 16 * 1024 * 1024; // 16 MiB cap
const NEWLINE_BYTE = 0x0a;
export const TRANSPORT_HISTORY_TOOL_RESULT_PREVIEW_BYTES = 1024;
const TRANSPORT_HISTORY_TRUNCATED_MARKER = '\n[transport result truncated]';
const RENDERABLE_TRANSPORT_HISTORY_TYPES = new Set(['user.message', 'assistant.text', 'tool.call', 'tool.result']);

let dirEnsured = false;

async function ensureDir(): Promise<void> {
  if (dirEnsured) return;
  await mkdir(TRANSPORT_DIR, { recursive: true });
  dirEnsured = true;
}

function sessionFile(sessionId: string): string {
  // Sanitize session ID for filesystem (replace non-alphanumeric except dash/underscore)
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(TRANSPORT_DIR, `${safe}.jsonl`);
}

function shouldKeepTransportHistoryEvent(event: Record<string, unknown>): boolean {
  if (event.hidden === true) return false;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'tool.call') return readToolCallId(event) !== null;
  return RENDERABLE_TRANSPORT_HISTORY_TYPES.has(type);
}

function readToolCallId(event: Record<string, unknown>): string | null {
  for (const key of ['toolCallId', 'toolUseId', 'callId', 'id']) {
    const value = event[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function truncateStringByUtf8Bytes(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) return { value, truncated: false };
  const markerBytes = Buffer.byteLength(TRANSPORT_HISTORY_TRUNCATED_MARKER, 'utf8');
  const targetBytes = Math.max(0, maxBytes - markerBytes);
  let end = Math.min(value.length, targetBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > targetBytes) {
    end = Math.floor(end * 0.9);
  }
  return {
    value: `${value.slice(0, end)}${TRANSPORT_HISTORY_TRUNCATED_MARKER}`,
    truncated: true,
  };
}

function previewTransportResultValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') return truncateStringByUtf8Bytes(value, TRANSPORT_HISTORY_TOOL_RESULT_PREVIEW_BYTES);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return { value, truncated: false };
  }
  return { value: '[non-string result omitted from transport history]', truncated: true };
}

function previewField(
  out: Record<string, unknown>,
  key: 'output' | 'error',
  value: unknown,
  truncatedFields: string[],
): void {
  if (value === undefined) return;
  const preview = previewTransportResultValue(value);
  if (preview.value !== undefined) out[key] = preview.value;
  if (preview.truncated) truncatedFields.push(key);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pickToolResultOutput(event: Record<string, unknown>): unknown {
  if (event.output !== undefined) return event.output;
  const detail = record(event.detail);
  return detail?.output ?? detail?.content;
}

function pickToolResultError(event: Record<string, unknown>): unknown {
  if (event.error !== undefined) return event.error;
  const detail = record(event.detail);
  return detail?.error;
}

function preserveTruncationMetadata(source: Record<string, unknown>, out: Record<string, unknown>, fields: string[]): void {
  const existingFields = Array.isArray(source.transportHistoryTruncatedFields)
    ? source.transportHistoryTruncatedFields.filter((field): field is string => typeof field === 'string')
    : [];
  const truncatedFields = [...new Set([...existingFields, ...fields])];
  if (truncatedFields.length === 0 && source.transportHistoryTruncated !== true) return;

  out.transportHistoryTruncated = true;
  out.transportHistoryLimitBytes = TRANSPORT_HISTORY_TOOL_RESULT_PREVIEW_BYTES;
  if (truncatedFields.length > 0) {
    out.transportHistoryTruncatedFields = truncatedFields;
  }
}

export function sanitizeTransportHistoryEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === 'tool.call') {
    const out: Record<string, unknown> = { type: 'tool.call' };
    for (const key of ['sessionId', 'toolCallId', 'toolUseId', 'callId', 'id', 'tool', '_ts']) {
      if (event[key] !== undefined) out[key] = event[key];
    }
    if (event.activityGeneration !== undefined) out.activityGeneration = event.activityGeneration;
    return out;
  }

  if (event.type !== 'tool.result') return event;

  const truncatedFields: string[] = [];
  const out: Record<string, unknown> = { type: 'tool.result' };

  for (const key of ['sessionId', 'toolCallId', 'toolUseId', 'callId', 'id', 'tool', 'terminalStatus', 'terminalReason', 'activityGeneration', 'synthetic', 'source', 'decisionReason', 'idempotencyKey', 'turnId', 'itemKind', '_ts']) {
    if (event[key] !== undefined) out[key] = event[key];
  }
  previewField(out, 'output', pickToolResultOutput(event), truncatedFields);
  previewField(out, 'error', pickToolResultError(event), truncatedFields);
  preserveTruncationMetadata(event, out, truncatedFields);

  return out;
}

function chatHistoryEnvelopeBytes(sessionId: string, events: readonly Record<string, unknown>[]): number {
  return Buffer.byteLength(JSON.stringify({ type: 'chat.history', sessionId, events }), 'utf8');
}

export function trimTransportHistoryEventsToReplayBudget(sessionId: string, events: Record<string, unknown>[]): Record<string, unknown>[] {
  if (events.length === 0) return events;
  if (chatHistoryEnvelopeBytes(sessionId, events) <= TRANSPORT_HISTORY_REPLAY_BUDGET_BYTES) return events;
  const kept: Record<string, unknown>[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    kept.unshift(events[index]!);
    if (chatHistoryEnvelopeBytes(sessionId, kept) > TRANSPORT_HISTORY_REPLAY_BUDGET_BYTES) {
      kept.shift();
      break;
    }
  }
  return kept;
}

/** Append a transport event to the session's JSONL file. */
export async function appendTransportEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  try {
    if (!shouldKeepTransportHistoryEvent(event)) return;
    await ensureDir();
    const line = JSON.stringify(sanitizeTransportHistoryEvent({ ...event, _ts: Date.now() })) + '\n';
    await appendFile(sessionFile(sessionId), line, 'utf8');
  } catch (err) {
    logger.debug({ sessionId, err }, 'transport-history: append failed');
  }
}

/**
 * Read recent history for a session — returns parsed event objects (last
 * {@link MAX_REPLAY_LINES} lines).
 *
 * Uses a reverse-chunk tail scan: read 64 KiB at a time from EOF backward,
 * counting newlines, and stop as soon as we've seen
 * `MAX_REPLAY_LINES + 1` of them (the +1 lets us drop the leading partial
 * line cleanly). For short-message sessions this is typically a single
 * syscall; for rare sessions with very large lines we keep scanning up to
 * {@link MAX_TAIL_BYTES}. Allocation is bounded by
 * `min(file_size, MAX_TAIL_BYTES)` regardless of total file size, so
 * multi-hundred-MB JSONLs no longer force a ~340MB V8 string allocation.
 */
export async function replayTransportHistory(sessionId: string): Promise<Record<string, unknown>[]> {
  let fh;
  try {
    fh = await open(sessionFile(sessionId), 'r');
    const { size } = await fh.stat();
    if (size === 0) return [];

    // We want `MAX_REPLAY_LINES` complete lines. If our scan reaches the
    // start of the file we get them all; otherwise we need one extra
    // newline so the FIRST newline in our buffer marks the start of a
    // known-clean line and we can drop the partial prefix.
    const WANT_NEWLINES = MAX_REPLAY_LINES + 1;

    // Reverse-read in chunks. `buf` holds the rolling tail of the file in
    // normal byte order — we prepend each new chunk so concatenation is
    // correct left-to-right, and its last byte is always the last byte of
    // the file.
    let offset = size;
    let buf = Buffer.alloc(0);
    let newlineCount = 0;

    while (offset > 0 && newlineCount < WANT_NEWLINES && (size - offset) < MAX_TAIL_BYTES) {
      const remaining = MAX_TAIL_BYTES - (size - offset);
      const readSize = Math.min(TAIL_CHUNK_BYTES, offset, remaining);
      const next = Buffer.alloc(readSize);
      offset -= readSize;
      await fh.read(next, 0, readSize, offset);
      // Count newlines in the fresh chunk BEFORE concat so cost is O(chunk),
      // not O(accumulated buffer).
      for (let i = 0; i < readSize; i++) {
        if (next[i] === NEWLINE_BYTE) newlineCount++;
      }
      buf = buf.length === 0 ? next : Buffer.concat([next, buf]);
    }

    const content = buf.toString('utf8');
    // If our scan didn't reach the start of the file, the buffer's first
    // line is a broken JSON suffix — drop everything up to and including
    // the first newline. When `offset === 0` we actually reached the
    // start and the first line is complete.
    const partialStart = offset === 0 ? 0 : content.indexOf('\n') + 1;
    const lines = content.slice(partialStart).split('\n').filter(Boolean);
    const recent = lines.slice(-MAX_REPLAY_LINES);
    const events: Record<string, unknown>[] = [];
    for (const line of recent) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (!shouldKeepTransportHistoryEvent(parsed)) continue;
        events.push(sanitizeTransportHistoryEvent(parsed));
      } catch { /* skip malformed — e.g. lines that are themselves longer
                   than MAX_TAIL_BYTES end up truncated */ }
    }
    return events;
  } catch {
    return []; // file doesn't exist yet
  } finally {
    if (fh) {
      // Always release the fd — previously `readFile` did this implicitly,
      // but with a manual `open` we MUST close ourselves to avoid leaking
      // one fd per replay call.
      try { await fh.close(); } catch { /* best-effort */ }
    }
  }
}
