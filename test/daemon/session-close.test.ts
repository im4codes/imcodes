import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getPanePidsMock, execFileMock } = vi.hoisted(() => ({
  getPanePidsMock: vi.fn().mockResolvedValue([]),
  execFileMock: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  getPanePids: getPanePidsMock,
}));

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { closeSingleSession, collectProjectCloseTargets, killSessionProcesses } from '../../src/agent/session-close.js';
import type { SessionRecord } from '../../src/store/session-store.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'deck_proj_brain',
    projectName: 'proj',
    role: 'brain',
    agentType: 'claude-code',
    projectDir: '/proj',
    state: 'running',
    restarts: 0,
    restartTimestamps: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('closeSingleSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockImplementation((_file: string, _args: string[], _optsOrCb?: unknown, maybeCb?: unknown) => {
      const cb = typeof _optsOrCb === 'function'
        ? _optsOrCb as (err: Error | null, stdout?: string, stderr?: string) => void
        : maybeCb as ((err: Error | null, stdout?: string, stderr?: string) => void) | undefined;
      cb?.(null, '', '');
    });
  });

  it('isolates stage failures and does not emit success when verification fails', async () => {
    const callOrder: string[] = [];
    const result = await closeSingleSession(makeRecord(), {
      emitStopping: () => { callOrder.push('emitStopping'); },
      stopWatchers: () => {
        callOrder.push('stopWatchers');
        throw new Error('watcher cleanup failed');
      },
      stopTransportRuntime: () => { callOrder.push('stopTransportRuntime'); },
      killProcessRuntime: () => { callOrder.push('killProcessRuntime'); },
      verifyClosed: () => {
        callOrder.push('verifyClosed');
        throw new Error('tmux still alive');
      },
      emitSuccess: () => { callOrder.push('emitSuccess'); },
      persistSuccess: () => { callOrder.push('persistSuccess'); },
      emitFailure: () => { callOrder.push('emitFailure'); },
      persistFailure: () => { callOrder.push('persistFailure'); },
    });

    expect(result.ok).toBe(false);
    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([
      { sessionName: 'deck_proj_brain', stage: 'watchers', message: 'watcher cleanup failed' },
      { sessionName: 'deck_proj_brain', stage: 'verify', message: 'tmux still alive' },
    ]);
    expect(callOrder).toEqual([
      'emitStopping',
      'stopWatchers',
      'killProcessRuntime',
      'verifyClosed',
      'emitFailure',
      'persistFailure',
    ]);
  });

  it('does not emit success when persistence fails after close verification', async () => {
    const callOrder: string[] = [];
    const result = await closeSingleSession(makeRecord(), {
      emitStopping: () => { callOrder.push('emitStopping'); },
      stopWatchers: () => { callOrder.push('stopWatchers'); },
      stopTransportRuntime: () => { callOrder.push('stopTransportRuntime'); },
      killProcessRuntime: () => { callOrder.push('killProcessRuntime'); },
      verifyClosed: () => { callOrder.push('verifyClosed'); },
      persistSuccess: () => {
        callOrder.push('persistSuccess');
        throw new Error('db update failed');
      },
      emitSuccess: () => { callOrder.push('emitSuccess'); },
      emitFailure: () => { callOrder.push('emitFailure'); },
      persistFailure: () => { callOrder.push('persistFailure'); },
    });

    expect(result.ok).toBe(false);
    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([
      { sessionName: 'deck_proj_brain', stage: 'persist', message: 'db update failed' },
    ]);
    expect(callOrder).toEqual([
      'emitStopping',
      'stopWatchers',
      'killProcessRuntime',
      'verifyClosed',
      'persistSuccess',
      'emitFailure',
      'persistFailure',
    ]);
  });
});

describe('killSessionProcesses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockImplementation((_file: string, _args: string[], _optsOrCb?: unknown, maybeCb?: unknown) => {
      const cb = typeof _optsOrCb === 'function'
        ? _optsOrCb as (err: Error | null, stdout?: string, stderr?: string) => void
        : maybeCb as ((err: Error | null, stdout?: string, stderr?: string) => void) | undefined;
      cb?.(null, '', '');
    });
  });

  it('uses taskkill on Windows instead of pkill/kill', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    getPanePidsMock.mockResolvedValue(['4321']);

    try {
      await killSessionProcesses('deck_proj_brain');
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform });
    }

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '4321'],
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it('uses pkill and kill on non-Windows platforms', async () => {
    getPanePidsMock.mockResolvedValue(['1234']);

    await killSessionProcesses('deck_proj_brain');

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      'pkill',
      ['-9', '-P', '1234'],
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      'kill',
      ['-9', '1234'],
      expect.any(Function),
    );
  });
});

describe('collectProjectCloseTargets', () => {
  it('returns descendants before parents for project shutdown', () => {
    const targets = collectProjectCloseTargets('proj', [
      makeRecord({ name: 'deck_proj_brain' }),
      makeRecord({ name: 'deck_proj_w1', role: 'w1' }),
      makeRecord({ name: 'deck_sub_parent', projectName: 'deck_sub_parent', role: 'w1', parentSession: 'deck_proj_w1' }),
      makeRecord({ name: 'deck_sub_child', projectName: 'deck_sub_child', role: 'w1', parentSession: 'deck_sub_parent' }),
      makeRecord({ name: 'deck_other_brain', projectName: 'other' }),
    ]);

    expect(targets.map((target) => target.name)).toEqual([
      'deck_sub_child',
      'deck_sub_parent',
      'deck_proj_brain',
      'deck_proj_w1',
    ]);
  });
});
