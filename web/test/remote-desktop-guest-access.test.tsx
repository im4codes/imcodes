/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('RemoteDesktopGuestAccess', () => {
  it('moves a resolved scrubbed invite into attended waiting without rendering serverId or desktop controls', async () => {
    const starter: RemoteDesktopGuestSessionStarter = { start: vi.fn(async () => ({ stop: vi.fn() })) };
    render(<RemoteDesktopGuestAccess bootstrap={Promise.resolve({ status: 'invite', token: 'raw-token' })} api={{
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
});
