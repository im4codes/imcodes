/**
 * Cross-server `get_memory_sources` orchestrator.
 *
 * MCP `get_memory_sources(projectionId)` must follow the projection back to
 * the daemon whose local SQLite holds the raw events. Phase-1 of
 * memory-source-server-routing surfaced `originServerId` on every search
 * hit; this orchestrator consumes it. The MCP tool surface stays unchanged
 * — `serverId` remains in `MEMORY_MCP_FORBIDDEN_ARG_NAMES`. The
 * orchestrator resolves the owner from a process-local cache (populated by
 * `searchMcpMemoryRecall`) or a cloud lookup, never from caller input.
 *
 * State machine:
 *   1. resolve originServerId:
 *        cache → cloud projection-owner endpoint → undefined (fallback)
 *   2. dispatch:
 *        owner === self  → local SQLite (existing memoryGetSources helper)
 *        owner !== self  → HTTP GET /api/memory/sources?serverId=...&...
 *        owner unknown   → local SQLite (legacy behaviour, unchanged)
 *
 * Error mapping for the remote path:
 *   HTTP 403            → reason='scope_forbidden'
 *   HTTP 409 daemon_offline → reason='projection_unavailable'
 *   HTTP 404            → empty isomorphic result (same shape as missing)
 *   other / network err → reason='internal_error'
 */
import type { MemoryToolCaller } from '../context/memory-read-tools.js';
import { memoryGetSources, type MemoryGetSourcesResult } from '../context/memory-read-tools.js';
import { projectionOwnerCache } from './memory-projection-owner-cache.js';
import logger from '../util/logger.js';

export interface OrchestratorCredentials {
  workerUrl: string;
  serverId: string;
  token: string;
}

export interface OrchestratorDeps {
  /** Used to bypass real I/O in tests. */
  fetchImpl?: typeof fetch;
  /** Replaces the default `loadCredentials()` from bind-flow. */
  loadCredentials?: () => Promise<OrchestratorCredentials | null>;
  /** Replaces the default cache (for tests). */
  cache?: typeof projectionOwnerCache;
  /** Replaces the default local memoryGetSources (for tests). */
  localGetSources?: typeof memoryGetSources;
  /** Used to short-circuit cloud lookups in tests that want to force local fallback. */
  skipCloudLookup?: boolean;
  /** Override the request timeout. */
  timeoutMs?: number;
}

export interface GetSourcesError {
  status: 'error';
  reason: 'scope_forbidden' | 'projection_unavailable' | 'internal_error' | 'validation_failed';
  message?: string;
  projectionId: string;
}

export type GetSourcesOrchestratorResult =
  | (MemoryGetSourcesResult & { status: 'ok'; originServerId?: string })
  | GetSourcesError;

const DEFAULT_TIMEOUT_MS = 10_000;

function cleanBaseUrl(workerUrl: string): string {
  return workerUrl.replace(/\/+$/, '');
}

async function defaultLoadCredentials(): Promise<OrchestratorCredentials | null> {
  try {
    const mod = await import('../bind/bind-flow.js');
    const credentials = await mod.loadCredentials();
    if (!credentials?.workerUrl || !credentials.serverId || !credentials.token) return null;
    return credentials;
  } catch {
    return null;
  }
}

async function resolveOwnerFromCloud(
  projectionId: string,
  credentials: OrchestratorCredentials,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  const url = `${cleanBaseUrl(credentials.workerUrl)}/api/memory/projection-owner?projectionId=${encodeURIComponent(projectionId)}`;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'X-Server-Id': credentials.serverId,
      },
      signal,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      logger.debug({ projectionId, status: response.status }, 'projection-owner resolver returned non-OK');
      return null;
    }
    const body = await response.json().catch(() => null) as { originServerId?: unknown } | null;
    const value = body && typeof body.originServerId === 'string' ? body.originServerId.trim() : '';
    return value || null;
  } catch (err) {
    logger.debug({ projectionId, err: err instanceof Error ? err.message : String(err) }, 'projection-owner resolver request failed');
    return null;
  }
}

interface RemoteSourcesEnvelope {
  status?: string;
  projectionId?: string;
  sourceEventCount?: number;
  sources?: MemoryGetSourcesResult['sources'];
  partial?: boolean;
  originServerId?: string;
  reason?: string;
  message?: string;
}

