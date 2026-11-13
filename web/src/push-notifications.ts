/**
 * Push notification registration for Capacitor apps.
 *
 * Three flows, picked at runtime by Capacitor platform × compile-time region:
 *   - iOS:                                APNs (via @capacitor/push-notifications)
 *   - Android, International edition:     FCM  (via @capacitor/push-notifications)
 *   - Android, Mainland China edition:    JPush 极光推送 (via our custom JPush plugin)
 *
 * The Mainland China branch sends platform='android-jpush' to /api/push/register
 * so the server's dispatchPush() routes the message to the JPush v3 REST API
 * instead of FCM. See shared/push-notifications.ts for the platform constants
 * and server/src/routes/push.ts for the dispatch side.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNative = (): boolean => typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' && (globalThis as any).Capacitor.isNativePlatform();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getPlatform = (): string => (globalThis as any).Capacitor?.getPlatform?.() ?? 'unknown';

import {
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_FCM,
  PUSH_PLATFORM_ANDROID_JPUSH,
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  DEFAULT_PUSH_ENABLED_SERVER_IDS,
  isPushNotificationType,
  sanitizePushEnabledServerIds,
  type PushPlatform,
  type PushNotificationType,
} from '@shared/push-notifications.js';

let pushSupported = false;
let resetBadgePromise: Promise<void> | null = null;
let lastBadgeResetAt = 0;

// Expose badge-reset to native layer (AppDelegate calls via evaluateJavaScript on app foreground).
// Uses apiFetch which prepends baseUrl and includes Bearer token — relative URLs fail in Capacitor.
import { apiFetch } from './api.js';
import { ACTIVE_TIMELINE_REFRESH_EVENT } from './hooks/useTimeline.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__imcodesResetBadge = () => {
  void resetPushBadge(true);
};

export async function resetPushBadge(force = false): Promise<void> {
  if (!isNative()) return;
  const now = Date.now();
  if (!force && now - lastBadgeResetAt < 3_000) return;
  if (resetBadgePromise) return resetBadgePromise;
  resetBadgePromise = apiFetch('/api/push/badge-reset', { method: 'POST' })
    .then(() => {
      lastBadgeResetAt = Date.now();
    })
    .catch(() => {})
    .finally(() => {
      resetBadgePromise = null;
    });
  return resetBadgePromise;
}

export async function initPushNotifications(
  apiKey: string,
  cfWorkerUrl: string,
): Promise<void> {
  if (!isNative()) return;

  const platform = getPlatform();
  if (platform === 'android' && __PUSH_REGION__ === 'china') {
    await initJpush(apiKey, cfWorkerUrl);
  } else {
    await initApnsOrFcm(apiKey, cfWorkerUrl);
  }
}

// ── APNs (iOS) / FCM (International Android) via @capacitor/push-notifications ──

async function initApnsOrFcm(apiKey: string, cfWorkerUrl: string): Promise<void> {
  // Dynamic import to avoid bundling on web
  // @ts-ignore
  const { PushNotifications } = await import('@capacitor/push-notifications');

  const perms = await PushNotifications.checkPermissions();
  if (perms.receive !== 'granted') {
    const req = await PushNotifications.requestPermissions();
    if (req.receive !== 'granted') return;
  }

  pushSupported = true;
  await PushNotifications.register();

  PushNotifications.addListener('registration', async (token: { value: string }) => {
    const platform: PushPlatform =
      getPlatform() === 'ios' ? PUSH_PLATFORM_IOS : PUSH_PLATFORM_ANDROID_FCM;
    await registerDeviceToken(token.value, platform, apiKey, cfWorkerUrl);
  });

  PushNotifications.addListener('pushNotificationReceived', (notification: unknown) => {
    console.log('Push received:', notification);
  });

  PushNotifications.addListener('pushNotificationActionPerformed', (action: { notification: { data: unknown } }) => {
    console.log('Push action:', action);
    const data = action.notification.data as Record<string, string> | undefined;
    handleNotificationOpen(data);
  });
}

// ── JPush 极光推送 (Mainland China Android) ──────────────────────────────────

interface JPushPluginShape {
  getRegistrationID(): Promise<{ registrationID: string }>;
  clearAllNotifications(): Promise<void>;
  addListener(
    eventName: 'registration',
    handler: (data: { registrationID: string }) => void,
  ): Promise<unknown>;
  addListener(
    eventName: 'notificationOpened' | 'notificationReceived',
    handler: (data: { title?: string; alert?: string; extras?: Record<string, unknown> }) => void,
  ): Promise<unknown>;
}

async function initJpush(apiKey: string, cfWorkerUrl: string): Promise<void> {
  // The JPush plugin only exists in the Mainland China flavor APK.
  // registerPlugin returns a proxy that throws on first call if the native
  // impl is missing, so wrap it in try/catch to fail soft on the International
  // flavor APK if it ever reaches this branch.
  let JPush: JPushPluginShape;
  try {
    // Dynamic import keeps @capacitor/core out of pre-mount code paths.
    const { registerPlugin } = await import('@capacitor/core');
    JPush = registerPlugin<JPushPluginShape>('JPush');
  } catch (err) {
    console.warn('JPush plugin unavailable — push disabled this session', err);
    return;
  }

  pushSupported = true;

  // Listener for late-arriving registration_id (JPush SDK provisions
  // asynchronously after JPushInterface.init in AppApplication).
  await JPush.addListener('registration', async (data) => {
    if (data.registrationID) {
      await registerDeviceToken(
        data.registrationID,
        PUSH_PLATFORM_ANDROID_JPUSH,
        apiKey,
        cfWorkerUrl,
      );
    }
  });

  await JPush.addListener('notificationReceived', (data) => {
    console.log('JPush received:', data);
  });

  await JPush.addListener('notificationOpened', (data) => {
    console.log('JPush opened:', data);
    handleNotificationOpen(data.extras as Record<string, string> | undefined);
  });

  // Best-effort immediate fetch: if the SDK has already provisioned the id
  // (warm start), this resolves quickly and we don't need to wait for the
  // 'registration' event.
  try {
    const { registrationID } = await JPush.getRegistrationID();
    if (registrationID) {
      await registerDeviceToken(
        registrationID,
        PUSH_PLATFORM_ANDROID_JPUSH,
        apiKey,
        cfWorkerUrl,
      );
    }
  } catch {
    // Cold start: the 'registration' listener above will catch it instead.
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function handleNotificationOpen(data: Record<string, string> | undefined): void {
  if (data?.serverId || data?.session) {
    window.dispatchEvent(new CustomEvent('deck:navigate', {
      detail: { serverId: data.serverId, session: data.session },
    }));
  }
  // Force a fresh HTTP backfill of the now-active session regardless of
  // whether navigation actually switched sessions. If the target session
  // was already mounted, `setActiveSession` no-ops and the mount-time
  // backfill never fires — the user would see stale messages until the
  // next WS event. Dispatching ACTIVE_TIMELINE_REFRESH_EVENT pulls the
  // latest timeline via the history API immediately.
  //
  // Dispatch twice to cover two race windows:
  //   1. Synchronous — already-mounted SessionPane listeners catch it.
  //   2. After two requestAnimationFrame ticks — gives React time to
  //      re-render from the deck:navigate → setActiveSession update
  //      above so a SessionPane that mounts for a just-activated
  //      session (cold tab, notification for a previously-unvisited
  //      session) can still attach its listener and catch the refresh.
  //      useTimeline's handler is idempotent — the 200ms debounce inside
  //      fireHttpBackfill coalesces back-to-back dispatches.
  const fireRefresh = (): void => {
    try { window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT)); } catch { /* ignore */ }
  };
  fireRefresh();
  requestAnimationFrame(() => requestAnimationFrame(fireRefresh));
}

