export interface P2pParticipantIdentityInput {
  session?: string | null;
  label?: string | null;
  agentType?: string | null;
  ccPreset?: string | null;
  mode?: string | null;
}

export function shortP2pSessionName(session: string): string {
  const parts = session.split('_');
  return parts[parts.length - 1] ?? session;
}

export function formatP2pParticipantIdentity(
  input: P2pParticipantIdentityInput,
  opts: { includeMode?: boolean } = {},
): string {
  const label = input.label?.trim() || (input.session ? shortP2pSessionName(input.session) : '');
  const agentType = input.agentType?.trim() || '';
  const ccPreset = agentType === 'claude-code' ? (input.ccPreset?.trim() || '') : '';
  const mode = input.mode?.trim() || '';

  const base = agentType
    ? `${label}:${agentType}${ccPreset ? `:(${ccPreset})` : ''}`
    : label;

  if (opts.includeMode && mode) return `${base}:${mode}`;
  return base;
}
