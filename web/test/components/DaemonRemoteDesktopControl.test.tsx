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
  REMOTE_DESKTOP_CAPTURE_CAPABILITY,
  REMOTE_DESKTOP_PLATFORM_CAPABILITY,
  REMOTE_DESKTOP_SESSION_CAPABILITY,
} = await import('@shared/remote-desktop-platform.js');
const { REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY } = await import('@shared/remote-desktop-access.js');
const { DaemonRemoteDesktopControl, RemoteDesktopGlyphIcon } = await import('../../src/components/DaemonRemoteDesktopControl.js');
const {
  clearCachedDaemonCapabilities,
  readCachedDaemonCapabilities,
  writeCachedDaemonCapabilities,
} = await import('../../src/daemon-capability-cache.js');

const TEST_SCOPE = 'http://localhost:8080#test_user';

type MessageHandler = (message: Record<string, unknown>) => void;

function createSwitchableWsStub(initialCapabilities: string[] | null, targetServerId?: string, initialConnected = true) {
  let isConnected = initialConnected;
  let currentSnapshot = initialCapabilities ? { capabilities: initialCapabilities } : null;
  const snapshotListeners = new Set<(s: { capabilities: string[] } | null) => void>();
  const messageHandlers = new Set<MessageHandler>();
  const sent: Array<Record<string, unknown>> = [];

  const client = {
    get connected() { return isConnected; },
    targetsServer: (id: string) => (targetServerId !== undefined ? targetServerId === id : true),
    getDaemonCapabilitySnapshot: () => currentSnapshot,
    onDaemonCapabilitySnapshot: (listener: (s: { capabilities: string[] } | null) => void) => {
      snapshotListeners.add(listener);
      listener(currentSnapshot);
      return () => { snapshotListeners.delete(listener); };
    },
    onMessage: (handler: MessageHandler) => {
      messageHandlers.add(handler);
      return () => { messageHandlers.delete(handler); };
    },
    send: (message: Record<string, unknown>) => {
      if (isConnected) sent.push(message);
    },
  };

  return {
    client,
    sent,
    setConnected: (val: boolean) => { isConnected = val; },
    emitMessage: (message: Record<string, unknown>) => {
      for (const handler of messageHandlers) handler(message);
    },
    emitSnapshot: (capabilities: string[] | null) => {
      currentSnapshot = capabilities ? { capabilities } : null;
      for (const listener of snapshotListeners) listener(currentSnapshot);
    },
  };
}

