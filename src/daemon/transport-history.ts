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
 * Cap how much of the JSONL file we pull in for a replay read.
 *
 * Daemon file store JSONLs grow unbounded — on a 211 production daemon we
 * observed 170MB+ per session after a week of runtime. The previous impl
 * called `readFile(full)` and then `.split('\n').slice(-200)`, so every
 * browser subscribe / session resume allocated a ~170MB JS string
 * (~340MB V8 UTF-16) plus a full per-line array. Concurrent subscribes
 * from multiple browsers compounded that into multi-GB transient spikes
 * and caused sustained RSS growth of ~80MB/min on the daemon.
 *
 * 1 MiB tail is enough headroom: even pathologically long tool-output
 * lines (~4KB each) fit 200 entries in 800KB. The tail-read path keeps
 * replay cost O(1) in file size instead of O(N).
 */
const TAIL_READ_BYTES = 1 * 1024 * 1024; // 1 MiB

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
 * Implementation reads only the trailing {@link TAIL_READ_BYTES} of the
 * file, drops the first (possibly partial) line, and parses the rest.
 * This keeps replay cost bounded even on multi-hundred-MB JSONL files.
 */
export async function replayTransportHistory(sessionId: string): Promise<Record<string, unknown>[]> {
  let fh;
  try {
    fh = await open(sessionFile(sessionId), 'r');
    const { size } = await fh.stat();
    if (size === 0) return [];
    const readFrom = Math.max(0, size - TAIL_READ_BYTES);
    const length = size - readFrom;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, readFrom);

    const content = buf.toString('utf8');
    // If we started mid-line (readFrom > 0), the first partial line is a
    // broken JSON suffix — drop it. When readFrom === 0 we're reading the
    // whole (small) file and the first line is whole.
    const offset = readFrom === 0 ? 0 : content.indexOf('\n') + 1;
    const lines = content.slice(offset).split('\n').filter(Boolean);
    const recent = lines.slice(-MAX_REPLAY_LINES);
    const events: Record<string, unknown>[] = [];
    for (const line of recent) {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch { /* skip malformed — e.g. truncated first line that still
                   started after our offset because the file has no newlines */ }
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
