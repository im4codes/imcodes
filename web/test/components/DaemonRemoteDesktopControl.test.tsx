/**
 * @vitest-environment jsdom
 *
 * The daemon's own machine has no entry in the controlled-machine list, so this
 * control derives everything from the capabilities the daemon advertises in
 * `daemon.hello`. What is pinned here is the distinction that makes the button
 * honest: `installable` means "this Windows host could serve remote control",
 * the capability itself means "the verified worker is installed". A host that
 * advertises neither must render nothing rather than a button that will fail.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, act, fireEvent, screen, waitFor } from '@testing-library/preact';

const mintTicket = vi.fn(async () => ({ ticket: 'ticket_minted_value' }));
const setHostServer = vi.fn(async () => undefined);
const requestPermissions = vi.fn(async () => undefined);
const listAvailable = vi.fn(async () => ({ available: [], artifacts: [] as unknown[] }));
const createInstallCommand = vi.fn(async () => ({ command: 'curl … | sudo sh', expiresAt: 1, ticketId: 't' }));
const mintInstallCommand = vi.fn(async () => ({
  command: 'curl … | sudo sh', installCode: 'ABCDEFGHJKMN', expiresAt: 1, ticketId: 't',
}));
const refetch = vi.fn(async () => null);
/**
 * One mintable Desk, auto-selected. Before R5 this call passed `serverId` where
 * the Desk now sits; both are strings, so TypeScript could not catch it. The
 * assertion below therefore pins the exact argument ORDER, not just presence.
 */
const TEST_DESK = { id: 'desk-1', name: 'Ops Desk', role: 'owner' as const };
const listMintableDesks = vi.fn(async () => [TEST_DESK]);
vi.mock('../../src/api.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  listMintableDesks: () => listMintableDesks(),
  createControlledNodeInstallCommand: (...args: unknown[]) => createInstallCommand(...args as []),
}));
vi.mock('../../src/api/machines.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  mintControlledNodeExecutableTicket: (...args: unknown[]) => mintTicket(...args as []),
  mintControlledNodeInstallCommand: (...args: unknown[]) => mintInstallCommand(...args as []),
  setMachineHostServer: (...args: unknown[]) => setHostServer(...args as []),
  requestMachineRemoteDesktopPermissions: (...args: unknown[]) => requestPermissions(...args as []),
  listAvailableExecutables: () => listAvailable(),
}));
// Every test supplies `machines`, so the shared list is only the refetch seam.
vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({ machines: [], refetch }),
}));
// jsdom has no clipboard; the component's contract is only that it asks.
vi.mock('../../src/util/clipboard.js', () => ({
  copyToClipboardWhenReady: (pending: Promise<string>, onSuccess: () => void) => {
    void pending.then(() => onSuccess());
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Returns the key so assertions read as "which string was chosen"; every
    // key asserted below exists in all locale files.
    t: (key: string) => key,
  }),
}));

const { REMOTE_DESKTOP_CAPABILITY } = await import('@shared/remote-desktop.js');
const {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_INSTALL_STATE,
  REMOTE_DESKTOP_INSTALL_ERROR,
} = await import('@shared/remote-desktop-install.js');
const {
  REMOTE_DESKTOP_LOGIN_SCREEN_MSG,
  REMOTE_DESKTOP_LOGIN_SCREEN_STATE,
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  controlledNodeInstallHereCapability,
} = await import('@shared/remote-desktop-login-screen.js');
const {
  REMOTE_DESKTOP_ENCODER_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} = await import('@shared/remote-desktop-platform.js');
const { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } = await import('@shared/remote-desktop-access.js');
const { DaemonRemoteDesktopControl } = await import('../../src/components/DaemonRemoteDesktopControl.js');

type MessageHandler = (message: Record<string, unknown>) => void;

function wsStub(capabilities: string[]) {
  const messageHandlers = new Set<MessageHandler>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    emit: (message: Record<string, unknown>) => {
      for (const handler of messageHandlers) handler(message);
    },
    client: {
      getDaemonCapabilitySnapshot: () => ({ capabilities }),
      onDaemonCapabilitySnapshot: () => () => {},
      onMessage: (handler: MessageHandler) => {
        messageHandlers.add(handler);
        return () => messageHandlers.delete(handler);
      },
      send: (message: Record<string, unknown>) => { sent.push(message); },
    },
  };
}

