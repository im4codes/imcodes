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

afterEach(() => cleanup());
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
});
