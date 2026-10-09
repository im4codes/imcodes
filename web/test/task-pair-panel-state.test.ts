import { beforeEach, describe, expect, it } from 'vitest';
import {
  TASK_PAIR_PANEL_STATE_MAX_SESSIONS,
  forgetTaskPairPanelSession,
  readTaskPairPanelChoice,
  resetTaskPairPanelMemoryForTests,
  resolveTaskPairPanelCollapsed,
  serverWideStorageKey,
  sessionMapStorageKey,
  usesSessionScopedChoice,
  writeTaskPairPanelChoice,
  type StorageLike,
} from '../src/task-pair-panel-state.js';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}
const blockedStorage: StorageLike = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};

beforeEach(() => resetTaskPairPanelMemoryForTests());

describe('what the pair panel shows when the user has not chosen', () => {
  const base = { mobile: true, scopeSessionId: 'deck_sub_1', hasLiveTask: false };

  it('a phone sub-session opens for a live task, stays closed with only history (first view)', () => {
    expect(resolveTaskPairPanelCollapsed({ ...base, choice: undefined, hasLiveTask: true })).toBe(false);
    expect(resolveTaskPairPanelCollapsed({ ...base, choice: undefined, hasLiveTask: false })).toBe(true);
  });

  it('the user\'s choice always wins: never auto-closed after they opened it, never auto-opened after they closed it', () => {
    expect(resolveTaskPairPanelCollapsed({ ...base, choice: false, hasLiveTask: false })).toBe(false);
    expect(resolveTaskPairPanelCollapsed({ ...base, choice: true, hasLiveTask: true })).toBe(true);
  });

  it('desktop and the phone\'s main chat keep their defaults (desktop open, main chat closed), live task or not', () => {
    for (const hasLiveTask of [true, false]) {
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: false, scopeSessionId: 'deck_sub_1', hasLiveTask })).toBe(false);
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: false, hasLiveTask })).toBe(false);
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: true, hasLiveTask })).toBe(true);
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: true, scopeSessionId: '', hasLiveTask })).toBe(true);
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: true, scopeSessionId: null, hasLiveTask })).toBe(true);
    }
  });

  it('only a phone sub-session keeps its own per-session choice', () => {
    expect(usesSessionScopedChoice({ mobile: true, scopeSessionId: 'a' })).toBe(true);
    expect(usesSessionScopedChoice({ mobile: false, scopeSessionId: 'a' })).toBe(false);
    expect(usesSessionScopedChoice({ mobile: true })).toBe(false);
    expect(usesSessionScopedChoice({ mobile: true, scopeSessionId: '' })).toBe(false);
  });
});

