import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ContextNamespace, LocalContextEvent } from '../../shared/context-types.js';
import { serializeContextNamespace } from './context-keys.js';
import {
  getArchivedEvent,
  getProcessedProjectionById,
  getStagedEvent,
  listProjectionSources,
  searchArchiveFts,
} from '../store/context-store.js';

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
export interface MemoryToolCaller {
  userId: string;
  namespace: ContextNamespace;
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
  userId: string;
  /** Sentinel literal so the discriminator survives JSON round-trips in tests. */
  allowGlobalOwnerSearch: true;
}

type AnyCaller = MemoryToolCaller | InternalMemoryToolCaller;

function isInternalCaller(caller: AnyCaller): caller is InternalMemoryToolCaller {
  return (caller as InternalMemoryToolCaller).allowGlobalOwnerSearch === true;
}

function getBoundUserId(): string | undefined {
  const path = process.env.IMCODES_SERVER_CONFIG_PATH ?? join(homedir(), '.imcodes', 'server.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { userId?: string };
    return typeof parsed.userId === 'string' ? parsed.userId : undefined;
  } catch {
    return undefined;
  }
}

function forbidden(message = 'raw memory events are private to the originating user'): Error {
  const err = new Error(message);
  (err as Error & { code?: string }).code = 'IMCODES_MEMORY_FORBIDDEN';
  return err;
}

function assertOwner<T extends AnyCaller>(caller?: T): T {
  const boundUserId = getBoundUserId();
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
  projectionId: string;
  sourceEventCount: number;
  note?: string;
  sources?: Array<{ eventId: string; status: 'archived' | 'staged' | 'missing'; content: string | null; eventType?: string; createdAt?: number }>;
  partial?: boolean;
}

export function memoryGetSources(projectionId: string, caller: MemoryToolCaller): MemoryGetSourcesResult {
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
  return {
    projectionId,
    sourceEventCount: projection.sourceEventIds.length,
    sources,
    partial: sources.length !== projection.sourceEventIds.length || sources.some((source) => source.content === null),
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
