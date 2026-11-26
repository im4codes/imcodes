/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LoginPage } from '../../src/pages/LoginPage.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts?.code ? `${key}:${String(opts.code)}` : key) }),
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

vi.mock('../../src/native.js', () => ({
  isNative: () => false,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('LoginPage + real apiFetch auth error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('displays invalid_credentials immediately on wrong password/server without calling /api/auth/refresh or showing invalid_body', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/auth/refresh')) {
        return jsonResponse({ error: 'invalid_body' }, 400);
      }
      return jsonResponse({ error: 'invalid_credentials' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage serverUrl="https://wrong-server.example" onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => {
      expect(screen.getByText('login.invalid_credentials')).toBeTruthy();
    }, { timeout: 2500 });
    expect(screen.queryByText(/invalid_body/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/auth/password/login');
  });

  it('keeps 429 too_many_attempts and 403 account_disabled flowing cleanly through real apiFetch', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'too_many_attempts', retryAfterMs: 121_000 }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'account_disabled' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage serverUrl="https://app.im.codes" onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'bad' } });

    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));
    await waitFor(() => expect(screen.getByText('login.too_many_attempts')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));
    await waitFor(() => expect(screen.getByText('login.account_disabled')).toBeTruthy());
  });

  it('shows localized invalid_credentials without refresh, /user/me, or raw code leak when forced password change returns 401 invalid_old_password', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, passwordMustChange: true }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_old_password' }, 401));
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage serverUrl="https://app.im.codes" onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'stale-temp-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await screen.findByText('login.must_change_password');
    fireEvent.input(screen.getByPlaceholderText('login.new_password_placeholder'), { target: { value: 'NewPassw0rd1!' } });
    fireEvent.input(screen.getByPlaceholderText('login.confirm_password_placeholder'), { target: { value: 'NewPassw0rd1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.change_password_btn' }));

    await waitFor(() => {
      expect(screen.getByText('login.invalid_credentials')).toBeTruthy();
    });
    expect(screen.queryByText(/invalid_old_password/)).toBeNull();
    expect(screen.queryByText(/login_failed_code/)).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/auth/password/login',
      '/api/auth/password/change',
    ]);
  });
});
