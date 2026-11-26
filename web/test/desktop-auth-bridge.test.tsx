/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { DesktopAuthBridge } from '../src/pages/DesktopAuthBridge.js';

const VALID_CB = 'http://127.0.0.1:43751/setup/callback?state=StateToken12345678';

describe('DesktopAuthBridge', () => {
  const replaceSpy = vi.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        replace: replaceSpy,
      },
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('requests a desktop nonce and redirects to the validated loopback callback', async () => {
    const redirectUrl = 'http://127.0.0.1:43751/setup/callback?nonce=nonce-xyz&state=StateToken12345678';
    apiFetchMock.mockResolvedValueOnce({ nonce: 'nonce-xyz', redirectUrl });

    render(<DesktopAuthBridge callbackUrl={VALID_CB} />);

    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/auth/desktop/nonce', {
        method: 'POST',
        body: JSON.stringify({ callbackUrl: VALID_CB }),
      });
      expect(replaceSpy).toHaveBeenCalledWith(redirectUrl);
    });
  });

  it('refuses an off-origin or mismatched-state redirectUrl from the server', async () => {
    apiFetchMock.mockResolvedValueOnce({
      nonce: 'nonce-xyz',
      redirectUrl: 'https://evil.example/setup/callback?nonce=nonce-xyz&state=StateToken12345678',
    });

    render(<DesktopAuthBridge callbackUrl={VALID_CB} />);

    await waitFor(() => {
      expect(screen.getByText('login.desktop_callback_error')).toBeTruthy();
    });
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('has all desktop_callback i18n keys in every web locale', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'];
    for (const loc of locales) {
      const json = JSON.parse(
        readFileSync(resolve(__dirname, `../src/i18n/locales/${loc}.json`), 'utf8'),
      ) as { login?: Record<string, string> };
      expect(json.login?.desktop_callback_completing, loc).toBeTruthy();
      expect(json.login?.desktop_callback_error, loc).toBeTruthy();
      expect(json.login?.desktop_callback_retry, loc).toBeTruthy();
    }
  });
});
