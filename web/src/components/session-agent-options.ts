import type { SessionAgentType } from '@shared/agent-types.js';

export type SessionAgentGroupId = 'transport' | 'process';
export type SessionAgentSurface = 'new-session' | 'sub-session';

export interface SessionAgentChoice {
  id: SessionAgentType;
  icon: string;
  fallbackLabel: string;
  labelKey?: string;
  group: SessionAgentGroupId;
  surfaces: SessionAgentSurface[];
}

export const SESSION_AGENT_GROUP_LABEL_KEYS: Record<SessionAgentGroupId, string> = {
  transport: 'session.agentGroup.transport_sdk',
  process: 'session.agentGroup.cli_process',
};

const SESSION_AGENT_CHOICES: SessionAgentChoice[] = [
  {
    id: 'claude-code-sdk',
    icon: '⚡',
    fallbackLabel: 'Claude Code SDK',
    labelKey: 'session.agentType.claude_code_sdk',
    group: 'transport',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'codex-sdk',
    icon: '📦',
    fallbackLabel: 'Codex SDK',
    labelKey: 'session.agentType.codex_sdk',
    group: 'transport',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'copilot-sdk',
    icon: '🐙',
    fallbackLabel: 'Copilot',
    labelKey: 'session.agentType.copilot_sdk',
    group: 'transport',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'cursor-headless',
    icon: '⌘',
    fallbackLabel: 'Cursor',
    labelKey: 'session.agentType.cursor_headless',
    group: 'transport',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'qwen',
    icon: '千',
    fallbackLabel: 'Qwen Code',
    labelKey: 'session.agentType.qwen',
    group: 'transport',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'openclaw',
    icon: '🦞',
    fallbackLabel: 'OpenClaw',
    labelKey: 'session.agentType.openclaw',
    group: 'transport',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'claude-code',
    icon: '⚡',
    fallbackLabel: 'Claude Code',
    labelKey: 'session.agentType.claude_code_cli',
    group: 'process',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'codex',
    icon: '📦',
    fallbackLabel: 'Codex',
    labelKey: 'session.agentType.codex_cli',
    group: 'process',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'opencode',
    icon: '🔆',
    fallbackLabel: 'OpenCode',
    group: 'process',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'gemini',
    icon: '♊',
    fallbackLabel: 'Gemini CLI',
    group: 'process',
    surfaces: ['new-session', 'sub-session'],
  },
  {
    id: 'shell',
    icon: '🐚',
    fallbackLabel: 'Shell',
    group: 'process',
    surfaces: ['sub-session'],
  },
  {
    id: 'script',
    icon: '🔄',
    fallbackLabel: 'Script',
    group: 'process',
    surfaces: ['sub-session'],
  },
];

export function getSessionAgentGroups(surface: SessionAgentSurface): Array<{ id: SessionAgentGroupId; items: SessionAgentChoice[] }> {
  return [
    {
      id: 'transport',
      items: SESSION_AGENT_CHOICES.filter((choice) => choice.group === 'transport' && choice.surfaces.includes(surface)),
    },
    {
      id: 'process',
      items: SESSION_AGENT_CHOICES.filter((choice) => choice.group === 'process' && choice.surfaces.includes(surface)),
    },
  ];
}

export function getSessionAgentLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  choice: SessionAgentChoice,
): string {
  return choice.labelKey ? t(choice.labelKey) : choice.fallbackLabel;
}
