/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_STOP_ORIGIN,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../shared/remote-desktop-access.js';
import { RemoteDesktopGuestAccess } from '../src/components/RemoteDesktopGuestAccess.js';
import {
  REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY,
  REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY,
  generateRemoteDesktopBrowserKeyPair,
} from '../src/remote-desktop-access-crypto.js';
import type { RemoteDesktopAccessApi, RemoteDesktopGuestReady, RemoteDesktopGuestSessionStarter } from '../src/api/remote-desktop-access.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${Object.values(values).join(':')}` : key }) }));

async function ready(): Promise<RemoteDesktopGuestReady> {
  return {
    status: 'ready', hostId: 'host-1', serverId: 'server-internal-1', bootstrapTicket: 'A'.repeat(43), expiresAt: Date.now() + 60_000,
    mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW, source: REMOTE_DESKTOP_ACTOR_SOURCE.ATTENDED_LINK,
    browserKey: await generateRemoteDesktopBrowserKeyPair(),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  localStorage.clear();
  sessionStorage.clear();
});
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

describe('RemoteDesktopGuestAccess', () => {
  it('always exposes an escape back to the normal IM.codes entry', () => {
    const onExit = vi.fn();
    render(<RemoteDesktopGuestAccess onExit={onExit} />);

    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.back_to_imcodes' }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('moves a resolved scrubbed invite into attended waiting without rendering serverId or desktop controls', async () => {
    const stop = vi.fn();
    const starter: RemoteDesktopGuestSessionStarter = { start: vi.fn(async () => ({ stop })) };
    const result = render(<RemoteDesktopGuestAccess bootstrap={Promise.resolve({ status: 'invite', token: 'A'.repeat(43) })} api={{
      resolveInvite: vi.fn(async () => ready()),
    } as unknown as RemoteDesktopAccessApi} sessionStarter={starter} />);
    expect(await screen.findByText(/waiting_for_consent/)).toBeTruthy();
    expect(starter.start).toHaveBeenCalledWith(expect.objectContaining({
      serverId: 'server-internal-1', hostId: 'host-1', mode: 'view', source: 'attended_link',
      bootstrapProof: expect.any(Object),
    }), expect.any(Function));
    expect(document.body.textContent).not.toContain('server-internal-1');
    expect(document.body.textContent).not.toContain('remote_desktop.workspace_wall');
    expect(document.body.textContent).not.toContain('settings');
    result.unmount();
    expect(stop).toHaveBeenCalledWith(REMOTE_DESKTOP_STOP_ORIGIN.GUEST_UNMOUNT);
  });

  it('uses generic unavailable/cooldown states and clears password input after proof', async () => {
    const provePassword = vi.fn(async () => ({ status: 'rate_limited' as const }));
    render(<RemoteDesktopGuestAccess api={{ provePassword } as unknown as RemoteDesktopAccessApi} />);
    fireEvent.input(screen.getByLabelText(/public_id/), { target: { value: '5123456789' } });
    const password = screen.getByLabelText(/password/) as HTMLInputElement;
    fireEvent.input(password, { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await waitFor(() => expect(provePassword).toHaveBeenCalledWith(expect.objectContaining({ publicNodeId: 5123456789, password: 'secret-password' })));
    expect(await screen.findByText(/cooldown/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('secret-password');
  });

  it('retries a scrubbed invitation with the same decrypted bearer and browser key', async () => {
    const calls: Array<Parameters<RemoteDesktopAccessApi['resolveInvite']>[0]> = [];
    const resolveInvite = vi.fn(async (input: Parameters<RemoteDesktopAccessApi['resolveInvite']>[0]) => {
      calls.push(input);
      if (calls.length === 1) return { status: 'unavailable' as const };
      return {
        ...await ready(),
        browserKey: input.browserKey,
      };
    });
    const starter: RemoteDesktopGuestSessionStarter = {
      start: vi.fn(async () => ({ stop: vi.fn() })),
    };
    render(<RemoteDesktopGuestAccess
      bootstrap={Promise.resolve({ status: 'invite', token: 'B'.repeat(43) })}
      api={{ resolveInvite } as unknown as RemoteDesktopAccessApi}
      sessionStarter={starter}
    />);

    expect(await screen.findByText(/state_invite_unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try_again/ }));
    expect(await screen.findByText(/waiting_for_consent/)).toBeTruthy();
    expect(resolveInvite).toHaveBeenCalledTimes(2);
    expect(calls[0].token).toBe('B'.repeat(43));
    expect(calls[1].token).toBe(calls[0].token);
    expect(calls[1].browserKey).toBe(calls[0].browserKey);
    expect(calls[0].browserKey.privateKey.extractable).toBe(false);
  });

  it('gives authenticated invitation, password and offline failures distinct safe next steps', async () => {
    const invite = render(<RemoteDesktopGuestAccess
      bootstrap={Promise.resolve({ status: 'invite', token: 'C'.repeat(43) })}
      api={{ resolveInvite: vi.fn(async () => ({ status: 'invitation_expired' as const })) } as unknown as RemoteDesktopAccessApi}
    />);
    expect(await screen.findByText('remote_desktop.guest.state_invitation_expired')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/server-internal|host-internal/);
    invite.unmount();

    render(<RemoteDesktopGuestAccess api={{
      provePassword: vi.fn(async () => ({ status: 'password_invalid' as const })),
    } as unknown as RemoteDesktopAccessApi} />);
    fireEvent.input(screen.getByLabelText(/public_id/), { target: { value: '5123456789' } });
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    expect(await screen.findByText('remote_desktop.guest.state_password_invalid')).toBeTruthy();
    cleanup();

    render(<RemoteDesktopGuestAccess api={{
      provePassword: vi.fn(async () => ({ status: 'device_offline' as const })),
    } as unknown as RemoteDesktopAccessApi} />);
    fireEvent.input(screen.getByLabelText(/public_id/), { target: { value: '5123456789' } });
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    expect(await screen.findByText('remote_desktop.guest.state_device_offline')).toBeTruthy();
  });

  it('prompts anonymous invite users to sign in or register and resumes from the scrubbed same-origin history state', async () => {
    window.history.replaceState({}, '', '/#invite=hidden-before-bootstrap');
    const resolveInvite = vi.fn(async () => ({ status: 'auth_required' as const }));
    const first = render(<RemoteDesktopGuestAccess
      bootstrap={Promise.resolve({ status: 'invite', token: 'D'.repeat(43) })}
      api={{ resolveInvite } as unknown as RemoteDesktopAccessApi}
    />);

    expect(await screen.findByText('remote_desktop.guest.state_auth_required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'remote_desktop.guest.sign_in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'remote_desktop.guest.register' })).toBeTruthy();
    expect(window.location.pathname).toBe('/remote-desktop/access');
    expect(window.location.hash).toBe('');
    const tokenHash = (window.history.state as Record<string, unknown>)[REMOTE_DESKTOP_INVITE_HISTORY_STATE_KEY];
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(window.history.state)).not.toContain('D'.repeat(43));

    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.sign_in' }));
    expect(await screen.findByText('login.subtitle')).toBeTruthy();
    expect(screen.queryByText('login.github_signin')).toBeNull();
    first.unmount();

    const resumed = vi.fn(async () => ({ status: 'unavailable' as const }));
    render(<RemoteDesktopGuestAccess
      bootstrap={Promise.resolve({ status: 'resume', tokenHash: String(tokenHash) })}
      api={{ resolveInvite: resumed } as unknown as RemoteDesktopAccessApi}
    />);
    await waitFor(() => expect(resumed).toHaveBeenCalledOnce());
    expect(resumed.mock.calls[0]![0].token).toBe('D'.repeat(43));
  });

  it('preserves only the public ID across password login and never persists the password', async () => {
    window.history.replaceState({}, '', '/remote-desktop/access');
    const first = render(<RemoteDesktopGuestAccess api={{
      provePassword: vi.fn(async () => ({ status: 'auth_required' as const })),
    } as unknown as RemoteDesktopAccessApi} />);
    fireEvent.input(screen.getByLabelText(/public_id/), { target: { value: '5123456789' } });
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    expect(await screen.findByText('remote_desktop.guest.state_auth_required')).toBeTruthy();
    expect((window.history.state as Record<string, unknown>)[REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY])
      .toBe('5123456789');
    expect(JSON.stringify(window.history.state)).not.toContain('secret-password');
    first.unmount();

    render(<RemoteDesktopGuestAccess api={{
      provePassword: vi.fn(async () => ({ status: 'password_invalid' as const })),
    } as unknown as RemoteDesktopAccessApi} />);
    expect((screen.getByLabelText(/public_id/) as HTMLInputElement).value).toBe('5123456789');
    expect((screen.getByLabelText(/password/) as HTMLInputElement).value).toBe('');
  });

  it('offers save only after a node-password proof and sends the short-lived proof binding', async () => {
    const browserKey = await generateRemoteDesktopBrowserKeyPair();
    const provePassword = vi.fn(async () => ({
      status: 'ready' as const,
      hostId: 'host-1',
      serverId: 'server-1',
      bootstrapTicket: 'B'.repeat(43),
      expiresAt: Date.now() + 30_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
      browserKey,
    }));
    const saveDevice = vi.fn(async () => ({ id: 'saved-1', publicNodeId: '5123456789', displayName: '5123456789', savedAt: Date.now() }));
    const starter: RemoteDesktopGuestSessionStarter = { start: vi.fn(async () => ({ stop: vi.fn() })) };
    render(<RemoteDesktopGuestAccess api={{ provePassword, saveDevice } as unknown as RemoteDesktopAccessApi} sessionStarter={starter} />);
    fireEvent.input(screen.getByLabelText(/public_id/), { target: { value: '5123456789' } });
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    const save = await screen.findByRole('button', { name: 'remote_desktop.guest.save_device' });
    expect(document.body.textContent).not.toContain('server-1');
    expect(document.body.textContent).not.toContain('host-1');
    expect(document.body.innerHTML).not.toContain('B'.repeat(43));
    expect(document.body.innerHTML).not.toContain(browserKey.thumbprint);
    fireEvent.click(save);
    await waitFor(() => expect(saveDevice).toHaveBeenCalledWith({
      publicNodeId: '5123456789',
      bootstrapTicket: 'B'.repeat(43),
      browserKeyThumbprint: browserKey.thumbprint,
    }));
    expect(screen.queryByRole('button', { name: 'remote_desktop.guest.save_device' })).toBeNull();
  });

  it('supports embedded in-app overlay mode without mutating URL/history and supports authMode round-trips', async () => {
    window.history.replaceState({ keep: true }, '', '/?foo=1');
    const onExit = vi.fn();
    const inviteView = render(
      <RemoteDesktopGuestAccess
        standalone={false}
        zIndex={20000}
        bootstrap={Promise.resolve({ status: 'invite', token: 'E'.repeat(43) })}
        api={{
          resolveInvite: vi.fn(async () => ({ status: 'auth_required' as const })),
        } as unknown as RemoteDesktopAccessApi}
        onExit={onExit}
      />,
    );

    const overlay = inviteView.container.querySelector('.remote-desktop-guest-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.zIndex).toBe('20000');

    expect(await screen.findByText('remote_desktop.guest.state_auth_required')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?foo=1');
    expect(window.history.state).toEqual({ keep: true });

    // Enter login authMode and navigate back to guest card cleanly.
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.sign_in' }));
    expect(await screen.findByText('login.subtitle')).toBeTruthy();
    expect(inviteView.container.querySelector('.remote-desktop-guest-overlay')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /back_to_invitation/ }));
    expect(await screen.findByText('remote_desktop.guest.state_auth_required')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.back_to_imcodes' }));
    expect(onExit).toHaveBeenCalledOnce();
    inviteView.unmount();

    // Password (Connect by ID) flow in embedded mode keeps prefilled publicNodeId and returns to idle on try_again.
    const provePassword = vi.fn(async () => ({ status: 'auth_required' as const }));
    render(
      <RemoteDesktopGuestAccess
        standalone={false}
        initialPublicNodeId="5987654321"
        api={{ provePassword } as unknown as RemoteDesktopAccessApi}
        onExit={onExit}
      />,
    );
    const idInput = screen.getByLabelText(/public_id/) as HTMLInputElement;
    expect(idInput.value).toBe('5987654321');
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    expect(await screen.findByText('remote_desktop.guest.state_auth_required')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
    expect(window.history.state).toEqual({ keep: true });

    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.try_again' }));
    expect((screen.getByLabelText(/public_id/) as HTMLInputElement).value).toBe('5987654321');
    expect(window.location.pathname).toBe('/');
  });

  it('ignores non-matching initialPublicNodeId and host URL search in embedded mode', () => {
    window.history.replaceState({ [REMOTE_DESKTOP_PUBLIC_ID_HISTORY_STATE_KEY]: '5111111111' }, '', '/?publicId=5222222222');
    render(<RemoteDesktopGuestAccess standalone={false} initialPublicNodeId="invalid" />);
    const idInput = screen.getByLabelText(/public_id/) as HTMLInputElement;
    expect(idInput.value).toBe('');
    expect(window.location.pathname).toBe('/');
  });

  it('completes real LoginPage auth in embedded mode without reload/navigation, preserves overlay and publicNodeId, and forwards native serverUrl/onLoginSuccess', async () => {
    window.history.replaceState({ keep: true }, '', '/?server=s1');
    const reload = vi.fn();
    vi.stubGlobal('location', {
      ...window.location,
      reload,
      assign: vi.fn(),
      replace: vi.fn(),
      href: window.location.href,
    } as Partial<Location>);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/auth/password/login')) {
        return new Response(JSON.stringify({ ok: true, apiKey: 'native-key-1', userId: 'user-42', keyId: 'kid-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const onWebLogin = vi.fn();
    const provePassword = vi.fn(async () => ({ status: 'auth_required' as const }));
    const view = render(
      <RemoteDesktopGuestAccess
        standalone={false}
        initialPublicNodeId="5987654321"
        serverUrl="https://app.im.codes"
        onWebLogin={onWebLogin}
        api={{ provePassword } as unknown as RemoteDesktopAccessApi}
        onExit={vi.fn()}
      />,
    );

    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await screen.findByText('remote_desktop.guest.state_auth_required');

    // Web login inside embedded overlay completes without window.location.reload()
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.sign_in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'Passw0rd1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => expect(onWebLogin).toHaveBeenCalledTimes(1));
    expect(reload).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?server=s1');
    expect(window.history.state).toEqual({ keep: true });
    expect(view.container.querySelector('.remote-desktop-guest-overlay')).toBeTruthy();
    expect((await screen.findByLabelText(/public_id/) as HTMLInputElement).value).toBe('5987654321');
    view.unmount();

    // Native embedded login forwards serverUrl and invokes onLoginSuccess(userId, serverUrl)
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const onLoginSuccess = vi.fn();
    const nativeView = render(
      <RemoteDesktopGuestAccess
        standalone={false}
        initialPublicNodeId="5987654321"
        serverUrl="https://custom.im.codes"
        onLoginSuccess={onLoginSuccess}
        api={{ provePassword } as unknown as RemoteDesktopAccessApi}
        onExit={vi.fn()}
      />,
    );
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await screen.findByText('remote_desktop.guest.state_auth_required');
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.sign_in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'Passw0rd1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));

    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith('user-42', 'https://custom.im.codes', undefined));
    expect(reload).not.toHaveBeenCalled();
    expect((await screen.findByLabelText(/public_id/) as HTMLInputElement).value).toBe('5987654321');
    nativeView.unmount();

    // Standalone /remote-desktop/access retains its reload-on-login behavior
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    const standaloneView = render(
      <RemoteDesktopGuestAccess
        api={{ provePassword } as unknown as RemoteDesktopAccessApi}
      />,
    );
    fireEvent.input(screen.getByLabelText(/public_id/), { target: { value: '5123456789' } });
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await screen.findByText('remote_desktop.guest.state_auth_required');
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.sign_in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'login.password_signin' }));
    fireEvent.input(screen.getByPlaceholderText('login.username_placeholder'), { target: { value: 'alice' } });
    fireEvent.input(screen.getByPlaceholderText('login.password_placeholder'), { target: { value: 'Passw0rd1!' } });
    fireEvent.click(screen.getByRole('button', { name: 'login.signin' }));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    standaloneView.unmount();
  });

  it('stops a deferred sessionStarter.start handle on unmount, retry re-entry, and stops resolved handle exactly once', async () => {
    const browserKey = await generateRemoteDesktopBrowserKeyPair();
    const readyResponse = {
      status: 'ready' as const,
      hostId: 'host-1',
      serverId: 'server-1',
      bootstrapTicket: 'C'.repeat(43),
      expiresAt: Date.now() + 30_000,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.NODE_PASSWORD,
      browserKey,
    };

    // 1. Unmount while sessionStarter.start is still pending -> late resolve must stop with GUEST_UNMOUNT
    let resolveDeferredStart!: (handle: { stop(origin: typeof REMOTE_DESKTOP_STOP_ORIGIN[keyof typeof REMOTE_DESKTOP_STOP_ORIGIN]): void }) => void;
    const deferredStop = vi.fn();
    const deferredStarter: RemoteDesktopGuestSessionStarter = {
      start: vi.fn(() => new Promise((resolve) => { resolveDeferredStart = resolve; })),
    };
    let onExitCalled = false;
    const deferredView = render(
      <RemoteDesktopGuestAccess
        standalone={false}
        initialPublicNodeId="5123456789"
        api={{ provePassword: vi.fn(async () => readyResponse) } as unknown as RemoteDesktopAccessApi}
        sessionStarter={deferredStarter}
        onExit={() => {
          onExitCalled = true;
          deferredView.unmount();
        }}
      />,
    );
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await waitFor(() => expect(deferredStarter.start).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.guest.back_to_imcodes' }));
    expect(onExitCalled).toBe(true);
    resolveDeferredStart({ stop: deferredStop });
    await waitFor(() => expect(deferredStop).toHaveBeenCalledTimes(1));
    expect(deferredStop).toHaveBeenCalledWith(REMOTE_DESKTOP_STOP_ORIGIN.GUEST_UNMOUNT);

    // 2. Retry while sessionStarter.start is pending -> stale resolve stops with GUEST_RETRY and ignores stale state/snapshots
    let resolveAttempt1!: (handle: { stop(origin: typeof REMOTE_DESKTOP_STOP_ORIGIN[keyof typeof REMOTE_DESKTOP_STOP_ORIGIN]): void }) => void;
    let onState1!: (next: 'waiting_for_consent' | 'timeout' | 'connected') => void;
    let onSnapshot1!: (snap: { stream: MediaStream | null }) => void;
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    let callCount = 0;
    const retryStarter: RemoteDesktopGuestSessionStarter = {
      start: vi.fn((params, onState) => {
        callCount += 1;
        if (callCount === 1) {
          onState1 = onState;
          onSnapshot1 = params.onSnapshot;
          return new Promise((resolve) => { resolveAttempt1 = resolve; });
        }
        return Promise.resolve({ stop: stop2 });
      }),
    };
    const retryView = render(
      <RemoteDesktopGuestAccess
        standalone={false}
        initialPublicNodeId="5123456789"
        api={{ provePassword: vi.fn(async () => readyResponse) } as unknown as RemoteDesktopAccessApi}
        sessionStarter={retryStarter}
        onExit={() => retryView.unmount()}
      />,
    );
    fireEvent.input(screen.getByLabelText(/password/), { target: { value: 'secret-password' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await waitFor(() => expect(retryStarter.start).toHaveBeenCalledTimes(1));

    // Allow try_again while attempt 1 is still pending start
    onState1('timeout');
    fireEvent.click(await screen.findByRole('button', { name: 'remote_desktop.guest.try_again' }));
    fireEvent.input(await screen.findByLabelText(/password/), { target: { value: 'secret-password-2' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/ }));
    await waitFor(() => expect(retryStarter.start).toHaveBeenCalledTimes(2));

    resolveAttempt1({ stop: stop1 });
    await waitFor(() => expect(stop1).toHaveBeenCalledTimes(1));
    expect(stop1).toHaveBeenCalledWith(REMOTE_DESKTOP_STOP_ORIGIN.GUEST_RETRY);
    onState1('waiting_for_consent');
    onSnapshot1({ stream: null });
    expect(stop2).not.toHaveBeenCalled();

    // 3. Normal unmount of the resolved active connection stops exactly once with GUEST_UNMOUNT
    retryView.unmount();
    expect(stop2).toHaveBeenCalledTimes(1);
    expect(stop2).toHaveBeenCalledWith(REMOTE_DESKTOP_STOP_ORIGIN.GUEST_UNMOUNT);
  });
});
