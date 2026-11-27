import {
  VOICE_HOTWORDS_API_PATH,
  coerceVoiceHotwordsSyncRecord,
  type VoiceHotwordsPutRequest,
  type VoiceHotwordsSyncRecord,
} from '../../shared/voice-hotwords.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import { daemonApiUrl, type DaemonHttpMethod } from '../../shared/daemon-token-routes.js';
import { daemonServerAuthHeaders } from '../../shared/daemon-server-auth.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface VoiceHotwordsServerEndpoint {
  serverId: string;
  workerUrl: string;
  token: string;
}

export interface VoiceHotwordsMcpClientOptions {
  /** When provided (even as `null`), skips the bound-credential lookup. */
  endpoint?: VoiceHotwordsServerEndpoint | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  loadSharedMachineAuthority?: () => Promise<string | null>;
}

export interface VoiceHotwordsMcpFailure {
  status: 'error';
  reason: MCPErrorReason;
  message: string;
}

export type VoiceHotwordsMcpResult =
  | { status: 'ok'; record: VoiceHotwordsSyncRecord }
  | VoiceHotwordsMcpFailure;

function failure(reason: MCPErrorReason, message: string): VoiceHotwordsMcpFailure {
  return { status: 'error', reason, message: sanitizeMcpErrorMessage(message) };
}

function cleanBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, '');
}

async function loadBoundEndpoint(): Promise<VoiceHotwordsServerEndpoint | null> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const creds = await loadCredentials();
    if (!creds?.serverId || !creds.workerUrl || !creds.token) return null;
    return { serverId: creds.serverId, workerUrl: creds.workerUrl, token: creds.token };
  } catch {
    return null;
  }
}

async function getEndpoint(options: VoiceHotwordsMcpClientOptions): Promise<VoiceHotwordsServerEndpoint | VoiceHotwordsMcpFailure> {
  const endpoint = options.endpoint !== undefined ? options.endpoint : await loadBoundEndpoint();
  if (!endpoint?.serverId || !endpoint.workerUrl || !endpoint.token) {
    return failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'voice hotwords MCP requires a bound daemon server credential');
  }
  return endpoint;
}

function voiceHotwordsUrl(endpoint: VoiceHotwordsServerEndpoint, method: DaemonHttpMethod, query = ''): string {
  return daemonApiUrl(cleanBaseUrl(endpoint.workerUrl), method, `${VOICE_HOTWORDS_API_PATH}${query}`);
}

async function parseJsonResponse(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    if (typeof rec.error === 'string') return rec.error;
    if (typeof rec.message === 'string') return rec.message;
    if (typeof rec.reason === 'string') return rec.reason;
  }
  return fallback;
}

function mapHttpFailure(status: number, body: unknown): VoiceHotwordsMcpFailure {
  if (status === 400) {
    return failure(MCP_ERROR_REASONS.VALIDATION_FAILED, responseMessage(body, 'voice hotwords rejected: invalid input'));
  }
  if (status === 401 || status === 403) {
    return failure(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, responseMessage(body, `voice hotwords request forbidden (${status})`));
  }
  return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, responseMessage(body, `voice hotwords request failed with status ${status}`));
}

async function requestVoiceHotwords(
  method: 'GET' | 'PUT',
  options: VoiceHotwordsMcpClientOptions,
  query = '',
  payload?: VoiceHotwordsPutRequest,
): Promise<VoiceHotwordsMcpResult> {
  const endpoint = await getEndpoint(options);
  if ('status' in endpoint) return endpoint;

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  try {
    let sharedMachineAuthority: string | null = null;
    if (options.loadSharedMachineAuthority) {
      try {
        sharedMachineAuthority = await options.loadSharedMachineAuthority();
      } catch {
        return failure(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'shared machine authority unavailable');
      }
    }
    const headers: Record<string, string> = {
      ...daemonServerAuthHeaders(endpoint),
      ...(sharedMachineAuthority ? { [SHARED_MACHINE_AUTHORITY_HEADER]: sharedMachineAuthority } : {}),
    };
    if (method === 'PUT') {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetchImpl(voiceHotwordsUrl(endpoint, method, query), {
      method,
      headers,
      ...(method === 'PUT' ? { body: JSON.stringify(payload ?? {}) } : {}),
      signal: controller.signal,
    });
    const body = await parseJsonResponse(res);
    if (!res.ok) return mapHttpFailure(res.status, body);
    const rawRecord = body && typeof body === 'object' ? (body as Record<string, unknown>).record : null;
    return { status: 'ok', record: coerceVoiceHotwordsSyncRecord(rawRecord) };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function voiceHotwordsMcpGet(
  options: VoiceHotwordsMcpClientOptions = {},
  projectKey?: string,
): Promise<VoiceHotwordsMcpResult> {
  const query = projectKey ? `?projectKey=${encodeURIComponent(projectKey)}` : '';
  return requestVoiceHotwords('GET', options, query);
}

export async function voiceHotwordsMcpSet(
  payload: VoiceHotwordsPutRequest,
  options: VoiceHotwordsMcpClientOptions = {},
): Promise<VoiceHotwordsMcpResult> {
  return requestVoiceHotwords('PUT', options, '', payload);
}
