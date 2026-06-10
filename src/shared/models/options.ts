// `fable` = Claude Fable 5 (Mythos-class, GA 2026-06-09) — Anthropic's most
// capable widely released model, the new top tier above Opus. Listed first so
// the picker surfaces the strongest model at the top.
export const CLAUDE_CODE_MODEL_IDS = ['fable', 'opus[1M]', 'sonnet', 'haiku'] as const;
export type ClaudeCodeModelId = typeof CLAUDE_CODE_MODEL_IDS[number];

export function normalizeClaudeCodeModelId(value: string | null | undefined): ClaudeCodeModelId | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'opus') return 'opus[1M]';
  if (CLAUDE_CODE_MODEL_IDS.includes(trimmed as ClaudeCodeModelId)) return trimmed as ClaudeCodeModelId;
  // Map a version-bearing / full Claude id (e.g. "claude-opus-4-8[1m]") to its
  // canonical picker option by family, so the model picker still pre-selects
  // correctly even when the detected/stored model preserves its version for the
  // ctx-bar label.
  const lower = trimmed.toLowerCase();
  // Mythos-class maps to the `fable` picker option (claude-fable-5 /
  // claude-mythos-5 both resolve here).
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable';
  if (lower.includes('opus')) return 'opus[1M]';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';
  return undefined;
}

export const CODEX_MODEL_IDS = ['gpt-5.4', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.2'] as const;
export type CodexModelId = typeof CODEX_MODEL_IDS[number];

export const GEMINI_MODEL_IDS = [
  'auto',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-pro-exp',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
] as const;
export type GeminiModelId = typeof GEMINI_MODEL_IDS[number];

export function mergeModelSuggestions(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())];
}
