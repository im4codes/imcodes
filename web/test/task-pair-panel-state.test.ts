import { beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_SESSION_MAP_KEY_PREFIX,
  PHONE_SHORT_SIDE_MAX_PX,
  isPhoneScreen,
  readServerWideChoice,
  removeLegacyTaskPairPanelKeys,
  resetTaskPairPanelMemoryForTests,
  resolveTaskPairPanelCollapsed,
  serverWideStorageKey,
  usesVisitScopedChoice,
  writeServerWideChoice,
  type StorageLike,
} from '../src/task-pair-panel-state.js';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
}
const blockedStorage: StorageLike = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
  length: 1,
  key() { throw new Error('SecurityError'); },
};

beforeEach(() => resetTaskPairPanelMemoryForTests());

describe('is it a phone', () => {
  it('a small screen in the compact panel layout is; a tablet, a desktop and a narrow desktop window are not', () => {
    expect(isPhoneScreen({ mobile: true, screenWidth: 390, screenHeight: 844 })).toBe(true);
    expect(isPhoneScreen({ mobile: true, screenWidth: 844, screenHeight: 390 })).toBe(true); // a phone turned sideways
    expect(isPhoneScreen({ mobile: true, screenWidth: 360, screenHeight: 800 })).toBe(true);
    expect(isPhoneScreen({ mobile: true, screenWidth: 820, screenHeight: 1180 })).toBe(false); // iPad
    expect(isPhoneScreen({ mobile: true, screenWidth: 1280, screenHeight: 800 })).toBe(false); // tablet landscape / small laptop
    expect(isPhoneScreen({ mobile: true, screenWidth: 2560, screenHeight: 1440 })).toBe(false); // a desktop window narrowed below 720
    expect(isPhoneScreen({ mobile: false, screenWidth: 390, screenHeight: 844 })).toBe(false);
    expect(isPhoneScreen({ mobile: true, screenWidth: PHONE_SHORT_SIDE_MAX_PX, screenHeight: 900 })).toBe(false);
    expect(isPhoneScreen({ mobile: true, screenWidth: PHONE_SHORT_SIDE_MAX_PX - 1, screenHeight: 900 })).toBe(true);
  });

  it('falls back to the window width when the screen size is unknown (0, missing, NaN)', () => {
    expect(isPhoneScreen({ mobile: true, screenWidth: 0, screenHeight: 0, innerWidth: 390 })).toBe(true);
    expect(isPhoneScreen({ mobile: true, innerWidth: 1000 })).toBe(false);
    expect(isPhoneScreen({ mobile: true, screenWidth: NaN, screenHeight: undefined, innerWidth: 400 })).toBe(true);
    expect(isPhoneScreen({ mobile: true })).toBe(false);
  });
});

describe('what the panel shows', () => {
  const phoneSub = { mobile: true, phone: true, scopeSessionId: 'deck_sub_1' };

  it('a phone sub-session is CLOSED when opened, always: nothing makes it open by itself', () => {
    expect(resolveTaskPairPanelCollapsed({ ...phoneSub, choice: undefined })).toBe(true);
  });

  it('the user\'s choice during this visit wins both ways', () => {
    expect(resolveTaskPairPanelCollapsed({ ...phoneSub, choice: false })).toBe(false);
    expect(resolveTaskPairPanelCollapsed({ ...phoneSub, choice: true })).toBe(true);
  });

  it('desktop, tablet and the phone main chat keep their defaults: open on desktop and tablet-sized layouts, closed in the compact layout', () => {
    for (const scopeSessionId of [undefined, null, '', 'deck_sub_1']) {
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: false, phone: false, scopeSessionId })).toBe(false); // desktop
      expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: true, phone: false, scopeSessionId })).toBe(true); // tablet in the compact layout: as before
    }
    expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: true, phone: true })).toBe(true); // phone main chat
    expect(resolveTaskPairPanelCollapsed({ choice: undefined, mobile: true, phone: true, scopeSessionId: '' })).toBe(true);
    expect(resolveTaskPairPanelCollapsed({ choice: false, mobile: true, phone: true })).toBe(false); // a stored main-chat choice still applies
  });

  it('only a phone sub-session has a per-visit choice', () => {
    expect(usesVisitScopedChoice({ phone: true, scopeSessionId: 'a' })).toBe(true);
    expect(usesVisitScopedChoice({ phone: false, scopeSessionId: 'a' })).toBe(false);
    expect(usesVisitScopedChoice({ phone: true })).toBe(false);
    expect(usesVisitScopedChoice({ phone: true, scopeSessionId: '' })).toBe(false);
  });
});

