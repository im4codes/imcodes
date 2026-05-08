import { createHash } from 'node:crypto';

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
