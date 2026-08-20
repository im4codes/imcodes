import type { DaemonRemoteDesktop } from './remote-desktop-daemon.js';

/**
 * The daemon's remote-desktop host, if this platform has one.
 *
 * A tiny registry rather than a direct import: the capability advertisement
 * lives in `server-link.ts` and the message dispatch in `command-handler.ts`,
 * and neither should pull the native worker host — nor each other — into its
 * import graph. Only `lifecycle.ts` constructs the instance.
 */
let active: DaemonRemoteDesktop | null = null;

export function setDaemonRemoteDesktop(instance: DaemonRemoteDesktop | null): void {
  active = instance;
}

/** Capabilities to fold into `daemon.hello`; empty when unsupported. */
export function daemonRemoteDesktopCapabilities(): readonly string[] {
  return active?.capabilities() ?? [];
}

/** Tear the worker down and forget it (daemon shutdown). */
export function closeDaemonRemoteDesktop(): void {
  active?.close();
  active = null;
}

/** Returns false when the message is not a remote-desktop message, or no host exists. */
export async function handleDaemonRemoteDesktopMessage(
  message: Record<string, unknown>,
): Promise<boolean> {
  return active ? active.handle(message) : false;
}
