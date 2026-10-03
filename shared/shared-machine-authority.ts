import type { ShareTarget } from './tab-sharing.js';

/** Server-minted delegated authority for device calls originating in a shared turn. */
export const SHARED_MACHINE_AUTHORITY_TYPE = 'shared-session-machine-authority' as const;
export const SHARED_MACHINE_AUTHORITY_HEADER = 'x-imcodes-shared-machine-authority' as const;
export const SHARED_MACHINE_AUTHORITY_FIELD = 'sharedMachineAuthority' as const;
export const SHARED_MACHINE_AUTHORITY_HOOK_PATH = '/shared-machine-authority' as const;
/** Hook response used when a stdio child still carries a pre-restart epoch. */
export const SHARED_MACHINE_AUTHORITY_STALE_RUNTIME_ERROR = 'shared_machine_authority_stale_runtime' as const;

export interface SharedMachineAuthorityClaims {
  type: typeof SHARED_MACHINE_AUTHORITY_TYPE;
  sub: string;
  sourceServerId: string;
  sessionName: string;
  projectName: string;
  shareTarget: ShareTarget;
  actionId: string;
}
