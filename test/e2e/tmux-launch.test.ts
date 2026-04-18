/**
 * E2E tests for tmux session launch correctness.
 * Ensures shell operators in commands (&&, ||) are handled properly.
 * Requires tmux. Skip with SKIP_TMUX_TESTS=1.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { newSession, killSession, sessionExists, capturePane } from '../../src/agent/tmux.js';
import { tmpdir } from 'os';

const SKIP = process.env.SKIP_TMUX_TESTS === '1' || !!process.env.CLAUDECODE;
const RUN_ID = Math.random().toString(36).slice(2, 8);
const SESSION = `e2e_tmux_launch_test_${RUN_ID}`;

describe.skipIf(SKIP)('tmux session launch', () => {
  afterEach(async () => {
    await killSession(SESSION).catch(() => {});
    await killSession(SESSION + '_noop').catch(() => {});
  });

  it('launches session with && in command without hanging', async () => {
    // This was the root bug: exec() would split on && and run the second part
    // in the daemon process directly, causing it to hang.
    // Use sleep so the session stays alive for the assertion.
    const cmd = `cd ${JSON.stringify(tmpdir())} && sleep 30`;
    const start = Date.now();
    await newSession(SESSION, cmd, { cwd: tmpdir() });
    const elapsed = Date.now() - start;

    // Must return in well under 10 seconds (not hang indefinitely even under full E2E load)
    expect(elapsed).toBeLessThan(10_000);
    expect(await sessionExists(SESSION)).toBe(true);
  }, 15_000);

  it('launches session with || fallback without hanging', async () => {
    // Verify || also works correctly (used by ucc.py-style resume-or-fresh pattern)
    const cmd = `false || sleep 30`;
    await newSession(SESSION + '_noop', cmd, { cwd: tmpdir() });
    expect(await sessionExists(SESSION + '_noop')).toBe(true);
  }, 10_000);

  it('launches without command', async () => {
    await newSession(SESSION, undefined, { cwd: tmpdir() });
    expect(await sessionExists(SESSION)).toBe(true);
  }, 10_000);

  it('throws when session already exists', async () => {
    await newSession(SESSION, 'sleep 60', { cwd: tmpdir() });
    await expect(newSession(SESSION, 'sleep 60', { cwd: tmpdir() })).rejects.toThrow();
  }, 10_000);
});
