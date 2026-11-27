/**
 * Push notification registration for Capacitor apps.
 *
 * iOS uses APNs and Android withFcm uses FCM, both through the Capacitor push
 * plugin. Android withoutFcm is a deliberately pure build and returns before
 * importing or registering any native push plugin.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNative = (): boolean => typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' && (globalThis as any).Capacitor.isNativePlatform();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getPlatform = (): string => (globalThis as any).Capacitor?.getPlatform?.() ?? 'unknown';

import {
  PUSH_PLATFORM_IOS,
  PUSH_PLATFORM_ANDROID_FCM,
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  DEFAULT_PUSH_ENABLED_SERVER_IDS,
  isPushNotificationType,
  sanitizePushEnabledServerIds,
  type PushPlatform,
  type PushNotificationType,
} from '@shared/push-notifications.js';

export type AndroidBackgroundPushConnectionState =
  | 'disabled'
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'waiting_network'
  | 'auth_error';

export interface AndroidBackgroundPushStatus {
  supported: boolean;
  hasFcm: boolean;
  enabled: boolean;
  running: boolean;
  connectionState: AndroidBackgroundPushConnectionState;
  notificationsGranted: boolean;
  batteryOptimizationIgnored: boolean;
}

interface BackgroundPushPluginContract {
  getStatus(): Promise<AndroidBackgroundPushStatus>;
  requestNotificationPermission(): Promise<{ supported: boolean; granted: boolean }>;
  requestIgnoreBatteryOptimizations(): Promise<{ supported: boolean; granted: boolean }>;
  start(options: {
    serverUrl: string;
    apiKey: string;
    statusTitle?: string;
    statusText?: string;
  }): Promise<{ supported: boolean; started: boolean }>;
  stop(): Promise<{ supported: boolean; stopped: boolean }>;
  consumePendingNotification(): Promise<{ notification: { serverId?: string; session?: string } | null }>;
  addListener(
    eventName: 'backgroundPushActionPerformed' | 'backgroundPushStateChanged',
    listener: (payload: Record<string, unknown>) => void,
  ): Promise<{ remove?: () => Promise<void> }>;
}

export const ANDROID_BG_PUSH_ENABLED_KEY = 'imcodes.android_background_push_enabled';

let pushSupported = false;
let resetBadgePromise: Promise<void> | null = null;
let lastBadgeResetAt = 0;
let activeAndroidBgAuth: { apiKey: string; serverUrl: string } | null = null;
let androidBgAuthGeneration = 0;
let androidBgLifecycleQueue: Promise<void> = Promise.resolve();
let androidBgListenersMounted = false;
let lastAndroidBgStatus: AndroidBackgroundPushStatus | null = null;
const androidBgStatusListeners = new Set<(status: AndroidBackgroundPushStatus | null) => void>();

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
  if (platform === 'android' && !isFcmBuild()) {
    await initAndroidBackgroundPush(apiKey, cfWorkerUrl);
    return;
  }
  await initApnsOrFcm(apiKey, cfWorkerUrl);
}

function isFcmBuild(): boolean {
  // Inline Vite/Vitest harnesses do not define the production macro. Preserve
  // the historical default (FCM enabled) while making the pure build explicit.
  return typeof __PUSH_FCM__ === 'undefined' || __PUSH_FCM__;
}

export function isAndroidBackgroundPushSupportedBuild(): boolean {
  return isNative() && getPlatform() === 'android' && !isFcmBuild();
}

export function getLocalAndroidBackgroundPushEnabled(): boolean {
  try {
    return localStorage.getItem(ANDROID_BG_PUSH_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

export function setLocalAndroidBackgroundPushEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ANDROID_BG_PUSH_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // ignore unavailable storage
  }
}

function emitAndroidBgStatus(status: AndroidBackgroundPushStatus | null): void {
  lastAndroidBgStatus = status;
  for (const listener of androidBgStatusListeners) {
    listener(status);
  }
}

async function getBackgroundPushPlugin(): Promise<BackgroundPushPluginContract | null> {
  if (!isAndroidBackgroundPushSupportedBuild()) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cap = (globalThis as any).Capacitor;
  if (cap?.Plugins?.BackgroundPush) {
    return cap.Plugins.BackgroundPush as BackgroundPushPluginContract;
  }
  if (typeof cap?.isPluginAvailable === 'function' && cap.isPluginAvailable('BackgroundPush')) {
    const { registerPlugin } = await import('@capacitor/core');
    return registerPlugin<BackgroundPushPluginContract>('BackgroundPush');
  }
  return null;
}

async function mountAndroidBackgroundListeners(plugin: BackgroundPushPluginContract): Promise<void> {
  if (androidBgListenersMounted) return;
  androidBgListenersMounted = true;
  await plugin.addListener('backgroundPushActionPerformed', (payload) => {
    const data: Record<string, string> = {};
    if (typeof payload?.serverId === 'string') data.serverId = payload.serverId;
    if (typeof payload?.session === 'string') data.session = payload.session;
    handleNotificationOpen(data);
  });
  await plugin.addListener('backgroundPushStateChanged', (payload) => {
    if (payload && typeof payload.supported === 'boolean') {
      emitAndroidBgStatus(payload as unknown as AndroidBackgroundPushStatus);
    }
  });
}

function isDebugOrTestRuntime(): boolean {
  try {
    const metaEnv = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
    if (metaEnv?.DEV === true || metaEnv?.MODE === 'test') return true;
  } catch {
    // ignore
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]';
}

export function normalizeAndroidBgServerUrl(rawUrl: string | null | undefined): string | null {
  const trimmed = String(rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') {
      return parsed.toString().replace(/\/+$/, '');
    }
    if (parsed.protocol === 'http:' && isDebugOrTestRuntime() && isLoopbackHost(parsed.hostname)) {
      return parsed.toString().replace(/\/+$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

function enqueueAndroidBgLifecycle<T>(task: () => Promise<T>): Promise<T> {
  const next = androidBgLifecycleQueue.then(task, task);
  androidBgLifecycleQueue = next.then(() => undefined, () => undefined);
  return next;
}

function isAndroidBgAuthCurrent(
  generation: number,
  expectedAuth: { apiKey: string; serverUrl: string } | null,
): boolean {
  if (generation !== androidBgAuthGeneration) return false;
  if (!expectedAuth) return activeAndroidBgAuth === null;
  return (
    activeAndroidBgAuth !== null
    && activeAndroidBgAuth.apiKey === expectedAuth.apiKey
    && activeAndroidBgAuth.serverUrl === expectedAuth.serverUrl
  );
}

async function initAndroidBackgroundPush(apiKey: string, cfWorkerUrl: string): Promise<void> {
  const trimmedKey = apiKey.trim();
  const normalizedUrl = normalizeAndroidBgServerUrl(cfWorkerUrl);
  if (!trimmedKey || !normalizedUrl) {
    await stopAndroidBackgroundPushOnLogout();
    return;
  }

  const myGen = ++androidBgAuthGeneration;
  const boundAuth = { apiKey: trimmedKey, serverUrl: normalizedUrl };
  activeAndroidBgAuth = boundAuth;

  const plugin = await getBackgroundPushPlugin();
  if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
  if (!plugin) {
    pushSupported = false;
    return;
  }

  await mountAndroidBackgroundListeners(plugin);
  if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;

  try {
    const pending = await plugin.consumePendingNotification();
    if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
    if (pending?.notification && (pending.notification.serverId || pending.notification.session)) {
      const navData: Record<string, string> = {};
      if (pending.notification.serverId) navData.serverId = pending.notification.serverId;
      if (pending.notification.session) navData.session = pending.notification.session;
      handleNotificationOpen(navData);
    }
  } catch {
    // ignore failed pending read
  }

  let status = await plugin.getStatus();
  if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
  if (!status?.supported) {
    pushSupported = false;
    emitAndroidBgStatus(status ?? null);
    return;
  }

  const userEnabled = getLocalAndroidBackgroundPushEnabled();
  if (!userEnabled) {
    await enqueueAndroidBgLifecycle(async () => {
      if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
      if (status.running || status.enabled) {
        await plugin.stop();
        if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
        status = await plugin.getStatus();
      }
      if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
      pushSupported = status.notificationsGranted;
      emitAndroidBgStatus(status);
    });
    return;
  }

  let granted = status.notificationsGranted;
  if (!granted) {
    const req = await plugin.requestNotificationPermission();
    if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
    granted = Boolean(req?.granted);
  }
  if (!granted) {
    const nextStatus = await plugin.getStatus();
    if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
    pushSupported = false;
    emitAndroidBgStatus(nextStatus);
    return;
  }

  await enqueueAndroidBgLifecycle(async () => {
    if (!isAndroidBgAuthCurrent(myGen, boundAuth) || !getLocalAndroidBackgroundPushEnabled()) return;
    const startRes = await plugin.start({ serverUrl: boundAuth.serverUrl, apiKey: boundAuth.apiKey });
    if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
    pushSupported = Boolean(startRes?.started);
    emitAndroidBgStatus(await plugin.getStatus());
  });
}

export async function getAndroidBackgroundPushStatus(): Promise<AndroidBackgroundPushStatus | null> {
  const plugin = await getBackgroundPushPlugin();
  if (!plugin) return null;
  const status = await plugin.getStatus();
  emitAndroidBgStatus(status);
  return status;
}

export function subscribeAndroidBackgroundPushStatus(
  listener: (status: AndroidBackgroundPushStatus | null) => void,
): () => void {
  androidBgStatusListeners.add(listener);
  if (lastAndroidBgStatus) {
    listener(lastAndroidBgStatus);
  }
  return () => {
    androidBgStatusListeners.delete(listener);
  };
}

export async function enableAndroidBackgroundPush(credentials?: {
  apiKey?: string | null;
  serverUrl?: string | null;
}): Promise<AndroidBackgroundPushStatus | null> {
  let boundAuth: { apiKey: string; serverUrl: string } | null = null;
  let myGen = androidBgAuthGeneration;

  if (credentials !== undefined) {
    const rawKey = credentials.apiKey?.trim() ?? '';
    const normalizedUrl = normalizeAndroidBgServerUrl(credentials.serverUrl);
    if (rawKey && normalizedUrl) {
      myGen = ++androidBgAuthGeneration;
      boundAuth = { apiKey: rawKey, serverUrl: normalizedUrl };
      activeAndroidBgAuth = boundAuth;
    } else if (credentials.apiKey !== undefined || credentials.serverUrl !== undefined) {
      // Explicit partial/invalid credential context must never combine with a different active auth pair.
      return getAndroidBackgroundPushStatus();
    } else {
      boundAuth = activeAndroidBgAuth ? { ...activeAndroidBgAuth } : null;
    }
  } else {
    boundAuth = activeAndroidBgAuth ? { ...activeAndroidBgAuth } : null;
  }

  const plugin = await getBackgroundPushPlugin();
  if (!plugin) return null;
  if (myGen !== androidBgAuthGeneration) return null;

  setLocalAndroidBackgroundPushEnabled(true);
  let status = await plugin.getStatus();
  if (myGen !== androidBgAuthGeneration) return null;
  if (!status.notificationsGranted) {
    const req = await plugin.requestNotificationPermission();
    if (myGen !== androidBgAuthGeneration) return null;
    if (!req?.granted) {
      status = await plugin.getStatus();
      if (myGen !== androidBgAuthGeneration) return null;
      pushSupported = false;
      emitAndroidBgStatus(status);
      return status;
    }
  }

  if (boundAuth && isAndroidBgAuthCurrent(myGen, boundAuth)) {
    await enqueueAndroidBgLifecycle(async () => {
      if (!isAndroidBgAuthCurrent(myGen, boundAuth) || !getLocalAndroidBackgroundPushEnabled()) return;
      const startRes = await plugin.start({ serverUrl: boundAuth.serverUrl, apiKey: boundAuth.apiKey });
      if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
      pushSupported = Boolean(startRes?.started);
    });
  }
  if (myGen !== androidBgAuthGeneration) return null;
  status = await plugin.getStatus();
  if (myGen !== androidBgAuthGeneration) return null;
  emitAndroidBgStatus(status);
  return status;
}

export async function disableAndroidBackgroundPush(): Promise<AndroidBackgroundPushStatus | null> {
  const plugin = await getBackgroundPushPlugin();
  setLocalAndroidBackgroundPushEnabled(false);
  pushSupported = false;
  if (!plugin) return null;
  return enqueueAndroidBgLifecycle(async () => {
    await plugin.stop();
    const status = await plugin.getStatus();
    emitAndroidBgStatus(status);
    return status;
  });
}

export async function requestAndroidNotificationPermission(): Promise<AndroidBackgroundPushStatus | null> {
  const plugin = await getBackgroundPushPlugin();
  if (!plugin) return null;
  const myGen = androidBgAuthGeneration;
  const boundAuth = activeAndroidBgAuth ? { ...activeAndroidBgAuth } : null;
  const res = await plugin.requestNotificationPermission();
  if (myGen !== androidBgAuthGeneration) return null;
  if (res?.granted && getLocalAndroidBackgroundPushEnabled() && boundAuth && isAndroidBgAuthCurrent(myGen, boundAuth)) {
    await enqueueAndroidBgLifecycle(async () => {
      if (!isAndroidBgAuthCurrent(myGen, boundAuth) || !getLocalAndroidBackgroundPushEnabled()) return;
      const startRes = await plugin.start({
        serverUrl: boundAuth.serverUrl,
        apiKey: boundAuth.apiKey,
      });
      if (!isAndroidBgAuthCurrent(myGen, boundAuth)) return;
      pushSupported = Boolean(startRes?.started);
    });
  }
  if (myGen !== androidBgAuthGeneration) return null;
  const status = await plugin.getStatus();
  if (myGen !== androidBgAuthGeneration) return null;
  emitAndroidBgStatus(status);
  return status;
}

export async function requestAndroidBatteryOptimizationExemption(): Promise<AndroidBackgroundPushStatus | null> {
  const plugin = await getBackgroundPushPlugin();
  if (!plugin) return null;
  await plugin.requestIgnoreBatteryOptimizations();
  const status = await plugin.getStatus();
  emitAndroidBgStatus(status);
  return status;
}

export async function stopAndroidBackgroundPushOnLogout(): Promise<void> {
  androidBgAuthGeneration += 1;
  activeAndroidBgAuth = null;
  pushSupported = false;
  await enqueueAndroidBgLifecycle(async () => {
    const plugin = await getBackgroundPushPlugin();
    if (!plugin) return;
    await plugin.stop();
    emitAndroidBgStatus(await plugin.getStatus().catch(() => null));
  });
}

export function resetAndroidBackgroundPushStateForTesting(): void {
  pushSupported = false;
  activeAndroidBgAuth = null;
  androidBgAuthGeneration = 0;
  androidBgLifecycleQueue = Promise.resolve();
  androidBgListenersMounted = false;
  lastAndroidBgStatus = null;
  androidBgStatusListeners.clear();
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
    const includeNotificationTypes = hasUnsyncedPushNotificationEdits();
    const body: {
      token: string;
      platform: PushPlatform;
      notificationTypes?: PushNotificationType[];
    } = { token, platform };
    if (includeNotificationTypes) {
      body.notificationTypes = getLocalPushNotificationPreferences();
    }
    const res = await fetch(`${cfWorkerUrl}/api/push/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!includeNotificationTypes && res?.ok) {
      void fetchPushNotificationSettings();
    }
  } catch (err) {
    console.warn('Failed to register push token:', err);
  }
}

export function isPushSupported(): boolean {
  return pushSupported;
}
