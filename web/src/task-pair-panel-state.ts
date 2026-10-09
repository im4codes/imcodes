/**
 * Open/closed state of the pair status panel, and what it is when the user has not chosen.
 *
 * Before this module the panel kept ONE flag per server and layout, shared by the main chat and every sub-session: closing it in
 * the main chat (where it lists every pair) closed it in every sub-session too, and on a phone the answer without a stored flag was
 * "closed" even for a sub-session whose own task is running. Worse, a resize (the soft keyboard fires one) re-read the flag from
 * storage with the serverId of the first render and overwrote the state in memory, so wherever storage did not hold the answer
 * (private mode, a different key) the panel shut again each time the keyboard opened.
 *
 * Now: on a phone, a sub-session's panel remembers ITS OWN choice (per server and session, bounded, forgotten when the session is
 * closed); with no choice yet it opens when the sub-session has a live task and stays closed when there is nothing to show; an
 * explicit choice is never overridden (never auto-closed after the user opened it, never auto-opened after they closed it). The
 * main chat and the desktop layout keep their existing server-wide flag and defaults.
 */
import { TASK_PAIR_STATUS_PANEL_STORAGE_KEY } from '@shared/task-pair.js';

/** One entry per sub-session the user has touched; the oldest are dropped past this. */
export const TASK_PAIR_PANEL_STATE_MAX_SESSIONS = 100;
const SESSION_MAP_KEY_PREFIX = `${TASK_PAIR_STATUS_PANEL_STORAGE_KEY}.sessions` as const;

/** Statuses of a pair that still has something to show the user (not finished). */
export const TASK_PAIR_PANEL_LIVE_STATUSES: readonly string[] = Object.freeze([
  'working', 'rework', 'in_audit', 'awaiting_audit', 'awaiting_brain_decision', 'queued',
]);

/** The server-wide flag of the main chat (and of every desktop panel): unchanged. */
export function serverWideStorageKey(serverId: string | null | undefined, mobile: boolean): string {
  const scope = serverId ? `:${serverId}` : '';
  return `${TASK_PAIR_STATUS_PANEL_STORAGE_KEY}${scope}:${mobile ? 'mobile' : 'desktop'}`;
}

export function sessionMapStorageKey(serverId: string | null | undefined): string {
  return `${SESSION_MAP_KEY_PREFIX}:${serverId || 'local'}`;
}

/** Does this panel keep its own per-session choice? Only a sub-session's panel on a phone does. */
export function usesSessionScopedChoice(input: { mobile: boolean; scopeSessionId?: string | null }): boolean {
  return input.mobile && typeof input.scopeSessionId === 'string' && input.scopeSessionId.length > 0;
}

/**
 * Collapsed or not, given the user's stored choice (`undefined` = none). A choice always wins. Without one: desktop is open (as
 * before); a phone's main chat is closed (as before); a phone's sub-session is open when it has a live task, closed when it has
 * nothing but history.
 */
export function resolveTaskPairPanelCollapsed(input: {
  choice: boolean | undefined;
  mobile: boolean;
  scopeSessionId?: string | null;
  hasLiveTask: boolean;
}): boolean {
  if (input.choice !== undefined) return input.choice;
  if (!input.mobile) return false;
  if (usesSessionScopedChoice(input)) return !input.hasLiveTask;
  return true;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

interface SessionEntry { c: boolean; t: number }

/** What this tab knows when storage is unavailable (private mode, quota, blocked): the choice survives remounts and resizes. */
const memoryFlags = new Map<string, boolean>();
const memorySessions = new Map<string, Map<string, SessionEntry>>();

function parseSessionMap(raw: string | null): Map<string, SessionEntry> {
  const map = new Map<string, SessionEntry>();
  if (!raw) return map;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [session, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { c?: unknown; t?: unknown } | null;
      if (entry && (entry.c === 0 || entry.c === 1) && typeof entry.t === 'number' && Number.isFinite(entry.t)) map.set(session, { c: entry.c === 1, t: entry.t });
    }
  } catch { /* a corrupt map is a lost preference, nothing more */ }
  return map;
}

function pruned(map: Map<string, SessionEntry>, max = TASK_PAIR_PANEL_STATE_MAX_SESSIONS): Map<string, SessionEntry> {
  if (map.size <= max) return map;
  const keep = [...map.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, max);
  return new Map(keep);
}

function serializeSessionMap(map: Map<string, SessionEntry>): string {
  const out: Record<string, { c: 0 | 1; t: number }> = {};
  for (const [session, entry] of map) out[session] = { c: entry.c ? 1 : 0, t: entry.t };
  return JSON.stringify(out);
}

function readSessionMap(serverId: string | null | undefined, storage: StorageLike | null): Map<string, SessionEntry> {
  const key = sessionMapStorageKey(serverId);
  if (storage) {
    try { return parseSessionMap(storage.getItem(key)); } catch { /* fall through to memory */ }
  }
  return new Map(memorySessions.get(key) ?? []);
}

function writeSessionMap(serverId: string | null | undefined, map: Map<string, SessionEntry>, storage: StorageLike | null): void {
  const key = sessionMapStorageKey(serverId);
  memorySessions.set(key, new Map(map));
  if (!storage) return;
  try {
    if (map.size === 0) storage.removeItem(key);
    else storage.setItem(key, serializeSessionMap(map));
  } catch { /* the in-memory copy still holds it for this tab */ }
}

/** The user's stored choice for this panel (collapsed = true), or undefined when they have not made one. */
export function readTaskPairPanelChoice(input: {
  serverId: string | null | undefined;
  mobile: boolean;
  scopeSessionId?: string | null;
  storage?: StorageLike | null;
}): boolean | undefined {
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  if (usesSessionScopedChoice(input)) return readSessionMap(input.serverId, storage).get(input.scopeSessionId!)?.c;
  const key = serverWideStorageKey(input.serverId, input.mobile);
  if (storage) {
    try {
      const stored = storage.getItem(key);
      if (stored === '1') return true;
      if (stored === '0') return false;
      return undefined;
    } catch { /* fall through to memory */ }
  }
  return memoryFlags.get(key);
}

export function writeTaskPairPanelChoice(input: {
  serverId: string | null | undefined;
  mobile: boolean;
  scopeSessionId?: string | null;
  collapsed: boolean;
  now?: number;
  storage?: StorageLike | null;
  maxSessions?: number;
}): void {
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  if (usesSessionScopedChoice(input)) {
    const map = readSessionMap(input.serverId, storage);
    map.delete(input.scopeSessionId!);
    map.set(input.scopeSessionId!, { c: input.collapsed, t: input.now ?? Date.now() });
    writeSessionMap(input.serverId, pruned(map, input.maxSessions), storage);
    return;
  }
  const key = serverWideStorageKey(input.serverId, input.mobile);
  memoryFlags.set(key, input.collapsed);
  try { storage?.setItem(key, input.collapsed ? '1' : '0'); } catch { /* memory copy holds it */ }
}

/** A sub-session was closed: its remembered choice goes with it. */
export function forgetTaskPairPanelSession(serverId: string | null | undefined, sessionName: string, storage?: StorageLike | null): void {
  const resolved = storage === undefined ? defaultStorage() : storage;
  const map = readSessionMap(serverId, resolved);
  if (!map.delete(sessionName)) return;
  writeSessionMap(serverId, map, resolved);
}

/** Tests: forget what this tab remembers outside storage. */
export function resetTaskPairPanelMemoryForTests(): void {
  memoryFlags.clear();
  memorySessions.clear();
}
