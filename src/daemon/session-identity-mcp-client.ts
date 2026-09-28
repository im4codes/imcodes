import {
  SESSION_IDENTITY_API_PATH,
  SESSION_IDENTITY_REQUEST_TIMEOUT_MS,
  SESSION_IDENTITY_SCOPES,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '../../shared/session-identity.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';

const DEFAULT_TIMEOUT_MS = SESSION_IDENTITY_REQUEST_TIMEOUT_MS;
/** Keep transient reconnect/fetch failures bounded, but give a daemon a short
 * chance to ride out a pod handoff or server restart. */
export const SESSION_IDENTITY_RETRY_DELAYS_MS = Object.freeze([100, 250]);

export interface SessionIdentityEndpoint {
  serverId: string;
  workerUrl: string;
  token: string;
}

export interface SessionIdentityClientOptions {
  endpoint?: SessionIdentityEndpoint | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Failure = { status: 'error'; reason: MCPErrorReason; message: string };
export type IdentityGetResult = { status: 'ok'; profile: SessionIdentityProfile | null } | Failure;
export type IdentityWriteResult = { status: 'ok'; profile: SessionIdentityProfile } | Failure;
export type IdentityDeleteResult = { status: 'ok'; deleted: boolean } | Failure;
export type IdentityListResult = {
  status: 'ok';
  serverId: string;
  profiles: SessionIdentityProfile[];
} | Failure;

function failure(reason: MCPErrorReason, message: string): Failure {
  return { status: 'error', reason, message: sanitizeMcpErrorMessage(message) };
}

async function endpoint(options: SessionIdentityClientOptions): Promise<SessionIdentityEndpoint | Failure> {
  if (options.endpoint !== undefined) {
    return options.endpoint ?? failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'session identity requires a bound daemon server credential');
  }
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const value = await loadCredentials();
    if (!value?.serverId || !value.workerUrl || !value.token) {
      return failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'session identity requires a bound daemon server credential');
    }
    return { serverId: value.serverId, workerUrl: value.workerUrl, token: value.token };
  } catch {
    return failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'session identity requires a bound daemon server credential');
  }
}

function urlFor(ep: SessionIdentityEndpoint, scope: SessionIdentityScope, scopeKey: string, extra?: URLSearchParams): string {
  const query = extra ?? new URLSearchParams();
  // Keep REST requests on the daemon's server shard.  The header authenticates
  // the credential, while the query parameter lets multi-replica ingress route
  // requests before auth middleware runs (and avoids cross-server reads).
  query.set('serverId', ep.serverId);
  query.set('scope', scope);
  if (scope !== SESSION_IDENTITY_SCOPES.USER) query.set('scopeKey', scopeKey);
  return `${ep.workerUrl.replace(/\/+$/, '')}${SESSION_IDENTITY_API_PATH}?${query.toString()}`;
}

async function request(
  options: SessionIdentityClientOptions,
  scope: SessionIdentityScope,
  scopeKey: string,
  init: RequestInit,
  extra?: URLSearchParams,
): Promise<{ status: 'ok'; body: Record<string, unknown> } | Failure> {
  const ep = await endpoint(options);
  if ('status' in ep) return ep;
  const url = urlFor(ep, scope, scopeKey, extra);
  let lastError = 'session identity request failed';
  for (let attempt = 0; attempt <= SESSION_IDENTITY_RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await (options.fetchImpl ?? fetch)(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${ep.token}`,
          'X-Server-Id': ep.serverId,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: controller.signal,
      });
      const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const reason = response.status === 409
          ? MCP_ERROR_REASONS.REVISION_CONFLICT
          : response.status === 400 ? MCP_ERROR_REASONS.VALIDATION_FAILED
            : response.status === 401 || response.status === 403 ? MCP_ERROR_REASONS.SCOPE_FORBIDDEN
              : MCP_ERROR_REASONS.INTERNAL_ERROR;
        const message = typeof raw.error === 'string' ? raw.error : `session identity request failed (${response.status})`;
        // Retry only server-side failures. Validation/auth failures are
        // deterministic and must be surfaced immediately.
        if (response.status < 500 || attempt === SESSION_IDENTITY_RETRY_DELAYS_MS.length) {
          return failure(reason, message);
        }
        lastError = message;
      } else {
        return { status: 'ok', body: raw };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === SESSION_IDENTITY_RETRY_DELAYS_MS.length) {
        return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, `session identity request failed after retries: ${lastError}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_IDENTITY_RETRY_DELAYS_MS[attempt]!));
  }
  return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, `session identity request failed after retries: ${lastError}`);
}

