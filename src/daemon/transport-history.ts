/**
 * Transport session JSONL history — local cache for transport-backed agent messages.
 * Each session gets a JSONL file at ~/.imcodes/transport/{sessionKey}.jsonl
 * Provides append (on each event) and replay (on browser subscribe).
 */

import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../util/logger.js';

const TRANSPORT_DIR = join(homedir(), '.imcodes', 'transport');
const MAX_REPLAY_LINES = 200;

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

/** Read recent history for a session — returns parsed event objects (last N lines). */
export async function replayTransportHistory(sessionId: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(sessionFile(sessionId), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-MAX_REPLAY_LINES);
    const events: Record<string, unknown>[] = [];
    for (const line of recent) {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch { /* skip malformed */ }
    }
    return events;
  } catch {
    return []; // file doesn't exist yet
  }
}
