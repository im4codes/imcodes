/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { resetPushNotificationPreferencesStateForTesting } from '../src/push-notifications.js';
import {
  DEFAULT_PUSH_NOTIFICATION_TYPES,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT,
  PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE,
  PUSH_NOTIFICATION_TYPE_REMOTE_DESKTOP,
} from '@shared/push-notifications.js';

const apiFetchMock = vi.fn();

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  passwordChange: vi.fn(),
  passkeyVerifyBegin: vi.fn(),
  passwordSetupWithPasskey: vi.fn(),
  updateDisplayName: vi.fn(),
  listPasskeys: vi.fn().mockResolvedValue({ credentials: [] }),
  deletePasskey: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'settings.title': 'Settings',
        'settings.back': '← Back',
        'settings.tab_profile': 'Profile',
        'settings.tab_notifications': 'Notifications',
        'settings.tab_security': 'Security',
        'settings.tab_guide': 'User Guide',
        'settings.account_identity': 'Account Identity',
        'settings.username': 'Username',
        'settings.display_name': 'Display Name',
        'settings.edit': 'Edit',
        'settings.set_password_login': 'Set Password Login',
        'settings.push_notifications_label': 'Push Notifications',
        'settings.push_notifications_title': 'Push Notification Preferences',
        'settings.push_notifications_desc': 'Customize push notification types.',
        'settings.push_group_basic': 'Basic Notifications',
        'settings.push_task_complete_title': 'Task Complete / Session Idle',
        'settings.push_task_complete_desc': 'Send push when session is idle',
        'settings.push_waiting_input_title': 'Waiting for User Input / Question',
        'settings.push_waiting_input_desc': 'Send push when asking a question',
        'settings.push_session_error_title': 'Session Errors & Exceptions',
        'settings.push_session_error_desc': 'Send push on error',
        'settings.push_group_task_pair': 'Task Lifecycle',
        'settings.push_task_pair_done_title': 'Task Done (DONE)',
        'settings.push_task_pair_done_desc': 'Notify when task is done',
        'settings.push_task_pair_paused_title': 'Task Paused / Awaiting Decision (PAUSED)',
        'settings.push_task_pair_paused_desc': 'Notify when task is paused',
        'settings.push_task_pair_audit_title': 'Audit & Intermediate Steps (Audit & Rework)',
        'settings.push_task_pair_audit_desc': 'Intermediate steps',
        'settings.push_group_security': 'Security Alerts',
        'settings.push_security_highest_badge': 'Highest Security Alert',
        'settings.push_remote_desktop_title': 'Remote Desktop Auto-Unlock Alert',
        'settings.push_remote_desktop_desc': 'Highest severity alert',
        'settings.push_servers_label': 'Allowed Servers',
        'settings.push_servers_title': 'Push Notification Servers',
        'settings.push_servers_desc': 'All servers are disabled by default.',
        'settings.push_servers_select_all': 'Select All',
        'settings.push_servers_clear': 'Clear',
        'settings.push_servers_empty': 'No servers found for this account.',
        'settings.push_server_role_daemon': 'Daemon',
        'settings.push_server_role_controlled': 'Controlled Node',
        'settings.push_server_online': 'Online',
        'settings.push_server_offline': 'Offline',
      };
      return dict[key] ?? key;
    },
  }),
}));

