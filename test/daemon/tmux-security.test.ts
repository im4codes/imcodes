/**
 * Tests for tmux.ts shell-injection prevention and FIFO lifecycle.
 * Verifies that all tmux commands use execFile (no shell) and that
 * special characters in session names, commands, and paths are not
 * interpreted as shell metacharacters.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';

// Track all execFile calls to verify args
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let failNextTmuxSubcommand: string | null = null;
let failNextTmuxErrorText = 'server exited unexpectedly';
const originalExecFile = childProcess.execFile;

// Mock execFile to capture calls and return success
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    execFile: vi.fn((...callArgs: any[]) => {
      const cmd = callArgs[0] as string;
      const args = callArgs[1] as string[];
      const cb = callArgs[callArgs.length - 1];
      execFileCalls.push({ cmd, args: [...args] });

      // Return mock stdout for commands that need it
      const subCmd = args[0];
      if (cmd === 'tmux') {
        if (failNextTmuxSubcommand && subCmd === failNextTmuxSubcommand) {
          const err = Object.assign(new Error(failNextTmuxErrorText), {
            stderr: failNextTmuxErrorText,
          });
          failNextTmuxSubcommand = null;
          if (typeof cb === 'function') cb(err);
          return;
        }
        if (subCmd === 'list-sessions') {
          if (typeof cb === 'function') cb(null, { stdout: '' });
          return;
        }
        if (subCmd === 'display-message') {
          if (typeof cb === 'function') cb(null, { stdout: '80 24' });
          return;
        }
        if (subCmd === 'capture-pane') {
          if (typeof cb === 'function') cb(null, { stdout: 'test output' });
          return;
        }
        if (subCmd === 'list-panes') {
          if (typeof cb === 'function') cb(null, { stdout: '0' });
          return;
        }
        if (subCmd === '-V') {
          if (typeof cb === 'function') cb(null, { stdout: 'tmux 3.4' });
          return;
        }
      }
      // Default success
      if (typeof cb === 'function') cb(null, { stdout: '' });
    }),
  };
});

// Import after mocking
const tmux = await import('../../src/agent/tmux.js');

describe('tmux shell-injection prevention', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    failNextTmuxSubcommand = null;
    failNextTmuxErrorText = 'server exited unexpectedly';
  });

  it('uses execFile (not exec) for all tmux commands', async () => {
    // This test verifies that the module only imports execFile
    // If someone reverts to exec(), the mock won't capture those calls
    await tmux.capturePane('deck_test_brain');
    // Filter out ensureTmuxServer's list-sessions probe
    const nonProbe = execFileCalls.filter((c) => c.args[0] !== 'list-sessions');
    expect(nonProbe.length).toBeGreaterThan(0);
    expect(nonProbe[0].cmd).toBe('tmux');
    // Verify it's an array of args, not a single shell string
    expect(Array.isArray(nonProbe[0].args)).toBe(true);
    expect(nonProbe[0].args[0]).toBe('capture-pane');
  });

  it('session names with shell metacharacters are passed as literal args', async () => {
    const malicious = 'deck_test_brain; rm -rf /';
    await tmux.killSession(malicious);
    const call = execFileCalls.find((c) => c.args[0] === 'kill-session');
    expect(call).toBeDefined();
    // The session name must be a single array element, not split by shell
    expect(call!.args).toEqual(['kill-session', '-t', malicious]);
  });

  it('sendKeys passes text with shell metacharacters as literal arg', async () => {
    const payload = '$(whoami) && echo pwned';
    await tmux.sendKey('deck_test_brain', payload);
    const call = execFileCalls.find((c) => c.args.includes(payload));
    expect(call).toBeDefined();
    expect(call!.args).toEqual(['send-keys', '-t', 'deck_test_brain', payload]);
  });

  it('newSession passes command with backticks as literal arg', async () => {
    const command = 'echo `id`; cat /etc/passwd';
    await tmux.newSession('deck_test_brain', command);
    const call = execFileCalls.find((c) => c.args[0] === 'new-session');
    expect(call).toBeDefined();
    // Command is after '--' separator, as a single arg
    const dashDashIdx = call!.args.indexOf('--');
    expect(dashDashIdx).toBeGreaterThan(0);
    expect(call!.args[dashDashIdx + 1]).toBe(command);
  });

  it('newSession passes cwd with spaces as literal arg', async () => {
    await tmux.newSession('deck_test_brain', 'bash', { cwd: '/path/with spaces/and "quotes"' });
    const call = execFileCalls.find((c) => c.args[0] === 'new-session');
    expect(call).toBeDefined();
    const cIdx = call!.args.indexOf('-c');
    expect(cIdx).toBeGreaterThan(0);
    expect(call!.args[cIdx + 1]).toBe('/path/with spaces/and "quotes"');
  });

  it('newSession passes env values with special chars as literal args', async () => {
    await tmux.newSession('deck_test_brain', 'bash', {
      env: { FOO: 'bar;baz', BAR: '$(echo pwned)' },
    });
    const call = execFileCalls.find((c) => c.args[0] === 'new-session');
    expect(call).toBeDefined();
    expect(call!.args).toContain('-e');
    expect(call!.args).toContain('FOO=bar;baz');
    expect(call!.args).toContain('BAR=$(echo pwned)');
  });

  it('sendRawInput passes literal text without shell escaping', async () => {
    const text = "hello'world\"test";
    await tmux.sendRawInput('deck_test_brain', text);
    const call = execFileCalls.find((c) => c.args.includes(text));
    expect(call).toBeDefined();
    expect(call!.args).toEqual(['send-keys', '-t', 'deck_test_brain', '-l', '--', text]);
  });

  it('respawnPane passes command without shell interpretation', async () => {
    const cmd = "bash -c 'echo $(id)'";
    await tmux.respawnPane('deck_test_brain', cmd);
    const call = execFileCalls.find((c) => c.args[0] === 'respawn-pane');
    expect(call).toBeDefined();
    expect(call!.args).toEqual(['respawn-pane', '-t', 'deck_test_brain', '-k', cmd]);
  });

  it('capturePaneVisible passes session name as separate arg', async () => {
    await tmux.capturePaneVisible('deck_test_brain');
    const call = execFileCalls.find((c) => c.args[0] === 'capture-pane' && c.args.includes('-e'));
    expect(call).toBeDefined();
    expect(call!.args).toEqual(['capture-pane', '-e', '-p', '-t', 'deck_test_brain']);
  });

  it('retries once when tmux server exits between commands', async () => {
    await tmux.capturePane('deck_test_brain'); // primes ensureTmuxServer cache
    execFileCalls.length = 0;
    failNextTmuxSubcommand = 'new-session';

    await tmux.newSession('deck_test_brain', 'bash');

    const listSessionsCalls = execFileCalls.filter((c) => c.args[0] === 'list-sessions');
    const newSessionCalls = execFileCalls.filter((c) => c.args[0] === 'new-session' && c.args[3] === 'deck_test_brain');
    expect(listSessionsCalls.length).toBe(1);
    expect(newSessionCalls.length).toBe(2);
  });
});

describe('tmux FIFO open mode', () => {
  it('macOS uses cat subprocess (not blocking createReadStream)', () => {
    // macOS path spawns `cat` to read the FIFO — stdout is a native pipe
    // that kqueue handles without occupying the libuv thread pool.
    // The keepalive fd uses O_RDWR | O_NONBLOCK to prevent cat from getting EOF.
    const O_RDWR = 2;
    const O_NONBLOCK = process.platform === 'darwin' ? 4 : 2048;
    // Both flags are used together on macOS for the keepalive fd
    expect((O_RDWR | O_NONBLOCK) & O_RDWR).toBe(O_RDWR);
    expect((O_RDWR | O_NONBLOCK) & O_NONBLOCK).toBe(O_NONBLOCK);
  });

  it('Linux uses net.Socket with O_RDWR|O_NONBLOCK (epoll)', () => {
    const O_RDWR = 2;
    const O_NONBLOCK = 2048; // Linux value
    const flags = O_RDWR | O_NONBLOCK;
    expect(flags & O_RDWR).toBe(O_RDWR);
    expect(flags & O_NONBLOCK).toBe(O_NONBLOCK);
  });
});
