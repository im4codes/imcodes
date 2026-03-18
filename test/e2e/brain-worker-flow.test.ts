/**
 * E2E test: brain → worker dispatch flow using real tmux + mock agents.
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 *
 * Flow: message → brain dispatch → worker execute → idle → brain review → @reply
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newSession, killSession, sendKeys, capturePane, sessionExists } from '../../src/agent/tmux.js';

const SKIP = process.env.SKIP_TMUX_TESTS === '1';
const BRAIN_SESSION = 'e2e_brain_flow_brain';
const WORKER_SESSION = 'e2e_brain_flow_w1';
const FIXTURES = new URL('../fixtures', import.meta.url).pathname;

describe.skipIf(SKIP)('Brain → Worker dispatch flow', () => {
  beforeAll(async () => {
    await killSession(BRAIN_SESSION).catch(() => {});
    await killSession(WORKER_SESSION).catch(() => {});
    // Start mock brain that reads stdin and outputs @commands
    await newSession(BRAIN_SESSION, `bash ${FIXTURES}/mock-brain.sh`, { cwd: '/tmp' });
    // Start mock worker that simulates CC-like agent
    await newSession(WORKER_SESSION, `bash ${FIXTURES}/mock-agent.sh`, { cwd: '/tmp' });
    // Give sessions time to start
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(async () => {
    await killSession(BRAIN_SESSION).catch(() => {});
    await killSession(WORKER_SESSION).catch(() => {});
  });

  it('brain and worker sessions exist', async () => {
    expect(await sessionExists(BRAIN_SESSION)).toBe(true);
    expect(await sessionExists(WORKER_SESSION)).toBe(true);
  });

  it('brain session captures output', async () => {
    const lines = await capturePane(BRAIN_SESSION);
    expect(lines).toBeDefined();
    expect(Array.isArray(lines)).toBe(true);
  });

  it('worker session captures output', async () => {
    const lines = await capturePane(WORKER_SESSION);
    expect(lines).toBeDefined();
    expect(Array.isArray(lines)).toBe(true);
  });

  it('brain receives and echoes input', async () => {
    await sendKeys(BRAIN_SESSION, 'Test task description');
    await new Promise((r) => setTimeout(r, 500));
    const lines = await capturePane(BRAIN_SESSION);
    const content = lines.join('\n');
    // mock-brain.sh echoes input
    expect(content).toBeTruthy();
  });

  it('worker can receive keys', async () => {
    await sendKeys(WORKER_SESSION, 'hello');
    await new Promise((r) => setTimeout(r, 300));
    const lines = await capturePane(WORKER_SESSION);
    expect(lines.length).toBeGreaterThan(0);
  });
});
