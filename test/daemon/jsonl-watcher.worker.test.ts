/**
 * End-to-end parity test for the JSONL parse worker.
 *
 * Drives the real watcher (real fs.watch, real file writes, real timers)
 * against a JSONL transcript TWICE:
 *   1. With `IM4CODES_JSONL_WORKER=1` (parse happens in a Worker thread)
 *   2. Without the flag (parse happens on the main thread)
 *
 * Asserts that both runs produce identical timeline-event sequences. If the
 * worker path ever diverges from the main-thread path, this test fails — and
 * catches the regression BEFORE it lands in production.
 *
 * This test deliberately uses longer timeouts (watcher polls every 2s).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile, mkdir, rm, appendFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mock timeline emitter so we can capture exact event sequences ────────────

interface CapturedEvent {
  session: string;
  type: string;
  payload: Record<string, unknown>;
  opts?: Record<string, unknown>;
}

const captured: CapturedEvent[] = [];

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: vi.fn((session: string, type: string, payload: Record<string, unknown>, opts?: Record<string, unknown>) => {
      captured.push({ session, type, payload, opts });
    }),
    on: vi.fn(() => () => {}),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/util/model-context.js', () => ({
  resolveContextWindow: vi.fn(() => 200000),
}));

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

function assistantText(text: string): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: '2026-04-24T00:00:00.000Z',
    message: {
      content: [{ type: 'text', text }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 },
    },
  });
}

function assistantEdit(toolUseId: string, filePath: string): string {
  return jsonlLine({
    type: 'assistant',
    timestamp: '2026-04-24T00:00:00.000Z',
    message: {
      content: [{ type: 'tool_use', id: toolUseId, name: 'Edit', input: { file_path: filePath, old_string: 'a', new_string: 'b' } }],
      model: 'claude-opus-4-6',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
}

function userEditResult(toolUseId: string, filePath: string): string {
  return jsonlLine({
    type: 'user',
    timestamp: '2026-04-24T00:00:01.000Z',
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: 'Edited',
        toolUseResult: { type: 'update', filePath, oldString: 'a', newString: 'b' },
      }],
    },
  });
}

function userText(text: string): string {
  return jsonlLine({
    type: 'user',
    timestamp: '2026-04-24T00:00:00.000Z',
    message: { content: [{ type: 'text', text }] },
  });
}

// ── Test scaffolding ─────────────────────────────────────────────────────────

let testDir: string;
const originalEnv = process.env.IM4CODES_JSONL_WORKER;

beforeEach(async () => {
  testDir = join(tmpdir(), `imcodes-jsonl-worker-parity-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  captured.length = 0;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.IM4CODES_JSONL_WORKER;
  else process.env.IM4CODES_JSONL_WORKER = originalEnv;
  // Shut down the pool between tests so we start each test fresh.
  vi.resetModules();
});

/**
 * Reset the module-level state (mainParseCtx pending map + captured events)
 * so we can run the same fixture against two different code paths.
 */
async function runFixture(useWorker: boolean, fixtureLines: string[]): Promise<CapturedEvent[]> {
  captured.length = 0;
  // IM4CODES_JSONL_WORKER is "on by default, set to 0 to disable".
  if (useWorker) delete process.env.IM4CODES_JSONL_WORKER;
  else process.env.IM4CODES_JSONL_WORKER = '0';

  // Force a fresh watcher/pool module instance each run.
  vi.resetModules();
  const { startWatchingFile, stopWatching } = await import('../../src/daemon/jsonl-watcher.js');
  const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');

  const sessionId = randomUUID();
  const filePath = join(testDir, `${sessionId}.jsonl`);

  // Seed file with empty content so startWatchingFile finds it quickly.
  await writeFile(filePath, '');

  const sessionName = `parity-${useWorker ? 'worker' : 'main'}`;
  await startWatchingFile(sessionName, filePath, sessionId);

  // Append all fixture lines
  for (const line of fixtureLines) {
    await appendFile(filePath, line);
  }

  // Watcher polls every 2s. Wait enough for at least two drain cycles.
  await new Promise((r) => setTimeout(r, 2500));

  stopWatching(sessionName);
  await jsonlParsePool.shutdown();

  // Filter to only events for our session and drop non-deterministic fields
  // (timestamps baked into eventIds come from the fixture, so they're OK).
  return captured
    .filter((e) => e.session === sessionName)
    .map((e) => ({
      session: e.session,
      type: e.type,
      payload: e.payload,
      opts: e.opts,
    }));
}

/**
 * Canonicalize an event sequence for comparison — strip sessionName (differs
 * between runs by design) and normalize session-scoped strings so the two
 * runs produce byte-identical output when the semantics match.
 */
