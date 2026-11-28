import { DAEMON_COMMAND_TYPES } from './daemon-command-types.js';
import { DAEMON_MSG } from './daemon-events.js';
import type { ShareTarget } from './tab-sharing.js';

/** Prefix for pure in-memory, server-stateful opaque turn grants (non-JWT, zero persistence). */
export const TURN_AUTHORITY_TOKEN_PREFIX = 'trg_' as const;
/** Capability negotiated in daemon.hello before the server mints pure-RAM turn grants for that link. */
export const TURN_AUTHORITY_REVOKE_CAPABILITY_V1 = 'turn_authority_revoke_v1' as const;
/** Server-minted delegated authority for device calls originating in a shared turn. */
export const SHARED_MACHINE_AUTHORITY_TYPE = 'shared-session-machine-authority' as const;
/** Server-minted authority for machine/account calls originating in a verified host owner turn. */
export const OWNER_MACHINE_AUTHORITY_TYPE = 'owner-session-machine-authority' as const;
export const SHARED_MACHINE_AUTHORITY_HEADER = 'x-imcodes-shared-machine-authority' as const;
export const SHARED_MACHINE_AUTHORITY_FIELD = 'sharedMachineAuthority' as const;
export const OWNER_MACHINE_AUTHORITY_FIELD = 'ownerMachineAuthority' as const;
export const SHARED_MACHINE_AUTHORITY_HOOK_PATH = '/shared-machine-authority' as const;
/** Purpose marker sent only by cron MCP authority resolution so external-CLI turns can create restricted crons while keeping machine/alias hooks fail-closed. */
export const SHARED_MACHINE_AUTHORITY_CRON_PURPOSE = 'cron' as const;
export const SHARED_MACHINE_AUTHORITY_EXTERNAL_CLI_ACTOR_KIND = 'external_cli' as const;
export const CRON_RESTRICTED_ROUTE_SEGMENT = 'cron-restricted' as const;
export const CRON_RESTRICTED_ACTOR_HEADER = 'x-imcodes-cron-actor' as const;
export const CRON_RESTRICTED_ACTOR_EXTERNAL_CLI = 'external_cli' as const;
/** Hook response used when a stdio child still carries a pre-restart epoch. */
export const SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR = 'shared_machine_authority_stale_runtime' as const;

export const SHARED_MACHINE_AUTHORITY_ACTOR_KIND = {
  OWNER: 'owner',
  PARTICIPANT: 'participant',
} as const;

export type SharedMachineAuthorityActorKind =
  (typeof SHARED_MACHINE_AUTHORITY_ACTOR_KIND)[keyof typeof SHARED_MACHINE_AUTHORITY_ACTOR_KIND];

/**
 * Browser commands that write into a PROCESS session's terminal or agent and are
 * not `session.send`. The server stamps `sharedActor` (+ a cached authority
 * token) on a participant's copy of these, so the daemon binds the participant
 * context exactly as it does for a stamped send. An interactive host owner
 * socket receives `OWNER_MACHINE_AUTHORITY_FIELD` via the same command class.
 */
export const SHARE_PROCESS_INPUT_COMMANDS: ReadonlySet<string> = new Set([DAEMON_COMMAND_TYPES.SESSION_INPUT]);

/** Who fed a process session, as recorded by the daemon's per-session authority window. */
export const SHARED_MACHINE_ACTIVITY_KIND = { OWNER: 'owner', PARTICIPANT: 'participant' } as const;
export type SharedMachineActivity =
  | { kind: typeof SHARED_MACHINE_ACTIVITY_KIND.OWNER; authority?: string | undefined }
  | { kind: typeof SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT; actorUserId: string; authority?: string | undefined };

export interface SharedMachineAuthorityClaims {
  type: typeof SHARED_MACHINE_AUTHORITY_TYPE;
  sub: string;
  sourceServerId: string;
  sessionName: string;
  projectName: string;
  shareTarget: ShareTarget;
  actionId: string;
  rootSessionName?: string;
  ownerUserId?: string;
}

export interface OwnerMachineAuthorityClaims {
  type: typeof OWNER_MACHINE_AUTHORITY_TYPE;
  sub: string;
  sourceServerId: string;
  sessionName: string;
  projectName: string;
  actionId: string;
  rootSessionName?: string;
}

export interface TurnAuthorityRevokeMessage {
  type: typeof DAEMON_MSG.TURN_AUTHORITY_REVOKE;
  rootSessionName: string;
  tokenHash: string;
}

export function isTurnAuthorityRevokeMessage(raw: unknown): raw is TurnAuthorityRevokeMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const msg = raw as Record<string, unknown>;
  return msg.type === DAEMON_MSG.TURN_AUTHORITY_REVOKE
    && typeof msg.rootSessionName === 'string' && msg.rootSessionName.length > 0 && msg.rootSessionName.length <= 256
    && typeof msg.tokenHash === 'string' && /^[a-f0-9]{64}$/i.test(msg.tokenHash);
}
