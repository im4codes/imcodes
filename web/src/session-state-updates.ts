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

/** Structural equality for the small JSON-ish values a session record holds. */
export function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => looselyEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => key in right && looselyEqual(left[key], right[key]));
}

/**
 * Replace one session by `build(session)`, keeping every identity that did not
 * change. A live frame that repeats what the record already says (an idle frame
 * for an idle session, the same queue snapshot again) returns the SAME array,
 * so `setSessions` bails out and the app -- and every mounted pane -- is not
 * re-rendered for it.
 */
export function updateSessionIfChanged(
  sessions: SessionInfo[],
  sessionName: string,
  build: (session: SessionInfo) => SessionInfo,
): SessionInfo[] {
  const index = sessions.findIndex((session) => session.name === sessionName);
  if (index < 0) return sessions;
  const current = sessions[index]!;
  const next = build(current);
  if (next === current || looselyEqual(current, next)) return sessions;
  const copy = sessions.slice();
  copy[index] = next;
  return copy;
}

/**
 * `list` with `list[index]` replaced by `next`, or `list` itself when `next` is
 * structurally the same record (see {@link updateSessionIfChanged}).
 */
export function replaceAtIfChanged<T>(list: T[], index: number, next: T): T[] {
  const current = list[index];
  if (current === next || looselyEqual(current, next)) return list;
  const copy = list.slice();
  copy[index] = next;
  return copy;
}
