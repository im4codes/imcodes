import type { SessionInfo } from './types.js';

export function markSessionRunningIfNeeded(sessions: SessionInfo[], sessionName: string): SessionInfo[] {
  let changed = false;
  const next = sessions.map((session) => {
    if (session.name !== sessionName) return session;
    if (session.state === 'running') return session;
    changed = true;
    return { ...session, state: 'running' as const };
  });
  return changed ? next : sessions;
}
