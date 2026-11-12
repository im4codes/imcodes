/**
 * Lightweight browser-side registry tracking active incognito timeline keys.
 * Kept separate from hooks/useTimeline so components like SessionControls can
 * query incognito state without introducing extra exports onto mocked hooks.
 */
const activeIncognitoTimelineKeys = new Set<string>();

export function scopeIncognitoTimelineCacheKey(serverId: string | null | undefined, sessionId: string): string {
  return serverId ? `${serverId}:${sessionId}` : sessionId;
}

export function setIncognitoTimelineKeyActive(cacheKey: string, active: boolean): void {
  if (active) activeIncognitoTimelineKeys.add(cacheKey);
  else activeIncognitoTimelineKeys.delete(cacheKey);
}

export function isIncognitoTimelineSession(serverId: string | null | undefined, sessionId: string): boolean {
  return activeIncognitoTimelineKeys.has(scopeIncognitoTimelineCacheKey(serverId, sessionId));
}

export function clearIncognitoTimelineRegistry(): void {
  activeIncognitoTimelineKeys.clear();
}
