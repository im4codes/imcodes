/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const startAuthenticationMock = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthenticationMock(...args),
}));

const updateDisplayNameMock = vi.fn();
const passwordChangeMock = vi.fn();
const passkeyVerifyBeginMock = vi.fn();
const passwordSetupWithPasskeyMock = vi.fn();
const listPasskeysMock = vi.fn();
const deletePasskeyMock = vi.fn();
const passkeyRegisterBeginMock = vi.fn();
const passkeyRegisterCompleteMock = vi.fn();
const authSessionStartMock = vi.fn();
const getAuthKeyMock = vi.fn();
const nativeState = vi.hoisted(() => ({ value: false }));
const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      public body: string,
      public code: string | null = null,
    ) {
      super(`API ${status}: ${code ?? body}`);
    }
  }
  return { MockApiError };
});
vi.mock('../../src/api.js', () => ({
  ApiError: MockApiError,
  apiFetch: vi.fn().mockResolvedValue({ ok: false }),
  updateDisplayName: (...args: unknown[]) => updateDisplayNameMock(...args),
  passwordChange: (...args: unknown[]) => passwordChangeMock(...args),
  passkeyVerifyBegin: (...args: unknown[]) => passkeyVerifyBeginMock(...args),
  passwordSetupWithPasskey: (...args: unknown[]) => passwordSetupWithPasskeyMock(...args),
  listPasskeys: (...args: unknown[]) => listPasskeysMock(...args),
  deletePasskey: (...args: unknown[]) => deletePasskeyMock(...args),
  passkeyRegisterBegin: (...args: unknown[]) => passkeyRegisterBeginMock(...args),
  passkeyRegisterComplete: (...args: unknown[]) => passkeyRegisterCompleteMock(...args),
}));

vi.mock('../../src/native.js', () => ({
  isNative: () => nativeState.value,
}));
vi.mock('../../src/plugins/auth-session.js', () => ({
  default: { start: (...args: unknown[]) => authSessionStartMock(...args) },
}));
vi.mock('../../src/biometric-auth.js', () => ({
  getAuthKey: (...args: unknown[]) => getAuthKeyMock(...args),
}));

