// Daemon MCP → server channel for user-owned pinned messages. The daemon uses
// its bound credential; the server derives the owner and re-authorizes every
// referenced session. Tool callers never supply user/server/session identity.

import {
  MESSAGE_PINS_API_PATH,
  MESSAGE_PIN_ERRORS,
  MESSAGE_PIN_LIMITS,
  isMessagePinEventType,
  type CreateMessagePinInput,
  type MessagePin,
  type MessagePinEventType,
} from '../../shared/message-pins.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export interface MessagePinServerEndpoint {
  serverId: string;
  workerUrl: string;
  token: string;
}

export interface MessagePinMcpClientOptions {
  endpoint?: MessagePinServerEndpoint | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface MessagePinMcpFailure {
  status: 'error';
  reason: MCPErrorReason;
  message: string;
}

export interface MessagePinListInput {
  sessionName?: string;
  query?: string;
  eventType?: MessagePinEventType;
  limit?: number;
}

export type MessagePinListResult = { status: 'ok'; pins: MessagePin[] } | MessagePinMcpFailure;
export type MessagePinGetResult =
  | { status: 'ok'; found: true; pin: MessagePin }
  | { status: 'ok'; found: false; id: string; reason: typeof MESSAGE_PIN_ERRORS.NOT_FOUND }
  | MessagePinMcpFailure;
export type MessagePinSaveResult = { status: 'ok'; pin: MessagePin } | MessagePinMcpFailure;
export type MessagePinDeleteResult =
  | { status: 'ok'; deleted: true; id: string }
  | { status: 'ok'; deleted: false; id: string; reason: typeof MESSAGE_PIN_ERRORS.NOT_FOUND }
  | MessagePinMcpFailure;

function failure(reason: MCPErrorReason, message: string): MessagePinMcpFailure {
  return { status: 'error', reason, message: sanitizeMcpErrorMessage(message) };
}

async function loadBoundEndpoint(): Promise<MessagePinServerEndpoint | null> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const creds = await loadCredentials();
    if (!creds?.serverId || !creds.workerUrl || !creds.token) return null;
    return { serverId: creds.serverId, workerUrl: creds.workerUrl, token: creds.token };
  } catch {
    return null;
  }
}

async function getEndpoint(options: MessagePinMcpClientOptions): Promise<MessagePinServerEndpoint | MessagePinMcpFailure> {
  const endpoint = options.endpoint !== undefined ? options.endpoint : await loadBoundEndpoint();
  if (!endpoint?.serverId || !endpoint.workerUrl || !endpoint.token) {
    return failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'message pin MCP requires a bound daemon server credential');
  }
  return endpoint;
}

function pinUrl(endpoint: MessagePinServerEndpoint, suffix = '', params?: URLSearchParams): string {
  const query = params ?? new URLSearchParams();
  query.set('serverId', endpoint.serverId);
  return `${endpoint.workerUrl.replace(/\/+$/, '')}${MESSAGE_PINS_API_PATH}${suffix}?${query.toString()}`;
}

async function parseJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return fallback;
}

function mapFailure(status: number, body: unknown): MessagePinMcpFailure {
  if (status === 400 || status === 409) {
    return failure(MCP_ERROR_REASONS.VALIDATION_FAILED, responseMessage(body, 'message pin request rejected'));
  }
  if (status === 401 || status === 403) {
    return failure(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, responseMessage(body, `message pin request forbidden (${status})`));
  }
  return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, responseMessage(body, `message pin request failed with status ${status}`));
}

function coercePin(raw: unknown): MessagePin | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== 'string'
    || typeof value.serverId !== 'string'
    || typeof value.sessionName !== 'string'
    || typeof value.eventId !== 'string'
    || typeof value.eventTs !== 'number'
    || !isMessagePinEventType(value.eventType)
    || typeof value.text !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
  ) return null;
  return value as unknown as MessagePin;
}

