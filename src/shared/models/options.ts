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
