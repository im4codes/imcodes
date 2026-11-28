/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { h } from 'preact';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/preact';

const apiMocks = vi.hoisted(() => ({
  listSharesForTarget: vi.fn(),
  createShare: vi.fn(),
  updateShare: vi.fn(),
  revokeShare: vi.fn(),
  getMyServerPrivateDevicePolicy: vi.fn(),
  updateMyServerPrivateDevicePolicy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'share.warning.device') {
        return 'High-risk machine collaboration notice: Real-time collaboration on this computer/server is equivalent to Remote Desktop & terminal access with no OS sandbox. Never collaborate on a personal device containing private data — use only dedicated development machines or shared servers.';
      }
      if (key === 'share.warning.session') {
        return "High-risk collaboration notice: Real-time collaboration lets participants run Shell commands, edit files, and use tools directly in this machine's environment with no OS sandbox. Never use on a personal computer with private data — only dedicated dev machines or shared servers.";
      }
      if (key === 'share.target.server') return 'Whole server';
      if (key === 'share.target.currentTab') return 'Current session tab';
      if (key === 'share.role.viewer') return 'Viewer';
      if (key === 'share.role.participant') return 'Participant';
      if (!vars) return key;
      const suffix = Object.entries(vars)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      return `${key}(${suffix})`;
    },
  }),
}));

vi.mock('../../src/components/RemoteDesktopOwnerAccess.js', () => ({
  RemoteDesktopOwnerAccess: () => <div data-testid="remote-desktop-owner-access">Remote Desktop Content</div>,
}));

vi.mock('../../src/api.js', () => ({
  listSharesForTarget: apiMocks.listSharesForTarget,
  createShare: apiMocks.createShare,
  updateShare: apiMocks.updateShare,
  revokeShare: apiMocks.revokeShare,
  getMyServerPrivateDevicePolicy: apiMocks.getMyServerPrivateDevicePolicy,
  updateMyServerPrivateDevicePolicy: apiMocks.updateMyServerPrivateDevicePolicy,
  ApiError: class ApiError extends Error {
    body?: string;
    constructor(body?: string) {
      super(body);
      this.body = body;
    }
  },
}));

import { ShareSessionDialog } from '../../src/components/ShareSessionDialog.js';
import type { ShareDialogTarget } from '../../src/tab-sharing-ui.js';

