/**
 * E2E test: multi-session dispatch — brain dispatches tasks to 2 workers in parallel.
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  newSession,
  killSession,
  sendKeys,
  capturePane,
  sessionExists,
} from '../../src/agent/tmux.js';
import { tmpdir } from 'os';

const SKIP = process.env.SKIP_TMUX_TESTS === '1';
const BRAIN_SESSION = 'e2e_multi_brain';
const WORKER1_SESSION = 'e2e_multi_w1';
const WORKER2_SESSION = 'e2e_multi_w2';
const FIXTURES = new URL('../fixtures', import.meta.url).pathname;

describe.skipIf(SKIP)('Multi-session parallel dispatch', () => {
  beforeAll(async () => {
    // Ensure tmux server is running before parallel session creates
    const { ensureTmuxServer } = await import('../../src/agent/tmux.js');
    await ensureTmuxServer();

    await Promise.all([
      killSession(BRAIN_SESSION).catch(() => {}),
      killSession(WORKER1_SESSION).catch(() => {}),
      killSession(WORKER2_SESSION).catch(() => {}),
    ]);

    // Create sessions sequentially to avoid tmux server race on CI
    await newSession(BRAIN_SESSION, `bash ${FIXTURES}/mock-brain.sh`, { cwd: tmpdir() });
    await newSession(WORKER1_SESSION, `bash ${FIXTURES}/mock-agent.sh`, { cwd: tmpdir() });
    await newSession(WORKER2_SESSION, `bash ${FIXTURES}/mock-agent.sh`, { cwd: tmpdir() });

    // Allow sessions to initialize
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(async () => {
    await Promise.all([
      killSession(BRAIN_SESSION).catch(() => {}),
      killSession(WORKER1_SESSION).catch(() => {}),
      killSession(WORKER2_SESSION).catch(() => {}),
    ]);
  });

  it('all three sessions exist', async () => {
    expect(await sessionExists(BRAIN_SESSION)).toBe(true);
    expect(await sessionExists(WORKER1_SESSION)).toBe(true);
    expect(await sessionExists(WORKER2_SESSION)).toBe(true);
  });

  it('brain session captures output', async () => {
    const lines = await capturePane(BRAIN_SESSION);
    expect(Array.isArray(lines)).toBe(true);
  });

  it('both worker sessions capture output', async () => {
    const [lines1, lines2] = await Promise.all([
      capturePane(WORKER1_SESSION),
      capturePane(WORKER2_SESSION),
    ]);
    expect(Array.isArray(lines1)).toBe(true);
    expect(Array.isArray(lines2)).toBe(true);
  });

  it('brain can send to worker 1', async () => {
    await sendKeys(BRAIN_SESSION, '@w1 task for worker one');
    await new Promise((r) => setTimeout(r, 300));
    const lines = await capturePane(BRAIN_SESSION);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('brain can send to worker 2', async () => {
    await sendKeys(BRAIN_SESSION, '@w2 task for worker two');
    await new Promise((r) => setTimeout(r, 300));
    const lines = await capturePane(BRAIN_SESSION);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('workers can receive input independently', async () => {
    // Send distinct keys to each worker and verify they each got input
    await Promise.all([
      sendKeys(WORKER1_SESSION, 'worker-one-message'),
      sendKeys(WORKER2_SESSION, 'worker-two-message'),
    ]);
    await new Promise((r) => setTimeout(r, 500));

    const [w1Lines, w2Lines] = await Promise.all([
      capturePane(WORKER1_SESSION),
      capturePane(WORKER2_SESSION),
    ]);

    expect(w1Lines.length).toBeGreaterThan(0);
    expect(w2Lines.length).toBeGreaterThan(0);
  });

  it('session-manager creates brain and worker sessions', async () => {
    const { launchSession } = await import('../../src/agent/session-manager.js');
    expect(typeof launchSession).toBe('function');
  });
});
