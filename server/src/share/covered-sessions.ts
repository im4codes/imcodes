import type { Database } from '../db/client.js';
import { getSubSessionsByServer } from '../db/queries.js';
import { rawSubSessionIdFromDisplayName, type ShareTarget } from '../../../shared/tab-sharing.js';

export function shareTargetCoversSession(target: ShareTarget, sessionName: string): boolean {
  if (target.kind === 'server') return true;
  if (target.kind === 'main') return target.sessionName === sessionName;
  return rawSubSessionIdFromDisplayName(sessionName) === target.subSessionId;
}

export async function resolveCoveredSessionNames(
  db: Database,
  target: ShareTarget,
): Promise<string[] | undefined> {
  if (target.kind === 'server') return undefined;
  const names = new Set<string>();
  names.add(target.kind === 'main' ? target.sessionName : `deck_sub_${target.subSessionId}`);
  if (target.kind !== 'main') return [...names];

  const subSessions = await getSubSessionsByServer(db, target.serverId);
  for (const subSession of subSessions) {
    if (subSession.parent_session === target.sessionName) {
      names.add(`deck_sub_${subSession.id}`);
    }
  }
  return [...names];
}

export function buildCoversSessionPredicate(
  target: ShareTarget,
  coveredSessionNames?: readonly string[],
): (sessionName: string) => boolean {
  return (sessionName: string) =>
    shareTargetCoversSession(target, sessionName) || !!coveredSessionNames?.includes(sessionName);
}
