import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY,
  REMOTE_DESKTOP_INSTALL_MSG,
  REMOTE_DESKTOP_INSTALL_STATE,
  validateRemoteDesktopInstallStateMessage,
  type RemoteDesktopInstallState,
} from '@shared/remote-desktop-install.js';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  REMOTE_DESKTOP_LOGIN_SCREEN_MSG,
  REMOTE_DESKTOP_LOGIN_SCREEN_STATE,
  readControlledNodeInstallHereTarget,
  validateRemoteDesktopLoginScreenStateMessage,
  type RemoteDesktopLoginScreenState,
} from '@shared/remote-desktop-login-screen.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import type { WsClient } from '../ws-client.js';
import {
  daemonRemoteDesktopMachine,
  mintControlledNodeExecutableTicket,
  mintControlledNodeInstallCommand,
  type MachineListItem,
} from '../api/machines.js';
import { useMachines } from '../hooks/useMachines.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import { DaemonRemoteDesktopSetup } from './DaemonRemoteDesktopSetup.js';
import {
  readCachedDaemonCapabilities,
  writeCachedDaemonCapabilities,
} from '../daemon-capability-cache.js';

export interface RemoteDesktopGlyphIconProps {
  size?: number;
  className?: string;
}

/**
 * Cross-platform remote desktop glyph styled after a modern macOS wide-screen
 * display (silver chassis + dark glass screen + glare reflection + chin + stand).
 * Avoids platform-dependent font emoji glyphs (e.g. Windows U+1F5A5 upright tower)
 * and uses no SVG gradient IDs to prevent cross-instance defs clashes.
 */
export function RemoteDesktopGlyphIcon({ size = 17, className }: RemoteDesktopGlyphIconProps) {
  return (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* Outer enclosure (silver chassis & chin) */}
      <rect x="2" y="2.5" width="20" height="14" rx="1.8" fill="#cbd5e1" stroke="#475569" stroke-width="0.8" />
      {/* Display screen (dark glass) */}
      <rect x="2.8" y="3.3" width="18.4" height="9.7" rx="0.6" fill="#0f172a" stroke="#334155" stroke-width="0.5" />
      {/* Glass reflection sheen */}
      <polygon points="3.4,3.3 12,3.3 4.5,13 2.8,13 2.8,4.5" fill="#ffffff" opacity="0.16" />
      {/* Camera lens dot */}
      <circle cx="12" cy="2.9" r="0.35" fill="#334155" />
      {/* Stand neck */}
      <path d="M10.6 16.5 L10.1 20.2 H13.9 L13.4 16.5 Z" fill="#94a3b8" />
      {/* Stand foot / base */}
      <rect x="6.5" y="20.2" width="11" height="1.6" rx="0.8" fill="#cbd5e1" stroke="#475569" stroke-width="0.6" />
    </svg>
  );
}

export interface DaemonRemoteDesktopControlProps {
  ws: WsClient | null;
  serverId: string | null;
  serverName?: string | null;
  daemonOnline: boolean;
  onOpen(machine: MachineListItem): void;
  /** Icon only, for a toolbar that labels nothing else either. */
  compact?: boolean;
  /**
   * Whether this mount point has room for the one-time login-screen setup
   * beside the control. Separate from `compact`, which is only about labels: a
   * desktop toolbar shows icons and still has room, the mobile status bar has
   * labels neither way and no room at all.
   */
  offerLoginScreenSetup?: boolean;
  /**
   * Controlled machines this user can reach. Supplied by a caller that already
   * has them; otherwise read from the shared machine list, so every toolbar
   * that mounts this control shares one request.
   */
  machines?: readonly MachineListItem[];
  /**
   * Whether this user may set remote desktop up on this daemon's computer: its
   * owner, not someone it is shared with. The install command minted for this
   * daemon and the machine link are both owner-only on the server.
   */
  canSetUp?: boolean;
  /**
   * Authenticated user/baseUrl scope. Isolates daemon capability cache across accounts.
   */
  accountScope?: string | null;
}

export interface ResolveServerRemoteDesktopTargetInput {
  serverId: string | null | undefined;
  serverName?: string | null;
  daemonOnline: boolean;
  capabilities?: readonly string[];
  machines: readonly MachineListItem[];
}

export interface ServerRemoteDesktopTargetResolution {
  target: MachineListItem | null;
  linkedNode: MachineListItem | null;
  linkedOpenable: boolean;
  ready: boolean;
  unavailableReason: 'no_server' | 'offline' | 'unavailable' | null;
}

