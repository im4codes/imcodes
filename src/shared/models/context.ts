export const OPENAI_CONTEXT_WINDOWS = {
  GPT_55: 922_000,
  GPT_54: 1_000_000,
  GPT_5_FAMILY: 400_000,
  GPT_41_FAMILY: 1_000_000,
} as const;

export const CLAUDE_CONTEXT_WINDOWS = {
  OPUS_1M_ALIAS: 1_000_000,
  OPUS_4_FAMILY: 1_000_000,
  SONNET_4_FAMILY: 1_000_000,
  HAIKU_4_FAMILY: 200_000,
  CLAUDE_3_FAMILY: 200_000,
} as const;

export const QWEN_CONTEXT_WINDOWS = {
  CODER_MODEL: 1_000_000,
  QWEN35_PLUS: 1_000_000,
  QWEN3_CODER_PLUS: 1_000_000,
  QWEN3_CODER_NEXT: 262_144,
  QWEN3_MAX: 262_144,
  GLM_47: 202_752,
  GLM_5: 202_752,
  MINIMAX_M25: 196_608,
  KIMI_K25: 262_144,
} as const;

function isGpt55Model(model: string): boolean {
  return /^gpt[-_ ]?5\.5(?:$|[-_.\s(])/.test(model);
}

function isGpt54Model(model: string): boolean {
  return /^gpt[-_ ]?5\.4(?:$|[-_.\s(])/.test(model);
}

/** Infer context window from model name when the provider doesn't send one explicitly. */
export function inferContextWindow(model?: string | null): number | undefined {
  const m = model?.toLowerCase().trim();
  if (!m) return undefined;

  if (isGpt55Model(m)) return OPENAI_CONTEXT_WINDOWS.GPT_55;
  if (isGpt54Model(m)) return OPENAI_CONTEXT_WINDOWS.GPT_54;

  if (
    /^gpt-5(?:$|[-_.])/.test(m) ||
    /^gpt-5\.[0-3](?:$|[-_.])/.test(m)
  ) {
    return OPENAI_CONTEXT_WINDOWS.GPT_5_FAMILY;
  }

  if (/^gpt-4\.1(?:$|[-_.])/.test(m)) return OPENAI_CONTEXT_WINDOWS.GPT_41_FAMILY;

  if (m == 'opus[1m]') return CLAUDE_CONTEXT_WINDOWS.OPUS_1M_ALIAS;
  if (/^claude-opus-4(?:$|[-_.])/.test(m)) return CLAUDE_CONTEXT_WINDOWS.OPUS_4_FAMILY;
  if (m == 'sonnet') return CLAUDE_CONTEXT_WINDOWS.SONNET_4_FAMILY;
  if (/^claude-sonnet-4(?:$|[-_.])/.test(m)) return CLAUDE_CONTEXT_WINDOWS.SONNET_4_FAMILY;
  if (m == 'haiku') return CLAUDE_CONTEXT_WINDOWS.HAIKU_4_FAMILY;
  if (/^claude-haiku-4(?:$|[-_.])/.test(m)) return CLAUDE_CONTEXT_WINDOWS.HAIKU_4_FAMILY;
  if (/^claude-3(?:[.-]|$)/.test(m)) return CLAUDE_CONTEXT_WINDOWS.CLAUDE_3_FAMILY;

  if (/^coder-model$/.test(m)) return QWEN_CONTEXT_WINDOWS.CODER_MODEL;
  if (/^qwen3\.5-plus(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.QWEN35_PLUS;
  if (/^qwen3-coder-plus(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.QWEN3_CODER_PLUS;
  if (/^qwen3-coder-next(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.QWEN3_CODER_NEXT;
  if (/^qwen3-max(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.QWEN3_MAX;
  if (/^glm-4\.7(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.GLM_47;
  if (/^glm-5(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.GLM_5;
  if (/^minimax-m2\.5(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.MINIMAX_M25;
  if (/^kimi-k2\.5(?:$|[-_.])/.test(m)) return QWEN_CONTEXT_WINDOWS.KIMI_K25;

  return undefined;
}

export interface ResolveContextWindowOptions {
  /**
   * Some providers report the actual live window for the current turn/session.
   * Prefer that value over model-family inference when the event explicitly
   * marks the context window as provider-sourced. Keep the historical default
   * of model inference first for older watcher events whose explicit value may
   * be a stale preset/fallback.
   */
  preferExplicit?: boolean;
}

function validExplicitContextWindow(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isKnownStaleProviderContextWindow(
  model: string | null | undefined,
  explicit: number,
  inferred: number | undefined,
): boolean {
  if (inferred === undefined) return false;
  const m = model?.toLowerCase().trim();
  if (!m) return false;
  // Codex/app-server can report transport fallback windows for GPT-5.5
  // sessions (seen as 258400 and 1000000) even when the selected IM.codes
  // model is GPT-5.5. GPT-5.5's product limit is fixed at 922k for this UI
  // contract, so any provider-sourced mismatch must not drive the ctx meter.
  return isGpt55Model(m) && explicit !== inferred;
}

export function resolveContextWindow(
  explicit: number | undefined,
  model?: string | null,
  fallback = 1_000_000,
  options: ResolveContextWindowOptions = {},
): number {
  const safeExplicit = validExplicitContextWindow(explicit);
  const inferred = inferContextWindow(model);
  if (options.preferExplicit && safeExplicit !== undefined) {
    if (isKnownStaleProviderContextWindow(model, safeExplicit, inferred)) return inferred!;
    return safeExplicit;
  }
  return inferred ?? safeExplicit ?? fallback;
}
