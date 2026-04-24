/**
 * Integration tests for the JSONL parse worker pool — exercising the REAL
 * Node.js Worker thread end-to-end (bootstrap .mjs + worker + parse core).
 *
 * These tests catch regressions in:
 *   - the worker thread bootstrap (tsx loader registration)
 *   - the request/response envelope serialization
 *   - id correlation across concurrent calls
 *   - timeout handling
 *   - crash / unexpected exit → fallback
 *   - shutdown → reuse
 *   - pending tool-call state persistence across separate parseLines calls
 *
 * Parse-logic correctness itself is covered by `jsonl-parse-core.test.ts`.
 */

import { afterEach, describe, expect, it, beforeEach } from 'vitest';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

describe('isJsonlWorkerEnabled (worker on by default)', () => {
  const originalEnv = process.env.IM4CODES_JSONL_WORKER;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.IM4CODES_JSONL_WORKER;
    else process.env.IM4CODES_JSONL_WORKER = originalEnv;
  });

  it('returns true when env var is unset (default on)', async () => {
    const { isJsonlWorkerEnabled } = await import('../../src/daemon/jsonl-parse-pool.js');
    delete process.env.IM4CODES_JSONL_WORKER;
    expect(isJsonlWorkerEnabled()).toBe(true);
  });

  it('returns false only for explicit kill-switch values', async () => {
    const { isJsonlWorkerEnabled } = await import('../../src/daemon/jsonl-parse-pool.js');
    for (const v of ['0', 'false', 'FALSE', 'no', 'off', 'OFF', '', '  0  ']) {
      process.env.IM4CODES_JSONL_WORKER = v;
      expect(isJsonlWorkerEnabled()).toBe(false);
    }
  });

  it('returns true for any other value (only explicit off disables)', async () => {
    const { isJsonlWorkerEnabled } = await import('../../src/daemon/jsonl-parse-pool.js');
    for (const v of ['1', 'true', 'yes', 'on', 'random', 'enabled']) {
      process.env.IM4CODES_JSONL_WORKER = v;
      expect(isJsonlWorkerEnabled()).toBe(true);
    }
  });
});

