import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Many windows poll the same read-only tmux query in the same tick; each used
 * to cost its own `tmux` fork on the daemon's main thread. Identical
 * concurrent reads now share one spawn, but only while no write (send-keys,
 * new-session, ...) has started or finished since that spawn began, so a
 * caller that writes and then reads never receives a pre-write snapshot.
 */

const state = vi.hoisted(() => ({
  spawns: [] as string[][],
  release: [] as Array<() => void>,
  gated: false,
  gateWrite: false,
  writeRelease: [] as Array<() => void>,
  screen: 'before',
  fail: false,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = ((..._args: unknown[]) => { throw new Error('callback execFile is not used by tmux.ts'); }) as unknown as typeof actual.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (_command: string, args: string[]) => {
    state.spawns.push(args);
    const isRead = args[0] === 'capture-pane' || args[0] === 'list-sessions' || args[0] === 'display-message';
    const snapshot = state.screen;
    if (state.gated && isRead && args[0] === 'capture-pane') {
      await new Promise<void>((resolve) => { state.release.push(resolve); });
    }
    if (state.fail && args[0] === 'capture-pane') throw Object.assign(new Error('capture failed'), { stderr: "can't find pane" });
    if (args[0] === 'send-keys') {
      if (state.gateWrite) await new Promise<void>((resolve) => { state.writeRelease.push(resolve); });
      state.screen = 'after';
    }
    if (args[0] === 'capture-pane') return { stdout: snapshot, stderr: '' };
    if (args[0] === 'list-sessions') return { stdout: 's1\ns2', stderr: '' };
    if (args[0] === 'display-message') return { stdout: '%7', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  return { ...actual, execFile, execFileSync: () => Buffer.from('') };
});

process.env.IMCODES_MUX = 'tmux';
const tmux = await import('../../src/agent/tmux.js');

const captureSpawns = () => state.spawns.filter((args) => args[0] === 'capture-pane');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('tmuxRun read coalescing', () => {
  beforeEach(async () => {
    state.gated = false;
    state.gateWrite = false;
    state.writeRelease = [];
    state.fail = false;
    state.screen = 'before';
    state.release = [];
    await tmux.listSessions(); // primes ensureTmuxServer so its own probe is not counted
    state.spawns = [];
  });

  it('shares one spawn between identical concurrent reads (N windows polling the same pane)', async () => {
    const windows = 6;
    const results = await Promise.all(Array.from({ length: windows }, () => tmux.capturePane('s1', 40)));
    expect(captureSpawns()).toHaveLength(1);
    expect(results.every((lines) => lines.join('\n') === 'before')).toBe(true);
    expect(windows / captureSpawns().length).toBe(6);
  });

  it('does not share reads that differ in any argument', async () => {
    await Promise.all([tmux.capturePane('s1', 40), tmux.capturePane('s2', 40), tmux.capturePane('s1', 80)]);
    expect(captureSpawns()).toHaveLength(3);
  });

  it('never gives a caller that wrote and then read a snapshot taken before its write', async () => {
    state.gated = true;
    state.gateWrite = true;
    const stale = tmux.capturePane('s1', 40);
    await tick();
    expect(captureSpawns()).toHaveLength(1);

    // The write starts while the first read is still in flight and is itself still running.
    const write = tmux.sendKey('s1', 'C-c');
    await tick();
    const duringWrite = tmux.capturePane('s1', 40);
    await tick();
    expect(captureSpawns()).toHaveLength(2);

    state.gateWrite = false;
    for (const release of state.writeRelease.splice(0)) release();
    await write;
    const afterWrite = tmux.capturePane('s1', 40);
    await tick();
    // Neither the pre-write read nor the during-write read may serve a post-write caller.
    expect(captureSpawns()).toHaveLength(3);

    state.gated = false;
    for (const release of state.release.splice(0)) release();
    const [a, , c] = await Promise.all([stale, duringWrite, afterWrite]);
    expect(a.join('\n')).toBe('before');
    expect(c.join('\n')).toBe('after');
  });

  it('lets reads issued after a finished write share a fresh spawn', async () => {
    await tmux.sendKey('s1', 'C-c');
    state.spawns = [];
    await Promise.all([tmux.capturePane('s1', 40), tmux.capturePane('s1', 40)]);
    expect(captureSpawns()).toHaveLength(1);
  });

  it('never coalesces writes, and keeps their order', async () => {
    await Promise.all([tmux.sendKey('s1', 'Enter'), tmux.sendKey('s1', 'Enter'), tmux.sendKey('s1', 'C-c')]);
    const sends = state.spawns.filter((args) => args[0] === 'send-keys').map((args) => args.at(-1));
    expect(sends).toEqual(['Enter', 'Enter', 'C-c']);
  });

  it('gives every sharer the failure, and the next read spawns fresh', async () => {
    state.fail = true;
    const outcomes = await Promise.allSettled([tmux.capturePane('s1', 40), tmux.capturePane('s1', 40), tmux.capturePane('s1', 40)]);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(captureSpawns()).toHaveLength(1);
    state.fail = false;
    state.spawns = [];
    expect((await tmux.capturePane('s1', 40)).join('\n')).toBe('before');
    expect(captureSpawns()).toHaveLength(1);
  });

  it('shares list-sessions and pane-id queries too', async () => {
    const [a, b, c, d] = await Promise.all([tmux.listSessions(), tmux.listSessions(), tmux.getPaneId('s1'), tmux.getPaneId('s1')]);
    expect(a).toEqual(b);
    expect(c).toBe(d);
    expect(state.spawns.filter((args) => args[0] === 'list-sessions')).toHaveLength(1);
    expect(state.spawns.filter((args) => args[0] === 'display-message')).toHaveLength(1);
  });
});
