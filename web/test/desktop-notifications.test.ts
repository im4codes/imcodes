/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
  PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
} from '@shared/push-notifications.js';
import {
  canReceiveDesktopNotifications,
  requestDesktopNotificationPermission,
  resetDesktopNotificationsForTests,
  setLocalDesktopNotificationsEnabled,
  shouldShowDesktopNotification,
  showDesktopNotification,
} from '../src/desktop-notifications.js';
import {
  resetPushNotificationPreferencesStateForTesting,
  setLocalPushEnabledServers,
  setLocalPushNotificationPreferences,
} from '../src/push-notifications.js';
import { ACTIVE_TIMELINE_REFRESH_EVENT } from '../src/hooks/useTimeline.js';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static instances: FakeNotification[] = [];

  title: string;
  options: NotificationOptions | undefined;
  onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
}

describe('desktop-notifications', () => {
  const OriginalNotification = globalThis.Notification;
  const OriginalUserAgent = navigator.userAgent;

  beforeEach(() => {
    localStorage.clear();
    resetPushNotificationPreferencesStateForTesting();
    resetDesktopNotificationsForTests();
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
    FakeNotification.instances = [];
    vi.stubGlobal('Notification', FakeNotification);
    delete (globalThis as Record<string, unknown>).Capacitor;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (OriginalNotification) {
      globalThis.Notification = OriginalNotification;
    }
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: OriginalUserAgent });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('requests permission cleanly and tracks local desktop notification toggle', async () => {
    FakeNotification.permission = 'default';
    expect(canReceiveDesktopNotifications()).toBe(false);

    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    expect(await requestDesktopNotificationPermission()).toBe('granted');
    expect(canReceiveDesktopNotifications()).toBe(true);

    setLocalDesktopNotificationsEnabled(false);
    expect(canReceiveDesktopNotifications()).toBe(false);
  });

  it('filters by synced pushPreferences & pushEnabledServers, bypasses mute for remote_desktop, and deduplicates by eventId', () => {
    setLocalPushNotificationPreferences([
      PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
      PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
    ]);
    setLocalPushEnabledServers(['srv-1']);

    // Disabled notification type (task_pair_audit) is suppressed
    expect(
      showDesktopNotification({
        eventId: 'evt-audit',
        title: 'Audit',
        body: 'In audit',
        notificationType: PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
        serverId: 'srv-1',
        ts: 1,
      }),
    ).toBeNull();

    // Disabled server (srv-2) is suppressed for normal types
    expect(
      showDesktopNotification({
        eventId: 'evt-muted-srv',
        title: 'Muted Server',
        body: 'Done',
        notificationType: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
        serverId: 'srv-2',
        ts: 2,
      }),
    ).toBeNull();

    // remote_desktop bypasses per-server mute allowlist
    const rd = showDesktopNotification({
      eventId: 'evt-rd',
      title: 'Remote Unlock',
      body: 'Unlocked',
      notificationType: PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
      serverId: 'srv-2',
      ts: 3,
    });
    expect(rd).toBeTruthy();

    // Allowed server & type fires once and deduplicates repeat eventId
    const n1 = showDesktopNotification({
      eventId: 'evt-ok-1',
      title: 'Srv1 · proj',
      body: 'Ready',
      notificationType: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      serverId: 'srv-1',
      session: 'deck_proj_brain',
      ts: 4,
    });
    const n1Dup = showDesktopNotification({
      eventId: 'evt-ok-1',
      title: 'Srv1 · proj',
      body: 'Ready',
      notificationType: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
      serverId: 'srv-1',
      session: 'deck_proj_brain',
      ts: 4,
    });
    expect(n1).toBeTruthy();
    expect(n1Dup).toBeNull();
    expect(FakeNotification.instances).toHaveLength(2);
    expect(FakeNotification.instances[1]!.options).toEqual({ body: 'Ready', tag: 'evt-ok-1' });
  });

  it('suppresses non-Electron same-session foreground browser popups, but always notifies on pc-app (Electron) and navigates on click', () => {
    setLocalPushEnabledServers(['srv-1', 'srv-2']);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    // Same active session & server in focused browser -> suppressed
    expect(
      shouldShowDesktopNotification(
        {
          eventId: 'evt-fg',
          title: 'Active',
          body: 'Done',
          notificationType: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          serverId: 'srv-1',
          session: 'deck_proj_brain',
          ts: 1,
        },
        { activeServerId: 'srv-1', activeSession: 'deck_proj_brain', accessibleServerIds: ['srv-1', 'srv-2'] },
      ),
    ).toBe(false);

    // Different server in focused browser -> shown
    expect(
      shouldShowDesktopNotification(
        {
          eventId: 'evt-other-srv',
          title: 'Srv2',
          body: 'Done',
          notificationType: PUSH_NOTIFICATION_TYPE_TASK_COMPLETE,
          serverId: 'srv-2',
          session: 'deck_other_brain',
          ts: 2,
        },
        { activeServerId: 'srv-1', activeSession: 'deck_proj_brain', accessibleServerIds: ['srv-1', 'srv-2'] },
      ),
    ).toBe(true);

    // Electron pc-app notifies even when window is focused, and click focuses + dispatches deck:navigate + refresh
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 Electron/45.3.3 Chrome/134.0',
    });
    const navEvents: unknown[] = [];
    const refreshEvents: number[] = [];
    window.addEventListener('deck:navigate', (e) => navEvents.push((e as CustomEvent).detail));
    window.addEventListener(ACTIVE_TIMELINE_REFRESH_EVENT, () => refreshEvents.push(1));

    const notif = showDesktopNotification(
      {
        eventId: 'evt-electron-click',
        title: 'Srv2 · task',
        body: 'Completed',
        notificationType: PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
        serverId: 'srv-2',
        session: 'deck_other_brain',
        ts: 3,
      },
      { activeServerId: 'srv-1', activeSession: 'deck_proj_brain', accessibleServerIds: ['srv-1', 'srv-2'] },
    );
    expect(notif).toBeTruthy();
    notif!.onclick?.call(notif as unknown as Notification, new Event('click'));

    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(navEvents).toEqual([{ serverId: 'srv-2', session: 'deck_other_brain' }]);
    expect(refreshEvents.length).toBeGreaterThanOrEqual(1);
    expect(notif!.close).toHaveBeenCalledTimes(1);
  });
});