async function request(
  endpoint: MessagePinServerEndpoint,
  method: 'GET' | 'POST' | 'DELETE',
  suffix: string,
  params: URLSearchParams,
  options: MessagePinMcpClientOptions,
  body?: unknown,
): Promise<{ status: 'ok'; httpStatus: number; body: unknown } | MessagePinMcpFailure> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${endpoint.token}`,
      'X-Server-Id': endpoint.serverId,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await (options.fetchImpl ?? fetch)(pinUrl(endpoint, suffix, params), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    return { status: 'ok', httpStatus: res.status, body: await parseJson(res) };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function messagePinMcpList(
  input: MessagePinListInput,
  options: MessagePinMcpClientOptions = {},
): Promise<MessagePinListResult> {
  const endpoint = await getEndpoint(options);
  if ('status' in endpoint) return endpoint;
  const params = new URLSearchParams();
  if (input.sessionName) params.set('sessionName', input.sessionName);
  if (input.query) params.set('q', input.query);
  if (input.eventType) params.set('eventType', input.eventType);
  params.set('limit', String(input.limit ?? MESSAGE_PIN_LIMITS.MCP_LIST_RESULTS));
  const res = await request(endpoint, 'GET', '', params, options);
  if (res.status !== 'ok') return res;
  if (res.httpStatus < 200 || res.httpStatus >= 300) return mapFailure(res.httpStatus, res.body);
  const raw = res.body && typeof res.body === 'object' && Array.isArray((res.body as Record<string, unknown>).pins)
    ? (res.body as { pins: unknown[] }).pins
    : [];
  return { status: 'ok', pins: raw.map(coercePin).filter((pin): pin is MessagePin => pin !== null) };
}

export async function messagePinMcpGet(id: string, options: MessagePinMcpClientOptions = {}): Promise<MessagePinGetResult> {
  const endpoint = await getEndpoint(options);
  if ('status' in endpoint) return endpoint;
  const res = await request(endpoint, 'GET', `/${encodeURIComponent(id)}`, new URLSearchParams(), options);
  if (res.status !== 'ok') return res;
  if (res.httpStatus === 404) return { status: 'ok', found: false, id, reason: MESSAGE_PIN_ERRORS.NOT_FOUND };
  if (res.httpStatus < 200 || res.httpStatus >= 300) return mapFailure(res.httpStatus, res.body);
  const pin = coercePin(res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>).pin : null);
  return pin ? { status: 'ok', found: true, pin } : failure(MCP_ERROR_REASONS.INTERNAL_ERROR, 'message pin lookup returned no record');
}

export async function messagePinMcpSave(
  sessionName: string,
  pin: CreateMessagePinInput,
  options: MessagePinMcpClientOptions = {},
): Promise<MessagePinSaveResult> {
  const endpoint = await getEndpoint(options);
  if ('status' in endpoint) return endpoint;
  const params = new URLSearchParams({ sessionName });
  const res = await request(endpoint, 'POST', '', params, options, pin);
  if (res.status !== 'ok') return res;
  if (res.httpStatus < 200 || res.httpStatus >= 300) return mapFailure(res.httpStatus, res.body);
  const saved = coercePin(res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>).pin : null);
  return saved ? { status: 'ok', pin: saved } : failure(MCP_ERROR_REASONS.INTERNAL_ERROR, 'message pin save returned no record');
}

export async function messagePinMcpDelete(id: string, options: MessagePinMcpClientOptions = {}): Promise<MessagePinDeleteResult> {
  const endpoint = await getEndpoint(options);
  if ('status' in endpoint) return endpoint;
  const res = await request(endpoint, 'DELETE', `/${encodeURIComponent(id)}`, new URLSearchParams(), options);
  if (res.status !== 'ok') return res;
  if (res.httpStatus === 404) return { status: 'ok', deleted: false, id, reason: MESSAGE_PIN_ERRORS.NOT_FOUND };
  if (res.httpStatus < 200 || res.httpStatus >= 300) return mapFailure(res.httpStatus, res.body);
  return { status: 'ok', deleted: true, id };
}