function profileFrom(value: unknown): SessionIdentityProfile | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.scope !== 'string' || typeof row.scopeKey !== 'string' || typeof row.content !== 'string') return null;
  if (typeof row.contentHash !== 'string' || typeof row.revision !== 'number' || typeof row.updatedAt !== 'number') return null;
  if (row.scope !== 'user' && row.scope !== 'project' && row.scope !== 'session') return null;
  return {
    scope: row.scope,
    scopeKey: row.scopeKey,
    content: row.content,
    contentHash: row.contentHash,
    revision: row.revision,
    updatedAt: row.updatedAt,
    source: row.source === 'web' ? 'web' : 'mcp',
    ...(typeof row.sourceFile === 'string' && row.sourceFile ? { sourceFile: row.sourceFile } : {}),
  };
}

export async function getSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
  options: SessionIdentityClientOptions = {},
): Promise<IdentityGetResult> {
  const result = await request(options, scope, scopeKey, { method: 'GET' });
  if (result.status !== 'ok') return result;
  return { status: 'ok', profile: profileFrom(result.body.profile) };
}

export async function listSessionIdentityProfiles(
  options: SessionIdentityClientOptions = {},
): Promise<IdentityListResult> {
  const ep = await endpoint(options);
  if ('status' in ep) return ep;
  let lastError = 'session identity request failed';
  for (let attempt = 0; attempt <= SESSION_IDENTITY_RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await (options.fetchImpl ?? fetch)(
        `${ep.workerUrl.replace(/\/+$/, '')}${SESSION_IDENTITY_API_PATH}/all?serverId=${encodeURIComponent(ep.serverId)}`,
        {
          headers: { Authorization: `Bearer ${ep.token}`, 'X-Server-Id': ep.serverId },
          signal: controller.signal,
        },
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        lastError = typeof body.error === 'string' ? body.error : `session identity request failed (${response.status})`;
        if (response.status < 500 || attempt === SESSION_IDENTITY_RETRY_DELAYS_MS.length) {
          return failure(
            response.status === 401 || response.status === 403
              ? MCP_ERROR_REASONS.SCOPE_FORBIDDEN
              : MCP_ERROR_REASONS.INTERNAL_ERROR,
            lastError,
          );
        }
      } else {
        const raw = Array.isArray(body.profiles) ? body.profiles : [];
        return {
          status: 'ok',
          serverId: ep.serverId,
          profiles: raw.flatMap((value) => {
            const profile = profileFrom(value);
            return profile ? [profile] : [];
          }),
        };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === SESSION_IDENTITY_RETRY_DELAYS_MS.length) {
        return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, `session identity request failed after retries: ${lastError}`);
      }
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_IDENTITY_RETRY_DELAYS_MS[attempt]!));
  }
  return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, `session identity request failed after retries: ${lastError}`);
}

export async function setSessionIdentityProfile(
  input: { scope: SessionIdentityScope; scopeKey: string; content: string; expectedRevision?: number; sourceFile?: string },
  options: SessionIdentityClientOptions = {},
): Promise<IdentityWriteResult> {
  const { expectedRevision: _ignoredExpectedRevision, ...lastWriteWinsInput } = input;
  const result = await request(options, input.scope, input.scopeKey, {
    method: 'PUT',
    body: JSON.stringify(lastWriteWinsInput),
  });
  if (result.status !== 'ok') return result;
  const profile = profileFrom(result.body.profile);
  return profile ? { status: 'ok', profile } : failure(MCP_ERROR_REASONS.INTERNAL_ERROR, 'server returned an invalid identity profile');
}

export async function clearSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
  _expectedRevision: number | undefined,
  options: SessionIdentityClientOptions = {},
): Promise<IdentityDeleteResult> {
  const result = await request(options, scope, scopeKey, { method: 'DELETE' });
  if (result.status !== 'ok') return result;
  return { status: 'ok', deleted: result.body.deleted === true };
}

export async function getEffectiveSessionIdentityProfiles(
  input: { projectKey: string; sessionKey?: string; sessionName?: string },
  options: SessionIdentityClientOptions = {},
): Promise<{ status: 'ok'; serverId: string; profiles: SessionIdentityProfile[] } | Failure> {
  const ep = await endpoint(options);
  if ('status' in ep) return ep;
  const scopedOptions = { ...options, endpoint: ep };
  const sessionKey = input.sessionName
    ? sessionIdentitySessionKey(ep.serverId, input.sessionName)
    : input.sessionKey ?? '';
  const results = await Promise.all([
    getSessionIdentityProfile(SESSION_IDENTITY_SCOPES.USER, '', scopedOptions),
    getSessionIdentityProfile(SESSION_IDENTITY_SCOPES.PROJECT, input.projectKey, scopedOptions),
    getSessionIdentityProfile(SESSION_IDENTITY_SCOPES.SESSION, sessionKey, scopedOptions),
  ]);
  const failed = results.find((result): result is Failure => result.status === 'error');
  if (failed) return failed;
  return {
    status: 'ok',
    serverId: ep.serverId,
    profiles: results.flatMap((result) => result.status === 'ok' && result.profile ? [result.profile] : []),
  };
}
