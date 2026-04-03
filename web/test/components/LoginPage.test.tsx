/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const startAuthenticationMock = vi.fn();
const startRegistrationMock = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthenticationMock(...args),
  startRegistration: (...args: unknown[]) => startRegistrationMock(...args),
}));

const nativeState = vi.hoisted(() => ({ value: true }));
const {
  authSessionStartMock,
  configureApiKeyMock,
  exchangeNonceWithRetryMock,
  storeAuthKeyMock,
  preferencesSetMock,
} = vi.hoisted(() => ({
  authSessionStartMock: vi.fn(),
  configureApiKeyMock: vi.fn(),
  exchangeNonceWithRetryMock: vi.fn(),
  storeAuthKeyMock: vi.fn(),
  preferencesSetMock: vi.fn(),
}));

vi.mock('../../src/api.js', () => ({
  configureApiKey: (...args: unknown[]) => configureApiKeyMock(...args),
  exchangeNonceWithRetry: (...args: unknown[]) => exchangeNonceWithRetryMock(...args),
  passkeyLoginBegin: vi.fn(),
  passkeyLoginComplete: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
  passwordLogin: vi.fn(),
  passwordChange: vi.fn(),
  passwordRegister: vi.fn(),
}));

vi.mock('../../src/native.js', () => ({
  isNative: () => nativeState.value,
}));

vi.mock('../../src/plugins/auth-session.js', () => ({
  default: { start: (...args: unknown[]) => authSessionStartMock(...args) },
}));

vi.mock('../../src/biometric-auth.js', () => ({
  storeAuthKey: (...args: unknown[]) => storeAuthKeyMock(...args),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    set: (...args: unknown[]) => preferencesSetMock(...args),
  },
}));

import { LoginPage } from '../../src/pages/LoginPage.js';

describe('LoginPage native auth nonce exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeState.value = true;
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
  });

  it('exchanges a callback nonce before storing the native auth key', async () => {
    authSessionStartMock.mockResolvedValue({ url: 'imcodes://auth?nonce=nonce-123' });
    exchangeNonceWithRetryMock.mockResolvedValue({ apiKey: 'api-key-1', userId: 'user-1', keyId: 'key-1' });
    const onLoginSuccess = vi.fn();

    render(<LoginPage serverUrl="https://app.im.codes" onLoginSuccess={onLoginSuccess} />);

    fireEvent.click(await screen.findByRole('button', { name: 'login.passkey_signin' }));

    await waitFor(() => {
      expect(exchangeNonceWithRetryMock).toHaveBeenCalledWith('https://app.im.codes', 'nonce-123');
      expect(storeAuthKeyMock).toHaveBeenCalledWith('api-key-1');
      expect(configureApiKeyMock).toHaveBeenCalledWith('api-key-1');
      expect(preferencesSetMock).toHaveBeenCalledWith({ key: 'deck_api_key_id', value: 'key-1' });
      expect(onLoginSuccess).toHaveBeenCalledWith('user-1', 'https://app.im.codes');
    });
  });

  it('falls back to the legacy key callback when nonce is absent', async () => {
    authSessionStartMock.mockResolvedValue({ url: 'imcodes://auth?key=legacy-key&userId=user-2&keyId=key-2' });
    const onLoginSuccess = vi.fn();

    render(<LoginPage serverUrl="https://app.im.codes" onLoginSuccess={onLoginSuccess} />);
    fireEvent.click(await screen.findByRole('button', { name: 'login.passkey_signin' }));

    await waitFor(() => {
      expect(exchangeNonceWithRetryMock).not.toHaveBeenCalled();
      expect(storeAuthKeyMock).toHaveBeenCalledWith('legacy-key');
      expect(configureApiKeyMock).toHaveBeenCalledWith('legacy-key');
      expect(preferencesSetMock).toHaveBeenCalledWith({ key: 'deck_api_key_id', value: 'key-2' });
      expect(onLoginSuccess).toHaveBeenCalledWith('user-2', 'https://app.im.codes');
    });
  });

  it('shows a connection failure message when nonce exchange fails', async () => {
    authSessionStartMock.mockResolvedValue({ url: 'imcodes://auth?nonce=nonce-123' });
    exchangeNonceWithRetryMock.mockRejectedValue(new Error('network down'));

    render(<LoginPage serverUrl="https://app.im.codes" onLoginSuccess={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'login.passkey_signin' }));

    expect(await screen.findByText('login.nonce_exchange_failed')).toBeDefined();
  });
});
