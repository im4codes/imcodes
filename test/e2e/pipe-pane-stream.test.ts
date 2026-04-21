/**
 * E2E tests for task 8.5: pipe-pane raw PTY streaming.
 * Verifies live output delivery, multi-session isolation, snapshot-on-subscribe,
 * and CR-overwrite dedup (duplicate-text regression).
 *
 * Requires tmux (>= 2.6 for pipe-pane -O). Skip with SKIP_TMUX_TESTS=1.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newSession,
  killSession,
  sendKeys,
  getPaneId,
  capturePaneVisible,
  startPipePaneStream,
  stopPipePaneStream,
  checkPipePaneCapability,
} from '../../src/agent/tmux.js';
import { RawStreamParser, resetParser } from '../../src/daemon/terminal-parser.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1';
const RUN_ID = Math.random().toString(36).slice(2, 8);

// Session names must match /^deck_[a-z0-9_]+_(brain|w\d+)$/
const SESSION_A = `deck_e2epptest${RUN_ID}_brain`;
const SESSION_B = `deck_e2epptest${RUN_ID}_w1`;

/** Collect all stream chunks for `ms` milliseconds then return as a Buffer. */
async function collectStream(stream: NodeJS.ReadableStream, ms: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: unknown) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  });
  await new Promise((r) => setTimeout(r, ms));
  return Buffer.concat(chunks);
}

/** Retry helper for flaky tmux operations (server can crash between tests in CI) */
async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

