import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pidContents: [''],
  pidIndex: 0,
  taskQueryOutput: '',
  scheduledTaskRunOk: false,
  vbsExists: false,
  startupCmdExists: false,
  alivePids: new Set<number>(),
  execCalls: [] as string[],
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
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
    if (cmd.startsWith('taskkill /f /pid ')) return '';
    if (cmd.includes('schtasks /Query /TN imcodes-daemon')) {
      if (!state.taskQueryOutput) throw new Error('task missing');
      return opts?.encoding ? state.taskQueryOutput : Buffer.from(state.taskQueryOutput);
    }
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
    state.taskQueryOutput = '';
    state.scheduledTaskRunOk = false;
    state.vbsExists = false;
    state.startupCmdExists = false;
    state.alivePids = new Set<number>();
    state.execCalls = [];
    state.spawnCalls = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (!state.alivePids.has(pid)) throw new Error('not running');
      return true;
    }) as typeof process.kill);
  });

  it('returns false when no restart path is available', async () => {
    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(false);
    expect(state.execCalls.some((c) => c.includes('schtasks /Run /TN imcodes-daemon'))).toBe(true);
    expect(state.spawnCalls).toHaveLength(0);
  });

  it('triggers scheduled task and waits for a new live daemon pid', async () => {
    state.pidContents = ['123', '456'];
    state.alivePids = new Set([456]);
    state.scheduledTaskRunOk = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.execCalls).toContain('taskkill /f /pid 123');
    expect(state.execCalls).toContain('schtasks /Run /TN imcodes-daemon');
  });

  it('accepts an already-running watchdog if it yields a new live daemon pid', async () => {
    state.pidContents = ['123', '123', '789'];
    state.alivePids = new Set([789]);
    state.taskQueryOutput = '"imcodes-daemon","Next Run Time","Status","Running"';

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.execCalls).toContain('taskkill /f /pid 123');
    expect(state.execCalls.some((c) => c.includes('schtasks /Query /TN imcodes-daemon'))).toBe(true);
  });

  it('falls back to VBS launcher and waits for daemon pid', async () => {
    state.pidContents = ['', '900'];
    state.alivePids = new Set([900]);
    state.vbsExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.spawnCalls).toEqual([
      { cmd: 'wscript', args: ['C:\\Users\\tester\\.imcodes\\daemon-launcher.vbs'] },
    ]);
  });

  it('falls back to startup shortcut when no scheduled task or VBS launcher is available', async () => {
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
});
