import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(() => ({ name: 'deck_delivery_brain', projectName: 'delivery-project' })),
  getTransportRuntime: vi.fn(),
  dispatchSessionMessage: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('../../../src/store/session-store.js', () => ({ getSession: mocks.getSession }));
vi.mock('../../../src/agent/session-manager.js', () => ({ getTransportRuntime: mocks.getTransportRuntime }));
vi.mock('../../../src/daemon/session-dispatch.js', () => ({ dispatchSessionMessage: mocks.dispatchSessionMessage }));
vi.mock('../../../src/daemon/timeline-emitter.js', () => ({ timelineEmitter: { emit: mocks.emit } }));

import { sendTaskPairMessage, setTaskPairDeliveryDepsForTests, taskPairMessageIdPrefix } from '../../../src/daemon/task-pairs/delivery.js';

describe('task-pair reminder delivery dedupe', () => {
  afterEach(() => {
    setTaskPairDeliveryDepsForTests(undefined);
    mocks.getTransportRuntime.mockReset();
    mocks.dispatchSessionMessage.mockReset();
    mocks.emit.mockReset();
    mocks.getSession.mockClear();
  });

  it('does not append a replay card when the same reminder is already queued', async () => {
    mocks.getTransportRuntime.mockReturnValue({
      pendingEntries: [{ clientMessageId: 'task-pair-nudge:__integration__:integration-drift:old' }],
    });

    await expect(sendTaskPairMessage('deck_delivery_brain', '__integration__', 'integration-drift', 'old reminder'))
      .resolves.toBe('skipped_pending');
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.dispatchSessionMessage).not.toHaveBeenCalled();
  });

  it('coalesces concurrent live/replay producers before transport enqueue', async () => {
    let release!: (value: 'queued') => void;
    mocks.getTransportRuntime.mockReturnValue({ pendingEntries: [] });
    mocks.dispatchSessionMessage.mockReturnValue(new Promise<'queued'>((resolve) => { release = resolve; }));

    const first = sendTaskPairMessage('deck_delivery_brain', '__integration__', 'integration-drift', 'reminder');
    await expect(sendTaskPairMessage('deck_delivery_brain', '__integration__', 'integration-drift', 'replay'))
      .resolves.toBe('skipped_pending');
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    release('queued');
    await expect(first).resolves.toBe('queued');
    expect(mocks.dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps durable pending notices isolated by lifecycle scope across replay', async () => {
    const taskId = 'pair-round-scope';
    const oldRoundId = `${taskPairMessageIdPrefix(taskId, 'policy-rejection', 'round:1')}old-round`;
    mocks.getTransportRuntime.mockReturnValue({ pendingEntries: [{ clientMessageId: oldRoundId }] });
    mocks.dispatchSessionMessage.mockReturnValue('queued');

    await expect(sendTaskPairMessage('deck_delivery_brain', taskId, 'policy-rejection', 'new round', 'round:2'))
      .resolves.toBe('queued');
    expect(mocks.dispatchSessionMessage).toHaveBeenCalledTimes(1);
    const newRoundId = mocks.emit.mock.calls[0]?.[2]?.clientMessageId as string;
    expect(newRoundId).toMatch(new RegExp(`^${taskPairMessageIdPrefix(taskId, 'policy-rejection', 'round:2')}`));

    // A restart/replay snapshot containing the new round must suppress only
    // that same scope; the older round was intentionally not a match.
    mocks.getTransportRuntime.mockReturnValue({ pendingEntries: [{ clientMessageId: newRoundId }] });
    await expect(sendTaskPairMessage('deck_delivery_brain', taskId, 'policy-rejection', 'replay', 'round:2'))
      .resolves.toBe('skipped_pending');
    expect(mocks.dispatchSessionMessage).toHaveBeenCalledTimes(1);
  });
});
