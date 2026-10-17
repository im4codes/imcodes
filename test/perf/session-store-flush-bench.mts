/**
 * Main-thread cost of one session-store flush, on a production-shaped store.
 *
 *   npx tsx test/perf/session-store-flush-bench.mts [--sessions 300] [--iterations 60]
 *
 * The shape follows a real daemon's ~/.imcodes/sessions.json: about 300
 * sessions and 1.4 MB, where a handful of Brain sessions carry a large
 * `summarySyncFingerprints` map (50-95 KB each), some tens of sessions carry a
 * few KB, and most are well under 1 KB. The store lives in a throwaway home;
 * the real ~/.imcodes is never read or written.
 *
 * It measures what the daemon pays for one mutation followed by the debounced
 * flush it causes: the event loop's active time across the whole debounce
 * window (performance.eventLoopUtilization), its worst stall
 * (monitorEventLoopDelay) and the bytes written. `--mode flush` measures an
 * explicit flushStore() instead (the shutdown path).
 *
 * It only uses the store's public API, so it runs unchanged against the JSON
 * store (base) and the SQLite store: bytes are the WAL growth per flush for
 * SQLite (a side connection truncates the WAL before each mutation), and the
 * sessions.json rewrite plus the .1 backup copy for the JSON store.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const SESSIONS = Number(args.get('sessions') ?? 300);
const ITERATIONS = Number(args.get('iterations') ?? 60);
const MODE = args.get('mode') ?? 'debounce';
const WARMUP = 5;
const DEBOUNCE_WAIT_MS = 700;

// The store lives in `$HOME/.imcodes`: point HOME at a throwaway directory.
const fakeHome = mkdtempSync(join(tmpdir(), 'imcodes-store-bench-'));
const home = join(fakeHome, '.imcodes');
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.VITEST = '1'; // the store's test-runner mode: real persistence, isolated home only

function hex(seed: number, length: number): string {
  let out = '';
  let state = seed >>> 0 || 1;
  while (out.length < length) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += state.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

function record(index: number, fingerprints: number): Record<string, unknown> {
  const name = `deck_realproj${index % 40}_${index % 7 === 0 ? 'brain' : `w${index}`}${index}`;
  const summarySyncFingerprints: Record<string, unknown> = {};
  for (let i = 0; i < fingerprints; i += 1) summarySyncFingerprints[`sum_${hex(index * 7919 + i, 16)}`] = { fingerprint: hex(index * 104729 + i, 64), syncedAt: 1_790_000_000_000 + i };
  return {
    name, projectName: `realproj${index % 40}`, role: index % 7 === 0 ? 'brain' : `w${index % 5}`,
    agentType: index % 3 === 0 ? 'claude-code-sdk' : 'codex-sdk', runtimeType: 'transport',
    projectDir: `/home/user/work/realproj${index % 40}`, state: 'idle',
    sessionInstanceId: `instance-${hex(index, 24)}`, runtimeEpoch: `epoch-${hex(index + 1, 24)}`,
    restarts: 0, restartTimestamps: [], createdAt: 1_789_000_000_000 + index, updatedAt: 1_790_000_000_000 + index,
    requestedModel: 'claude-sonnet-5', activeModel: 'claude-sonnet-5',
    transportConfig: { supervision: { mode: 'off', maxParseRetries: 2 }, note: hex(index, 200) },
    contextNamespace: `ns-${hex(index, 16)}`,
    ...(Object.keys(summarySyncFingerprints).length > 0 ? { summarySyncFingerprints } : {}),
  };
}

/** Class sizes (fingerprints per record) mirroring the real file: 5 huge, 13% mid, 20% small, rest tiny. */
function fingerprintsFor(index: number, total: number): number {
  const scale = total / 300;
  if (index < 5 * scale) return 520;
  if (index < 45 * scale) return 90;
  if (index < 105 * scale) return 28;
  return 0;
}

const sessions: Record<string, unknown> = {};
for (let i = 0; i < SESSIONS; i += 1) {
  const value = record(i, fingerprintsFor(i, SESSIONS));
  sessions[value.name as string] = value;
}
mkdirSync(home, { recursive: true });
writeFileSync(join(home, 'sessions.json'), JSON.stringify({ version: 2, sessions, identityPrompts: {} }, null, 2));

