/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetchMock, fetchMeMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  fetchMeMock: vi.fn(),
}));

vi.mock('../src/api.js', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  fetchMe: (...args: unknown[]) => fetchMeMock(...args),
  ApiError: class ApiError extends Error {},
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'remote_desktop.native_step_up_title': 'Confirm in IM.codes',
      'remote_desktop.native_step_up_pending': 'Verify with your passkey.',
      'remote_desktop.native_step_up_verified': 'Verified, return to shell.',
      'remote_desktop.native_step_up_failed': 'Verification could not be completed.',
    })[key] ?? key,
  }),
}));

import {
  REMOTE_DESKTOP_NATIVE_STEP_UP_PATH,
  RemoteDesktopNativeStepUp,
  readRemoteDesktopNativeStepUpChallenge,
} from '../src/pages/RemoteDesktopNativeStepUp.js';

const CHALLENGE_ID = 'A'.repeat(43);
const WEBAUTHN_CHALLENGE = 'B'.repeat(43);

describe('RemoteDesktopNativeStepUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, '', `${REMOTE_DESKTOP_NATIVE_STEP_UP_PATH}?challengeId=${CHALLENGE_ID}`);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('requires the browser account session before WebAuthn and completes through the native endpoint in order', async () => {
    const order: string[] = [];
    fetchMeMock.mockImplementation(async () => { order.push('account'); return { id: 'owner-1' }; });
    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/options')) {
        order.push('options');
        return {
          challengeId: CHALLENGE_ID,
          challenge: WEBAUTHN_CHALLENGE,
          rpId: 'app.example.test',
          userVerification: 'discouraged',
          allowCredentials: [{ id: 'C'.repeat(43), type: 'public-key' }],
        };
      }
      order.push('complete');
      expect(path).toBe('/api/auth/remote-desktop/step-up/complete-native');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        challengeId: CHALLENGE_ID,
        response: { id: 'credential-1', type: 'public-key' },
      });
      return { grantToken: 'must-never-reach-the-page' };
    });
    const get = vi.fn(async (options: CredentialRequestOptions) => {
      order.push('webauthn');
      expect(options.publicKey?.challenge).toBeInstanceOf(ArrayBuffer);
      expect(options.publicKey?.userVerification).toBe('required');
      expect(options.publicKey?.allowCredentials?.[0]?.id).toBeInstanceOf(ArrayBuffer);
      return {
        id: 'credential-1',
        type: 'public-key',
        toJSON: () => ({ id: 'credential-1', type: 'public-key' }),
      } as Credential;
    });
    Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get } });

    render(<RemoteDesktopNativeStepUp />);

    expect(await screen.findByText('Verified, return to shell.')).toBeTruthy();
    expect(order).toEqual(['account', 'options', 'webauthn', 'complete']);
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      1,
      `/api/auth/remote-desktop/step-up/${CHALLENGE_ID}/options`,
    );
  });

  it('never renders or persists a grant and does not mutate URL history', async () => {
    fetchMeMock.mockResolvedValue({ id: 'owner-1' });
    apiFetchMock.mockResolvedValueOnce({
      challengeId: CHALLENGE_ID,
      challenge: WEBAUTHN_CHALLENGE,
      rpId: 'app.example.test',
    }).mockResolvedValueOnce({
      stepUpGrant: 'grant-secret-sentinel',
      serverId: 'server-secret-sentinel',
    });
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: vi.fn(async () => ({
          id: 'credential-1',
          type: 'public-key',
          toJSON: () => ({ id: 'credential-1' }),
        })),
      },
    });
    const setLocal = vi.spyOn(Storage.prototype, 'setItem');
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');

    render(<RemoteDesktopNativeStepUp />);

    expect(await screen.findByText('Verified, return to shell.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('grant-secret-sentinel');
    expect(document.body.textContent).not.toContain('server-secret-sentinel');
    expect(document.body.textContent).not.toContain(CHALLENGE_ID);
    expect(JSON.stringify({ ...localStorage })).not.toContain('grant-secret-sentinel');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('grant-secret-sentinel');
    expect(setLocal).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe(`?challengeId=${CHALLENGE_ID}`);
  });

  it('fails generically before any request when the URL has extra, duplicate, or malformed fields', async () => {
    for (const search of [
      `?challengeId=${CHALLENGE_ID}&serverId=server-1`,
      `?challengeId=${CHALLENGE_ID}&challengeId=${CHALLENGE_ID}`,
      '?challengeId=short',
      `?challengeId=${CHALLENGE_ID}&grant=secret`,
    ]) {
      expect(readRemoteDesktopNativeStepUpChallenge({
        pathname: REMOTE_DESKTOP_NATIVE_STEP_UP_PATH,
        search,
        hash: '',
      } as Location)).toBeNull();
    }
    window.history.replaceState({}, '', `${REMOTE_DESKTOP_NATIVE_STEP_UP_PATH}?challengeId=short`);
    render(<RemoteDesktopNativeStepUp />);
    expect((await screen.findByRole('alert')).textContent).toBe('Verification could not be completed.');
    expect(fetchMeMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('is mounted as a dedicated app route before the ordinary app shell', () => {
    const webRoot = existsSync(resolve(process.cwd(), 'src/main.tsx'))
      ? process.cwd()
      : resolve(process.cwd(), 'web');
    const source = readFileSync(resolve(webRoot, 'src/main.tsx'), 'utf8');
    expect(source).toContain("window.location.pathname === REMOTE_DESKTOP_NATIVE_STEP_UP_PATH");
    expect(source).toContain('if (remoteDesktopNativeStepUpEntry)');
    expect(source).toContain('render(<RemoteDesktopNativeStepUp />');
  });
});
