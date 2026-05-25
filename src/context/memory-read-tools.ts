import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ContextNamespace, LocalContextEvent } from '../../shared/context-types.js';
import { buildMemoryMcpSourceProvenance, type MemoryMcpSourceProvenance, type MemoryMcpSourceProvenanceInput } from '../../shared/memory-mcp-provenance.js';
import { buildMemoryProjectionFallbackSource } from '../../shared/memory-projection-source-fallback.js';
import { serializeContextNamespace } from './context-keys.js';
import {
  LEGACY_DAEMON_LOCAL_USER_ID,
  getArchivedEvent,
  getContextObservationById,
  getProcessedProjectionById,
  getStagedEvent,
  listContextNamespaces,
  listProjectionSources,
  searchArchiveFts,
} from '../store/context-store.js';

const MEMORY_TOOL_CALLER_BRAND: unique symbol = Symbol('MemoryToolCaller');
const INTERNAL_MEMORY_TOOL_CALLER_BRAND: unique symbol = Symbol('InternalMemoryToolCaller');
const DAEMON_LOCAL_MEMORY_USER_ID = 'daemon-local';

/**
 * Caller identity passed to public read-tool handlers.
 *
 * `namespace` is REQUIRED for all public callers — every external invocation
 * (MCP adapter, in-process bridge, future RPC layer) MUST scope its query to
 * a single namespace. Owner-wide queries are deliberately not exposed on this
 * type; see `InternalMemoryToolCaller` below for the daemon-only debug path.
 *
 * (memory-system-1.1-foundations P4 / spec.md:298-311)
 */
export interface MemoryToolCaller extends MemoryMcpSourceProvenance {
  readonly userId: string;
  readonly namespace: ContextNamespace;
  readonly [MEMORY_TOOL_CALLER_BRAND]: true;
}

/**
 * Internal-only caller variant for daemon-local debug helpers that need to
 * search across namespaces owned by the bound user. This type is NOT
 * registered on the public read-tool surface and is enforced via the
 * `scripts/check-no-internal-caller-leak.sh` CI grep — any reference to
 * `allowGlobalOwnerSearch` outside this file or `src/daemon/*` fails CI.
 *
 * Owner-wide search is best-effort and may under-return because user
 * filtering is post-query and capped (see `searchArchiveFts`). Use only
 * from internal debug entry points where partial coverage is acceptable.
 */
export interface InternalMemoryToolCaller {
  readonly userId: string;
  /** Sentinel literal so the discriminator survives JSON round-trips in tests. */
  readonly allowGlobalOwnerSearch: true;
  readonly [INTERNAL_MEMORY_TOOL_CALLER_BRAND]: true;
}

type AnyCaller = MemoryToolCaller | InternalMemoryToolCaller;

export function createMemoryToolCaller(input: { userId: string; namespace: ContextNamespace } & MemoryMcpSourceProvenanceInput): MemoryToolCaller {
  if (!input.userId.trim() || !input.namespace || typeof input.namespace !== 'object') {
    throw new Error('invalid caller');
  }
  const provenance = buildMemoryMcpSourceProvenance(input);
  return Object.freeze({
    userId: input.userId,
    namespace: input.namespace,
    ...provenance,
    [MEMORY_TOOL_CALLER_BRAND]: true as const,
  }) as MemoryToolCaller;
}

export function _createInternalMemoryToolCaller(input: { userId: string }): InternalMemoryToolCaller {
  if (!input.userId.trim()) {
    throw new Error('invalid caller');
  }
  return Object.freeze({
    userId: input.userId,
    allowGlobalOwnerSearch: true,
    [INTERNAL_MEMORY_TOOL_CALLER_BRAND]: true as const,
  }) as InternalMemoryToolCaller;
}

function isInternalCaller(caller: AnyCaller): caller is InternalMemoryToolCaller {
  return (caller as InternalMemoryToolCaller).allowGlobalOwnerSearch === true
    && (caller as InternalMemoryToolCaller)[INTERNAL_MEMORY_TOOL_CALLER_BRAND] === true;
}

export function getBoundMemoryToolUserId(): string | undefined {
  const path = process.env.IMCODES_SERVER_CONFIG_PATH ?? join(homedir(), '.imcodes', 'server.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { userId?: string };
    return typeof parsed.userId === 'string' && parsed.userId.trim() ? parsed.userId.trim() : DAEMON_LOCAL_MEMORY_USER_ID;
  } catch {
    return DAEMON_LOCAL_MEMORY_USER_ID;
  }
}

function forbidden(message = 'raw memory events are private to the originating user'): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = 'IMCODES_MEMORY_FORBIDDEN';
  return err;
}

function assertOwner<T extends AnyCaller>(caller?: T): T {
  const boundUserId = getBoundMemoryToolUserId();
  if (!boundUserId) throw forbidden('raw memory tools require a bound IM.codes user');
  if (!caller?.userId) throw forbidden('raw memory tools require an authenticated caller');
  if (caller.userId !== boundUserId) {
    throw forbidden();
  }
  return caller;
}

