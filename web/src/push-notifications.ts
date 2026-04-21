/**
 * Push notification registration for Capacitor apps.
 * Registers for APNs (iOS) / FCM (Android) and sends token to CF Worker.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNative = (): boolean => typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' && (globalThis as any).Capacitor.isNativePlatform();

let pushSupported = false;
let resetBadgePromise: Promise<void> | null = null;
let lastBadgeResetAt = 0;

// Expose badge-reset to native layer (AppDelegate calls via evaluateJavaScript on app foreground).
// Uses apiFetch which prepends baseUrl and includes Bearer token — relative URLs fail in Capacitor.
import { apiFetch } from './api.js';
import { ACTIVE_TIMELINE_REFRESH_EVENT } from './hooks/useTimeline.js';
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
    await registerDeviceToken(token.value, apiKey, cfWorkerUrl);
  });

  PushNotifications.addListener('pushNotificationReceived', (notification: unknown) => {
    console.log('Push received:', notification);
  });

  PushNotifications.addListener('pushNotificationActionPerformed', (action: { notification: { data: unknown } }) => {
    console.log('Push action:', action);
    const data = action.notification.data as Record<string, string> | undefined;
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
  });
}

async function registerDeviceToken(token: string, apiKey: string, cfWorkerUrl: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const platform = (globalThis as any).Capacitor?.getPlatform?.() ?? 'unknown'; // 'ios' | 'android'
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
