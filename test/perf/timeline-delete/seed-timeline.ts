/**
 * Seeds a production-shaped timeline home for the delete-latency harness.
 *
 *   IMCODES_HOME=/path/to/scratch/home npx tsx test/perf/timeline-delete/seed-timeline.ts
 *
 * Shape (measured on a real owner machine, counts only): per-session JSONL capped at
 * ~5000 lines of ~8-11 KB average (large tool results), 37% of assistant bubbles made
 * of several stored assistant.text events (up to 15), a ~1.3 GB timeline dir and a
 * multi-GB timeline.sqlite projection with millions of rows.
 *
 *  - the TARGET session gets a real JSONL of 6000 events + a real projection (rebuilt by
 *    the production code, so its schema/rows are exactly what production writes);
 *  - BULK sessions add JSONL files and projection rows directly (insert-only) to reach
 *    the size; the delete path never touches them, they exist so the DB/dir are prod-sized.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { getProjectionDbPath, timelineProjection } from '../../../src/daemon/timeline-projection.js';
import { TIMELINE_PERF_TARGET_SESSION } from './constants.js';

const HOME = process.env.IMCODES_HOME?.trim();
if (!HOME || HOME.includes('/.imcodes')) throw new Error('IMCODES_HOME must be a scratch dir (not a real ~/.imcodes)');
const BULK_SESSIONS = Number(process.env.SEED_BULK_SESSIONS ?? 40);
const BULK_ROWS_PER_SESSION = Number(process.env.SEED_BULK_ROWS ?? 60_000);
const BULK_JSONL_LINES = Number(process.env.SEED_BULK_JSONL_LINES ?? 5000);

let rng = 0x9e3779b9;
const rand = () => { rng ^= rng << 13; rng >>>= 0; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 0x1_0000_0000; };
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const filler = (bytes: number): string => 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(Math.ceil(bytes / 56)).slice(0, bytes);

/** events for one session: user turns, runs of 1-15 assistant.text segments, tool call/result pairs with big outputs. */
function* generate(sessionId: string, total: number): Generator<Record<string, unknown>> {
  let seq = 0;
  const base = 1_700_000_000_000;
  const make = (type: string, payload: Record<string, unknown>, id?: string) => {
    seq += 1;
    return { eventId: id ?? `evt_${sessionId.slice(-6)}_${seq}`, sessionId, ts: base + seq * 1000, seq, epoch: 1, source: 'daemon', confidence: 'high', type, payload };
  };
  while (seq < total) {
    yield make('user.message', { text: `${filler(200 + Math.floor(rand() * 600))}` });
    const runs = 1 + Math.floor(rand() * 4);
    for (let r = 0; r < runs && seq < total; r += 1) {
      const segments = rand() < 0.37 ? 2 + Math.floor(rand() * 14) : 1;
      for (let s = 0; s < segments && seq < total; s += 1) yield make('assistant.text', { text: filler(300 + Math.floor(rand() * 2500)), streaming: false });
      if (seq >= total) break;
      const call = make('tool.call', { toolCallId: `tc_${seq}`, tool: 'shell', input: { command: filler(120) } });
      yield call;
      if (seq >= total) break;
      yield make('tool.result', { toolCallId: `tc_${seq - 1}`, tool: 'shell', output: filler(pick([2_000, 6_000, 20_000, 60_000, 120_000])) });
    }
  }
}

async function writeJsonl(sessionId: string, lines: number): Promise<number> {
  const file = join(HOME!, 'timeline', `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  const out = createWriteStream(file);
  let written = 0;
  for (const event of generate(sessionId, lines)) {
    const line = `${JSON.stringify(event)}\n`;
    written += 1;
    if (!out.write(line)) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
  return written;
}

mkdirSync(join(HOME, 'timeline'), { recursive: true });
process.stdout.write(`[seed] target session JSONL (6000 events)\n`);
await writeJsonl(TIMELINE_PERF_TARGET_SESSION, 6000);
await timelineProjection.rebuildSession(TIMELINE_PERF_TARGET_SESSION); // production code creates the schema + rows
await timelineProjection.drain(30_000);

process.stdout.write(`[seed] ${BULK_SESSIONS} bulk sessions (jsonl ${BULK_JSONL_LINES} lines each + ${BULK_ROWS_PER_SESSION} projection rows each)\n`);
const dbPath = getProjectionDbPath();
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
const insert = db.prepare(`INSERT INTO timeline_projection_events (
  session_id, append_ordinal, event_id, ts, seq, epoch, type, source, confidence, streaming, hidden, text, payload_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, 1, ?, 'daemon', 'high', 0, 0, ?, ?, ?, ?)`);
for (let n = 0; n < BULK_SESSIONS; n += 1) {
  const sessionId = `deck_perfbulk${String(n).padStart(3, '0')}_w1`;
  await writeJsonl(sessionId, BULK_JSONL_LINES);
  db.exec('BEGIN');
  for (let i = 1; i <= BULK_ROWS_PER_SESSION; i += 1) {
    const type = rand() < 0.4 ? 'assistant.text' : rand() < 0.5 ? 'tool.result' : 'tool.call';
    const text = type === 'assistant.text' ? filler(300 + Math.floor(rand() * 500)) : null;
    const payload = JSON.stringify({ text: text ?? undefined, output: type === 'tool.result' ? filler(400) : undefined });
    insert.run(sessionId, i, `bulk_${n}_${i}`, 1_700_000_000_000 + i * 1000, i, type, text, payload, 1_700_000_000_000 + i * 1000, Date.now());
  }
  db.exec('COMMIT');
  if (n % 5 === 0) process.stdout.write(`[seed] bulk ${n + 1}/${BULK_SESSIONS}\n`);
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
db.close();
process.stdout.write('[seed] done\n');
process.exit(0);