/**
 * Resolve the Remote Desktop target for the currently selected server:
 * prefer an openable linked controlled node on the same machine so sign-in
 * screens stay unified, or fall back to the daemon's built-in Remote Desktop.
 */
export function resolveServerRemoteDesktopTarget({
  serverId,
  serverName,
  daemonOnline,
  capabilities = [],
  machines,
}: ResolveServerRemoteDesktopTargetInput): ServerRemoteDesktopTargetResolution {
  const ready = capabilities.includes(REMOTE_DESKTOP_CAPABILITY);
  if (!serverId) {
    return {
      target: null,
      linkedNode: null,
      linkedOpenable: false,
      ready,
      unavailableReason: 'no_server',
    };
  }
  const linkedNode = machines.find((machine) => machine.hostServerId === serverId) ?? null;
  const linkedOpenable = linkedNode !== null && canOpenRemoteDesktopMachine(linkedNode);
  if (!daemonOnline) {
    return {
      target: null,
      linkedNode,
      linkedOpenable,
      ready,
      unavailableReason: 'offline',
    };
  }
  if (linkedOpenable && linkedNode) {
    return {
      target: linkedNode,
      linkedNode,
      linkedOpenable: true,
      ready,
      unavailableReason: null,
    };
  }
  if (ready) {
    return {
      target: daemonRemoteDesktopMachine(serverId, serverName ?? null),
      linkedNode,
      linkedOpenable: false,
      ready: true,
      unavailableReason: null,
    };
  }
  return {
    target: null,
    linkedNode,
    linkedOpenable: false,
    ready: false,
    unavailableReason: linkedNode && !linkedNode.online ? 'offline' : 'unavailable',
  };
}

/**
 * Remote control for the daemon's own machine.
 *
 * A daemon has no entry in the controlled-machine list, so its remote-desktop
 * state comes from the capabilities it advertises in `daemon.hello`: an
 * `installable` capability (`REMOTE_DESKTOP_INSTALLABLE_CAPABILITY` for
 * Windows and Linux, which share the same repair-by-self-upgrade mechanism;
 * `REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY` under its own name for macOS,
 * which installs by publishing into a component store instead) means "this
 * host could serve remote control but needs one install/repair step first",
 * and the capability itself means "the native worker is installed and
 * verified". Both installable capabilities resolve to the same generic,
 * field-less `REMOTE_DESKTOP_INSTALL_MSG.REQUEST` on click; the
 * daemon/controlled-node side already branches on its own platform to run the
 * right install path.
 *
 * A daemon that serves neither (Linux and macOS: their remote desktop is the
 * IM.codes controlled node on the same computer) still gets the button. It
 * opens the controlled node linked to this daemon (`hostServerId`) when that
 * node can serve a session, and otherwise opens DaemonRemoteDesktopSetup,
 * which asks for what is missing: an install, a permission, or the one-time
 * link to an already-installed node. Right-click reopens that setup to change
 * the link.
 */
function isWsSendable(ws: WsClient | null | undefined): boolean {
  if (!ws) return false;
  if ('connected' in ws && typeof (ws as { connected?: unknown }).connected === 'boolean') {
    if (!(ws as { connected: boolean }).connected) return false;
  }
  const raw = (ws as unknown as { ws?: { readyState?: number } | null }).ws;
  if (raw && typeof raw === 'object' && typeof raw.readyState === 'number') {
    if (raw.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
      return false;
    }
  }
  return typeof ws.send === 'function';
}

