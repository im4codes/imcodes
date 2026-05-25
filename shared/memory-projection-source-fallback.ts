import type { MemoryOrigin } from './memory-origin.js';
import { projectionSemanticContent } from './memory-content-hash.js';

export interface MemoryProjectionFallbackInput {
  id: string;
  sourceEventIds?: readonly string[];
  summary?: string | null;
  content?: unknown;
  origin?: MemoryOrigin | string | null;
  createdAt?: number;
}

export interface MemoryProjectionFallbackSource {
  eventId: string;
  status: 'projection';
  content: string;
  eventType: 'memory.projection';
  createdAt?: number;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Returns a model-visible source snippet from the projection itself when raw
 * source events are unavailable. This is intentionally conservative: it uses
 * semantic content fields (`text` / `summary`) or the projection summary, and
 * does not stringify arbitrary content_json metadata.
 */
export function buildMemoryProjectionFallbackSource(
  projection: MemoryProjectionFallbackInput | undefined | null,
): MemoryProjectionFallbackSource | undefined {
  if (!projection) return undefined;
  const semanticContent = projectionSemanticContent(projection.content);
  const contentRecord = semanticContent && typeof semanticContent === 'object' && !Array.isArray(semanticContent)
    ? semanticContent as Record<string, unknown>
    : undefined;
  const text = firstNonEmptyString(
    contentRecord?.text,
    contentRecord?.summary,
    projection.summary,
  );
  if (!text) return undefined;
  return {
    eventId: projection.sourceEventIds?.[0] ?? `projection:${projection.id}`,
    status: 'projection',
    content: text,
    eventType: 'memory.projection',
    createdAt: projection.createdAt,
  };
}
