import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { deliverTransportResendEntry } from '../../src/agent/transport-resend-delivery.js';
import {
  clearAllResend,
  drainResend,
  enqueueResend,
  getResendCount,
} from '../../src/daemon/transport-resend-queue.js';

type ResendRuntime = Pick<
  TransportSessionRuntime,
  'appendExternalMessageToActiveTurn' | 'send'
>;

function runtimeHarness() {
  const appendExternalMessageToActiveTurn = vi.fn();
  const send = vi.fn();
  return {
    runtime: { appendExternalMessageToActiveTurn, send } as unknown as ResendRuntime,
    appendExternalMessageToActiveTurn,
    send,
  };
}

describe('transport resend delivery policy', () => {
  beforeEach(() => {
    clearAllResend();
  });

  it('drains consecutive append entries into one active provider query instead of the idle FIFO', async () => {
    const harness = runtimeHarness();
    harness.appendExternalMessageToActiveTurn
      .mockResolvedValueOnce('sent')
      .mockResolvedValueOnce('appended')
      .mockResolvedValueOnce('appended');
    const queuedAt = Date.now();
    for (const marker of ['A', 'B', 'C']) {
      enqueueResend('deck_sub_append_restore', {
        text: marker,
        commandId: `cmd-${marker}`,
        clientMessageId: `msg-${marker}`,
        deliveryMode: 'append',
        queuedAt,
      });
    }

    await expect(drainResend(
      'deck_sub_append_restore',
      (entry) => deliverTransportResendEntry(harness.runtime, entry),
    )).resolves.toBe(3);

    expect(harness.appendExternalMessageToActiveTurn.mock.calls).toEqual([
      ['A', 'msg-A'],
      ['B', 'msg-B'],
      ['C', 'msg-C'],
    ]);
    expect(harness.send).not.toHaveBeenCalled();
    expect(getResendCount('deck_sub_append_restore')).toBe(0);
  });

  it('replays append-mode restore entries through the active provider query, not the idle FIFO', async () => {
    const harness = runtimeHarness();
    harness.appendExternalMessageToActiveTurn.mockResolvedValue('appended');

    await expect(deliverTransportResendEntry(harness.runtime, {
      text: '#shortcut',
      providerText: 'expanded shortcut body',
      commandId: 'cmd-append',
      clientMessageId: 'msg-append',
      deliveryMode: 'append',
      queuedAt: Date.now(),
    })).resolves.toBe('appended');

    expect(harness.appendExternalMessageToActiveTurn).toHaveBeenCalledWith(
      'expanded shortcut body',
      'msg-append',
    );
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('threads delegation/private routing authority through native append and FIFO fallback', async () => {
    const harness = runtimeHarness();
    harness.appendExternalMessageToActiveTurn.mockResolvedValue('unsupported');
    harness.send.mockReturnValue('queued');
    const delegationReply = { delegationId: 'delegation-resend-private' };
    const entry = {
      text: 'delegation completed',
      commandId: 'cmd-delegation-private',
      clientMessageId: 'msg-delegation-private',
      deliveryMode: 'append' as const,
      activeTurnDeliveryKind: 'delegation_reply' as const,
      delegationReply,
      queuedAt: Date.now(),
    };

    await expect(deliverTransportResendEntry(harness.runtime, entry)).resolves.toBe('queued');
    expect(harness.appendExternalMessageToActiveTurn).toHaveBeenCalledWith(
      entry.text,
      entry.clientMessageId,
      undefined,
      undefined,
      { activeTurnDeliveryKind: 'delegation_reply', delegationReply },
    );
    expect(harness.send).toHaveBeenCalledWith(
      entry.text,
      entry.clientMessageId,
      undefined,
      undefined,
      { activeTurnDeliveryKind: 'delegation_reply', delegationReply },
    );
  });

  it.each(['stale', 'unsupported'] as const)(
    'falls back to the durable runtime FIFO when native append returns %s',
    async (appendResult) => {
      const harness = runtimeHarness();
      harness.appendExternalMessageToActiveTurn.mockResolvedValue(appendResult);
      harness.send.mockReturnValue('queued');

      await expect(deliverTransportResendEntry(harness.runtime, {
        text: 'keep me durable',
        commandId: 'cmd-fallback',
        clientMessageId: 'msg-fallback',
        deliveryMode: 'append',
        supervisionReference: {
          kind: 'implementation_blocker',
          taskId: 'tsk_wake',
          assignmentId: 'asg_worker',
          revision: 'wake-r1',
          exactError: 'auditor unavailable',
        },
        queuedAt: Date.now(),
      })).resolves.toBe('queued');

      expect(harness.appendExternalMessageToActiveTurn).toHaveBeenCalledOnce();
      expect(harness.appendExternalMessageToActiveTurn).toHaveBeenCalledWith(
        'keep me durable',
        'msg-fallback',
        expect.objectContaining({
          kind: 'implementation_blocker',
          taskId: 'tsk_wake',
          assignmentId: 'asg_worker',
        }),
      );
      expect(harness.send).toHaveBeenCalledWith(
        'keep me durable',
        'msg-fallback',
        undefined,
        undefined,
        {
          supervisionReference: {
            kind: 'implementation_blocker',
            taskId: 'tsk_wake',
            assignmentId: 'asg_worker',
            revision: 'wake-r1',
            exactError: 'auditor unavailable',
          },
        },
      );
    },
  );

  it('propagates temporary authority unavailability without falling back or fabricating delivery', async () => {
    const harness = runtimeHarness();
    harness.appendExternalMessageToActiveTurn.mockResolvedValue('retry');

    await expect(deliverTransportResendEntry(harness.runtime, {
      text: 'retry exact control row',
      commandId: 'cmd-retry',
      clientMessageId: 'msg-retry',
      deliveryMode: 'append',
      queuedAt: Date.now(),
    })).resolves.toBe('retry');
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('keeps attachment-bearing restore entries on the ordinary supported path', async () => {
    const harness = runtimeHarness();
    harness.send.mockReturnValue('sent');
    const attachment = {
      id: 'attachment-1',
      daemonPath: '/tmp/example.png',
      type: 'image' as const,
      mime: 'image/png',
    };

    await expect(deliverTransportResendEntry(harness.runtime, {
      text: 'inspect image',
      commandId: 'cmd-image',
      deliveryMode: 'append',
      attachments: [attachment],
      queuedAt: Date.now(),
    })).resolves.toBe('sent');

    expect(harness.appendExternalMessageToActiveTurn).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      'inspect image',
      'cmd-image',
      [attachment],
      undefined,
      {},
    );
  });

  it('rehydrates a queued cron registration through the system-contract path', async () => {
    const harness = runtimeHarness();
    harness.send.mockReturnValue('sent');
    const registeredSystemContract = {
      contractId: 'supervision_cron_control_v1',
      signature: 'cron-v1-body',
      body: '{"contractId":"supervision_cron_control_v1","authoritative":{"taskBody":"inspect"}}',
    };

    await expect(deliverTransportResendEntry(harness.runtime, {
      text: 'compact cron ref',
      commandId: 'cron-command',
      clientMessageId: 'cron-message',
      deliveryMode: 'append',
      registeredSystemContract,
      queuedAt: Date.now(),
    })).resolves.toBe('sent');

    expect(harness.appendExternalMessageToActiveTurn).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith(
      'compact cron ref',
      'cron-message',
      undefined,
      undefined,
      { registeredSystemContract },
    );
  });
});
