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
import { describe, it, expect, vi, afterEach } from 'vitest';
import { h } from 'preact';
import { render, cleanup, act, fireEvent } from '@testing-library/preact';

const mintTicket = vi.fn(async () => ({ ticket: 'ticket_minted_value' }));
vi.mock('../../src/api/machines.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  mintControlledNodeExecutableTicket: (...args: unknown[]) => mintTicket(...args as []),
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
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_INSTALL_STATE,
  REMOTE_DESKTOP_INSTALL_ERROR,
} = await import('@shared/remote-desktop-install.js');
const {
  REMOTE_DESKTOP_LOGIN_SCREEN_MSG,
  REMOTE_DESKTOP_LOGIN_SCREEN_STATE,
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
} = await import('@shared/remote-desktop-login-screen.js');
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

afterEach(() => { cleanup(); });

describe('DaemonRemoteDesktopControl', () => {
  it('renders nothing for a daemon that cannot serve remote control', () => {
    const { view } = mount([]);
    expect(view.container.querySelector('button')).toBeNull();
  });

  it('renders nothing while the daemon is offline, however it is capable', () => {
    const { view } = mount([REMOTE_DESKTOP_CAPABILITY], { daemonOnline: false });
    expect(view.container.querySelector('button')).toBeNull();
  });

  it('offers the download when the host could serve remote control but has no worker', () => {
    const { view } = mount([REMOTE_DESKTOP_INSTALLABLE_CAPABILITY]);
    const button = view.container.querySelector('button')!;
    expect(button.getAttribute('title')).toBe('remote_desktop.install_worker');
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

    it('mints a ticket bound to this daemon and hands it over', async () => {
      const { view, sent } = mount(ready);
      fireEvent.click(view.container.querySelectorAll('button')[1]!);
      await act(async () => { await Promise.resolve(); });
      expect(mintTicket).toHaveBeenCalledWith({ os: 'win', arch: 'x64' }, 'server_1');
      expect(sent).toEqual([{
        type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
        ticket: 'ticket_minted_value',
      }]);
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
