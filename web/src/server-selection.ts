export interface SelectableServerInfo {
  id: string;
  name: string;
}

export function getSelectedServerName(
  selectedServerId: string | null,
  servers: readonly SelectableServerInfo[],
  fallbackName: string | null,
): string | null {
  if (!selectedServerId) return null;
  if (servers.length === 0) return fallbackName;
  return servers.find((server) => server.id === selectedServerId)?.name ?? null;
}
