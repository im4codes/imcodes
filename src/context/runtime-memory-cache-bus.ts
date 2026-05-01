import type { ContextNamespace } from '../../shared/context-types.js';
import { incrementCounter } from '../util/metrics.js';

export type RuntimeMemoryCacheInvalidationEvent =
  | { kind: 'preference'; userId: string }
  | { kind: 'observation'; observationId: string; namespace?: ContextNamespace }
  | { kind: 'md_ingest'; projectDir: string; namespace: ContextNamespace }
  | { kind: 'skill_registry' };

type Listener = (event: RuntimeMemoryCacheInvalidationEvent) => void;

const listeners = new Set<Listener>();

export function subscribeRuntimeMemoryCacheInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishRuntimeMemoryCacheInvalidation(event: RuntimeMemoryCacheInvalidationEvent): void {
  incrementCounter('mem.cache.invalidate_published', { kind: event.kind });
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // Cache invalidation is best-effort and must never block management mutation responses.
    }
  }
}
