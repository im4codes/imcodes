/** Shared cross-vendor handoff contract and bounded configuration. */
export const CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS = {
  recentTurns: { min: 0, max: 200 },
  summaryLimit: { min: 0, max: 200 },
  maxChars: { min: 500, max: 500_000 },
} as const;

export const CROSS_VENDOR_HANDOFF_DEFAULTS = {
  enabled: true,
  maxTokens: 50000,
  hardMaxTokens: 50000,
  recentTurns: 100,
  summaryLimit: 20,
  maxChars: 128_000,
  maxTextChars: 1200,
  timeoutMs: 3000,
  providerWaitMs: 2000,
  includeToolPreviews: false,
} as const;

export const CROSS_VENDOR_HANDOFF_HEADINGS = {
  title: 'IM.codes cross-vendor handoff',
  notice: 'Non-authoritative prior context; verify against the worktree and current tools.',
  goal: 'Goal and open TODOs',
  facts: 'Facts, decisions and constraints',
  summaries: 'Recent session summaries',
  turns: 'Recent completed turns',
  tools: 'Tool activity',
  work: 'Work state pointers',
  metadata: 'Switch metadata',
} as const;

export interface CrossVendorHandoffConfig {
  enabled: boolean;
  maxTokens: number;
  recentTurns: number;
  summaryLimit: number;
  maxChars: number;
  timeoutMs: number;
  /** Maximum time the first target turn waits for the async pack. */
  providerWaitMs: number;
  includeToolPreviews: boolean;
}

export interface CrossVendorHandoffCutoff {
  epoch: number;
  seq: number;
  ts: number;
}

export interface CrossVendorHandoffPack {
  text: string;
  sourceAgentType: string;
  sourceRuntimeType: 'process' | 'transport';
  sourceConversationKey?: string;
  cutoff: CrossVendorHandoffCutoff;
  createdAt: number;
  tokenCount: number;
}

export interface CrossVendorHandoffSessionState {
  config?: Partial<CrossVendorHandoffConfig>;
  /** Last cutoff delivered to each provider/runtime key. */
  cutoffs?: Record<string, CrossVendorHandoffCutoff>;
  /** A bounded pack waiting for the next ordinary turn. */
  pending?: CrossVendorHandoffPack;
}

export function beginCrossVendorHandoffState(
  existing: CrossVendorHandoffSessionState | undefined,
  config: CrossVendorHandoffConfig,
  sourceAgentType: string,
  cutoff: CrossVendorHandoffCutoff,
): CrossVendorHandoffSessionState {
  return {
    ...(existing ?? {}),
    config,
    // A new switch supersedes any pack built for the previous target. Keeping
    // it would let a timeout on B leak stale context into C after restart.
    pending: undefined,
    cutoffs: { ...(existing?.cutoffs ?? {}), [sourceAgentType]: cutoff },
  };
}

export function isCrossVendorHandoffLaunchCurrent(input: {
  expectedGeneration: number;
  currentGeneration: number | undefined;
  currentAgentType: string | undefined;
  targetAgentType: string;
}): boolean {
  return input.currentGeneration === input.expectedGeneration
    && input.currentAgentType === input.targetAgentType;
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.max(min, Math.min(max, n));
}

export function normalizeCrossVendorHandoffConfig(input?: Partial<CrossVendorHandoffConfig> | null): CrossVendorHandoffConfig {
  const maxTokens = Number.isFinite(input?.maxTokens) ? Math.trunc(input!.maxTokens!) : CROSS_VENDOR_HANDOFF_DEFAULTS.maxTokens;
  return {
    enabled: input?.enabled !== false,
    maxTokens: Math.max(1, Math.min(CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens, maxTokens)),
    recentTurns: clampInt(
      input?.recentTurns,
      CROSS_VENDOR_HANDOFF_DEFAULTS.recentTurns,
      CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.recentTurns.min,
      CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.recentTurns.max,
    ),
    summaryLimit: clampInt(
      input?.summaryLimit,
      CROSS_VENDOR_HANDOFF_DEFAULTS.summaryLimit,
      CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.summaryLimit.min,
      CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.summaryLimit.max,
    ),
    maxChars: clampInt(
      input?.maxChars,
      CROSS_VENDOR_HANDOFF_DEFAULTS.maxChars,
      CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.maxChars.min,
      CROSS_VENDOR_HANDOFF_LIMIT_BOUNDS.maxChars.max,
    ),
    timeoutMs: Math.max(250, Math.min(30_000, Math.trunc(input?.timeoutMs ?? CROSS_VENDOR_HANDOFF_DEFAULTS.timeoutMs))),
    providerWaitMs: Math.max(0, Math.min(CROSS_VENDOR_HANDOFF_DEFAULTS.timeoutMs, Math.trunc(input?.providerWaitMs ?? CROSS_VENDOR_HANDOFF_DEFAULTS.providerWaitMs))),
    includeToolPreviews: input?.includeToolPreviews === true,
  };
}
