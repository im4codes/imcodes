import { describe, expect, it } from 'vitest';
import {
  MAX_REMEMBERED_SERVER_SESSIONS,
  SERVER_SESSION_INDEX_STORAGE_KEY,
  readLastRememberedServerId,
  readServerSession,
  serverSessionStorageKey,
  writeServerSession,
} from '../src/server-tab-state.js';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  throwOn: Set<'get' | 'set' | 'remove'> = new Set();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null {
    if (this.throwOn.has('get')) throw new DOMException('denied', 'SecurityError');
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void {
    if (this.throwOn.has('remove')) throw new DOMException('denied', 'SecurityError');
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.throwOn.has('set')) throw new DOMException('quota', 'QuotaExceededError');
    this.map.set(key, value);
  }
  keys(): string[] { return [...this.map.keys()]; }
}

describe('server tab state', () => {
  it('remembers one tab per server, independently', () => {
    const storage = new MemoryStorage();
    writeServerSession('srv-a', 'deck_a_notes', storage);
    writeServerSession('srv-b', 'deck_b_ops', storage);
    expect(readServerSession('srv-a', storage)).toBe('deck_a_notes');
    expect(readServerSession('srv-b', storage)).toBe('deck_b_ops');
    expect(readServerSession('srv-c', storage)).toBeNull();
  });

  it('keys by the encoded server id so ids with special characters never collide', () => {
    const storage = new MemoryStorage();
    writeServerSession('a/b', 'one', storage);
    writeServerSession('a%2Fb', 'two', storage);
    expect(readServerSession('a/b', storage)).toBe('one');
    expect(readServerSession('a%2Fb', storage)).toBe('two');
    expect(serverSessionStorageKey('a/b')).toBe('rcc_session_a%2Fb');
  });

  it('still reads the pre-scoped legacy key written by older builds', () => {
    const storage = new MemoryStorage();
    storage.setItem('rcc_session_srv-legacy', 'deck_legacy_brain');
    expect(readServerSession('srv-legacy', storage)).toBe('deck_legacy_brain');
  });

  it('tracks the most recently remembered server first (the "last server")', () => {
    const storage = new MemoryStorage();
    expect(readLastRememberedServerId(storage)).toBeNull();
    writeServerSession('srv-a', 'a1', storage);
    writeServerSession('srv-b', 'b1', storage);
    expect(readLastRememberedServerId(storage)).toBe('srv-b');
    writeServerSession('srv-a', 'a2', storage);
    expect(readLastRememberedServerId(storage)).toBe('srv-a');
    expect(JSON.parse(storage.getItem(SERVER_SESSION_INDEX_STORAGE_KEY)!)).toEqual(['srv-a', 'srv-b']);
  });

  it('forgets a server explicitly and drops it from the index', () => {
    const storage = new MemoryStorage();
    writeServerSession('srv-a', 'a1', storage);
    writeServerSession('srv-b', 'b1', storage);
    writeServerSession('srv-b', null, storage);
    expect(readServerSession('srv-b', storage)).toBeNull();
    expect(readLastRememberedServerId(storage)).toBe('srv-a');
  });

  it('keeps storage bounded: the least recently used snapshot is evicted past the cap', () => {
    const storage = new MemoryStorage();
    const total = MAX_REMEMBERED_SERVER_SESSIONS + 10;
    for (let i = 0; i < total; i += 1) writeServerSession(`srv-${i}`, `deck_${i}_brain`, storage);

    const snapshotKeys = storage.keys().filter((key) => key.startsWith('rcc_session_srv-'));
    expect(snapshotKeys).toHaveLength(MAX_REMEMBERED_SERVER_SESSIONS);
    expect(readServerSession('srv-0', storage)).toBeNull(); // oldest evicted
    expect(readServerSession('srv-9', storage)).toBeNull();
    expect(readServerSession('srv-10', storage)).toBe('deck_10_brain');
    expect(readServerSession(`srv-${total - 1}`, storage)).toBe(`deck_${total - 1}_brain`);
    expect(JSON.parse(storage.getItem(SERVER_SESSION_INDEX_STORAGE_KEY)!)).toHaveLength(MAX_REMEMBERED_SERVER_SESSIONS);
  });

  it('refreshing a server moves it to the front so an actively used server is never the one evicted', () => {
    const storage = new MemoryStorage();
    for (let i = 0; i < MAX_REMEMBERED_SERVER_SESSIONS; i += 1) writeServerSession(`srv-${i}`, `t${i}`, storage);
    writeServerSession('srv-0', 'still-used', storage); // oldest, but used again
    writeServerSession('srv-new', 'fresh', storage); // pushes one out

    expect(readServerSession('srv-0', storage)).toBe('still-used');
    expect(readServerSession('srv-1', storage)).toBeNull();
  });

  it('survives a corrupt or hostile index without throwing or losing the snapshot being written', () => {
    for (const corrupt of ['not json', '{"a":1}', '[1,2,{"x":1}]', 'null', '"str"']) {
      const storage = new MemoryStorage();
      storage.setItem(SERVER_SESSION_INDEX_STORAGE_KEY, corrupt);
      expect(() => writeServerSession('srv-a', 'deck_a', storage)).not.toThrow();
      expect(readServerSession('srv-a', storage)).toBe('deck_a');
      expect(readLastRememberedServerId(storage)).toBe('srv-a');
    }
  });

  it('never throws when storage is unavailable or full, and reads as nothing remembered', () => {
    const storage = new MemoryStorage();
    writeServerSession('srv-a', 'deck_a', storage);
    storage.throwOn = new Set(['get', 'set', 'remove']);
    expect(() => writeServerSession('srv-a', 'deck_b', storage)).not.toThrow();
    expect(() => writeServerSession('srv-a', null, storage)).not.toThrow();
    expect(readServerSession('srv-a', storage)).toBeNull();
    expect(readLastRememberedServerId(storage)).toBeNull();
  });

  it('ignores oversized values and ids instead of storing them', () => {
    const storage = new MemoryStorage();
    writeServerSession('srv-a', 'x'.repeat(1_025), storage);
    expect(readServerSession('srv-a', storage)).toBeNull();
    writeServerSession('s'.repeat(513), 'deck_a', storage);
    expect(storage.keys()).toEqual([]);
  });

  it('does nothing for an empty server id', () => {
    const storage = new MemoryStorage();
    writeServerSession('', 'deck_a', storage);
    expect(readServerSession('', storage)).toBeNull();
    expect(storage.keys()).toEqual([]);
  });
});
