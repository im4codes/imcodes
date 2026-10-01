import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/store/session-store.js', () => ({
  getSession: vi.fn(),
  listSessions: vi.fn(),
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

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    on: vi.fn(() => () => {}),
    emit: vi.fn(),
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

import {
  __setCronSendDispatcherForTests,
  executeCronJob,
  type CronSendDispatchInput,
} from '../../src/daemon/cron-executor.js';
import { detectStatusAsync } from '../../src/agent/detect.js';
import { sendKeys } from '../../src/agent/tmux.js';
import { getSession, listSessions } from '../../src/store/session-store.js';
import { CRON_MSG, type CronDispatchMessage } from '../../shared/cron-types.js';

const mockServerLink = {
  send: vi.fn(),
  sendTimelineEvent: vi.fn(),
  daemonVersion: '0.1.0',
} as any;

function makeSession() {
  return {
    name: 'deck_myapp_brain',
    agentType: 'claude-code',
    state: 'running',
    projectName: 'myapp',
    projectDir: '/home/user/myapp',
  };
}

function makeSendMsg(): CronDispatchMessage {
  return {
    type: CRON_MSG.DISPATCH,
    jobId: 'job-send',
    executionId: 'exec-send',
    jobName: 'send-review',
    serverId: 'srv-1',
    projectName: 'myapp',
    targetRole: 'brain',
    action: {
      type: 'send',
      target: 'w1',
      message: 'please review this',
      reply: true,
      idempotencyKey: 'idem-1',
    },
  };
}

describe('executeCronJob structured send actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setCronSendDispatcherForTests(null);
    (getSession as ReturnType<typeof vi.fn>).mockReturnValue(makeSession());
    (listSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      makeSession(),
      { ...makeSession(), name: 'deck_myapp_w1', role: 'w1', label: 'Coder' },
    ]);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValue('idle');
  });

  it('dispatches send actions through the structured send dispatcher and reports ids', async () => {
    const dispatchCronSend = vi.fn(async (_input: CronSendDispatchInput) => ({
      dispatchId: 'send_dispatch_1',
      status: 'dispatched' as const,
      deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_1', status: 'delivered' as const }],
    }));
    __setCronSendDispatcherForTests(dispatchCronSend);

    await executeCronJob(makeSendMsg(), mockServerLink);

    expect(dispatchCronSend).toHaveBeenCalledWith({
      fromSessionName: 'deck_myapp_brain',
      target: 'w1',
      message: 'please review this',
      reply: true,
      idempotencyKey: 'idem-1',
    });
    expect(sendKeys).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-send',
      executionId: 'exec-send',
      status: 'dispatched',
      detail: JSON.stringify({
        dispatchId: 'send_dispatch_1',
        deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_1', status: 'delivered' }],
      }),
    });
  });

  it('reports partial structured send delivery results to cron history', async () => {
    const dispatchCronSend = vi.fn(async (_input: CronSendDispatchInput) => ({
      dispatchId: 'send_dispatch_partial',
      status: 'partial' as const,
      deliveries: [
        { target: 'deck_myapp_w1', messageId: 'send_message_1', status: 'delivered' as const },
        { target: 'deck_myapp_w2', status: 'failed' as const, error: 'transport failed' },
      ],
    }));
    __setCronSendDispatcherForTests(dispatchCronSend);

    await executeCronJob(makeSendMsg(), mockServerLink);

    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-send',
      executionId: 'exec-send',
      status: 'partial',
      detail: JSON.stringify({
        dispatchId: 'send_dispatch_partial',
        deliveries: [
          { target: 'deck_myapp_w1', messageId: 'send_message_1', status: 'delivered' },
          { target: 'deck_myapp_w2', status: 'failed', error: 'transport failed' },
        ],
      }),
    });
  });

  it('does not compile send actions into command strings when dispatcher is unavailable', async () => {
    await executeCronJob(makeSendMsg(), mockServerLink);

    expect(sendKeys).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-send',
      executionId: 'exec-send',
      status: 'error',
      detail: expect.stringContaining('Cron structured send failed'),
    });
  });

  it('skips an idle-only send when the recipient is busy without invoking the dispatcher', async () => {
    const dispatchCronSend = vi.fn();
    __setCronSendDispatcherForTests(dispatchCronSend);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => (
      name === 'deck_myapp_brain' ? 'idle' : 'streaming'
    ));

    await executeCronJob({
      ...makeSendMsg(),
      action: { ...makeSendMsg().action, onlyWhenIdle: true },
    }, mockServerLink);

    expect(dispatchCronSend).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenCalledWith({
      type: CRON_MSG.COMMAND_RESULT,
      jobId: 'job-send',
      executionId: 'exec-send',
      status: 'skipped_busy',
      detail: 'Cron idle-only recipient is busy: deck_myapp_w1 (streaming)',
    });
  });

  it('re-evaluates an idle-only recipient on the next occurrence after it becomes idle', async () => {
    const dispatchCronSend = vi.fn(async (_input: CronSendDispatchInput) => ({
      dispatchId: 'send_dispatch_idle',
      status: 'dispatched' as const,
      deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_idle', status: 'delivered' as const }],
    }));
    __setCronSendDispatcherForTests(dispatchCronSend);
    (detectStatusAsync as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('streaming')
      .mockResolvedValue('idle');

    const msg = {
      ...makeSendMsg(),
      action: { ...makeSendMsg().action, onlyWhenIdle: true },
    };
    await executeCronJob(msg, mockServerLink);
    expect(dispatchCronSend).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({
      type: CRON_MSG.COMMAND_RESULT,
      status: 'skipped_busy',
    }));

    await executeCronJob(msg, mockServerLink);

    expect(dispatchCronSend).toHaveBeenCalledTimes(1);
    expect(dispatchCronSend).toHaveBeenCalledWith(expect.objectContaining({
      target: 'w1',
      message: 'please review this',
    }));
    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: CRON_MSG.COMMAND_RESULT,
      status: 'dispatched',
    }));
  });

  it('preserves ordinary structured-send behavior when onlyWhenIdle is omitted', async () => {
    const dispatchCronSend = vi.fn(async (_input: CronSendDispatchInput) => ({
      dispatchId: 'send_dispatch_default',
      status: 'dispatched' as const,
      deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_default', status: 'delivered' as const }],
    }));
    __setCronSendDispatcherForTests(dispatchCronSend);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => (
      name === 'deck_myapp_brain' ? 'idle' : 'streaming'
    ));

    await executeCronJob(makeSendMsg(), mockServerLink);

    expect(dispatchCronSend).toHaveBeenCalledTimes(1);
  });
});