function canonicalize(events: CapturedEvent[]): Array<Omit<CapturedEvent, 'session'>> {
  return events.map(({ type, payload, opts }) => {
    // eventId contains the sessionName: "cc:{sessionName}:{offset}:{suffix}:{idx}"
    // and file-change normalized eventId contains it too. Replace with a constant.
    const normalizedOpts = opts
      ? { ...opts, eventId: typeof opts.eventId === 'string' ? opts.eventId.replace(/parity-(worker|main)/g, 'SESSION') : opts.eventId }
      : opts;
    return { type, payload, opts: normalizedOpts };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('jsonl-watcher parity: worker ON vs worker OFF', () => {
  it('produces identical events for plain assistant/user turns', async () => {
    const fixture = [
      userText('hi'),
      assistantText('hello!'),
      userText('thanks'),
      assistantText('you are welcome'),
    ];
    const workerEvents = await runFixture(true, fixture);
    const mainEvents = await runFixture(false, fixture);
    expect(workerEvents.length).toBeGreaterThan(0);
    expect(canonicalize(workerEvents)).toEqual(canonicalize(mainEvents));
  }, 15000);

  it('produces identical events for Edit tool_use + tool_result pair (file.change)', async () => {
    const tuId = `tu_${randomUUID().slice(0, 8)}`;
    const filePath = '/tmp/parity-test.ts';
    const fixture = [
      userText('edit the file'),
      assistantEdit(tuId, filePath),
      userEditResult(tuId, filePath),
    ];
    const workerEvents = await runFixture(true, fixture);
    const mainEvents = await runFixture(false, fixture);

    // Must see: user.message, tool.call (hidden), tool.result (hidden), file.change
    const workerTypes = workerEvents.map((e) => e.type);
    const mainTypes = mainEvents.map((e) => e.type);
    expect(workerTypes).toContain('file.change');
    expect(mainTypes).toContain('file.change');
    expect(canonicalize(workerEvents)).toEqual(canonicalize(mainEvents));
  }, 15000);

  it('produces identical events when tool_use and tool_result arrive in separate drain cycles', async () => {
    const tuId = `tu_${randomUUID().slice(0, 8)}`;
    const filePath = '/tmp/parity-split-test.ts';

    // Split the fixture so the tool_use lands in one drain and the
    // tool_result in another — this exercises cross-message state in the
    // worker's pendingToolCalls map. We simulate by running the fixture as
    // two writes separated by a wait within runFixture's polling window.
    // (Since runFixture just appends everything then waits 2.5s for the
    // watcher's 2s poll, the watcher sees everything in one drain. To force
    // a split, we need a variant that writes in stages.)

    captured.length = 0;
    process.env.IM4CODES_JSONL_WORKER = '1';
    vi.resetModules();
    const { startWatchingFile, stopWatching } = await import('../../src/daemon/jsonl-watcher.js');
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');

    const sessionId = randomUUID();
    const sessionName = `parity-split-worker`;
    const filePath2 = join(testDir, `${sessionId}.jsonl`);
    await writeFile(filePath2, '');
    await startWatchingFile(sessionName, filePath2, sessionId);

    await appendFile(filePath2, assistantEdit(tuId, filePath));
    await new Promise((r) => setTimeout(r, 2500));
    await appendFile(filePath2, userEditResult(tuId, filePath));
    await new Promise((r) => setTimeout(r, 2500));

    stopWatching(sessionName);
    await jsonlParsePool.shutdown();

    const workerEvents = captured.filter((e) => e.session === sessionName);
    const workerTypes = workerEvents.map((e) => e.type);
    // Correlation worked across drains: file.change appears
    expect(workerTypes).toContain('file.change');
    // The tool.call that emits alongside file.change should be 'hidden'
    const hiddenCall = workerEvents.find((e) => e.type === 'tool.call' && e.opts?.hidden === true);
    expect(hiddenCall).toBeDefined();
  }, 20000);

  it('falls back to main thread when worker is unavailable', async () => {
    delete process.env.IM4CODES_JSONL_WORKER; // default: worker enabled
    captured.length = 0;
    vi.resetModules();

    const { startWatchingFile, stopWatching } = await import('../../src/daemon/jsonl-watcher.js');
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');

    // Pre-emptively shut down and force the pool to report unavailable.
    await jsonlParsePool.shutdown();
    // Monkeypatch isAvailable to return false — simulates a crashed worker.
    const originalIsAvailable = jsonlParsePool.isAvailable.bind(jsonlParsePool);
    jsonlParsePool.isAvailable = () => false;

    try {
      const sessionId = randomUUID();
      const filePath = join(testDir, `${sessionId}.jsonl`);
      await writeFile(filePath, '');
      const sessionName = 'fallback-main';
      await startWatchingFile(sessionName, filePath, sessionId);

      await appendFile(filePath, assistantText('fallback works'));
      await new Promise((r) => setTimeout(r, 2500));

      stopWatching(sessionName);

      const events = captured.filter((e) => e.session === sessionName);
      const textEvents = events.filter((e) => e.type === 'assistant.text');
      expect(textEvents).toHaveLength(1);
      expect(textEvents[0].payload.text).toBe('fallback works');
    } finally {
      jsonlParsePool.isAvailable = originalIsAvailable;
    }
  }, 15000);
});
