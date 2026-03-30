import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

// Mock child_process before importing wezterm module
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

const execFileMock = vi.mocked(execFileCb);

// Helper to make execFile mock resolve with { stdout, stderr }
function mockExecFileResolves(stdout: string, stderr = ''): void {
  execFileMock.mockImplementation((...fnArgs: any[]) => {
    const cb = fnArgs.find((a: any) => typeof a === 'function');
    if (cb) cb(null, { stdout, stderr });
    return undefined as any;
  });
}

function mockExecFileRejectsOnce(error: Error): void {
  execFileMock.mockImplementationOnce((...fnArgs: any[]) => {
    const cb = fnArgs.find((a: any) => typeof a === 'function');
    if (cb) cb(error, { stdout: '', stderr: '' });
    return undefined as any;
  });
}

// We need to re-import the module fresh for each test to get clean state
let wezterm: typeof import('../../src/agent/wezterm.js');

beforeEach(async () => {
  vi.clearAllMocks();
  // Dynamic import with cache busting doesn't work in vitest — just import once
  // and rely on registerPane/unregisterPane to manage state
  wezterm = await import('../../src/agent/wezterm.js');
  // Clear any registered panes from previous tests
  // We do this by unregistering known test panes
});

afterEach(() => {
  // Clean up registered panes
  try { wezterm.unregisterPane('test_session'); } catch { /* */ }
  try { wezterm.unregisterPane('deck_proj_brain'); } catch { /* */ }
  try { wezterm.unregisterPane('deck_proj_w1'); } catch { /* */ }
});

describe('wezterm name→pane_id mapping', () => {
  it('registerPane stores and requirePaneId retrieves', () => {
    wezterm.registerPane('test_session', '42');
    expect(wezterm.requirePaneId('test_session')).toBe('42');
  });

  it('requirePaneId throws for unknown session', () => {
    expect(() => wezterm.requirePaneId('nonexistent')).toThrow('WezTerm pane_id not found');
  });

  it('unregisterPane removes the mapping', () => {
    wezterm.registerPane('test_session', '99');
    wezterm.unregisterPane('test_session');
    expect(() => wezterm.requirePaneId('test_session')).toThrow('WezTerm pane_id not found');
  });
});

