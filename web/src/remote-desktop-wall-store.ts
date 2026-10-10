import {
  REMOTE_DESKTOP_ACCESS_LIMITS,
  REMOTE_DESKTOP_WALL_OPERATION,
  type RemoteDesktopWallMutation,
  type RemoteDesktopWallOperation,
} from '@shared/remote-desktop-access.js';
import {
  RemoteDesktopWallRequestError,
  type RemoteDesktopWallSnapshot,
} from './api/remote-desktop-wall.js';

export interface RemoteDesktopWallIntent {
  operation: RemoteDesktopWallOperation;
  hostId: string;
  toIndex?: number;
}
export interface RemoteDesktopWallMutationResult {
  snapshot: RemoteDesktopWallSnapshot;
  outcome: 'applied' | 'authorization_lost' | 'conflict_requires_retry' | 'failed';
  replayCount: number;
}

export function applyRemoteDesktopWallIntent(
  snapshot: RemoteDesktopWallSnapshot,
  intent: RemoteDesktopWallIntent,
): string[] | null {
  const ids = [...snapshot.hostIds];
  const index = ids.indexOf(intent.hostId);
  if (intent.operation === REMOTE_DESKTOP_WALL_OPERATION.ADD) {
    if (index >= 0) return ids;
    if (ids.length >= REMOTE_DESKTOP_ACCESS_LIMITS.WALL_MAX_HOSTS) return null;
    return [...ids, intent.hostId];
  }
  if (intent.operation === REMOTE_DESKTOP_WALL_OPERATION.REMOVE) {
    if (index < 0) return ids;
    return ids.filter((id) => id !== intent.hostId);
  }
  if (index < 0 || !Number.isSafeInteger(intent.toIndex)) return null;
  const toIndex = Math.max(0, Math.min(ids.length - 1, intent.toIndex!));
  if (toIndex === index) return ids;
  ids.splice(index, 1);
  ids.splice(toIndex, 0, intent.hostId);
  return ids;
}

/** CAS mutation with exactly one conflict replay. Authorization loss always wins. */
export async function mutateRemoteDesktopWallWithOneReplay(input: {
  snapshot: RemoteDesktopWallSnapshot;
  intent: RemoteDesktopWallIntent;
  send(mutation: RemoteDesktopWallMutation): Promise<RemoteDesktopWallSnapshot>;
}): Promise<RemoteDesktopWallMutationResult> {
  let authoritative = input.snapshot;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const hostIds = applyRemoteDesktopWallIntent(authoritative, input.intent);
    if (!hostIds) return { snapshot: authoritative, outcome: 'failed', replayCount: attempt };
    if (hostIds.length === authoritative.hostIds.length
      && hostIds.every((id, index) => id === authoritative.hostIds[index])) {
      return { snapshot: authoritative, outcome: 'applied', replayCount: attempt };
    }
    try {
      const snapshot = await input.send({
        operation: input.intent.operation,
        expectedRevision: authoritative.revision,
        hostIds,
      });
      return { snapshot, outcome: 'applied', replayCount: attempt };
    } catch (error) {
      if (!(error instanceof RemoteDesktopWallRequestError) || !error.snapshot) {
        return { snapshot: authoritative, outcome: 'failed', replayCount: attempt };
      }
      authoritative = error.snapshot;
      if (error.status === 403) {
        return { snapshot: authoritative, outcome: 'authorization_lost', replayCount: attempt };
      }
      if (error.status !== 409) {
        return { snapshot: authoritative, outcome: 'failed', replayCount: attempt };
      }
      if (attempt === 1) {
        return { snapshot: authoritative, outcome: 'conflict_requires_retry', replayCount: 1 };
      }
    }
  }
  return { snapshot: authoritative, outcome: 'conflict_requires_retry', replayCount: 1 };
}
