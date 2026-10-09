import { DAEMON_COMMAND_TYPES } from './daemon-command-types.js';
import type { ShareTarget } from './tab-sharing.js';

/** Server-minted delegated authority for device calls originating in a shared turn. */
export const SHARED_MACHINE_AUTHORITY_TYPE = 'shared-session-machine-authority' as const;
export const SHARED_MACHINE_AUTHORITY_HEADER = 'x-imcodes-shared-machine-authority' as const;
export const SHARED_MACHINE_AUTHORITY_FIELD = 'sharedMachineAuthority' as const;
export const SHARED_MACHINE_AUTHORITY_HOOK_PATH = '/shared-machine-authority' as const;
/** Hook response used when a stdio child still carries a pre-restart epoch. */
export const SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR = 'shared_machine_authority_stale_runtime' as const;

/**
 * Browser commands that write into a PROCESS session's terminal or agent and are
 * not `session.send`. The server stamps `sharedActor` (+ a cached authority
 * token) on a participant's copy of these, so the daemon binds the participant
 * context exactly as it does for a stamped send. Other participant-covered
 * actions either reach transport sessions only (queue edit/append, approval
 * response; those bind through the transport runtime's dispatch entries) or
 * never feed the agent (resize, file/repo/cron actions, session lifecycle).
 */
export const SHARE_PROCESS_INPUT_COMMANDS: ReadonlySet<string> = new Set([DAEMON_COMMAND_TYPES.SESSION_INPUT]);

/** Who fed a process session, as recorded by the daemon's per-session authority window. */
export const SHARED_MACHINE_ACTIVITY_KIND = { OWNER: 'owner', PARTICIPANT: 'participant' } as const;
export type SharedMachineActivity =
  | { kind: typeof SHARED_MACHINE_ACTIVITY_KIND.OWNER }
  | { kind: typeof SHARED_MACHINE_ACTIVITY_KIND.PARTICIPANT; actorUserId: string; authority?: string | undefined };

export interface SharedMachineAuthorityClaims {
  type: typeof SHARED_MACHINE_AUTHORITY_TYPE;
  sub: string;
  sourceServerId: string;
  sessionName: string;
  projectName: string;
  shareTarget: ShareTarget;
  actionId: string;
}
