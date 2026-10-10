/**
 * Open/closed state of the pair status panel, and what it is when the user has not chosen.
 *
 * The owner's rule for a PHONE: opening a sub-session shows its task bar CLOSED, every time. The user may open it by tapping and it
 * then stays as they left it for as long as that view stays open (including viewport resizes: the soft keyboard fires them), but
 * nothing is remembered between visits: leaving the sub-session and coming back, reloading the page or reopening the app closes it
 * again. So a phone sub-session's choice lives only in the mounted panel's memory (never in storage, never at module level) and
 * "closed" is the only default, whether or not a task is running (the collapsed strip already shows the live counts).
 *
 * The main chat and the desktop layout keep their server-wide flag and defaults exactly as before this work (desktop open, the
 * phone main chat closed, one stored flag per server and layout), except that an in-tab copy now backs the stored flag so a blocked
 * storage no longer loses it on a resize.
 */
import { TASK_PAIR_STATUS_PANEL_STORAGE_KEY } from '@shared/task-pair.js';

/** The key prefix of the per-sub-session map an earlier version wrote; it is no longer used and is removed once per page load. */
export const LEGACY_SESSION_MAP_KEY_PREFIX = `${TASK_PAIR_STATUS_PANEL_STORAGE_KEY}.sessions` as const;

/** A phone's short side is below this (CSS px); tablets and desktop windows are above it. */
export const PHONE_SHORT_SIDE_MAX_PX = 600;

/** The server-wide flag of the main chat (and of every desktop/tablet panel). */
export function serverWideStorageKey(serverId: string | null | undefined, mobile: boolean): string {
  const scope = serverId ? `:${serverId}` : '';
  return `${TASK_PAIR_STATUS_PANEL_STORAGE_KEY}${scope}:${mobile ? 'mobile' : 'desktop'}`;
}

/** Is this a phone? The compact mobile panel layout AND a small screen: an iPad or a narrow desktop window is not. */
export function isPhoneScreen(input: { mobile: boolean; screenWidth?: number; screenHeight?: number; innerWidth?: number }): boolean {
  if (!input.mobile) return false;
  const sides = [input.screenWidth, input.screenHeight].filter((side): side is number => typeof side === 'number' && Number.isFinite(side) && side > 0);
  const shortSide = sides.length > 0 ? Math.min(...sides) : input.innerWidth;
  return typeof shortSide === 'number' && Number.isFinite(shortSide) && shortSide > 0 && shortSide < PHONE_SHORT_SIDE_MAX_PX;
}

/** A phone sub-session's panel: its choice is per visit and kept in memory only. */
export function usesVisitScopedChoice(input: { phone: boolean; scopeSessionId?: string | null }): boolean {
  return input.phone && typeof input.scopeSessionId === 'string' && input.scopeSessionId.length > 0;
}

/**
 * Collapsed or not. A phone sub-session: closed unless the user opened it during this visit. Everything else: the stored
 * server-wide flag if there is one, else desktop open / phone main chat closed (as before).
 */
export function resolveTaskPairPanelCollapsed(input: {
  choice: boolean | undefined;
  mobile: boolean;
  phone: boolean;
  scopeSessionId?: string | null;
}): boolean {
  if (input.choice !== undefined) return input.choice;
  if (usesVisitScopedChoice(input)) return true;
  return input.mobile;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

function defaultStorage(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** What this tab knows when storage is unavailable (private mode, quota, blocked): the server-wide flag survives remounts and resizes. */
const memoryFlags = new Map<string, boolean>();

/** The stored server-wide choice (collapsed = true), or undefined when there is none. */
export function readServerWideChoice(input: { serverId: string | null | undefined; mobile: boolean; storage?: StorageLike | null }): boolean | undefined {
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
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

export function writeServerWideChoice(input: { serverId: string | null | undefined; mobile: boolean; collapsed: boolean; storage?: StorageLike | null }): void {
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  const key = serverWideStorageKey(input.serverId, input.mobile);
  memoryFlags.set(key, input.collapsed);
  try { storage?.setItem(key, input.collapsed ? '1' : '0'); } catch { /* the in-tab copy holds it */ }
}

/** Removes the per-sub-session maps an earlier version stored, so they do not linger. Safe to call any number of times. */
export function removeLegacyTaskPairPanelKeys(storage?: StorageLike | null): number {
  const resolved = storage === undefined ? defaultStorage() : storage;
  if (!resolved || typeof resolved.key !== 'function' || typeof resolved.length !== 'number') return 0;
  const doomed: string[] = [];
  try {
    for (let index = 0; index < resolved.length; index += 1) {
      const key = resolved.key(index);
      if (key && key.startsWith(`${LEGACY_SESSION_MAP_KEY_PREFIX}:`)) doomed.push(key);
    }
    for (const key of doomed) resolved.removeItem(key);
  } catch { /* storage went away: nothing to clean */ }
  return doomed.length;
}

let legacyCleaned = false;
/** Once per page load. */
export function cleanLegacyTaskPairPanelKeysOnce(): void {
  if (legacyCleaned) return;
  legacyCleaned = true;
  removeLegacyTaskPairPanelKeys();
}

/** Tests: forget what this tab remembers outside storage, and allow the one-time cleanup to run again. */
export function resetTaskPairPanelMemoryForTests(): void {
  memoryFlags.clear();
  legacyCleaned = false;
}