export const PUSH_NOTIFICATION_PREFERENCES_KEY = 'imcodes.push_notification_preferences';
export const PUSH_ENABLED_SERVERS_PREFERENCES_KEY = 'imcodes.push_enabled_server_ids';

interface SyncedLocalPreference<TValue> {
  hasUnsyncedEdits: () => boolean;
  getLastSyncedGeneration: () => number;
  getCurrentEditGeneration: () => number;
  resetForTesting: () => void;
  getLocal: () => TValue;
  setLocal: (value: TValue) => void;
  recordEdit: (value: TValue) => number;
  rollbackTo: (previousValue: TValue, expectedGen: number) => boolean;
  subscribe: (listener: (value: TValue) => void) => () => void;
  applyRemoteIfClean: (raw: unknown, startGen: number, wasDirtyAtStart: boolean) => TValue | undefined;
  sync: (value: TValue) => Promise<boolean>;
  commit: (value: TValue, fallbackPrevious?: TValue) => Promise<boolean>;
}

function createSyncedLocalPreference<TValue>(options: {
  storageKey: string;
  getDefault: () => TValue;
  parseValue: (raw: unknown) => TValue | undefined;
  serializeLocal: (value: TValue) => string | null;
  buildPostBody: (value: TValue) => Record<string, unknown>;
}): SyncedLocalPreference<TValue> {
  let currentEditGeneration = 0;
  let lastSyncedGeneration = 0;
  let syncQueue: Promise<void> = Promise.resolve();
  let pendingSync: { value: TValue; generation: number } | null = null;
  let confirmedSnapshot: { hasValue: boolean; value: TValue } = {
    hasValue: false,
    value: options.getDefault(),
  };
  let preDirtyBaseline: { hasValue: boolean; value: TValue } = {
    hasValue: false,
    value: options.getDefault(),
  };
  let lastBatchAttempt: { coveredGen: number; ok: boolean } | null = null;
  const listeners = new Set<(value: TValue) => void>();

  const cloneValue = (value: TValue): TValue =>
    (Array.isArray(value) ? [...value] : value) as TValue;

  const notify = (value: TValue): void => {
    for (const listener of listeners) {
      listener(cloneValue(value));
    }
  };

  const hasUnsyncedEdits = (): boolean => {
    if (pendingSync !== null) return true;
    if (currentEditGeneration > lastSyncedGeneration) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(options.storageKey) === null) {
          currentEditGeneration = 0;
          lastSyncedGeneration = 0;
          return false;
        }
      } catch {
        // ignore
      }
      return true;
    }
    return false;
  };

  const getLocal = (): TValue => {
    try {
      const raw = localStorage.getItem(options.storageKey);
      if (raw !== null) {
        const parsed = options.parseValue(JSON.parse(raw));
        if (parsed !== undefined) {
          return parsed;
        }
      }
    } catch {
      // fallback
    }
    return options.getDefault();
  };

  const setLocal = (value: TValue): void => {
    try {
      const serialized = options.serializeLocal(value);
      if (serialized === null) {
        localStorage.removeItem(options.storageKey);
      } else {
        localStorage.setItem(options.storageKey, serialized);
      }
    } catch {
      // ignore
    }
    notify(value);
  };

  const capturePreDirtyBaselineIfClean = (): void => {
    if (
      !confirmedSnapshot.hasValue
      && !preDirtyBaseline.hasValue
      && currentEditGeneration === lastSyncedGeneration
      && pendingSync === null
    ) {
      preDirtyBaseline = {
        hasValue: true,
        value: cloneValue(getLocal()),
      };
    }
  };

  const recordEdit = (value: TValue): number => {
    capturePreDirtyBaselineIfClean();
    currentEditGeneration++;
    setLocal(value);
    return currentEditGeneration;
  };

  const rollbackTo = (previousValue: TValue, expectedGen: number): boolean => {
    if (currentEditGeneration !== expectedGen) return false;
    // Never roll back to an unconfirmed optimistic intermediate value supplied by a caller:
    // prefer the last server-confirmed snapshot, else the clean pre-dirty baseline captured before
    // this unconfirmed edit chain began.
    const rollbackTarget = confirmedSnapshot.hasValue
      ? cloneValue(confirmedSnapshot.value)
      : preDirtyBaseline.hasValue
        ? cloneValue(preDirtyBaseline.value)
        : cloneValue(previousValue);
    pendingSync = null;
    preDirtyBaseline = { hasValue: false, value: options.getDefault() };
    lastBatchAttempt = null;
    lastSyncedGeneration = currentEditGeneration;
    setLocal(rollbackTarget);
    return true;
  };

  const subscribe = (listener: (value: TValue) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const applyRemoteIfClean = (raw: unknown, startGen: number, wasDirtyAtStart: boolean): TValue | undefined => {
    const valid = options.parseValue(raw);
    if (valid === undefined) return undefined;
    // Guard against:
    // 1. Reads initiated while dirty (un-ACKed/pending local edits) - cannot be upgraded by subsequent ACK;
    // 2. Reads arriving after newer local edits were made;
    // 3. Reads completing while local state is currently dirty.
    if (wasDirtyAtStart || currentEditGeneration > startGen || hasUnsyncedEdits()) {
      return undefined;
    }
    confirmedSnapshot = { hasValue: true, value: cloneValue(valid) };
    preDirtyBaseline = { hasValue: false, value: options.getDefault() };
    setLocal(valid);
    return valid;
  };

  const sync = async (value: TValue): Promise<boolean> => {
    const gen = recordEdit(value);
    pendingSync = { value, generation: gen };
    let ok = true;

    const myAttempt = syncQueue.then(async () => {
      if (!pendingSync || lastSyncedGeneration >= gen) {
        ok = true;
        return;
      }
      if (lastBatchAttempt && gen <= lastBatchAttempt.coveredGen) {
        ok = lastBatchAttempt.ok;
        return;
      }
      const targetGen = pendingSync.generation;
      const toSend = pendingSync.value;
      try {
        const res = await apiFetch<{ ok?: boolean }>('/api/push/preferences', {
          method: 'POST',
          body: JSON.stringify(options.buildPostBody(toSend)),
        });
        if (res && res.ok !== false) {
          if (lastSyncedGeneration < targetGen) {
            lastSyncedGeneration = targetGen;
          }
          confirmedSnapshot = { hasValue: true, value: cloneValue(toSend) };
          preDirtyBaseline = { hasValue: false, value: options.getDefault() };
          if (pendingSync && pendingSync.generation <= targetGen) {
            pendingSync = null;
          }
          lastBatchAttempt = { coveredGen: targetGen, ok: true };
          ok = true;
        } else {
          throw new Error('Push preferences update failed');
        }
      } catch (err) {
        ok = false;
        lastBatchAttempt = { coveredGen: targetGen, ok: false };
        console.warn('Failed to sync push notification preferences:', err);
        // Do NOT clear pendingSync on failure, retaining dirty state for subsequent sync/read guards
      }
    });

    syncQueue = myAttempt;
    await myAttempt;
    return ok;
  };

  const commit = async (value: TValue, fallbackPrevious?: TValue): Promise<boolean> => {
    const expectedGen = currentEditGeneration + 1;
    const ok = await sync(value);
    if (!ok) {
      rollbackTo(fallbackPrevious === undefined ? options.getDefault() : fallbackPrevious, expectedGen);
    }
    return ok;
  };

  return {
    hasUnsyncedEdits,
    getLastSyncedGeneration: () => lastSyncedGeneration,
    getCurrentEditGeneration: () => currentEditGeneration,
    resetForTesting: () => {
      currentEditGeneration = 0;
      lastSyncedGeneration = 0;
      syncQueue = Promise.resolve();
      pendingSync = null;
      confirmedSnapshot = { hasValue: false, value: options.getDefault() };
      preDirtyBaseline = { hasValue: false, value: options.getDefault() };
      lastBatchAttempt = null;
      listeners.clear();
    },
    getLocal,
    setLocal,
    recordEdit,
    rollbackTo,
    subscribe,
    applyRemoteIfClean,
    sync,
    commit,
  };
}