async function waitForSnapshotText(sessionName: string, expected: string[], attempts = 8, delayMs = 250): Promise<string> {
  let lastSnapshot = '';
  for (let i = 0; i < attempts; i++) {
    lastSnapshot = await capturePaneVisible(sessionName);
    if (expected.every((value) => lastSnapshot.includes(value))) return lastSnapshot;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return lastSnapshot;
}

async function waitForStreamText(stream: NodeJS.ReadableStream, expected: string, timeoutMs = 5000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for stream text: ${expected}`));
    }, timeoutMs);

    const onData = (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      const output = Buffer.concat(chunks).toString();
      if (output.includes(expected)) {
        cleanup();
        resolve(output);
      }
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    };

    stream.on('data', onData);
    stream.on('error', onError);
  });
}

describe.skipIf(SKIP)('pipe-pane stream e2e (task 8.5)', () => {
  beforeEach(async () => {
    await killSession(SESSION_A).catch(() => {});
    await killSession(SESSION_B).catch(() => {});
    await retry(() => newSession(SESSION_A, 'bash', { cwd: '/tmp' }));
    await new Promise((r) => setTimeout(r, 300));
  });

  afterEach(async () => {
    await stopPipePaneStream(SESSION_A).catch(() => {});
    await stopPipePaneStream(SESSION_B).catch(() => {});
    await killSession(SESSION_A).catch(() => {});
    await killSession(SESSION_B).catch(() => {});
    resetParser(SESSION_A);
    resetParser(SESSION_B);
  });

  it('tmux >= 2.6 supports pipe-pane -O', async () => {
    const capable = await checkPipePaneCapability();
    expect(capable).toBe(true);
  });

  // ── Task 8.5 check 1: terminal live output ──────────────────────────────────

  it('raw PTY bytes arrive via pipe-pane stream', async () => {
    const paneId = await getPaneId(SESSION_A);
    const { stream, cleanup } = await startPipePaneStream(SESSION_A, paneId);

    try {
      // Start collecting before sending keys
      const collectPromise = collectStream(stream, 1500);
      await new Promise((r) => setTimeout(r, 200)); // let pipe-pane settle

      await sendKeys(SESSION_A, 'echo PIPEPANE_LIVE_OUTPUT');

      const output = (await collectPromise).toString();
      expect(output).toContain('PIPEPANE_LIVE_OUTPUT');
    } finally {
      await cleanup();
    }
  }, 10_000);

  // ── Task 8.5 check 3: multi-session isolation ───────────────────────────────

  it('two sessions pipe independently — no cross-session data leak', async () => {
    await retry(() => newSession(SESSION_B, 'bash', { cwd: '/tmp' }));
    await new Promise((r) => setTimeout(r, 300));

    const paneIdA = await getPaneId(SESSION_A);
    const paneIdB = await getPaneId(SESSION_B);

    const { stream: streamA, cleanup: cleanupA } = await startPipePaneStream(SESSION_A, paneIdA);
    const { stream: streamB, cleanup: cleanupB } = await startPipePaneStream(SESSION_B, paneIdB);

    const chunksA: Buffer[] = [];
    const chunksB: Buffer[] = [];
    streamA.on('data', (c: unknown) => chunksA.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string)));
    streamB.on('data', (c: unknown) => chunksB.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string)));

    await new Promise((r) => setTimeout(r, 300));

    // Send distinct markers to each session
    await sendKeys(SESSION_A, 'echo MARKER_SESSION_A_ONLY');
    await sendKeys(SESSION_B, 'echo MARKER_SESSION_B_ONLY');

    await new Promise((r) => setTimeout(r, 1200));

    const outA = Buffer.concat(chunksA).toString();
    const outB = Buffer.concat(chunksB).toString();

    // Each session's stream only contains its own marker
    expect(outA).toContain('MARKER_SESSION_A_ONLY');
    expect(outA).not.toContain('MARKER_SESSION_B_ONLY');

    expect(outB).toContain('MARKER_SESSION_B_ONLY');
    expect(outB).not.toContain('MARKER_SESSION_A_ONLY');

    await cleanupA();
    await cleanupB();
  }, 15_000);

  // ── Task 8.5 check 2: reconnect / snapshot-on-subscribe ────────────────────

  it('capturePaneVisible returns current screen content on reconnect', async () => {
    // Simulate state after a few commands (what the user would see on reconnect)
    await sendKeys(SESSION_A, 'echo SNAPSHOT_LINE_ONE');
    await sendKeys(SESSION_A, 'echo SNAPSHOT_LINE_TWO');
    await new Promise((r) => setTimeout(r, 600));

    const snapshot = await waitForSnapshotText(SESSION_A, [
      'SNAPSHOT_LINE_ONE',
      'SNAPSHOT_LINE_TWO',
    ]);
    expect(snapshot).toContain('SNAPSHOT_LINE_ONE');
    expect(snapshot).toContain('SNAPSHOT_LINE_TWO');
  }, 10_000);

  // ── Task 8.5 check 4: CR-overwrite duplicate-text regression ───────────────

  it('CR-overwrite lines are not accumulated as new content (duplicate-text regression)', async () => {
    const paneId = await getPaneId(SESSION_A);
    const { stream, cleanup } = await startPipePaneStream(SESSION_A, paneId);

    const accumulated: string[] = [];
    // Tap into processRawPtyData by listening to what gets classified as KEEP
    // We do this by collecting raw data and running it through the parser directly.
    const rawChunks: Buffer[] = [];
    stream.on('data', (c: unknown) => rawChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string)));

    await new Promise((r) => setTimeout(r, 200));

    // Emit progress-bar style output: multiple CR-rewrite frames followed by final newline
    // printf '\rStep 1/3...\rStep 2/3...\rStep 3/3...done\n'
    await sendKeys(SESSION_A, String.raw`printf '\rStep 1/3...\rStep 2/3...\rStep 3/3...done\n'`);
    await new Promise((r) => setTimeout(r, 1000));

    // Run all collected raw bytes through the stream parser
    const raw = Buffer.concat(rawChunks);
    const parser = new RawStreamParser();
    const lines = parser.feed(raw);

    // CR-overwritten partial lines MUST NOT appear as standalone completed lines.
    // Lines that legitimately contain "Step" are:
    //   1. The command echo (bash echoes the printf command verbatim — contains "printf")
    //   2. The final printf output after \n completes it (contains "done")
    // Intermediate states "Step 1/3..." and "Step 2/3..." (CR-overwritten, no \n)
    // must NOT appear as standalone completed lines (the whole point of CR semantics).
    const stepLines = lines.filter((l: string) => l.includes('Step'));
    for (const line of stepLines) {
      const isCommandEcho = line.includes('printf');
      const isFinalOutput = line.includes('done');
      expect(isCommandEcho || isFinalOutput).toBe(true);
    }
    // Also verify the final output was actually emitted (not lost)
    const hasFinal = lines.some((l: string) => l.includes('done') && l.includes('Step'));
    expect(hasFinal).toBe(true);

    await cleanup();
  }, 10_000);

  // ── Pipe restart (rebind) sanity check ────────────────────────────────────

  it('stop and restart pipe for same session works without error', async () => {
    const paneId = await getPaneId(SESSION_A);

    const { stream: s1, cleanup: c1 } = await startPipePaneStream(SESSION_A, paneId);
    await new Promise((r) => setTimeout(r, 200));
    await c1(); // stop first pipe
    await new Promise((r) => setTimeout(r, 250));

    // Restart: must succeed without error
    const { stream: s2, cleanup: c2 } = await startPipePaneStream(SESSION_A, paneId);

    await new Promise((r) => setTimeout(r, 200));
    const outputPromise = waitForStreamText(s2, 'AFTER_REBIND', 8000);
    await sendKeys(SESSION_A, 'echo AFTER_REBIND');
    const out = await outputPromise;
    expect(out).toContain('AFTER_REBIND');

    await c2();
  }, 30_000);
});