/**
 * Defensive runtime guard for the public-caller surface. TypeScript declares
 * `namespace` as required on `MemoryToolCaller`, but cast-away or
 * JSON-deserialized callers can still arrive with the field missing — and
 * the foundations spec requires those calls to fail-closed, not surface raw
 * cross-namespace data.
 */
function assertPublicCallerHasNamespace(caller: MemoryToolCaller | undefined): MemoryToolCaller {
  if (!caller || !caller.namespace || typeof caller.namespace !== 'object') {
    throw forbidden('raw memory tools require caller namespace');
  }
  if ((caller as MemoryToolCaller)[MEMORY_TOOL_CALLER_BRAND] !== true) {
    throw forbidden('raw memory tools require a factory-created caller');
  }
  // Reject any attempt to smuggle the internal flag through the public surface.
  if ((caller as unknown as { allowGlobalOwnerSearch?: unknown }).allowGlobalOwnerSearch) {
    throw forbidden('global-owner search is not exposed on the public read-tool surface');
  }
  return caller;
}

function sameNamespace(a: ContextNamespace, b: ContextNamespace): boolean {
  return serializeContextNamespace(a) === serializeContextNamespace(b);
}

function canAccessNamespace(namespace: ContextNamespace, caller: AnyCaller): boolean {
  if (
    namespace.scope === 'personal'
    && (!namespace.userId || namespace.userId === LEGACY_DAEMON_LOCAL_USER_ID)
  ) {
    if (isInternalCaller(caller)) return true;
    return caller.namespace.scope === 'personal'
      && namespace.projectId === caller.namespace.projectId
      && (namespace.enterpriseId ?? undefined) === (caller.namespace.enterpriseId ?? undefined)
      && (namespace.workspaceId ?? undefined) === (caller.namespace.workspaceId ?? undefined);
  }
  if (namespace.userId !== caller.userId) return false;
  if (isInternalCaller(caller)) return true;
  // Public callers carry a required namespace; cross-namespace reads are forbidden.
  return sameNamespace(namespace, caller.namespace);
}

function assertCanAccessNamespace(namespace: ContextNamespace, caller: AnyCaller): void {
  if (!canAccessNamespace(namespace, caller)) throw forbidden();
}

function canReturnEvent(event: LocalContextEvent | undefined, caller: AnyCaller): event is LocalContextEvent {
  if (!event) return false;
  return canAccessNamespace(event.target.namespace, caller);
}

// ── Public read-tool handlers ──────────────────────────────────────────────
//
// All public handlers accept `MemoryToolCaller`, which has a REQUIRED
// `namespace`. The `InternalMemoryToolCaller` variant is intentionally not
// accepted here so a JSON-deserialized request body cannot smuggle the
// `allowGlobalOwnerSearch` flag through a public surface.

export function chatGetEvent(id: string, caller: MemoryToolCaller): ReturnType<typeof getArchivedEvent> {
  const checkedCaller = assertOwner(assertPublicCallerHasNamespace(caller));
  const event = getArchivedEvent(id) ?? getStagedEvent(id);
  if (!event) return undefined;
  assertCanAccessNamespace(event.target.namespace, checkedCaller);
  return event;
}

export interface MemoryGetSourcesResult {
  projectionId?: string;
  observationId?: string;
  sourceEventCount: number;
  note?: string;
  sources?: Array<{ eventId: string; status: 'archived' | 'staged' | 'missing' | 'projection' | 'observation'; content: string | null; eventType?: string; createdAt?: number }>;
  projectionSource?: { eventId: string; status: 'projection'; content: string; eventType: 'memory.projection'; createdAt?: number };
  partial?: boolean;
}

export type MemoryGetSourcesInput =
  | string
  | {
    projectionId?: string;
    observationId?: string;
    kind?: 'projection' | 'observation';
  };

function observationNamespaceById(namespaceId: string, scope: ContextNamespace['scope']): ContextNamespace | undefined {
  const row = listContextNamespaces().find((candidate) => candidate.id === namespaceId);
  if (!row) return undefined;
  return {
    scope,
    projectId: row.projectId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    enterpriseId: row.orgId,
  };
}

function canAccessObservationNamespace(namespace: ContextNamespace | undefined, caller: AnyCaller): namespace is ContextNamespace {
  if (!namespace) return false;
  if (namespace.userId !== caller.userId) return false;
  if (isInternalCaller(caller)) return true;
  if (sameNamespace(namespace, caller.namespace)) return true;
  return namespace.scope === 'user_private'
    && caller.namespace.userId === caller.userId
    && namespace.userId === caller.userId
    && (!caller.namespace.projectId || namespace.projectId === caller.namespace.projectId);
}

function observationText(content: Record<string, unknown>): string {
  const text = content.text;
  if (typeof text === 'string' && text.trim()) return text.trim();
  return JSON.stringify(content);
}

function shouldUseProjectionFallback(sources: NonNullable<MemoryGetSourcesResult['sources']>): boolean {
  return sources.length === 0
    || sources.every((source) => source.content === null && source.status === 'missing');
}

