import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks';
import { CC_PRESET_MSG, normalizeCcPresetName, type CcPreset } from '@shared/cc-presets.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import type { WsClient } from '../ws-client.js';

export const CC_PRESET_REQUEST_TIMEOUT_MS = 20_000;

export const CC_PRESET_ERR_OFFLINE = '__cc_preset_offline__';
export const CC_PRESET_ERR_NOT_LOADED = '__cc_preset_not_loaded__';
export const CC_PRESET_ERR_SYNCING = '__cc_preset_syncing__';
export const CC_PRESET_ERR_SAVE_IN_PROGRESS = '__cc_preset_save_in_progress__';
export const CC_PRESET_ERR_CONFLICT = '__cc_preset_conflict__';
export const CC_PRESET_ERR_RECONNECTED = '__cc_preset_reconnected__';
export const CC_PRESET_ERR_TIMEOUT = '__cc_preset_timeout__';
export const CC_PRESET_ERR_SAVE_FAILED = '__cc_preset_save_failed__';
export const CC_PRESET_ERR_DISCOVER_FAILED = '__cc_preset_discover_failed__';

export interface CcPresetSaveResult {
  ok: boolean;
  presets: CcPreset[];
  conflict?: boolean;
  error?: string;
}

export interface CcPresetDiscoverResult {
  ok: boolean;
  preset?: CcPreset;
  error?: string;
}

interface ActiveListRequest {
  requestId: string;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingSaveEntry {
  requestId: string;
  generation: number;
  targetPresets: CcPreset[];
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: CcPresetSaveResult) => void;
}

interface PendingDiscoverEntry {
  requestId: string;
  generation: number;
  presetName: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: CcPresetDiscoverResult) => void;
}

interface CcPresetStoreEntry {
  ws: WsClient;
  presets: CcPreset[];
  version: string | undefined;
  loaded: boolean;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  discovering: boolean;
  daemonOffline: boolean;
  error: string;
  wasDisconnected: boolean;
  generation: number;
  subscribers: Set<() => void>;
  enabledSubscribers: Set<string>;
  activeListRequest: ActiveListRequest | null;
  pendingSaves: PendingSaveEntry[];
  pendingDiscovers: PendingDiscoverEntry[];
  unsubWs: (() => void) | null;
}

