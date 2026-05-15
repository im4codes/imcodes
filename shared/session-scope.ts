export interface SessionScopeRecord {
  name: string;
  projectName: string;
  projectDir?: string;
  parentSession?: string;
}

export interface RuntimeScopeCaller {
  sessionName: string | null;
  projectName: string | null;
  projectRoot?: string | null;
  serverId?: string | null;
}

export interface ResolvedRuntimeScope {
  sessionName: string | null;
  projectName: string | null;
  projectRoot: string | null;
  serverId: string | null;
}

export const IMCODES_SESSION_NAME_PATTERN = /^deck_(?:sub_[A-Za-z0-9_-]+|[A-Za-z0-9._-]+_(?:brain|w\d+))$/;

export function isValidImcodesSessionName(sessionName: string): boolean {
  return IMCODES_SESSION_NAME_PATTERN.test(sessionName);
}

export function resolveEffectiveProjectName(
  session: SessionScopeRecord,
  allSessions: readonly SessionScopeRecord[],
): string {
  if (session.parentSession) {
    const parent = allSessions.find((candidate) => candidate.name === session.parentSession);
    if (parent?.projectName) return parent.projectName;
    return session.parentSession;
  }
  return session.projectName;
}

export function resolveRuntimeScope(
  caller: RuntimeScopeCaller,
  allSessions: readonly SessionScopeRecord[],
): ResolvedRuntimeScope {
  const session = caller.sessionName
    ? allSessions.find((candidate) => candidate.name === caller.sessionName)
    : undefined;
  return {
    sessionName: caller.sessionName,
    projectName: session ? resolveEffectiveProjectName(session, allSessions) : caller.projectName,
    projectRoot: session?.projectDir ?? caller.projectRoot ?? null,
    serverId: caller.serverId ?? null,
  };
}
