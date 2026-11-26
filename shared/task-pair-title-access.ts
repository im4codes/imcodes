/** Title-only grants. A session role is not a human's task authorization. */
export const TASK_PAIR_TITLE_ACCESS_VERSION = 1 as const;
export const TASK_PAIR_TITLE_ACCESS_MAX_USERS = 64;
export const TASK_PAIR_TITLE_ACCESS_MAX_USER_CHARS = 128;
export const TASK_PAIR_TITLE_ACCESS_FIELD = 'titleAccess' as const;
export const TASK_PAIR_TITLE_AUTHORITY_PATH = '/api/task-pair-title-authority' as const;
export const TASK_PAIR_TITLE_AUTHORITY_TIMEOUT_MS = 3_000;

export interface TaskPairTitleAccess {
  version: typeof TASK_PAIR_TITLE_ACCESS_VERSION;
  serverId: string;
  /** Append-only: verified creator, plus users explicitly granted by the owner. */
  userIds: string[];
}
/** Older share redactors already drop `brief` recursively. Never put raw grant identities on an unknown wire field. */
export interface TaskPairTitleWireAccess { brief: TaskPairTitleAccess }
export const taskPairTitleWireAccess = (access: TaskPairTitleAccess): TaskPairTitleWireAccess => ({ brief: access });
export function canReadTaskPairWireTitle(access: unknown, actor: TaskPairTitleActor | undefined): boolean {
  return !!access && typeof access === 'object' && !Array.isArray(access)
    && canReadTaskPairTitle((access as Partial<TaskPairTitleWireAccess>).brief, actor);
}
export interface TaskPairTitleActor { serverId: string; userId: string }
export interface TaskPairTitleTurn {
  participantView: boolean;
  /** Present only after live server verification of the current turn authority. */
  actor?: TaskPairTitleActor & { sessionName: string; projectName: string };
}

export function isTaskPairTitleAccess(access: unknown): access is TaskPairTitleAccess {
  if (!access || typeof access !== 'object' || Array.isArray(access)) return false;
  const grant = access as Partial<TaskPairTitleAccess>;
  return grant.version === TASK_PAIR_TITLE_ACCESS_VERSION && typeof grant.serverId === 'string' && grant.serverId.length > 0
    && Array.isArray(grant.userIds) && grant.userIds.length > 0 && grant.userIds.length <= TASK_PAIR_TITLE_ACCESS_MAX_USERS
    && grant.userIds.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= TASK_PAIR_TITLE_ACCESS_MAX_USER_CHARS);
}
export function canReadTaskPairTitle(access: unknown, actor: TaskPairTitleActor | undefined): boolean {
  return !!actor?.serverId && !!actor.userId && isTaskPairTitleAccess(access)
    && access.serverId === actor.serverId && access.userIds.includes(actor.userId);
}
