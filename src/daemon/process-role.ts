/**
 * Which kind of imcodes process this is.
 *
 * Only the daemon (the process that holds the instance lock) may own transport
 * runtimes and drain the shared durable resend queue. Every other imcodes
 * process (the stdio MCP server/bootstrap and any CLI command) imports the same
 * modules, so it needs an explicit marker: otherwise a helper that runs in such
 * a process can connect its own provider app-server, restore the daemon's
 * runtimes and deliver the daemon's queued messages, racing the real owner
 * (duplicate delivery, "another writer is active", forked provider threads).
 *
 * Unmarked processes (unit tests, embedded use) keep the previous behaviour.
 */
type ProcessRole = 'unknown' | 'daemon' | 'non-daemon';

let role: ProcessRole = 'unknown';

/** Entry points of helper processes (MCP, CLI) mark themselves before doing any work. */
export function markNonDaemonProcess(): void {
  // A daemon that is already running in this process must never be demoted.
  if (role !== 'daemon') role = 'non-daemon';
}

/** The daemon marks itself right after acquiring the instance lock. */
export function markDaemonProcess(): void {
  role = 'daemon';
}

/** True only for a process that explicitly declared it is not the daemon. */
export function isNonDaemonProcess(): boolean {
  return role === 'non-daemon';
}

export function resetProcessRoleForTests(): void {
  role = 'unknown';
}
