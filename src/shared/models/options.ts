export const CLAUDE_CODE_MODEL_IDS = ['opus[1M]', 'sonnet', 'haiku'] as const;
export type ClaudeCodeModelId = typeof CLAUDE_CODE_MODEL_IDS[number];

export function normalizeClaudeCodeModelId(value: string | null | undefined): ClaudeCodeModelId | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'opus') return 'opus[1M]';
  return CLAUDE_CODE_MODEL_IDS.includes(trimmed as ClaudeCodeModelId) ? (trimmed as ClaudeCodeModelId) : undefined;
}

export const CODEX_MODEL_IDS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.2'] as const;
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
