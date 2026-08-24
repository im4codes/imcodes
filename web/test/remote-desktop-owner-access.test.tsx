/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_LINK_KIND } from '../../shared/remote-desktop-access.js';
import { RemoteDesktopOwnerAccess } from '../src/components/RemoteDesktopOwnerAccess.js';
import type { RemoteDesktopAccessApi, RemoteDesktopOwnerLinkView, RemoteDesktopPrivacyCoordinator } from '../src/api/remote-desktop-access.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key}:${Object.values(values).join(':')}` : key }) }));

const link: RemoteDesktopOwnerLinkView = {
  id: 'link-1', hostId: 'host-1', label: 'Ops', kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED,
  mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL, expiresAt: Date.now() + 3600_000,
  authorityGeneration: 1, expiryRevision: 1, commitRevision: 1, state: 'active', claimed: false, createdAt: Date.now(),
  connectionAudit: {
    connectionCount: 2,
    totalDurationMs: 5_400_000,
    lastConnectedAt: Date.now() - 3_600_000,
    recentConnections: [{
      ipAddress: '203.0.113.42',
      connectedAt: Date.now() - 3_600_000,
      disconnectedAt: Date.now() - 1_800_000,
      durationMs: 1_800_000,
    }],
  },
};

function api(overrides: Partial<RemoteDesktopAccessApi> = {}): RemoteDesktopAccessApi {
  return {
    loadHost: vi.fn(async () => ({ hostId: 'host-1', publicNodeId: '5123456789', mergeState: 'resolved' as const })),
    rotateHost: vi.fn(async () => ({ hostId: 'host-1', publicNodeId: '5987654321', mergeState: 'resolved' as const })),
    listLinks: vi.fn(async () => [link]),
    createLink: vi.fn(async () => ({ ...link, id: 'link-2', label: 'New' })),
    mutateLink: vi.fn(async () => link),
    revokeLink: vi.fn(async () => ({ ...link, state: 'revoked' })),
    mutatePassword: vi.fn(async () => ({ hostId: 'host-1', generation: 2, state: 'enabled' as const, effectsEmitted: 0 })),
    beginStepUp: vi.fn(async () => ({ challengeId: 'challenge-id', challenge: 'AAAA' })),
    completeStepUp: vi.fn(async () => ({ stepUpGrant: 'grant' })),
    beginPrivacy: vi.fn(async () => ({ epochId: 'unused', revision: 1 })),
    endPrivacy: vi.fn(async () => undefined),
    resolveInvite: vi.fn(),
    provePassword: vi.fn(),
    ...overrides,
  } as RemoteDesktopAccessApi;
}

function privacy(overrides: Partial<RemoteDesktopPrivacyCoordinator> = {}): RemoteDesktopPrivacyCoordinator {
  return {
    begin: vi.fn(async () => ({ epochId: 'epoch-1', revision: 1 })),
    end: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { get: vi.fn(async () => ({ id: 'cred-1', type: 'public-key', toJSON: () => ({ id: 'cred-1' }) })) },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RemoteDesktopOwnerAccess', () => {
  it('displays and copies the public ID without rendering internal server IDs', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
    render(<RemoteDesktopOwnerAccess hostId="host-1" api={api()} privacy={privacy()} />);
    expect(await screen.findByText('5123456789')).toBeTruthy();
    expect(document.body.textContent).not.toContain('srv-secret');
    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('5123456789');
  });

  it('shows bounded per-link connection count, duration and source IP audit', async () => {
    render(<RemoteDesktopOwnerAccess hostId="host-1" api={api()} privacy={privacy()} />);
    expect(await screen.findByText('203.0.113.42')).toBeTruthy();
    expect(document.body.textContent).toContain('remote_desktop.access_audit_connections:2');
    expect(document.body.textContent).toContain('remote_desktop.access_audit_total_duration');
    expect(document.body.textContent).not.toContain('sessionId');
  });

  it('requires privacy and action-bound step-up before creating a link, then shows the raw invite once', async () => {
    const fake = api();
    const guard = privacy();
    render(<RemoteDesktopOwnerAccess hostId="host-1" api={fake} privacy={guard} />);
    await screen.findByText('Ops');
    fireEvent.input(screen.getByLabelText('remote_desktop.access_link_label'), { target: { value: 'New label' } });
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.access_create_link' }));
    await screen.findByLabelText('remote_desktop.access_secret_value');
    expect(guard.begin).toHaveBeenCalledWith('host-1');
    expect(fake.beginStepUp).toHaveBeenCalledWith(expect.objectContaining({ canonicalHostId: 'host-1', action: expect.objectContaining({ kind: 'remote_desktop.link.create' }) }));
    expect(fake.createLink).toHaveBeenCalledWith(expect.objectContaining({ prepared: expect.objectContaining({ inviteUrl: expect.stringContaining('#invite=v1.') }), stepUpGrant: 'grant' }));
    expect((screen.getByLabelText('remote_desktop.access_secret_value') as HTMLInputElement).value).toContain('#invite=v1.');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('remote_desktop.access_secret_value')).toBeNull());
    expect(guard.end).toHaveBeenCalledWith('host-1', { epochId: 'epoch-1', revision: 1 });
  });

  it('fails closed when privacy cannot be established and clears passwords after mutation', async () => {
    const blocked = api();
    const blockedPrivacy = privacy({ begin: vi.fn(async () => { throw new Error('privacy_required'); }) });
    render(<RemoteDesktopOwnerAccess hostId="host-1" api={blocked} privacy={blockedPrivacy} />);
    await screen.findByText('Ops');
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.access_create_link' }));
    await screen.findByRole('alert');
    expect(blocked.createLink).not.toHaveBeenCalled();
    cleanup();

    const ok = api();
    render(<RemoteDesktopOwnerAccess hostId="host-1" api={ok} privacy={privacy()} />);
    await screen.findByText('Ops');
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.access_password_set' }));
    const password = await screen.findByLabelText('remote_desktop.access_password_value') as HTMLInputElement;
    fireEvent.input(password, { target: { value: 'never-echo-this' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(ok.mutatePassword).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent).not.toContain('never-echo-this'));
  });

  it('blocks further mutations when privacy release requires recovery', async () => {
    const guard = privacy({ end: vi.fn(async () => { throw new Error('recovery_required'); }) });
    render(<RemoteDesktopOwnerAccess hostId="host-1" api={api()} privacy={guard} />);
    await screen.findByText('Ops');
    fireEvent.click(screen.getByRole('button', { name: 'remote_desktop.access_create_link' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(await screen.findByText('remote_desktop.access_privacy_recovery')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'remote_desktop.access_create_link' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'remote_desktop.access_password_set' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
