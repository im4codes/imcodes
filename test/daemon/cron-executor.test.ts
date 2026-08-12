import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  sessionName: vi.fn((project: string, role: string) => `deck_${project}_${role}`),
  getTransportRuntime: vi.fn(),
  ensureTransportRuntimeAvailable: vi.fn(),
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

const { timelineOn, timelineEmit } = vi.hoisted(() => ({
  timelineOn: vi.fn(),
  timelineEmit: vi.fn(),
}));
const cronProcessSendMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    on: timelineOn,
    emit: timelineEmit,
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

import { __setCronProcessCommandSenderForTests, executeCronJob } from '../../src/daemon/cron-executor.js';
import { getSession } from '../../src/store/session-store.js';
import {
  ensureTransportRuntimeAvailable,
  getTransportRuntime,
  sessionName,
} from '../../src/agent/session-manager.js';
import { detectStatusAsync } from '../../src/agent/detect.js';
import { sendKeys } from '../../src/agent/tmux.js';
import { startP2pRun } from '../../src/daemon/p2p-orchestrator.js';
import { CRON_COMPLETION_POLICY, CRON_MSG, type CronDispatchMessage } from '../../shared/cron-types.js';
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
    (ensureTransportRuntimeAvailable as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
    __setCronProcessCommandSenderForTests(cronProcessSendMock);
  });

  // 1. Command to idle process session
  it('routes an idle process cron command through the common process send boundary', async () => {
    const session = makeSession();
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(session);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(cronProcessSendMock).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'review the codebase',
    );
    expect(sendKeys).not.toHaveBeenCalled();
  });

  it('reports a process session send failure instead of leaving the cron execution unresolved', async () => {
    const sendError = new Error('tmux write failed');
    cronProcessSendMock.mockRejectedValueOnce(sendError);
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await expect(executeCronJob(makeMsg({ executionId: 'exec-process-failure' }), mockServerLink))
      .resolves.toBeUndefined();

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-process-failure',
      status: 'error',
      detail: 'Cron process session send failed for deck_myapp_brain: tmux write failed',
    });
    expect(logger.error).toHaveBeenCalledWith(
      { jobId: 'job-1', sessionName: 'deck_myapp_brain', error: sendError },
      'Cron: process session send failed',
    );
  });

  it('injects only the self-management id and lifecycle rule into agent wake-up prompts', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({
      jobId: 'job-progress-1',
      jobName: 'Check implementation progress',
      cronExpr: '*/10 * * * *',
      timezone: 'Asia/Shanghai',
      expiresAt: Date.parse('2026-07-12T00:00:00Z'),
      action: { type: 'command', command: 'Inspect the current progress.', selfManaged: true },
    }), mockServerLink);

    const prompt = cronProcessSendMock.mock.calls[0][1] as string;
    expect(prompt).toContain('Inspect the current progress.\n\n<imcodes-cron-control id="job-progress-1" completion-policy="recurring">');
    expect(prompt).toContain('Do not add web fetches, curl requests, or other network checks unless the task explicitly requests them.');
    expect(prompt).toContain('If an explicitly requested tool returns SILENT as its first non-empty line, stop immediately, call no more tools, and finish this occurrence with exactly SILENT.');
    expect(prompt).toContain('Always produce one final response for this occurrence.');
  });

  it('allows an until-complete schedule to self-cancel only after its overall goal completes', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({
      jobId: 'job-bounded-1',
      completionPolicy: CRON_COMPLETION_POLICY.UNTIL_COMPLETE,
      action: { type: 'command', command: 'Keep working toward the release.', selfManaged: true },
    }), mockServerLink);

    expect(cronProcessSendMock.mock.calls[0][1]).toContain(
      'Call cron_cancel_self with this id only when the overall goal—not merely this occurrence—is complete.',
    );
    expect(cronProcessSendMock.mock.calls[0][1]).not.toContain('force=true');
  });

  it.each(['shell', 'script'] as const)('does not inject MCP controls into %s commands', async (agentType) => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession({ agentType }));
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({
      jobId: 'job-raw-1',
      action: { type: 'command', command: 'printf ready', selfManaged: true },
    }), mockServerLink);

    expect(cronProcessSendMock).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'printf ready',
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
    expect(cronProcessSendMock).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'review the codebase',
    );
  });

  // 7. Command to error session — proceeds (recovery)
  it('proceeds when session status is error (recovery)', async () => {
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('error');

    await executeCronJob(makeMsg(), mockServerLink);

    expect(cronProcessSendMock).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'review the codebase',
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
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      send: vi.fn().mockReturnValue('sent'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(detectStatusAsync).not.toHaveBeenCalled();
    expect(mockRuntime.send).toHaveBeenCalledWith('review the codebase', 'cron:job-1:dispatch:attempt:1');
    expect(typeof mockRuntime.send.mock.calls[0][0]).toBe('string');
    expect(sendKeys).not.toHaveBeenCalled();
    expect(timelineEmit).toHaveBeenCalledWith(
      'deck_myapp_brain',
      'user.message',
      { text: 'review the codebase', allowDuplicate: true },
    );
  });

  it('does not emit a user.message when a transport cron command is only queued', async () => {
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      send: vi.fn().mockReturnValue('queued'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(mockRuntime.send).toHaveBeenCalledWith('review the codebase', 'cron:job-1:dispatch:attempt:1');
    expect(timelineEmit).not.toHaveBeenCalledWith(
      'deck_myapp_brain',
      'user.message',
      expect.anything(),
    );
  });

  it('retries a recoverable transport failure after one minute only when no tool ran', async () => {
    vi.useFakeTimers();
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      getStatus: vi.fn(() => 'idle'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockReturnValue('sent'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg({ executionId: 'exec-retry-safe' }), mockServerLink);
    handler?.({
      sessionId: 'deck_myapp_brain',
      type: 'assistant.text',
      payload: {
        text: '⚠️ OpenCode was unresponsive and was automatically recovered.',
        providerErrorCode: 'CANCELLED',
        providerErrorRecoverable: true,
      },
    });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });

    expect(mockServerLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: CRON_MSG.COMMAND_RESULT,
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRuntime.send).toHaveBeenNthCalledWith(
      2,
      'review the codebase',
      'cron:job-1:exec-retry-safe:attempt:2',
    );
    expect(mockRuntime.cancel).not.toHaveBeenCalled();

    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: 'done after retry' } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-retry-safe',
      detail: 'done after retry',
    });
    vi.useRealTimers();
  });

  it('does not replay a recoverable cron failure after tool side effects', async () => {
    vi.useFakeTimers();
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      getStatus: vi.fn(() => 'idle'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockReturnValue('sent'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg({ executionId: 'exec-no-duplicate' }), mockServerLink);
    handler?.({ sessionId: 'deck_myapp_brain', type: 'tool.result', payload: { output: 'side effect complete' } });
    handler?.({
      sessionId: 'deck_myapp_brain',
      type: 'assistant.text',
      payload: {
        text: '⚠️ Error: fetch failed',
        providerErrorCode: 'CONNECTION_LOST',
        providerErrorRecoverable: true,
      },
    });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-no-duplicate',
      status: 'error',
      detail: '⚠️ Error: fetch failed',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRuntime.send).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('subscribes before transport dispatch so an immediate result is not lost', async () => {
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      getStatus: vi.fn(() => 'idle'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn(() => {
        handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: 'immediate result' } });
        handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });
        return 'sent';
      }),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg({ executionId: 'exec-immediate' }), mockServerLink);

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-immediate',
      detail: 'immediate result',
    });
  });

  it('stops after three side-effect-free timed-out attempts and reports the timeout', async () => {
    vi.useFakeTimers();
    timelineOn.mockImplementation(() => () => {});
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      getStatus: vi.fn(() => 'idle'),
      cancel: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockReturnValue('sent'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(mockRuntime);

    await executeCronJob(makeMsg({ executionId: 'exec-timeout-budget' }), mockServerLink);
    await vi.advanceTimersByTimeAsync(13 * 60_000 + 60_000);
    await vi.advanceTimersByTimeAsync(13 * 60_000 + 60_000);
    await vi.advanceTimersByTimeAsync(13 * 60_000);

    expect(mockRuntime.send).toHaveBeenCalledTimes(3);
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-timeout-budget',
      status: 'error',
      detail: 'Cron command timed out waiting for response from deck_myapp_brain',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRuntime.send).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  // 11. Missing transport runtime — restores exact session before sending
  it('restores a missing transport runtime before sending the cron command', async () => {
    const mockRuntime = {
      providerSessionId: 'restored-provider-session',
      send: vi.fn().mockReturnValue('sent'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (ensureTransportRuntimeAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(mockRuntime);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(ensureTransportRuntimeAvailable).toHaveBeenCalledOnce();
    expect(ensureTransportRuntimeAvailable).toHaveBeenCalledWith('deck_myapp_brain');
    expect(mockRuntime.send).toHaveBeenCalledOnce();
    expect(mockRuntime.send).toHaveBeenCalledWith('review the codebase', 'cron:job-1:dispatch:attempt:1');
    expect(sendKeys).not.toHaveBeenCalled();
    expect(mockServerLink.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: CRON_MSG.COMMAND_RESULT,
      status: 'error',
    }));
  });

  it('replaces an unbound transport runtime before sending the cron command', async () => {
    const unboundRuntime = { send: vi.fn().mockReturnValue('sent') };
    const restoredRuntime = {
      providerSessionId: 'restored-provider-session',
      send: vi.fn().mockReturnValue('sent'),
    };
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(unboundRuntime);
    (ensureTransportRuntimeAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(restoredRuntime);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(ensureTransportRuntimeAvailable).toHaveBeenCalledWith('deck_myapp_brain');
    expect(unboundRuntime.send).not.toHaveBeenCalled();
    expect(restoredRuntime.send).toHaveBeenCalledOnce();
    expect(restoredRuntime.send).toHaveBeenCalledWith('review the codebase', 'cron:job-1:dispatch:attempt:1');
  });

  it('reports an error only after on-demand transport recovery fails', async () => {
    const restoreError = new Error('provider restart failed');
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(
      makeSession({ runtimeType: 'transport', agentType: 'opencode-sdk' }),
    );
    (getTransportRuntime as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (ensureTransportRuntimeAvailable as ReturnType<typeof vi.fn>).mockRejectedValue(restoreError);

    await executeCronJob(makeMsg(), mockServerLink);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionName: 'deck_myapp_brain', err: restoreError }),
      expect.stringContaining('runtime restore failed'),
    );
    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: CRON_MSG.COMMAND_RESULT,
      status: 'error',
      detail: expect.stringContaining('provider restart failed'),
    }));
  });

  // 12. Transport session send throws — logs error, doesn't crash
  it('logs error when transport send throws but does not crash', async () => {
    const sendError = new Error('provider timeout');
    const mockRuntime = {
      providerSessionId: 'connected-provider-session',
      send: vi.fn().mockRejectedValue(sendError),
    };
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

    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    expect(startP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_myapp_brain',
      targets: [
        { session: 'deck_myapp_w1', mode: 'audit' },
        { session: 'deck_myapp_w2', mode: 'audit' },
      ],
      userText: 'code review',
      fileContents: [],
      serverLink: mockServerLink,
      rounds: 3,
      launchOrigin: expect.objectContaining({
        kind: 'cron',
        cronJobId: 'job-1',
      }),
    }));
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
    expect(cronProcessSendMock).toHaveBeenCalled();
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

    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    expect(startP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_myapp_brain',
      targets: [{ session: 'deck_myapp_w1', mode: 'review' }],
      userText: 'quick sync',
      fileContents: [],
      serverLink: mockServerLink,
      rounds: 1,
      launchOrigin: expect.objectContaining({
        kind: 'cron',
        cronJobId: 'job-1',
      }),
    }));
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
    expect(cronProcessSendMock).toHaveBeenCalledWith(
      'deck_sub_abc123',
      'review the codebase',
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
    expect(cronProcessSendMock).toHaveBeenCalled();
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

    expect((startP2pRun as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(1);
    expect(startP2pRun).toHaveBeenCalledWith(expect.objectContaining({
      initiatorSession: 'deck_myapp_brain',
      targets: [{ session: 'deck_sub_worker1', mode: 'review' }],
      userText: 'architecture review',
      fileContents: [],
      serverLink: mockServerLink,
      rounds: 1,
    }));
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

  it('records only the final assistant text instead of every streaming update', async () => {
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({ executionId: 'exec-final-text' }), mockServerLink);

    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: '主', streaming: true } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: '主人，', streaming: true } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: '主人，最终结果。', streaming: false } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-1',
      executionId: 'exec-final-text',
      detail: '主人，最终结果。',
    });
  });

  it('falls back to the latest snapshot when an older provider goes idle without a terminal text event', async () => {
    let handler: ((event: any) => void) | undefined;
    timelineOn.mockImplementation((fn: (event: any) => void) => {
      handler = fn;
      return () => {};
    });
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');

    await executeCronJob(makeMsg({ executionId: 'exec-latest-snapshot' }), mockServerLink);

    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: 'partial', streaming: true } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'assistant.text', payload: { text: 'complete snapshot', streaming: true } });
    handler?.({ sessionId: 'deck_myapp_brain', type: 'session.state', payload: { state: 'idle' } });

    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-latest-snapshot',
      detail: 'complete snapshot',
    }));
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
