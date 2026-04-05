import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pidContents: [''],
  pidIndex: 0,
  scheduledTaskRunOk: false,
  vbsExists: false,
  startupCmdExists: false,
  alivePids: new Set<number>(),
  execCalls: [] as string[],
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
  /** Simulated wmic ParentProcessId result for killWatchdogTree */
  wmicParentPid: null as number | null,
}));

vi.mock('node:os', () => ({
  homedir: () => 'C:\\Users\\tester',
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    resolve: (...parts: string[]) => parts.join('\\'),
  };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => {
    if (path.endsWith('daemon-launcher.vbs')) return state.vbsExists;
    if (path.endsWith('Start Menu\\Programs\\Startup\\imcodes-daemon.cmd')) return state.startupCmdExists;
    return false;
  }),
  readFileSync: vi.fn(() => {
    const idx = Math.min(state.pidIndex, state.pidContents.length - 1);
    const value = state.pidContents[idx] ?? '';
    state.pidIndex += 1;
    return value;
  }),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string, opts?: { encoding?: string }) => {
    state.execCalls.push(cmd);
    // killWatchdogTree: wmic query for parent PID
    if (cmd.includes('wmic process where') && cmd.includes('ParentProcessId')) {
      if (state.wmicParentPid !== null) {
        const result = `\r\nParentProcessId=${state.wmicParentPid}\r\n`;
        return opts?.encoding ? result : Buffer.from(result);
      }
      throw new Error('not found');
    }
    // killWatchdogTree: taskkill /f /t (tree kill)
    if (cmd.startsWith('taskkill /f /t /pid ')) return '';
    // belt-and-suspenders: taskkill /f /pid (single process)
    if (cmd.startsWith('taskkill /f /pid ')) return '';
    if (cmd.includes('schtasks /Run /TN imcodes-daemon')) {
      if (!state.scheduledTaskRunOk) throw new Error('run failed');
      return '';
    }
    throw new Error(`unexpected execSync: ${cmd}`);
  }),
  spawn: vi.fn((cmd: string, args: string[]) => {
    state.spawnCalls.push({ cmd, args });
    return { unref: vi.fn() };
  }),
}));

describe('restartWindowsDaemon', () => {
  beforeEach(() => {
    vi.resetModules();
    state.pidContents = [''];
    state.pidIndex = 0;
    state.scheduledTaskRunOk = false;
    state.vbsExists = false;
    state.startupCmdExists = false;
    state.alivePids = new Set<number>();
    state.execCalls = [];
    state.spawnCalls = [];
    state.wmicParentPid = null;
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (!state.alivePids.has(pid)) throw new Error('not running');
      return true;
    }) as typeof process.kill);
  });

  it('returns false when no restart path is available', async () => {
    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(false);
    // No VBS, no schtask, no startup shortcut — nothing to trigger
    expect(state.spawnCalls).toHaveLength(0);
  });

  it('kills watchdog tree and launches VBS when available', async () => {
    state.pidContents = ['123', '456'];
    state.alivePids = new Set([456]);
    state.vbsExists = true;
    state.wmicParentPid = 999; // watchdog parent

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    // Should tree-kill the watchdog parent
    expect(state.execCalls).toContain('taskkill /f /t /pid 999');
    // Should launch VBS (preferred over schtask)
    expect(state.spawnCalls[0]).toEqual(
      expect.objectContaining({ cmd: 'wscript', args: expect.arrayContaining(['C:\\Users\\tester\\.imcodes\\daemon-launcher.vbs']) }),
    );
  });

  it('falls back to scheduled task when VBS is not available', async () => {
    state.pidContents = ['123', '456'];
    state.alivePids = new Set([456]);
    state.scheduledTaskRunOk = true;
    state.wmicParentPid = 888;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.execCalls).toContain('taskkill /f /t /pid 888');
    expect(state.execCalls).toContain('schtasks /Run /TN imcodes-daemon');
  });

  it('falls back to startup shortcut as last resort', async () => {
    state.pidContents = ['', '901'];
    state.alivePids = new Set([901]);
    state.startupCmdExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.spawnCalls).toEqual([
      {
        cmd: 'cmd',
        args: ['/c', 'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\imcodes-daemon.cmd'],
      },
    ]);
  });

  it('force-kills daemon if tree-kill misses it', async () => {
    state.pidContents = ['123', '456'];
    state.alivePids = new Set([123, 456]); // daemon still alive after tree-kill
    state.vbsExists = true;
    state.wmicParentPid = null; // wmic fails — no parent found

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    // Should fall back to direct taskkill
    expect(state.execCalls).toContain('taskkill /f /pid 123');
  });
});
