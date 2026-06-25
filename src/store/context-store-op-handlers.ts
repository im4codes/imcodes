/**
 * Shared context-store op→handler dispatch map.
 *
 * Built ONCE here and used by BOTH:
 *  - the context-store worker (`context-store-worker.ts`) to serve RPCs as the
 *    single long-lived DB owner, and
 *  - the worker-client (`context-store-worker-client.ts`) as the BOUNDED
 *    in-process COLD fallback that runs only when the worker is not yet ready
 *    (the brief startup window before `whenReady`, unit tests that never spawn
 *    the worker, and the short-lived CLI) — never in steady-state daemon
 *    production, where the worker is eagerly warmed and owns every call.
 *
 * Keeping a SINGLE builder guarantees the worker and the cold fallback dispatch
 * the SAME allowlisted op to the SAME store function — no drift, and never a raw
 * `store[arbitrary]` proxy (the map is bounded by the shared RPC allowlist, per
 * design Decision 1 / "Worker RPC registry allowlist").
 *
 * Importing `context-store.js` here is intentional and is the worker/facade
 * dispatch layer — it is one of the small, enumerated allowlisted importers in
 * `scripts/lint-no-sync-context-store.mjs` (the daemon CALLER modules reach the
 * store ONLY through the async client, never this builder or `context-store`
 * directly).
 */
import * as store from './context-store.js';
import {
  searchLocalMemoryBounded,
  searchLocalMemorySemanticBounded,
  selectStartupMemoryBounded,
  searchLocalMemoryAuthorizedBounded,
} from '../context/memory-recall-bounded.js';
import { CONTEXT_STORE_L1_OPS } from '../../shared/context-store-rpc.js';

export type ContextStoreOpHandler = (args: unknown[]) => unknown;

export interface ContextStoreOpHandlerMap {
  handlers: Map<string, ContextStoreOpHandler>;
  /** Allowlisted L1 ops with no callable store export (registry drift) — the
   *  worker logs these; a call to one returns `unsupported_operation`. */
  missingL1Ops: string[];
}

/**
 * Build the allowlisted op→handler map: L1 wrappers auto-resolved from the
 * store module by the shared allowlist, plus the explicit L2 (aggregate), L3
 * front-of-turn recall, and R5 management recall orchestration handlers.
 */
export function buildContextStoreOpHandlers(): ContextStoreOpHandlerMap {
  const handlers = new Map<string, ContextStoreOpHandler>();
  const missingL1Ops: string[] = [];
  const storeRecord = store as unknown as Record<string, unknown>;
  for (const op of CONTEXT_STORE_L1_OPS) {
    const fn = storeRecord[op];
    if (typeof fn === 'function') {
      handlers.set(op, (args) => (fn as (...a: unknown[]) => unknown)(...args));
    } else {
      missingL1Ops.push(op);
    }
  }

  // L3/R5 bounded recall orchestration. The whole collect + rank + redact + slice
  // runs here; only <=limit items + bounded stats cross back. L3 callers default
  // to high priority; R5 management callers default/override to normal priority.
  handlers.set('searchLocalMemoryBounded', (args) =>
    searchLocalMemoryBounded(args[0] as Parameters<typeof searchLocalMemoryBounded>[0]),
  );
  handlers.set('searchLocalMemorySemanticBounded', (args) =>
    searchLocalMemorySemanticBounded(
      args[0] as Parameters<typeof searchLocalMemorySemanticBounded>[0],
      args[1] as Float32Array,
      args[2] as RegExp[],
      args[3] as Parameters<typeof searchLocalMemorySemanticBounded>[3],
    ),
  );
  handlers.set('selectStartupMemoryBounded', (args) =>
    selectStartupMemoryBounded(
      args[0] as Parameters<typeof selectStartupMemoryBounded>[0],
      args[1] as Parameters<typeof selectStartupMemoryBounded>[1],
    ),
  );
  handlers.set('searchLocalMemoryAuthorizedBounded', (args) =>
    searchLocalMemoryAuthorizedBounded(
      args[0] as Parameters<typeof searchLocalMemoryAuthorizedBounded>[0],
    ),
  );

  // L2 — aggregate / single-transaction orchestration handlers.
  handlers.set('commitMaterialization', (args) =>
    store.commitMaterialization(args[0] as Parameters<typeof store.commitMaterialization>[0]),
  );
  handlers.set('ingestContextEvent', (args) =>
    store.ingestContextEvent(
      args[0] as Parameters<typeof store.ingestContextEvent>[0],
      args[1] as Parameters<typeof store.ingestContextEvent>[1],
    ),
  );

  return { handlers, missingL1Ops };
}
