import { beforeEach, describe, expect, it } from 'vitest';
import type { PendingTransportMessage, TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { clearAllResend, enqueueResend, getResendEntries } from '../../src/daemon/transport-resend-queue.js';
import { preserveTransportRuntimeQueuesToResend } from '../../src/daemon/transport-resend-preservation.js';
import { getTransportQueueStore } from '../../src/daemon/transport-queue-store.js';

function runtimeSnapshot(
  activeDispatchEntries: PendingTransportMessage[],
  pendingEntries: PendingTransportMessage[],
): TransportSessionRuntime {
  return {
    activeDispatchEntries,
    pendingEntries,
  } as unknown as TransportSessionRuntime;
}

describe('preserveTransportRuntimeQueuesToResend', () => {
  beforeEach(() => {
    clearAllResend();
  });

  it('preserves active entries before pending entries without reordering', () => {
    const sharedActor = {
      actorUserId: 'shared-user',
      actorDisplayName: 'Shared User',
      effectiveActorRole: 'participant',
      origin: 'shared-tab',
      actionId: 'action-1',
      primaryShareId: 'share-1',
      authorizedAt: 1,
      snapshot: {
        target: { kind: 'main', serverId: 'srv-1', sessionName: 'deck_preserve_brain' },
        effectiveRole: 'participant',
        historyCutoffAt: 1,
        authorizedAt: 1,
        primaryShareId: 'share-1',
        coveringShareIds: ['share-1'],
        expiresAt: null,
        nextCoverageRecheckAt: null,
      },
    };
    const runtime = runtimeSnapshot(
      [{
        clientMessageId: 'cmd-active', text: 'active turn', messagePreamble: 'active context', sharedActor,
        registeredSystemContract: {
          contractId: 'supervision_cron_control_v1', signature: 'body-v1', body: 'authoritative cron body',
        },
      }],
      [
        { clientMessageId: 'cmd-pending-1', text: 'queued one' },
        { clientMessageId: 'cmd-pending-2', text: 'queued two', messagePreamble: 'queued context' },
      ],
    );

    const result = preserveTransportRuntimeQueuesToResend('deck_preserve_brain', runtime);

    expect(result).toMatchObject({
      beforeCount: 0,
      afterCount: 3,
      preservedCount: 3,
      activeCount: 1,
      pendingCount: 2,
    });
    expect(getResendEntries('deck_preserve_brain')).toEqual([
      expect.objectContaining({
        commandId: 'cmd-active', text: 'active turn', messagePreamble: 'active context', sharedActor,
        registeredSystemContract: expect.objectContaining({
          contractId: 'supervision_cron_control_v1', body: 'authoritative cron body',
        }),
      }),
      expect.objectContaining({ commandId: 'cmd-pending-1', text: 'queued one' }),
      expect.objectContaining({ commandId: 'cmd-pending-2', text: 'queued two', messagePreamble: 'queued context' }),
    ]);
  });

  it('dedupes against existing resend entries and within the runtime snapshot', () => {
    enqueueResend('deck_preserve_brain', {
      text: 'already queued',
      commandId: 'cmd-active',
      queuedAt: Date.now(),
    });
    const runtime = runtimeSnapshot(
      [{ clientMessageId: 'cmd-active', text: 'active duplicate' }],
      [
        { clientMessageId: 'cmd-pending', text: 'queued once' },
        { clientMessageId: 'cmd-pending', text: 'queued duplicate' },
      ],
    );

    const result = preserveTransportRuntimeQueuesToResend('deck_preserve_brain', runtime);

    expect(result).toMatchObject({
      beforeCount: 1,
      afterCount: 2,
      preservedCount: 1,
      activeCount: 1,
      pendingCount: 2,
      rejectedCount: 1,
    });
    expect(getResendEntries('deck_preserve_brain').map((entry) => entry.commandId)).toEqual([
      'cmd-active',
      'cmd-pending',
    ]);
    expect(getResendEntries('deck_preserve_brain').map((entry) => entry.text)).toEqual([
      'already queued',
      'queued once',
    ]);
  });

  it('preserves every private authority field while making peer-audit lifetime explicit', () => {
    const supervisionReference = {
      kind: 'implementation_blocker' as const,
      taskId: 'tsk-private-authority',
      assignmentId: 'asg-private-authority',
      exactError: 'automatic audit routing blocked',
      revision: 'private-authority-r1',
    };
    const runtime = runtimeSnapshot([], [
      {
        clientMessageId: 'private-supervision',
        text: 'supervision wake',
        deliveryMode: 'append',
        activeTurnDeliveryKind: 'mcp_message',
        supervisionReference,
      },
      {
        clientMessageId: 'private-delegation',
        text: 'delegation completed',
        deliveryMode: 'append',
        activeTurnDeliveryKind: 'delegation_reply',
        delegationReply: { delegationId: 'delegation-private-1' },
      },
      {
        clientMessageId: 'private-peer-audit',
        text: 'peer audit brief',
        peerAudit: { contractVersion: 'v1', attemptHash: 'attempt-private-1' },
      },
    ]);

    expect(preserveTransportRuntimeQueuesToResend('deck_preserve_private', runtime))
      .toMatchObject({ preservedCount: 3, rejectedCount: 0 });
    expect(getResendEntries('deck_preserve_private')).toEqual([
      expect.objectContaining({
        clientMessageId: 'private-supervision',
        activeTurnDeliveryKind: 'mcp_message',
        supervisionReference,
      }),
      expect.objectContaining({
        clientMessageId: 'private-delegation',
        activeTurnDeliveryKind: 'delegation_reply',
        delegationReply: { delegationId: 'delegation-private-1' },
      }),
      expect.objectContaining({
        clientMessageId: 'private-peer-audit',
        peerAudit: { contractVersion: 'v1', attemptHash: 'attempt-private-1' },
      }),
    ]);
    for (const clientMessageId of ['private-supervision', 'private-delegation', 'private-peer-audit']) {
      const material = JSON.parse(
        getTransportQueueStore().readPrivateDispatchMaterial('deck_preserve_private', clientMessageId) ?? '{}',
      ) as Record<string, unknown>;
      expect(material).toMatchObject(
        clientMessageId === 'private-supervision'
          ? { activeTurnDeliveryKind: 'mcp_message', supervisionReference }
          : clientMessageId === 'private-delegation'
            ? { activeTurnDeliveryKind: 'delegation_reply', delegationReply: { delegationId: 'delegation-private-1' } }
            : { peerAudit: { contractVersion: 'v1', attemptHash: 'attempt-private-1' } },
      );
    }
    // Peer-audit rows deliberately remain process-local authority: persistence
    // lets an in-process relaunch preserve them, while restart rehydration's
    // existing scrubPeerAuditOrphans gate removes them if the controller died.
  });
});
