export const P2P_SESSION_CONFIG_PREF_KEY = 'p2p_session_config' as const;

export function p2pScopedSessionKey(rootSession: string, serverId?: string | null): string {
  return serverId ? `${serverId}:${rootSession}` : rootSession;
}

export function p2pLegacySessionConfigPrefKey(rootSession: string): string {
  return `${P2P_SESSION_CONFIG_PREF_KEY}:${rootSession}`;
}

export function p2pSessionConfigPrefKey(rootSession: string, serverId?: string | null): string {
  return `${P2P_SESSION_CONFIG_PREF_KEY}:${p2pScopedSessionKey(rootSession, serverId)}`;
}

export function p2pSessionConfigLegacyPrefKeys(rootSession: string): readonly string[] {
  return [p2pLegacySessionConfigPrefKey(rootSession), P2P_SESSION_CONFIG_PREF_KEY];
}
