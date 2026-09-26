/** Shared cross-vendor handoff contract and bounded configuration. */
export const CROSS_VENDOR_HANDOFF_DEFAULTS = {
  enabled: true,
  maxTokens: 3000,
  hardMaxTokens: 6000,
  recentTurns: 10,
  timeoutMs: 3000,
  providerWaitMs: 2000,
  includeToolPreviews: false,
} as const;

export const CROSS_VENDOR_HANDOFF_HEADINGS = {
  title: 'IM.codes cross-vendor handoff',
  notice: 'Non-authoritative prior context; verify against the worktree and current tools.',
  goal: 'Goal and open TODOs',
  facts: 'Facts, decisions and constraints',
  turns: 'Recent completed turns',
  tools: 'Tool activity',
  work: 'Work state pointers',
  metadata: 'Switch metadata',
} as const;

export interface CrossVendorHandoffConfig {
  enabled: boolean;
  maxTokens: number;
  recentTurns: number;
  timeoutMs: number;
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

export function normalizeCrossVendorHandoffConfig(input?: Partial<CrossVendorHandoffConfig> | null): CrossVendorHandoffConfig {
  const maxTokens = Number.isFinite(input?.maxTokens) ? Math.trunc(input!.maxTokens!) : CROSS_VENDOR_HANDOFF_DEFAULTS.maxTokens;
  return {
    enabled: input?.enabled !== false,
    maxTokens: Math.max(1, Math.min(CROSS_VENDOR_HANDOFF_DEFAULTS.hardMaxTokens, maxTokens)),
    recentTurns: Math.max(1, Math.min(100, Math.trunc(input?.recentTurns ?? CROSS_VENDOR_HANDOFF_DEFAULTS.recentTurns))),
    timeoutMs: Math.max(250, Math.min(30_000, Math.trunc(input?.timeoutMs ?? CROSS_VENDOR_HANDOFF_DEFAULTS.timeoutMs))),
    includeToolPreviews: input?.includeToolPreviews === true,
  };
}