describe('the server-wide flag (main chat, desktop, tablet) is unchanged', () => {
  it('keeps its keys and values', () => {
    const storage = new MemoryStorage();
    expect(serverWideStorageKey('srv', true)).toBe('imcodes.task-pair-status-panel.collapsed:srv:mobile');
    expect(serverWideStorageKey('srv', false)).toBe('imcodes.task-pair-status-panel.collapsed:srv:desktop');
    expect(serverWideStorageKey(null, false)).toBe('imcodes.task-pair-status-panel.collapsed:desktop');
    storage.setItem('imcodes.task-pair-status-panel.collapsed:srv:desktop', '1');
    storage.setItem('imcodes.task-pair-status-panel.collapsed:srv:mobile', '0');
    expect(readServerWideChoice({ serverId: 'srv', mobile: false, storage })).toBe(true);
    expect(readServerWideChoice({ serverId: 'srv', mobile: true, storage })).toBe(false);
    expect(readServerWideChoice({ serverId: 'other', mobile: true, storage })).toBeUndefined();
    writeServerWideChoice({ serverId: 'srv', mobile: false, collapsed: false, storage });
    expect(storage.getItem('imcodes.task-pair-status-panel.collapsed:srv:desktop')).toBe('0');
    storage.setItem('imcodes.task-pair-status-panel.collapsed:srv:desktop', 'maybe');
    expect(readServerWideChoice({ serverId: 'srv', mobile: false, storage })).toBeUndefined();
  });

  it('blocked storage still keeps the flag for this tab', () => {
    expect(readServerWideChoice({ serverId: 'srv', mobile: false, storage: blockedStorage })).toBeUndefined();
    writeServerWideChoice({ serverId: 'srv', mobile: false, collapsed: true, storage: blockedStorage });
    expect(readServerWideChoice({ serverId: 'srv', mobile: false, storage: blockedStorage })).toBe(true);
    writeServerWideChoice({ serverId: 'srv', mobile: true, collapsed: false, storage: null });
    expect(readServerWideChoice({ serverId: 'srv', mobile: true, storage: null })).toBe(false);
  });
});

describe('the per-sub-session maps the previous version stored are removed', () => {
  it('removes every legacy map key and nothing else', () => {
    const storage = new MemoryStorage();
    storage.setItem(`${LEGACY_SESSION_MAP_KEY_PREFIX}:srv`, '{"deck_sub_a":{"c":0,"t":1}}');
    storage.setItem(`${LEGACY_SESSION_MAP_KEY_PREFIX}:local`, '{}');
    storage.setItem(`${LEGACY_SESSION_MAP_KEY_PREFIX}:other-server`, 'garbage');
    storage.setItem('imcodes.task-pair-status-panel.collapsed:srv:mobile', '1'); // the server-wide flag stays
    storage.setItem('imcodes.task-pair-status-panel.collapsed:desktop', '0');
    storage.setItem('unrelated', 'x');
    expect(removeLegacyTaskPairPanelKeys(storage)).toBe(3);
    expect([...storage.data.keys()].sort()).toEqual(['imcodes.task-pair-status-panel.collapsed:desktop', 'imcodes.task-pair-status-panel.collapsed:srv:mobile', 'unrelated']);
    expect(removeLegacyTaskPairPanelKeys(storage)).toBe(0); // idempotent
  });

  it('copes with storage that is empty, missing or blocked', () => {
    expect(removeLegacyTaskPairPanelKeys(new MemoryStorage())).toBe(0);
    expect(removeLegacyTaskPairPanelKeys(null)).toBe(0);
    expect(() => removeLegacyTaskPairPanelKeys(blockedStorage)).not.toThrow();
    expect(removeLegacyTaskPairPanelKeys(blockedStorage)).toBe(0);
  });
});
