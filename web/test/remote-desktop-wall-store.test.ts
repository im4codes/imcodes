import { describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_WALL_OPERATION } from '@shared/remote-desktop-access.js';
import {
  RemoteDesktopWallRequestError,
  type RemoteDesktopWallSnapshot,
} from '../src/api/remote-desktop-wall.js';
import { mutateRemoteDesktopWallWithOneReplay } from '../src/remote-desktop-wall-store.js';

function snapshot(revision: number, hostIds: string[]): RemoteDesktopWallSnapshot {
  return {
    revision,
    layout: 'grid',
    hostIds,
    hosts: hostIds.map((hostId) => ({
      hostId,
      remoteDesktopHostId: hostId,
      serverId: `server-${hostId}`,
      refName: hostId,
      displayName: hostId,
      online: true,
      execEnabled: true,
      accessRole: 'owner',
    })),
  };
}

describe('remote desktop wall conflict replay', () => {
  it('replays a CAS intent exactly once against the authoritative snapshot', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new RemoteDesktopWallRequestError(409, 'wall_revision_conflict', snapshot(2, ['a', 'b'])))
      .mockResolvedValueOnce(snapshot(3, ['a', 'b', 'c']));
    const result = await mutateRemoteDesktopWallWithOneReplay({
      snapshot: snapshot(1, ['a']),
      intent: { operation: REMOTE_DESKTOP_WALL_OPERATION.ADD, hostId: 'c' },
      send,
    });
    expect(result).toMatchObject({ outcome: 'applied', replayCount: 1, snapshot: { revision: 3 } });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({
      operation: 'add', expectedRevision: 2, hostIds: ['a', 'b', 'c'],
    });
  });

  it('never performs a third implicit write after a second conflict', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new RemoteDesktopWallRequestError(409, 'wall_revision_conflict', snapshot(2, ['a'])))
      .mockRejectedValueOnce(new RemoteDesktopWallRequestError(409, 'wall_revision_conflict', snapshot(3, ['a', 'b'])));
    const result = await mutateRemoteDesktopWallWithOneReplay({
      snapshot: snapshot(1, ['a']),
      intent: { operation: REMOTE_DESKTOP_WALL_OPERATION.ADD, hostId: 'c' },
      send,
    });
    expect(result).toMatchObject({ outcome: 'conflict_requires_retry', replayCount: 1, snapshot: { revision: 3 } });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('makes authorization loss win without replaying stale intent', async () => {
    const send = vi.fn().mockRejectedValue(
      new RemoteDesktopWallRequestError(403, 'wall_host_unavailable', snapshot(5, [])),
    );
    const result = await mutateRemoteDesktopWallWithOneReplay({
      snapshot: snapshot(4, ['a']),
      intent: { operation: REMOTE_DESKTOP_WALL_OPERATION.REORDER, hostId: 'a', toIndex: 0 },
      send,
    });
    // A no-op reorder never writes. Use removal to exercise the auth-loss path.
    expect(send).toHaveBeenCalledTimes(0);
    const removed = await mutateRemoteDesktopWallWithOneReplay({
      snapshot: snapshot(4, ['a']),
      intent: { operation: REMOTE_DESKTOP_WALL_OPERATION.REMOVE, hostId: 'a' },
      send,
    });
    expect(removed).toMatchObject({ outcome: 'authorization_lost', snapshot: { revision: 5, hostIds: [] } });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
