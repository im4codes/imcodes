import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import { MACHINE_HOST_LINK_ERROR } from '@shared/machine-reference.js';
import {
  REMOTE_DESKTOP_LOGIN_SCREEN_ERROR,
  REMOTE_DESKTOP_LOGIN_SCREEN_STATE,
  type RemoteDesktopLoginScreenState,
} from '@shared/remote-desktop-login-screen.js';
import {
  ApiError,
  controlledNodeDownloadErrorKey,
  createControlledNodeInstallCommand,
} from '../api.js';
import {
  artifactSelectionKey,
  buildControlledNodeDownloadTargets,
  installMachineRemoteDesktopWorker,
  listAvailableExecutables,
  requestMachineRemoteDesktopPermissions,
  setMachineHostServer,
  type ControlledNodeArtifactSelection,
  type ControlledNodeOs,
  type MachineListItem,
} from '../api/machines.js';
import {
  canInstallRemoteDesktopWorker,
  machineAccessRole,
  needsRemoteDesktopPermission,
} from '../controlled-node-remote-desktop.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import { copyToClipboardWhenReady } from '../util/clipboard.js';
import './daemon-remote-desktop-setup.css';

const PLATFORM_KEY: Record<ControlledNodeOs, string> = {
  linux: 'remote_desktop.platform_linux',
  mac: 'remote_desktop.platform_mac',
  win: 'remote_desktop.platform_win',
};

/** Why an automatic install did not happen, in the reader's words. */
const AUTO_INSTALL_ERROR_KEY: Record<string, string> = {
  [REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ADMIN_REQUIRED]: 'remote_desktop.setup_auto_error_admin_required',
  [REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.ELEVATION_DECLINED]: 'remote_desktop.setup_auto_error_elevation_declined',
  [REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.INSTALL_FAILED]: 'remote_desktop.setup_auto_error_install_failed',
  [REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.NOT_BOUND]: 'remote_desktop.setup_auto_error_not_bound',
  [REMOTE_DESKTOP_LOGIN_SCREEN_ERROR.UNSUPPORTED_PLATFORM]: 'remote_desktop.setup_auto_error_unsupported_platform',
};

/** How long the dialog keeps looking for the freshly installed node. */
const FOLLOW_UP_READ_INTERVAL_MS = 3_000;
const FOLLOW_UP_MAX_READS = 60;

/** How to run the copied command on each system (elevation differs). */
const USAGE_KEY: Record<ControlledNodeOs, string> = {
  linux: 'controlled_nodes.usage_linux_command',
  mac: 'controlled_nodes.usage_mac_command',
  win: 'controlled_nodes.usage_win_command',
};

export interface DaemonRemoteDesktopSetupProps {
  /** The daemon whose computer this is about. */
  serverId: string;
  serverName?: string | null;
  machines: readonly MachineListItem[];
  onClose(): void;
  onOpen(machine: MachineListItem): void;
  /** Re-read the machine list after a link, unlink or install changed it. */
  onChanged(): void | Promise<unknown>;
  /**
   * Present when this daemon can install the controlled node on its own
   * computer and the viewer is its owner: one confirmation instead of a
   * command to paste into a terminal there.
   */
  installHere?: {
    state: { state: RemoteDesktopLoginScreenState; error?: string } | null;
    start(): void;
  };
}

/**
 * Remote desktop for a daemon's own computer, when the daemon does not serve
 * it itself (Linux and macOS: the IM.codes controlled node on that computer
 * does).
 *
 * With a node linked to this daemon it shows what that node still needs (a
 * permission, its remote-desktop component, or simply to come online). With
 * none it offers the two ways to get one: an install command minted for this
 * daemon, so the node links itself when it enrolls, or a one-time pick of the
 * already-installed controlled machine that is this computer.
 */
