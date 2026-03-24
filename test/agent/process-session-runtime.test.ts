import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProcessSessionRuntime } from '../../src/agent/process-session-runtime.js';
import { RUNTIME_TYPES } from '../../src/agent/session-runtime.js';

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/detect.js')>();
  return {
    ...actual,
    detectStatusAsync: vi.fn().mockResolvedValue('idle'),
  };
});

describe('ProcessSessionRuntime', () => {
  let runtime: ProcessSessionRuntime;
  let sendKeys: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let detectStatusAsync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const tmux = await import('../../src/agent/tmux.js');
    const detect = await import('../../src/agent/detect.js');
    sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    killSession = tmux.killSession as ReturnType<typeof vi.fn>;
    detectStatusAsync = detect.detectStatusAsync as ReturnType<typeof vi.fn>;
    runtime = new ProcessSessionRuntime('deck_myapp_brain', 'claude-code');
  });

  it('type property returns "process"', () => {
    expect(runtime.type).toBe(RUNTIME_TYPES.PROCESS);
    expect(runtime.type).toBe('process');
  });

  it('send() delegates to sendKeys with the correct session name', async () => {
    await runtime.send('hello world');
    expect(sendKeys).toHaveBeenCalledOnce();
    expect(sendKeys).toHaveBeenCalledWith('deck_myapp_brain', 'hello world');
  });

  it('send() passes the exact message string to sendKeys', async () => {
    const message = 'fix the bug in src/index.ts\n';
    await runtime.send(message);
    expect(sendKeys).toHaveBeenCalledWith('deck_myapp_brain', message);
  });

  it('kill() delegates to killSession with the correct session name', async () => {
    await runtime.kill();
    expect(killSession).toHaveBeenCalledOnce();
    expect(killSession).toHaveBeenCalledWith('deck_myapp_brain');
  });

  it('getStatus() returns "unknown" initially (cached status)', () => {
    expect(runtime.getStatus()).toBe('unknown');
  });

  it('updateStatus() updates the cached status', () => {
    runtime.updateStatus('idle');
    expect(runtime.getStatus()).toBe('idle');
  });

  it('updateStatus() reflects each new status value', () => {
    runtime.updateStatus('thinking');
    expect(runtime.getStatus()).toBe('thinking');

    runtime.updateStatus('streaming');
    expect(runtime.getStatus()).toBe('streaming');

    runtime.updateStatus('tool_running');
    expect(runtime.getStatus()).toBe('tool_running');
  });

  it('refreshStatus() calls detectStatusAsync with session name and agent type', async () => {
    await runtime.refreshStatus();
    expect(detectStatusAsync).toHaveBeenCalledOnce();
    expect(detectStatusAsync).toHaveBeenCalledWith('deck_myapp_brain', 'claude-code');
  });

  it('refreshStatus() returns the result from detectStatusAsync', async () => {
    detectStatusAsync.mockResolvedValue('streaming');
    const result = await runtime.refreshStatus();
    expect(result).toBe('streaming');
  });

  it('refreshStatus() updates the cached status', async () => {
    detectStatusAsync.mockResolvedValue('thinking');
    await runtime.refreshStatus();
    expect(runtime.getStatus()).toBe('thinking');
  });

  it('refreshStatus() result is reflected in subsequent getStatus() calls', async () => {
    detectStatusAsync.mockResolvedValue('tool_running');
    await runtime.refreshStatus();
    expect(runtime.getStatus()).toBe('tool_running');
  });

  it('uses the session name passed in constructor', async () => {
    const other = new ProcessSessionRuntime('deck_otherapp_w1', 'shell');
    await other.send('run tests');
    expect(sendKeys).toHaveBeenCalledWith('deck_otherapp_w1', 'run tests');
  });
});
