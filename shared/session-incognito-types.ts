/** Privacy intent is immutable for the lifetime of a session. Missing means normal. */
export interface SessionIncognitoConfig {
  incognito?: boolean;
}

/** Forward on every event so downstream stores cannot mistake private data for history. */
export const INCOGNITO_TIMELINE_PAYLOAD = {
  incognito: true,
  memoryExcluded: true,
} as const;

export const SESSION_INCOGNITO_MAX_BUFFER = 500;
export const SESSION_INCOGNITO_CAPABILITY = 'session-incognito-v1';

export function isIncognitoSession(value: unknown): boolean {
  return !!value && typeof value === 'object'
    && (value as SessionIncognitoConfig).incognito === true;
}

export const SESSION_INCOGNITO_SERVER_READY = 'session-incognito.ready';
export const SESSION_INCOGNITO_UNSUPPORTED = 'Incognito requires a compatible server and daemon and a supported runtime (claude-code-sdk, codex-sdk, or pi).';
export const SESSION_INCOGNITO_MEMORY_DISABLED = 'Memory tools are disabled in incognito sessions.';
export const SESSION_INCOGNITO_AGENT_TYPE = 'claude-code-sdk';
export const SESSION_INCOGNITO_AGENT_TYPES = [SESSION_INCOGNITO_AGENT_TYPE, 'codex-sdk', 'pi'] as const;
export function supportsSessionIncognito(agentType: unknown): boolean {
  return typeof agentType === 'string' && (SESSION_INCOGNITO_AGENT_TYPES as readonly string[]).includes(agentType);
}