function wsStub(capabilities: string[]) {
  const messageHandlers = new Set<MessageHandler>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    emit: (message: Record<string, unknown>) => {
      for (const handler of messageHandlers) handler(message);
    },
    client: {
      get connected() { return true; },
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

    it('asks a Mac with Screen Recording but not Accessibility for the grant instead of opening it', async () => {
      // pro.koca.win: it could only be watched, and it is offered only once
      // both permissions are in.
      const mac = {
        ...node,
        serverId: 'controlled_mac_view',
        os: 'mac',
        hostServerId: 'server_1',
        capabilities: [
          REMOTE_DESKTOP_SESSION_CAPABILITY,
          REMOTE_DESKTOP_PLATFORM_CAPABILITY.MACOS,
          REMOTE_DESKTOP_CAPTURE_CAPABILITY.MACOS_SCREEN_CAPTURE_KIT,
          REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
          REMOTE_DESKTOP_LOCAL_DISCLOSURE_CAPABILITY,
        ],
      };
      const { view, onOpen } = mount([], { machines: [mac] });
      fireEvent.click(view.container.querySelector('button')!);
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('remote_desktop.request_permission'));
      await waitFor(() => expect(requestPermissions).toHaveBeenCalledWith('controlled_mac_view'));
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

  describe('cross-platform RemoteDesktopGlyphIcon and emoji replacement', () => {
    it('renders RemoteDesktopGlyphIcon SVG and does not render 🖥 emoji in ready state (compact and non-compact)', () => {
      const readyCaps = [
        REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
        REMOTE_DESKTOP_CAPABILITY,
      ];
      // Compact mode (toolbar / sidebar icon-only)
      const { view: compactView } = mount(readyCaps, { compact: true });
      const compactBtn = compactView.container.querySelector('.daemon-remote-desktop-btn')!;
      expect(compactBtn).toBeTruthy();
      expect(compactBtn.textContent).not.toContain('🖥');
      const compactSvg = compactBtn.querySelector('svg');
      expect(compactSvg).toBeTruthy();
      expect(compactSvg?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(compactSvg?.getAttribute('width')).toBe('17');
      expect(compactSvg?.getAttribute('height')).toBe('17');
      expect(compactSvg?.getAttribute('aria-hidden')).toBe('true');
      expect(compactBtn.getAttribute('aria-label')).toBe('remote_desktop.daemon_control');

      // Non-compact mode (shows label text next to SVG)
      cleanup();
      const { view: fullView } = mount(readyCaps, { compact: false });
      const fullBtn = fullView.container.querySelector('.daemon-remote-desktop-btn')!;
      expect(fullBtn).toBeTruthy();
      expect(fullBtn.textContent).not.toContain('🖥');
      expect(fullBtn.textContent).toContain('remote_desktop.daemon_control');
      const fullSvg = fullBtn.querySelector('svg');
      expect(fullSvg).toBeTruthy();
    });

    it('renders RemoteDesktopGlyphIcon SVG and does not render 🖥 emoji in is-setup-required state', () => {
      const { view } = mount([], { canSetUp: true });
      const setupBtn = view.container.querySelector('.daemon-remote-desktop-btn.is-setup-required')!;
      expect(setupBtn).toBeTruthy();
      expect(setupBtn.textContent).not.toContain('🖥');
      const svg = setupBtn.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(setupBtn.getAttribute('aria-label')).toBe('remote_desktop.setup_button_hint');
    });

    it('RemoteDesktopGlyphIcon renders valid iMac-style display without defs or id clashes', () => {
      const { container } = render(h(RemoteDesktopGlyphIcon, { size: 17, className: 'custom-rd-icon' }));
      const svg = container.querySelector('svg')!;
      expect(svg).toBeTruthy();
      expect(svg.getAttribute('width')).toBe('17');
      expect(svg.getAttribute('height')).toBe('17');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(svg.classList.contains('custom-rd-icon')).toBe(true);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      // Must not use defs or id attribute to avoid cross-instance SVG defs clashes
      expect(svg.querySelector('defs')).toBeNull();
      expect(svg.querySelectorAll('[id]')).toHaveLength(0);
      // Screen, chin, and stand elements exist
      expect(svg.querySelectorAll('rect').length).toBeGreaterThanOrEqual(3);
      expect(svg.querySelector('polygon')).toBeTruthy();
      expect(svg.querySelector('path')).toBeTruthy();
    });
  });

  it('resolveServerRemoteDesktopTarget prefers openable linked nodes, falls back to daemon RD, and distinguishes offline vs unavailable', async () => {
    const { resolveServerRemoteDesktopTarget } = await import('../../src/components/DaemonRemoteDesktopControl.js');
    const linkedOnline = {
      serverId: 'node-1',
      refName: 'winbox',
      displayName: 'WinBox',
      online: true,
      execEnabled: true,
      accessRole: 'owner' as const,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
      hostServerId: 'srv-1',
    };
    const linkedOffline = { ...linkedOnline, online: false };

    // Prefers openable linked node even when daemon also has RD capability
    expect(resolveServerRemoteDesktopTarget({
      serverId: 'srv-1',
      serverName: 'Srv 1',
      daemonOnline: true,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
      machines: [linkedOnline],
    })).toMatchObject({ target: linkedOnline, linkedOpenable: true, unavailableReason: null });

    // Falls back to daemon RD when linked node is offline or absent
    expect(resolveServerRemoteDesktopTarget({
      serverId: 'srv-1',
      serverName: 'Srv 1',
      daemonOnline: true,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
      machines: [linkedOffline],
    })).toMatchObject({
      target: { serverId: 'srv-1', displayName: 'Srv 1' },
      linkedOpenable: false,
      unavailableReason: null,
    });

    // Offline daemon + offline linked node -> offline reason
    expect(resolveServerRemoteDesktopTarget({
      serverId: 'srv-1',
      serverName: 'Srv 1',
      daemonOnline: false,
      capabilities: [],
      machines: [linkedOffline],
    })).toMatchObject({ target: null, unavailableReason: 'offline' });

    // Offline daemon + ONLINE linked node -> STILL offline reason (matches DaemonRemoteDesktopControl top-bar guard)
    expect(resolveServerRemoteDesktopTarget({
      serverId: 'srv-1',
      serverName: 'Srv 1',
      daemonOnline: false,
      capabilities: [REMOTE_DESKTOP_CAPABILITY],
      machines: [linkedOnline],
    })).toMatchObject({ target: null, unavailableReason: 'offline' });

    const { DaemonRemoteDesktopControl: RDControl } = await import('../../src/components/DaemonRemoteDesktopControl.js');
    const offlineView = render(h(RDControl as never, {
      ws: null,
      serverId: 'srv-1',
      serverName: 'Srv 1',
      daemonOnline: false,
      onOpen: vi.fn(),
      machines: [linkedOnline],
    }));
    expect(offlineView.container.querySelector('.daemon-remote-desktop-btn')).toBeNull();

    // Online daemon without RD capability and no openable linked node -> unavailable reason
    expect(resolveServerRemoteDesktopTarget({
      serverId: 'srv-1',
      serverName: 'Srv 1',
      daemonOnline: true,
      capabilities: [],
      machines: [],
    })).toMatchObject({ target: null, unavailableReason: 'unavailable' });

    // Missing serverId -> no_server reason
    expect(resolveServerRemoteDesktopTarget({
      serverId: null,
      daemonOnline: false,
      capabilities: [],
      machines: [],
    })).toMatchObject({ target: null, unavailableReason: 'no_server' });
  });

  describe('server switching, capability caching, and state isolation', () => {
    beforeEach(() => {
      clearCachedDaemonCapabilities();
    });

    it('keeps remote desktop button visible without flash on server switch A -> B -> A when snapshot is initially null', async () => {
      // 1. Initial visit to Server A: ws connects and reports REMOTE_DESKTOP_CAPABILITY
      const wsA = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY]);
      const { container, rerender } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsA.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      // Server A button is visible and ready
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();

      // 2. Switch to Server B: initial ws has null snapshot before hello, but server B has cached REMOTE_DESKTOP_INSTALLABLE_CAPABILITY
      writeCachedDaemonCapabilities('server_B', [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], { accountScope: TEST_SCOPE });
      const wsB = createSwitchableWsStub(null); // null before hello arrives
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: wsB.client as never,
        serverId: 'server_B',
        serverName: 'Server B',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      // Server B uses cached installable capability immediately without vanishing to null
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();
      expect(container.textContent).toContain('remote_desktop.install_worker');

      // Server B hello arrives and confirms capabilities
      act(() => {
        wsB.emitSnapshot([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
      });
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();

      // 3. Switch back to Server A: wsA is fresh or reconnected with null snapshot before hello
      const wsA2 = createSwitchableWsStub(null); // null before hello
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: wsA2.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      // Server A button does NOT vanish to null; it immediately restores from cache!
      const btnA = container.querySelector('.daemon-remote-desktop-btn');
      expect(btnA).toBeTruthy();
      expect(btnA?.getAttribute('title')).toBe('remote_desktop.daemon_control');

      // When Server A hello arrives, stays stable
      act(() => {
        wsA2.emitSnapshot([REMOTE_DESKTOP_CAPABILITY]);
      });
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();
    });

    it('updates button state and cache when live capabilities change (e.g. revoked or uninstalled)', async () => {
      // Server was previously cached with REMOTE_DESKTOP_CAPABILITY
      writeCachedDaemonCapabilities('server_revoked', [REMOTE_DESKTOP_CAPABILITY], { accountScope: TEST_SCOPE });
      const ws = createSwitchableWsStub(null);
      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_revoked',
        serverName: 'Revoked Host',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      // Initially shows ready button from cache
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();
      expect(container.querySelector('.is-setup-required')).toBeNull();

      // Daemon connects and authoritative snapshot reveals capabilities are now empty (uninstalled)
      act(() => {
        ws.emitSnapshot([]);
      });

      // Button converges to is-setup-required and cache is updated
      expect(container.querySelector('.daemon-remote-desktop-btn.is-setup-required')).toBeTruthy();
      expect(readCachedDaemonCapabilities('server_revoked', { accountScope: TEST_SCOPE })).toEqual([]);
    });

    it('hides button when daemon is explicitly offline, even if capabilities are cached', () => {
      writeCachedDaemonCapabilities('server_offline', [REMOTE_DESKTOP_CAPABILITY], { accountScope: TEST_SCOPE });
      const ws = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY]);
      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_offline',
        daemonOnline: false,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      expect(container.firstChild).toBeNull();
    });

    it('resets install, loginScreen, and setupOpen state on serverId switch so states do not leak from A to B', async () => {
      const wsA = createSwitchableWsStub([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
      const { container, rerender } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsA.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      // Trigger install downloading state on Server A
      const installBtn = container.querySelector('.daemon-remote-desktop-btn')!;
      fireEvent.click(installBtn);
      act(() => {
        wsA.emitMessage({
          type: REMOTE_DESKTOP_INSTALL_MSG.STATE,
          state: REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING,
        });
      });
      expect(container.textContent).toContain('remote_desktop.installing');

      // Now switch to Server B
      const wsB = createSwitchableWsStub([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: wsB.client as never,
        serverId: 'server_B',
        serverName: 'Server B',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      // Server B must NOT show "installing" from Server A!
      expect(container.textContent).not.toContain('remote_desktop.installing');
      expect(container.textContent).toContain('remote_desktop.install_worker');
    });

    it('clears capability cache on logout preventing cross-account state leakage', () => {
      writeCachedDaemonCapabilities('server_user1', [REMOTE_DESKTOP_CAPABILITY], { accountScope: TEST_SCOPE });
      expect(readCachedDaemonCapabilities('server_user1', { accountScope: TEST_SCOPE })).toEqual([REMOTE_DESKTOP_CAPABILITY]);

      // Logout called
      clearCachedDaemonCapabilities();
      expect(readCachedDaemonCapabilities('server_user1', { accountScope: TEST_SCOPE })).toBeNull();

      // Cold mount without live snapshot does not show button for new user
      const ws = createSwitchableWsStub(null);
      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_user1',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: false,
      }));
      expect(container.firstChild).toBeNull();
    });

    it('does not inherit capabilities or write to cache when ws targets old server and serverId is new', () => {
      // wsA targets 'server_A' with REMOTE_DESKTOP_CAPABILITY
      const wsA = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A');
      // Render component pointing to server_B with wsA (e.g. before effect updates wsRef)
      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsA.client as never,
        serverId: 'server_B',
        serverName: 'Server B',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: false,
      }));

      // Server B must NOT show Server A's button!
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeNull();
      // Server B's cache must NOT be polluted with Server A's capabilities!
      expect(readCachedDaemonCapabilities('server_B', { accountScope: TEST_SCOPE })).toBeNull();
    });

    it('discards late ticket mint failure from previous server on switch without polluting new server', async () => {
      let rejectMintA: (err: unknown) => void = () => {};
      const mintPendingPromise = new Promise<{ ticket: string }>((_, reject) => {
        rejectMintA = reject;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeExecutableTicket').mockImplementationOnce(() => mintPendingPromise as never);

      const wsA = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A');
      const { container, rerender } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsA.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      // Click login screen enable on Server A
      const buttonsA = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsA.length).toBe(2);
      fireEvent.click(buttonsA[1]);

      // Now switch to Server B before mint resolves/rejects
      const wsB = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_B');
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: wsB.client as never,
        serverId: 'server_B',
        serverName: 'Server B',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      const buttonsB = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsB[1].getAttribute('title')).toBe('remote_desktop.login_screen_hint');

      // Reject Server A's promise
      await act(async () => {
        rejectMintA(new Error('Server A network timeout'));
      });

      // Server B's title must NOT change to login_screen_error_download_failed!
      const buttonsBAfter = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsBAfter[1].getAttribute('title')).toBe('remote_desktop.login_screen_hint');

      spy.mockRestore();
    });

    it('discards late mint failure or success on A -> B -> A switch without polluting second visit to A', async () => {
      let rejectMintA1: (err: unknown) => void = () => {};
      let resolveMintA1: (val: { ticket: string }) => void = () => {};
      const mintPendingPromise = new Promise<{ ticket: string }>((resolve, reject) => {
        resolveMintA1 = resolve;
        rejectMintA1 = reject;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeExecutableTicket').mockImplementationOnce(() => mintPendingPromise as never);

      // 1. Visit Server A (first visit) with wsA1
      const wsA1 = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A');
      const { container, rerender } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsA1.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      // Click login screen enable on visit 1 to A
      const buttonsA1 = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsA1.length).toBe(2);
      fireEvent.click(buttonsA1[1]);

      // 2. Switch to Server B with wsB
      const wsB = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_B');
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: wsB.client as never,
        serverId: 'server_B',
        serverName: 'Server B',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      // 3. Switch back to Server A (second visit) with new WebSocket wsA2
      const wsA2 = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A');
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: wsA2.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      const buttonsA2 = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsA2[1].getAttribute('title')).toBe('remote_desktop.login_screen_hint');

      // 4. Reject the late promise from visit 1 to Server A
      await act(async () => {
        rejectMintA1(new Error('Late network error from visit 1'));
      });

      // Second visit to Server A MUST NOT turn into download_failed!
      const buttonsA2AfterReject = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsA2AfterReject[1].getAttribute('title')).toBe('remote_desktop.login_screen_hint');
      expect(wsA2.sent.length).toBe(0);
      expect(wsA1.sent.length).toBe(0);

      spy.mockRestore();
    });

    it('discards late mint callback on same server when connection replaces ws1 -> ws2', async () => {
      let resolveMint1: (val: { ticket: string }) => void = () => {};
      const mintPendingPromise = new Promise<{ ticket: string }>((resolve) => {
        resolveMint1 = resolve;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeExecutableTicket').mockImplementationOnce(() => mintPendingPromise as never);

      // Visit Server A with ws1
      const ws1 = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A');
      const { container, rerender } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws1.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      // Click login screen enable with ws1
      const buttons1 = container.querySelectorAll('.daemon-remote-desktop-btn');
      fireEvent.click(buttons1[1]);

      // Reconnect/replace WebSocket on same server with ws2
      const ws2 = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A');
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: ws2.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      // Resolve old mint from ws1
      await act(async () => {
        resolveMint1({ ticket: 'old_ticket_from_ws1' });
      });

      // Old mint must NOT send message on ws2 or ws1
      expect(ws2.sent.length).toBe(0);
      expect(ws1.sent.length).toBe(0);

      spy.mockRestore();
    });

    it('ignores click on cached installable button when matching connection is not sendable, and succeeds once connected', () => {
      writeCachedDaemonCapabilities('server_cached_install', [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], { accountScope: TEST_SCOPE });
      // WebSocket is created but not connected yet
      const ws = createSwitchableWsStub([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], 'server_cached_install', false);

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_cached_install',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      // Button is visible from cache
      const button = container.querySelector('.daemon-remote-desktop-btn') as HTMLButtonElement;
      expect(button).toBeTruthy();
      expect(button.textContent).toContain('remote_desktop.install_worker');

      // Click while disconnected: must NOT enter DOWNLOADING or send
      fireEvent.click(button);
      expect(ws.sent.length).toBe(0);
      expect(button.disabled).toBe(false);
      expect(button.querySelector('.connecting-dot')).toBeNull();

      // Now connection becomes sendable/connected
      act(() => {
        ws.setConnected(true);
      });

      // Click when connected: successfully enters DOWNLOADING and sends request
      fireEvent.click(button);
      expect(ws.sent.length).toBe(1);
      expect(ws.sent[0]).toEqual({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST });
      expect(button.disabled).toBe(true);
      expect(button.querySelector('.connecting-dot')).not.toBeNull();
    });

    it('recovers to retryable state if connection drops while mint is in flight', async () => {
      let resolveMint: (val: { ticket: string }) => void = () => {};
      const mintPendingPromise = new Promise<{ ticket: string }>((resolve) => {
        resolveMint = resolve;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeExecutableTicket').mockImplementationOnce(() => mintPendingPromise as never);

      const ws = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_A', true);
      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_A',
        serverName: 'Server A',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));

      // Click login screen enable
      const buttons = container.querySelectorAll('.daemon-remote-desktop-btn');
      fireEvent.click(buttons[1]);
      expect(buttons[1].querySelector('.connecting-dot')).not.toBeNull();

      // Connection drops before mint finishes
      act(() => {
        ws.setConnected(false);
      });

      // Mint finishes
      await act(async () => {
        resolveMint({ ticket: 'valid_ticket' });
      });

      // Recovers to retryable failure state rather than stuck in DOWNLOADING
      const buttonsAfter = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsAfter[1].getAttribute('title')).toBe('remote_desktop.login_screen_error_download_failed');
      expect(buttonsAfter[1].querySelector('.connecting-dot')).toBeNull();

      spy.mockRestore();
    });

    it('strictly enforces explicit accountScope: unscoped control uses live snapshot only and ignores cache', () => {
      writeCachedDaemonCapabilities('server_scoped_test', [REMOTE_DESKTOP_CAPABILITY], { accountScope: TEST_SCOPE });

      // Unscoped mount (missing accountScope): does NOT read from cache
      const wsUnscoped = createSwitchableWsStub(null, 'server_scoped_test');
      const { container: unscopedContainer } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsUnscoped.client as never,
        serverId: 'server_scoped_test',
        daemonOnline: true,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: false,
      }));
      expect(unscopedContainer.querySelector('.daemon-remote-desktop-btn')).toBeNull();

      // Scoped mount (with matching accountScope): reads immediately from cache
      const wsScoped = createSwitchableWsStub(null, 'server_scoped_test');
      const { container: scopedContainer } = render(h(DaemonRemoteDesktopControl as never, {
        ws: wsScoped.client as never,
        serverId: 'server_scoped_test',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: false,
      }));
      expect(scopedContainer.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();
    });

    it('enforces canSetUp=false: hides worker install and login-screen enable buttons for restricted viewers', () => {
      // 1. Viewer on installable host: worker install button is hidden
      writeCachedDaemonCapabilities('server_viewer_install', [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], { accountScope: TEST_SCOPE });
      const ws1 = createSwitchableWsStub([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], 'server_viewer_install');
      const { container: c1 } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws1.client as never,
        serverId: 'server_viewer_install',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: false,
      }));
      expect(c1.querySelector('.daemon-remote-desktop-btn')).toBeNull();

      // Owner on same installable host: worker install button IS shown
      const { container: c1Owner } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws1.client as never,
        serverId: 'server_viewer_install',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));
      expect(c1Owner.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();
      expect(c1Owner.textContent).toContain('remote_desktop.install_worker');

      // 2. Viewer on ready host: open button IS shown, but login-screen enable button is hidden
      writeCachedDaemonCapabilities('server_viewer_ready', [REMOTE_DESKTOP_CAPABILITY], { accountScope: TEST_SCOPE });
      const ws2 = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_viewer_ready');
      const { container: c2 } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws2.client as never,
        serverId: 'server_viewer_ready',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: false,
      }));
      // Only 1 button (the open button), no auxiliary lock/login-screen button
      const buttonsViewer = c2.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsViewer.length).toBe(1);
      expect(buttonsViewer[0].getAttribute('title')).toBe('remote_desktop.daemon_control');

      // Owner on same ready host: offers both open button AND login screen setup button
      const { container: c2Owner } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws2.client as never,
        serverId: 'server_viewer_ready',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        offerLoginScreenSetup: true,
        canSetUp: true,
      }));
      const buttonsOwner = c2Owner.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttonsOwner.length).toBe(2);
      expect(buttonsOwner[1].getAttribute('title')).toBe('remote_desktop.login_screen_hint');
    });

    it('prevents stale snapshot callbacks from backfilling cache after teardown', () => {
      const ws = createSwitchableWsStub(null, 'server_stale');
      const { unmount } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_stale',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
      }));

      // Unmount the component
      unmount();

      // Late snapshot fires after teardown
      act(() => {
        ws.emitSnapshot([REMOTE_DESKTOP_CAPABILITY]);
      });

      // Cache for server_stale should NOT be written by unmounted component
      expect(readCachedDaemonCapabilities('server_stale', { accountScope: TEST_SCOPE })).toBeNull();
    });

    it('toggles canSetUp (owner -> restricted -> owner) on same socket: clears ready button on snapshot [] and preserves subsequent install events', () => {
      writeCachedDaemonCapabilities('server_perm', [REMOTE_DESKTOP_CAPABILITY], { accountScope: TEST_SCOPE });
      const ws = createSwitchableWsStub([REMOTE_DESKTOP_CAPABILITY], 'server_perm');
      const { container, rerender } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_perm',
        serverName: 'Perm Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      // Initially owner: ready button is shown
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeTruthy();

      // Switch to restricted viewer (canSetUp: false)
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_perm',
        serverName: 'Perm Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: false,
      }));

      // Daemon on same socket publishes authoritative empty capabilities
      act(() => {
        ws.emitSnapshot([]);
      });

      // Ready button must be removed from page, and cache must be updated to []
      expect(container.querySelector('.daemon-remote-desktop-btn')).toBeNull();
      expect(readCachedDaemonCapabilities('server_perm', { accountScope: TEST_SCOPE })).toEqual([]);

      // Switch back to owner (canSetUp: true) and daemon advertises installable
      rerender(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_perm',
        serverName: 'Perm Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));
      act(() => {
        ws.emitSnapshot([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
      });

      // Install button is shown and can still handle click and messages
      const installBtn = container.querySelector('.daemon-remote-desktop-btn') as HTMLButtonElement;
      expect(installBtn).toBeTruthy();
      expect(installBtn.textContent).toContain('remote_desktop.install_worker');

      fireEvent.click(installBtn);
      expect(ws.sent.length).toBe(1);
      expect(ws.sent[0]).toEqual({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST });
      expect(installBtn.querySelector('.connecting-dot')).not.toBeNull();

      // Install state message arriving on socket updates state
      act(() => {
        ws.emitMessage({
          type: REMOTE_DESKTOP_INSTALL_MSG.STATE,
          state: REMOTE_DESKTOP_INSTALL_STATE.INSTALLED,
        });
      });
      expect(installBtn.querySelector('.connecting-dot')).toBeNull();
    });

    it('does not enter downloading when clicked with connected=true but raw websocket is CLOSING', () => {
      const ws = createSwitchableWsStub([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], 'server_raw_closing');
      // Mock underlying raw websocket in CLOSING state (2)
      (ws.client as Record<string, unknown>).ws = { readyState: 2 };

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_raw_closing',
        serverName: 'Raw Closing Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      const button = container.querySelector('.daemon-remote-desktop-btn') as HTMLButtonElement;
      expect(button).toBeTruthy();

      fireEvent.click(button);
      // No frames sent and does not enter downloading
      expect(ws.sent.length).toBe(0);
      expect(button.disabled).toBe(false);
      expect(button.querySelector('.connecting-dot')).toBeNull();
    });

    it('does not accept install action when browser connected=true but daemon handshake not yet complete (snapshot null)', () => {
      writeCachedDaemonCapabilities('server_handshake', [REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], { accountScope: TEST_SCOPE });
      // ws has connected=true, but getDaemonCapabilitySnapshot() is null (daemon not yet ready)
      const ws = createSwitchableWsStub(null, 'server_handshake');

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_handshake',
        serverName: 'Handshake Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      const button = container.querySelector('.daemon-remote-desktop-btn') as HTMLButtonElement;
      // Button is visible via cache (no flicker)
      expect(button).toBeTruthy();

      // Click while daemon handshake is not yet complete: must not accept operation
      fireEvent.click(button);
      expect(ws.sent.length).toBe(0);
      expect(button.disabled).toBe(false);
      expect(button.querySelector('.connecting-dot')).toBeNull();

      // Once daemon handshake completes:
      act(() => {
        ws.emitSnapshot([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
      });
      fireEvent.click(button);
      expect(ws.sent.length).toBe(1);
      expect(button.querySelector('.connecting-dot')).not.toBeNull();
    });

    it('cleans up in-progress downloading operation when daemon disconnects or capabilities clear on same ws', () => {
      const ws = createSwitchableWsStub([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY], 'server_dc_cleanup');

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_dc_cleanup',
        serverName: 'DC Cleanup Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      const button = container.querySelector('.daemon-remote-desktop-btn') as HTMLButtonElement;
      fireEvent.click(button);
      expect(button.querySelector('.connecting-dot')).not.toBeNull();

      // Daemon disconnect message arrives on the same ws
      act(() => {
        ws.emitMessage({ type: 'daemon.disconnect' });
      });

      // Downloading state is cleaned up; no longer locked
      expect(button.querySelector('.connecting-dot')).toBeNull();
      expect(button.disabled).toBe(false);
    });

    it('cancels pending ticket send when snapshot retracts ready capability during in-flight mint', async () => {
      let resolveTicket: (val: { ticket: string }) => void = () => {};
      const pendingMint = new Promise<{ ticket: string }>((resolve) => {
        resolveTicket = resolve;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeExecutableTicket').mockImplementationOnce(() => pendingMint as never);

      const ws = createSwitchableWsStub(
        [REMOTE_DESKTOP_CAPABILITY, REMOTE_DESKTOP_INSTALLABLE_CAPABILITY],
        'server_retract_ready',
      );

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_retract_ready',
        serverName: 'Retract Ready Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      // Click login screen enable button
      const buttons = container.querySelectorAll('.daemon-remote-desktop-btn');
      expect(buttons.length).toBe(2);
      fireEvent.click(buttons[1]);
      expect(buttons[1].querySelector('.connecting-dot')).not.toBeNull();

      // Snapshot update removes REMOTE_DESKTOP_CAPABILITY, leaving only INSTALLABLE
      act(() => {
        ws.emitSnapshot([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
      });

      // Now resolve the ticket mint
      await act(async () => {
        resolveTicket({ ticket: 'late_ticket_123' });
      });

      // Assert: NO frame was sent because required capability was retracted!
      expect(ws.sent.length).toBe(0);

      spy.mockRestore();
    });

    it('cancels pending install-here send when snapshot replaces or retracts install-here target', async () => {
      let resolveInstallCode: (val: { installCode: string }) => void = () => {};
      const pendingMint = new Promise<{ installCode: string }>((resolve) => {
        resolveInstallCode = resolve;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeInstallCommand').mockImplementationOnce(() => pendingMint as never);

      const linuxX64Cap = controlledNodeInstallHereCapability({ os: 'linux', arch: 'x64' });
      const darwinArm64Cap = controlledNodeInstallHereCapability({ os: 'darwin', arch: 'arm64' });

      const ws = createSwitchableWsStub([linuxX64Cap], 'server_retract_install_here');

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_retract_install_here',
        serverName: 'Install Here Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      // Right-click opens setup dialog
      const btn = container.querySelector('.daemon-remote-desktop-btn') as HTMLButtonElement;
      fireEvent.contextMenu(btn);

      // In setup dialog, click install here start button
      const startBtn = container.querySelector('.controlled-node-install-here-btn') as HTMLButtonElement;
      if (startBtn) {
        fireEvent.click(startBtn);
      }

      // Snapshot updates target artifact to darwin-arm64
      act(() => {
        ws.emitSnapshot([darwinArm64Cap]);
      });

      // Resolve mint promise
      await act(async () => {
        resolveInstallCode({ installCode: 'sh -c late_install' });
      });

      // No frame sent
      expect(ws.sent.length).toBe(0);

      spy.mockRestore();
    });

    it('does not cancel in-flight ticket send when unrelated capabilities are added or removed', async () => {
      let resolveTicket: (val: { ticket: string }) => void = () => {};
      const pendingMint = new Promise<{ ticket: string }>((resolve) => {
        resolveTicket = resolve;
      });
      const machinesApi = await import('../../src/api/machines.js');
      const spy = vi.spyOn(machinesApi, 'mintControlledNodeExecutableTicket').mockImplementationOnce(() => pendingMint as never);

      const ws = createSwitchableWsStub(
        [REMOTE_DESKTOP_CAPABILITY, REMOTE_DESKTOP_INSTALLABLE_CAPABILITY],
        'server_unrelated_caps',
      );

      const { container } = render(h(DaemonRemoteDesktopControl as never, {
        ws: ws.client as never,
        serverId: 'server_unrelated_caps',
        serverName: 'Unrelated Caps Server',
        daemonOnline: true,
        accountScope: TEST_SCOPE,
        onOpen: vi.fn(),
        machines: [],
        canSetUp: true,
      }));

      const buttons = container.querySelectorAll('.daemon-remote-desktop-btn');
      fireEvent.click(buttons[1]);

      // Snapshot adds an unrelated capability (e.g. encoder), keeping REMOTE_DESKTOP_CAPABILITY
      act(() => {
        ws.emitSnapshot([
          REMOTE_DESKTOP_CAPABILITY,
          REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
          REMOTE_DESKTOP_ENCODER_CAPABILITY.H264,
        ]);
      });

      // Resolve ticket
      await act(async () => {
        resolveTicket({ ticket: 'valid_ticket_456' });
      });

      // Because REMOTE_DESKTOP_CAPABILITY was preserved, the ticket IS sent!
      expect(ws.sent.length).toBe(1);
      expect(ws.sent[0]).toEqual({
        type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
        ticket: 'valid_ticket_456',
      });

      spy.mockRestore();
    });
  });
});
