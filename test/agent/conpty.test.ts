import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const normalizeSlashes = (value: string) => value.replace(/\\/g, '/');

// ── Mock node-pty ──────────────────────────────────────────────────────────────

interface MockPty {
  pid: number;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  _dataListeners: ((data: string) => void)[];
  _exitListeners: ((e: { exitCode: number }) => void)[];
  /** Simulate PTY output */
  _emit(data: string): void;
  /** Simulate PTY exit */
  _exit(exitCode: number): void;
}

function createMockPty(pid = 1234): MockPty {
  const pty: MockPty = {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    _dataListeners: [],
    _exitListeners: [],
    _emit(data: string) {
      for (const cb of this._dataListeners) cb(data);
    },
    _exit(exitCode: number) {
      for (const cb of this._exitListeners) cb({ exitCode });
    },
  };
  pty.onData.mockImplementation((cb: (data: string) => void) => { pty._dataListeners.push(cb); });
  pty.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => { pty._exitListeners.push(cb); });
  return pty;
}

let mockPty: MockPty;
let spawnMock: ReturnType<typeof vi.fn>;

// Mock node-pty before importing conpty
vi.mock('node-pty', () => {
  return {
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

// Mock child_process.execSync for taskkill
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

import { execSync } from 'child_process';
const execSyncMock = vi.mocked(execSync);

// ── Import conpty module ───────────────────────────────────────────────────────

let conpty: typeof import('../../src/agent/conpty.js');

beforeEach(async () => {
  vi.clearAllMocks();
  mockPty = createMockPty();
  spawnMock = vi.fn().mockReturnValue(mockPty);
  conpty = await import('../../src/agent/conpty.js');
});

afterEach(() => {
  // Clean up all sessions
  for (const name of conpty.conptyListSessions()) {
    try { conpty.conptyKillSession(name); } catch { /* ignore */ }
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('conpty backend', () => {
  // ── Session lifecycle ──────────────────────────────────────────────────────

  describe('conptyNewSession', () => {
    it('spawns a PTY via node-pty with correct args', async () => {
      await conpty.conptyNewSession('test-session', 'echo hello', {
        cwd: '/tmp',
        env: { FOO: 'bar' },
        cols: 120,
        rows: 40,
      });

      expect(spawnMock).toHaveBeenCalledWith('echo', ['hello'], {
        cwd: '/tmp',
        env: expect.objectContaining({ FOO: 'bar' }),
        cols: 120,
        rows: 40,
        useConpty: true,
      });
      expect(conpty.conptySessionExists('test-session')).toBe(true);
    });

    it('strips redundant cd /d prefix from command', async () => {
      await conpty.conptyNewSession('cd-strip', 'cd /d "C:\\Users\\admin" && claude --resume abc', {
        cwd: 'C:\\Users\\admin',
      });

      expect(spawnMock).toHaveBeenCalledWith('claude', ['--resume', 'abc'], expect.objectContaining({
        cwd: expect.any(String),
      }));
    });

    it('strips cd prefix without /d flag', async () => {
      await conpty.conptyNewSession('cd-strip2', 'cd "C:\\path" && some-cmd', {
        cwd: 'C:\\path',
      });

      expect(spawnMock).toHaveBeenCalledWith('some-cmd', [], expect.objectContaining({
        cwd: expect.any(String),
      }));
    });

    it('uses default cols=200, rows=50 when not specified', async () => {
      await conpty.conptyNewSession('test-defaults', 'cmd');

      expect(spawnMock).toHaveBeenCalledWith('cmd', [], expect.objectContaining({
        cols: 200,
        rows: 50,
      }));
    });

    it('merges opts.env with process.env', async () => {
      await conpty.conptyNewSession('test-env', 'cmd', {
        env: { CUSTOM_VAR: '1' },
      });

      const call = spawnMock.mock.calls[0];
      const envArg = call[2].env;
      expect(envArg).toHaveProperty('CUSTOM_VAR', '1');
      // process.env should also be present
      expect(envArg).toHaveProperty('PATH');
    });

    it('registers onData and onExit listeners', async () => {
      await conpty.conptyNewSession('test-listeners', 'cmd');

      expect(mockPty.onData).toHaveBeenCalledTimes(1);
      expect(mockPty.onExit).toHaveBeenCalledTimes(1);
    });

    it('uses cmd.exe for compound Windows commands', async () => {
      const origPlatform = process.platform;
      const origComspec = process.env.COMSPEC;
      const origAppData = process.env.APPDATA;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
        process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming';

        await conpty.conptyNewSession('win-shell', 'cd /d "C:\\repo" && claude --dangerously-skip-permissions -c || claude --dangerously-skip-permissions', {
          cwd: 'C:\\repo',
        });

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [file, args, options] = spawnMock.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
        expect(file).toBe('C:\\Windows\\System32\\cmd.exe');
        expect(args).toEqual(['/d', '/c', 'claude --dangerously-skip-permissions -c || claude --dangerously-skip-permissions']);
        expect(options.cwd).toBe('C:\\repo');
        expect(options.env.PATH).toMatch(/C:\\Users\\tester\\AppData\\Roaming[\\/]npm/);
      } finally {
        if (origComspec === undefined) delete process.env.COMSPEC; else process.env.COMSPEC = origComspec;
        if (origAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = origAppData;
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });
  });

  describe('conptySessionExists / conptyListSessions', () => {
    it('returns false for non-existent session', () => {
      expect(conpty.conptySessionExists('nope')).toBe(false);
    });

    it('lists all active sessions', async () => {
      await conpty.conptyNewSession('s1', 'cmd');
      mockPty = createMockPty(5678);
      spawnMock.mockReturnValue(mockPty);
      await conpty.conptyNewSession('s2', 'cmd');

      const sessions = conpty.conptyListSessions();
      expect(sessions).toContain('s1');
      expect(sessions).toContain('s2');
      expect(sessions).toHaveLength(2);
    });
  });

  describe('conptyKillSession', () => {
    it('removes session from map', async () => {
      await conpty.conptyNewSession('kill-me', 'cmd');
      expect(conpty.conptySessionExists('kill-me')).toBe(true);

      conpty.conptyKillSession('kill-me');
      expect(conpty.conptySessionExists('kill-me')).toBe(false);
    });

    it('calls pty.kill()', async () => {
      await conpty.conptyNewSession('kill-test', 'cmd');
      conpty.conptyKillSession('kill-test');

      expect(mockPty.kill).toHaveBeenCalled();
    });

    it('is a no-op for non-existent sessions', () => {
      // Should not throw
      conpty.conptyKillSession('doesnt-exist');
    });

    it('calls taskkill on Windows', async () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      await conpty.conptyNewSession('win-kill', 'cmd');
      conpty.conptyKillSession('win-kill');

      expect(execSyncMock).toHaveBeenCalledWith(
        `taskkill /F /T /PID ${mockPty.pid}`,
        { stdio: 'ignore' },
      );

      Object.defineProperty(process, 'platform', { value: origPlatform });
    });
  });

  // ── I/O ────────────────────────────────────────────────────────────────────

  describe('conptySendText', () => {
    it('writes text directly to PTY', async () => {
      await conpty.conptyNewSession('io-test', 'cmd');
      conpty.conptySendText('io-test', 'hello world');

      expect(mockPty.write).toHaveBeenCalledWith('hello world');
    });

    it('is a no-op for non-existent session', () => {
      conpty.conptySendText('nope', 'data');
      // Should not throw
    });
  });

  describe('conptySendEnter', () => {
    it('sends carriage return', async () => {
      await conpty.conptyNewSession('enter-test', 'cmd');
      conpty.conptySendEnter('enter-test');

      expect(mockPty.write).toHaveBeenCalledWith('\r');
    });
  });

  describe('conptySendKey', () => {
    it('maps tmux key names to escape sequences', async () => {
      await conpty.conptyNewSession('key-test', 'cmd');

      conpty.conptySendKey('key-test', 'Up');
      expect(mockPty.write).toHaveBeenCalledWith('\x1b[A');

      conpty.conptySendKey('key-test', 'Down');
      expect(mockPty.write).toHaveBeenCalledWith('\x1b[B');

      conpty.conptySendKey('key-test', 'Enter');
      expect(mockPty.write).toHaveBeenCalledWith('\r');
    });

    it('handles C-<letter> ctrl sequences', async () => {
      await conpty.conptyNewSession('ctrl-test', 'cmd');

      conpty.conptySendKey('ctrl-test', 'C-c');
      expect(mockPty.write).toHaveBeenCalledWith('\x03');

      conpty.conptySendKey('ctrl-test', 'C-d');
      expect(mockPty.write).toHaveBeenCalledWith('\x04');
    });

    it('falls back to writing key string directly for unknown keys', async () => {
      await conpty.conptyNewSession('fallback-test', 'cmd');

      conpty.conptySendKey('fallback-test', 'x');
      expect(mockPty.write).toHaveBeenCalledWith('x');
    });
  });

  // ── Ring buffer / capture ──────────────────────────────────────────────────

  describe('conptyCapturePane', () => {
    it('returns empty array for non-existent session', () => {
      expect(conpty.conptyCapturePane('nope')).toEqual([]);
    });

    it('captures complete lines from PTY output', async () => {
      await conpty.conptyNewSession('cap-test', 'cmd');

      mockPty._emit('line1\nline2\nline3\n');
      const lines = conpty.conptyCapturePane('cap-test', 10);
      expect(lines).toEqual(['line1', 'line2', 'line3']);
    });

    it('handles partial lines (no trailing newline)', async () => {
      await conpty.conptyNewSession('partial-test', 'cmd');

      mockPty._emit('complete\npartial');
      let lines = conpty.conptyCapturePane('partial-test', 10);
      expect(lines).toEqual(['complete']);

      // Complete the partial line
      mockPty._emit(' line\n');
      lines = conpty.conptyCapturePane('partial-test', 10);
      expect(lines).toEqual(['complete', 'partial line']);
    });

    it('returns last N lines', async () => {
      await conpty.conptyNewSession('lastn-test', 'cmd');

      mockPty._emit('a\nb\nc\nd\ne\n');
      const lines = conpty.conptyCapturePane('lastn-test', 3);
      expect(lines).toEqual(['c', 'd', 'e']);
    });

    it('caps ring buffer at 500 lines', async () => {
      await conpty.conptyNewSession('overflow-test', 'cmd');

      // Emit 600 lines
      const bigOutput = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n') + '\n';
      mockPty._emit(bigOutput);

      const all = conpty.conptyCapturePane('overflow-test', 600);
      expect(all).toHaveLength(500);
      // Should have lines 100-599 (oldest 100 dropped)
      expect(all[0]).toBe('line100');
      expect(all[499]).toBe('line599');
    });

    it('defaults to last 50 lines', async () => {
      await conpty.conptyNewSession('default-test', 'cmd');

      const output = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n';
      mockPty._emit(output);

      const lines = conpty.conptyCapturePane('default-test');
      expect(lines).toHaveLength(50);
      expect(lines[0]).toBe('line50');
    });
  });

  // ── Streaming / subscribe ──────────────────────────────────────────────────

  describe('conptySubscribe', () => {
    it('receives PTY output via callback', async () => {
      await conpty.conptyNewSession('sub-test', 'cmd');

      const received: string[] = [];
      conpty.conptySubscribe('sub-test', (data) => received.push(data));

      mockPty._emit('hello');
      mockPty._emit('world');

      expect(received).toEqual(['hello', 'world']);
    });

    it('supports multiple subscribers', async () => {
      await conpty.conptyNewSession('multi-sub', 'cmd');

      const sub1: string[] = [];
      const sub2: string[] = [];
      conpty.conptySubscribe('multi-sub', (data) => sub1.push(data));
      conpty.conptySubscribe('multi-sub', (data) => sub2.push(data));

      mockPty._emit('data');

      expect(sub1).toEqual(['data']);
      expect(sub2).toEqual(['data']);
    });

    it('returns unsubscribe function', async () => {
      await conpty.conptyNewSession('unsub-test', 'cmd');

      const received: string[] = [];
      const unsub = conpty.conptySubscribe('unsub-test', (data) => received.push(data));

      mockPty._emit('before');
      unsub();
      mockPty._emit('after');

      expect(received).toEqual(['before']);
    });

    it('returns no-op unsubscribe for non-existent session', () => {
      const unsub = conpty.conptySubscribe('nope', () => {});
      unsub(); // Should not throw
    });

    it('isolates subscriber errors', async () => {
      await conpty.conptyNewSession('error-sub', 'cmd');

      const good: string[] = [];
      conpty.conptySubscribe('error-sub', () => { throw new Error('boom'); });
      conpty.conptySubscribe('error-sub', (data) => good.push(data));

      mockPty._emit('data');
      expect(good).toEqual(['data']); // Second subscriber still works
    });
  });

  // ── Liveness ───────────────────────────────────────────────────────────────

  describe('conptyIsPaneAlive', () => {
    it('returns true for running session', async () => {
      await conpty.conptyNewSession('alive-test', 'cmd');
      expect(conpty.conptyIsPaneAlive('alive-test')).toBe(true);
    });

    it('returns false after onExit fires', async () => {
      await conpty.conptyNewSession('exit-test', 'cmd');

      mockPty._exit(0);
      expect(conpty.conptyIsPaneAlive('exit-test')).toBe(false);
    });

    it('returns false for non-existent session', () => {
      expect(conpty.conptyIsPaneAlive('nope')).toBe(false);
    });
  });

  // ── Resize ─────────────────────────────────────────────────────────────────

  describe('conptyResize', () => {
    it('calls pty.resize and updates cached size', async () => {
      await conpty.conptyNewSession('resize-test', 'cmd', { cols: 80, rows: 24 });

      conpty.conptyResize('resize-test', 160, 48);

      expect(mockPty.resize).toHaveBeenCalledWith(160, 48);
      expect(conpty.conptyGetPaneSize('resize-test')).toEqual({ cols: 160, rows: 48 });
    });
  });

  describe('conptyGetPaneSize', () => {
    it('returns cached dimensions from spawn', async () => {
      await conpty.conptyNewSession('size-test', 'cmd', { cols: 100, rows: 30 });
      expect(conpty.conptyGetPaneSize('size-test')).toEqual({ cols: 100, rows: 30 });
    });

    it('returns default 200x50 for non-existent session', () => {
      expect(conpty.conptyGetPaneSize('nope')).toEqual({ cols: 200, rows: 50 });
    });
  });

  // ── Introspection ──────────────────────────────────────────────────────────

  describe('conptyGetPid', () => {
    it('returns the PTY process PID', async () => {
      await conpty.conptyNewSession('pid-test', 'cmd');
      expect(conpty.conptyGetPid('pid-test')).toBe(1234);
    });

    it('throws for non-existent session', () => {
      expect(() => conpty.conptyGetPid('nope')).toThrow('ConPTY session not found');
    });
  });

  describe('conptyGetPaneCwd', () => {
    it('returns cached spawn CWD', async () => {
      await conpty.conptyNewSession('cwd-test', 'cmd', { cwd: '/home/user/project' });
      expect(normalizeSlashes(conpty.conptyGetPaneCwd('cwd-test'))).toBe('/home/user/project');
    });

    it('returns empty string for non-existent session', () => {
      expect(conpty.conptyGetPaneCwd('nope')).toBe('');
    });
  });

  describe('conptyGetPanePids', () => {
    it('returns single-element array with PTY PID as string', async () => {
      await conpty.conptyNewSession('pids-test', 'cmd');
      expect(conpty.conptyGetPanePids('pids-test')).toEqual(['1234']);
    });

    it('returns empty array for non-existent session', () => {
      expect(conpty.conptyGetPanePids('nope')).toEqual([]);
    });
  });

  // ── Respawn ────────────────────────────────────────────────────────────────

  describe('conptyRespawnPane', () => {
    it('kills old session and creates new one with same name', async () => {
      await conpty.conptyNewSession('respawn-test', 'old-cmd', { cwd: '/old/path' });
      expect(conpty.conptySessionExists('respawn-test')).toBe(true);

      const newMockPty = createMockPty(9999);
      spawnMock.mockReturnValue(newMockPty);

      await conpty.conptyRespawnPane('respawn-test', 'new-cmd');

      expect(conpty.conptySessionExists('respawn-test')).toBe(true);
      // Should have spawned with new command but preserved CWD
      const lastCall = spawnMock.mock.calls.at(-1) as [string, string[], { cwd?: string }] | undefined;
      expect(lastCall?.[0]).toBe('new-cmd');
      expect(lastCall?.[1]).toEqual([]);
      expect(normalizeSlashes(lastCall?.[2]?.cwd ?? '')).toBe('/old/path');
    });

    it('old PTY is killed before new one is spawned', async () => {
      await conpty.conptyNewSession('respawn-order', 'cmd');

      const newMock = createMockPty(5555);
      spawnMock.mockReturnValue(newMock);

      await conpty.conptyRespawnPane('respawn-order', 'new-cmd');

      expect(mockPty.kill).toHaveBeenCalled();
    });
  });
});
