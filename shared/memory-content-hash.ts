import { createHash } from 'node:crypto';

import { redactSensitiveText } from './redact-secrets.js';

const PROJECTION_SYSTEM_METADATA_KEYS = new Set([
  'ownerUserId',
  'ownedByUserId',
  'createdByUserId',
  'updatedByUserId',
  'authorUserId',
]);

export function stableJson(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

/**
 * Projection content may carry trusted management metadata used for owner /
 * creator authorization. That metadata is not semantic memory content: it must
 * not affect citation drift hashes, embedding sources, recall matching, or
 * other model-visible payloads.
 *
 * Only top-level reserved keys are stripped. Nested fields remain caller data.
 */
export function projectionSemanticContent(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
  const record = content as Record<string, unknown>;
  let stripped = false;
  const semantic: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (PROJECTION_SYSTEM_METADATA_KEYS.has(key)) {
      stripped = true;
      continue;
    }
    semantic[key] = value;
  }
  return stripped ? semantic : content;
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function computeProjectionContentHash(input: { summary: string; content: unknown }): string {
  return sha256Text(`projection-content:v1:${input.summary.trim()}\n${stableJson(projectionSemanticContent(input.content))}`);
}

/**
 * Maximum characters of a projection's redacted summary+content used as the
 * embedding source text. Keep in lockstep with the recall reader's slice
 * (memory-search.ts `itemEmbedText`).
 */
export const PROJECTION_EMBED_SOURCE_MAX_CHARS = 500;

/**
 * Derive the EXACT text that the L3 semantic-recall reader embeds (and stores
 * as `embedding_source`) for a "processed" projection candidate.
 *
 * SINGLE SOURCE OF TRUTH for the embed-source derivation. The recall reader
 * (memory-search.ts) builds its candidate text the same way:
 *   1. `content` = `JSON.stringify(projectionSemanticContent(content))` ONLY
 *      when the semantic content is a non-array object, else the empty string
 *      (mirrors `projectionToItem`, which leaves `item.content` undefined and
 *      the reader coalesces `item.content ?? ''`).
 *   2. `redactSensitiveText(`${summary} ${content}`, extraRedactPatterns)`.
 *   3. `.slice(0, PROJECTION_EMBED_SOURCE_MAX_CHARS)`.
 *
 * The write-time persistence path MUST call this so the persisted
 * `embedding_source` is byte-identical to what recall compares against;
 * otherwise recall treats the stored vector as stale and recomputes it,
 * defeating the persistence. Producer and consumer share this one function —
 * never copy the formula.
 */
export function projectionEmbedSourceText(
  summary: string,
  content: unknown,
  extraRedactPatterns: RegExp[] = [],
): string {
  const semantic = projectionSemanticContent(content);
  const contentStr = semantic && typeof semantic === 'object' && !Array.isArray(semantic)
    ? JSON.stringify(semantic)
    : '';
  return composeEmbedSourceText(summary, contentStr, extraRedactPatterns);
}

/**
 * Lower-level embed-source composition from an ALREADY-stringified content
 * string — the form carried by `MemorySearchResultItem.content`. The L3 worker
 * rerank and the recall reader both hold pre-stringified content, so they call
 * this directly; the write-time persistence path derives `contentStr` first via
 * {@link projectionEmbedSourceText}. ONE redaction+slice formula shared by the
 * producer (write time), the consumer (recall reader), and the worker rerank.
 */
export function composeEmbedSourceText(
  summary: string,
  contentStr: string,
  extraRedactPatterns: RegExp[] = [],
): string {
  return redactSensitiveText(`${summary} ${contentStr}`, extraRedactPatterns)
    .slice(0, PROJECTION_EMBED_SOURCE_MAX_CHARS);
}
