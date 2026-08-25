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

const passwordLoginMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/api.js', () => ({
  configureApiKey: (...args: unknown[]) => configureApiKeyMock(...args),
  exchangeNonceWithRetry: (...args: unknown[]) => exchangeNonceWithRetryMock(...args),
  passkeyLoginBegin: vi.fn(),
  passkeyLoginComplete: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
  passwordLogin: (...args: unknown[]) => passwordLoginMock(...args),
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

  it('drops an in-flight native login before any credential write when its parent generation expires', async () => {
    authSessionStartMock.mockResolvedValue({ url: 'imcodes://auth?nonce=nonce-stale' });
    let resolveExchange!: (value: { apiKey: string; userId: string; keyId: string }) => void;
    exchangeNonceWithRetryMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveExchange = resolve;
    }));
    let current = true;
    const finish = vi.fn();
    const onLoginSuccess = vi.fn();

    render(
      <LoginPage
        serverUrl="https://app.im.codes"
        beginAuthAttempt={() => ({ isCurrent: () => current, finish })}
        onLoginSuccess={onLoginSuccess}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'login.passkey_signin' }));
    await waitFor(() => {
      expect(exchangeNonceWithRetryMock).toHaveBeenCalledWith('https://app.im.codes', 'nonce-stale');
    });

    current = false;
    resolveExchange({ apiKey: 'must-not-store', userId: 'stale-user', keyId: 'stale-key' });

    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(storeAuthKeyMock).not.toHaveBeenCalled();
    expect(configureApiKeyMock).not.toHaveBeenCalled();
    expect(preferencesSetMock).not.toHaveBeenCalled();
    expect(onLoginSuccess).not.toHaveBeenCalled();
  });

  it('shows a connection failure message when nonce exchange fails', async () => {
    authSessionStartMock.mockResolvedValue({ url: 'imcodes://auth?nonce=nonce-123' });
    exchangeNonceWithRetryMock.mockRejectedValue(new Error('network down'));

    render(<LoginPage serverUrl="https://app.im.codes" onLoginSuccess={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'login.passkey_signin' }));

    expect(await screen.findByText('login.nonce_exchange_failed')).toBeDefined();
  });

  it('rejects a second native password attempt while Secure Storage is pending', async () => {
    passwordLoginMock.mockResolvedValue({
      apiKey: 'api-key-a',
      userId: 'user-a',
      keyId: 'key-a',
    });
    let resolveStore!: () => void;
    storeAuthKeyMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveStore = resolve;
    }));
    preferencesSetMock.mockResolvedValue(undefined);
    const beginAuthAttempt = vi.fn(() => ({
      isCurrent: () => true,
      finish: vi.fn(),
    }));
    const onLoginSuccess = vi.fn();
    const onChangeServer = vi.fn();

    render(
      <LoginPage
        serverUrl="https://app.im.codes"
        beginAuthAttempt={beginAuthAttempt}
        onLoginSuccess={onLoginSuccess}
        onChangeServer={onChangeServer}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    const username = screen.getByPlaceholderText('login.username_placeholder');
    const password = screen.getByPlaceholderText('login.password_placeholder');
    fireEvent.input(username, { target: { value: 'user-a' } });
    fireEvent.input(password, { target: { value: 'password-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => expect(storeAuthKeyMock).toHaveBeenCalledWith('api-key-a'));
    fireEvent.keyDown(password, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'common.loading' }));
    const changeServer = screen.getByRole('button', { name: 'serverSetup.changeServer' });
    expect((changeServer as HTMLButtonElement).disabled).toBe(true);
    (changeServer as HTMLButtonElement).click();
    expect(passwordLoginMock).toHaveBeenCalledTimes(1);
    expect(beginAuthAttempt).toHaveBeenCalledTimes(1);
    expect(onChangeServer).not.toHaveBeenCalled();

    resolveStore();
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith(
      'user-a',
      'https://app.im.codes',
    ));
    expect(preferencesSetMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a second native password attempt while key-id Preferences are pending', async () => {
    passwordLoginMock.mockResolvedValue({
      apiKey: 'api-key-b',
      userId: 'user-b',
      keyId: 'key-b',
    });
    storeAuthKeyMock.mockResolvedValue(undefined);
    let resolvePreference!: () => void;
    preferencesSetMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePreference = resolve;
    }));
    const beginAuthAttempt = vi.fn(() => ({
      isCurrent: () => true,
      finish: vi.fn(),
    }));
    const onLoginSuccess = vi.fn();
    const onChangeServer = vi.fn();

    render(
      <LoginPage
        serverUrl="https://app.im.codes"
        beginAuthAttempt={beginAuthAttempt}
        onLoginSuccess={onLoginSuccess}
        onChangeServer={onChangeServer}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    const username = screen.getByPlaceholderText('login.username_placeholder');
    const password = screen.getByPlaceholderText('login.password_placeholder');
    fireEvent.input(username, { target: { value: 'user-b' } });
    fireEvent.input(password, { target: { value: 'password-b' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => expect(preferencesSetMock).toHaveBeenCalledWith({
      key: 'deck_api_key_id',
      value: 'key-b',
    }));
    fireEvent.keyDown(password, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'common.loading' }));
    const changeServer = screen.getByRole('button', { name: 'serverSetup.changeServer' });
    expect((changeServer as HTMLButtonElement).disabled).toBe(true);
    (changeServer as HTMLButtonElement).click();
    expect(passwordLoginMock).toHaveBeenCalledTimes(1);
    expect(beginAuthAttempt).toHaveBeenCalledTimes(1);
    expect(onChangeServer).not.toHaveBeenCalled();

    resolvePreference();
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith(
      'user-b',
      'https://app.im.codes',
    ));
    expect(storeAuthKeyMock).toHaveBeenCalledTimes(1);
  });
});

