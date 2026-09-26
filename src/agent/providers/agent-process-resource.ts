import type { ChildProcess } from 'node:child_process';
import {
  registerAgentProcessResource,
  releaseSessionResource,
} from '../../daemon/session-resource-service.js';
import type { SessionResourceOwner } from '../../daemon/session-resource-registry.js';
import logger from '../../util/logger.js';
import type { SessionConfig } from '../transport-provider.js';

/**
 * Registry bookkeeping for a session-owned agent CLI that leads its own POSIX
 * process group.
 *
 * Why this exists at all: in-process teardown reaps the group through
 * `killProcessTree`, but if the daemon itself dies — crash, SIGKILL, power —
 * nothing runs that teardown, and the group survives with PPID=1. The registry
 * already solves that: a PID handle with `killTree: true` is stamped with the
 * process start time at registration, and the startup sweep refuses to signal
 * unless the recorded fingerprint still matches the live process. That is real
 * ownership authority, not a guess from command text.
 *
 * It is one module rather than five copies because five providers need exactly
 * the same three steps: derive the owner, register after spawn, release on exit.
 */

export interface AgentProcessResource {
  /** Release the registry lease. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * The owner tuple for a session-owned child, or null when the session did not
 * supply a complete identity. `SessionConfig` already carries all three fields
 * for exactly this purpose.
 */
export function agentResourceOwner(config: Pick<SessionConfig,
  'sessionName' | 'sessionInstanceId' | 'runtimeEpoch'>): SessionResourceOwner | null {
  const sessionName = config.sessionName?.trim();
  const sessionInstanceId = config.sessionInstanceId?.trim();
  const runtimeEpoch = config.runtimeEpoch?.trim();
  return sessionName && sessionInstanceId && runtimeEpoch
    ? { sessionName, sessionInstanceId, runtimeEpoch }
    : null;
}

const NOOP: AgentProcessResource = { release: async () => {} };

/**
 * Register `child` as a session-owned agent process and release the lease when
 * it exits.
 *
 * Registration is asynchronous while some spawn sites (notably the Claude SDK's
 * `spawnClaudeCodeProcess`) must return the ChildProcess synchronously, so the
 * pending registration is retained here and awaited by `release()`. That
 * ordering matters: releasing before the registration resolves would leave a
 * lease behind that only a later startup sweep could clean up.
 */
export function bindAgentProcessResource(
  owner: SessionResourceOwner | null,
  child: ChildProcess,
): AgentProcessResource {
  const pid = child.pid;
  if (!owner || typeof pid !== 'number' || pid <= 0) return NOOP;

  const registration = registerAgentProcessResource(owner, pid).catch((error) => {
    // A failed registration costs crash-recovery coverage for this child; it
    // must not take down a working session, and in-process teardown still
    // reaps the group. Surfaced rather than swallowed.
    logger.warn({ err: error, pid, session: owner.sessionName }, 'agent process resource registration failed');
    return null;
  });

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    const resourceId = await registration;
    if (!resourceId) return;
    await releaseSessionResource(resourceId, owner).catch(() => {});
  };

  child.once('exit', () => { void release(); });
  return { release };
}
