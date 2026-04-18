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

// ── Recall cap rule ────────────────────────────────────────────────────────
//
// Tuning rationale:
//   - MIN_FLOOR = 0.4 → still excludes pure project+recency noise
//     (same-project, fresh, never-recalled, similarity 0 scores only 0.425),
//     while keeping weaker-but-real multilingual semantic matches that
//     often land around 0.40–0.44 after composite scoring.
//   - DEFAULT_CAP = 3 → tight default; noise-resistant.
//   - EXTEND_BAR = 0.6, EXTEND_CAP = 5 → if the top 3 are ALL strong,
//     keep absorbing equally-strong items up to 5. Mediocre 4th items
//     do not get promoted.

export const RECALL_MIN_FLOOR = 0.4;
export const RECALL_DEFAULT_CAP = 3;
export const RECALL_EXTEND_BAR = 0.6;
export const RECALL_EXTEND_CAP = 5;

export interface RecallCapOptions {
  minFloor?: number;
  defaultCap?: number;
  extendBar?: number;
  extendCap?: number;
}

/**
 * Apply the recall cap rule to a list of scored candidates.
 *
 * Input SHOULD already be sorted by `score` descending; if not, this
 * function sorts defensively without mutating the caller's array.
 *
 * Rule:
 *   1. Drop anything with `score < minFloor` (default 0.4).
 *   2. Take the first `defaultCap` (default 3).
 *   3. If those `defaultCap` are ALL at or above `extendBar` (default 0.6),
 *      keep absorbing subsequent items that are also at or above `extendBar`,
 *      up to `extendCap` items total (default 5).
 */
export function applyRecallCapRule<T extends { score: number }>(
  scored: readonly T[],
  options: RecallCapOptions = {},
): T[] {
  const minFloor = options.minFloor ?? RECALL_MIN_FLOOR;
  const defaultCap = options.defaultCap ?? RECALL_DEFAULT_CAP;
  const extendBar = options.extendBar ?? RECALL_EXTEND_BAR;
  const extendCap = options.extendCap ?? RECALL_EXTEND_CAP;

  // Defensive sort copy — callers that already sort pay only O(n) scan.
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  const floored = sorted.filter((item) => item.score >= minFloor);
  if (floored.length === 0) return [];

  const base = floored.slice(0, defaultCap);
  if (base.length < defaultCap) return base;

  const allStrong = base.every((item) => item.score >= extendBar);
  if (!allStrong) return base;

  const extended: T[] = [...base];
  for (let i = defaultCap; i < floored.length && extended.length < extendCap; i++) {
    const candidate = floored[i];
    if (candidate.score < extendBar) break;
    extended.push(candidate);
  }
  return extended;
}