const fileBytes = statSync(join(home, 'sessions.json')).size; // the legacy-format fixture (the SQLite store migrates and freezes it)
const store = await import('../../src/store/session-store.js');
await store.loadStore({ probe: false });
const names = Object.keys(sessions);

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return { mean: +mean.toFixed(2), p50: +sorted[Math.floor(sorted.length * 0.5)]!.toFixed(2), p95: +sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2), max: +sorted.at(-1)!.toFixed(2) };
};

const sqlitePath = join(home, 'sessions.sqlite');
const usesSqlite = existsSync(sqlitePath);
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const sideConnection = usesSqlite ? new DatabaseSync(sqlitePath) : null;
const sizeOf = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
const bytes: number[] = [];

async function oneFlush(i: number): Promise<{ busyMs: number; wallMs: number }> {
  const name = names[(i * 37) % names.length]!;
  sideConnection?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = performance.eventLoopUtilization();
  const started = performance.now();
  store.updateSessionState(name, i % 2 === 0 ? 'running' : 'idle');
  if (MODE === 'flush') await store.flushStore();
  else await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS)); // the 500 ms debounce fires and its write completes
  const wallMs = performance.now() - started;
  const delta = performance.eventLoopUtilization(before);
  bytes.push(usesSqlite ? sizeOf(`${sqlitePath}-wal`) : fileBytes * 2);
  return { busyMs: delta.active, wallMs };
}

for (let i = 0; i < WARMUP; i += 1) await oneFlush(i);

// Two passes: the delay histogram wakes the loop every millisecond, which would itself add
// active time across a 700 ms debounce window. Pass 1 measures busy time with no monitor;
// pass 2 measures the worst stall with the monitor and reports no busy time.
const busy: number[] = [];
const wall: number[] = [];
for (let i = 0; i < ITERATIONS; i += 1) {
  const result = await oneFlush(WARMUP + i);
  busy.push(result.busyMs);
  wall.push(result.wallMs);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const delay = monitorEventLoopDelay({ resolution: 1 });
delay.enable();
for (let i = 0; i < ITERATIONS; i += 1) {
  await oneFlush(WARMUP + ITERATIONS + i);
  await new Promise((resolve) => setTimeout(resolve, 5));
}
delay.disable();

// The mutation call alone (timer re-arm): what a burst of mutations pays before the debounce fires.
const mutationStart = performance.now();
const MUTATIONS = 20_000;
for (let i = 0; i < MUTATIONS; i += 1) store.updateSessionState(names[i % names.length]!, i % 2 === 0 ? 'running' : 'idle');
const mutationUs = ((performance.now() - mutationStart) / MUTATIONS) * 1000;
await store.flushStore();

// listSessions is called on nearly every daemon operation.
const LISTS = 50_000;
const listStart = performance.now();
for (let i = 0; i < LISTS; i += 1) store.listSessions();
const listAllMicros = ((performance.now() - listStart) / LISTS) * 1000;
const listProjectStart = performance.now();
for (let i = 0; i < LISTS; i += 1) store.listSessions('realproj3');
const listProjectMicros = ((performance.now() - listProjectStart) / LISTS) * 1000;

console.log(JSON.stringify({
  sessions: SESSIONS,
  fileBytes,
  storage: usesSqlite ? 'sqlite' : 'json',
  mode: MODE,
  iterations: ITERATIONS,
  bytesWrittenPerFlush: stats(bytes.slice(WARMUP, WARMUP + ITERATIONS)),
  flushMainThreadBusyMs: stats(busy),
  flushWallMs: stats(wall),
  worstEventLoopStallMs: +(delay.max / 1e6).toFixed(2),
  p99EventLoopDelayMs: +(delay.percentile(99) / 1e6).toFixed(2),
  compatExportMainThreadMs: (store as { sessionsJsonCompatExportStatsForTests?: () => { lastMainThreadMs: number; completed: number } }).sessionsJsonCompatExportStatsForTests?.() ?? null,
  mutationCallMicros: +mutationUs.toFixed(2),
  listSessionsAllMicros: +listAllMicros.toFixed(2),
  listSessionsByProjectMicros: +listProjectMicros.toFixed(2),
}, null, 2));
rmSync(fakeHome, { recursive: true, force: true });