const pushTypesPref = createSyncedLocalPreference<PushNotificationType[]>({
  storageKey: PUSH_NOTIFICATION_PREFERENCES_KEY,
  getDefault: () => [...DEFAULT_PUSH_NOTIFICATION_TYPES],
  parseValue: (raw) => (Array.isArray(raw) ? raw.filter(isPushNotificationType) : undefined),
  serializeLocal: (value) => JSON.stringify(value),
  buildPostBody: (types) => ({ types }),
});

const pushServersPref = createSyncedLocalPreference<string[] | null>({
  storageKey: PUSH_ENABLED_SERVERS_PREFERENCES_KEY,
  getDefault: () => (DEFAULT_PUSH_ENABLED_SERVER_IDS ? [...DEFAULT_PUSH_ENABLED_SERVER_IDS] : null),
  parseValue: (raw) => {
    if (raw === null) return null;
    if (Array.isArray(raw)) return sanitizePushEnabledServerIds(raw);
    return undefined;
  },
  serializeLocal: (value) => (value === null ? null : JSON.stringify(sanitizePushEnabledServerIds(value))),
  buildPostBody: (enabledServerIds) => ({
    enabledServerIds: enabledServerIds === null ? null : sanitizePushEnabledServerIds(enabledServerIds),
  }),
});

