import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  sessionName: vi.fn((project: string, role: string) => `deck_${project}_${role}`),
  getTransportRuntime: vi.fn(),
}));

vi.mock('../../src/agent/detect.js', () => ({
  detectStatusAsync: vi.fn(),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: vi.fn(),
}));

const { timelineOn } = vi.hoisted(() => ({
  timelineOn: vi.fn(),
}));
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    on: timelineOn,
  },
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { executeCronJob } from '../../src/daemon/cron-executor.js';
import { getSession } from '../../src/store/session-store.js';
import { sessionName, getTransportRuntime } from '../../src/agent/session-manager.js';
import { detectStatusAsync } from '../../src/agent/detect.js';
import { sendKeys } from '../../src/agent/tmux.js';
import { startP2pRun } from '../../src/daemon/p2p-orchestrator.js';
import { CRON_MSG, type CronDispatchMessage } from '../../shared/cron-types.js';
import logger from '../../src/util/logger.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockServerLink = {
  send: vi.fn(),
  sendTimelineEvent: vi.fn(),
  daemonVersion: '0.1.0',
} as any;

function makeMsg(overrides: Partial<CronDispatchMessage> = {}): CronDispatchMessage {
  return {
    type: CRON_MSG.DISPATCH,
    jobId: 'job-1',
    jobName: 'nightly-review',
    serverId: 'srv-1',
    projectName: 'myapp',
    targetRole: 'brain',
    action: { type: 'command', command: 'review the codebase' },
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    name: 'deck_myapp_brain',
    agentType: 'claude-code',
    state: 'running',
    projectName: 'myapp',
    projectDir: '/home/user/myapp',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeCronJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (sessionName as ReturnType<typeof vi.fn>).mockImplementation(
      (project: string, role: string) => `deck_${project}_${role}`,
    );
    timelineOn.mockReturnValue(() => {});
  });

  // 1. Command to idle process session
  it('sends command to idle process session via sendKeys with cwd', async () => {
    const session = makeSession();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(session);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'review the codebase',
      { cwd: '/home/user/myapp' },
    );
  });

  // 2. Command to streaming session — skips (busy)
  it('skips command when session is streaming', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('streaming');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'streaming' }),
      expect.stringContaining('busy'),
    );
  });

  // 3. Command to thinking session — skips (busy)
  it('skips command when session is thinking', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('thinking');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 4. Command to tool_running session — skips (busy)
  it('skips command when session is tool_running', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('tool_running');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 5. Command to permission session — skips (busy)
  it('skips command when session is permission', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('permission');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 6. Command to idle session (unknown/failed status detection) — proceeds
  it('proceeds when status detection fails (unknown status)', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux gone'));

    await executeCronJob(makeMsg(), mockServerLink);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('status detection failed'),
    );
    expect(sendKeys).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'review the codebase',
      { cwd: '/home/user/myapp' },
    );
  });

  // 7. Command to error session — proceeds (recovery)
  it('proceeds when session status is error (recovery)', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('error');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'review the codebase',
      { cwd: '/home/user/myapp' },
    );
  });

  // 8. Command to nonexistent session — skips, logs warning
  it('skips when target session does not exist', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'deck_myapp_brain' }),
      expect.stringContaining('not found'),
    );
  });

  // 9. Invalid target role — skips, logs warning
  it('skips when target role is invalid', async () => {
    await executeCronJob(makeMsg({ targetRole: 'invalid_role' }), mockServerLink);

    expect(getSession).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ targetRole: 'invalid_role' }),
      expect.stringContaining('invalid target role'),
    );
  });

  // 10. Transport session — skips busy check, calls runtime.send()
  it('sends command to transport session via runtime.send(), skipping busy check', async () => {
    const mockRuntime = { send: vi.fn().mockResolvedValue(undefined) };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(detectStatusAsync).not.toHaveBeenCalled();
    expect(mockRuntime.send).toHaveBeenCalledWith('review the codebase');
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // 11. Transport session with disconnected provider — skips, logs warning
  it('skips when transport provider is not connected', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'deck_myapp_brain' }),
      expect.stringContaining('not connected'),
    );
  });

  // 12. Transport session send throws — logs error, doesn't crash
  it('logs error when transport send throws but does not crash', async () => {
    const sendError = new Error('provider timeout');
    const mockRuntime = { send: vi.fn().mockRejectedValue(sendError) };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    // Should not throw
    await executeCronJob(makeMsg(), mockServerLink);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: sendError }),
      expect.stringContaining('transport send failed'),
    );
  });

  // 13. P2P with valid participants — calls startP2pRun with correct targets
  it('starts P2P run with valid participants', async () => {
    const brainSession = makeSession();
    const w1Session = makeSession({ name: 'deck_myapp_w1' });
    const w2Session = makeSession({ name: 'deck_myapp_w2' });

    (getSession as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'deck_myapp_brain') return brainSession;
      if (name === 'deck_myapp_w1') return w1Session;
      if (name === 'deck_myapp_w2') return w2Session;
      return null;
    });
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'code review',
        mode: 'audit',
        participants: ['w1', 'w2'],
        rounds: 3,
      },
    });

    await executeCronJob(msg, mockServerLink);

    expect(startP2pRun).toHaveBeenCalledWith(
      'deck_myapp_brain',
      [
        { session: 'deck_myapp_w1', mode: 'audit' },
        { session: 'deck_myapp_w2', mode: 'audit' },
      ],
      'code review',
      [],
      mockServerLink,
      3,
    );
  });

  // 14. P2P with no valid participants — skips
  it('skips P2P when no valid participants exist', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'deck_myapp_brain') return makeSession();
      return null; // w3, w4 don't exist
    });
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'discussion',
        mode: 'brainstorm',
        participants: ['w3', 'w4'],
      },
    });

    await executeCronJob(msg, mockServerLink);

    expect(startP2pRun).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
      expect.stringContaining('no valid P2P participants'),
    );
  });

  // 15. Command handler routes cron.dispatch — verified by CRON_MSG constant
  it('uses CRON_MSG.DISPATCH constant for message type', () => {
    expect(CRON_MSG.DISPATCH).toBe('cron.dispatch');
  });

  // ── Additional edge cases ─────────────────────────────────────────────────

  it('accepts worker roles like w1, w2, w99', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession({ name: 'deck_myapp_w1' }));
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({ targetRole: 'w1' }), mockServerLink);

    expect(sessionName).toHaveBeenCalledWith('myapp', 'w1');
    expect(sendKeys).toHaveBeenCalled();
  });

  it('P2P defaults to 1 round when rounds is not specified', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'deck_myapp_brain') return makeSession();
      if (name === 'deck_myapp_w1') return makeSession({ name: 'deck_myapp_w1' });
      return null;
    });
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'quick sync',
        mode: 'review',
        participants: ['w1'],
        // rounds omitted
      },
    });

    await executeCronJob(msg, mockServerLink);

    expect(startP2pRun).toHaveBeenCalledWith(
      'deck_myapp_brain',
      [{ session: 'deck_myapp_w1', mode: 'review' }],
      'quick sync',
      [],
      mockServerLink,
      1,
    );
  });

  it('logs warning for unknown action type', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    const msg = makeMsg({
      action: { type: 'unknown' } as any,
    });

    await executeCronJob(msg, mockServerLink);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'unknown' }),
      expect.stringContaining('unknown action type'),
    );
  });

  // ── Sub-session targeting ──────────────────────────────────────────────

  it('sends command to sub-session when targetSessionName is set', async () => {
    const subSession = makeSession({ name: 'deck_sub_abc123', projectDir: '/home/user/myapp' });
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(subSession);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(
      makeMsg({ targetSessionName: 'deck_sub_abc123' }),
      mockServerLink,
    );

    // Should use targetSessionName directly, not construct via sessionName()
    expect(sessionName).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledWith('deck_sub_abc123');
    expect(sendKeys).toHaveBeenCalledWith(
      'deck_sub_abc123',
      'review the codebase',
      { cwd: '/home/user/myapp' },
    );
  });

  it('skips role validation when targetSessionName is set', async () => {
    const subSession = makeSession({ name: 'deck_sub_xyz' });
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(subSession);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    // targetRole is invalid, but targetSessionName takes precedence
    await executeCronJob(
      makeMsg({ targetRole: 'not_a_valid_role', targetSessionName: 'deck_sub_xyz' }),
      mockServerLink,
    );

    // Should NOT warn about invalid role — targetSessionName bypasses role validation
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetRole: 'not_a_valid_role' }),
      expect.stringContaining('invalid target role'),
    );
    expect(sendKeys).toHaveBeenCalled();
  });

  it('resolves sub-session P2P participants from participantEntries', async () => {
    const brainSession = makeSession();
    const subSession = makeSession({ name: 'deck_sub_worker1' });

    (getSession as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'deck_myapp_brain') return brainSession;
      if (name === 'deck_sub_worker1') return subSession;
      return null;
    });
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    const msg = makeMsg({
      action: {
        type: 'p2p',
        topic: 'architecture review',
        mode: 'review',
        participantEntries: [
          { type: 'session', value: 'deck_sub_worker1' },
        ],
      },
    });

    await executeCronJob(msg, mockServerLink);

    expect(startP2pRun).toHaveBeenCalledWith(
      'deck_myapp_brain',
      [{ session: 'deck_sub_worker1', mode: 'review' }],
      'architecture review',
      [],
      mockServerLink,
      1,
    );
  });

  it('sends command result with executionId when assistant output completes', async () => {
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({ executionId: 'exec-1' }), mockServerLink);

    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: 'done' } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-1',
      detail: 'done',
    });
  });

  it('retries command result send after a transient link failure', async () => {
    vi.useFakeTimers();
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');
    mockServerLink.send
      .mockImplementationOnce(() => { throw new Error('not connected'); })
      .mockImplementationOnce(() => undefined);

    await executeCronJob(makeMsg({ executionId: 'exec-2' }), mockServerLink);

    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: 'retry me' } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });

    expect(mockServerLink.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockServerLink.send).toHaveBeenCalledTimes(2);
    expect(mockServerLink.send).toHaveBeenLastCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-2',
      detail: 'retry me',
    });
    vi.useRealTimers();
  });

  it('reports skipped_busy back to the server', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('thinking');

    await executeCronJob(makeMsg({ executionId: 'exec-3' }), mockServerLink);

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-3',
      status: 'skipped_busy',
      detail: 'Cron target session is busy: deck_myapp_brain (thinking)',
    });
  });
});
