import type { CronSendAction } from '../../shared/cron-types.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { buildMemoryMcpSourceProvenance, type MemoryMcpSourceProvenance } from '../../shared/memory-mcp-provenance.js';
import {
  MCP_FEATURE_FLAGS_BY_NAME,
  isMcpFeatureEnabled,
  type MCPFeatureFlag,
  type MCPFeatureFlagValues,
} from '../../shared/memory-mcp-feature-flags.js';
import { validateMcpCronAction } from './cron-action-validator.js';

const CRON_EXPIRES_AT_MAX_MS = 90 * 24 * 60 * 60 * 1000;
const CRON_LIST_LIMIT_MAX = 100;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CronServerCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
}

export interface CronMcpClientOptions {
  credentials?: CronServerCredentials | null;
  fetchImpl?: typeof fetch;
  featureFlags?: MCPFeatureFlagValues;
  nowMs?: () => number;
  runtimeServerId?: string | null;
  timeoutMs?: number;
}

export interface CronCreateInput extends MemoryMcpSourceProvenance {
  name: string;
  cronExpr: string;
  projectName: string;
  targetRole?: string;
  targetSessionName?: string | null;
  action: unknown;
  timezone?: string;
  expiresAt?: number | null;
  userId?: string;
  serverId?: string;
  token?: string;
  actorId?: string;
}

export interface CronUpdateInput extends MemoryMcpSourceProvenance {
  id: string;
  name?: string;
  cronExpr?: string;
  projectName?: string;
  targetRole?: string;
  targetSessionName?: string | null;
  action?: unknown;
  timezone?: string;
  expiresAt?: number | null;
  userId?: string;
  serverId?: string;
  token?: string;
  actorId?: string;
}

export interface CronListInput {
  projectName?: string | null;
  limit?: number;
  userId?: string;
  serverId?: string;
  token?: string;
  actorId?: string;
}

export type CronMcpFailure =
  | { status: 'disabled'; reason: typeof MCP_ERROR_REASONS.FEATURE_DISABLED; disabledFlag: MCPFeatureFlag }
  | { status: 'error'; reason: MCPErrorReason; message: string };

export type CronMcpResult<T> = ({ status: 'ok' } & T) | CronMcpFailure;

async function loadBoundCredentials(): Promise<CronServerCredentials | null> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const creds = await loadCredentials();
    if (!creds) return null;
    return {
      serverId: creds.serverId,
      token: creds.token,
      workerUrl: creds.workerUrl,
    };
  } catch {
    return null;
  }
}

function disabled(disabledFlag: MCPFeatureFlag): CronMcpFailure {
  return { status: 'disabled', reason: MCP_ERROR_REASONS.FEATURE_DISABLED, disabledFlag };
}

function error(reason: MCPErrorReason, message: string): CronMcpFailure {
  return { status: 'error', reason, message: sanitizeErrorMessage(message) };
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/token[=:]\s*[^&\s]+/gi, 'token=[redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, '[redacted-url]')
    .replace(/\s+at\s+.*$/gms, '')
    .slice(0, 300);
}

function cleanBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, '');
}

function cleanRuntimeServerId(serverId: string | null | undefined): string | null {
  return typeof serverId === 'string' && serverId.trim() ? serverId.trim() : null;
}

function cronUrl(credentials: CronServerCredentials, runtimeServerId: string, suffix = ''): string {
  return `${cleanBaseUrl(credentials.workerUrl)}/api/server/${encodeURIComponent(runtimeServerId)}/cron${suffix}`;
}

async function getCredentials(
  options: CronMcpClientOptions,
): Promise<{ credentials: CronServerCredentials; runtimeServerId: string } | CronMcpFailure> {
  const runtimeServerId = cleanRuntimeServerId(options.runtimeServerId);
  if (!runtimeServerId) {
    return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'Cron MCP requires runtime-bound server identity');
  }
  const credentials = options.credentials !== undefined ? options.credentials : await loadBoundCredentials();
  if (!credentials?.serverId || !credentials.token || !credentials.workerUrl) {
    return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'Cron MCP requires bound server credentials');
  }
  if (credentials.serverId !== runtimeServerId) {
    return error(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'Cron MCP runtime server identity does not match bound credentials');
  }
  return { credentials, runtimeServerId };
}

function validateExpiresAt(expiresAt: number | null | undefined, nowMs: number): CronMcpFailure | null {
  if (expiresAt === undefined || expiresAt === null) return null;
  if (!Number.isFinite(expiresAt)) return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be a finite timestamp');
  if (expiresAt > nowMs + CRON_EXPIRES_AT_MAX_MS) {
    return error(MCP_ERROR_REASONS.VALIDATION_FAILED, 'expiresAt must be no more than 90 days from now');
  }
  return null;
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CRON_LIST_LIMIT_MAX;
  return Math.min(Math.max(1, Math.trunc(limit)), CRON_LIST_LIMIT_MAX);
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
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return fallback;
}