export function hasUnsyncedPushNotificationEdits(): boolean {
  return pushTypesPref.hasUnsyncedEdits();
}

export function getLastSyncedPushNotificationGeneration(): number {
  return pushTypesPref.getLastSyncedGeneration();
}

export function hasUnsyncedPushEnabledServerEdits(): boolean {
  return pushServersPref.hasUnsyncedEdits();
}

export function resetPushNotificationPreferencesStateForTesting(): void {
  pushTypesPref.resetForTesting();
  pushServersPref.resetForTesting();
}

export function getLocalPushNotificationPreferences(): PushNotificationType[] {
  return pushTypesPref.getLocal();
}

export function setLocalPushNotificationPreferences(types: PushNotificationType[]): void {
  pushTypesPref.setLocal(types);
}

export function recordLocalPushNotificationEdit(types: PushNotificationType[]): number {
  return pushTypesPref.recordEdit(types);
}

export function getCurrentPushNotificationEditGeneration(): number {
  return pushTypesPref.getCurrentEditGeneration();
}

export function getLocalPushEnabledServers(): string[] | null {
  return pushServersPref.getLocal();
}

export function setLocalPushEnabledServers(serverIds: string[] | null): void {
  pushServersPref.setLocal(serverIds === null ? null : sanitizePushEnabledServerIds(serverIds));
}

