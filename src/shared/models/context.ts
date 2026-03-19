export const OPENAI_CONTEXT_WINDOWS = {
  GPT_54: 1_050_000,
  GPT_5_FAMILY: 400_000,
  GPT_41_FAMILY: 1_000_000,
} as const;

/** Infer context window from model name when the provider doesn't send one explicitly. */
export function inferContextWindow(model?: string | null): number | undefined {
  const m = model?.toLowerCase().trim();
  if (!m) return undefined;

  if (/^gpt-5\.4(?:$|[-_.])/.test(m)) return OPENAI_CONTEXT_WINDOWS.GPT_54;

  if (
    /^gpt-5(?:$|[-_.])/.test(m) ||
    /^gpt-5\.[0-3](?:$|[-_.])/.test(m)
  ) {
    return OPENAI_CONTEXT_WINDOWS.GPT_5_FAMILY;
  }

  if (/^gpt-4\.1(?:$|[-_.])/.test(m)) return OPENAI_CONTEXT_WINDOWS.GPT_41_FAMILY;

  return undefined;
}

export function resolveContextWindow(explicit: number | undefined, model?: string | null, fallback = 1_000_000): number {
  return inferContextWindow(model) ?? explicit ?? fallback;
}