function memoryGetObservationSources(observationId: string, caller: MemoryToolCaller): MemoryGetSourcesResult {
  const checkedCaller = assertOwner(assertPublicCallerHasNamespace(caller));
  const observation = getContextObservationById(observationId);
  const namespace = observation ? observationNamespaceById(observation.namespaceId, observation.scope) : undefined;
  if (!observation || !canAccessObservationNamespace(namespace, checkedCaller)) {
    return { observationId, sourceEventCount: 0, sources: [] };
  }
  const sourceId = observation.sourceEventIds[0] ?? `observation:${observation.id}`;
  return {
    observationId,
    sourceEventCount: Math.max(1, observation.sourceEventIds.length),
    sources: [{
      eventId: sourceId,
      status: 'observation',
      content: observationText(observation.content),
      eventType: `memory.observation.${observation.class}`,
      createdAt: observation.createdAt,
    }],
    partial: false,
  };
}

function resolveGetSourcesInput(input: MemoryGetSourcesInput): { projectionId?: string; observationId?: string } {
  if (typeof input === 'string') return { projectionId: input };
  const projectionId = typeof input.projectionId === 'string' && input.projectionId.trim() ? input.projectionId.trim() : undefined;
  const observationId = typeof input.observationId === 'string' && input.observationId.trim() ? input.observationId.trim() : undefined;
  if (input.kind === 'observation' && observationId) return { observationId };
  if (input.kind === 'projection' && projectionId) return { projectionId };
  return { projectionId, observationId };
}

export function memoryGetSources(input: MemoryGetSourcesInput, caller: MemoryToolCaller): MemoryGetSourcesResult {
  const resolved = resolveGetSourcesInput(input);
  if (resolved.observationId && !resolved.projectionId) {
    return memoryGetObservationSources(resolved.observationId, caller);
  }
  const projectionId = resolved.projectionId ?? '';
  const checkedCaller = assertOwner(assertPublicCallerHasNamespace(caller));
  const projection = getProcessedProjectionById(projectionId);
  if (!projection) return { projectionId, sourceEventCount: 0, sources: [] };
  if (!canAccessNamespace(projection.namespace, checkedCaller)) {
    // Fail closed and keep the response isomorphic with a missing projection.
    // Returning source counts here leaked whether another namespace had a
    // projection for a guessed id and how many raw events backed it.
    return { projectionId, sourceEventCount: 0, sources: [] };
  }
  const sources = listProjectionSources(projectionId).map((source) => {
    const event = canReturnEvent(source.event, checkedCaller) ? source.event : undefined;
    return {
      eventId: source.eventId,
      status: source.status,
      content: event?.content ?? null,
      eventType: event?.eventType,
      createdAt: event?.createdAt,
    };
  });
  const projectionSource = buildMemoryProjectionFallbackSource(projection);
  const fallback = shouldUseProjectionFallback(sources) ? projectionSource : undefined;
  const resolvedSources = fallback ? [fallback] : sources;
  return {
    projectionId,
    sourceEventCount: Math.max(projection.sourceEventIds.length, resolvedSources.length),
    sources: resolvedSources,
    ...(projectionSource ? { projectionSource } : {}),
    partial: !fallback && (sources.length !== projection.sourceEventIds.length || sources.some((source) => source.content === null)),
  };
}

export function chatSearchFts(query: string, caller: MemoryToolCaller): ReturnType<typeof searchArchiveFts>;
export function chatSearchFts(query: string, limit: number | undefined, caller: MemoryToolCaller): ReturnType<typeof searchArchiveFts>;
export function chatSearchFts(
  query: string,
  limitOrCaller: number | MemoryToolCaller | undefined,
  caller?: MemoryToolCaller,
): ReturnType<typeof searchArchiveFts> {
  const resolvedCaller = typeof limitOrCaller === 'object' ? limitOrCaller : caller;
  const checkedCaller = assertOwner(assertPublicCallerHasNamespace(resolvedCaller));
  const requestedLimit = typeof limitOrCaller === 'number'
    ? Math.max(1, Math.min(100, Math.floor(limitOrCaller)))
    : 20;
  return searchArchiveFts(query, requestedLimit, {
    namespace: checkedCaller.namespace,
    userId: checkedCaller.userId,
  });
}

// ── Internal-only owner-wide search (NOT exposed on public read-tool surface) ──
//
// May under-return because the underlying FTS path post-filters userId after
// a capped fetch (`searchArchiveFts` fetches `limit * 10` capped at 1000).
// This is intentionally a debug helper for the daemon process; do not wire
// it into MCP / RPC schemas. The CI grep guard enforces this.

export function _internalChatSearchFtsGlobal(
  query: string,
  limit: number | undefined,
  caller: InternalMemoryToolCaller,
): ReturnType<typeof searchArchiveFts> {
  const checkedCaller = assertOwner(caller);
  const requestedLimit = typeof limit === 'number'
    ? Math.max(1, Math.min(100, Math.floor(limit)))
    : 20;
  return searchArchiveFts(query, requestedLimit, {
    namespace: undefined,
    userId: checkedCaller.userId,
  });
}