import { SettingsPage } from '../../src/pages/SettingsPage.js';

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeState.value = false;
    listPasskeysMock.mockResolvedValue({ credentials: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders password setup flow for passkey-only accounts and completes it after passkey verification', async () => {
    passkeyVerifyBeginMock.mockResolvedValue({ challengeId: 'cid-1', foo: 'bar' });
    startAuthenticationMock.mockResolvedValue({ id: 'cred-1' });
    passwordSetupWithPasskeyMock.mockResolvedValue({
      ok: true,
      user: { username: 'alice', has_password: true },
    });
    const onUserAuthUpdated = vi.fn();

    render(
      <SettingsPage
        displayName="Alice"
        username={null}
        hasPassword={false}
        serverUrl="https://app.im.codes"
        initialTab="security"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={onUserAuthUpdated}
      />,
    );

    expect(screen.getByText('settings.set_password_login')).toBeDefined();
    expect(screen.getByText('passkey.title')).toBeDefined();

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'Strong-Pass-123' } });

    fireEvent.click(screen.getByRole('button', { name: 'settings.set_password_btn' }));

    await waitFor(() => {
      expect(passkeyVerifyBeginMock).toHaveBeenCalledOnce();
      expect(startAuthenticationMock).toHaveBeenCalledOnce();
      expect(passwordSetupWithPasskeyMock).toHaveBeenCalledWith('alice.name', 'Strong-Pass-123', 'cid-1', { id: 'cred-1' });
      expect(onUserAuthUpdated).toHaveBeenCalledWith({ username: 'alice', hasPassword: true });
    });
  });

  it('renders password change flow and PasskeyManager on the Security tab', async () => {
    listPasskeysMock.mockResolvedValue({
      credentials: [{ id: 'cred-1', deviceName: 'MacBook Pro', createdAt: 1700000000000, lastUsedAt: null }],
    });

    render(
      <SettingsPage
        displayName="Alice"
        username="alice"
        hasPassword
        serverUrl="https://app.im.codes"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    expect(screen.getByText('alice')).toBeDefined();
    expect(screen.queryByText('settings.change_password')).toBeNull();
    expect(screen.queryByText('passkey.title')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'settings.tab_security' }));
    expect(screen.getByText('settings.change_password')).toBeDefined();
    expect(screen.queryByText('settings.set_password_login')).toBeNull();
    expect(screen.getByText('passkey.title')).toBeDefined();
    expect(await screen.findByText('MacBook Pro')).toBeDefined();
  });

  it('isolates Profile, Notifications, Security, and User Guide sections across 4 independent tabs and resets scroll', () => {
    render(
      <SettingsPage
        displayName="Alice"
        username="alice"
        hasPassword
        serverUrl="https://app.im.codes"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    const profileTab = screen.getByRole('tab', { name: 'settings.tab_profile' });
    const notificationsTab = screen.getByRole('tab', { name: 'settings.tab_notifications' });
    const securityTab = screen.getByRole('tab', { name: 'settings.tab_security' });
    const guideTab = screen.getByRole('tab', { name: 'settings.tab_guide' });
    const scroll = screen.getByTestId('settings-page-scroll');

    expect(profileTab.getAttribute('aria-selected')).toBe('true');
    expect(notificationsTab.getAttribute('aria-selected')).toBe('false');
    expect(securityTab.getAttribute('aria-selected')).toBe('false');
    expect(guideTab.getAttribute('aria-selected')).toBe('false');

    // Profile tab: Account identity + legal footer only
    expect(screen.getByRole('tabpanel', { name: 'settings.tab_profile' })).toBeDefined();
    expect(screen.getByText('settings.account_identity')).toBeDefined();
    expect(screen.getByText('settings.privacy_policy')).toBeDefined();
    expect(screen.getByText('settings.terms_of_service')).toBeDefined();
    expect(screen.queryByTestId('push-notification-settings-card')).toBeNull();
    expect(screen.queryByText('settings.change_password')).toBeNull();
    expect(screen.queryByText('passkey.title')).toBeNull();
    expect(screen.queryByTestId('guide-page')).toBeNull();
    expect(screen.queryByText('settings.team_discussion_title')).toBeNull();

    // Notifications tab: Push Notification Preferences only
    scroll.scrollTop = 120;
    fireEvent.click(notificationsTab);
    expect(notificationsTab.getAttribute('aria-selected')).toBe('true');
    expect(profileTab.getAttribute('aria-selected')).toBe('false');
    expect(scroll.scrollTop).toBe(0);
    expect(screen.getByRole('tabpanel', { name: 'settings.tab_notifications' })).toBeDefined();
    expect(screen.getByTestId('push-notification-settings-card')).toBeDefined();
    expect(screen.queryByText('settings.account_identity')).toBeNull();
    expect(screen.queryByText('settings.privacy_policy')).toBeNull();
    expect(screen.queryByText('settings.change_password')).toBeNull();
    expect(screen.queryByText('passkey.title')).toBeNull();
    expect(screen.queryByTestId('guide-page')).toBeNull();

    // Security tab: Password + PasskeyManager only
    scroll.scrollTop = 80;
    fireEvent.click(securityTab);
    expect(securityTab.getAttribute('aria-selected')).toBe('true');
    expect(scroll.scrollTop).toBe(0);
    expect(screen.getByRole('tabpanel', { name: 'settings.tab_security' })).toBeDefined();
    expect(screen.getByText('settings.change_password')).toBeDefined();
    expect(screen.getByText('passkey.title')).toBeDefined();
    expect(screen.queryByText('settings.account_identity')).toBeNull();
    expect(screen.queryByTestId('push-notification-settings-card')).toBeNull();
    expect(screen.queryByTestId('guide-page')).toBeNull();

    // User Guide tab: GuidePage only
    scroll.scrollTop = 60;
    fireEvent.click(guideTab);
    expect(guideTab.getAttribute('aria-selected')).toBe('true');
    expect(scroll.scrollTop).toBe(0);
    expect(screen.getByRole('tabpanel', { name: 'settings.tab_guide' })).toBeDefined();
    expect(screen.getByTestId('guide-page')).toBeDefined();
    expect(screen.getByText('guide.sections.team.title')).toBeDefined();
    expect(screen.queryByText('settings.account_identity')).toBeNull();
    expect(screen.queryByTestId('push-notification-settings-card')).toBeNull();
    expect(screen.queryByText('settings.change_password')).toBeNull();
    expect(screen.queryByText('passkey.title')).toBeNull();
  });

  it('establishes a bounded mobile-first scroll container with safe-area bottom padding', () => {
    render(
      <SettingsPage
        displayName="Alice"
        username="alice"
        hasPassword
        serverUrl="https://app.im.codes"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    const scroll = screen.getByTestId('settings-page-scroll');
    expect(scroll.style.overflowY).toBe('auto');
    expect(scroll.style.minHeight).toBe('0px');
    expect(scroll.style.touchAction).toBe('pan-y');
    const inner = scroll.firstElementChild as HTMLElement | null;
    expect(inner?.style.paddingBottom).toContain('--sab');
  });

  it('maps structured API error codes for password setup', async () => {
    passkeyVerifyBeginMock.mockResolvedValue({ challengeId: 'cid-1', foo: 'bar' });
    startAuthenticationMock.mockResolvedValue({ id: 'cred-1' });
    passwordSetupWithPasskeyMock.mockRejectedValue(new MockApiError(409, '{"error":"username_taken"}', 'username_taken'));

    render(
      <SettingsPage
        displayName="Alice"
        username={null}
        hasPassword={false}
        serverUrl="https://app.im.codes"
        initialTab="security"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.set_password_btn' }));

    expect(await screen.findByText('settings.username_taken')).toBeDefined();
  });

  it('shows a generic error when the API error code is unknown', async () => {
    passkeyVerifyBeginMock.mockResolvedValue({ challengeId: 'cid-1', foo: 'bar' });
    startAuthenticationMock.mockResolvedValue({ id: 'cred-1' });
    passwordSetupWithPasskeyMock.mockRejectedValue(new MockApiError(500, '{"error":"unexpected"}', null));

    render(
      <SettingsPage
        displayName="Alice"
        username={null}
        hasPassword={false}
        initialTab="security"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.set_password_btn' }));

    expect(await screen.findByText('settings.password_setup_error')).toBeDefined();
  });

  it('runs native passkey password setup flow through AuthSession', async () => {
    nativeState.value = true;
    getAuthKeyMock.mockResolvedValue('deck_key_123');
    authSessionStartMock.mockResolvedValue({ url: 'imcodes://password-setup?ok=1&username=alice.name' });
    const onUserAuthUpdated = vi.fn();

    render(
      <SettingsPage
        displayName="Alice"
        username={null}
        hasPassword={false}
        serverUrl="https://app.im.codes"
        initialTab="security"
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={onUserAuthUpdated}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'Strong-Pass-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.set_password_btn' }));

    await waitFor(() => {
      expect(getAuthKeyMock).toHaveBeenCalledOnce();
      expect(authSessionStartMock).toHaveBeenCalledOnce();
      expect(onUserAuthUpdated).toHaveBeenCalledWith({ username: 'alice.name', hasPassword: true });
    });
    const authSessionArg = authSessionStartMock.mock.calls[0]?.[0] as { url: string; callbackScheme: string };
    expect(authSessionArg.callbackScheme).toBe('imcodes');
    expect(authSessionArg.url).toContain('/?');
    expect(authSessionArg.url).toContain('action=password_setup');
    expect(authSessionArg.url).toContain('native_callback=imcodes%3A%2F%2Fpassword-setup');
    expect(authSessionArg.url).not.toContain('/api/auth/passkey/native');
    expect(passkeyVerifyBeginMock).not.toHaveBeenCalled();
    expect(startAuthenticationMock).not.toHaveBeenCalled();
  });
});
