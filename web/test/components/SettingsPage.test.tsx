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
  updateDisplayName: (...args: unknown[]) => updateDisplayNameMock(...args),
  passwordChange: (...args: unknown[]) => passwordChangeMock(...args),
  passkeyVerifyBegin: (...args: unknown[]) => passkeyVerifyBeginMock(...args),
  passwordSetupWithPasskey: (...args: unknown[]) => passwordSetupWithPasskeyMock(...args),
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
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={onUserAuthUpdated}
      />,
    );

    expect(screen.getByText('settings.set_password_login')).toBeDefined();

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'strong-password-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'strong-password-123' } });

    fireEvent.click(screen.getByRole('button', { name: 'settings.set_password_btn' }));

    await waitFor(() => {
      expect(passkeyVerifyBeginMock).toHaveBeenCalledOnce();
      expect(startAuthenticationMock).toHaveBeenCalledOnce();
      expect(passwordSetupWithPasskeyMock).toHaveBeenCalledWith('alice.name', 'strong-password-123', 'cid-1', { id: 'cred-1' });
      expect(onUserAuthUpdated).toHaveBeenCalledWith({ username: 'alice', hasPassword: true });
    });
  });

  it('renders password change flow when a password already exists', () => {
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

    expect(screen.getByText('settings.change_password')).toBeDefined();
    expect(screen.queryByText('settings.set_password_login')).toBeNull();
    expect(screen.getByText('alice')).toBeDefined();
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
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'strong-password-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'strong-password-123' } });
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
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={vi.fn()}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'strong-password-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'strong-password-123' } });
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
        onBack={vi.fn()}
        onDisplayNameChanged={vi.fn()}
        onUserAuthUpdated={onUserAuthUpdated}
      />,
    );

    fireEvent.input(screen.getByPlaceholderText('settings.username_placeholder'), { target: { value: 'Alice.Name' } });
    fireEvent.input(screen.getByPlaceholderText('settings.new_password'), { target: { value: 'strong-password-123' } });
    fireEvent.input(screen.getByPlaceholderText('settings.confirm_password'), { target: { value: 'strong-password-123' } });
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
