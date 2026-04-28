import { useSyncExternalStore } from 'preact/compat';
import { useEffect, useMemo } from 'preact/hooks';
import { getUserPref, onUserPrefChanged, saveUserPref, type UserPrefChangedMeta } from '../api.js';
import { createSharedResource, type SharedResource } from '../stores/shared-resource.js';

export interface UsePrefOptions<T> {
  legacyKey?: string;
  parse?: (raw: unknown) => T | null;
  serialize?: (value: T) => unknown;
}

export interface UsePrefResult<T> {
  value: T | null;
  rawValue: unknown | null;
  loaded: boolean;
  loading: boolean;
  stale: boolean;
  error: unknown | null;
  save: (value: T) => Promise<void>;
  set: (value: T) => void;
  reload: () => Promise<T | null>;
}

type PrefEntry = {
  key: string;
  legacyKey?: string;
  resource: SharedResource<unknown>;
  migrationAttempted: boolean;
  primaryAuthoritative: boolean;
  localWriteVersion: number;
  hasLocalPrimaryWrite: boolean;
  needsLegacyRetry: boolean;
  recentLocalWrites: Array<{ version: number; raw: unknown; source: 'set' | 'save' | 'migration' }>;
};

const MAX_RECENT_LOCAL_WRITES = 20;

const prefEntries = new Map<string, PrefEntry>();
let prefDispatcherUnsubscribe: (() => void) | null = null;

const noopSubscribe = () => () => undefined;
const nullSnapshot = { value: null, loaded: false, loading: false, stale: false, error: null };
const noopSave = async () => undefined;
const noopSet = () => undefined;
const noopReload = async () => null;

export function parseString(raw: unknown): string | null {
  return typeof raw === 'string' && raw ? raw : null;
}

export function parseOptionalString(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null;
}

export function parseBooleanish(raw: unknown): boolean | null {
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return null;
}

export function parseJsonValue<T>(raw: unknown, normalize?: (value: unknown) => T | null): T | null {
  if (typeof raw !== 'string') return normalize ? normalize(raw) : null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalize ? normalize(parsed) : parsed as T;
  } catch {
    return null;
  }
}

function ensurePrefDispatcher(): void {
  if (prefDispatcherUnsubscribe) return;
  try {
    prefDispatcherUnsubscribe = onUserPrefChanged((changedKey, rawValue, meta) => {
      for (const entry of prefEntries.values()) {
        if (changedKey === entry.key) {
          applyPrimaryEvent(entry, rawValue, meta);
        } else if (entry.legacyKey && changedKey === entry.legacyKey) {
          applyLegacyEvent(entry, rawValue);
        }
      }
    });
  } catch {
    // Some focused component tests mock only get/save preference helpers. In
    // production api.ts always exports onUserPrefChanged; without it, cache
    // sharing still works for direct loads/saves but external event fan-out is disabled.
    prefDispatcherUnsubscribe = () => undefined;
  }
}

function rawEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function recordLocalWrite(
  entry: PrefEntry,
  raw: unknown,
  source: 'set' | 'save' | 'migration',
): number {
  entry.localWriteVersion += 1;
  const version = entry.localWriteVersion;
  entry.recentLocalWrites.push({ version, raw, source });
  if (entry.recentLocalWrites.length > MAX_RECENT_LOCAL_WRITES) {
    entry.recentLocalWrites.splice(0, entry.recentLocalWrites.length - MAX_RECENT_LOCAL_WRITES);
  }
  return version;
}

function findRecentLocalWrite(entry: PrefEntry, rawValue: unknown): { version: number; raw: unknown; source: 'set' | 'save' | 'migration' } | null {
  for (let index = entry.recentLocalWrites.length - 1; index >= 0; index -= 1) {
    const candidate = entry.recentLocalWrites[index];
    if (candidate && rawEquals(candidate.raw, rawValue)) return candidate;
  }
  return null;
}

function applyPrimaryEvent(entry: PrefEntry, rawValue: unknown, meta?: UserPrefChangedMeta): void {
  const source = meta?.source ?? 'local';
  if (source === 'local') {
    const matchingLocalWrite = findRecentLocalWrite(entry, rawValue);
    if (matchingLocalWrite && matchingLocalWrite.version < entry.localWriteVersion) return;
    if (!matchingLocalWrite && entry.recentLocalWrites.length >= MAX_RECENT_LOCAL_WRITES) {
      return;
    }
  }
  entry.primaryAuthoritative = true;
  entry.resource.mutate(rawValue);
}

function applyLegacyEvent(entry: PrefEntry, rawValue: unknown): void {
  if (entry.primaryAuthoritative || entry.hasLocalPrimaryWrite) return;
  entry.migrationAttempted = true;
  if (rawValue == null) return;
  if (entry.legacyKey) {
    entry.primaryAuthoritative = true;
    recordLocalWrite(entry, rawValue, 'migration');
    entry.resource.mutate(rawValue);
    void saveUserPref(entry.key, rawValue).catch(() => undefined);
  }
}

