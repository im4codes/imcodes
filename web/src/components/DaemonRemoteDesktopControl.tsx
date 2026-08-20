import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_INSTALL_STATE,
  validateRemoteDesktopInstallStateMessage,
  type RemoteDesktopInstallState,
} from '@shared/remote-desktop-install.js';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_MSG,
  REMOTE_DESKTOP_LOGIN_SCREEN_STATE,
  validateRemoteDesktopLoginScreenStateMessage,
  type RemoteDesktopLoginScreenState,
} from '@shared/remote-desktop-login-screen.js';
import type { WsClient } from '../ws-client.js';
import {
  daemonRemoteDesktopMachine,
  listControllableMachines,
  mintControlledNodeExecutableTicket,
  type MachineListItem,
} from '../api/machines.js';

export interface DaemonRemoteDesktopControlProps {
  ws: WsClient | null;
  serverId: string | null;
  serverName?: string | null;
  daemonOnline: boolean;
  onOpen(machine: MachineListItem): void;
  compact?: boolean;
  /**
   * Controlled machines this user can reach. Supplied by a caller that already
   * has them; otherwise looked up here, and only for a daemon that can actually
   * serve remote control, so an ordinary session never pays for the request.
   */
  machines?: readonly MachineListItem[];
}

/**
 * Remote control for the daemon's own machine.
 *
 * A daemon has no entry in the controlled-machine list, so its remote-desktop
 * state comes from the capabilities it advertises in `daemon.hello`: the
 * `installable` capability means "this is a Windows host that could serve remote
 * control", and the capability itself means "the native worker is installed and
 * verified". Anything else renders nothing at all — a machine that cannot serve
 * remote control should not offer a button that will fail.
 */
export function DaemonRemoteDesktopControl({
  ws,
  serverId,
  serverName,
  daemonOnline,
  onOpen,
  compact = false,
  machines,
}: DaemonRemoteDesktopControlProps) {
  const { t } = useTranslation();
  const [capabilities, setCapabilities] = useState<readonly string[]>([]);
  const [install, setInstall] = useState<{ state: RemoteDesktopInstallState; error?: string } | null>(null);
  const [loginScreen, setLoginScreen] = useState<
    { state: RemoteDesktopLoginScreenState; error?: string } | null
  >(null);
  const [fetched, setFetched] = useState<readonly MachineListItem[]>([]);

  useEffect(() => {
    if (!ws) {
      setCapabilities([]);
      return;
    }
    setCapabilities(ws.getDaemonCapabilitySnapshot()?.capabilities ?? []);
    return ws.onDaemonCapabilitySnapshot((snapshot) => {
      setCapabilities(snapshot?.capabilities ?? []);
    });
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((message) => {
      const state = validateRemoteDesktopInstallStateMessage(message);
      if (state) setInstall({ state: state.state, ...(state.error ? { error: state.error } : {}) });
      const loginScreenState = validateRemoteDesktopLoginScreenStateMessage(message);
      if (loginScreenState) {
        setLoginScreen({
          state: loginScreenState.state,
          ...(loginScreenState.error ? { error: loginScreenState.error } : {}),
        });
      }
    });
  }, [ws]);

  const ready = capabilities.includes(REMOTE_DESKTOP_CAPABILITY);

  useEffect(() => {
    if (machines || !ready || !serverId) return;
    let cancelled = false;
    void listControllableMachines()
      .then((list) => { if (!cancelled) setFetched(list); })
      // A failed lookup only means no hand-off is offered; the daemon's own
      // remote control still works.
      .catch(() => {});
    return () => { cancelled = true; };
    // `loginScreen` is a dependency so a completed install is picked up without
    // the user reloading: the node it just enrolled is what the button steers to.
  }, [machines, ready, serverId, loginScreen?.state]);
  const installable = capabilities.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY);
  if (!serverId || !daemonOnline || (!ready && !installable)) return null;

  // A controlled node enrolled from this daemon is the same physical machine.
  // Opening it instead of the daemon is what keeps one desktop to one session,
  // and it is the only one of the two that reaches the sign-in screen.
  const sharedMachine = (machines ?? fetched)
    .find((machine) => machine.hostServerId === serverId) ?? null;

  if (ready || sharedMachine) {
    const target = sharedMachine ?? daemonRemoteDesktopMachine(serverId, serverName ?? null);
    const control = (
      <button
        class="view-toggle daemon-remote-desktop-btn"
        title={t('remote_desktop.daemon_control')}
        onClick={() => onOpen(target)}
      >
        🖥{compact ? '' : ` ${t('remote_desktop.daemon_control')}`}
      </button>
    );
    const installing = loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING
      || loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING;
    // Offered on the status card only, and only while no controlled node shares
    // this machine: the status bar has no room for a second button, and this is
    // a one-time setup step rather than a daily action.
    if (compact || sharedMachine || !ready) return control;
    const failed = loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED;
    return (
      <>
        {control}
        <button
          class="view-toggle daemon-remote-desktop-btn"
          style={failed ? { color: '#f87171', borderColor: '#7f1d1d' } : undefined}
          disabled={installing}
          title={failed
            ? t(`remote_desktop.login_screen_error_${loginScreen?.error ?? 'download_failed'}`, {
              defaultValue: t('remote_desktop.login_screen_failed'),
            })
            : t('remote_desktop.login_screen_hint')}
          onClick={() => {
            setLoginScreen({ state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING });
            void mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }, serverId)
              .then((minted) => {
                ws?.send({
                  type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
                  ticket: minted.ticket,
                });
              })
              .catch(() => {
                setLoginScreen({
                  state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
                  error: 'download_failed',
                });
              });
          }}
        >
          {installing
            ? <><span class="connecting-dot" />{` ${loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING
              ? t('remote_desktop.login_screen_waiting')
              : t('remote_desktop.login_screen_downloading')}`}</>
            : `🔒 ${t(failed ? 'remote_desktop.login_screen_retry' : 'remote_desktop.login_screen_enable')}`}
        </button>
      </>
    );
  }

  const downloading = install?.state === REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING;
  const failed = install?.state === REMOTE_DESKTOP_INSTALL_STATE.FAILED;
  const failureLabel = failed
    ? t(`remote_desktop.install_error_${install?.error ?? 'download_failed'}`, {
      defaultValue: t('remote_desktop.install_failed'),
    })
    : '';
  return (
    <button
      class="view-toggle daemon-remote-desktop-btn"
      // Inline rather than a class: styles.css is shared and this is the only
      // rule the control needs beyond `view-toggle`.
      style={failed ? { color: '#f87171', borderColor: '#7f1d1d' } : undefined}
      disabled={downloading}
      title={failed ? failureLabel : t('remote_desktop.install_worker')}
      onClick={() => {
        setInstall({ state: REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING });
        ws?.send({ type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST });
      }}
    >
      {downloading
        ? <><span class="connecting-dot" />{compact ? '' : ` ${t('remote_desktop.installing')}`}</>
        : <>⬇{compact ? '' : ` ${t(failed ? 'remote_desktop.install_retry' : 'remote_desktop.install_worker')}`}</>}
    </button>
  );
}