const wsPresetStore = new WeakMap<object, CcPresetStoreEntry>();
let requestSeq = 0;

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${requestSeq}-${Date.now()}`;
}

function notifyStore(entry: CcPresetStoreEntry): void {
  for (const listener of entry.subscribers) {
    listener();
  }
}

function clearActiveListRequest(entry: CcPresetStoreEntry): void {
  if (entry.activeListRequest) {
    clearTimeout(entry.activeListRequest.timer);
    entry.activeListRequest = null;
  }
  entry.loading = false;
  entry.refreshing = false;
}

function rejectPendingOperations(entry: CcPresetStoreEntry, error: string): void {
  const saves = entry.pendingSaves.splice(0);
  const discovers = entry.pendingDiscovers.splice(0);
  entry.saving = false;
  entry.discovering = false;
  if (saves.length > 0 || discovers.length > 0) {
    entry.error = error;
  }
  for (const save of saves) {
    clearTimeout(save.timer);
    save.resolve({ ok: false, presets: entry.presets, error });
  }
  for (const discover of discovers) {
    clearTimeout(discover.timer);
    discover.resolve({ ok: false, error });
  }
}

function bumpGeneration(entry: CcPresetStoreEntry, error: string, daemonOffline: boolean): void {
  entry.generation += 1;
  entry.daemonOffline = daemonOffline;
  clearActiveListRequest(entry);
  rejectPendingOperations(entry, error);
}

function requestPresetList(entry: CcPresetStoreEntry): void {
  if (!entry.ws.connected || entry.daemonOffline) {
    entry.wasDisconnected = true;
    clearActiveListRequest(entry);
    return;
  }
  if (entry.activeListRequest) return;
  const requestId = nextRequestId('cc-preset-list');
  const generation = entry.generation;
  const timer = setTimeout(() => {
    if (entry.activeListRequest?.requestId !== requestId || entry.generation !== generation) return;
    entry.activeListRequest = null;
    entry.loading = false;
    entry.refreshing = false;
    entry.error = CC_PRESET_ERR_TIMEOUT;
    notifyStore(entry);
  }, CC_PRESET_REQUEST_TIMEOUT_MS);

  entry.activeListRequest = { requestId, generation, timer };
  entry.refreshing = true;
  entry.loading = !entry.loaded;
  entry.wasDisconnected = false;
  notifyStore(entry);
  try {
    entry.ws.send({ type: CC_PRESET_MSG.LIST, requestId });
  } catch {
    clearActiveListRequest(entry);
    notifyStore(entry);
  }
}

function ensureStoreSubscription(entry: CcPresetStoreEntry): void {
  if (entry.unsubWs || typeof entry.ws.onMessage !== 'function') return;
  entry.unsubWs = entry.ws.onMessage((msg) => {
    const type = (msg as { type?: string }).type;

    if (type === DAEMON_MSG.DISCONNECTED) {
      bumpGeneration(entry, CC_PRESET_ERR_OFFLINE, true);
      notifyStore(entry);
      return;
    }

    if (type === DAEMON_MSG.RECONNECTED) {
      entry.wasDisconnected = false;
      bumpGeneration(entry, CC_PRESET_ERR_RECONNECTED, false);
      notifyStore(entry);
      if (entry.enabledSubscribers.size > 0) {
        requestPresetList(entry);
      }
      return;
    }

    // Browser WS reconnect fallback when session_list (or control frame) arrives
    // after ws.connected had dropped to false.
    if (entry.wasDisconnected && entry.ws.connected) {
      entry.wasDisconnected = false;
      entry.daemonOffline = false;
      bumpGeneration(entry, CC_PRESET_ERR_RECONNECTED, false);
      if (entry.enabledSubscribers.size > 0 && type !== CC_PRESET_MSG.LIST_RESPONSE) {
        requestPresetList(entry);
      }
    }

    if (type === CC_PRESET_MSG.LIST_RESPONSE) {
      const listMsg = msg as { requestId?: string; presets?: CcPreset[]; version?: string };
      if (entry.activeListRequest) {
        if (
          !listMsg.requestId
          || entry.activeListRequest.requestId !== listMsg.requestId
          || entry.activeListRequest.generation !== entry.generation
        ) {
          return;
        }
      } else if (listMsg.requestId) {
        return;
      }
      clearActiveListRequest(entry);
      entry.daemonOffline = false;
      entry.presets = Array.isArray(listMsg.presets) ? listMsg.presets : [];
      entry.version = typeof listMsg.version === 'string' ? listMsg.version : undefined;
      entry.loaded = true;
      if (
        entry.error === CC_PRESET_ERR_NOT_LOADED
        || entry.error === CC_PRESET_ERR_SYNCING
        || entry.error === CC_PRESET_ERR_RECONNECTED
        || entry.error === CC_PRESET_ERR_TIMEOUT
      ) {
        entry.error = '';
      }
      notifyStore(entry);
      return;
    }

    if (type === CC_PRESET_MSG.SAVE_RESPONSE) {
      const saveMsg = msg as {
        requestId?: string;
        ok?: boolean;
        version?: string;
        presets?: CcPreset[];
        conflict?: boolean;
        error?: string;
      };
      const idx = saveMsg.requestId
        ? entry.pendingSaves.findIndex(
            (item) => item.requestId === saveMsg.requestId && item.generation === entry.generation,
          )
        : entry.pendingSaves.findIndex((item) => item.generation === entry.generation);
      if (idx === -1) return;
      const [pending] = entry.pendingSaves.splice(idx, 1);
      clearTimeout(pending.timer);
      entry.saving = entry.pendingSaves.length > 0;
      entry.daemonOffline = false;
      if (saveMsg.ok) {
        entry.presets = Array.isArray(saveMsg.presets) ? saveMsg.presets : pending.targetPresets;
        if (typeof saveMsg.version === 'string') {
          entry.version = saveMsg.version;
        }
        entry.loaded = true;
        entry.error = '';
        notifyStore(entry);
        pending.resolve({ ok: true, presets: entry.presets });
      } else if (saveMsg.conflict) {
        if (Array.isArray(saveMsg.presets)) {
          entry.presets = saveMsg.presets;
          entry.version = typeof saveMsg.version === 'string' ? saveMsg.version : undefined;
          entry.loaded = true;
        } else if (entry.enabledSubscribers.size > 0) {
          requestPresetList(entry);
        }
        entry.error = CC_PRESET_ERR_CONFLICT;
        notifyStore(entry);
        pending.resolve({ ok: false, conflict: true, presets: entry.presets, error: CC_PRESET_ERR_CONFLICT });
      } else {
        const err = saveMsg.error?.trim() || CC_PRESET_ERR_SAVE_FAILED;
        entry.error = err;
        notifyStore(entry);
        pending.resolve({ ok: false, presets: entry.presets, error: err });
      }
      return;
    }

    if (type === CC_PRESET_MSG.DISCOVER_MODELS_RESPONSE) {
      const dMsg = msg as {
        requestId?: string;
        presetName?: string;
        ok?: boolean;
        preset?: CcPreset;
        presets?: CcPreset[];
        version?: string;
        error?: string;
      };
      const normalizedTarget = normalizeCcPresetName(dMsg.presetName ?? dMsg.preset?.name ?? '');
      const idx = dMsg.requestId
        ? entry.pendingDiscovers.findIndex(
            (item) => item.requestId === dMsg.requestId && item.generation === entry.generation,
          )
        : (normalizedTarget
            ? entry.pendingDiscovers.findIndex(
                (item) => item.presetName === normalizedTarget && item.generation === entry.generation,
              )
            : (entry.pendingDiscovers.length === 1 && entry.pendingDiscovers[0].generation === entry.generation
                ? 0
                : -1));
      if (idx === -1) {
        return;
      }
      const [pending] = entry.pendingDiscovers.splice(idx, 1);
      clearTimeout(pending.timer);
      entry.discovering = entry.pendingDiscovers.length > 0;
      entry.daemonOffline = false;
      if (Array.isArray(dMsg.presets) && typeof dMsg.version === 'string') {
        entry.presets = dMsg.presets;
        entry.version = dMsg.version;
        entry.loaded = true;
      } else if (dMsg.preset) {
        entry.presets = upsertCcPresetList(entry.presets, dMsg.preset);
        if (entry.version !== undefined && entry.enabledSubscribers.size > 0) {
          requestPresetList(entry);
        }
      }
      if (dMsg.ok) {
        entry.error = '';
        notifyStore(entry);
        pending.resolve({ ok: true, preset: dMsg.preset });
      } else {
        const err = dMsg.error?.trim() || CC_PRESET_ERR_DISCOVER_FAILED;
        entry.error = err;
        notifyStore(entry);
        pending.resolve({ ok: false, preset: dMsg.preset, error: err });
      }
    }
  });
}

function getOrCreateStore(ws: WsClient): CcPresetStoreEntry {
  let entry = wsPresetStore.get(ws);
  if (!entry) {
    entry = {
      ws,
      presets: [],
      version: undefined,
      loaded: false,
      loading: false,
      refreshing: false,
      saving: false,
      discovering: false,
      daemonOffline: false,
      error: '',
      wasDisconnected: !ws.connected,
      generation: 1,
      subscribers: new Set(),
      enabledSubscribers: new Set(),
      activeListRequest: null,
      pendingSaves: [],
      pendingDiscovers: [],
      unsubWs: null,
    };
    wsPresetStore.set(ws, entry);
  }
  return entry;
}

export function upsertCcPresetList(list: readonly CcPreset[], preset: CcPreset): CcPreset[] {
  const key = normalizeCcPresetName(preset.name);
  return [...list.filter((item) => normalizeCcPresetName(item.name) !== key), preset];
}

export interface UseCcPresetsOptions {
  enabled?: boolean;
}

export interface UseCcPresetsResult {
  presets: CcPreset[];
  loaded: boolean;
  loading: boolean;
  refreshing: boolean;
  saving: boolean;
  discovering: boolean;
  error: string;
  setError: (error: string) => void;
  refresh: () => void;
  savePresets: (presets: CcPreset[]) => Promise<CcPresetSaveResult>;
  savePreset: (preset: CcPreset) => Promise<CcPresetSaveResult>;
  deletePreset: (name: string) => Promise<CcPresetSaveResult>;
  discoverModels: (preset: CcPreset) => Promise<CcPresetDiscoverResult>;
}

export function useCcPresets(
  ws: WsClient | null | undefined,
  options: UseCcPresetsOptions = {},
): UseCcPresetsResult {
  const enabled = options.enabled ?? true;
  const subscriberId = useId();
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((v) => v + 1), []);
  const wasActiveConnectedRef = useRef(false);

  const store = ws ? getOrCreateStore(ws) : null;
  const isConnected = Boolean(ws?.connected);

  useEffect(() => {
    if (!ws || !store) {
      wasActiveConnectedRef.current = false;
      return;
    }
    store.subscribers.add(bump);
    ensureStoreSubscription(store);

    if (enabled) {
      store.enabledSubscribers.add(subscriberId);
    } else {
      store.enabledSubscribers.delete(subscriberId);
    }

    if (!ws.connected) {
      wasActiveConnectedRef.current = false;
      if (!store.wasDisconnected) {
        bumpGeneration(store, CC_PRESET_ERR_OFFLINE, false);
      }
      store.wasDisconnected = true;
      notifyStore(store);
    } else {
      if (store.wasDisconnected) {
        store.wasDisconnected = false;
        store.daemonOffline = false;
        bumpGeneration(store, CC_PRESET_ERR_RECONNECTED, false);
      }
      if (enabled && (!wasActiveConnectedRef.current || !store.loaded)) {
        wasActiveConnectedRef.current = true;
        requestPresetList(store);
      } else if (!enabled) {
        wasActiveConnectedRef.current = false;
      }
    }

    return () => {
      store.subscribers.delete(bump);
      store.enabledSubscribers.delete(subscriberId);
      if (store.subscribers.size === 0) {
        if (store.unsubWs) {
          store.unsubWs();
          store.unsubWs = null;
        }
        bumpGeneration(store, CC_PRESET_ERR_OFFLINE, store.daemonOffline);
      }
    };
  }, [ws, store, enabled, isConnected, bump, subscriberId]);

  const refresh = useCallback(() => {
    if (!store) return;
    if (store.activeListRequest) {
      clearTimeout(store.activeListRequest.timer);
      store.activeListRequest = null;
    }
    requestPresetList(store);
  }, [store]);

  const setError = useCallback((error: string) => {
    if (!store) return;
    if (store.error === error) return;
    store.error = error;
    notifyStore(store);
  }, [store]);

  const savePresets = useCallback(async (presets: CcPreset[]): Promise<CcPresetSaveResult> => {
    if (!store || !ws || !ws.connected || store.daemonOffline) {
      if (store) {
        store.error = CC_PRESET_ERR_OFFLINE;
        notifyStore(store);
      }
      return { ok: false, presets: store?.presets ?? [], error: CC_PRESET_ERR_OFFLINE };
    }
    if (!store.loaded) {
      store.error = CC_PRESET_ERR_NOT_LOADED;
      notifyStore(store);
      return { ok: false, presets: store.presets, error: CC_PRESET_ERR_NOT_LOADED };
    }
    if (store.refreshing || store.activeListRequest || store.discovering || store.pendingDiscovers.length > 0) {
      store.error = CC_PRESET_ERR_SYNCING;
      notifyStore(store);
      return { ok: false, presets: store.presets, error: CC_PRESET_ERR_SYNCING };
    }
    if (store.saving || store.pendingSaves.length > 0) {
      store.error = CC_PRESET_ERR_SAVE_IN_PROGRESS;
      notifyStore(store);
      return { ok: false, presets: store.presets, error: CC_PRESET_ERR_SAVE_IN_PROGRESS };
    }

    const requestId = nextRequestId('cc-preset-save');
    const generation = store.generation;
    store.saving = true;
    store.error = '';
    notifyStore(store);

    return new Promise<CcPresetSaveResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = store.pendingSaves.indexOf(pending);
        if (idx === -1) return;
        store.pendingSaves.splice(idx, 1);
        store.saving = store.pendingSaves.length > 0;
        store.error = CC_PRESET_ERR_TIMEOUT;
        notifyStore(store);
        resolve({ ok: false, presets: store.presets, error: CC_PRESET_ERR_TIMEOUT });
      }, CC_PRESET_REQUEST_TIMEOUT_MS);

      const pending: PendingSaveEntry = { requestId, generation, targetPresets: presets, timer, resolve };
      store.pendingSaves.push(pending);
      try {
        ws.send({
          type: CC_PRESET_MSG.SAVE,
          requestId,
          ...(store.version !== undefined ? { expectedVersion: store.version } : {}),
          presets,
        });
      } catch (err) {
        const idx = store.pendingSaves.indexOf(pending);
        if (idx !== -1) store.pendingSaves.splice(idx, 1);
        clearTimeout(timer);
        store.saving = store.pendingSaves.length > 0;
        const message = err instanceof Error ? err.message : CC_PRESET_ERR_SAVE_FAILED;
        store.error = message;
        notifyStore(store);
        resolve({ ok: false, presets: store.presets, error: message });
      }
    });
  }, [store, ws]);

  const savePreset = useCallback(async (preset: CcPreset): Promise<CcPresetSaveResult> => {
    const current = store?.presets ?? [];
    const updated = upsertCcPresetList(current, preset);
    return savePresets(updated);
  }, [store, savePresets]);

  const deletePreset = useCallback(async (name: string): Promise<CcPresetSaveResult> => {
    const key = normalizeCcPresetName(name);
    const current = store?.presets ?? [];
    const updated = current.filter((item) => normalizeCcPresetName(item.name) !== key);
    return savePresets(updated);
  }, [store, savePresets]);

  const discoverModels = useCallback(async (preset: CcPreset): Promise<CcPresetDiscoverResult> => {
    if (!ws || !store || !ws.connected || store.daemonOffline) {
      if (store) {
        store.error = CC_PRESET_ERR_OFFLINE;
        notifyStore(store);
      }
      return { ok: false, error: CC_PRESET_ERR_OFFLINE };
    }
    if (!store.loaded) {
      store.error = CC_PRESET_ERR_NOT_LOADED;
      notifyStore(store);
      return { ok: false, error: CC_PRESET_ERR_NOT_LOADED };
    }
    if (store.refreshing || store.activeListRequest) {
      store.error = CC_PRESET_ERR_SYNCING;
      notifyStore(store);
      return { ok: false, error: CC_PRESET_ERR_SYNCING };
    }

    const saveResult = await savePreset(preset);
    if (!saveResult.ok) {
      return { ok: false, error: saveResult.error ?? CC_PRESET_ERR_SAVE_FAILED };
    }
    if (!ws.connected || store.daemonOffline) {
      store.error = CC_PRESET_ERR_OFFLINE;
      notifyStore(store);
      return { ok: false, error: CC_PRESET_ERR_OFFLINE };
    }

    const requestId = nextRequestId('cc-preset-discover');
    const generation = store.generation;
    store.discovering = true;
    store.error = '';
    notifyStore(store);

    return new Promise<CcPresetDiscoverResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = store.pendingDiscovers.indexOf(pending);
        if (idx === -1) return;
        store.pendingDiscovers.splice(idx, 1);
        store.discovering = store.pendingDiscovers.length > 0;
        store.error = CC_PRESET_ERR_TIMEOUT;
        notifyStore(store);
        resolve({ ok: false, error: CC_PRESET_ERR_TIMEOUT });
      }, CC_PRESET_REQUEST_TIMEOUT_MS);

      const pending: PendingDiscoverEntry = {
        requestId,
        generation,
        presetName: normalizeCcPresetName(preset.name),
        timer,
        resolve,
      };
      store.pendingDiscovers.push(pending);
      try {
        ws.send({
          type: CC_PRESET_MSG.DISCOVER_MODELS,
          requestId,
          presetName: preset.name,
        });
      } catch (err) {
        const idx = store.pendingDiscovers.indexOf(pending);
        if (idx !== -1) store.pendingDiscovers.splice(idx, 1);
        clearTimeout(timer);
        store.discovering = store.pendingDiscovers.length > 0;
        const message = err instanceof Error ? err.message : CC_PRESET_ERR_DISCOVER_FAILED;
        store.error = message;
        notifyStore(store);
        resolve({ ok: false, error: message });
      }
    });
  }, [ws, store, savePreset]);

  return {
    presets: store?.presets ?? [],
    loaded: store?.loaded ?? false,
    loading: store?.loading ?? false,
    refreshing: store?.refreshing ?? false,
    saving: store?.saving ?? false,
    discovering: store?.discovering ?? false,
    error: store?.error ?? '',
    setError,
    refresh,
    savePresets,
    savePreset,
    deletePreset,
    discoverModels,
  };
}
