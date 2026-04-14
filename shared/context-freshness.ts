import type { ContextFreshness } from './context-types.js';

export function classifyTimestampFreshness(
  updatedAt: number | null | undefined,
  now: number,
  maxAgeMs: number,
): ContextFreshness {
  if (!Number.isFinite(updatedAt)) return 'missing';
  return now - Number(updatedAt) <= maxAgeMs ? 'fresh' : 'stale';
}