describe('SettingsPage push notification settings', () => {
  beforeEach(() => {
    localStorage.clear();
    resetPushNotificationPreferencesStateForTesting();
    apiFetchMock.mockReset().mockResolvedValue({
      ok: true,
      types: DEFAULT_PUSH_NOTIFICATION_TYPES,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders push notification preferences card with all groups and default checkbox states', async () => {
    render(
      <SettingsPage
        displayName="Ada Lovelace"
        username="ada"
        hasPassword={true}
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('push-notification-settings-card')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }));

    expect(screen.getByTestId('push-notification-settings-card')).toBeDefined();
    expect(screen.getByText('Push Notification Preferences')).toBeDefined();

    // Group headings
    expect(screen.getByText('Basic Notifications')).toBeDefined();
    expect(screen.getByText('Task Lifecycle')).toBeDefined();
    expect(screen.getByText('Security Alerts')).toBeDefined();
    expect(screen.getByText('Highest Security Alert')).toBeDefined();

    // Checkboxes
    const taskCompleteCb = screen.getByLabelText('Task Complete / Session Idle') as HTMLInputElement;
    const waitingInputCb = screen.getByLabelText('Waiting for User Input / Question') as HTMLInputElement;
    const sessionErrorCb = screen.getByLabelText('Session Errors & Exceptions') as HTMLInputElement;
    const taskPairDoneCb = screen.getByLabelText('Task Done (DONE)') as HTMLInputElement;
    const taskPairPausedCb = screen.getByLabelText('Task Paused / Awaiting Decision (PAUSED)') as HTMLInputElement;
    const taskPairAuditCb = screen.getByLabelText('Audit & Intermediate Steps (Audit & Rework)') as HTMLInputElement;
    const remoteDesktopCb = screen.getByLabelText('Remote Desktop Auto-Unlock Alert') as HTMLInputElement;

    // Default states: 6 checked, 1 (audit) unchecked
    expect(taskCompleteCb.checked).toBe(true);
    expect(waitingInputCb.checked).toBe(true);
    expect(sessionErrorCb.checked).toBe(true);
    expect(taskPairDoneCb.checked).toBe(true);
    expect(taskPairPausedCb.checked).toBe(true);
    expect(taskPairAuditCb.checked).toBe(false); // default OFF per requirements
    expect(remoteDesktopCb.checked).toBe(true);
  });

  it('toggles a preference checkbox and syncs with server', async () => {
    render(
      <SettingsPage
        displayName="Ada Lovelace"
        username="ada"
        hasPassword={true}
        initialTab="notifications"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    // Wait for initial fetch to settle
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/push/preferences');
    });

    const taskPairAuditCb = screen.getByLabelText('Audit & Intermediate Steps (Audit & Rework)') as HTMLInputElement;
    expect(taskPairAuditCb.checked).toBe(false);

    // Turn ON task_pair_audit
    fireEvent.click(taskPairAuditCb);
    expect(taskPairAuditCb.checked).toBe(true);

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/push/preferences', {
        method: 'POST',
        body: expect.stringContaining(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT),
      });
    });

    // Turn OFF task_pair_done
    const taskPairDoneCb = screen.getByLabelText('Task Done (DONE)') as HTMLInputElement;
    expect(taskPairDoneCb.checked).toBe(true);
    fireEvent.click(taskPairDoneCb);
    expect(taskPairDoneCb.checked).toBe(false);

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('/api/push/preferences');
      const body = JSON.parse(lastCall[1].body as string);
      expect(body.types).not.toContain(PUSH_NOTIFICATION_TYPE_TASK_PAIR_DONE);
      expect(body.types).toContain(PUSH_NOTIFICATION_TYPE_TASK_PAIR_AUDIT);
    });
  });

  it('renders server checklist unchecked by default, syncs server selection, and tolerates deleted server IDs', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/push/preferences') {
        return Promise.resolve({
          ok: true,
          types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          enabledServerIds: ['deleted-srv-99'],
        });
      }
      if (path === '/api/server') {
        return Promise.resolve({
          servers: [
            { id: 'srv-1', name: 'Office Mac', status: 'online' },
            { id: 'srv-2', name: 'Small Node', status: 'offline' },
          ],
        });
      }
      if (path === '/api/machines') {
        return Promise.resolve({
          machines: [
            { serverId: 'ctrl-1', displayName: 'Win Workstation', online: true },
          ],
        });
      }
      return Promise.resolve({ ok: true });
    });

    render(
      <SettingsPage
        displayName="Ada Lovelace"
        username="ada"
        hasPassword={true}
        initialTab="notifications"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    const officeCb = await screen.findByLabelText('Office Mac') as HTMLInputElement;
    const smallNodeCb = screen.getByLabelText('Small Node') as HTMLInputElement;
    const winCb = screen.getByLabelText('Win Workstation') as HTMLInputElement;

    // All visible servers start unchecked when enabledServerIds has no matching IDs
    expect(officeCb.checked).toBe(false);
    expect(smallNodeCb.checked).toBe(false);
    expect(winCb.checked).toBe(false);

    // Check Office Mac -> sends only enabledServerIds
    fireEvent.click(officeCb);
    expect(officeCb.checked).toBe(true);
    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        ([path, opts]) => path === '/api/push/preferences' && (opts as { method?: string } | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
      expect(JSON.parse((postCalls[0][1] as { body: string }).body)).toEqual({
        enabledServerIds: ['deleted-srv-99', 'srv-1'],
      });
    });

    // Select All checks all visible servers
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(officeCb.checked).toBe(true);
    expect(smallNodeCb.checked).toBe(true);
    expect(winCb.checked).toBe(true);

    // Clear unchecks all servers
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(officeCb.checked).toBe(false);
    expect(smallNodeCb.checked).toBe(false);
    expect(winCb.checked).toBe(false);
    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        ([path, opts]) => path === '/api/push/preferences' && (opts as { method?: string } | undefined)?.method === 'POST',
      );
      const lastBody = JSON.parse((postCalls[postCalls.length - 1][1] as { body: string }).body);
      expect(lastBody).toEqual({ enabledServerIds: [] });
    });
  });

  it('renders single server checked by default when enabledServerIds is null and persists [] on uncheck', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/push/preferences') {
        return Promise.resolve({
          ok: true,
          types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          enabledServerIds: null,
        });
      }
      if (path === '/api/server') {
        return Promise.resolve({
          servers: [{ id: 'srv-only', name: 'Sole Node', status: 'online' }],
        });
      }
      if (path === '/api/machines') {
        return Promise.resolve({ machines: [] });
      }
      return Promise.resolve({ ok: true });
    });

    render(
      <SettingsPage
        displayName="Ada Lovelace"
        username="ada"
        hasPassword={true}
        initialTab="notifications"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    const soleCb = await screen.findByLabelText('Sole Node') as HTMLInputElement;
    expect(soleCb.checked).toBe(true);

    // Manually unchecking the sole server sends explicit [] override
    fireEvent.click(soleCb);
    expect(soleCb.checked).toBe(false);
    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        ([path, opts]) => path === '/api/push/preferences' && (opts as { method?: string } | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
      expect(JSON.parse((postCalls[0][1] as { body: string }).body)).toEqual({ enabledServerIds: [] });
    });
  });

  it('renders multiple servers all unchecked by default when enabledServerIds is null', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/push/preferences') {
        return Promise.resolve({
          ok: true,
          types: DEFAULT_PUSH_NOTIFICATION_TYPES,
          enabledServerIds: null,
        });
      }
      if (path === '/api/server') {
        return Promise.resolve({
          servers: [
            { id: 'srv-1', name: 'Primary', status: 'online' },
            { id: 'srv-2', name: 'Secondary', status: 'online' },
          ],
        });
      }
      if (path === '/api/machines') {
        return Promise.resolve({ machines: [] });
      }
      return Promise.resolve({ ok: true });
    });

    render(
      <SettingsPage
        displayName="Ada Lovelace"
        username="ada"
        hasPassword={true}
        initialTab="notifications"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    const primaryCb = await screen.findByLabelText('Primary') as HTMLInputElement;
    const secondaryCb = screen.getByLabelText('Secondary') as HTMLInputElement;
    expect(primaryCb.checked).toBe(false);
    expect(secondaryCb.checked).toBe(false);

    fireEvent.click(primaryCb);
    expect(primaryCb.checked).toBe(true);
    await waitFor(() => {
      const postCalls = apiFetchMock.mock.calls.filter(
        ([path, opts]) => path === '/api/push/preferences' && (opts as { method?: string } | undefined)?.method === 'POST',
      );
      expect(postCalls.length).toBe(1);
      expect(JSON.parse((postCalls[0][1] as { body: string }).body)).toEqual({ enabledServerIds: ['srv-1'] });
    });
  });
});
