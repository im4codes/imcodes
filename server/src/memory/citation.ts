import type { Env } from '../env.js';
import { sha256Text } from '../../../shared/memory-content-hash.js';
export {
  computeProjectionContentHash,
  sha256Text,
  stableJson,
} from '../../../shared/memory-content-hash.js';

const DEFAULT_CITATION_COUNT_RATE_LIMIT = 30;
const DEFAULT_CITATION_COUNT_RATE_LIMIT_WINDOW_MS = 60_000;
const CITATION_COUNT_RATE_LIMIT_ENV = 'IMCODES_MEM_CITATION_COUNT_RATE_LIMIT';
const CITATION_COUNT_RATE_LIMIT_WINDOW_ENV = 'IMCODES_MEM_CITATION_COUNT_RATE_LIMIT_WINDOW_MS';

type CitationCountBucket = {
  windowStartedAt: number;
  count: number;
};

const citationCountBuckets = new Map<string, CitationCountBucket>();

export function deriveCitationIdempotencyKey(input: {
  scopeNamespace: string;
  projectionId: string;
  citingMessageId: string;
}): string {
  return sha256Text(`cite:v1:${input.scopeNamespace}:${input.projectionId}:${input.citingMessageId}`);
}

function readPositiveIntegerEnv(env: Env | undefined, key: string, fallback: number): number {
  const raw = (env as unknown as Record<string, string | undefined> | undefined)?.[key] ?? process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getCitationCountRateLimit(env?: Env): {
  maxCount: number;
  windowMs: number;
} {
  return {
    maxCount: readPositiveIntegerEnv(env, CITATION_COUNT_RATE_LIMIT_ENV, DEFAULT_CITATION_COUNT_RATE_LIMIT),
    windowMs: readPositiveIntegerEnv(env, CITATION_COUNT_RATE_LIMIT_WINDOW_ENV, DEFAULT_CITATION_COUNT_RATE_LIMIT_WINDOW_MS),
  };
}

export function consumeCitationCountRateLimit(input: {
  env?: Env;
  userId: string;
  projectionId: string;
  now: number;
}): { allowed: boolean; remaining: number; resetAt: number } {
  const { maxCount, windowMs } = getCitationCountRateLimit(input.env);
  const bucketKey = `${input.userId}\u0000${input.projectionId}`;
  const existing = citationCountBuckets.get(bucketKey);
  const bucket = existing && input.now - existing.windowStartedAt < windowMs
    ? existing
    : { windowStartedAt: input.now, count: 0 };
  if (bucket.count >= maxCount) {
    citationCountBuckets.set(bucketKey, bucket);
    return {
      allowed: false,
      remaining: 0,
      resetAt: bucket.windowStartedAt + windowMs,
    };
  }
  bucket.count += 1;
  citationCountBuckets.set(bucketKey, bucket);

  for (const [key, value] of citationCountBuckets.entries()) {
    if (input.now - value.windowStartedAt >= windowMs * 2) citationCountBuckets.delete(key);
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxCount - bucket.count),
    resetAt: bucket.windowStartedAt + windowMs,
  };
}

export function resetCitationCountRateLimiterForTests(): void {
  citationCountBuckets.clear();
}
