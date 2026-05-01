import { describe, expect, it } from 'vitest';
import {
  consumeCitationCountRateLimit,
  deriveCitationIdempotencyKey,
  resetCitationCountRateLimiterForTests,
} from '../../server/src/memory/citation.js';

describe('memory cite-count replay contract', () => {
  it('derives stable authoritative idempotency keys from scope, projection, and citing message', () => {
    const first = deriveCitationIdempotencyKey({
      scopeNamespace: 'org_shared:ent-1:repo',
      projectionId: 'projection-1',
      citingMessageId: 'message-1',
    });
    const replay = deriveCitationIdempotencyKey({
      scopeNamespace: 'org_shared:ent-1:repo',
      projectionId: 'projection-1',
      citingMessageId: 'message-1',
    });
    const differentMessage = deriveCitationIdempotencyKey({
      scopeNamespace: 'org_shared:ent-1:repo',
      projectionId: 'projection-1',
      citingMessageId: 'message-2',
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(replay).toBe(first);
    expect(differentMessage).not.toBe(first);
  });

  it('bounds count pumping with a per-user/projection rate limiter', () => {
    resetCitationCountRateLimiterForTests();
    process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT = '1';
    process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT_WINDOW_MS = '1000';
    try {
      expect(consumeCitationCountRateLimit({
        userId: 'user-1',
        projectionId: 'projection-1',
        now: 1000,
      }).allowed).toBe(true);
      expect(consumeCitationCountRateLimit({
        userId: 'user-1',
        projectionId: 'projection-1',
        now: 1001,
      }).allowed).toBe(false);
      expect(consumeCitationCountRateLimit({
        userId: 'user-1',
        projectionId: 'projection-1',
        now: 2500,
      }).allowed).toBe(true);
    } finally {
      delete process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT;
      delete process.env.IMCODES_MEM_CITATION_COUNT_RATE_LIMIT_WINDOW_MS;
      resetCitationCountRateLimiterForTests();
    }
  });
});
