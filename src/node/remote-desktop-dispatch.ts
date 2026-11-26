import {
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_TERMINAL_REASON,
  validateRemoteDesktopDaemonCommand,
  type RemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';

/**
 * Anything that can serve a validated remote-desktop command. Both the
 * controlled-node runtime and a normal Windows daemon host a worker, and the
 * dispatch rules below are identical for them — only the transport differs.
 */
export interface RemoteDesktopCommandTarget {
  handle(command: RemoteDesktopDaemonCommand): Promise<boolean>;
}

/**
 * Route one already-typed remote-desktop message to the local worker.
 *
 * `STOP`/`CANCEL` are deliberately silent on failure: they are teardown, and a
 * terminal frame in reply to them would race the teardown the caller already
 * asked for. Every other unmet command answers with a bounded terminal frame so
 * the browser stops waiting instead of hanging on a request nothing will serve.
 * No error detail is reflected back — the worker never holds the node
 * credential and its failures are not the browser's business.
 */
export async function dispatchRemoteDesktopCommand(input: {
  message: Record<string, unknown>;
  enabled: boolean;
  target: RemoteDesktopCommandTarget;
  send(message: Record<string, unknown>): void;
}): Promise<void> {
  const parsed = validateRemoteDesktopDaemonCommand(input.message);
  if (!parsed.ok) return;
  const command = parsed.value;
  const isTeardown = command.type === REMOTE_DESKTOP_MSG.STOP
    || command.type === REMOTE_DESKTOP_MSG.CANCEL;
  const terminal = (reason: string): void => {
    if (isTeardown) return;
    input.send({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId: command.requestId,
      sessionId: command.sessionId,
      capability: command.capability,
      reason,
    });
  };
  if (!input.enabled) {
    terminal(REMOTE_DESKTOP_TERMINAL_REASON.CAPABILITY_UNAVAILABLE);
    return;
  }
  try {
    if (await input.target.handle(command)) return;
  } catch {
    // Fall through to the bounded terminal frame below.
  }
  terminal(REMOTE_DESKTOP_TERMINAL_REASON.WORKER_FAILED);
}