describe('jsonlParsePool — REAL Worker thread', () => {
  beforeEach(async () => {
    // Ensure a fresh pool for each test; clears permanentlyDisabled from
    // previous test-induced crashes.
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    await jsonlParsePool.shutdown();
  });

  afterEach(async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    await jsonlParsePool.shutdown();
  });

  it('boots a worker thread and parses a simple assistant line', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const line = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: 'hello from real worker' },
    });
    const result = await jsonlParsePool.parseLines({
      sessionName: 'real-s1',
      items: [{ line, lineByteOffset: 0 }],
    }, 5000);
    expect(result).not.toBeNull();
    expect(result!.emits).toHaveLength(1);
    expect(result!.emits[0].type).toBe('assistant.text');
    expect(result!.emits[0].payload.text).toBe('hello from real worker');
  });

  it('correlates many concurrent parseLines calls by id', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const mk = (n: number) => jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: { content: `msg-${n}` },
    });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(jsonlParsePool.parseLines({
        sessionName: 'real-concurrent',
        items: [{ line: mk(i), lineByteOffset: i * 100 }],
      }, 5000));
    }
    const results = (await Promise.all(promises)) as Array<{ emits: Array<{ payload: { text: string } }> } | null>;
    for (let i = 0; i < 20; i++) {
      expect(results[i]).not.toBeNull();
      expect(results[i]!.emits[0].payload.text).toBe(`msg-${i}`);
    }
  });

  it('preserves tool_use → tool_result correlation across separate calls', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const useLine = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{ type: 'tool_use', id: 'tu_real', name: 'Bash', input: { command: 'echo hi' } }],
      },
    });
    const resultLine = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:01.000Z',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_real', content: 'hi' }],
      },
    });

    const first = await jsonlParsePool.parseLines({
      sessionName: 'real-correlation',
      items: [{ line: useLine, lineByteOffset: 0 }],
    }, 5000);
    expect(first!.emits.map((e) => e.type)).toEqual(['tool.call']);

    const second = await jsonlParsePool.parseLines({
      sessionName: 'real-correlation',
      items: [{ line: resultLine, lineByteOffset: 1 }],
    }, 5000);
    expect(second!.emits.map((e) => e.type)).toEqual(['tool.result']);
    // The result's eventId ties back to the tool_use ID only if the worker
    // remembered the pending call across requests.
    expect(second!.emits[0].metadata.eventId).toContain('tu_real');
  });

  it('emits hidden tool rows + file.change for Edit tool across call+result pair', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const editUse = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_edit_real',
          name: 'Edit',
          input: { file_path: '/tmp/x.ts', old_string: 'a', new_string: 'b' },
        }],
      },
    });
    const editResult = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:01.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_edit_real',
          content: 'Edited',
          toolUseResult: {
            type: 'update',
            filePath: '/tmp/x.ts',
            oldString: 'a',
            newString: 'b',
          },
        }],
      },
    });

    // Edit tool.call is deferred — no emit on tool_use, state is tracked.
    const useEmits = await jsonlParsePool.parseLines({
      sessionName: 'real-edit',
      items: [{ line: editUse, lineByteOffset: 0 }],
    }, 5000);
    expect(useEmits!.emits).toHaveLength(0);

    // On result: hidden tool.call + hidden tool.result + visible file.change
    const resultEmits = await jsonlParsePool.parseLines({
      sessionName: 'real-edit',
      items: [{ line: editResult, lineByteOffset: 1 }],
    }, 5000);
    expect(resultEmits!.emits.map((e) => e.type)).toEqual(['tool.call', 'tool.result', 'file.change']);
    expect(resultEmits!.emits[0].metadata.hidden).toBe(true);
    expect(resultEmits!.emits[1].metadata.hidden).toBe(true);
  });

  it('handles large batches without truncation', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const items = Array.from({ length: 500 }, (_, i) => ({
      line: jsonlLine({
        type: 'assistant',
        timestamp: '2026-04-24T00:00:00.000Z',
        message: { content: `batch-${i}` },
      }),
      lineByteOffset: i * 200,
    }));
    const result = await jsonlParsePool.parseLines({
      sessionName: 'real-batch',
      items,
    }, 10000);
    expect(result).not.toBeNull();
    expect(result!.emits).toHaveLength(500);
    expect(result!.emits[0].payload.text).toBe('batch-0');
    expect(result!.emits[499].payload.text).toBe('batch-499');
  });

  it('returns null on timeout; pool stays available afterwards', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    // Send a huge batch with a very short timeout to force a timeout
    const items = Array.from({ length: 50_000 }, (_, i) => ({
      line: jsonlLine({ type: 'assistant', message: { content: `x${i}` } }),
      lineByteOffset: i,
    }));
    const result = await jsonlParsePool.parseLines(
      { sessionName: 'real-timeout', items },
      1, // 1ms timeout — definitely fires before worker returns
    );
    expect(result).toBeNull();
    // A timeout does NOT trigger permanentlyDisabled; a follow-up small
    // request should still succeed.
    const followUp = await jsonlParsePool.parseLines({
      sessionName: 'real-timeout-after',
      items: [{
        line: jsonlLine({ type: 'assistant', message: { content: 'after' } }),
        lineByteOffset: 0,
      }],
    }, 5000);
    expect(followUp).not.toBeNull();
    expect(followUp!.emits[0].payload.text).toBe('after');
  });

  it('forgetSession drops per-session state so subsequent results are uncorrelated', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const editUse = jsonlLine({
      type: 'assistant',
      timestamp: '2026-04-24T00:00:00.000Z',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_forget_real',
          name: 'Edit',
          input: { file_path: '/tmp/y.ts', old_string: 'a', new_string: 'b' },
        }],
      },
    });
    const editResult = jsonlLine({
      type: 'user',
      timestamp: '2026-04-24T00:00:01.000Z',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_forget_real',
          content: 'Edited',
          toolUseResult: {
            type: 'update',
            filePath: '/tmp/y.ts',
            oldString: 'a',
            newString: 'b',
          },
        }],
      },
    });

    await jsonlParsePool.parseLines({
      sessionName: 'real-forget',
      items: [{ line: editUse, lineByteOffset: 0 }],
    }, 5000);

    // Forget — worker drops the pending tool-call map for this session.
    await jsonlParsePool.forgetSession('real-forget');

    const afterForget = await jsonlParsePool.parseLines({
      sessionName: 'real-forget',
      items: [{ line: editResult, lineByteOffset: 1 }],
    }, 5000);

    // Without a pending entry, the normalized file-change path is skipped —
    // we should get at most a plain tool.result, never the hidden-then-visible
    // Edit/file.change sequence from the correlated path.
    const types = afterForget!.emits.map((e) => e.type);
    expect(types).not.toContain('file.change');
    expect(types).toEqual(['tool.result']);
    // The pending tool.call for the deferred Edit must NOT have been emitted.
    expect(types).not.toContain('tool.call');
  });

  it('shutdown() terminates worker cleanly and allows the pool to be reused', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    const line = jsonlLine({ type: 'assistant', message: { content: 'before shutdown' } });
    await jsonlParsePool.parseLines({ sessionName: 'r', items: [{ line, lineByteOffset: 0 }] }, 5000);
    await jsonlParsePool.shutdown();
    expect(jsonlParsePool.isAvailable()).toBe(true);
    // A fresh parseLines call spawns a new worker and completes.
    const result = await jsonlParsePool.parseLines({
      sessionName: 'r',
      items: [{
        line: jsonlLine({ type: 'assistant', message: { content: 'after shutdown' } }),
        lineByteOffset: 0,
      }],
    }, 5000);
    expect(result!.emits[0].payload.text).toBe('after shutdown');
  });

  it('survives bad payloads: worker catches its own throw, pool stays available', async () => {
    const { jsonlParsePool } = await import('../../src/daemon/jsonl-parse-pool.js');
    expect(jsonlParsePool.isAvailable()).toBe(true);
    // Warm up with a good request so the worker is running
    await jsonlParsePool.parseLines({
      sessionName: 'bad-payload-warmup',
      items: [{
        line: jsonlLine({ type: 'assistant', message: { content: 'warmup' } }),
        lineByteOffset: 0,
      }],
    }, 5000);
    // Send a payload the worker will reject (items missing). The worker's
    // try/catch wraps it and responds ok:false — not an error event — so the
    // pool must NOT mark itself permanently disabled.
    const result = await jsonlParsePool.parseLines(
      // @ts-expect-error — intentionally malformed payload
      { sessionName: 'bad-payload', items: undefined },
      2000,
    );
    expect(result).toBeNull();
    expect(jsonlParsePool.isAvailable()).toBe(true);
    // A subsequent good request must still succeed
    const after = await jsonlParsePool.parseLines({
      sessionName: 'bad-payload-after',
      items: [{
        line: jsonlLine({ type: 'assistant', message: { content: 'after' } }),
        lineByteOffset: 0,
      }],
    }, 5000);
    expect(after!.emits[0].payload.text).toBe('after');
  });
});
