/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { LoginPage } from '../../src/pages/LoginPage.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.code ? `${key}:${String(opts.code)}` : key),
    i18n: { language: 'en' },
  }),
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

describe('LoginPage email auth flows', () => {
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

  it('hides email fields and forgot password when server returns emailAuthEnabled=false or 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/api/auth/email/config')) {
        return jsonResponse({ error: 'not_found' }, 404);
      }
      return jsonResponse({});
    }));

    render(<LoginPage serverUrl="https://app.im.codes" onLogin={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.username_placeholder')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: 'login.forgot_password' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'login.password_register' }));
    expect(screen.queryByPlaceholderText('login.email_placeholder')).toBeNull();
  });

  it('discovers emailAuthEnabled=true via /api/auth/email/config and supports email-verified registration + forgot password reset', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      calls.push({ url: urlStr, body });
      if (urlStr.endsWith('/api/auth/email/config')) {
        return jsonResponse({ emailAuthEnabled: true });
      }
      if (urlStr.endsWith('/api/auth/email/send-code')) {
        return jsonResponse({ ok: true });
      }
      if (urlStr.endsWith('/api/auth/password/register')) {
        return jsonResponse({ ok: true });
      }
      if (urlStr.endsWith('/api/auth/password/reset')) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    }));

    const onLogin = vi.fn();
    render(<LoginPage serverUrl="https://app.im.codes" completionMode="callback" onLogin={onLogin} />);

    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText('login.username_or_email_placeholder')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'login.forgot_password' })).toBeTruthy();
    });

    // 1. Registration with email OTP
    fireEvent.click(screen.getByRole('button', { name: 'login.password_register' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice99' } });
    fireEvent.input(screen.getByPlaceholderText('login.email_placeholder'), { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.send_email_code' }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/auth/email/send-code') && c.body?.purpose === 'register')).toBe(true);
    });

    fireEvent.input(screen.getByPlaceholderText('login.email_code_placeholder'), { target: { value: '123456' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'StrongPass1!' } });
    fireEvent.input(screen.getByPlaceholderText('login.confirm_password_placeholder'), { target: { value: 'StrongPass1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.password_register_btn' }));

    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/auth/password/register'))).toBe(true);
    });
    const regCall = calls.find((c) => c.url.endsWith('/api/auth/password/register'));
    expect(regCall?.body).toMatchObject({
      username: 'alice99',
      email: 'alice@example.com',
      emailCode: '123456',
    });
    expect(onLogin).toHaveBeenCalledTimes(1);

    // 2. Forgot password reset flow (fresh render so 60s resend cooldown resets)
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(screen.getByRole('button', { name: 'login.forgot_password' })).toBeTruthy();
    cleanup();

    render(<LoginPage serverUrl="https://app.im.codes" completionMode="callback" onLogin={onLogin} />);
    fireEvent.click(screen.getByRole('button', { name: 'login.password_signin' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'login.forgot_password' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'login.forgot_password' }));
    fireEvent.input(screen.getByPlaceholderText('login.email_placeholder'), { target: { value: 'alice@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.send_email_code' }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/api/auth/email/send-code') && c.body?.purpose === 'password_reset')).toBe(true);
    });
    fireEvent.input(screen.getByPlaceholderText('login.email_code_placeholder'), { target: { value: '654321' } });
    fireEvent.input(screen.getByPlaceholderText('login.new_password_placeholder'), { target: { value: 'BetterPass2!' } });
    fireEvent.input(screen.getByPlaceholderText('login.confirm_password_placeholder'), { target: { value: 'BetterPass2!' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.reset_password_btn' }));

    await waitFor(() => {
      expect(screen.getByText('login.password_reset_success')).toBeTruthy();
    });
    const resetCall = calls.find((c) => c.url.endsWith('/api/auth/password/reset'));
    expect(resetCall?.body).toEqual({
      email: 'alice@example.com',
      code: '654321',
      newPassword: 'BetterPass2!',
    });
  });
});
