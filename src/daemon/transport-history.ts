/**
 * Transport session JSONL history — local cache for transport-backed agent messages.
 * Each session gets a JSONL file at ~/.imcodes/transport/{sessionKey}.jsonl
 * Provides append (on each event) and replay (on browser subscribe).
 */

import { appendFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../util/logger.js';

const TRANSPORT_DIR = join(homedir(), '.imcodes', 'transport');
const MAX_REPLAY_LINES = 200;
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

/** Append a transport event to the session's JSONL file. */
export async function appendTransportEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  try {
    await ensureDir();
    const line = JSON.stringify({ ...event, _ts: Date.now() }) + '\n';
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
        events.push(JSON.parse(line) as Record<string, unknown>);
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
