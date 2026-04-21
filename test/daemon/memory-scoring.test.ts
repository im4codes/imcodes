import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  computeRecencyBoost,
  computeFrequencyBoost,
  computeProjectBoost,
  computeRelevanceScore,
  normalizeMemoryScoringWeights,
  W_SIMILARITY,
  W_RECENCY,
  W_FREQUENCY,
  W_PROJECT,
  type MemoryScoringInput,
} from '../../shared/memory-scoring.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('memory-scoring', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('computeRecencyBoost', () => {
    it('returns ~1.0 for fresh (today) memory', () => {
      const now = Date.now();
      expect(computeRecencyBoost(now, 'recent_summary')).toBeCloseTo(1.0, 2);
      expect(computeRecencyBoost(now, 'durable_memory_candidate')).toBeCloseTo(1.0, 2);
    });

    it('returns ~0.5 for recent_summary at 14 days ago (one half-life)', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const fourteenDaysAgo = now - 14 * DAY_MS;
      expect(computeRecencyBoost(fourteenDaysAgo, 'recent_summary')).toBeCloseTo(0.5, 2);
    });

    it('returns ~0.5 for durable_memory_candidate at 90 days ago (one half-life)', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const ninetyDaysAgo = now - 90 * DAY_MS;
      expect(computeRecencyBoost(ninetyDaysAgo, 'durable_memory_candidate')).toBeCloseTo(0.5, 2);
    });

    it('returns values in [0, 1] for various ages', () => {
      const now = Date.now();
      for (const days of [0, 1, 7, 14, 30, 90, 365]) {
        const boost = computeRecencyBoost(now - days * DAY_MS, 'recent_summary');
        expect(boost).toBeGreaterThanOrEqual(0);
        expect(boost).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('computeFrequencyBoost', () => {
    it('returns 0 for 0 hits', () => {
      expect(computeFrequencyBoost(0)).toBe(0);
    });

    it('returns ~0.4 for 3 hits', () => {
      // log2(4) / 5 = 2 / 5 = 0.4
      expect(computeFrequencyBoost(3)).toBeCloseTo(0.4, 4);
    });

    it('returns ~0.6 for 7 hits', () => {
      // log2(8) / 5 = 3 / 5 = 0.6
      expect(computeFrequencyBoost(7)).toBeCloseTo(0.6, 4);
    });

    it('returns 1.0 for 31 hits (capped)', () => {
      // log2(32) / 5 = 5 / 5 = 1.0
      expect(computeFrequencyBoost(31)).toBe(1.0);
    });

    it('caps at 1.0 for very high hit counts', () => {
      expect(computeFrequencyBoost(1000)).toBe(1.0);
    });

    it('returns values in [0, 1] for any non-negative input', () => {
      for (const count of [0, 1, 2, 5, 10, 50, 100]) {
        const boost = computeFrequencyBoost(count);
        expect(boost).toBeGreaterThanOrEqual(0);
        expect(boost).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('computeProjectBoost', () => {
    it('returns 1.0 for same project', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-1',
      })).toBe(1.0);
    });

    it('returns 0.3 for same enterprise, different project', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-2',
        memoryEnterpriseId: 'ent-1',
        currentEnterpriseId: 'ent-1',
      })).toBe(0.3);
    });

    it('returns 0.1 for unrelated (different enterprise)', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-2',
        memoryEnterpriseId: 'ent-1',
        currentEnterpriseId: 'ent-2',
      })).toBe(0.1);
    });

    it('returns 0.1 when enterprise IDs are absent', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-2',
      })).toBe(0.1);
    });

    it('returns 0.1 when only one enterprise ID is present', () => {
      expect(computeProjectBoost({
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-2',
        memoryEnterpriseId: 'ent-1',
      })).toBe(0.1);
    });
  });

  describe('computeRelevanceScore', () => {
    it('same-project stale memory beats cross-project frequent memory', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Same-project, moderately similar, 10 days old, few hits
      const sameProjectStale: MemoryScoringInput = {
        similarity: 0.6,
        lastUsedAt: now - 10 * DAY_MS,
        hitCount: 2,
        projectionClass: 'recent_summary',
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-1',
      };

      // Cross-project, same similarity, very fresh, many hits, unrelated
      const crossProjectFrequent: MemoryScoringInput = {
        similarity: 0.6,
        lastUsedAt: now - 1 * DAY_MS,
        hitCount: 15,
        projectionClass: 'recent_summary',
        memoryProjectId: 'proj-2',
        currentProjectId: 'proj-1',
      };

      const sameProjectScore = computeRelevanceScore(sameProjectStale);
      const crossProjectScore = computeRelevanceScore(crossProjectFrequent);

      // Project affinity (0.2 * 0.9 = 0.18 boost) outweighs recency+frequency gap
      expect(sameProjectScore).toBeGreaterThan(crossProjectScore);
    });

    it('fresh high-similarity same-project yields highest score', () => {
      vi.useFakeTimers();
      const now = Date.now();

      const bestCase: MemoryScoringInput = {
        similarity: 0.85,
        lastUsedAt: now,
        hitCount: 2,
        projectionClass: 'recent_summary',
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-1',
      };

      const score = computeRelevanceScore(bestCase);
      // 0.4*0.85 + 0.25*1.0 + 0.15*log2(3)/5 + 0.2*1.0
      // = 0.34 + 0.25 + 0.04755 + 0.2 = ~0.8376
      expect(score).toBeCloseTo(0.8376, 2);
      expect(score).toBeGreaterThan(0.8);
    });

    it('all component scores are in [0, 1] range', () => {
      vi.useFakeTimers();
      const now = Date.now();

      const inputs: MemoryScoringInput[] = [
        { similarity: 0, lastUsedAt: now - 365 * DAY_MS, hitCount: 0, projectionClass: 'recent_summary', memoryProjectId: 'a', currentProjectId: 'b' },
        { similarity: 1, lastUsedAt: now, hitCount: 100, projectionClass: 'durable_memory_candidate', memoryProjectId: 'a', currentProjectId: 'a' },
        { similarity: 0.5, lastUsedAt: now - 14 * DAY_MS, hitCount: 3, projectionClass: 'recent_summary', memoryProjectId: 'a', currentProjectId: 'b', memoryEnterpriseId: 'e1', currentEnterpriseId: 'e1' },
      ];

      for (const input of inputs) {
        const recency = computeRecencyBoost(input.lastUsedAt, input.projectionClass);
        const frequency = computeFrequencyBoost(input.hitCount);
        const project = computeProjectBoost(input);

        expect(recency).toBeGreaterThanOrEqual(0);
        expect(recency).toBeLessThanOrEqual(1);
        expect(frequency).toBeGreaterThanOrEqual(0);
        expect(frequency).toBeLessThanOrEqual(1);
        expect(project).toBeGreaterThanOrEqual(0);
        expect(project).toBeLessThanOrEqual(1);
      }
    });

    it('total score is in [0, 1] since weights sum to 1.0', () => {
      // First verify weights sum to 1.0
      expect(W_SIMILARITY + W_RECENCY + W_FREQUENCY + W_PROJECT).toBeCloseTo(1.0, 10);

      vi.useFakeTimers();
      const now = Date.now();

      // Worst case: all minimums
      const worstCase: MemoryScoringInput = {
        similarity: 0,
        lastUsedAt: now - 10000 * DAY_MS,
        hitCount: 0,
        projectionClass: 'recent_summary',
        memoryProjectId: 'a',
        currentProjectId: 'b',
      };

      // Best case: all maximums
      const bestCase: MemoryScoringInput = {
        similarity: 1,
        lastUsedAt: now,
        hitCount: 31,
        projectionClass: 'durable_memory_candidate',
        memoryProjectId: 'a',
        currentProjectId: 'a',
      };

      const worstScore = computeRelevanceScore(worstCase);
      const bestScore = computeRelevanceScore(bestCase);

      expect(worstScore).toBeGreaterThanOrEqual(0);
      expect(worstScore).toBeLessThanOrEqual(1);
      expect(bestScore).toBeGreaterThanOrEqual(0);
      expect(bestScore).toBeLessThanOrEqual(1);

      // Best case should be very close to 1.0
      // 0.4*1 + 0.25*1 + 0.15*1 + 0.2*1 = 1.0
      expect(bestScore).toBeCloseTo(1.0, 2);
    });

    it('supports custom weights for advanced scoring configuration', () => {
      vi.useFakeTimers();
      const now = Date.now();
      const input: MemoryScoringInput = {
        similarity: 0.4,
        lastUsedAt: now,
        hitCount: 7,
        projectionClass: 'recent_summary',
        memoryProjectId: 'proj-1',
        currentProjectId: 'proj-2',
      };
      const score = computeRelevanceScore(input, {
        similarity: 0.1,
        recency: 0.6,
        frequency: 0.2,
        project: 0.1,
      });
      expect(score).toBeGreaterThan(computeRelevanceScore(input));
    });

    it('falls back per-field and renormalizes when some advanced weights are invalid', () => {
      expect(normalizeMemoryScoringWeights({
        similarity: Number.NaN,
        recency: -1,
        frequency: Number.NaN,
        project: -1,
      })).toEqual({
        similarity: 0.7273,
        recency: 0,
        frequency: 0.2727,
        project: 0,
      });
    });
  });
});