export function DaemonRemoteDesktopSetup({
  serverId,
  serverName,
  machines,
  onClose,
  onOpen,
  onChanged,
  installHere,
}: DaemonRemoteDesktopSetupProps) {
  const { t } = useTranslation();
  const linked = machines.find((machine) => machine.hostServerId === serverId) ?? null;
  // Only the owner can link a node, and a node already linked to another
  // daemon is someone else's computer until it is unlinked there.
  const candidates = machines.filter((machine) => (
    machine.nodeId !== undefined
    && machineAccessRole(machine) === 'owner'
    && !machine.hostServerId
  ));

  const [busy, setBusy] = useState<'link' | 'unlink' | 'install' | 'permission' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [targets, setTargets] = useState<ControlledNodeArtifactSelection[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsFailed, setTargetsFailed] = useState(false);
  const [copyingKey, setCopyingKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<ControlledNodeArtifactSelection | null>(null);
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [manualRequested, setManualRequested] = useState(false);
  // Set once this dialog's automatic install finished: from then on, whatever
  // the new node still needs -- its remote-desktop component, the Mac's
  // permissions -- is asked for without another click.
  const [followUp, setFollowUp] = useState(false);
  const followUpSteps = useRef(new Set<string>());
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    if (linked) return;
    let cancelled = false;
    setTargetsLoading(true);
    setTargetsFailed(false);
    listAvailableExecutables()
      .then((availability) => {
        if (!cancelled) setTargets(buildControlledNodeDownloadTargets(availability));
      })
      .catch(() => { if (!cancelled) setTargetsFailed(true); })
      .finally(() => { if (!cancelled) setTargetsLoading(false); });
    return () => { cancelled = true; };
  }, [linked === null]);

  const autoState = installHere?.state?.state ?? null;
  useEffect(() => {
    if (autoState === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.COMPLETED) setFollowUp(true);
  }, [autoState]);

  // The node enrols a moment after the installer finishes; keep re-reading the
  // list (bounded) until it is linked here and ready to open.
  const linkedReady = linked !== null && canOpenRemoteDesktopMachine(linked);
  useEffect(() => {
    if (!followUp || linkedReady) return;
    let reads = 0;
    const timer = setInterval(() => {
      reads += 1;
      if (reads > FOLLOW_UP_MAX_READS) {
        clearInterval(timer);
        return;
      }
      void onChanged();
    }, FOLLOW_UP_READ_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [followUp, linkedReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const run = async (
    kind: NonNullable<typeof busy>,
    action: () => Promise<unknown>,
    failure: (err: unknown) => string,
  ) => {
    setError(null);
    setBusy(kind);
    try {
      await action();
      await onChanged();
    } catch (err) {
      if (mountedRef.current) setError(failure(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const copyInstallCommand = async (target: ControlledNodeArtifactSelection) => {
    if (copyingKey) return;
    setError(null);
    setCopied(null);
    setCopyingKey(artifactSelectionKey(target));
    try {
      // Engage the clipboard before awaiting the mint: iOS only allows the
      // write while the tap still counts (same as the machine list's button).
      // Minted for this daemon, so the node links itself when it enrolls.
      const pending = createControlledNodeInstallCommand(target, serverId).then((minted) => minted.command);
      const written = new Promise<boolean>((resolve) => {
        copyToClipboardWhenReady(pending, () => resolve(true), () => resolve(false));
      });
      await pending;
      if (!await written) {
        setError(t('controlled_nodes.copy_install_command_clipboard_error'));
        return;
      }
      if (mountedRef.current) setCopied(target);
    } catch (err) {
      const errorKey = controlledNodeDownloadErrorKey(err);
      setError(t(errorKey === 'controlled_nodes.download_error'
        ? 'controlled_nodes.copy_install_command_error'
        : errorKey));
    } finally {
      if (mountedRef.current) setCopyingKey(null);
    }
  };

  // Each follow-up step at most once, with the same calls the buttons below
  // (and the controlled-machine list's permission button) make.
  useEffect(() => {
    if (!followUp || !linked || busy !== null || canOpenRemoteDesktopMachine(linked)) return;
    const node = linked;
    if (canInstallRemoteDesktopWorker(node) && !followUpSteps.current.has('install')) {
      followUpSteps.current.add('install');
      void run(
        'install',
        () => installMachineRemoteDesktopWorker(node.serverId),
        () => t('remote_desktop.install_failed'),
      );
    } else if (needsRemoteDesktopPermission(node) && !followUpSteps.current.has('permission')) {
      // Raises the Screen Recording and Accessibility prompts on that Mac.
      followUpSteps.current.add('permission');
      void run(
        'permission',
        () => requestMachineRemoteDesktopPermissions(node.serverId),
        () => t('remote_desktop.request_permission_failed'),
      );
    }
  }, [followUp, linked, busy]);

  const linkedStatus = (node: MachineListItem) => {
    if (canOpenRemoteDesktopMachine(node)) {
      return (
        <button
          type="button"
          class="daemon-rd-setup-primary"
          onClick={() => {
            onOpen(node);
            onClose();
          }}
        >{t('remote_desktop.open')}</button>
      );
    }
    if (needsRemoteDesktopPermission(node)) {
      return (
        <>
          <p class="daemon-rd-setup-note">{t('remote_desktop.macos_screen_recording_guidance')}</p>
          <button
            type="button"
            class="daemon-rd-setup-primary"
            disabled={busy !== null}
            title={t('remote_desktop.request_permission_hint')}
            onClick={() => void run(
              'permission',
              () => requestMachineRemoteDesktopPermissions(node.serverId),
              () => t('remote_desktop.request_permission_failed'),
            )}
          >{busy === 'permission'
            ? t('remote_desktop.requesting_permission')
            : t('remote_desktop.request_permission')}</button>
        </>
      );
    }
    if (canInstallRemoteDesktopWorker(node)) {
      return (
        <button
          type="button"
          class="daemon-rd-setup-primary"
          disabled={busy !== null}
          onClick={() => void run(
            'install',
            () => installMachineRemoteDesktopWorker(node.serverId),
            () => t('remote_desktop.install_failed'),
          )}
        >{busy === 'install' ? t('remote_desktop.installing') : t('remote_desktop.install_worker')}</button>
      );
    }
    return (
      <p class="daemon-rd-setup-note">{node.online
        ? t('remote_desktop.setup_node_unavailable')
        : t('remote_desktop.setup_node_offline')}</p>
    );
  };

  const title = t('remote_desktop.setup_title', { server: serverName || serverId });
  return createPortal((
    <div
      class="dialog-overlay daemon-rd-setup-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="daemon-rd-setup-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div class="dialog daemon-rd-setup">
        <div class="dialog-header">
          <h2 id="daemon-rd-setup-title">{title}</h2>
          <button type="button" class="dialog-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <div class="dialog-body">
          <p class="daemon-rd-setup-intro">{t('remote_desktop.setup_intro')}</p>

          {linked ? (
            <section class="daemon-rd-setup-section" data-testid="daemon-rd-setup-linked">
              <h3>{t('remote_desktop.setup_linked_heading')}</h3>
              <div class="daemon-rd-setup-machine">{linked.displayName}</div>
              {linkedStatus(linked)}
              <button
                type="button"
                class="daemon-rd-setup-secondary"
                disabled={busy !== null}
                onClick={() => void run(
                  'unlink',
                  () => setMachineHostServer(linked.serverId, null),
                  () => t('remote_desktop.setup_unlink_failed'),
                )}
              >{t('remote_desktop.setup_unlink')}</button>
            </section>
          ) : (
            <>
              {installHere && (
                <section class="daemon-rd-setup-section" data-testid="daemon-rd-setup-auto-install">
                  <h3>{t('remote_desktop.setup_auto_heading')}</h3>
                  <p class="daemon-rd-setup-note">{t('remote_desktop.setup_auto_hint')}</p>
                  {(() => {
                    const progress = installHere.state?.state;
                    if (progress === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING
                      || progress === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING
                      || progress === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.COMPLETED) {
                      return (
                        <p class="daemon-rd-setup-note" role="status">
                          {t(progress === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.DOWNLOADING
                            ? 'remote_desktop.setup_auto_downloading'
                            : progress === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.ELEVATING
                              ? 'remote_desktop.setup_auto_elevating'
                              : 'remote_desktop.setup_auto_completed')}
                        </p>
                      );
                    }
                    if (confirmingInstall) {
                      return (
                        <div class="daemon-rd-setup-link-row">
                          <p class="daemon-rd-setup-note">
                            {t('remote_desktop.setup_auto_confirm', { server: serverName || serverId })}
                          </p>
                          <button
                            type="button"
                            class="daemon-rd-setup-primary"
                            onClick={() => {
                              setConfirmingInstall(false);
                              installHere.start();
                            }}
                          >{t('remote_desktop.setup_auto_confirm_action')}</button>
                          <button
                            type="button"
                            class="daemon-rd-setup-secondary"
                            onClick={() => setConfirmingInstall(false)}
                          >{t('common.cancel')}</button>
                        </div>
                      );
                    }
                    const failure = progress === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED
                      ? t(AUTO_INSTALL_ERROR_KEY[installHere.state?.error ?? '']
                        ?? 'remote_desktop.setup_auto_error_download_failed')
                      : null;
                    return (
                      <>
                        {failure && <p class="daemon-rd-setup-error" role="alert">{failure}</p>}
                        <button
                          type="button"
                          class="daemon-rd-setup-primary"
                          onClick={() => setConfirmingInstall(true)}
                        >{t(failure ? 'remote_desktop.setup_auto_retry' : 'remote_desktop.setup_auto_action')}</button>
                      </>
                    );
                  })()}
                </section>
              )}
              {installHere && !manualRequested && autoState !== REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED && (
                <button
                  type="button"
                  class="daemon-rd-setup-secondary"
                  onClick={() => setManualRequested(true)}
                >{t('remote_desktop.setup_auto_manual')}</button>
              )}
              {(!installHere || manualRequested || autoState === REMOTE_DESKTOP_LOGIN_SCREEN_STATE.FAILED) && (
              <section class="daemon-rd-setup-section" data-testid="daemon-rd-setup-install">
                <h3>{t('remote_desktop.setup_install_heading')}</h3>
                <p class="daemon-rd-setup-note">{t('remote_desktop.setup_install_hint')}</p>
                {targetsLoading && <p class="daemon-rd-setup-note">{t('controlled_nodes.loading_availability')}</p>}
                {targetsFailed && <p class="daemon-rd-setup-error">{t('controlled_nodes.availability_error')}</p>}
                {targets.map((target) => {
                  const key = artifactSelectionKey(target);
                  const isCopied = copied !== null && artifactSelectionKey(copied) === key;
                  return (
                    <div class="daemon-rd-setup-target" key={key}>
                      <span>{t('controlled_nodes.download_target', { os: t(PLATFORM_KEY[target.os]), arch: target.arch })}</span>
                      <button
                        type="button"
                        class="daemon-rd-setup-secondary"
                        disabled={copyingKey !== null}
                        aria-live="polite"
                        onClick={() => void copyInstallCommand(target)}
                      >{copyingKey === key
                        ? t('controlled_nodes.copy_install_command_pending')
                        : isCopied
                          ? t('controlled_nodes.copy_install_command_copied')
                          : t('controlled_nodes.copy_install_command')}</button>
                    </div>
                  );
                })}
                {copied && <p class="daemon-rd-setup-note daemon-rd-setup-usage">{t(USAGE_KEY[copied.os])}</p>}
              </section>
              )}

              <section class="daemon-rd-setup-section" data-testid="daemon-rd-setup-link">
                <h3>{t('remote_desktop.setup_link_heading')}</h3>
                <p class="daemon-rd-setup-note">{t('remote_desktop.setup_link_hint')}</p>
                {candidates.length === 0 ? (
                  <p class="daemon-rd-setup-note">{t('remote_desktop.setup_link_none')}</p>
                ) : (
                  <div class="daemon-rd-setup-link-row">
                    <select
                      value={selected}
                      aria-label={t('remote_desktop.setup_link_heading')}
                      onChange={(event) => setSelected((event.currentTarget as HTMLSelectElement).value)}
                    >
                      <option value="">{t('remote_desktop.setup_link_placeholder')}</option>
                      {candidates.map((machine) => (
                        <option key={machine.serverId} value={machine.serverId}>{machine.displayName}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      class="daemon-rd-setup-primary"
                      disabled={!selected || busy !== null}
                      onClick={() => void run(
                        'link',
                        () => setMachineHostServer(selected, serverId),
                        (err) => t(err instanceof ApiError
                          && err.code === MACHINE_HOST_LINK_ERROR.HOST_CONFLICT
                          ? 'remote_desktop.setup_link_conflict'
                          : 'remote_desktop.setup_link_failed'),
                      )}
                    >{t('remote_desktop.setup_link_action')}</button>
                  </div>
                )}
              </section>
            </>
          )}

          {error && <p class="daemon-rd-setup-error" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  ), document.body);
}
