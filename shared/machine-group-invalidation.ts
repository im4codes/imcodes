import { REMOTE_DESKTOP_LIMITS } from './remote-desktop.js';

/** Server-internal fleet invalidation; no daemon or browser wire change. */
export const MACHINE_GROUP_INVALIDATION = {
  CHANNEL: 'imcodes_machine_group_invalidation',
  LISTENER_APPLICATION_PREFIX: 'imcodes-group:',
  PENDING: 'machine_group_revalidation_pending',
  UNAVAILABLE: 'machine_group_invalidation_unavailable',
  POLL_MS: 1_000,
  // Never exclude a paused/dead pod while its node could still hold an authorized desktop lease.
  RECEIVER_LEASE_MS: REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS + REMOTE_DESKTOP_LIMITS.CLOCK_SKEW_TOLERANCE_MS + 3_000,
  AUTHORITY_HEALTH_MS: 10_000,
  APPLY_TIMEOUT_MS: 4_000,
  WAIT_TIMEOUT_MS: 6_000,
  BATCH_SIZE: 64,
  RETENTION_MS: 7 * 24 * 60 * 60 * 1_000,
} as const;
export interface MachineGroupInvalidationScope {
  teamId?: string;
  serverId?: string;
  actorId?: string;
}
