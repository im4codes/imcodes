import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Shared mock state ──────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  pidContents: [''],
  pidIndex: 0,
  scheduledTaskRunOk: false,
  vbsExists: false,
  startupCmdExists: false,
  alivePids: new Set<number>(),
  execCalls: [] as string[],
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\tester' }));

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual, resolve: (...parts: string[]) => parts.join('\\') };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: string) => {
    if (path.endsWith('daemon-launcher.vbs')) return state.vbsExists;
    if (path.endsWith('imcodes-daemon.cmd')) return state.startupCmdExists;
    return false;
  }),
  readFileSync: vi.fn(() => {
    const idx = Math.min(state.pidIndex, state.pidContents.length - 1);
    state.pidIndex += 1;
    return state.pidContents[idx] ?? '';
  }),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    state.execCalls.push(cmd);
    if (cmd.startsWith('taskkill ')) return '';
    if (cmd.includes('schtasks /Run')) {
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

function reset(): void {
  vi.resetModules();
  state.pidContents = [''];
  state.pidIndex = 0;
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
}

// ── restartWindowsDaemon tests ─────────────────────────────────────────────────

describe('restartWindowsDaemon', () => {
  beforeEach(reset);

  // ── Launcher priority ──

  it('returns false when no launcher path is available', async () => {
    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(false);
    expect(state.spawnCalls).toHaveLength(0);
  });

  it('prefers VBS launcher over scheduled task', async () => {
    state.pidContents = ['', '100'];
    state.alivePids = new Set([100]);
    state.vbsExists = true;
    state.scheduledTaskRunOk = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.spawnCalls[0].cmd).toBe('wscript');
    // Should NOT have called schtasks since VBS succeeded
    expect(state.execCalls.some(c => c.includes('schtasks /Run'))).toBe(false);
  });

  it('falls back to scheduled task when VBS missing', async () => {
    state.pidContents = ['', '200'];
    state.alivePids = new Set([200]);
    state.scheduledTaskRunOk = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.spawnCalls).toHaveLength(0);
    expect(state.execCalls).toContain('schtasks /Run /TN imcodes-daemon');
  });

  it('falls back to startup shortcut as last resort', async () => {
    state.pidContents = ['', '300'];
    state.alivePids = new Set([300]);
    state.startupCmdExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0].cmd).toMatch(/cmd(\.exe)?$/i);
  });

  // ── Daemon kill ──

  it('kills existing daemon by PID before launching', async () => {
    state.pidContents = ['555', '666'];
    state.alivePids = new Set([666]);
    state.vbsExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    expect(state.execCalls).toContain('taskkill /f /pid 555');
  });

  it('handles daemon already dead gracefully', async () => {
    // PID file has a value but process is not running — should not throw
    state.pidContents = ['999', '888'];
    state.alivePids = new Set([888]);
    state.vbsExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
    // taskkill was attempted (and silently failed)
    expect(state.execCalls).toContain('taskkill /f /pid 999');
  });

  // ── PID wait logic ──

  it('waits for new PID different from old', async () => {
    // First read: old PID 100, second read: new PID 200
    state.pidContents = ['100', '200'];
    state.alivePids = new Set([200]);
    state.vbsExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
  });

  it('works when no previous PID exists (fresh start)', async () => {
    state.pidContents = ['', '500'];
    state.alivePids = new Set([500]);
    state.vbsExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    expect(restartWindowsDaemon()).toBe(true);
  });

  it('skips own PID when passed as currentPid', async () => {
    // PID file contains our own PID — should treat as "no previous daemon"
    state.pidContents = ['42', '700'];
    state.alivePids = new Set([700]);
    state.vbsExists = true;

    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    // currentPid=42 matches PID file → no taskkill
    expect(restartWindowsDaemon(42)).toBe(true);
    expect(state.execCalls.some(c => c.includes('taskkill'))).toBe(false);
  });

  // ── windowsHide on all spawn calls ──

  it('passes windowsHide to VBS spawn', async () => {
    state.pidContents = ['', '100'];
    state.alivePids = new Set([100]);
    state.vbsExists = true;

    const { spawn } = await import('node:child_process');
    const { restartWindowsDaemon } = await import('../../src/util/windows-daemon.js');
    restartWindowsDaemon();
    const call = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true }));
  });
});
