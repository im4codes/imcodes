export const CLAUDE_CODE_MODEL_IDS = ['opus[1M]', 'sonnet', 'haiku'] as const;
export type ClaudeCodeModelId = typeof CLAUDE_CODE_MODEL_IDS[number];

export const CODEX_MODEL_IDS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'] as const;
export type CodexModelId = typeof CODEX_MODEL_IDS[number];
