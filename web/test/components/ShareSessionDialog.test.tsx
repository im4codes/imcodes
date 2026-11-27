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
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'share.warning.device') {
        return 'Security notice: Sharing this device grants full device permissions. Do not share devices containing private data — use only for shared development machines or similar non-private devices.';
      }
      if (key === 'share.warning.session') {
        return "Security notice: Sharing a session lets collaborators interact with this device's environment. Do not share sessions on devices containing private data — use only for shared development machines or similar non-private devices.";
      }
      if (key === 'share.target.server') return 'Whole server';
      if (key === 'share.target.currentTab') return 'Current session tab';
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
    expect(warning.textContent).toContain('Security notice: Sharing this device grants full device permissions');

    // Switch to Remote Desktop tab
    const rdpTab = screen.getByRole('tab', { name: 'controlled_nodes.share.remote_desktop_tab' });
    fireEvent.click(rdpTab);

    // Warning banner should still be present on Remote Desktop tab
    const warningAfterTabSwitch = screen.getByTestId('share-security-warning');
    expect(warningAfterTabSwitch).toBeTruthy();
    expect(warningAfterTabSwitch.textContent).toContain('Security notice: Sharing this device grants full device permissions');
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
    expect(warning.textContent).toContain("Security notice: Sharing a session lets collaborators interact with this device's environment");

    // Toggle radio to Whole server
    const serverRadio = screen.getByRole('radio', { name: 'Whole server' });
    fireEvent.click(serverRadio);

    // Should dynamically switch to device warning
    expect(warning.textContent).toContain('Security notice: Sharing this device grants full device permissions');

    // Toggle back to Current session tab
    const tabRadio = screen.getByRole('radio', { name: 'Current session tab' });
    fireEvent.click(tabRadio);

    // Should switch back to session warning
    expect(warning.textContent).toContain("Security notice: Sharing a session lets collaborators interact with this device's environment");
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
    expect(warning.textContent).toContain('Security notice: Sharing this device grants full device permissions');
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
    expect(warning.textContent).toContain("Security notice: Sharing a session lets collaborators interact with this device's environment");
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
});
