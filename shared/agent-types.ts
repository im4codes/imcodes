export const SESSION_AGENT_TYPES = [
  'claude-code-sdk',
  'claude-code',
  'codex-sdk',
  'codex',
  'opencode',
  'gemini',
  'qwen',
  'openclaw',
  'shell',
  'script',
] as const;

export type SessionAgentType = typeof SESSION_AGENT_TYPES[number];

export const CLAUDE_CODE_FAMILY = ['claude-code-sdk', 'claude-code'] as const;
export const CODEX_FAMILY = ['codex-sdk', 'codex'] as const;

export function isSessionAgentType(value: string): value is SessionAgentType {
  return (SESSION_AGENT_TYPES as readonly string[]).includes(value);
}

export function isClaudeCodeFamily(value: string): value is typeof CLAUDE_CODE_FAMILY[number] {
  return (CLAUDE_CODE_FAMILY as readonly string[]).includes(value);
}

export function isCodexFamily(value: string): value is typeof CODEX_FAMILY[number] {
  return (CODEX_FAMILY as readonly string[]).includes(value);
}