function trySendInstallRequest(ws: WsClient | null | undefined, msg: object): boolean {
  if (!isWsSendable(ws)) return false;
  const urgent = (ws as unknown as { sendUrgent?: (m: object) => void })?.sendUrgent;
  if (typeof urgent === 'function') {
    try {
      urgent.call(ws, msg);
      return true;
    } catch {
      return false;
    }
  }
  if (typeof ws?.send === 'function') {
    try {
      ws.send(msg);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function DaemonRemoteDesktopControl({
  ws,
  serverId,
  serverName,
  daemonOnline,
  onOpen,
  compact = false,
  offerLoginScreenSetup = true,
  machines,
  canSetUp = true,
  accountScope,
}: DaemonRemoteDesktopControlProps) {
  const { t } = useTranslation();

  // Bind connection strictly to the current serverId to avoid reading or persisting cross-server snapshots
  const matchingWs = ws && serverId && (typeof ws.targetsServer !== 'function' || ws.targetsServer(serverId))
    ? ws
    : null;

  const normalizedServerId = serverId ?? null;
  const normalizedAccountScope = accountScope ?? null;

  const [activeServerId, setActiveServerId] = useState<string | null>(normalizedServerId);
  const [activeAccountScope, setActiveAccountScope] = useState<string | null>(normalizedAccountScope);
  const [activeWs, setActiveWs] = useState<WsClient | null>(matchingWs);
  const [activeCanSetUp, setActiveCanSetUp] = useState<boolean>(canSetUp);

  const installOperationEpochRef = useRef(0);
  const unmountedRef = useRef(false);

  const [capabilities, setCapabilities] = useState<readonly string[]>(() => {
    if (!serverId) return [];
    if (matchingWs) {
      const live = matchingWs.getDaemonCapabilitySnapshot()?.capabilities;
      if (live) return live;
    }
    return accountScope ? readCachedDaemonCapabilities(serverId, { accountScope }) ?? [] : [];
  });
  const [install, setInstall] = useState<{ state: RemoteDesktopInstallState; error?: string } | null>(null);
  const [loginScreen, setLoginScreen] = useState<
    { state: RemoteDesktopLoginScreenState; error?: string } | null
  >(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const sharedMachines = useMachines();
  const machineList = machines ?? sharedMachines.machines;

  // Synchronous state alignment during render when switching serverId, accountScope, connection, or permissions
  if (
    normalizedServerId !== activeServerId
    || normalizedAccountScope !== activeAccountScope
    || activeWs !== matchingWs
    || activeCanSetUp !== canSetUp
  ) {
    setActiveServerId(normalizedServerId);
    setActiveAccountScope(normalizedAccountScope);
    setActiveWs(matchingWs);
    setActiveCanSetUp(canSetUp);
    installOperationEpochRef.current += 1;

    const initialCapabilities = (() => {
      if (!serverId) return [];
      if (matchingWs) {
        const live = matchingWs.getDaemonCapabilitySnapshot()?.capabilities;
        if (live) return live;
      }
      return accountScope ? readCachedDaemonCapabilities(serverId, { accountScope }) ?? [] : [];
    })();
    setCapabilities(initialCapabilities);
    setInstall(null);
    setLoginScreen(null);
    setSetupOpen(false);
  }

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      installOperationEpochRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!serverId) {
      setCapabilities([]);
      return;
    }
    const live = matchingWs?.getDaemonCapabilitySnapshot();
    if (live?.capabilities) {
      setCapabilities(live.capabilities);
      if (accountScope) {
        writeCachedDaemonCapabilities(serverId, live.capabilities, { accountScope });
      }
    } else {
      const cached = accountScope ? readCachedDaemonCapabilities(serverId, { accountScope }) : null;
      if (cached !== null) {
        setCapabilities(cached);
      } else {
        setCapabilities([]);
      }
    }
    if (!matchingWs) return;
    return matchingWs.onDaemonCapabilitySnapshot((snapshot) => {
      if (unmountedRef.current) return;
      if (snapshot && typeof snapshot === 'object' && 'capabilities' in snapshot && Array.isArray((snapshot as { capabilities: unknown }).capabilities)) {
        const caps = (snapshot as { capabilities: readonly string[] }).capabilities;
        setCapabilities(caps);
        if (accountScope) {
          writeCachedDaemonCapabilities(serverId, caps, { accountScope });
        }
        if (caps.length === 0) {
          setInstall(null);
          setLoginScreen(null);
          installOperationEpochRef.current += 1;
        }
      } else if (!snapshot || (snapshot as { capabilities?: unknown }).capabilities === null) {
        // Snapshot cleared: clean up in-progress install operation so recovery doesn't stay locked
        setInstall(null);
        setLoginScreen(null);
        installOperationEpochRef.current += 1;
      }
    });
  }, [matchingWs, serverId, accountScope, canSetUp]);

  useEffect(() => {
    if (!matchingWs) return;
    return matchingWs.onMessage((message) => {
      if (unmountedRef.current) return;
      const type = (message as { type?: unknown })?.type;
      if (
        type === DAEMON_MSG.DISCONNECTED
        || type === 'daemon.disconnect'
        || type === 'daemon.disconnected'
        || type === 'daemon.offline'
      ) {
        setInstall(null);
        setLoginScreen(null);
        installOperationEpochRef.current += 1;
        return;
      }
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
  }, [matchingWs, serverId, accountScope, canSetUp]);

  const {
    target: resolvedTarget,
    linkedNode,
    linkedOpenable,
    ready,
  } = resolveServerRemoteDesktopTarget({
    serverId,
    serverName,
    daemonOnline,
    capabilities,
    machines: machineList,
  });

  // A completed login-screen install enrolled a node for this machine; pick it
  // up without the user reloading, since it is what the button steers to next.
  useEffect(() => {
    if (loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.COMPLETED) {
      void sharedMachines.refetch();
    }
  }, [loginScreen?.state]);
  // Two separate wire names for the same meaning (see the class doc comment):
  // Windows/Linux repair by self-upgrade under the legacy Windows-named
  // constant, macOS component-store install under its own. A host that
  // advertises neither is not offering anything this button could trigger.
  const installable = capabilities.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY)
    || capabilities.includes(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY);
  if (!serverId || !daemonOnline) return null;

  // A Linux or macOS daemon that can install the controlled node itself: the
  // owner confirms once, the daemon runs the same install as the copyable
  // command, and the node enrols linked to this daemon.
  const installHereTarget = canSetUp ? readControlledNodeInstallHereTarget(capabilities) : null;
  const installHere = installHereTarget && canSetUp ? {
    state: loginScreen,
    start: () => {
      if (!canSetUp) return;
      if (!matchingWs || !isWsSendable(matchingWs)) {
        return;
      }
      if (typeof matchingWs.targetsServer === 'function' && !matchingWs.targetsServer(serverId)) {
        return;
      }
      const liveCaps = matchingWs.getDaemonCapabilitySnapshot()?.capabilities;
      if (!liveCaps || !readControlledNodeInstallHereTarget(liveCaps)) {
        return;
      }
      const opEpoch = installOperationEpochRef.current;
      setLoginScreen({ state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING });
      void mintControlledNodeInstallCommand(installHereTarget, serverId)
        .then((minted) => {
          if (unmountedRef.current || installOperationEpochRef.current !== opEpoch) return;
          if (!minted.installCode || !matchingWs || (typeof matchingWs.targetsServer === 'function' && !matchingWs.targetsServer(serverId))) {
            setLoginScreen({
              state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
              error: REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED,
            });
            return;
          }
          const sent = trySendInstallRequest(matchingWs, {
            type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
            installCode: minted.installCode,
          });
          if (!sent) {
            setLoginScreen({
              state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
              error: REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED,
            });
          }
        })
        .catch(() => {
          if (unmountedRef.current || installOperationEpochRef.current !== opEpoch) return;
          setLoginScreen({
            state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
            error: REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.DOWNLOAD_FAILED,
          });
        });
    },
  } : undefined;
  const setup = setupOpen && canSetUp ? (
    <DaemonRemoteDesktopSetup
      serverId={serverId}
      serverName={serverName}
      machines={machineList}
      onClose={() => setSetupOpen(false)}
      onOpen={onOpen}
      onChanged={() => sharedMachines.refetch()}
      {...(installHere ? { installHere } : {})}
    />
  ) : null;
  // Where the daemon has no remote desktop of its own, right-click reopens the
  // setup: the only way to change which node is this computer once it opens.
  const openSetupFromContextMenu = !ready && canSetUp
    ? (event: MouseEvent) => {
      event.preventDefault();
      setSetupOpen(true);
    }
    : undefined;

  if (resolvedTarget) {
    const control = (
      <>
        <button
          class="view-toggle daemon-remote-desktop-btn"
          title={linkedOpenable && linkedNode
            ? t('remote_desktop.daemon_control_linked', { machine: linkedNode.displayName })
            : t('remote_desktop.daemon_control')}
          aria-label={linkedOpenable && linkedNode
            ? t('remote_desktop.daemon_control_linked', { machine: linkedNode.displayName })
            : t('remote_desktop.daemon_control')}
          onClick={() => onOpen(resolvedTarget)}
          onContextMenu={openSetupFromContextMenu}
        >
          <RemoteDesktopGlyphIcon size={17} />{compact ? '' : ` ${t('remote_desktop.daemon_control')}`}
        </button>
        {setup}
      </>
    );
    const installing = loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING
      || loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING;
    // Only where there is room, and only while no controlled node already shares
    // this machine — in which case that node serves the sign-in screen already.
    // Also restricted strictly to users who can set up (owner only, never viewers).
    if (!offerLoginScreenSetup || linkedNode || !ready || !canSetUp) return control;
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
            if (!canSetUp) return;
            if (!matchingWs || !isWsSendable(matchingWs)) {
              return;
            }
            if (typeof matchingWs.targetsServer === 'function' && !matchingWs.targetsServer(serverId)) {
              return;
            }
            const liveCaps = matchingWs.getDaemonCapabilitySnapshot()?.capabilities;
            if (!liveCaps || !liveCaps.includes(REMOTE_DESKTOP_CAPABILITY)) {
              return;
            }
            if (!window.confirm(t('remote_desktop.install_confirm', {
              server: serverName ?? serverId ?? '',
            }))) return;
            const opEpoch = installOperationEpochRef.current;
            setLoginScreen({ state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING });
            void mintControlledNodeExecutableTicket({ os: 'win', arch: 'x64' }, serverId)
              .then((minted) => {
                if (unmountedRef.current || installOperationEpochRef.current !== opEpoch) return;
                if (!minted.ticket || !matchingWs || (typeof matchingWs.targetsServer === 'function' && !matchingWs.targetsServer(serverId))) {
                  setLoginScreen({
                    state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
                    error: 'download_failed',
                  });
                  return;
                }
                const sent = trySendInstallRequest(matchingWs, {
                  type: REMOTE_DESKTOP_LOGIN_SCREEN_MSG.REQUEST,
                  ticket: minted.ticket,
                });
                if (!sent) {
                  setLoginScreen({
                    state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
                    error: 'download_failed',
                  });
                }
              })
              .catch(() => {
                if (unmountedRef.current || installOperationEpochRef.current !== opEpoch) return;
                setLoginScreen({
                  state: REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED,
                  error: 'download_failed',
                });
              });
          }}
        >
          {installing
            ? <><span class="connecting-dot" />{compact ? '' : ` ${loginScreen?.state === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING
              ? t('remote_desktop.login_screen_waiting')
              : t('remote_desktop.login_screen_downloading')}`}</>
            : `🔒${compact ? '' : ` ${t(failed ? 'remote_desktop.login_screen_retry' : 'remote_desktop.login_screen_enable')}`}`}
        </button>
      </>
    );
  }

  if (!installable) {
    // Linux/macOS daemon: its remote desktop is the controlled node on this
    // computer. Nothing openable is linked yet, so the click says what is
    // missing instead of the button being absent.
    if (!canSetUp) return null;
    return (
      <>
        <button
          class="view-toggle daemon-remote-desktop-btn is-setup-required"
          title={linkedNode
            ? t('remote_desktop.daemon_control_linked', { machine: linkedNode.displayName })
            : t('remote_desktop.setup_button_hint')}
          aria-label={linkedNode
            ? t('remote_desktop.daemon_control_linked', { machine: linkedNode.displayName })
            : t('remote_desktop.setup_button_hint')}
          onClick={() => setSetupOpen(true)}
        >
          <RemoteDesktopGlyphIcon size={17} />{compact ? '' : ` ${t('remote_desktop.daemon_control')}`}
        </button>
        {setup}
      </>
    );
  }

  if (!canSetUp) return null;

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
        if (!canSetUp) return;
        if (!matchingWs || !isWsSendable(matchingWs)) {
          return;
        }
        if (typeof matchingWs.targetsServer === 'function' && !matchingWs.targetsServer(serverId)) {
          return;
        }
        const liveCaps = matchingWs.getDaemonCapabilitySnapshot()?.capabilities;
        if (!liveCaps || (!liveCaps.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY) && !liveCaps.includes(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY))) {
          return;
        }
        if (!window.confirm(t('remote_desktop.install_confirm', {
          server: serverName ?? serverId ?? '',
        }))) return;
        setInstall({ state: REMOTE_DESKTOP_INSTALL_STATE.DOWNLOADING });
        const sent = trySendInstallRequest(matchingWs, { type: REMOTE_DESKTOP_INSTALL_MSG.REQUEST });
        if (!sent) {
          setInstall({
            state: REMOTE_DESKTOP_INSTALL_STATE.FAILED,
            error: 'download_failed',
          });
        }
      }}
    >
      {downloading
        ? <><span class="connecting-dot" />{compact ? '' : ` ${t('remote_desktop.installing')}`}</>
        : <>⬇{compact ? '' : ` ${t(failed ? 'remote_desktop.install_retry' : 'remote_desktop.install_worker')}`}</>}
    </button>
  );
}
