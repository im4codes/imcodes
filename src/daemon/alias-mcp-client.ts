// Daemon → server read channel for the user-level alias store.
//
// Aliases are a precise, server-stored, USER-SCOPED reference store, distinct
// from memory. v1 exposes only READ tools to agents (resolve_alias /
// list_aliases); writes are user-only via the web app (`POST/DELETE
// /api/aliases`). See openspec/changes/alias-quick-insert (design D5/D6).
//
// This reuses the existing daemon→server auth mechanism (the same
// `Authorization: Bearer <server token>` + `X-Server-Id: <serverId>` pattern
// used by cron-mcp-client / memory-get-sources-orchestrator / embedding
// server-fallback). The server scopes the read to the daemon's bound OWNER
// user from that credential — the daemon never supplies a user id.
//
// `ALIAS_API_PATH` is intentionally pod-independent (no `serverId` in the
// path/query): alias rows are plain user-scoped DB data, not per-pod daemon
// state, so they do not need pod-sticky routing. The bound credential is only
// used for authentication.

import {
  ALIAS_API_PATH,
  ALIAS_REASONS,
  nfc,
  validateAliasName,
  type AliasEntry,
} from '../../shared/alias-types.js';
import { MCP_ERROR_REASONS, type MCPErrorReason } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const ALIAS_LIST_LIMIT_MAX = 500;

export interface AliasServerEndpoint {
  serverId: string;
  workerUrl: string;
  token: string;
}

export interface AliasMcpClientOptions {
  /** When provided (even as `null`), skips the bound-credential lookup. */
  endpoint?: AliasServerEndpoint | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AliasMcpFailure {
  status: 'error';
  reason: MCPErrorReason;
  message: string;
}

/** `resolve_alias` result: found value, or a non-error not-found (never throws). */
export type AliasResolveResult =
  | { status: 'ok'; found: true; name: string; alias: AliasEntry }
  | { status: 'ok'; found: false; name: string; reason: typeof ALIAS_REASONS.NOT_FOUND }
  | AliasMcpFailure;

export type AliasListResult =
  | { status: 'ok'; aliases: AliasEntry[] }
  | AliasMcpFailure;

function failure(reason: MCPErrorReason, message: string): AliasMcpFailure {
  return { status: 'error', reason, message: sanitizeMcpErrorMessage(message) };
}

function cleanBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, '');
}

async function loadBoundEndpoint(): Promise<AliasServerEndpoint | null> {
  try {
    const { loadCredentials } = await import('../bind/bind-flow.js');
    const creds = await loadCredentials();
    if (!creds?.serverId || !creds.workerUrl || !creds.token) return null;
    return { serverId: creds.serverId, workerUrl: creds.workerUrl, token: creds.token };
  } catch {
    return null;
  }
}

async function getEndpoint(options: AliasMcpClientOptions): Promise<AliasServerEndpoint | AliasMcpFailure> {
  const endpoint = options.endpoint !== undefined ? options.endpoint : await loadBoundEndpoint();
  if (!endpoint?.serverId || !endpoint.workerUrl || !endpoint.token) {
    return failure(MCP_ERROR_REASONS.IDENTITY_REJECTED, 'alias MCP requires a bound daemon server credential');
  }
  return endpoint;
}

function aliasUrl(endpoint: AliasServerEndpoint, query = ''): string {
  return `${cleanBaseUrl(endpoint.workerUrl)}${ALIAS_API_PATH}${query}`;
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
    if (typeof record.reason === 'string') return record.reason;
  }
  return fallback;
}

function mapHttpFailure(status: number, body: unknown): AliasMcpFailure {
  if (status === 401 || status === 403) {
    return failure(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, responseMessage(body, `alias request forbidden (${status})`));
  }
  return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, responseMessage(body, `alias request failed with status ${status}`));
}

/** Minimal, defensive coercion of an untrusted server row into an `AliasEntry`. */
function coerceAliasEntry(raw: unknown): AliasEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const value = typeof record.value === 'string' ? record.value : undefined;
  if (name === undefined || value === undefined) return null;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  return {
    name,
    value,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    tags,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    source: record.source === 'mcp' ? 'mcp' : 'web',
  };
}

function coerceAliasList(body: unknown): AliasEntry[] {
  const rawList = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).aliases)
      ? ((body as Record<string, unknown>).aliases as unknown[])
      : [];
  const out: AliasEntry[] = [];
  for (const raw of rawList) {
    const entry = coerceAliasEntry(raw);
    if (entry) out.push(entry);
  }
  return out;
}

async function requestAliases(
  endpoint: AliasServerEndpoint,
  query: string,
  options: AliasMcpClientOptions,
): Promise<{ status: 'ok'; body: unknown } | AliasMcpFailure> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetchImpl(aliasUrl(endpoint, query), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        'X-Server-Id': endpoint.serverId,
      },
      signal: controller.signal,
    });
    const body = await parseJsonResponse(res);
    if (!res.ok) return mapHttpFailure(res.status, body);
    return { status: 'ok', body };
  } catch (err) {
    return failure(MCP_ERROR_REASONS.INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List the bound owner user's aliases (server is source of truth, user-scoped).
 * Read-only; never mutates.
 */
export async function aliasMcpList(options: AliasMcpClientOptions = {}): Promise<AliasListResult> {
  const endpoint = await getEndpoint(options);
  if ('status' in endpoint) return endpoint;
  const params = new URLSearchParams({ limit: String(ALIAS_LIST_LIMIT_MAX) });
  const result = await requestAliases(endpoint, `?${params.toString()}`, options);
  if (result.status !== 'ok') return result;
  return { status: 'ok', aliases: coerceAliasList(result.body) };
}

/**
 * Resolve a single alias name to its current value for the bound owner user.
 * Returns `found: false` with `alias_not_found` for an absent name — it MUST
 * NOT throw or error for a missing name. Invalid names are `found: false`
 * (they can never match a stored, validated name).
 */
export async function aliasMcpResolve(name: string, options: AliasMcpClientOptions = {}): Promise<AliasResolveResult> {
  const normalized = nfc(name);
  if (validateAliasName(normalized) !== null) {
    return { status: 'ok', found: false, name: normalized, reason: ALIAS_REASONS.NOT_FOUND };
  }
  const list = await aliasMcpList(options);
  if (list.status !== 'ok') return list;
  const match = list.aliases.find((entry) => nfc(entry.name) === normalized);
  if (!match) {
    return { status: 'ok', found: false, name: normalized, reason: ALIAS_REASONS.NOT_FOUND };
  }
  return { status: 'ok', found: true, name: normalized, alias: match };
}
