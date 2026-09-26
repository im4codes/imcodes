import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupervisionHeartbeatProjectionSyncHandler } from '../../src/daemon/lifecycle.js';

describe('lifecycle supervision heartbeat projection sync', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces projection changes onto session_list and subsession.sync', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const buildSessionList = vi.fn(async () => [{ name: 'deck_brain' }]) as never;
    const sendSubSessionSync = vi.fn(async () => undefined);
    const handler = createSupervisionHeartbeatProjectionSyncHandler({
      getServerLink: () => ({ daemonVersion: 'test', send } as never),
      buildSessionList,
      sendSubSessionSync: sendSubSessionSync as never,
    });

    handler('deck_brain');
    handler('deck_brain');
    handler('deck_sub_child');
    handler('deck_sub_child');
    await vi.runAllTimersAsync();

    expect(buildSessionList).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'session_list',
      daemonVersion: 'test',
      sessions: [{ name: 'deck_brain' }],
    });
    expect(sendSubSessionSync).toHaveBeenCalledOnce();
    expect(sendSubSessionSync).toHaveBeenCalledWith(
      expect.objectContaining({ daemonVersion: 'test' }),
      'child',
    );
  });
});
