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

/**
 * The web client hides legacy project workers (`deck_<project>_wN`) from normal
 * navigation. Unlabelled, daemon-created workers therefore must not appear in
 * target discovery, broadcast, or ordinary user/agent sends: agents otherwise
 * choose raw `w1`/`w2` sessions that the user cannot see in the frontend.
 *
 * A parented/deck_sub session is frontend-visible. A label or `userCreated`
 * marker is also an explicit signal that a worker is intentionally exposed.
 */
export function isDiscoverableInterAgentSession(session: {
  name: string;
  role?: string | null;
  label?: string | null;
  parentSession?: string | null;
  userCreated?: boolean | null;
}): boolean {
  if (session.parentSession || session.name.startsWith('deck_sub_')) return true;
  const isLegacyProjectWorker = /^deck_.+_w\d+$/.test(session.name) && /^w\d+$/.test(session.role ?? '');
  if (!isLegacyProjectWorker) return true;
  return session.userCreated === true || Boolean(session.label?.trim());
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
