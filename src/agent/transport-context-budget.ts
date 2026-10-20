export const DEFAULT_TRANSPORT_CONTEXT_BUDGET_MS = 2_500;
const MIN_TRANSPORT_CONTEXT_BUDGET_MS = 50;
const MAX_TRANSPORT_CONTEXT_BUDGET_MS = 30_000;

export function readBoundedTimeoutMs(
  envName: string,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
  options?: { allowZero?: boolean },
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallbackMs;
  if (options?.allowZero && parsed === 0) return 0;
  if (parsed < minMs) return minMs;
  if (parsed > maxMs) return maxMs;
  return parsed;
}

/**
 * How long any single context/memory enrichment step (startup bootstrap, per-message recall)
 * may hold up the path it decorates. Lives outside `transport-session-runtime` so launch code
 * can share the budget without importing the whole runtime.
 */
export function getTransportContextBudgetMs(): number {
  return readBoundedTimeoutMs(
    'IMCODES_TRANSPORT_CONTEXT_BUDGET_MS',
    DEFAULT_TRANSPORT_CONTEXT_BUDGET_MS,
    MIN_TRANSPORT_CONTEXT_BUDGET_MS,
    MAX_TRANSPORT_CONTEXT_BUDGET_MS,
    { allowZero: false },
  );
}
