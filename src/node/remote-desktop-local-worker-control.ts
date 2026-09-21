import {
  REMOTE_DESKTOP_MSG,
  type RemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';
import type { RemoteDesktopLocalConnection } from '../../shared/remote-desktop-local-management.js';
import type { RemoteDesktopWorkerHostCore } from './remote-desktop-worker-host-core.js';

type CommandHandler = (command: RemoteDesktopDaemonCommand) => Promise<boolean>;

export function activeLocalRemoteDesktopConnections<Metadata>(
  core: RemoteDesktopWorkerHostCore<Metadata>,
): readonly RemoteDesktopLocalConnection[] {
  return core.activeConnections();
}

export async function stopLocalRemoteDesktopConnection<Metadata>(
  core: RemoteDesktopWorkerHostCore<Metadata>,
  handle: CommandHandler,
  publicId: string,
): Promise<boolean> {
  const sessionId = core.sessionIdForLocalConnection(publicId);
  const authority = sessionId ? core.get(sessionId) : undefined;
  if (!authority) return false;
  return handle({
    type: REMOTE_DESKTOP_MSG.STOP,
    requestId: authority.requestId,
    sessionId: authority.sessionId,
    capability: authority.capability.toString('utf8'),
  });
}

export async function stopAllLocalRemoteDesktopConnections<Metadata>(
  core: RemoteDesktopWorkerHostCore<Metadata>,
  handle: CommandHandler,
): Promise<void> {
  // Snapshot before dispatch: STOP may synchronously retire an authority.
  for (const authority of [...core.values()]) {
    await handle({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId: authority.requestId,
      sessionId: authority.sessionId,
      capability: authority.capability.toString('utf8'),
    });
  }
}