function mount(capabilities: string[], overrides: Record<string, unknown> = {}) {
  const ws = wsStub(capabilities);
  const onOpen = vi.fn();
  const view = render(h(DaemonRemoteDesktopControl as never, {
    ws: ws.client as never,
    serverId: 'server_1',
    serverName: 'winbox',
    daemonOnline: true,
    onOpen,
    machines: [],
    ...overrides,
  }));
  return { ...ws, onOpen, view };
}

// These buttons now ask for confirmation before enabling remote desktop
// (window.confirm) -- stub it to "yes" so these tests keep exercising the
// mint/send behavior beyond the prompt, which is what they actually assert.
let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  confirmSpy.mockRestore();
  cleanup();
  vi.clearAllMocks();
});

describe('DaemonRemoteDesktopControl', () => {
  describe('a daemon with no remote desktop of its own (Linux, macOS)', () => {
    // Its remote desktop is the controlled node on the same computer.
    const node = {
      serverId: 'controlled_linux',
      nodeId: '9535523706',
      refName: 'node-211',
      displayName: '211',
      os: 'linux',
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    };

    it('still offers the button, and a click asks for what is missing instead of failing', () => {
      const { view } = mount([]);
      const button = view.container.querySelector('button')!;
      expect(button.getAttribute('title')).toBe('remote_desktop.setup_button_hint');
      fireEvent.click(button);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="daemon-rd-setup-install"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="daemon-rd-setup-link"]')).not.toBeNull();
    });

    it('opens the controlled node linked to this daemon directly', () => {
      const { view, onOpen } = mount([], { machines: [{ ...node, hostServerId: 'server_1' }] });
      const button = view.container.querySelector('button')!;
      expect(button.getAttribute('title')).toBe('remote_desktop.daemon_control_linked');
      fireEvent.click(button);
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'controlled_linux' }));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it('asks a linked Mac that is one permission away for the grant instead of opening it', async () => {
      const mac = {
        ...node,
        serverId: 'controlled_mac',
        os: 'mac',
        hostServerId: 'server_1',
        // Everything but the capture adapter: Screen Recording not granted yet.
        capabilities: [
          REMOTE_DESKTOP_SESSION_CAPABILITY,
          REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
          REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
          REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
        ],
      };
      const { view, onOpen } = mount([], { machines: [mac] });
      fireEvent.click(view.container.querySelector('button')!);
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('remote_desktop.request_permission'));
      await waitFor(() => expect(requestPermissions).toHaveBeenCalledWith('controlled_mac'));
    });

    it('links an already-installed node to this daemon, once, and re-reads the list', async () => {
      const { view } = mount([], { machines: [node] });
      fireEvent.click(view.container.querySelector('button')!);
      const select = document.querySelector('[data-testid="daemon-rd-setup-link"] select') as HTMLSelectElement;
      // A native change, as a browser sends it: testing-library's synthesized
      // change does not reach a listener inside a portal under preact/compat.
      act(() => {
        select.value = 'controlled_linux';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const linkButton = screen.getByText('remote_desktop.setup_link_action') as HTMLButtonElement;
      expect(linkButton.disabled).toBe(false);
      fireEvent.click(linkButton);
      await waitFor(() => expect(setHostServer).toHaveBeenCalledWith('controlled_linux', 'server_1'));
      await waitFor(() => expect(refetch).toHaveBeenCalled());
    });

    it('mints the install command for this daemon, so the new node links itself', async () => {
      listAvailable.mockResolvedValueOnce({
        available: ['linux'],
        artifacts: [{ os: 'linux', arch: 'x64', filename: 'imcodes-node', sizeBytes: 1, sha256: 'a'.repeat(64) }],
      });
      const { view } = mount([]);
      fireEvent.click(view.container.querySelector('button')!);
      fireEvent.click(await screen.findByText('controlled_nodes.copy_install_command'));
      await waitFor(() => expect(createInstallCommand).toHaveBeenCalledWith({ os: 'linux', arch: 'x64' }, 'server_1'));
      // Then says how to run it on that system.
      await screen.findByText('controlled_nodes.usage_linux_command');
    });

    it('installs the controlled node through the daemon after one confirmation', async () => {
      const { view, sent, emit } = mount([controlledNodeInstallHereCapability({ os: 'linux', arch: 'x64' })]);
      fireEvent.click(view.container.querySelector('button')!);
      fireEvent.click(await screen.findByText('remote_desktop.setup_auto_action'));
      // Nothing happens until the owner confirms.
      expect(mintInstallCommand).not.toHaveBeenCalled();
      screen.getByText('remote_desktop.setup_auto_confirm');
      fireEvent.click(screen.getByText('remote_desktop.setup_auto_confirm_action'));

      // Minted for this daemon's own artifact, so the node links itself.
      await waitFor(() => expect(mintInstallCommand).toHaveBeenCalledWith({ os: 'linux', arch: 'x64' }, 'server_1'));
      await waitFor(() => expect(sent).toContainEqual({
        type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
        installCode: 'ABCDEFGHJKMN',
      }));
      await screen.findByText('remote_desktop.setup_auto_downloading');

      act(() => emit({ type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE, state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING }));
      await screen.findByText('remote_desktop.setup_auto_elevating');
      act(() => emit({
        type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE,
        state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
        error: REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ADMIN_REQUIRED,
      }));
      await screen.findByText('remote_desktop.setup_auto_error_admin_required');
      // The copyable command stays right there for that case.
      screen.getByText('remote_desktop.setup_install_heading');
      screen.getByText('remote_desktop.setup_auto_retry');
    });

    it('keeps the copyable command as a fallback when the daemon can install by itself', async () => {
      const { view } = mount([controlledNodeInstallHereCapability({ os: 'linux', arch: 'x64' })]);
      fireEvent.click(view.container.querySelector('button')!);
      await screen.findByText('remote_desktop.setup_auto_action');
      expect(screen.queryByText('remote_desktop.setup_install_heading')).toBeNull();
      fireEvent.click(screen.getByText('remote_desktop.setup_auto_manual'));
      screen.getByText('remote_desktop.setup_install_heading');
    });

    it('after installing a Mac, asks for its permissions without another click', async () => {
      const capabilities = [controlledNodeInstallHereCapability({ os: 'mac', arch: 'universal' })];
      const { view, emit, client } = mount(capabilities);
      fireEvent.click(view.container.querySelector('button')!);
      fireEvent.click(await screen.findByText('remote_desktop.setup_auto_action'));
      fireEvent.click(screen.getByText('remote_desktop.setup_auto_confirm_action'));
      await waitFor(() => expect(mintInstallCommand).toHaveBeenCalledWith({ os: 'mac', arch: 'universal' }, 'server_1'));
      act(() => emit({ type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE, state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.COMPLETED }));
      await screen.findByText('remote_desktop.setup_auto_completed');

      // The node enrols linked to this daemon and reports Screen Recording missing.
      const mac = {
        ...node,
        serverId: 'controlled_mac',
        os: 'mac',
        hostServerId: 'server_1',
        capabilities: [
          REMOTE_DESKTOP_SESSION_CAPABILITY,
          REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
          REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
          REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
        ],
      };
      view.rerender(h(DaemonRemoteDesktopControl as never, {
        ws: client as never,
        serverId: 'server_1',
        serverName: 'winbox',
        daemonOnline: true,
        onOpen: vi.fn(),
        machines: [mac],
      }));
      // The same call the controlled-machine list's permission button makes, once.
      await waitFor(() => expect(requestPermissions).toHaveBeenCalledWith('controlled_mac'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });

    it('offers no automatic install on a daemon that cannot do it', async () => {
      const { view } = mount([]);
      fireEvent.click(view.container.querySelector('button')!);
      await screen.findByText('remote_desktop.setup_install_heading');
      expect(screen.queryByText('remote_desktop.setup_auto_action')).toBeNull();
    });

    it('lets a right-click reopen setup to change a link that would otherwise just open', () => {
      const { view, onOpen } = mount([], { machines: [{ ...node, hostServerId: 'server_1' }] });
      fireEvent.contextMenu(view.container.querySelector('button')!);
      expect(onOpen).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="daemon-rd-setup-linked"]')).not.toBeNull();
      fireEvent.click(screen.getByText('remote_desktop.setup_unlink'));
      return waitFor(() => expect(setHostServer).toHaveBeenCalledWith('controlled_linux', null));
    });

    it('renders nothing on a daemon shared with this user when nothing openable is linked', () => {
      const { view } = mount([], { canSetUp: false });
      expect(view.container.querySelector('button')).toBeNull();
    });
  });

  it('renders nothing while the daemon is offline, however it is capable', () => {
    const { view } = mount([REMOTE_DESKTOP_CAPABILITY], { daemonOnline: false });
    expect(view.container.querySelector('button')).toBeNull();
  });

  it('offers the download when the host could serve remote control but has no worker (Windows or Linux — both repair by self-upgrade under this one wire capability)', () => {
    const { view } = mount([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    const button = view.container.querySelector('button')!;
    expect(button.getAttribute('title')).toBe('remote_desktop.install_worker');
  });

  /**
   * The daemon advertises a SEPARATE capability for macOS
   * (`REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY`) because it installs by a
   * different mechanism (component-store publish, not self-upgrade) — but
   * this component's own `installable` check only ever recognized the
   * Windows/Linux one, so a macOS host missing its component set rendered
   * nothing at all: no button, no install offer, nothing to click. Same
   * fixture shape as the sibling Windows/Linux test above, proving the two
   * wire names now reach an identical rendered result.
   */
  it('offers the download when a macOS host could serve remote control but has no components installed', () => {
    const { view } = mount([REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY]);
    const button = view.container.querySelector('button')!;
    expect(button.getAttribute('title')).toBe('remote_desktop.install_worker');
  });

  it('requests an install for a macOS host through the same generic, field-less request the Windows/Linux path uses', () => {
    const { view, sent } = mount([REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY]);
    fireEvent.click(view.container.querySelector('button')!);
    // No platform field: the daemon/controlled-node side already knows its
    // own platform and branches there (installMacosRemoteDesktopComponents
    // vs repairMissingRemoteDesktopWorker) — the frontend only has to ask.
    expect(sent).toEqual([{ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }]);
  });

  it('opens the daemon machine once the worker is installed', () => {
    const { view, onOpen } = mount([
      REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
      REMOTE_DESKTOP_CAPABILITY,
    ]);
    const button = view.container.querySelector('button')!;
    expect(button.getAttribute('title')).toBe('remote_desktop.daemon_control');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The panel is keyed by serverId and capability authority. Pin the whole
    // synthetic daemon projection so descriptive OS metadata cannot return as
    // an implicit launch gate.
    expect(onOpen.mock.calls[0]![0]).toEqual({
      serverId: 'server_1',
      refName: '',
      displayName: 'winbox',
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
    });
  });

  it('requests an install and reflects the daemon-reported progress', async () => {
    const { view, sent, emit } = mount([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    fireEvent.click(view.container.querySelector('button')!);
    expect(sent).toEqual([{ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST }]);
    expect(view.container.querySelector('button')!.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      emit({
        type: REMOTE_DESKTOP_INSTALL_MSG.STATE,
        state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
        error: REMOTE_DESKTOP_INSTALL_ERROR.NOT_AVAILABLE,
      });
    });
    const button = view.container.querySelector('button')!;
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('title')).toBe('remote_desktop.install_error_not_available');
  });

  it('asks for confirmation before requesting an install, and sends nothing if declined', () => {
    confirmSpy.mockReturnValue(false);
    const { view, sent } = mount([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    fireEvent.click(view.container.querySelector('button')!);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(view.container.querySelector('button')!.hasAttribute('disabled')).toBe(false);
  });

  describe('login-screen control', () => {
    const ready = [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY, REMOTE_DESKTOP_CAPABILITY];
    const sharedMachine = {
      serverId: 'controlled_1',
      refName: 'winbox-node',
      displayName: 'winbox',
      os: 'win',
      online: true,
      execEnabled: true,
      accessRole: 'owner',
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
      hostServerId: 'server_1',
    };

    it('offers the one-time setup beside the control on the status card', () => {
      const { view } = mount(ready);
      expect([...view.container.querySelectorAll('button')].map((b) => b.getAttribute('title')))
        .toEqual(['remote_desktop.daemon_control', 'remote_desktop.login_screen_hint']);
    });

    it('keeps a mount point with no room to a single button', () => {
      const { view } = mount(ready, { compact: true, offerLoginScreenSetup: false });
      expect(view.container.querySelectorAll('button')).toHaveLength(1);
    });

    it('still offers the setup in a toolbar that only lacks labels', () => {
      // `compact` is about labels, not room: a desktop toolbar shows icons and
      // still has space for the one-time setup, and would otherwise be the one
      // place it could never be reached from.
      const { view } = mount(ready, { compact: true });
      const buttons = [...view.container.querySelectorAll('button')];
      expect(buttons).toHaveLength(2);
      expect(buttons[1]!.getAttribute('title')).toBe('remote_desktop.login_screen_hint');
      // Icon only, matching the toolbar around it.
      expect(buttons[1]!.textContent).toBe('🔒');
    });

    it('opens the controlled node that shares this machine, not the daemon', () => {
      const { view, onOpen } = mount(ready, { machines: [sharedMachine] });
      const buttons = [...view.container.querySelectorAll('button')];
      // One button, and it steers to the machine that can also serve the
      // sign-in screen — two entries would put two workers on one desktop.
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0]!);
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'controlled_1' }));
    });

    it('ignores a controlled node that shares some other machine', () => {
      const { view, onOpen } = mount(ready, {
        machines: [{ ...sharedMachine, hostServerId: 'server_other' }],
      });
      fireEvent.click(view.container.querySelectorAll('button')[0]!);
      expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server_1' }));
    });

    it('mints a ticket bound to this daemon, with no group involved', async () => {
      const { view, sent } = mount(ready);
      fireEvent.click(view.container.querySelectorAll('button')[1]!);
      await act(async () => { await Promise.resolve(); });
      // The daemon id is the host binding and the only argument there is.
      // It used to sit behind a group id, and because both are strings, passing
      // the daemon where the group belonged compiled silently.
      expect(mintTicket).toHaveBeenCalledWith({ os: 'win', arch: 'x64' }, 'server_1');
      expect(sent).toEqual([{
        type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
        ticket: 'ticket_minted_value',
      }]);
    });

    it('can mint immediately, with no group list to wait for', async () => {
      // The control used to stay disabled until a group list resolved, and
      // refuse outright if the account had none. Enrolment binds this machine
      // to its user; there is nothing to wait for.
      mintTicket.mockClear();
      const { view } = mount(ready);
      const button = view.container.querySelectorAll('button')[1]!;
      expect(button.hasAttribute('disabled')).toBe(false);
      fireEvent.click(button);
      await act(async () => { await Promise.resolve(); });
      expect(mintTicket).toHaveBeenCalledTimes(1);
    });

    it('asks for confirmation before enabling the login screen, and mints nothing if declined', async () => {
      confirmSpy.mockReturnValue(false);
      mintTicket.mockClear();
      const { view } = mount(ready);
      fireEvent.click(view.container.querySelectorAll('button')[1]!);
      await act(async () => { await Promise.resolve(); });
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(mintTicket).not.toHaveBeenCalled();
    });

    it('reports a dismissed prompt without losing the retry', async () => {
      const { view, emit } = mount(ready);
      fireEvent.click(view.container.querySelectorAll('button')[1]!);
      await act(async () => {
        emit({
          type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.STATE,
          state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
          error: REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED,
        });
      });
      const retry = view.container.querySelectorAll('button')[1]!;
      expect(retry.hasAttribute('disabled')).toBe(false);
      expect(retry.getAttribute('title'))
        .toBe('remote_desktop.login_screen_error_elevation_declined');
    });
  });

  it('ignores a malformed install state instead of rendering it', async () => {
    const { view, sent, emit } = mount([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    fireEvent.click(view.container.querySelector('button')!);
    expect(sent).toHaveLength(1);
    await act(async () => {
      emit({ type: REMOTE_DESKTOP_INSTALL_MSG.STATE, state: 'exploded' });
    });
    // Still showing the in-flight download, not an unknown state.
    expect(view.container.querySelector('button')!.hasAttribute('disabled')).toBe(true);
  });
});
