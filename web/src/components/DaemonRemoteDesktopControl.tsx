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
  REMOTE_DESKTOP_ELEVATED_CAPABILITY,
  REMOTE_DESKTOP_ELEVATED_INSTALL_MSG,
  REMOTE_DESKTOP_ELEVATED_STATE,
  validateRemoteDesktopElevatedStateMessage,
  type RemoteDesktopElevatedState,
} from '@shared/remote-desktop-elevated.js';
import type { WsClient } from '../ws-client.js';
import { daemonRemoteDesktopMachine, type MachineListItem } from '../api/machines.js';

export interface DaemonRemoteDesktopControlProps {
  ws: WsClient | null;
  serverId: string | null;
  serverName?: string | null;
  daemonOnline: boolean;
  onOpen(machine: MachineListItem): void;
  compact?: boolean;
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
}: DaemonRemoteDesktopControlProps) {
  const { t } = useTranslation();
  const [capabilities, setCapabilities] = useState<readonly string[]>([]);
  const [install, setInstall] = useState<{ state: RemoteDesktopInstallState; error?: string } | null>(null);
  const [elevated, setElevated] = useState<{ state: RemoteDesktopElevatedState; error?: string } | null>(null);

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
      const elevatedState = validateRemoteDesktopElevatedStateMessage(message);
      if (elevatedState) {
        setElevated({
          state: elevatedState.state,
          ...(elevatedState.error ? { error: elevatedState.error } : {}),
        });
      }
    });
  }, [ws]);

  const ready = capabilities.includes(REMOTE_DESKTOP_CAPABILITY);
  const installable = capabilities.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY);
  if (!serverId || !daemonOnline || (!ready && !installable)) return null;

  if (ready) {
    const control = (
      <button
        class="view-toggle daemon-remote-desktop-btn"
        title={t('remote_desktop.daemon_control')}
        onClick={() => onOpen(daemonRemoteDesktopMachine(serverId, serverName ?? null))}
      >
        🖥{compact ? '' : ` ${t('remote_desktop.daemon_control')}`}
      </button>
    );
    const elevatedReady = capabilities.includes(REMOTE_DESKTOP_ELEVATED_CAPABILITY)
      || elevated?.state === REMOTE_DESKTOP_ELEVATED_STATE.INSTALLED;
    // Offered on the status card only: the status bar has no room for a second
    // button, and this is a one-time setup step rather than a daily action.
    if (compact || elevatedReady) return control;
    const elevating = elevated?.state === REMOTE_DESKTOP_ELEVATED_STATE.ELEVATING;
    const elevateFailed = elevated?.state === REMOTE_DESKTOP_ELEVATED_STATE.FAILED;
    return (
      <>
        {control}
        <button
          class="view-toggle daemon-remote-desktop-btn"
          style={elevateFailed ? { color: '#f87171', borderColor: '#7f1d1d' } : undefined}
          disabled={elevating}
          title={elevateFailed
            ? t(`remote_desktop.elevated_error_${elevated?.error ?? 'install_failed'}`, {
              defaultValue: t('remote_desktop.elevated_failed'),
            })
            : t('remote_desktop.elevated_hint')}
          onClick={() => {
            setElevated({ state: REMOTE_DESKTOP_ELEVATED_STATE.ELEVATING });
            ws?.send({ type: REMOTE_DESKTOP_ELEVATED_INSTALL_MSG.REQUEST });
          }}
        >
          {elevating
            ? <><span class="connecting-dot" />{` ${t('remote_desktop.elevated_waiting')}`}</>
            : `🔒 ${t(elevateFailed ? 'remote_desktop.elevated_retry' : 'remote_desktop.elevated_enable')}`}
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