describe('weztermNewSession', () => {
  it('calls wezterm cli spawn and registers pane_id', async () => {
    mockExecFileResolves('42\n');

    await wezterm.weztermNewSession('test_session', 'bash', { cwd: '/home/user/proj' });

    // Verify execFile was called with correct args
    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'spawn', '--cwd', '/home/user/proj', '--', 'bash'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );

    // Verify pane_id was registered
    expect(wezterm.requirePaneId('test_session')).toBe('42');
  });

  it('calls spawn without --cwd when not provided', async () => {
    mockExecFileResolves('55\n');

    await wezterm.weztermNewSession('test_session', 'bash');

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'spawn', '--', 'bash'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('calls spawn without command when not provided', async () => {
    mockExecFileResolves('77\n');

    await wezterm.weztermNewSession('test_session');

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'spawn'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});

describe('weztermKillSession', () => {
  it('calls wezterm cli kill-pane with the registered pane_id', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves('');

    await wezterm.weztermKillSession('test_session');

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'kill-pane', '--pane-id', '42'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );

    // Verify pane was unregistered
    expect(() => wezterm.requirePaneId('test_session')).toThrow();
  });

  it('is a no-op if session is not registered', async () => {
    await wezterm.weztermKillSession('nonexistent');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('weztermSessionExists', () => {
  it('returns true when pane_id is in wezterm list output', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([{ pane_id: 42 }, { pane_id: 99 }]));

    const exists = await wezterm.weztermSessionExists('test_session');
    expect(exists).toBe(true);
  });

  it('returns false when pane_id is not in wezterm list output', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([{ pane_id: 99 }]));

    const exists = await wezterm.weztermSessionExists('test_session');
    expect(exists).toBe(false);
  });

  it('returns false when session is not registered', async () => {
    const exists = await wezterm.weztermSessionExists('nonexistent');
    expect(exists).toBe(false);
    // Should not have called execFile
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('weztermListSessions', () => {
  it('returns only tracked sessions that exist in wezterm', async () => {
    wezterm.registerPane('deck_proj_brain', '10');
    wezterm.registerPane('deck_proj_w1', '20');
    mockExecFileResolves(JSON.stringify([{ pane_id: 10 }, { pane_id: 30 }]));

    const sessions = await wezterm.weztermListSessions();
    expect(sessions).toEqual(['deck_proj_brain']);
  });

  it('returns empty array on error', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileRejectsOnce(new Error('wezterm not running'));

    const sessions = await wezterm.weztermListSessions();
    expect(sessions).toEqual([]);
  });
});

describe('weztermSendText', () => {
  it('calls wezterm cli send-text with --no-paste', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves('');

    await wezterm.weztermSendText('test_session', 'hello world');

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'send-text', '--pane-id', '42', '--no-paste', '--', 'hello world'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it('throws if session is not registered', async () => {
    await expect(wezterm.weztermSendText('nonexistent', 'hello')).rejects.toThrow('WezTerm pane_id not found');
  });
});

describe('weztermSendEnter', () => {
  it('sends newline via send-text', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves('');

    await wezterm.weztermSendEnter('test_session');

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'send-text', '--pane-id', '42', '--no-paste', '--', '\n'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});

describe('weztermSendKey', () => {
  it('sends raw key bytes via send-text --no-paste', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves('');

    await wezterm.weztermSendKey('test_session', '\x03'); // Ctrl-C

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'send-text', '--pane-id', '42', '--no-paste', '--', '\x03'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});

describe('weztermCapturePane', () => {
  it('calls get-text and returns last N lines', async () => {
    wezterm.registerPane('test_session', '42');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    mockExecFileResolves(lines);

    const result = await wezterm.weztermCapturePane('test_session', 10);

    expect(execFileMock).toHaveBeenCalledWith(
      'wezterm',
      ['cli', 'get-text', '--pane-id', '42'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(result).toHaveLength(10);
    expect(result[0]).toBe('line 90');
  });
});

describe('weztermRespawnPane', () => {
  it('sends ctrl-c then the new command', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves('');

    // Can't easily test setTimeout timing, but we can verify the calls
    await wezterm.weztermRespawnPane('test_session', 'new-command');

    // First call: ctrl-c, then after delay: command + \r
    const calls = execFileMock.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // First call should be ctrl-c
    expect(calls[0][1]).toEqual(['cli', 'send-text', '--pane-id', '42', '--no-paste', '--', '\x03']);
  });
});

describe('weztermGetPaneCwd', () => {
  it('parses cwd from wezterm cli list JSON output', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([
      { pane_id: 42, cwd: 'file:///home/user/project' },
      { pane_id: 99, cwd: 'file:///home/user/other' },
    ]));

    const cwd = await wezterm.weztermGetPaneCwd('test_session');
    expect(cwd).toBe('file:///home/user/project');
  });

  it('returns empty string if pane not found in list', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([{ pane_id: 99, cwd: '/home/user' }]));

    const cwd = await wezterm.weztermGetPaneCwd('test_session');
    expect(cwd).toBe('');
  });
});

describe('weztermGetPaneId', () => {
  it('returns the registered pane_id', async () => {
    wezterm.registerPane('test_session', '42');
    const id = await wezterm.weztermGetPaneId('test_session');
    expect(id).toBe('42');
  });
});

describe('weztermIsPaneAlive', () => {
  it('returns true when pane is in list', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([{ pane_id: 42, is_active: true }]));

    expect(await wezterm.weztermIsPaneAlive('test_session')).toBe(true);
  });

  it('returns false when pane is not in list', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([{ pane_id: 99 }]));

    expect(await wezterm.weztermIsPaneAlive('test_session')).toBe(false);
  });

  it('returns false when session is not registered', async () => {
    expect(await wezterm.weztermIsPaneAlive('nonexistent')).toBe(false);
  });
});

describe('weztermGetPanePids', () => {
  it('returns pid from wezterm cli list JSON output', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([
      { pane_id: 42, pid: 12345 },
      { pane_id: 99, pid: 67890 },
    ]));

    const pids = await wezterm.weztermGetPanePids('test_session');
    expect(pids).toEqual(['12345']);
  });

  it('returns empty array when session not registered', async () => {
    const pids = await wezterm.weztermGetPanePids('nonexistent');
    expect(pids).toEqual([]);
  });

  it('returns empty array when pane has no pid', async () => {
    wezterm.registerPane('test_session', '42');
    mockExecFileResolves(JSON.stringify([{ pane_id: 42 }]));

    const pids = await wezterm.weztermGetPanePids('test_session');
    expect(pids).toEqual([]);
  });
});
