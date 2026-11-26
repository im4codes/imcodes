import type { GlobalTaskNotificationEvent } from '@shared/global-task-mode.js';
import {
  isPushEnabledForServer,
  shouldBypassServerPushMute,
} from '@shared/push-notifications.js';
import { ACTIVE_TIMELINE_REFRESH_EVENT } from './hooks/useTimeline.js';
import { isNative } from './native.js';
import {
  getLocalPushEnabledServers,
  getLocalPushNotificationPreferences,
} from './push-notifications.js';

export const DESKTOP_NOTIFICATIONS_ENABLED_KEY = 'imcodes.desktop_notifications_enabled';
export const DESKTOP_NOTIFICATION_PREFS_CHANGED_EVENT = 'imcodes:desktop-notification-prefs-changed';

const SEEN_NOTIFICATION_TTL_MS = 2 * 60 * 1000;
const MAX_SEEN_NOTIFICATION_IDS = 500;

export type DesktopNotificationPermission = NotificationPermission | 'unsupported';

export interface DesktopNotificationContext {
  activeServerId?: string | null;
  activeSession?: string | null;
  accessibleServerIds?: readonly string[];
}

const seenNotificationIds = new Map<string, number>();
const enabledListeners = new Set<(enabled: boolean) => void>();

export function isElectronPcApp(): boolean {
  return typeof navigator !== 'undefined' && /\bElectron\//i.test(navigator.userAgent ?? '');
}

export function isDesktopNotificationSupported(): boolean {
  return !isNative() && typeof Notification !== 'undefined';
}

export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (!isDesktopNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export function getLocalDesktopNotificationsEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY) !== '0';
  } catch {
    return true;
  }
}

function emitDesktopPrefsChanged(): void {
  const enabled = getLocalDesktopNotificationsEnabled();
  for (const listener of [...enabledListeners]) {
    try {
      listener(enabled);
    } catch {
      // isolate subscriber errors
    }
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(DESKTOP_NOTIFICATION_PREFS_CHANGED_EVENT));
    }
  } catch {
    // ignore
  }
}

export function setLocalDesktopNotificationsEnabled(enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(DESKTOP_NOTIFICATIONS_ENABLED_KEY, enabled ? '1' : '0');
    }
  } catch {
    // ignore
  }
  emitDesktopPrefsChanged();
}

export function subscribeDesktopNotificationsEnabled(listener: (enabled: boolean) => void): () => void {
  enabledListeners.add(listener);
  return () => {
    enabledListeners.delete(listener);
  };
}

export function canReceiveDesktopNotifications(): boolean {
  return (
    isDesktopNotificationSupported()
    && Notification.permission === 'granted'
    && getLocalDesktopNotificationsEnabled()
  );
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!isDesktopNotificationSupported()) return 'unsupported';
  if (typeof Notification.requestPermission !== 'function') {
    return Notification.permission;
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    setLocalDesktopNotificationsEnabled(true);
  } else {
    emitDesktopPrefsChanged();
  }
  return permission;
}

function pruneSeenNotifications(now: number): void {
  for (const [id, at] of seenNotificationIds) {
    if (now - at > SEEN_NOTIFICATION_TTL_MS) {
      seenNotificationIds.delete(id);
    }
  }
  while (seenNotificationIds.size > MAX_SEEN_NOTIFICATION_IDS) {
    const oldest = seenNotificationIds.keys().next().value;
    if (oldest === undefined) break;
    seenNotificationIds.delete(oldest);
  }
}

export function handleDesktopNotificationClick(event: Pick<GlobalTaskNotificationEvent, 'serverId' | 'session'>): void {
  try {
    window.focus?.();
  } catch {
    // ignore focus errors
  }
  if (event.serverId || event.session) {
    try {
      window.dispatchEvent(new CustomEvent('deck:navigate', {
        detail: {
          ...(event.serverId ? { serverId: event.serverId } : {}),
          ...(event.session ? { session: event.session } : {}),
        },
      }));
    } catch {
      // ignore
    }
  }
  const fireRefresh = (): void => {
    try { window.dispatchEvent(new CustomEvent(ACTIVE_TIMELINE_REFRESH_EVENT)); } catch { /* ignore */ }
  };
  fireRefresh();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(fireRefresh));
  }
}

export function shouldShowDesktopNotification(
  event: GlobalTaskNotificationEvent,
  context: DesktopNotificationContext = {},
): boolean {
  if (!canReceiveDesktopNotifications()) return false;
  if (!event.eventId || !event.title) return false;

  if (event.notificationType) {
    const allowedTypes = getLocalPushNotificationPreferences();
    if (!allowedTypes.includes(event.notificationType)) return false;
  }

  if (event.serverId && !shouldBypassServerPushMute(event.notificationType)) {
    const enabledServers = getLocalPushEnabledServers();
    const accessible = context.accessibleServerIds ?? (context.activeServerId ? [context.activeServerId] : []);
    if (!isPushEnabledForServer(enabledServers, event.serverId, accessible)) {
      return false;
    }
  }

  if (shouldBypassServerPushMute(event.notificationType) || isElectronPcApp()) {
    return true;
  }

  const isVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const hasFocus = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : false;
  const sameServer = !event.serverId || event.serverId === context.activeServerId;
  const sameSession = Boolean(event.session && context.activeSession && event.session === context.activeSession);
  if (isVisible && hasFocus && sameServer && sameSession) {
    return false;
  }
  return true;
}

export function showDesktopNotification(
  event: GlobalTaskNotificationEvent,
  context: DesktopNotificationContext = {},
): Notification | null {
  if (!shouldShowDesktopNotification(event, context)) return null;

  const now = Date.now();
  pruneSeenNotifications(now);
  if (seenNotificationIds.has(event.eventId)) return null;
  seenNotificationIds.set(event.eventId, now);

  try {
    const notification = new Notification(event.title, {
      body: event.body,
      tag: event.eventId,
    });
    notification.onclick = () => {
      handleDesktopNotificationClick(event);
      try { notification.close?.(); } catch { /* ignore */ }
    };
    return notification;
  } catch {
    return null;
  }
}

export function resetDesktopNotificationsForTests(): void {
  seenNotificationIds.clear();
  enabledListeners.clear();
}
