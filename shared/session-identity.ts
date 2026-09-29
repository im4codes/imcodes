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

export const SESSION_IDENTITY_USER_MAX_CHARS = 100_000;
export const SESSION_IDENTITY_PROJECT_MAX_CHARS = 300_000;
export const SESSION_IDENTITY_SESSION_MAX_CHARS = 300_000;
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
/** Bounds for the daemon's cross-session synchronization snapshot. */
export const SESSION_IDENTITY_SYNC_MAX_PROFILES = 256;
export const SESSION_IDENTITY_SYNC_MAX_BYTES = 2_000_000;
export const SESSION_IDENTITY_SYNC_STATEMENT_TIMEOUT_MS = 5_000;
/** Each HTTP attempt must settle before the browser's 20s confirmation budget. */
export const SESSION_IDENTITY_REQUEST_TIMEOUT_MS = 5_000;
/** The browser waits longer than the daemon's normal command-ack deadline so
 * a late-but-valid acknowledgement is not presented as a failed save. */
export const SESSION_IDENTITY_REFRESH_TIMEOUT_MS = 20_000;

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

/**
 * Identity-over-the-lease (phase 2) reuses the Direct File Transfer v2
 * upload/download operations unchanged: an "upload" is a SET, a "download"
 * is a GET, moving in-memory bytes rather than a real file. The daemon
 * recognizes an identity-flavored operation by this handle, carried in the
 * download's `previewHandle` (unrestricted byte-bounded string) or the
 * upload's `filename` field (same bound, repurposed -- the real
 * `clientUploadId` stays a plain opaque token, since IT is restricted to
 * `[A-Za-z0-9_-]{8,128}` and cannot carry an arbitrary scope key).
 *
 * The scope key is hex-encoded, not `encodeURIComponent`-encoded: the SET
 * path's `filename` passes through `sanitizeUploadFilename`
 * (shared/upload-filename.ts) before an OPERATION_INIT is ever sent, as if
 * this were a real file name. That sanitizer doesn't just strip characters
 * like `:` -- it also COLLAPSES runs of 2+ underscores into one, strips a
 * leading `.`/`-`, and strips a trailing `.`/space. `encodeURIComponent`
 * leaves `_`, `.`, and `-` unescaped (they're in its unreserved set), so an
 * entirely ordinary scope key containing one of those (a project id like
 * "my_app__staging", or one starting/ending with `.`/`-`) silently decoded
 * to the WRONG key after round-tripping through the sanitizer -- a real,
 * reproduced bug, not a hypothetical one. Hex output is only `0-9a-f`,
 * which can never trigger any of those three rules, so it survives
 * unchanged. `-` remains a safe, unambiguous delimiter: it never appears in
 * hex output either.
 *
 * PROJECT/SESSION only, never USER: USER scope stays server-authoritative
 * (phase 1) and is never reachable over the lease. `decode` rejects a
 * `user` handle explicitly rather than relying on every caller to check --
 * a browser (malicious or merely buggy) could otherwise ask the daemon to
 * read/write the local USER-scope profile through this path.
 */
const SESSION_IDENTITY_DIRECT_HANDLE_PREFIX = 'imcodes-identity-';
const SESSION_IDENTITY_DIRECT_SCOPES = new Set<string>([SESSION_IDENTITY_SCOPES.PROJECT, SESSION_IDENTITY_SCOPES.SESSION]);

export function encodeSessionIdentityDirectHandle(scope: 'project' | 'session', scopeKey: string): string {
  const hex = Buffer.from(scopeKey, 'utf8').toString('hex');
  return `${SESSION_IDENTITY_DIRECT_HANDLE_PREFIX}${scope}-${hex}`;
}

export function decodeSessionIdentityDirectHandle(
  handle: string,
): { scope: 'project' | 'session'; scopeKey: string } | null {
  if (!handle.startsWith(SESSION_IDENTITY_DIRECT_HANDLE_PREFIX)) return null;
  const rest = handle.slice(SESSION_IDENTITY_DIRECT_HANDLE_PREFIX.length);
  const separator = rest.indexOf('-');
  if (separator < 0) return null;
  const scope = rest.slice(0, separator) as 'project' | 'session';
  if (!SESSION_IDENTITY_DIRECT_SCOPES.has(scope)) return null;
  const hex = rest.slice(separator + 1);
  if (!/^[0-9a-f]*$/u.test(hex) || hex.length % 2 !== 0) return null;
  return { scope, scopeKey: Buffer.from(hex, 'hex').toString('utf8') };
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