async function requestCron(
  credentials: CronServerCredentials,
  runtimeServerId: string,
  pathSuffix: string,
  init: RequestInit,
  options: CronMcpClientOptions,
): Promise<CronMcpResult<{ body: unknown }>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(cronUrl(credentials, runtimeServerId, pathSuffix), {
      ...init,
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'X-Server-Id': runtimeServerId,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: controller.signal,
    });
    const body = await parseJsonResponse(res);
    if (!res.ok) {
      return error(MCP_ERROR_REASONS.INTERNAL_ERROR, responseMessage(body, `Cron request failed with status ${res.status}`));
    }
    return { status: 'ok', body };
  } catch (err) {
    return error(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function buildCreateBody(input: CronCreateInput, runtimeServerId: string, action: CronSendAction): Record<string, unknown> {
  return {
    name: input.name,
    cronExpr: input.cronExpr,
    serverId: runtimeServerId,
    projectName: input.projectName,
    targetRole: input.targetRole ?? 'brain',
    ...(input.targetSessionName !== undefined ? { targetSessionName: input.targetSessionName } : {}),
    action,
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

function buildUpdateBody(input: CronUpdateInput, action: CronSendAction | undefined): Record<string, unknown> {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.cronExpr !== undefined ? { cronExpr: input.cronExpr } : {}),
    ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
    ...(input.targetRole !== undefined ? { targetRole: input.targetRole } : {}),
    ...(input.targetSessionName !== undefined ? { targetSessionName: input.targetSessionName } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
}

export async function cronMcpCreate(
  input: CronCreateInput,
  options: CronMcpClientOptions = {},
): Promise<CronMcpResult<{ body: unknown }>> {
  if (!isMcpFeatureEnabled(options.featureFlags, MCP_FEATURE_FLAGS_BY_NAME.cronWrite)) {
    return disabled(MCP_FEATURE_FLAGS_BY_NAME.cronWrite);
  }
  const actionResult = validateMcpCronAction(input.action, buildMemoryMcpSourceProvenance({
    sourceSessionName: input.sourceSessionName,
    sourceProjectName: input.sourceProjectName,
    sourceServerId: input.sourceServerId,
  }));
  if (!actionResult.ok) return error(actionResult.reason, actionResult.message);
  const expiresError = validateExpiresAt(input.expiresAt, (options.nowMs ?? Date.now)());
  if (expiresError) return expiresError;
  const identity = await getCredentials(options);
  if ('status' in identity) return identity;
  return requestCron(identity.credentials, identity.runtimeServerId, '', {
    method: 'POST',
    body: JSON.stringify(buildCreateBody(input, identity.runtimeServerId, actionResult.action)),
  }, options);
}

export async function cronMcpUpdate(
  input: CronUpdateInput,
  options: CronMcpClientOptions = {},
): Promise<CronMcpResult<{ body: unknown }>> {
  if (!isMcpFeatureEnabled(options.featureFlags, MCP_FEATURE_FLAGS_BY_NAME.cronWrite)) {
    return disabled(MCP_FEATURE_FLAGS_BY_NAME.cronWrite);
  }
  let action: CronSendAction | undefined;
  if (input.action !== undefined) {
    const actionResult = validateMcpCronAction(input.action, buildMemoryMcpSourceProvenance({
      sourceSessionName: input.sourceSessionName,
      sourceProjectName: input.sourceProjectName,
      sourceServerId: input.sourceServerId,
    }));
    if (!actionResult.ok) return error(actionResult.reason, actionResult.message);
    action = actionResult.action;
  }
  const expiresError = validateExpiresAt(input.expiresAt, (options.nowMs ?? Date.now)());
  if (expiresError) return expiresError;
  const identity = await getCredentials(options);
  if ('status' in identity) return identity;
  return requestCron(identity.credentials, identity.runtimeServerId, `/${encodeURIComponent(input.id)}`, {
    method: 'PUT',
    body: JSON.stringify(buildUpdateBody(input, action)),
  }, options);
}

export async function cronMcpDelete(
  id: string,
  options: CronMcpClientOptions = {},
): Promise<CronMcpResult<{ body: unknown }>> {
  if (!isMcpFeatureEnabled(options.featureFlags, MCP_FEATURE_FLAGS_BY_NAME.cronWrite)) {
    return disabled(MCP_FEATURE_FLAGS_BY_NAME.cronWrite);
  }
  const identity = await getCredentials(options);
  if ('status' in identity) return identity;
  return requestCron(identity.credentials, identity.runtimeServerId, `/${encodeURIComponent(id)}`, { method: 'DELETE' }, options);
}

export async function cronMcpList(
  input: CronListInput = {},
  options: CronMcpClientOptions = {},
): Promise<CronMcpResult<{ body: unknown; limit: number }>> {
  if (!isMcpFeatureEnabled(options.featureFlags, MCP_FEATURE_FLAGS_BY_NAME.cronRead)) {
    return disabled(MCP_FEATURE_FLAGS_BY_NAME.cronRead);
  }
  const identity = await getCredentials(options);
  if ('status' in identity) return identity;
  const limit = clampListLimit(input.limit);
  const params = new URLSearchParams({ limit: String(limit) });
  if (input.projectName) params.set('projectName', input.projectName);
  const result = await requestCron(identity.credentials, identity.runtimeServerId, `?${params.toString()}`, { method: 'GET' }, options);
  if (result.status !== 'ok') return result;
  return { status: 'ok', body: result.body, limit };
}
