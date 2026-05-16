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
  type PushPlatform,
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

async function registerDeviceToken(
  token: string,
  platform: PushPlatform,
  apiKey: string,
  cfWorkerUrl: string,
): Promise<void> {
  try {
    await fetch(`${cfWorkerUrl}/api/push/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, platform }),
    });
  } catch (err) {
    console.warn('Failed to register push token:', err);
  }
}

export function isPushSupported(): boolean {
  return pushSupported;
}
