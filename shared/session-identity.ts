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

export const SESSION_IDENTITY_MAX_CHARS = 30_000;
export const SESSION_IDENTITY_MAX_UTF8_BYTES = 120_000;
export const SESSION_IDENTITY_SCOPE_KEY_MAX_CHARS = 512;
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
}

export function isSessionIdentityScope(value: unknown): value is SessionIdentityScope {
  return typeof value === 'string'
    && (SESSION_IDENTITY_SCOPE_LIST as readonly string[]).includes(value);
}

export function normalizeSessionIdentityContent(value: string): string {
  return value.normalize('NFC').trim();
}

export function sessionIdentityContentError(value: unknown): string | null {
  if (typeof value !== 'string') return 'identity_content_required';
  const normalized = normalizeSessionIdentityContent(value);
  if (!normalized) return 'identity_content_required';
  if (Array.from(normalized).length > SESSION_IDENTITY_MAX_CHARS) return 'identity_content_too_large';
  if (new TextEncoder().encode(normalized).byteLength > SESSION_IDENTITY_MAX_UTF8_BYTES) {
    return 'identity_content_too_large';
  }
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
    '<imcodes-agent-identity>',
    'The following user-authored identity contract is deterministic and scope-ordered. Later sections override conflicting earlier sections. The user\'s latest explicit instruction overrides every conflicting identity section and other IM.codes-authored contract text. Platform system/developer instructions, security boundaries, and tool authority remain higher priority.',
    ...ordered.flatMap((profile) => {
      const content = profile.content.trim();
      return content ? [`<${profile.scope}>`, content, `</${profile.scope}>`] : [];
    }),
    '</imcodes-agent-identity>',
  ].join('\n');
}
