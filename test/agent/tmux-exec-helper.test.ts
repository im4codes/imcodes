import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXEC_HELPER_ENV_SWITCH } from '../../shared/exec-helper-protocol.js';
import { ProcessStartReader } from '../../src/util/process-start.js';
import { __resetExecHelperForTests, getExecHelperStats, shutdownExecHelper, startExecHelper } from '../../src/util/exec-helper.js';

function hasTmux(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const RUN = process.platform !== 'win32' && hasTmux() && !process.env.SKIP_TMUX_TESTS;

/**
 * The real tmux module and the real process-start reader, with the exec helper
 * forked at "boot" (before TMUX_TMPDIR is even set): every tmux/ps call must reach a
 * private tmux server through the helper, in issue order, never the default server.
 */
describe.skipIf(!RUN)('tmux and process-start through the exec helper', () => {
  let tmuxDir: string;
  const previousTmpDir = process.env.TMUX_TMPDIR;
  let tmux: typeof import('../../src/agent/tmux.js');
  const session = 'deck_sub_exechelperorder';

  beforeAll(async () => {
    tmuxDir = mkdtempSync(join(tmpdir(), 'imc-tmux-helper-'));
    process.env[EXEC_HELPER_ENV_SWITCH] = '1';
    startExecHelper();
    const deadline = Date.now() + 15_000;
    while (!getExecHelperStats()?.ready) {
      if (Date.now() > deadline) throw new Error('exec helper never became ready');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    process.env.TMUX_TMPDIR = tmuxDir; // set AFTER the helper was forked: calls must carry it
    tmux = await import('../../src/agent/tmux.js');
  }, 30_000);

  afterAll(async () => {
    try { execFileSync('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir }, stdio: 'ignore' }); } catch { /* none */ }
    await shutdownExecHelper();
    __resetExecHelperForTests();
    delete process.env[EXEC_HELPER_ENV_SWITCH];
    if (previousTmpDir === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmpDir;
    rmSync(tmuxDir, { recursive: true, force: true });
  });

  it('creates, writes to, reads and kills a session on the private server, all via the helper', async () => {
    const before = getExecHelperStats()!.viaHelper;
    await tmux.newSession(session, 'cat');
    expect(await tmux.sessionExists(session)).toBe(true);
    expect(await tmux.listSessions()).toContain(session);
    expect(getExecHelperStats()!.viaHelper).toBeGreaterThan(before + 2);
    // The default tmux server (the owner's) never saw this session.
    const defaultServer = (() => { try { return execFileSync('tmux', ['list-sessions', '-F', '#S'], { env: { ...process.env, TMUX_TMPDIR: '/nonexistent-imc-default' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } })();
    expect(defaultServer).not.toContain(session);
  }, 30_000);

  it('keeps send-keys in issue order for one session (per-session write ordering)', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, '0')}`);
    for (const line of lines) await tmux.sendKeys(session, line);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pane = (await tmux.capturePane(session, 200)).join('\n');
    const seen = [...pane.matchAll(/line-(\d{2})/g)].map((m) => Number(m[1]));
    const firstOfEach = seen.filter((n, i) => seen.indexOf(n) === i);
    expect(firstOfEach).toEqual(lines.map((_, i) => i));
  }, 60_000);

  it('a tmux failure surfaces as a tmux error, not as a helper failure', async () => {
    await expect(tmux.capturePane('deck_sub_does_not_exist', 5)).rejects.toMatchObject({ code: 1 });
  }, 30_000);

  it('the process-start batch (one ps spawn for many pids) returns what a direct ps returns', async () => {
    const reader = new ProcessStartReader();
    const before = getExecHelperStats()!.viaHelper;
    const pids = [process.pid, process.ppid];
    const [own, parent] = await Promise.all(pids.map((pid) => reader.read(pid)));
    expect(getExecHelperStats()!.viaHelper).toBeGreaterThan(before);
    const direct = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    expect(own).toBe(direct(process.pid));
    expect(parent).toBe(direct(process.ppid));
    expect(await new ProcessStartReader().read(999_999_999)).toBeUndefined();
  }, 30_000);

  it('after the session is killed through the helper it is gone', async () => {
    await tmux.killSession(session);
    expect(await tmux.sessionExists(session)).toBe(false);
  }, 30_000);
});
