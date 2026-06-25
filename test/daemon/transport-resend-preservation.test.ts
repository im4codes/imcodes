import { beforeEach, describe, expect, it } from 'vitest';
import type { TransportSessionRuntime } from '../../src/agent/transport-session-runtime.js';
import { clearAllResend, enqueueResend, getResendEntries } from '../../src/daemon/transport-resend-queue.js';
import { preserveTransportRuntimeQueuesToResend } from '../../src/daemon/transport-resend-preservation.js';

function runtimeSnapshot(
  activeDispatchEntries: Array<{
    clientMessageId: string;
    text: string;
    messagePreamble?: string;
    sharedActor?: Record<string, unknown>;
  }>,
  pendingEntries: Array<{
    clientMessageId: string;
    text: string;
    messagePreamble?: string;
    sharedActor?: Record<string, unknown>;
  }>,
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
      [{ clientMessageId: 'cmd-active', text: 'active turn', messagePreamble: 'active context', sharedActor }],
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
      expect.objectContaining({ commandId: 'cmd-active', text: 'active turn', messagePreamble: 'active context', sharedActor }),
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
});
