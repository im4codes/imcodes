import {
  VERIFICATION_MACHINE_API_PATH,
  VERIFICATION_MACHINE_KIND_LIST,
  VERIFICATION_MACHINE_SCOPE_LIST,
  VERIFICATION_MACHINE_STATUS_LIST,
  isVerificationMachineId,
  verificationMachineAliasError,
  verificationMachineTargetError,
  type VerificationMachineKind,
  type VerificationMachineProfile,
  type VerificationMachineScope,
  type VerificationMachineStatus,
} from '../../shared/verification-machine.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';

const DEFAULT_TIMEOUT_MS = 15_000;
type Failure = { status: 'error'; reason: MCPErrorReason; message: string };
type Options = {
  endpoint?: { serverId: string; workerUrl: string; token: string } | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function failure(reason: MCPErrorReason, message: string): Failure {
  return { status: 'error', reason, message: sanitizeMcpErrorMessage(message) };
}

async function resolveEndpoint(options: Options) {
  if (options.endpoint !== undefined) return options.endpoint
    ?? failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'verification machines require a bound daemon credential');
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const value = await loadCredentials();
    return value?.serverId && value.workerUrl && value.token
      ? { serverId: value.serverId, workerUrl: value.workerUrl, token: value.token }
      : failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'verification machines require a bound daemon credential');
  } catch {
    return failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'verification machines require a bound daemon credential');
  }
}

function profileFrom(value: unknown): VerificationMachineProfile | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.scope !== 'string' || typeof row.scopeKey !== 'string'
    || typeof row.alias !== 'string' || typeof row.kind !== 'string' || typeof row.target !== 'string'
    || typeof row.enabled !== 'boolean' || typeof row.revision !== 'number'
    || typeof row.createdAt !== 'number' || typeof row.updatedAt !== 'number'
    || typeof row.lastVerificationStatus !== 'string') return null;
  if (!isVerificationMachineId(row.id)
    || !(VERIFICATION_MACHINE_SCOPE_LIST as readonly string[]).includes(row.scope)
    || !(VERIFICATION_MACHINE_KIND_LIST as readonly string[]).includes(row.kind)
    || !(VERIFICATION_MACHINE_STATUS_LIST as readonly string[]).includes(row.lastVerificationStatus)) return null;
  if (verificationMachineAliasError(row.alias)
    || verificationMachineTargetError(row.kind as VerificationMachineKind, row.target)) return null;
  return row as unknown as VerificationMachineProfile;
}

async function request(options: Options, path: string, init: RequestInit) {
  const endpoint = await resolveEndpoint(options);
  if ('status' in endpoint) return endpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${endpoint.workerUrl.replace(/\/+$/u, '')}${VERIFICATION_MACHINE_API_PATH}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          'X-Server-Id': endpoint.serverId,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: controller.signal,
      },
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const reason = response.status === 409 ? MCP_ERROR_REASONS.REVISION_CONFLICT
        : response.status === 400 ? MCP_ERROR_REASONS.VALIDATION_FAILED
          : response.status === 401 || response.status === 403 ? MCP_ERROR_REASONS.SCOPE_FORBIDDEN
            : MCP_ERROR_REASONS.INTERNAL_ERROR;
      return failure(reason, typeof body.error === 'string' ? body.error : `verification machine request failed (${response.status})`);
    }
    return { status: 'ok' as const, body };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function listVerificationMachineProfiles(projectKey: string | undefined, options: Options = {}) {
  const query = new URLSearchParams();
  if (projectKey) query.set('projectKey', projectKey);
  const result = await request(options, query.size ? `?${query}` : '', { method: 'GET' });
  if (result.status !== 'ok') return result;
  const profiles = Array.isArray(result.body.profiles)
    ? result.body.profiles.flatMap((value) => profileFrom(value) ?? [])
    : [];
  return { status: 'ok' as const, profiles };
}

export async function setVerificationMachineProfile(input: {
  id?: string;
  scope: VerificationMachineScope;
  scopeKey: string;
  alias: string;
  kind: VerificationMachineKind;
  target: string;
  enabled?: boolean;
  expectedRevision?: number;
}, options: Options = {}) {
  const result = await request(options, '', { method: 'PUT', body: JSON.stringify(input) });
  if (result.status !== 'ok') return result;
  const profile = profileFrom(result.body.profile);
  return profile ? { status: 'ok' as const, profile }
    : failure(MCP_ERROR_REASONS.INTERNAL_ERROR, 'server returned an invalid verification machine');
}

export async function removeVerificationMachineProfile(id: string, expectedRevision: number | undefined, options: Options = {}) {
  const query = expectedRevision === undefined ? '' : `?expectedRevision=${expectedRevision}`;
  const result = await request(options, `/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  return result.status === 'ok' ? { status: 'ok' as const, deleted: result.body.deleted === true } : result;
}

export async function recordVerificationMachineProfileStatus(id: string, status: VerificationMachineStatus, options: Options = {}) {
  const result = await request(options, `/${encodeURIComponent(id)}/verification`, {
    method: 'POST', body: JSON.stringify({ status }),
  });
  if (result.status !== 'ok') return result;
  const profile = profileFrom(result.body.profile);
  return profile ? { status: 'ok' as const, profile }
    : failure(MCP_ERROR_REASONS.INTERNAL_ERROR, 'server returned an invalid verification machine');
}
