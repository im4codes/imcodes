import type { ShareRole, ShareTarget } from './tab-sharing-ui.js';
import type { SessionInfo } from './types.js';

export interface SupervisionTaskConsoleVisibilityInput {
  session: Pick<SessionInfo, 'role'> | null | undefined;
  shareTargetKind: ShareTarget['kind'] | null;
  sharedAccessRole: ShareRole | null | undefined;
}

/**
 * Viewing the task console never promotes a session to Brain. The original
 * Brain can always view it, while viewers and participants of a shared main
 * session may also inspect its read-only projection. Server-wide and
 * sub-session shares stay excluded; mutation permissions remain independent.
 */
export function canViewSupervisionTaskConsole(
  input: SupervisionTaskConsoleVisibilityInput,
): boolean {
  if (input.session?.role !== 'brain') return false;
  if (input.shareTargetKind === null) return true;
  const hasSharedReadAccess = input.sharedAccessRole === 'viewer'
    || input.sharedAccessRole === 'participant';
  return input.shareTargetKind === 'main' && hasSharedReadAccess;
}
