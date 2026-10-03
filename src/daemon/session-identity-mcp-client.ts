/**
 * Local-first identity client used by the MCP tools (memory-mcp-tools.ts)
 * and the sync/apply paths. All three scopes read and write the daemon's own
 * local store (session-identity-local-store.ts) directly -- never HTTP to
 * the server (owner rule, tsk_cd_identity_daemon_storage: the daemon must
 * never call the server over HTTP for identity). A local write reports
 * itself to the server over the daemon's existing WS connection in the
 * background (see session-identity-local-store.ts's report sender); this
 * client never waits on that report to complete a get/set/clear.
 */
import {
  SESSION_IDENTITY_SCOPES,
  sessionIdentitySessionKey,
  type SessionIdentityProfile,
  type SessionIdentityScope,
} from '../../shared/session-identity.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import {
  getLocalSessionIdentityProfile,
  listLocalSessionIdentityProfiles,
  putLocalSessionIdentityProfile,
  removeLocalSessionIdentityProfile,
} from './session-identity-local-store.js';

export interface SessionIdentityEndpoint {
  serverId: string;
  workerUrl: string;
  token: string;
}

/** Kept only so existing callers/tests that pass a serverId hint still compile; no request is ever made. */
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
  truncated: boolean;
} | Failure;

function failure(reason: MCPErrorReason, message: string): Failure {
  return { status: 'error', reason, message: sanitizeMcpErrorMessage(message) };
}

async function resolveServerId(options: SessionIdentityClientOptions): Promise<string> {
  if (options.endpoint?.serverId) return options.endpoint.serverId;
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    return (await loadCredentials())?.serverId ?? '';
  } catch {
    return '';
  }
}

export async function getSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
  _options: SessionIdentityClientOptions = {},
): Promise<IdentityGetResult> {
  try {
    return { status: 'ok', profile: await getLocalSessionIdentityProfile(scope, scopeKey) };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

export async function listSessionIdentityProfiles(
  options: SessionIdentityClientOptions = {},
): Promise<IdentityListResult> {
  try {
    const profiles = await listLocalSessionIdentityProfiles();
    return { status: 'ok', serverId: await resolveServerId(options), profiles, truncated: false };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

export async function setSessionIdentityProfile(
  input: { scope: SessionIdentityScope; scopeKey: string; content: string; expectedRevision?: number; sourceFile?: string },
  _options: SessionIdentityClientOptions = {},
): Promise<IdentityWriteResult> {
  try {
    const profile = await putLocalSessionIdentityProfile({
      scope: input.scope, scopeKey: input.scopeKey, content: input.content, source: 'mcp', sourceFile: input.sourceFile,
    });
    return { status: 'ok', profile };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(MCP_ERROR_REASONS.VALIDATION_FAILED, message);
  }
}

export async function clearSessionIdentityProfile(
  scope: SessionIdentityScope,
  scopeKey: string,
  _expectedRevision: number | undefined,
  _options: SessionIdentityClientOptions = {},
): Promise<IdentityDeleteResult> {
  try {
    return { status: 'ok', deleted: await removeLocalSessionIdentityProfile(scope, scopeKey) };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}

export async function getEffectiveSessionIdentityProfiles(
  input: { projectKey: string; sessionKey?: string; sessionName?: string },
  options: SessionIdentityClientOptions = {},
): Promise<{ status: 'ok'; serverId: string; profiles: SessionIdentityProfile[] } | Failure> {
  const serverId = await resolveServerId(options);
  const sessionKey = input.sessionName
    ? sessionIdentitySessionKey(serverId, input.sessionName)
    : input.sessionKey ?? '';
  try {
    const [userProfile, projectProfile, sessionProfile] = await Promise.all([
      getLocalSessionIdentityProfile(SESSION_IDENTITY_SCOPES.USER, ''),
      getLocalSessionIdentityProfile(SESSION_IDENTITY_SCOPES.PROJECT, input.projectKey),
      getLocalSessionIdentityProfile(SESSION_IDENTITY_SCOPES.SESSION, sessionKey),
    ]);
    return {
      status: 'ok',
      serverId,
      profiles: [userProfile, projectProfile, sessionProfile].flatMap((profile) => (profile ? [profile] : [])),
    };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  }
}