describe('LoginPage password login: remember-password', () => {
  // jsdom's `window.location` is locked down; we can't redefine `reload`
  // directly. Replace the entire `location` object via vi.stubGlobal for
  // the duration of the suite — that bypasses the descriptor problem.
  beforeEach(() => {
    vi.clearAllMocks();
    nativeState.value = false; // exercise the web (non-native) branch
    localStorage.clear();
    const fakeLocation: Partial<Location> = {
      ...window.location,
      reload: vi.fn(),
      assign: vi.fn(),
      replace: vi.fn(),
      href: window.location.href,
    };
    vi.stubGlobal('location', fakeLocation);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  function openPasswordMode() {
    render(<LoginPage serverUrl="https://app.im.codes" onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
  }

  it('defaults the remember-password checkbox to checked when no preference exists', () => {
    openPasswordMode();
    const cb = screen.getByLabelText('login.remember_password') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('honors a previously stored "off" preference', () => {
    localStorage.setItem('rcc_login_remember', '0');
    openPasswordMode();
    const cb = screen.getByLabelText('login.remember_password') as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('hydrates username and password from localStorage when remember is on', () => {
    localStorage.setItem('rcc_login_remember', '1');
    localStorage.setItem('rcc_login_username', 'alice');
    localStorage.setItem('rcc_login_password', 'pw1');
    openPasswordMode();
    const username = screen.getByPlaceholderText('login.username_placeholder') as HTMLInputElement;
    const password = screen.getByPlaceholderText('login.password_placeholder') as HTMLInputElement;
    expect(username.value).toBe('alice');
    expect(password.value).toBe('pw1');
  });

  it('does NOT hydrate credentials when remember was previously turned off', () => {
    localStorage.setItem('rcc_login_remember', '0');
    localStorage.setItem('rcc_login_username', 'alice');
    localStorage.setItem('rcc_login_password', 'pw1');
    openPasswordMode();
    const username = screen.getByPlaceholderText('login.username_placeholder') as HTMLInputElement;
    const password = screen.getByPlaceholderText('login.password_placeholder') as HTMLInputElement;
    expect(username.value).toBe('');
    expect(password.value).toBe('');
  });

  it('persists username + password to localStorage on successful login when checkbox is checked', async () => {
    passwordLoginMock.mockResolvedValue({});

    openPasswordMode();
    const username = screen.getByPlaceholderText('login.username_placeholder') as HTMLInputElement;
    const password = screen.getByPlaceholderText('login.password_placeholder') as HTMLInputElement;
    fireEvent.input(username, { target: { value: 'bob' } });
    fireEvent.input(password, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => {
      expect(localStorage.getItem('rcc_login_remember')).toBe('1');
      expect(localStorage.getItem('rcc_login_username')).toBe('bob');
      expect(localStorage.getItem('rcc_login_password')).toBe('secret');
    });
  });

  it('claims the parent auth generation before starting a Web password login', async () => {
    let resolveLogin!: (value: Record<string, never>) => void;
    passwordLoginMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveLogin = resolve;
    }));
    let generation = 0;
    const staleMountGeneration = generation;
    const finish = vi.fn();
    const beginAuthAttempt = vi.fn(() => {
      generation += 1;
      const claimedGeneration = generation;
      return {
        isCurrent: () => generation === claimedGeneration,
        finish,
      };
    });
    const onLogin = vi.fn();

    render(
      <LoginPage
        serverUrl="https://app.im.codes"
        beginAuthAttempt={beginAuthAttempt}
        onLogin={onLogin}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), {
      target: { value: 'new-user' },
    });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), {
      target: { value: 'new-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => expect(passwordLoginMock).toHaveBeenCalledTimes(1));
    expect(beginAuthAttempt).toHaveBeenCalledTimes(1);
    expect(generation).not.toBe(staleMountGeneration);
    expect(onLogin).not.toHaveBeenCalled();

    resolveLogin({});
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('immediately wipes saved credentials when the user unchecks the box', () => {
    localStorage.setItem('rcc_login_remember', '1');
    localStorage.setItem('rcc_login_username', 'alice');
    localStorage.setItem('rcc_login_password', 'pw1');
    openPasswordMode();
    const cb = screen.getByLabelText('login.remember_password') as HTMLInputElement;
    fireEvent.click(cb);
    expect(localStorage.getItem('rcc_login_remember')).toBe('0');
    expect(localStorage.getItem('rcc_login_username')).toBeNull();
    expect(localStorage.getItem('rcc_login_password')).toBeNull();
  });

  it('does NOT save the password to localStorage on successful login when checkbox is unchecked', async () => {
    localStorage.setItem('rcc_login_remember', '0');
    passwordLoginMock.mockResolvedValue({});

    openPasswordMode();
    const username = screen.getByPlaceholderText('login.username_placeholder') as HTMLInputElement;
    const password = screen.getByPlaceholderText('login.password_placeholder') as HTMLInputElement;
    fireEvent.input(username, { target: { value: 'carol' } });
    fireEvent.input(password, { target: { value: 'pw9' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => {
      expect(passwordLoginMock).toHaveBeenCalled();
    });
    expect(localStorage.getItem('rcc_login_remember')).toBe('0');
    expect(localStorage.getItem('rcc_login_username')).toBeNull();
    expect(localStorage.getItem('rcc_login_password')).toBeNull();
  });
});
