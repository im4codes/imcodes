import logger from './logger.js';

const emittedBuckets = new Set<string>();
const HOUR_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 5000;

export function warnOncePerHour(signature: string, payload: Record<string, unknown> = {}, now = Date.now()): boolean {
  const hourBucket = Math.floor(now / HOUR_MS);
  const key = `${signature}:${hourBucket}`;
  if (emittedBuckets.has(key)) return false;
  if (emittedBuckets.size >= MAX_BUCKETS) emittedBuckets.clear();
  emittedBuckets.add(key);
  logger.warn({ signature, ...payload }, 'rate-limited warning');
  return true;
}

export function resetRateLimitedWarnForTests(): void {
  emittedBuckets.clear();
}
