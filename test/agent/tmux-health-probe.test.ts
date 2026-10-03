import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The 30 s health poll used to ask tmux twice per process session
 * (`list-sessions` for "does it exist", `list-panes -t <name>` for "is its pane
 * alive"): 2N forks per tick. One `list-panes -a` now answers both for every
 * session. These tests replay the OLD per-session queries against the same
 * simulated tmux server as the baseline, and prove the probe returns the same
 * answers wherever the old code acted on them.
 */

interface Win { active: boolean; panes: boolean[] } // panes: pane_dead flags
const state = vi.hoisted(() => ({
  spawns: [] as string[][],
  sessions: new Map<string, Array<{ active: boolean; panes: boolean[] }>>(),
  failListPanesAll: false,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = ((..._args: unknown[]) => { throw new Error('callback execFile is not used by tmux.ts'); }) as unknown as typeof actual.execFile;
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = async (_command: string, args: string[]) => {
    state.spawns.push(args);
    const noServer = () => Object.assign(new Error('no server'), { stderr: 'no server running on /tmp/tmux-1000/default' });
    const dead = (win: Win) => win.panes.map((d) => (d ? '1' : '0'));
    if (args[0] === 'list-sessions') {
      if (state.sessions.size === 0) throw noServer();
      return { stdout: [...state.sessions.keys()].join('\n'), stderr: '' };
    }
    if (args[0] === 'list-panes' && args[1] === '-a') {
      if (state.failListPanesAll) throw Object.assign(new Error('boom'), { stderr: 'protocol version mismatch' });
      if (state.sessions.size === 0) throw noServer();
      const lines: string[] = [];
      for (const [name, wins] of state.sessions) for (const win of wins) for (const d of dead(win)) lines.push(`${win.active ? 1 : 0} ${d} ${name}`);
      return { stdout: lines.join('\n'), stderr: '' };
    }
    if (args[0] === 'list-panes' && args[1] === '-t') {
      const wins = state.sessions.get(args[2]);
      if (!wins) throw Object.assign(new Error('nf'), { stderr: `can't find session: ${args[2]}` });
      return { stdout: dead(wins.find((win) => win.active)!).join('\n'), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { ...actual, execFile, execFileSync: () => Buffer.from('') };
});

process.env.IMCODES_MUX = 'tmux';
const tmux = await import('../../src/agent/tmux.js');

const listPanesAll = () => state.spawns.filter((args) => args[0] === 'list-panes' && args[1] === '-a');
const perSession = () => state.spawns.filter((args) => args[0] === 'list-sessions' || (args[0] === 'list-panes' && args[1] === '-t'));

beforeEach(async () => {
  state.sessions = new Map([['warmup', [{ active: true, panes: [false] }]]]);
  state.failListPanesAll = false;
  await tmux.listSessions(); // primes ensureTmuxServer so its own probe is not counted
  state.sessions = new Map();
  state.spawns = [];
});
afterEach(() => vi.restoreAllMocks());

const single = (dead: boolean): Win[] => [{ active: true, panes: [dead] }];

describe('createTmuxHealthProbe', () => {
  it('answers a tick over many sessions with ONE spawn instead of two per session', async () => {
    const names = Array.from({ length: 6 }, (_, i) => `deck_probe_${i}`);
    for (const name of names) state.sessions.set(name, single(false));

    const legacy: Array<[boolean, boolean]> = [];
    for (const name of names) legacy.push([await tmux.sessionExists(name), await tmux.isPaneAlive(name)]);
    const legacySpawns = state.spawns.length;
    expect(legacySpawns).toBe(names.length * 2);

    state.spawns = [];
    const probe = tmux.createTmuxHealthProbe();
    const fresh: Array<[boolean, boolean]> = [];
    for (const name of names) fresh.push([await probe.exists(name), await probe.paneAlive(name)]);
    expect(fresh).toEqual(legacy);
    expect(state.spawns).toHaveLength(1);
    expect(listPanesAll()).toHaveLength(1);
    expect(legacySpawns / state.spawns.length).toBe(12);
  });

  it('gives the same exists/paneAlive answers as the old per-session queries in every pane layout', async () => {
    state.sessions = new Map<string, Win[]>([
      ['alive', single(false)],
      ['dead', single(true)],
      ['two_alive_panes', [{ active: true, panes: [false, false] }]],
      ['active_alive_other_window_dead', [{ active: true, panes: [false] }, { active: false, panes: [true] }]],
      ['active_dead_other_window_alive', [{ active: false, panes: [false] }, { active: true, panes: [true] }]],
      ['with space name', single(false)],
    ]);
    const probe = tmux.createTmuxHealthProbe();
    for (const name of [...state.sessions.keys(), 'missing']) {
      expect(await probe.exists(name), `exists ${name}`).toBe(await tmux.sessionExists(name));
      expect(await probe.paneAlive(name), `paneAlive ${name}`).toBe(await tmux.isPaneAlive(name));
    }
  });

  it('never acts on a stale negative: a session created after the snapshot is confirmed live', async () => {
    state.sessions.set('early', single(false));
    const probe = tmux.createTmuxHealthProbe();
    expect(await probe.exists('early')).toBe(true);
    state.sessions.set('late', single(false));
    state.spawns = [];
    expect(await probe.exists('late')).toBe(true);
    expect(state.spawns.map((args) => args[0])).toEqual(['list-sessions']);
  });

  it('never respawns on a stale "dead": a pane revived after the snapshot is confirmed live', async () => {
    state.sessions.set('flaky', single(true));
    const probe = tmux.createTmuxHealthProbe();
    expect(await probe.exists('flaky')).toBe(true);
    state.sessions.set('flaky', single(false));
    expect(await probe.paneAlive('flaky')).toBe(true);
    expect(perSession().at(-1)).toEqual(['list-panes', '-t', 'flaky', '-F', '#{pane_dead}']);
  });

  it('still reports a genuinely dead pane and a genuinely missing session', async () => {
    state.sessions.set('dead', single(true));
    const probe = tmux.createTmuxHealthProbe();
    expect(await probe.paneAlive('dead')).toBe(false);
    expect(await probe.exists('missing')).toBe(false);
  });

  it('falls back to the per-session queries when the snapshot itself fails', async () => {
    state.sessions.set('a', single(false));
    state.failListPanesAll = true;
    const probe = tmux.createTmuxHealthProbe();
    expect(await probe.exists('a')).toBe(true);
    expect(await probe.paneAlive('a')).toBe(true);
    expect(perSession().length).toBe(2);
  });

  it('treats "no tmux server" as an empty snapshot without throwing', async () => {
    const probe = tmux.createTmuxHealthProbe();
    expect(await probe.exists('anything')).toBe(false);
    expect(await probe.paneAlive('anything')).toBe(false);
  });

  it('refetches once a snapshot is older than maxAgeMs, and shares one fetch between concurrent callers', async () => {
    state.sessions.set('a', single(false));
    state.sessions.set('b', single(false));
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const probe = tmux.createTmuxHealthProbe(1_000);
    await Promise.all([probe.exists('a'), probe.exists('b'), probe.paneAlive('a'), probe.paneAlive('b')]);
    expect(listPanesAll()).toHaveLength(1);
    now += 500;
    await probe.exists('a');
    expect(listPanesAll()).toHaveLength(1);
    now += 600;
    await probe.exists('a');
    expect(listPanesAll()).toHaveLength(2);
  });
});
