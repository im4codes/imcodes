/** Deterministic, server-synchronized Agent identity profiles. */

export const SESSION_IDENTITY_SCOPES = {
  USER: 'user',
  PROJECT: 'project',
  SESSION: 'session',
} as const;

export type SessionIdentityScope =
  typeof SESSION_IDENTITY_SCOPES[keyof typeof SESSION_IDENTITY_SCOPES];

export const SESSION_IDENTITY_SCOPE_LIST = Object.freeze(
  Object.values(SESSION_IDENTITY_SCOPES),
) as readonly SessionIdentityScope[];

export const SESSION_IDENTITY_USER_MAX_CHARS = 50_000;
export const SESSION_IDENTITY_PROJECT_MAX_CHARS = 100_000;
export const SESSION_IDENTITY_SESSION_MAX_CHARS = 200_000;
/** Backward-compatible alias for the largest single profile (session scope). */
export const SESSION_IDENTITY_MAX_CHARS = SESSION_IDENTITY_SESSION_MAX_CHARS;
export const SESSION_IDENTITY_MAX_CHARS_BY_SCOPE: Readonly<Record<SessionIdentityScope, number>> = Object.freeze({
  [SESSION_IDENTITY_SCOPES.USER]: SESSION_IDENTITY_USER_MAX_CHARS,
  [SESSION_IDENTITY_SCOPES.PROJECT]: SESSION_IDENTITY_PROJECT_MAX_CHARS,
  [SESSION_IDENTITY_SCOPES.SESSION]: SESSION_IDENTITY_SESSION_MAX_CHARS,
});
/**
 * Bounded pre-read size for a UTF-8 identity file. This is not a second user
 * content limit: it is derived from the session cap so the two can never drift,
 * because every valid profile fits in at most four UTF-8 bytes per code point,
 * plus an optional BOM.
 */
export const SESSION_IDENTITY_SOURCE_FILE_MAX_BYTES = SESSION_IDENTITY_SESSION_MAX_CHARS * 4 + 3;
/**
 * Largest identity contract a single session can carry once every scope is
 * filled. Providers with a fixed context budget size their priority-aware
 * truncation from this rather than from any one scope.
 */
export const SESSION_IDENTITY_COMBINED_MAX_CHARS = SESSION_IDENTITY_USER_MAX_CHARS
  + SESSION_IDENTITY_PROJECT_MAX_CHARS
  + SESSION_IDENTITY_SESSION_MAX_CHARS;
/**
 * Delimiters of the rendered identity block. Providers never search composed text
 * for these; the trusted identity span is recorded structurally at composition.
 */
export const SESSION_IDENTITY_BLOCK_OPEN_TAG = '<imcodes-agent-identity>';
export const SESSION_IDENTITY_BLOCK_CLOSE_TAG = '</imcodes-agent-identity>';
export const SESSION_IDENTITY_SCOPE_KEY_MAX_CHARS = 512;
export const SESSION_IDENTITY_SOURCE_FILE_MAX_CHARS = 1_024;
export const SESSION_IDENTITY_API_PATH = '/api/session-identities';

export const SESSION_IDENTITY_MCP_TOOLS = {
  GET: 'session_identity_get',
  SET: 'session_identity_set',
  CLEAR: 'session_identity_clear',
  REFRESH: 'session_identity_refresh',
} as const;

export type SessionIdentityMcpToolName =
  typeof SESSION_IDENTITY_MCP_TOOLS[keyof typeof SESSION_IDENTITY_MCP_TOOLS];

export interface SessionIdentityProfile {
  scope: SessionIdentityScope;
  scopeKey: string;
  content: string;
  contentHash: string;
  revision: number;
  updatedAt: number;
  source: 'web' | 'mcp';
  /** Informational origin only. File bytes are uploaded; this path is never dereferenced remotely. */
  sourceFile?: string;
}