export function recordLocalPushEnabledServersEdit(serverIds: string[] | null): number {
  return pushServersPref.recordEdit(serverIds === null ? null : sanitizePushEnabledServerIds(serverIds));
}

export interface PushNotificationSettingsSnapshot {
  types: PushNotificationType[] | null;
  enabledServerIds: string[] | null | undefined;
}

export async function fetchPushNotificationSettings(): Promise<PushNotificationSettingsSnapshot | null> {
  const typesStartGen = pushTypesPref.getCurrentEditGeneration();
  const typesDirtyAtStart = pushTypesPref.hasUnsyncedEdits();
  const serversStartGen = pushServersPref.getCurrentEditGeneration();
  const serversDirtyAtStart = pushServersPref.hasUnsyncedEdits();
  try {
    const res = await apiFetch<{
      ok: boolean;
      types?: unknown;
      enabledServerIds?: unknown;
    }>('/api/push/preferences');
    if (res?.ok && Array.isArray(res.types)) {
      const types = pushTypesPref.applyRemoteIfClean(res.types, typesStartGen, typesDirtyAtStart) ?? null;
      const enabledServerIds = res.enabledServerIds === undefined
        ? undefined
        : pushServersPref.applyRemoteIfClean(res.enabledServerIds, serversStartGen, serversDirtyAtStart);
      return { types, enabledServerIds };
    }
  } catch (err) {
    console.warn('Failed to fetch remote push notification preferences:', err);
  }
  return null;
}

export async function fetchPushNotificationPreferences(): Promise<PushNotificationType[] | null> {
  const snapshot = await fetchPushNotificationSettings();
  return snapshot?.types ?? null;
}

export async function syncPushNotificationPreferences(types: PushNotificationType[]): Promise<boolean> {
  return pushTypesPref.sync(types);
}

export async function syncPushEnabledServers(serverIds: string[] | null): Promise<boolean> {
  return pushServersPref.sync(serverIds === null ? null : sanitizePushEnabledServerIds(serverIds));
}

export function subscribePushEnabledServers(listener: (serverIds: string[] | null) => void): () => void {
  return pushServersPref.subscribe(listener);
}

/**
 * Optimistically apply `next` enabled server IDs, persist via POST /api/push/preferences,
 * and roll back to the last confirmed snapshot (or clean pre-dirty baseline) if the
 * request fails (provided no newer edit superseded it).
 */
export async function commitPushEnabledServers(
  next: string[] | null,
  previous: string[] | null = null,
): Promise<boolean> {
  const normalizedNext = next === null ? null : sanitizePushEnabledServerIds(next);
  const normalizedPrev = previous === null ? null : sanitizePushEnabledServerIds(previous);
  return pushServersPref.commit(normalizedNext, normalizedPrev);
}

async function registerDeviceToken(
  token: string,
  platform: PushPlatform,
  apiKey: string,
  cfWorkerUrl: string,
): Promise<void> {
  try {
    const notificationTypes = getLocalPushNotificationPreferences();
    await fetch(`${cfWorkerUrl}/api/push/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, platform, notificationTypes }),
    });
  } catch (err) {
    console.warn('Failed to register push token:', err);
  }
}

export function isPushSupported(): boolean {
  return pushSupported;
}