describe('the remembered choice', () => {
  it('a phone sub-session remembers its own choice per server and session, independent of other sessions and of the main chat flag', () => {
    const storage = new MemoryStorage();
    const target = { serverId: 'srv', mobile: true, storage };
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-a' })).toBeUndefined();
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-a', collapsed: false });
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-b', collapsed: true });
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-a' })).toBe(false);
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-b' })).toBe(true);
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-c' })).toBeUndefined();
    expect(readTaskPairPanelChoice({ ...target, serverId: 'other', scopeSessionId: 'sub-a' })).toBeUndefined();
    // the main chat's server-wide flag is another key: closing it there does not touch the sub-sessions (the old shared-flag bug)
    writeTaskPairPanelChoice({ ...target, collapsed: true });
    expect(storage.getItem(serverWideStorageKey('srv', true))).toBe('1');
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-a' })).toBe(false);
    expect(readTaskPairPanelChoice({ ...target })).toBe(true);
  });

  it('keeps the old server-wide keys and values for the main chat and for desktop', () => {
    const storage = new MemoryStorage();
    expect(serverWideStorageKey('srv', true)).toBe('imcodes.task-pair-status-panel.collapsed:srv:mobile');
    expect(serverWideStorageKey('srv', false)).toBe('imcodes.task-pair-status-panel.collapsed:srv:desktop');
    expect(serverWideStorageKey(null, false)).toBe('imcodes.task-pair-status-panel.collapsed:desktop');
    storage.setItem('imcodes.task-pair-status-panel.collapsed:srv:desktop', '1');
    storage.setItem('imcodes.task-pair-status-panel.collapsed:srv:mobile', '0');
    expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: false, storage })).toBe(true);
    expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: true, storage })).toBe(false);
    // desktop with a session scope still uses the server-wide desktop flag (desktop behaviour unchanged)
    expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: false, scopeSessionId: 'sub-a', storage })).toBe(true);
    writeTaskPairPanelChoice({ serverId: 'srv', mobile: false, scopeSessionId: 'sub-a', collapsed: false, storage });
    expect(storage.getItem('imcodes.task-pair-status-panel.collapsed:srv:desktop')).toBe('0');
    expect(storage.getItem(sessionMapStorageKey('srv'))).toBeNull();
  });

  it('forgets a closed sub-session and only that one; the stored map stays bounded to the newest entries', () => {
    const storage = new MemoryStorage();
    const target = { serverId: 'srv', mobile: true, storage, maxSessions: 5 };
    for (let n = 0; n < 8; n += 1) writeTaskPairPanelChoice({ ...target, scopeSessionId: `sub-${n}`, collapsed: n % 2 === 0, now: 1000 + n });
    const stored = JSON.parse(storage.getItem(sessionMapStorageKey('srv'))!) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['sub-3', 'sub-4', 'sub-5', 'sub-6', 'sub-7']);
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-0' })).toBeUndefined();
    forgetTaskPairPanelSession('srv', 'sub-5', storage);
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-5' })).toBeUndefined();
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'sub-6' })).toBe(true);
    // forgetting the last entry removes the key; forgetting an unknown session writes nothing
    for (const name of ['sub-3', 'sub-4', 'sub-6', 'sub-7']) forgetTaskPairPanelSession('srv', name, storage);
    expect(storage.getItem(sessionMapStorageKey('srv'))).toBeNull();
    forgetTaskPairPanelSession('srv', 'never-existed', storage);
    expect(storage.data.size).toBe(0);
    expect(TASK_PAIR_PANEL_STATE_MAX_SESSIONS).toBe(100);
  });

  it('re-choosing a session refreshes its age, so the most recently used survive the cap', () => {
    const storage = new MemoryStorage();
    const target = { serverId: 'srv', mobile: true, storage, maxSessions: 3 };
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'old', collapsed: true, now: 1 });
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'b', collapsed: true, now: 2 });
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'c', collapsed: true, now: 3 });
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'old', collapsed: false, now: 4 });
    writeTaskPairPanelChoice({ ...target, scopeSessionId: 'd', collapsed: true, now: 5 });
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'old' })).toBe(false);
    expect(readTaskPairPanelChoice({ ...target, scopeSessionId: 'b' })).toBeUndefined();
  });

  it('storage that is blocked (private mode, quota) still remembers the choice for this tab, for both kinds of panel', () => {
    const phone = { serverId: 'srv', mobile: true, storage: blockedStorage };
    expect(readTaskPairPanelChoice({ ...phone, scopeSessionId: 'sub-a' })).toBeUndefined();
    writeTaskPairPanelChoice({ ...phone, scopeSessionId: 'sub-a', collapsed: false });
    expect(readTaskPairPanelChoice({ ...phone, scopeSessionId: 'sub-a' })).toBe(false);
    writeTaskPairPanelChoice({ ...phone, collapsed: true });
    expect(readTaskPairPanelChoice(phone)).toBe(true);
    expect(() => forgetTaskPairPanelSession('srv', 'sub-a', blockedStorage)).not.toThrow();
    expect(readTaskPairPanelChoice({ ...phone, scopeSessionId: 'sub-a' })).toBeUndefined();
    // no storage object at all behaves the same
    writeTaskPairPanelChoice({ serverId: 'srv', mobile: true, scopeSessionId: 'sub-z', collapsed: false, storage: null });
    expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: true, scopeSessionId: 'sub-z', storage: null })).toBe(false);
  });

  it('garbage in storage is a lost preference, never a crash or a wrong answer', () => {
    const storage = new MemoryStorage();
    const key = sessionMapStorageKey('srv');
    for (const garbage of ['not json', '[]', '{"sub-a":{"c":2,"t":1}}', '{"sub-a":{"c":1}}', '{"sub-a":null}', '"x"']) {
      storage.setItem(key, garbage);
      expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: true, scopeSessionId: 'sub-a', storage }), garbage).toBeUndefined();
    }
    storage.setItem(serverWideStorageKey('srv', true), 'maybe');
    expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: true, storage })).toBeUndefined();
    // a write after garbage repairs the entry
    storage.setItem(key, 'not json');
    writeTaskPairPanelChoice({ serverId: 'srv', mobile: true, scopeSessionId: 'sub-a', collapsed: false, storage });
    expect(readTaskPairPanelChoice({ serverId: 'srv', mobile: true, scopeSessionId: 'sub-a', storage })).toBe(false);
  });
});