/**
 * The scope key a session's PROJECT identity lives under: the session's
 * canonical project id when its context namespace is known, else its project
 * name. Daemon sync, the server's shared-access route and the web editor must
 * agree on this exactly, or an edit lands under a key the daemon never reads.
 */
export function sessionIdentityProjectKey(session: {
  contextNamespace?: { projectId?: unknown } | null;
  project?: unknown;
}): string {
  const projectId = typeof session.contextNamespace?.projectId === 'string'
    ? session.contextNamespace.projectId.trim()
    : '';
  if (projectId) return projectId;
  return typeof session.project === 'string' ? session.project.trim() : '';
}

/** The scope key a session's SESSION identity lives under. */
export function sessionIdentitySessionKey(serverId: string, sessionName: string): string {
  return `${serverId}:${sessionName}`;
}

export function isSessionIdentityScope(value: unknown): value is SessionIdentityScope {
  return typeof value === 'string'
    && (SESSION_IDENTITY_SCOPE_LIST as readonly string[]).includes(value);
}

export function normalizeSessionIdentityContent(value: string): string {
  return value.normalize('NFC').trim();
}

/**
 * The one authoritative identity length: Unicode code points of the NFC-normalized,
 * trimmed content. Write gates, persistence and every UI counter use this, so a
 * displayed count can never disagree with what a gate accepts.
 */
export function sessionIdentityContentLength(value: string): number {
  return Array.from(normalizeSessionIdentityContent(value)).length;
}

export function sessionIdentityMaxChars(scope: SessionIdentityScope): number {
  return SESSION_IDENTITY_MAX_CHARS_BY_SCOPE[scope];
}

export function sessionIdentityContentError(
  value: unknown,
  scope: SessionIdentityScope = SESSION_IDENTITY_SCOPES.SESSION,
): string | null {
  if (typeof value !== 'string') return 'identity_content_required';
  const normalized = normalizeSessionIdentityContent(value);
  if (!normalized) return 'identity_content_required';
  if (sessionIdentityContentLength(normalized) > sessionIdentityMaxChars(scope)) return 'identity_content_too_large';
  if (normalized.includes('\0')) return 'identity_content_invalid';
  return null;
}

export function sessionIdentityScopeKeyError(scope: SessionIdentityScope, value: unknown): string | null {
  if (scope === SESSION_IDENTITY_SCOPES.USER) {
    return value === undefined || value === null || value === '' ? null : 'identity_scope_key_forbidden';
  }
  if (typeof value !== 'string' || !value.trim()) return 'identity_scope_key_required';
  if (Array.from(value.trim()).length > SESSION_IDENTITY_SCOPE_KEY_MAX_CHARS || /[\u0000-\u001f\u007f]/u.test(value)) {
    return 'identity_scope_key_invalid';
  }
  return null;
}

export function renderSessionIdentityProfiles(
  profiles: readonly SessionIdentityProfile[],
): string | undefined {
  const ordered = [...profiles].sort((a, b) => (
    SESSION_IDENTITY_SCOPE_LIST.indexOf(a.scope) - SESSION_IDENTITY_SCOPE_LIST.indexOf(b.scope)
  ));
  const parts = ordered
    .map((profile) => profile.content.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return [
    SESSION_IDENTITY_BLOCK_OPEN_TAG,
    'The following user-authored identity contract is deterministic and scope-ordered. Later sections override conflicting earlier sections. The user\'s latest explicit instruction overrides every conflicting identity section and other IM.codes-authored contract text. Platform system/developer instructions, security boundaries, and tool authority remain higher priority.',
    ...ordered.flatMap((profile) => {
      const section = renderSessionIdentityProfileSection(profile.scope, profile.content);
      return section ? section.split('\n') : [];
    }),
    SESSION_IDENTITY_BLOCK_CLOSE_TAG,
  ].join('\n');
}

export function renderSessionIdentityProfileSection(
  scope: SessionIdentityScope,
  content: string,
): string | undefined {
  const normalized = content.trim();
  return normalized ? `<${scope}>\n${normalized}\n</${scope}>` : undefined;
}