async function fetchRemoteSources(
  projectionId: string,
  ownerServerId: string,
  credentials: OrchestratorCredentials,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<GetSourcesOrchestratorResult> {
  const url = `${cleanBaseUrl(credentials.workerUrl)}/api/memory/sources?serverId=${encodeURIComponent(ownerServerId)}&projectionId=${encodeURIComponent(projectionId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'X-Server-Id': credentials.serverId,
      },
      signal,
    });
  } catch (err) {
    return {
      status: 'error',
      reason: 'internal_error',
      message: err instanceof Error ? err.message : 'network_error',
      projectionId,
    };
  }

  if (response.status === 403) {
    return { status: 'error', reason: 'scope_forbidden', projectionId };
  }
  if (response.status === 409) {
    // Daemon offline at the target serverId — pod-sticky route returned the
    // shared offline contract. Map to projection_unavailable so the MCP
    // caller surfaces a recoverable error and can retry later.
    return { status: 'error', reason: 'projection_unavailable', projectionId };
  }
  if (response.status === 404) {
    // Isomorphic with "missing projection" so we don't leak existence.
    return {
      status: 'ok',
      projectionId,
      sourceEventCount: 0,
      sources: [],
      originServerId: ownerServerId,
    };
  }
  if (!response.ok) {
    return { status: 'error', reason: 'internal_error', projectionId, message: `http_${response.status}` };
  }

  const body = await response.json().catch(() => null) as RemoteSourcesEnvelope | null;
  if (!body || body.status !== 'ok') {
    return { status: 'error', reason: 'internal_error', projectionId, message: body?.reason ?? 'invalid_body' };
  }
  return {
    status: 'ok',
    projectionId,
    sourceEventCount: typeof body.sourceEventCount === 'number' ? body.sourceEventCount : 0,
    sources: Array.isArray(body.sources) ? body.sources : [],
    ...(typeof body.partial === 'boolean' ? { partial: body.partial } : {}),
    originServerId: body.originServerId && typeof body.originServerId === 'string' ? body.originServerId : ownerServerId,
  };
}

/**
 * Resolve sources for `projectionId` through the appropriate path. Caller
 * supplies the MCP-bound `MemoryToolCaller` so the local fallback continues
 * to enforce the existing same-namespace check.
 */
export async function getMemorySourcesOrchestrated(
  projectionId: string,
  caller: MemoryToolCaller,
  deps: OrchestratorDeps = {},
): Promise<GetSourcesOrchestratorResult> {
  const trimmed = projectionId.trim();
  if (!trimmed) {
    return { status: 'error', reason: 'validation_failed', message: 'projectionId is required', projectionId };
  }

  const cache = deps.cache ?? projectionOwnerCache;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const localGetSources = deps.localGetSources ?? memoryGetSources;

  const credentials = await (deps.loadCredentials ?? defaultLoadCredentials)();
  const localServerId = credentials?.serverId ?? null;

  // Step 1: resolve owner.
  let owner: string | null = cache.get(trimmed) ?? null;
  if (!owner && credentials && !deps.skipCloudLookup) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    try {
      owner = await resolveOwnerFromCloud(trimmed, credentials, fetchImpl, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    if (owner) cache.set(trimmed, owner);
  }

  // Step 2: dispatch.
  //   - owner equals local serverId  → local SQLite path
  //   - owner is something else      → remote pod-sticky path
  //   - owner could not be resolved  → fall back to local (legacy behaviour)
  const goLocal = !owner || (localServerId && owner === localServerId);
  if (goLocal) {
    let local: MemoryGetSourcesResult;
    try {
      local = localGetSources(trimmed, caller);
    } catch (err) {
      logger.debug({ projectionId: trimmed, err: err instanceof Error ? err.message : String(err) }, 'local memoryGetSources failed');
      return { status: 'error', reason: 'internal_error', projectionId: trimmed };
    }
    return {
      status: 'ok',
      ...local,
      ...(localServerId ? { originServerId: localServerId } : {}),
    };
  }

  // Remote path. The owner is non-null here.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchRemoteSources(trimmed, owner!, credentials!, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
