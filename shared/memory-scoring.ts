/**
 * Memory relevance scoring — composite additive score for recall ranking.
 *
 * score = 0.4*similarity + 0.25*recencyBoost + 0.15*frequencyBoost + 0.2*projectBoost
 */

// Weights
export const W_SIMILARITY = 0.4;
export const W_RECENCY = 0.25;
export const W_FREQUENCY = 0.15;
export const W_PROJECT = 0.2;

// Half-lives in days
export const HALF_LIFE_RECENT_SUMMARY = 14;
export const HALF_LIFE_DURABLE_CANDIDATE = 90;

export type ProjectionClass = 'recent_summary' | 'durable_memory_candidate';

export interface MemoryScoringInput {
  /** Cosine similarity or pg_trgm similarity, range [0, 1] */
  similarity: number;
  /** Timestamp of last recall (last_used_at), or updated_at if never recalled */
  lastUsedAt: number;
  /** Number of times this memory has been recalled */
  hitCount: number;
  /** Projection class — determines half-life */
  projectionClass: ProjectionClass;
  /** Project ID of the memory item */
  memoryProjectId: string;
  /** Project ID of the current session/query context */
  currentProjectId: string;
  /** Enterprise ID of the memory item (if any) */
  memoryEnterpriseId?: string;
  /** Enterprise ID of the current context (if any) */
  currentEnterpriseId?: string;
}

/**
 * Compute recency boost using exponential decay from last_used_at.
 * Every recall resets the decay clock (spaced repetition effect).
 */
export function computeRecencyBoost(lastUsedAt: number, projectionClass: ProjectionClass): number {
  const ageDays = Math.max(0, (Date.now() - lastUsedAt) / (24 * 60 * 60 * 1000));
  const halfLife = projectionClass === 'durable_memory_candidate'
    ? HALF_LIFE_DURABLE_CANDIDATE
    : HALF_LIFE_RECENT_SUMMARY;
  return Math.exp(-ageDays * Math.LN2 / halfLife);
}

/**
 * Compute frequency boost from hit count, normalized to [0, 1].
 * Uses log2 to prevent linear scaling — diminishing returns after many hits.
 */
export function computeFrequencyBoost(hitCount: number): number {
  return Math.min(1, Math.log2(1 + hitCount) / 5);
}

/**
 * Compute project affinity boost.
 * Same project = 1.0, same enterprise = 0.3, unrelated = 0.1.
 */
export function computeProjectBoost(input: Pick<MemoryScoringInput, 'memoryProjectId' | 'currentProjectId' | 'memoryEnterpriseId' | 'currentEnterpriseId'>): number {
  if (input.memoryProjectId === input.currentProjectId) return 1.0;
  if (input.memoryEnterpriseId && input.currentEnterpriseId && input.memoryEnterpriseId === input.currentEnterpriseId) return 0.3;
  return 0.1;
}

/**
 * Compute the full composite relevance score.
 */
export function computeRelevanceScore(input: MemoryScoringInput): number {
  const recency = computeRecencyBoost(input.lastUsedAt, input.projectionClass);
  const frequency = computeFrequencyBoost(input.hitCount);
  const project = computeProjectBoost(input);
  return W_SIMILARITY * input.similarity + W_RECENCY * recency + W_FREQUENCY * frequency + W_PROJECT * project;
}
