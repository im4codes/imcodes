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
  __setCronExactSelfSenderForTests,
  __setCronSendDispatcherForTests,
  executeCronJob,
  type CronSendDispatchInput,
} from '../../src/daemon/cron-executor.js';
import { detectStatusAsync } from '../../src/agent/detect.js';
import { sendKeys } from '../../src/agent/tmux.js';
import { getSession, listSessions } from '../../src/store/session-store.js';
import { CRON_MSG, type CronDispatchMessage } from '../../shared/cron-types.js';
import { OWNER_MACHINE_AUTHORITY_FIELD, SHARED_MACHINE_AUTHORITY_FIELD } from '../../shared/shared-machine-authority.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import { resetTransportQueueStoreForTests } from '../../src/daemon/transport-queue-store.js';

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
    cronExpr: '0 9 * * *',
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
    resetTransportQueueStoreForTests();
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

    await executeCronJob({ ...msg, executionId: 'exec-send-2' }, mockServerLink);

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

  it('defaults daily structured sends to skip busy recipients', async () => {
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

    expect(dispatchCronSend).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'skipped_busy' }));
  });

  it('defensively defaults omitted idle-only policy for a short schedule', async () => {
    const dispatchCronSend = vi.fn();
    __setCronSendDispatcherForTests(dispatchCronSend);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => (
      name === 'deck_myapp_brain' ? 'idle' : 'streaming'
    ));

    await executeCronJob({
      ...makeSendMsg(),
      cronExpr: '*/10 * * * *',
      action: { ...makeSendMsg().action },
    }, mockServerLink);

    expect(dispatchCronSend).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'skipped_busy' }));
  });

  it('lets explicit false override the short-schedule default', async () => {
    const dispatchCronSend = vi.fn(async () => ({
      dispatchId: 'send_dispatch_override',
      status: 'dispatched' as const,
      deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_override', status: 'delivered' as const }],
    }));
    __setCronSendDispatcherForTests(dispatchCronSend);
    (detectStatusAsync as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => (
      name === 'deck_myapp_brain' ? 'idle' : 'streaming'
    ));

    await executeCronJob({
      ...makeSendMsg(),
      cronExpr: '*/10 * * * *',
      action: { ...makeSendMsg().action, onlyWhenIdle: false },
    }, mockServerLink);

    expect(dispatchCronSend).toHaveBeenCalledTimes(1);
  });

  it('replays after a simulated daemon restart without duplicating an idempotent delivery', async () => {
    const delivered = new Set<string>();
    const dispatchCronSend = vi.fn(async (input: CronSendDispatchInput) => {
      const key = input.idempotencyKey ?? '';
      if (delivered.has(key)) {
        return { dispatchId: 'send_dispatch_replay', status: 'dispatched' as const, deliveries: [] };
      }
      delivered.add(key);
      return {
        dispatchId: 'send_dispatch_once',
        status: 'dispatched' as const,
        deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_once', status: 'delivered' as const }],
      };
    });
    __setCronSendDispatcherForTests(dispatchCronSend);
    const msg = { ...makeSendMsg(), executionId: 'exec-send-busy', action: { ...makeSendMsg().action, onlyWhenIdle: true } };

    (detectStatusAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce('streaming').mockResolvedValue('idle');
    await executeCronJob(msg, mockServerLink); // busy occurrence is skipped
    expect(dispatchCronSend).not.toHaveBeenCalled();

    // Recreate the dispatcher as a fresh daemon process would, while retaining
    // the durable idempotency key in the request contract.
    __setCronSendDispatcherForTests(dispatchCronSend);
    const deliveredMsg = { ...msg, executionId: 'exec-send-2' };
    await executeCronJob(deliveredMsg, mockServerLink);
    await executeCronJob(deliveredMsg, mockServerLink);
    expect(dispatchCronSend).toHaveBeenCalledTimes(1);
    expect(dispatchCronSend.mock.calls.map((call) => call[0].idempotencyKey)).toEqual(['idem-1']);
    expect(delivered).toEqual(new Set(['idem-1']));
  });

  it('ignores a retry after the action was delivered but the result acknowledgement failed', async () => {
    let sideEffects = 0;
    const dispatchCronSend = vi.fn(async () => {
      sideEffects += 1;
      throw new Error('server link lost after delivery');
    });
    __setCronSendDispatcherForTests(dispatchCronSend);
    const msg = { ...makeSendMsg(), executionId: 'exec-post-delivery-crash' };

    await executeCronJob(msg, mockServerLink);
    // A server restart retries the same durable outbox execution id. The
    // daemon ledger must suppress the second action, not invoke the send path.
    await executeCronJob(msg, mockServerLink);

    expect(sideEffects).toBe(1);
    expect(dispatchCronSend).toHaveBeenCalledOnce();
    expect(mockServerLink.send).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-post-delivery-crash',
      status: 'dispatched',
      detail: 'Cron execution already accepted; duplicate dispatch ignored',
    }));
  });

  it('preserves ordinary missing and stopped-recipient handling', async () => {
    const dispatchCronSend = vi.fn(async () => ({
      dispatchId: 'send_dispatch_boundary', status: 'dispatched' as const, deliveries: [],
    }));
    __setCronSendDispatcherForTests(dispatchCronSend);
    (listSessions as ReturnType<typeof vi.fn>).mockReturnValue([makeSession()]);
    await executeCronJob({ ...makeSendMsg(), executionId: 'exec-send-missing', action: { ...makeSendMsg().action, onlyWhenIdle: true } }, mockServerLink);
    expect(dispatchCronSend).toHaveBeenCalledTimes(1);

    (listSessions as ReturnType<typeof vi.fn>).mockReturnValue([
      makeSession(), { ...makeSession(), name: 'deck_myapp_w1', role: 'w1', state: 'stopped' },
    ]);
    await executeCronJob({ ...makeSendMsg(), executionId: 'exec-send-stopped', action: { ...makeSendMsg().action, onlyWhenIdle: true } }, mockServerLink);
    expect(dispatchCronSend).toHaveBeenCalledTimes(2);
  });

  it('enforces exactTargetSessionName at daemon delivery: routes authorized self-send without fuzzy label/type fallback and binds cross-session exact target', async () => {
    const { dispatchCronSend: realDispatchCronSend } = await import('../../src/daemon/send-tool.js');
    const exactSelfSender = vi.fn(async () => 'sent' as const);
    const exactCrossDispatchMessage = vi.fn(async () => 'sent' as const);

    const subAllowed = {
      name: 'deck_sub_allowed1',
      agentType: 'codex-sdk',
      state: 'idle',
      projectName: 'myapp',
      projectDir: '/home/user/myapp',
      parentSession: 'deck_myapp_brain',
      label: 'Allowed Sub',
    };
    const decoyWorker = {
      name: 'deck_myapp_w1',
      agentType: 'deck_sub_allowed1',
      state: 'idle',
      projectName: 'myapp',
      projectDir: '/home/user/myapp',
      role: 'w1',
      label: 'deck_sub_allowed1',
    };
    const decoyW2 = {
      name: 'deck_myapp_w2',
      agentType: 'claude-code',
      state: 'idle',
      projectName: 'myapp',
      projectDir: '/home/user/myapp',
      role: 'w2',
      label: 'deck_myapp_w1',
    };
    const sessions = [makeSession(), subAllowed, decoyWorker, decoyW2];

    (getSession as ReturnType<typeof vi.fn>).mockImplementation((n: string) => sessions.find((s) => s.name === n));
    (listSessions as ReturnType<typeof vi.fn>).mockReturnValue(sessions);

    __setCronExactSelfSenderForTests(exactSelfSender);
    __setCronSendDispatcherForTests((input) => realDispatchCronSend(input, {
      listSessions: () => listSessions() as any,
      getSession: (n) => getSession(n) as any,
      dispatchMessage: exactCrossDispatchMessage,
    }));

    // 1) Self-delivery on subsession even when decoy shares identical label & agentType -> delivers ONLY to deck_sub_allowed1
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-exact-self',
      targetSessionName: 'deck_sub_allowed1',
      exactTargetSessionName: 'deck_sub_allowed1',
      action: { type: 'send', target: 'deck_sub_allowed1', message: 'self check' },
    }, mockServerLink);

    expect(exactSelfSender).toHaveBeenCalledTimes(1);
    expect((exactSelfSender.mock.calls[0] as any)?.[0]?.name).toBe('deck_sub_allowed1');
    expect(exactCrossDispatchMessage).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({
      executionId: 'exec-exact-self',
      status: 'dispatched',
    }));

    // 2) Cross-session exact delivery with label trap: decoyW2 has label === 'deck_myapp_w1', real deck_myapp_w1 is delivered
    exactSelfSender.mockClear();
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-exact-cross',
      exactTargetSessionName: 'deck_myapp_w1',
      action: { type: 'send', target: 'deck_myapp_w1', message: 'exact sibling', onlyWhenIdle: false },
    }, mockServerLink);

    expect(exactCrossDispatchMessage).toHaveBeenCalledTimes(1);
    expect((exactCrossDispatchMessage.mock.calls[0] as any)?.[0]?.name).toBe('deck_myapp_w1');

    // 3) Missing exact target when decoy has label === target -> MUST fail closed, ZERO fuzzy delivery to decoy
    exactCrossDispatchMessage.mockClear();
    const sessionsWithoutW1 = [makeSession(), decoyW2];
    (getSession as ReturnType<typeof vi.fn>).mockImplementation((n: string) => sessionsWithoutW1.find((s) => s.name === n));
    (listSessions as ReturnType<typeof vi.fn>).mockReturnValue(sessionsWithoutW1);

    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-exact-missing-decoy',
      exactTargetSessionName: 'deck_myapp_w1',
      action: { type: 'send', target: 'deck_myapp_w1', message: 'must fail closed', onlyWhenIdle: false },
    }, mockServerLink);

    expect(exactCrossDispatchMessage).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({
      executionId: 'exec-exact-missing-decoy',
      status: 'error',
    }));

    // 4) Broadcast or target mismatch on exact-scoped cron -> fail closed, ZERO deliveries
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-exact-bcast',
      exactTargetSessionName: 'deck_sub_allowed1',
      action: { type: 'send', target: 'deck_sub_allowed1', message: 'no bcast', broadcast: true },
    }, mockServerLink);
    expect(exactSelfSender).not.toHaveBeenCalled();
    expect(exactCrossDispatchMessage).not.toHaveBeenCalled();
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({
      executionId: 'exec-exact-bcast',
      status: 'error',
    }));

    __setCronExactSelfSenderForTests(null);
  });

  it('preserves normal sibling and broadcast sends for whole-server crons even when targetSessionName is set without ownerMachineAuthority', async () => {
    const { dispatchCronSend: realDispatchCronSend } = await import('../../src/daemon/send-tool.js');
    const exactSelfSender = vi.fn(async () => 'sent' as const);
    const dispatchMessage = vi.fn(async () => 'sent' as const);

    const execSub = {
      name: 'deck_sub_exec1',
      agentType: 'codex-sdk',
      state: 'idle',
      projectName: 'myapp',
      projectDir: '/home/user/myapp',
      parentSession: 'deck_myapp_brain',
    };
    const w1 = {
      name: 'deck_myapp_w1',
      agentType: 'claude-code',
      state: 'idle',
      projectName: 'myapp',
      projectDir: '/home/user/myapp',
      role: 'w1',
      label: 'Worker 1',
    };
    const w2 = {
      name: 'deck_myapp_w2',
      agentType: 'claude-code',
      state: 'idle',
      projectName: 'myapp',
      projectDir: '/home/user/myapp',
      role: 'w2',
      label: 'Worker 2',
    };
    const sessions = [makeSession(), execSub, w1, w2];
    (getSession as ReturnType<typeof vi.fn>).mockImplementation((n: string) => sessions.find((s) => s.name === n));
    (listSessions as ReturnType<typeof vi.fn>).mockReturnValue(sessions);

    __setCronExactSelfSenderForTests(exactSelfSender);
    __setCronSendDispatcherForTests((input) => realDispatchCronSend(input, {
      listSessions: () => listSessions() as any,
      getSession: (n) => getSession(n) as any,
      dispatchMessage,
    }));

    // 1) Whole-server cron with explicit execution targetSessionName & NO ownerMachineAuthority sends to another sibling
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-whole-srv-sibling',
      targetSessionName: 'deck_sub_exec1',
      action: { type: 'send', target: 'deck_myapp_w2', message: 'ping w2', onlyWhenIdle: false },
    }, mockServerLink);

    expect(exactSelfSender).not.toHaveBeenCalled();
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    expect((dispatchMessage.mock.calls[0] as any)?.[0]?.name).toBe('deck_myapp_w2');
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({
      executionId: 'exec-whole-srv-sibling',
      status: 'dispatched',
    }));

    // 2) Whole-server cron with explicit targetSessionName & NO ownerMachineAuthority can still broadcast
    dispatchMessage.mockClear();
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-whole-srv-bcast',
      targetSessionName: 'deck_sub_exec1',
      action: { type: 'send', target: 'brain', message: 'broadcast all', broadcast: true, onlyWhenIdle: false },
    }, mockServerLink);

    const deliveredTargets = dispatchMessage.mock.calls.map((c: any) => c[0].name).sort();
    expect(deliveredTargets).toEqual(['deck_myapp_brain', 'deck_myapp_w1', 'deck_myapp_w2']);
    expect(mockServerLink.send).toHaveBeenLastCalledWith(expect.objectContaining({
      executionId: 'exec-whole-srv-bcast',
      status: 'dispatched',
    }));

    __setCronExactSelfSenderForTests(null);
  });

  it('forwards ownerMachineAuthority and scoped sharedActor/sharedMachineAuthority on structured cron sends', async () => {
    const exactSelfSender = vi.fn(async () => 'sent' as const);
    const dispatchCronSend = vi.fn(async (_input: CronSendDispatchInput) => ({
      dispatchId: 'send_dispatch_auth',
      status: 'dispatched' as const,
      deliveries: [{ target: 'deck_myapp_w1', messageId: 'send_message_auth', status: 'delivered' as const }],
    }));
    __setCronExactSelfSenderForTests(exactSelfSender);
    __setCronSendDispatcherForTests(dispatchCronSend);

    const participantActor: SharedActorEnvelope = {
      actorUserId: 'part-1',
      actorDisplayName: 'part-1',
      snapshot: {
        target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_myapp_brain' },
        effectiveRole: 'participant',
        historyCutoffAt: 0,
        nextCoverageRecheckAt: null,
        coveringShareIds: ['s1'],
        primaryShareId: 's1',
        authorizedAt: 1,
      },
      primaryShareId: 's1',
      effectiveActorRole: 'participant',
      actionId: 'cron-send-part',
      origin: 'shared-tab',
      authorizedAt: 1,
    };

    // Exact self-session send with shared authority
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-exact-self-part',
      exactTargetSessionName: 'deck_myapp_brain',
      [OWNER_MACHINE_AUTHORITY_FIELD]: 'blocked-owner-jwt',
      [SHARED_MACHINE_AUTHORITY_FIELD]: 'part-send-jwt',
      sharedActor: participantActor,
      action: { type: 'send', target: 'deck_myapp_brain', message: 'self ping', onlyWhenIdle: false },
    }, mockServerLink);

    expect(exactSelfSender).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'deck_myapp_brain' }),
      'self ping',
      expect.objectContaining({
        sharedActor: participantActor,
        sharedMachineAuthority: 'part-send-jwt',
      }),
    );
    expect((exactSelfSender.mock.calls[0] as any)[2].ownerMachineAuthority).toBeUndefined();

    // Cross-session send with shared authority
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-cross-part',
      [SHARED_MACHINE_AUTHORITY_FIELD]: 'part-send-jwt',
      sharedActor: participantActor,
    }, mockServerLink);

    expect(dispatchCronSend).toHaveBeenCalledWith(expect.objectContaining({
      sharedActor: participantActor,
      sharedMachineAuthority: 'part-send-jwt',
    }));

    // External-CLI restricted structured send preserves restricted sharedActor with zero machine authorities
    const { IMCODES_EXTERNAL_CLI_SENDER } = await import('../../shared/imcodes-send.js');
    const extActor: SharedActorEnvelope = {
      actorUserId: IMCODES_EXTERNAL_CLI_SENDER,
      actorDisplayName: IMCODES_EXTERNAL_CLI_SENDER,
      snapshot: {
        shareId: 'external-cli',
        serverId: 'srv-1',
        userId: IMCODES_EXTERNAL_CLI_SENDER,
        effectiveRole: 'participant',
        target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_myapp_w1' },
        authorizedAt: 1,
        issuedAt: 1,
      },
      primaryShareId: null,
      effectiveActorRole: 'participant',
      actionId: 'cron-send-ext',
      origin: 'server-member',
      authorizedAt: 1,
    };
    dispatchCronSend.mockClear();
    await executeCronJob({
      ...makeSendMsg(),
      executionId: 'exec-ext-send',
      sharedActor: extActor,
    }, mockServerLink);
    expect(dispatchCronSend).toHaveBeenCalledWith(expect.objectContaining({
      sharedActor: extActor,
    }));
    expect((dispatchCronSend.mock.calls[0] as any)[0].ownerMachineAuthority).toBeUndefined();
    expect((dispatchCronSend.mock.calls[0] as any)[0].sharedMachineAuthority).toBeUndefined();

    __setCronExactSelfSenderForTests(null);
  });
});