function createPrefEntry(key: string, legacyKey?: string): PrefEntry {
  const entry: PrefEntry = {
    key,
    legacyKey,
    resource: undefined as unknown as SharedResource<unknown>,
    migrationAttempted: false,
    primaryAuthoritative: false,
    localWriteVersion: 0,
    hasLocalPrimaryWrite: false,
    needsLegacyRetry: false,
    recentLocalWrites: [],
  };
  entry.resource = createSharedResource<unknown>({
    fetcher: async () => {
      const primary = await getUserPref(key);
      if (primary !== null) {
        entry.primaryAuthoritative = true;
        return primary;
      }
      if (!entry.legacyKey || entry.migrationAttempted) return null;
      entry.migrationAttempted = true;
      const legacy = await getUserPref(entry.legacyKey);
      if (entry.primaryAuthoritative || entry.hasLocalPrimaryWrite) return entry.resource.peek().value ?? null;
      if (legacy !== null) {
        recordLocalWrite(entry, legacy, 'migration');
        entry.primaryAuthoritative = true;
        void saveUserPref(key, legacy).catch(() => undefined);
      }
      return legacy;
    },
  });
  return entry;
}

function getPrefEntry(key: string, legacyKey?: string): PrefEntry {
  ensurePrefDispatcher();
  let entry = prefEntries.get(key);
  if (!entry) {
    entry = createPrefEntry(key, legacyKey);
    prefEntries.set(key, entry);
  } else if (legacyKey && !entry.legacyKey) {
    entry.legacyKey = legacyKey;
    const snapshot = entry.resource.peek();
    if (
      snapshot.loaded
      && snapshot.value == null
      && !entry.migrationAttempted
      && !entry.primaryAuthoritative
      && !entry.hasLocalPrimaryWrite
    ) {
      entry.needsLegacyRetry = true;
    }
  }
  return entry;
}

function parseForConsumer<T>(raw: unknown, parse?: (raw: unknown) => T | null): T | null {
  if (raw == null) return null;
  if (!parse) return raw as T;
  try {
    return parse(raw);
  } catch {
    return null;
  }
}

function serializeForSave<T>(value: T, serialize?: (value: T) => unknown): unknown {
  return serialize ? serialize(value) : value;
}

export function usePref<T = unknown>(key: string | null, opts?: UsePrefOptions<T>): UsePrefResult<T> {
  if (!key) {
    useSyncExternalStore(noopSubscribe, () => nullSnapshot);
    useEffect(() => undefined, []);
    useMemo(() => null, []);
    useEffect(() => undefined, []);
    return {
      value: null,
      rawValue: null,
      loaded: false,
      loading: false,
      stale: false,
      error: null,
      save: noopSave,
      set: noopSet,
      reload: noopReload,
    };
  }

  const entry = getPrefEntry(key, opts?.legacyKey);
  const snapshot = entry.resource.use();
  const parsed = useMemo(
    () => parseForConsumer(snapshot.value, opts?.parse),
    [snapshot.value, opts?.parse],
  );
  useEffect(() => {
    if (!entry.needsLegacyRetry) return;
    entry.needsLegacyRetry = false;
    void entry.resource.reload().catch(() => undefined);
  }, [entry, opts?.legacyKey, snapshot.loaded, snapshot.value]);

  const set = (value: T) => {
    const raw = serializeForSave(value, opts?.serialize);
    recordLocalWrite(entry, raw, 'set');
    if (raw != null) {
      entry.primaryAuthoritative = true;
      entry.hasLocalPrimaryWrite = true;
    }
    entry.resource.mutate(raw);
  };

  const save = async (value: T) => {
    const raw = serializeForSave(value, opts?.serialize);
    const previousPrimaryAuthoritative = entry.primaryAuthoritative;
    const previousHasLocalPrimaryWrite = entry.hasLocalPrimaryWrite;
    recordLocalWrite(entry, raw, 'save');
    entry.primaryAuthoritative = true;
    entry.hasLocalPrimaryWrite = true;
    entry.resource.mutate(raw);
    try {
      await saveUserPref(key, raw);
    } catch (error) {
      entry.primaryAuthoritative = previousPrimaryAuthoritative;
      entry.hasLocalPrimaryWrite = previousHasLocalPrimaryWrite;
      throw error;
    }
  };

  const reload = async () => {
    const raw = await entry.resource.reload();
    return parseForConsumer(raw, opts?.parse);
  };

  return {
    value: parsed,
    rawValue: snapshot.value,
    loaded: snapshot.loaded,
    loading: snapshot.loading,
    stale: snapshot.stale,
    error: snapshot.error,
    save,
    set,
    reload,
  };
}

export function __resetPrefCacheForTests(): void {
  for (const entry of prefEntries.values()) entry.resource.disposeForTests();
  prefEntries.clear();
  try { prefDispatcherUnsubscribe?.(); } catch { /* ignore */ }
  prefDispatcherUnsubscribe = null;
}