describe('ShareSessionDialog security warnings', () => {
  const defaultTarget: ShareDialogTarget = {
    serverId: 'srv-1',
    serverLabel: 'Dev Machine Alpha',
    sessionName: 'main-session',
    tabLabel: 'Bash tab 1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listSharesForTarget.mockResolvedValue([]);
    apiMocks.getMyServerPrivateDevicePolicy.mockResolvedValue({ ok: true, serverId: 'srv-1', blockPrivateDevices: false });
    apiMocks.updateMyServerPrivateDevicePolicy.mockImplementation(async (serverId: string, blockPrivateDevices: boolean) => ({
      ok: true,
      serverId,
      blockPrivateDevices,
    }));
  });

  afterEach(() => {
    cleanup();
  });

  it('renders prominent device security warning for controlled node machine sharing across account and remote desktop tabs', async () => {
    render(
      <ShareSessionDialog
        variant="machine"
        fixedTarget={{ kind: 'server', serverId: 'srv-1' }}
        target={defaultTarget}
        remoteDesktopAccess={{ hostId: 'host-123', endpointLabel: 'Dev Machine Alpha' }}
        initialMachineSection="account"
        onClose={vi.fn()}
      />
    );

    const warning = screen.getByTestId('share-security-warning');
    expect(warning).toBeTruthy();
    expect(warning.getAttribute('role')).toBe('note');
    expect(warning.textContent).toContain('High-risk machine collaboration notice: Real-time collaboration on this computer/server is equivalent to Remote Desktop');

    // Switch to Remote Desktop tab
    const rdpTab = screen.getByRole('tab', { name: 'controlled_nodes.share.remote_desktop_tab' });
    fireEvent.click(rdpTab);

    // Warning banner should still be present on Remote Desktop tab
    const warningAfterTabSwitch = screen.getByTestId('share-security-warning');
    expect(warningAfterTabSwitch).toBeTruthy();
    expect(warningAfterTabSwitch.textContent).toContain('High-risk machine collaboration notice: Real-time collaboration on this computer/server is equivalent to Remote Desktop');
    expect(screen.getByTestId('remote-desktop-owner-access')).toBeTruthy();
  });

  it('renders session security warning for default session sharing and dynamically switches to device warning on whole-server choice', async () => {
    render(
      <ShareSessionDialog
        variant="session"
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );

    const warning = screen.getByTestId('share-security-warning');
    expect(warning).toBeTruthy();
    // Default choice is current-tab -> session warning
    expect(warning.textContent).toContain('High-risk collaboration notice: Real-time collaboration lets participants run Shell commands');

    // Toggle radio to Whole server
    const serverRadio = screen.getByRole('radio', { name: 'Whole server' });
    fireEvent.click(serverRadio);

    // Should dynamically switch to device warning
    expect(warning.textContent).toContain('High-risk machine collaboration notice: Real-time collaboration on this computer/server is equivalent to Remote Desktop');

    // Toggle back to Current session tab
    const tabRadio = screen.getByRole('radio', { name: 'Current session tab' });
    fireEvent.click(tabRadio);

    // Should switch back to session warning
    expect(warning.textContent).toContain('High-risk collaboration notice: Real-time collaboration lets participants run Shell commands');
  });

  it('renders device warning when fixedTarget is a whole server', () => {
    render(
      <ShareSessionDialog
        variant="session"
        fixedTarget={{ kind: 'server', serverId: 'srv-1' }}
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );

    const warning = screen.getByTestId('share-security-warning');
    expect(warning).toBeTruthy();
    expect(warning.textContent).toContain('High-risk machine collaboration notice: Real-time collaboration on this computer/server is equivalent to Remote Desktop');
  });

  it('renders session warning when fixedTarget is a tab session', () => {
    render(
      <ShareSessionDialog
        variant="session"
        fixedTarget={{ kind: 'session', serverId: 'srv-1', sessionName: 'session-1' }}
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );

    const warning = screen.getByTestId('share-security-warning');
    expect(warning).toBeTruthy();
    expect(warning.textContent).toContain('High-risk collaboration notice: Real-time collaboration lets participants run Shell commands');
  });

  it('escalates warning styling, renders trust disclosure, and switches roleHelp by selected target scope when Participant role is selected', () => {
    const { container } = render(
      <ShareSessionDialog
        variant="session"
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );

    const warning = screen.getByTestId('share-security-warning');
    expect(warning.classList.contains('is-participant')).toBe(false);
    expect(container.querySelector('.share-trust-disclosure')).toBeNull();
    expect(container.querySelector('.share-help')?.textContent).toBe('share.roleHelp.viewer');

    fireEvent.click(screen.getByRole('radio', { name: 'Participant' }));
    expect(warning.classList.contains('is-participant')).toBe(true);
    const disclosure = container.querySelector('.share-trust-disclosure');
    expect(disclosure).toBeTruthy();
    expect(disclosure?.textContent).toContain('share.trust.title');
    expect(disclosure?.textContent).toContain('share.trust.body');
    expect(container.querySelector('.share-help')?.textContent).toBe('share.roleHelp.participant');

    fireEvent.click(screen.getByRole('radio', { name: 'Whole server' }));
    expect(container.querySelector('.share-help')?.textContent).toBe('share.roleHelp.serverParticipant');

    fireEvent.click(screen.getByRole('radio', { name: 'Viewer' }));
    expect(container.querySelector('.share-help')?.textContent).toBe('share.roleHelp.viewer');

    fireEvent.click(screen.getByRole('radio', { name: 'Participant' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Current session tab' }));
    expect(container.querySelector('.share-help')?.textContent).toBe('share.roleHelp.participant');
  });

  it('uses whole-server participant roleHelp when fixedTarget is a server and preserves machine role_help on machine variant', () => {
    const serverSessionView = render(
      <ShareSessionDialog
        variant="session"
        fixedTarget={{ kind: 'server', serverId: 'srv-1' }}
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Participant' }));
    expect(serverSessionView.container.querySelector('.share-help')?.textContent).toBe('share.roleHelp.serverParticipant');
    serverSessionView.unmount();

    const machineView = render(
      <ShareSessionDialog
        variant="machine"
        fixedTarget={{ kind: 'server', serverId: 'srv-1' }}
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Participant' }));
    expect(machineView.container.querySelector('.share-help')?.textContent).toBe('controlled_nodes.share.role_help.participant');
  });

  it('structures header, warning, panel, and actions with proper layout classes to support fixed actions', () => {
    const { container } = render(
      <ShareSessionDialog
        variant="session"
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );

    const dialog = container.querySelector('.share-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog?.querySelector('.share-dialog-header')).toBeTruthy();
    expect(dialog?.querySelector('.share-security-warning')).toBeTruthy();
    expect(dialog?.querySelector('.share-dialog-panel')).toBeTruthy();
    expect(dialog?.querySelector('.ask-actions')).toBeTruthy();
  });

  it('hydrates and toggles Owner self-protection blockPrivateDevices for session variant and omits it for passive machine variant', async () => {
    apiMocks.getMyServerPrivateDevicePolicy.mockResolvedValue({
      ok: true,
      serverId: 'srv-1',
      blockPrivateDevices: true,
    });
    const sessionView = render(
      <ShareSessionDialog
        variant="session"
        target={defaultTarget}
        onClose={vi.fn()}
      />
    );

    const toggle = screen.getByTestId('share-private-device-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    fireEvent.click(checkbox);
    await waitFor(() => {
      expect(apiMocks.updateMyServerPrivateDevicePolicy).toHaveBeenCalledWith('srv-1', false);
    });
    expect(checkbox.checked).toBe(false);
    sessionView.unmount();

    render(
      <ShareSessionDialog
        variant="machine"
        fixedTarget={{ kind: 'server', serverId: 'ctl-1' }}
        target={{ ...defaultTarget, serverId: 'ctl-1' }}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByTestId('share-private-device-toggle')).toBeNull();
  });
});
