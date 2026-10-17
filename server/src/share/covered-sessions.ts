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
  const initialRoot = target.kind === 'main' ? target.sessionName : `deck_sub_${target.subSessionId}`;
  names.add(initialRoot);

  // Share coverage must not auto-cover execution clones just because their
  // parent session is shared; clones are excluded (default).
  const subSessions = await getSubSessionsByServer(db, target.serverId, { includeExecutionClones: false });
  let added = true;
  while (added) {
    added = false;
    for (const subSession of subSessions) {
      const childName = `deck_sub_${subSession.id}`;
      if (names.has(childName)) continue;
      const parent = subSession.parent_session;
      if (!parent) continue;
      if (names.has(parent) || names.has(`deck_sub_${parent}`)) {
        names.add(childName);
        added = true;
      }
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
