export interface AgentBadgeConfig {
  label: string;
  color: string;
  autoLabelPrefix: string;
}

export const AGENT_BADGE_CONFIG: Record<string, AgentBadgeConfig> = {
  'claude-code': { label: 'cc', color: '#7c3aed', autoLabelPrefix: 'CC' },
  'claude-code-sdk': { label: 'cc', color: '#7c3aed', autoLabelPrefix: 'CC' },
  'codex': { label: 'cx', color: '#d97706', autoLabelPrefix: 'Cx' },
  'codex-sdk': { label: 'cx', color: '#d97706', autoLabelPrefix: 'Cx' },
  'copilot-sdk': { label: 'co', color: '#2563eb', autoLabelPrefix: 'Co' },
  'cursor-headless': { label: 'cu', color: '#0ea5e9', autoLabelPrefix: 'Cu' },
  'opencode': { label: 'oc', color: '#059669', autoLabelPrefix: 'OC' },
  'openclaw': { label: 'oc', color: '#f97316', autoLabelPrefix: 'OC' },
  'qwen': { label: 'qw', color: '#0f766e', autoLabelPrefix: 'Qw' },
  'gemini': { label: 'gm', color: '#1d4ed8', autoLabelPrefix: 'Gm' },
  'gemini-sdk': { label: 'gm', color: '#1d4ed8', autoLabelPrefix: 'Gm' },
  'shell': { label: 'sh', color: '#475569', autoLabelPrefix: 'Sh' },
  'script': { label: 'sc', color: '#64748b', autoLabelPrefix: 'Sc' },
};

const LEGACY_AUTO_LABEL_PATTERNS: Array<{ pattern: RegExp; prefix: string }> = [
  { pattern: /^claude-code-sdk(\d+)?$/i, prefix: 'CC' },
  { pattern: /^codex-sdk(\d+)?$/i, prefix: 'Cx' },
  { pattern: /^copilot-sdk(\d+)?$/i, prefix: 'Co' },
  { pattern: /^cursor-headless(\d+)?$/i, prefix: 'Cu' },
  { pattern: /^gemini-sdk(\d+)?$/i, prefix: 'Gm' },
];

export function getAgentBadgeConfig(agentType: string | null | undefined): AgentBadgeConfig | null {
  if (!agentType) return null;
  return AGENT_BADGE_CONFIG[agentType] ?? null;
}

export function getAgentBadgeLabel(agentType: string | null | undefined): string {
  const config = getAgentBadgeConfig(agentType);
  if (config) return config.label;
  return (agentType ?? '').slice(0, 2) || '??';
}

export function getAutoSessionLabelPrefix(agentType: string | null | undefined): string {
  const config = getAgentBadgeConfig(agentType);
  if (config) return config.autoLabelPrefix;
  return agentType?.trim() || 'Session';
}

export function normalizeLegacyAutoSessionLabel(label: string): string {
  for (const { pattern, prefix } of LEGACY_AUTO_LABEL_PATTERNS) {
    const match = label.match(pattern);
    if (match) return `${prefix}${match[1] ?? ''}`;
  }
  return label;
}
