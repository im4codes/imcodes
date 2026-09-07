import {
  SESSION_IDENTITY_API_PATH,
  SESSION_IDENTITY_SCOPES,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '../../shared/session-identity.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';

const DEFAULT_TIMEOUT_MS = 15_000;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(urlFor(ep, scope, scopeKey, extra), {
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
      return failure(reason, typeof raw.error === 'string' ? raw.error : `session identity request failed (${response.status})`);
    }
    return { status: 'ok', body: raw };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${ep.workerUrl.replace(/\/+$/, '')}${SESSION_IDENTITY_API_PATH}/all`,
      {
        headers: { Authorization: `Bearer ${ep.token}`, 'X-Server-Id': ep.serverId },
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return failure(
        response.status === 401 || response.status === 403
          ? MCP_ERROR_REASONS.SCOPE_FORBIDDEN
          : MCP_ERROR_REASONS.INTERNAL_ERROR,
        typeof body.error === 'string' ? body.error : `session identity request failed (${response.status})`,
      );
    }
    const raw = Array.isArray(body.profiles) ? body.profiles : [];
    return {
      status: 'ok',
      serverId: ep.serverId,
      profiles: raw.flatMap((value) => {
        const profile = profileFrom(value);
        return profile ? [profile] : [];
      }),
    };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function setSessionIdentityProfile(
  input: { scope: SessionIdentityScope; scopeKey: string; content: string; expectedRevision?: number; sourceFile?: string },
  options: SessionIdentityClientOptions = {},
): Promise<IdentityWriteResult> {
  const result = await request(options, input.scope, input.scopeKey, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  if (result.status !== 'ok') return result;
  const profile = profileFrom(result.body.profile);
  return profile ? { status: 'ok', profile } : failure(MCP_ERROR_REASONS.INTERNAL_ERROR, 'server returned an invalid identity profile');
}

export async function clearSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
  expectedRevision: number | undefined,
  options: SessionIdentityClientOptions = {},
): Promise<IdentityDeleteResult> {
  const query = new URLSearchParams();
  if (expectedRevision !== undefined) query.set('expectedRevision', String(expectedRevision));
  const result = await request(options, scope, scopeKey, { method: 'DELETE' }, query);
  if (result.status !== 'ok') return result;
  return { status: 'ok', deleted: result.body.deleted === true };
}

export async function getEffectiveSessionIdentityProfiles(
  input: { projectKey: string; sessionKey: string },
  options: SessionIdentityClientOptions = {},
): Promise<{ status: 'ok'; profiles: SessionIdentityProfile[] } | Failure> {
  const results = await Promise.all([
    getSessionIdentityProfile(SESSION_IDENTITY_SCOPES.USER, '', options),
    getSessionIdentityProfile(SESSION_IDENTITY_SCOPES.PROJECT, input.projectKey, options),
    getSessionIdentityProfile(SESSION_IDENTITY_SCOPES.SESSION, input.sessionKey, options),
  ]);
  const failed = results.find((result): result is Failure => result.status === 'error');
  if (failed) return failed;
  return {
    status: 'ok',
    profiles: results.flatMap((result) => result.status === 'ok' && result.profile ? [result.profile] : []),
  };
}
