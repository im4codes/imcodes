/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const startAuthenticationMock = vi.fn();
const startRegistrationMock = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthenticationMock(...args),
  startRegistration: (...args: unknown[]) => startRegistrationMock(...args),
}));

const {
  passkeyLoginBeginMock,
  passkeyLoginCompleteNativeMock,
  passkeyRegisterBeginMock,
  passkeyRegisterCompleteMock,
  passkeyVerifyBeginMock,
  exchangeNonceWithRetryMock,
  passwordSetupWithPasskeyMock,
  withTemporaryApiKeyMock,
  MockApiError,
} = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      public status: number,
      public body: string,
      public code: string | null = null,
    ) {
      super(`API ${status}: ${code ?? body}`);
    }
  }
  return {
    passkeyLoginBeginMock: vi.fn(),
    passkeyLoginCompleteNativeMock: vi.fn(),
    passkeyRegisterBeginMock: vi.fn(),
    passkeyRegisterCompleteMock: vi.fn(),
    passkeyVerifyBeginMock: vi.fn(),
    exchangeNonceWithRetryMock: vi.fn(),
    passwordSetupWithPasskeyMock: vi.fn(),
    withTemporaryApiKeyMock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => await fn()),
    MockApiError,
  };
});

vi.mock('../../src/api.js', () => ({
  ApiError: MockApiError,
  passkeyLoginBegin: (...args: unknown[]) => passkeyLoginBeginMock(...args),
  passkeyLoginCompleteNative: (...args: unknown[]) => passkeyLoginCompleteNativeMock(...args),
  passkeyRegisterBegin: (...args: unknown[]) => passkeyRegisterBeginMock(...args),
  passkeyRegisterComplete: (...args: unknown[]) => passkeyRegisterCompleteMock(...args),
  passkeyVerifyBegin: (...args: unknown[]) => passkeyVerifyBeginMock(...args),
  exchangeNonceWithRetry: (...args: unknown[]) => exchangeNonceWithRetryMock(...args),
  passwordSetupWithPasskey: (...args: unknown[]) => passwordSetupWithPasskeyMock(...args),
  getApiBaseUrl: () => 'https://app.im.codes',
  withTemporaryApiKey: (...args: unknown[]) => withTemporaryApiKeyMock(...args),
}));

import { NativeAuthBridge } from '../../src/pages/NativeAuthBridge.js';

describe('NativeAuthBridge', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
    vi.spyOn(window, 'open').mockImplementation(() => null);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && first.includes('Not implemented: navigation')) return;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    consoleErrorSpy.mockRestore();
    cleanup();
  });

  it('runs the password_setup bridge flow when opened via native_callback route', async () => {
    const state = btoa(JSON.stringify({
      apiKey: 'deck_key_123',
      username: 'alice.name',
      newPassword: 'strong-password-123',
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    window.history.replaceState({}, '', `/?native_callback=${encodeURIComponent('imcodes://password-setup')}&action=password_setup#state=${state}`);

    passkeyVerifyBeginMock.mockResolvedValue({ challengeId: 'cid-1', foo: 'bar' });
    startAuthenticationMock.mockResolvedValue({ id: 'cred-1' });
    passwordSetupWithPasskeyMock.mockResolvedValue({ ok: true, user: { username: 'alice.name' } });

    render(<NativeAuthBridge callbackUrl="imcodes://password-setup" />);

    await waitFor(() => {
      expect(withTemporaryApiKeyMock).toHaveBeenCalledOnce();
      expect(withTemporaryApiKeyMock).toHaveBeenCalledWith('deck_key_123', expect.any(Function));
      expect(passkeyVerifyBeginMock).toHaveBeenCalledOnce();
      expect(startAuthenticationMock).toHaveBeenCalledOnce();
      expect(passwordSetupWithPasskeyMock).toHaveBeenCalledWith('alice.name', 'strong-password-123', 'cid-1', { id: 'cred-1' });
    });

    const fallback = await screen.findByText('login.native_callback_fallback');
    expect((fallback as HTMLAnchorElement).href).toBe('imcodes://password-setup?ok=1&username=alice.name');
  });

  it('uses nonce exchange for password setup when the bridge state carries a nonce', async () => {
    const state = btoa(JSON.stringify({
      nonce: 'nonce-123',
      username: 'alice.name',
      newPassword: 'strong-password-123',
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    window.history.replaceState({}, '', `/?native_callback=${encodeURIComponent('imcodes://password-setup')}&action=password_setup#state=${state}`);

    exchangeNonceWithRetryMock.mockResolvedValue({ apiKey: 'deck_key_123', userId: 'user-1', keyId: 'key-1' });
    passkeyVerifyBeginMock.mockResolvedValue({ challengeId: 'cid-1', foo: 'bar' });
    startAuthenticationMock.mockResolvedValue({ id: 'cred-1' });
    passwordSetupWithPasskeyMock.mockResolvedValue({ ok: true, user: { username: 'alice.name' } });

    render(<NativeAuthBridge callbackUrl="imcodes://password-setup" />);

    await waitFor(() => {
      expect(exchangeNonceWithRetryMock).toHaveBeenCalledOnce();
      expect(exchangeNonceWithRetryMock).toHaveBeenCalledWith('https://app.im.codes', 'nonce-123');
      expect(withTemporaryApiKeyMock).toHaveBeenCalledWith('deck_key_123', expect.any(Function));
      expect(passwordSetupWithPasskeyMock).toHaveBeenCalledWith('alice.name', 'strong-password-123', 'cid-1', { id: 'cred-1' });
    });
  });
});
