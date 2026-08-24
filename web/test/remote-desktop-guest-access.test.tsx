/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_ACTOR_SOURCE } from '../../shared/remote-desktop-access.js';
import { RemoteDesktopGuestAccess } from '../src/components/RemoteDesktopGuestAccess.js';
import { generateRemoteDesktopBrowserKeyPair } from '../src/remote-desktop-access-crypto.js';
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
    const starter: RemoteDesktopGuestSessionStarter = { start: vi.fn(async () => ({ stop: vi.fn() })) };
    render(<RemoteDesktopGuestAccess bootstrap={Promise.resolve({ status: 'invite', token: 'A'.repeat(43) })} api={{
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

    expect(await screen.findByText(/state_unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try_again/ }));
    expect(await screen.findByText(/waiting_for_consent/)).toBeTruthy();
    expect(resolveInvite).toHaveBeenCalledTimes(2);
    expect(calls[0].token).toBe('B'.repeat(43));
    expect(calls[1].token).toBe(calls[0].token);
    expect(calls[1].browserKey).toBe(calls[0].browserKey);
    expect(calls[0].browserKey.privateKey.extractable).toBe(false);
  });
});
