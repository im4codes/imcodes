import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  controlledNodeDownloadErrorKey,
  createControlledNodeRemoteInstallLink,
  createControlledNodeInstallCommand,
  downloadControlledNodeExecutable,
  beginControlledNodeDesktopDownload,
} from '../api.js';
import {
  artifactSelectionKey,
  buildControlledNodeDownloadTargets,
  installMachineRemoteDesktopWorker,
  listAvailableExecutables,
  renameMachine,
  revokeMachine,
  setMachineAutoUnlock,
  setMachineExecEnabled,
  type ControlledNodeArtifactMetadata,
  type ControlledNodeArtifactSelection,
  type ControlledNodeOs,
} from '../api/machines.js';
import { CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY } from '@shared/controlled-node-auto-unlock.js';
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY } from '@shared/remote-desktop-install.js';
import { REMOTE_DESKTOP_CAPABILITY } from '@shared/remote-desktop.js';
import { MACHINE_IDENTITY_UNAVAILABLE, normalizeMachineDisplayName } from '@shared/machine-reference.js';
import { formatByteSize } from '../util/byte-size.js';
import { copyToClipboard } from '../util/clipboard.js';
import { useMachines } from '../hooks/useMachines.js';
import { isNative } from '../native.js';
import { ShareSessionDialog } from './ShareSessionDialog.js';
import type { MachineListItem } from '../api/machines.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import { RemoteDesktopReadiness } from './RemoteDesktopReadiness.js';

/**
 * Auto unlock exists only where the remote-desktop worker does: it is that
 * worker that holds the secret and types it at the sign-in desktop. Offering
 * it on a node that cannot run one would promise something unreachable.
 */
function canConfigureAutoUnlock(machine: MachineListItem): boolean {
  return (machine.accessRole ?? 'owner') === 'owner'
    && Boolean(machine.capabilities?.includes(CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY));
}

function canInstallRemoteDesktopWorker(machine: MachineListItem): boolean {
  return machineAccessRole(machine) === 'owner'
    && machine.online
    && !machine.updateAvailable
    && Boolean(machine.capabilities?.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY))
    && !machine.capabilities?.includes(REMOTE_DESKTOP_CAPABILITY);
}

/**
 * Presence is DB-backed and changes independently of this browser after an
 * installer starts. Keep the open management panel fresh so a first install
 * moves from offline to online without requiring a second installer run or a
 * manual refresh.
 */
export const CONTROLLED_NODE_PRESENCE_REFRESH_MS = 5_000;

function formatExpiryTime(expiresAt: number, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(expiresAt));
  } catch {
    return new Date(expiresAt).toLocaleString();
  }
}

function artifactMetaLine(
  artifact: ControlledNodeArtifactMetadata | undefined,
  t: (key: string, opts?: Record<string, string>) => string,
): string | null {
  if (!artifact) return null;
  const parts: string[] = [];
  parts.push(artifact.arch);
  if (artifact.sizeBytes > 0) parts.push(formatByteSize(artifact.sizeBytes));
  if (parts.length === 0) return null;
  return t('controlled_nodes.artifact_meta', { detail: parts.join(' · ') });
}

function downloadLabel(
  target: ControlledNodeArtifactSelection,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  return t('controlled_nodes.download_target', {
    os: t(`controlled_nodes.os_${target.os}`),
    arch: target.arch,
  });
}

function findArtifactForTarget(
  artifacts: ControlledNodeArtifactMetadata[],
  target: ControlledNodeArtifactSelection,
): ControlledNodeArtifactMetadata | undefined {
  return artifacts.find((a) => a.os === target.os && a.arch === target.arch);
}

function machineAccessRole(machine: MachineListItem): 'owner' | 'viewer' | 'participant' {
  // The field is optional on the wire so a newly upgraded Web remains usable
  // with an older Server, whose machine list was owner-only.
  return machine.accessRole ?? 'owner';
}

const PLATFORM_PRESENTATION: Record<ControlledNodeOs, { glyph: string; name: string }> = {
  win: { glyph: '⊞', name: 'Windows' },
  mac: { glyph: '⌘', name: 'macOS' },
  linux: { glyph: '◇', name: 'Linux' },
};

export interface ControlledNodesPanelProps {
  onOpenRemoteDesktop?(machine: MachineListItem): void;
  onOpenRemoteDesktopWall?(): void;
}

const CONTROLLED_NODES_MOBILE_ACTIONS_MAX_WIDTH = 640;

export function ControlledNodesPanel({
  onOpenRemoteDesktop,
  onOpenRemoteDesktopWall,
}: ControlledNodesPanelProps) {
  const { t, i18n } = useTranslation();
  const { machines, loaded, loading, error, refetch } = useMachines();

  const [artifacts, setArtifacts] = useState<ControlledNodeArtifactMetadata[]>([]);
  const [downloadTargets, setDownloadTargets] = useState<ControlledNodeArtifactSelection[]>([]);
  const [availLoading, setAvailLoading] = useState(true);
  const [availError, setAvailError] = useState<string | null>(null);

  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [ticketExpiryByKey, setTicketExpiryByKey] = useState<Partial<Record<string, number>>>({});
  const [linkingKey, setLinkingKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [commandKey, setCommandKey] = useState<string | null>(null);
  const [copiedCommandKey, setCopiedCommandKey] = useState<string | null>(null);
  const [linkExpiryByKey, setLinkExpiryByKey] = useState<Partial<Record<string, number>>>({});
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [actionError, setActionError] = useState<string | null>(null);
  const [presenceRefreshFailed, setPresenceRefreshFailed] = useState(error != null);
  const [manualPresenceRefresh, setManualPresenceRefresh] = useState(false);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  // The typed secret lives here only until the request returns, then is cleared.
  const [autoUnlockServerId, setAutoUnlockServerId] = useState<string | null>(null);
  const [autoUnlockValue, setAutoUnlockValue] = useState('');
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [sharingMachine, setSharingMachine] = useState<MachineListItem | null>(null);
  const [mobileActions, setMobileActions] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= CONTROLLED_NODES_MOBILE_ACTIONS_MAX_WIDTH,
  );
  const [mobileActionMenuServerId, setMobileActionMenuServerId] = useState<string | null>(null);
  const mobileActionMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileActionMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const presenceMountedRef = useRef(true);

  const sortedTargets = useMemo(() => downloadTargets, [downloadTargets]);
  const availableOses = useMemo(
    () => [...new Set(downloadTargets.map((d) => d.os))],
    [downloadTargets],
  );

  const refreshAvailability = useCallback(() => {
    setAvailLoading(true);
    setAvailError(null);
    listAvailableExecutables()
      .then((res) => {
        setArtifacts(res.artifacts);
        setDownloadTargets(buildControlledNodeDownloadTargets(res));
      })
      .catch(() => setAvailError(t('controlled_nodes.availability_error')))
      .finally(() => setAvailLoading(false));
  }, [t]);

  useEffect(() => { refreshAvailability(); }, [refreshAvailability]);

  useEffect(() => {
    const updateMobileActions = (): void => {
      const nextMobileActions = window.innerWidth <= CONTROLLED_NODES_MOBILE_ACTIONS_MAX_WIDTH;
      setMobileActions(nextMobileActions);
      if (!nextMobileActions) setMobileActionMenuServerId(null);
    };
    window.addEventListener('resize', updateMobileActions);
    return () => window.removeEventListener('resize', updateMobileActions);
  }, []);

  const closeMobileActionMenu = useCallback((restoreFocus = false): void => {
    setMobileActionMenuServerId(null);
    if (restoreFocus) mobileActionMenuTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!mobileActionMenuServerId) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target
        && !mobileActionMenuPanelRef.current?.contains(target)
        && !mobileActionMenuTriggerRef.current?.contains(target)) {
        closeMobileActionMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMobileActionMenu(true);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeMobileActionMenu, mobileActionMenuServerId]);

  useEffect(() => {
    presenceMountedRef.current = true;
    return () => { presenceMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (error) setPresenceRefreshFailed(true);
  }, [error]);

  const refreshPresence = useCallback(async (): Promise<void> => {
    try {
      await refetch();
      if (presenceMountedRef.current) setPresenceRefreshFailed(false);
    } catch {
      // Keep the last known machine list visible and contain the rejection at
      // this boundary. A failed refresh must never become an operation error
      // or an unhandled rejection interpreted as a failed app update.
      if (presenceMountedRef.current) setPresenceRefreshFailed(true);
    }
  }, [refetch]);

  useEffect(() => {
    const refreshQuietly = (): void => {
      void refreshPresence();
    };
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') refreshQuietly();
    };
    refreshQuietly();
    const timer = window.setInterval(refreshQuietly, CONTROLLED_NODE_PRESENCE_REFRESH_MS);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refreshPresence]);

  const refreshPresenceManually = useCallback(async (): Promise<void> => {
    if (manualPresenceRefresh) return;
    setManualPresenceRefresh(true);
    try {
      await refreshPresence();
    } finally {
      setManualPresenceRefresh(false);
    }
  }, [manualPresenceRefresh, refreshPresence]);

  const onDownload = async (target: ControlledNodeArtifactSelection) => {
    const key = artifactSelectionKey(target);
    setDownloadingKey(key);
    setDownloadError(null);
    let desktopWindow: Window | null = null;
    if (!isNative()) {
      try {
        desktopWindow = beginControlledNodeDesktopDownload();
      } catch (err) {
        setDownloadError(t(controlledNodeDownloadErrorKey(err)));
        setDownloadingKey(null);
        return;
      }
    }
    try {
      const ticket = await downloadControlledNodeExecutable(target, { desktopWindow });
      setTicketExpiryByKey((prev) => ({ ...prev, [key]: ticket.expiresAt }));
    } catch (err) {
      setDownloadError(t(controlledNodeDownloadErrorKey(err)));
    } finally {
      setDownloadingKey(null);
    }
  };

  // Clearing the "Copied" flash on unmount keeps the timer from calling
  // setState against a torn-down component when the panel closes quickly.
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  /**
   * Mint a long-lived link and copy it, without navigating anywhere.
   *
   * This is the whole point of the remote-install mode: the operator is not at
   * the target machine, so the useful artifact is a string they can paste into
   * a chat and open over there. Downloading here and transferring the binary
   * would need the very remote tool they are trying to install.
   */
  /**
   * Copy the one-line install command.
   *
   * For a machine that has a terminal but no convenient browser: a headless
   * Linux box, or a Windows host reached over RDP where pasting a line into a
   * shell beats driving a browser. The command carries a short code rather than
   * the download ticket, so it can be read off a screen or dictated.
   */
  const onCopyInstallCommand = async (target: ControlledNodeArtifactSelection) => {
    const key = artifactSelectionKey(target);
    if (commandKey) return;
    setCommandKey(key);
    setDownloadError(null);
    try {
      const minted = await createControlledNodeInstallCommand(target);
      const copied = await new Promise<boolean>((resolve) => {
        copyToClipboard(minted.command, () => resolve(true), () => resolve(false));
      });
      if (!copied) {
        setDownloadError(t('controlled_nodes.copy_install_command_clipboard_error'));
        return;
      }
      setCopiedCommandKey(key);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        setCopiedCommandKey(null);
        copiedTimerRef.current = null;
      }, 4000);
    } catch (err) {
      const errorKey = controlledNodeDownloadErrorKey(err);
      setDownloadError(t(errorKey === 'controlled_nodes.download_error'
        ? 'controlled_nodes.copy_install_command_error'
        : errorKey));
    } finally {
      setCommandKey(null);
    }
  };

  const onCopyInstallLink = async (target: ControlledNodeArtifactSelection) => {
    const key = artifactSelectionKey(target);
    if (linkingKey) return;
    setLinkingKey(key);
    setDownloadError(null);
    try {
      const link = await createControlledNodeRemoteInstallLink(target);
      const copied = await new Promise<boolean>((resolve) => {
        copyToClipboard(link.url, () => resolve(true), () => resolve(false));
      });
      if (!copied) {
        setDownloadError(t('controlled_nodes.copy_install_link_clipboard_error'));
        return;
      }
      // Do not retain or render the bearer URL. Only the non-secret expiry is
      // kept after the clipboard confirms that the operator received it.
      setLinkExpiryByKey((prev) => ({ ...prev, [key]: link.expiresAt }));
      setCopiedKey(key);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        setCopiedKey(null);
        copiedTimerRef.current = null;
      }, 4000);
    } catch (err) {
      const errorKey = controlledNodeDownloadErrorKey(err);
      setDownloadError(t(errorKey === 'controlled_nodes.download_error'
        ? 'controlled_nodes.copy_install_link_error'
        : errorKey));
    } finally {
      setLinkingKey(null);
    }
  };

  const onToggleExec = async (serverId: string, next: boolean) => {
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await setMachineExecEnabled(serverId, next);
    } catch {
      setActionError(t('controlled_nodes.error_generic'));
      setBusyServerId(null);
      return;
    }
    await refreshPresence();
    setBusyServerId(null);
  };

  const onInstallRemoteDesktopWorker = async (serverId: string) => {
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await installMachineRemoteDesktopWorker(serverId);
    } catch {
      setActionError(t('remote_desktop.install_failed'));
      setBusyServerId(null);
      return;
    }
    await refreshPresence();
    setBusyServerId(null);
  };

  const startAutoUnlock = (serverId: string) => {
    setActionError(null);
    setAutoUnlockServerId(serverId);
    setAutoUnlockValue('');
  };

  const cancelAutoUnlock = () => {
    setAutoUnlockServerId(null);
    setAutoUnlockValue('');
  };

  const submitAutoUnlock = async (serverId: string, secret: string | null) => {
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await setMachineAutoUnlock(serverId, secret);
    } catch {
      setActionError(t('controlled_nodes.error_generic'));
      setBusyServerId(null);
      return;
    } finally {
      // The typed secret never stays in component state after the request.
      setAutoUnlockValue('');
    }
    setAutoUnlockServerId(null);
    await refreshPresence();
    setBusyServerId(null);
  };

  const startRename = (serverId: string, displayName: string) => {
    setActionError(null);
    setEditingServerId(serverId);
    setRenameValue(displayName);
  };

  const cancelRename = () => {
    setEditingServerId(null);
    setRenameValue('');
  };

  const onRename = async (serverId: string) => {
    const displayName = normalizeMachineDisplayName(renameValue);
    if (!displayName) {
      setActionError(t('controlled_nodes.rename_invalid'));
      return;
    }
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await renameMachine(serverId, displayName);
      cancelRename();
    } catch {
      setActionError(t('controlled_nodes.error_generic'));
      setBusyServerId(null);
      return;
    }
    await refreshPresence();
    setBusyServerId(null);
  };

  const onRevoke = async (serverId: string) => {
    if (!window.confirm(t('controlled_nodes.revoke_confirm'))) return;
    setActionError(null);
    setBusyServerId(serverId);
    try {
      await revokeMachine(serverId);
    } catch {
      setActionError(t('controlled_nodes.error_generic'));
      setBusyServerId(null);
      return;
    }
    await refreshPresence();
    setBusyServerId(null);
  };

  const usageOsKeys: Array<{ os: ControlledNodeOs; key: string }> = [
    { os: 'win', key: 'controlled_nodes.usage_win_run' },
    { os: 'mac', key: 'controlled_nodes.usage_mac_run' },
    { os: 'linux', key: 'controlled_nodes.usage_linux_run' },
  ];

  const showEmptyCatalog = !availLoading && !availError && sortedTargets.length === 0;
  const onlineMachineCount = machines.filter((machine) => machine.online).length;
  const execEnabledMachineCount = machines.filter((machine) => machine.execEnabled).length;

  const renderInstallAction = (machine: MachineListItem, inMobileMenu: boolean) => (
    canInstallRemoteDesktopWorker(machine) && (
      <button
        type="button"
        class="controlled-nodes-install-worker"
        disabled={busyServerId === machine.serverId}
        onClick={() => {
          if (inMobileMenu) closeMobileActionMenu();
          void onInstallRemoteDesktopWorker(machine.serverId);
        }}
      >
        {busyServerId === machine.serverId
          ? t('remote_desktop.installing')
          : t('remote_desktop.install_worker')}
      </button>
    )
  );

  const renderManagementActions = (machine: MachineListItem, inMobileMenu: boolean) => {
    const closeAfterAction = (): void => {
      if (inMobileMenu) closeMobileActionMenu();
    };
    return (
      <>
        {machineAccessRole(machine) === 'owner' ? (
          <>
            <button
              type="button"
              class="share-revoke-btn"
              disabled={busyServerId === machine.serverId}
              onClick={() => {
                closeAfterAction();
                setSharingMachine(machine);
              }}
            >
              {t('share.menu.shareTab')}
            </button>
            <button
              type="button"
              class="controlled-nodes-rename"
              disabled={busyServerId === machine.serverId || editingServerId === machine.serverId}
              title={t('common.rename')}
              onClick={() => {
                closeAfterAction();
                startRename(machine.serverId, machine.displayName);
              }}
            ><span aria-hidden="true">✎</span><span class="controlled-nodes-mobile-action-label">{t('common.rename')}</span></button>
            <button
              type="button"
              class={`controlled-nodes-exec-toggle ${machine.execEnabled ? 'is-enabled' : 'is-disabled'}`}
              disabled={busyServerId === machine.serverId}
              aria-pressed={machine.execEnabled}
              onClick={() => {
                closeAfterAction();
                void onToggleExec(machine.serverId, !machine.execEnabled);
              }}
            >
              <span class="controlled-nodes-toggle-track" aria-hidden="true"><i /></span>
              <span>{machine.execEnabled ? t('controlled_nodes.exec_on') : t('controlled_nodes.exec_off')}</span>
            </button>
            {canConfigureAutoUnlock(machine) && (autoUnlockServerId === machine.serverId ? (
              <form
                class="controlled-nodes-auto-unlock-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (autoUnlockValue) void submitAutoUnlock(machine.serverId, autoUnlockValue);
                }}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={autoUnlockValue}
                  placeholder={t('controlled_nodes.auto_unlock_placeholder')}
                  aria-label={t('controlled_nodes.auto_unlock_placeholder')}
                  onInput={(event) => setAutoUnlockValue((event.target as HTMLInputElement).value)}
                />
                <button type="submit" disabled={!autoUnlockValue || busyServerId === machine.serverId}>
                  {t('common.save')}
                </button>
                <button type="button" onClick={cancelAutoUnlock}>{t('common.cancel')}</button>
              </form>
            ) : (
              <button
                type="button"
                class="controlled-nodes-auto-unlock"
                disabled={busyServerId === machine.serverId}
                title={t('controlled_nodes.auto_unlock_hint')}
                onClick={() => {
                  if (machine.autoUnlockConfigured) {
                    closeAfterAction();
                    void submitAutoUnlock(machine.serverId, null);
                  } else {
                    startAutoUnlock(machine.serverId);
                  }
                }}
              >
                {machine.autoUnlockConfigured
                  ? t('controlled_nodes.auto_unlock_clear')
                  : t('controlled_nodes.auto_unlock_set')}
              </button>
            ))}
            <button
              type="button"
              class="controlled-nodes-revoke"
              disabled={busyServerId === machine.serverId}
              onClick={() => {
                closeAfterAction();
                void onRevoke(machine.serverId);
              }}
            >
              <span aria-hidden="true">×</span> {t('controlled_nodes.revoke')}
            </button>
          </>
        ) : (
          <span class="controlled-nodes-muted">
            {machineAccessRole(machine) === 'participant'
              ? (machine.execEnabled ? t('controlled_nodes.exec_on') : t('controlled_nodes.exec_off'))
              : t('controlled_nodes.share.view_only')}
          </span>
        )}
      </>
    );
  };

  return (
    <div class="controlled-nodes-panel">
      <div class="controlled-nodes-grid" aria-hidden="true" />

      <header class="controlled-nodes-hero">
        <div class="controlled-nodes-hero-copy">
          <span class="controlled-nodes-kicker" aria-hidden="true">
            <span class="controlled-nodes-kicker-signal" /> NODE GRID // SECURE RELAY
          </span>
          <h2>{t('controlled_nodes.title')}</h2>
        </div>
        <div class="controlled-nodes-metrics">
          <div class="controlled-nodes-metric">
            <strong>{machines.length}</strong>
            <span>{t('controlled_nodes.machines_title')}</span>
          </div>
          <div class="controlled-nodes-metric is-online">
            <strong>{onlineMachineCount}</strong>
            <span>{t('controlled_nodes.online')}</span>
          </div>
          <div class="controlled-nodes-metric is-exec">
            <strong>{execEnabledMachineCount}</strong>
            <span>{t('controlled_nodes.exec_on')}</span>
          </div>
        </div>
      </header>

      <section class="controlled-nodes-section controlled-nodes-machines-section">
        <div class="controlled-nodes-machines-header">
          <div class="controlled-nodes-section-heading">
            <span class="controlled-nodes-section-index">01</span>
            <h3>{t('controlled_nodes.machines_title')}</h3>
          </div>
          <div class="controlled-nodes-machines-actions">
            {onOpenRemoteDesktopWall && (
              <button type="button" class="controlled-nodes-wall" onClick={onOpenRemoteDesktopWall}>
                <span aria-hidden="true">▦</span>{t('remote_desktop.workspace_wall')}
              </button>
            )}
            <button
              type="button"
              class="controlled-nodes-refresh"
              onClick={() => { void refreshPresenceManually(); }}
              disabled={manualPresenceRefresh || (!loaded && loading)}
            >
              <span class={manualPresenceRefresh || (!loaded && loading) ? 'controlled-nodes-refresh-icon is-spinning' : 'controlled-nodes-refresh-icon'} aria-hidden="true">↻</span>
              {t('controlled_nodes.refresh')}
            </button>
          </div>
        </div>
        {actionError && <p class="controlled-nodes-error" role="alert">{actionError}</p>}
        {(presenceRefreshFailed || error) && (
          <p class="controlled-nodes-error controlled-nodes-presence-error" role="alert">
            {t('controlled_nodes.refresh_error')}
          </p>
        )}
        {loaded && machines.length === 0 && (
          <div class="controlled-nodes-empty">
            <span class="controlled-nodes-empty-radar" aria-hidden="true"><i /></span>
            <p>{t('controlled_nodes.empty')}</p>
          </div>
        )}
        <ul class="controlled-nodes-machine-list">
          {machines.map((m) => (
            <li key={m.serverId} class={`controlled-nodes-machine-row ${m.online ? 'is-online' : 'is-offline'}`}>
              <span class="controlled-nodes-machine-rail" aria-hidden="true" />
              <div class="controlled-nodes-machine-info">
                <div class="controlled-nodes-machine-heading">
                  {editingServerId === m.serverId ? (
                    <div class="controlled-nodes-rename-form">
                      <input
                        class="controlled-nodes-rename-input"
                        value={renameValue}
                        maxLength={120}
                        aria-label={t('controlled_nodes.rename_label')}
                        onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void onRename(m.serverId); }
                          if (e.key === 'Escape') cancelRename();
                        }}
                      />
                      <button
                        type="button"
                        class="controlled-nodes-rename-save"
                        disabled={busyServerId === m.serverId}
                        title={t('common.save')}
                        onClick={() => { void onRename(m.serverId); }}
                      >✓</button>
                      <button
                        type="button"
                        class="controlled-nodes-rename-cancel"
                        disabled={busyServerId === m.serverId}
                        title={t('common.cancel')}
                        onClick={cancelRename}
                      >×</button>
                    </div>
                  ) : (
                    <span class="controlled-nodes-machine-name">{m.displayName}</span>
                  )}
                  <span class={`controlled-nodes-status ${m.online ? 'online' : 'offline'}`}>
                    <i aria-hidden="true" />
                    {m.online ? t('controlled_nodes.online') : t('controlled_nodes.offline')}
                  </span>
                </div>
                <div class="controlled-nodes-machine-meta">
                  <code>{m.nodeId ?? MACHINE_IDENTITY_UNAVAILABLE}</code>
                  {m.os && <span>{m.os.toUpperCase()}</span>}
                  {m.daemonVersion
                    ? (
                      <span
                        class={m.updateAvailable ? 'controlled-nodes-version is-outdated' : 'controlled-nodes-version'}
                        title={m.updateAvailable
                          ? t('controlled_nodes.version_outdated')
                          : t('controlled_nodes.version_current')}
                      >
                        {t('controlled_nodes.version', { version: m.daemonVersion })}
                      </span>
                    )
                    : <span title={t('controlled_nodes.version_unknown')}>{t('controlled_nodes.version_unknown')}</span>}
                  <span>{t('controlled_nodes.access_role', { role: t(`share.role.${machineAccessRole(m)}`) })}</span>
                  {m.autoUnlockConfigured && (
                    <span
                      class="controlled-nodes-auto-unlock-badge"
                      title={t('controlled_nodes.auto_unlock_badge_hint')}
                    >{t('controlled_nodes.auto_unlock_badge')}</span>
                  )}
                </div>
                <RemoteDesktopReadiness capabilities={m.capabilities} compact />
              </div>
              <div class={`controlled-nodes-machine-actions ${mobileActions ? 'is-mobile' : 'is-desktop'}`}>
                {!mobileActions && renderInstallAction(m, false)}
                {canOpenRemoteDesktopMachine(m) && (
                  <button
                    type="button"
                    class="controlled-nodes-remote-desktop"
                    onClick={() => onOpenRemoteDesktop?.(m)}
                  >
                    {t('remote_desktop.open')}
                  </button>
                )}
                {mobileActions && machineAccessRole(m) === 'owner' ? (
                  <>
                    <button
                      ref={mobileActionMenuServerId === m.serverId ? mobileActionMenuTriggerRef : undefined}
                      type="button"
                      class="controlled-nodes-mobile-menu-trigger"
                      aria-haspopup="dialog"
                      aria-expanded={mobileActionMenuServerId === m.serverId}
                      aria-controls={`controlled-node-actions-${m.serverId}`}
                      aria-label={t('controlled_nodes.more_actions')}
                      title={t('controlled_nodes.more_actions')}
                      onClick={() => setMobileActionMenuServerId((current) => (
                        current === m.serverId ? null : m.serverId
                      ))}
                    ><span aria-hidden="true">⋯</span></button>
                    {mobileActionMenuServerId === m.serverId && (
                      <div
                        ref={mobileActionMenuPanelRef}
                        id={`controlled-node-actions-${m.serverId}`}
                        class="controlled-nodes-mobile-menu-panel"
                        role="dialog"
                        aria-label={t('controlled_nodes.more_actions')}
                      >
                        {renderInstallAction(m, true)}
                        {renderManagementActions(m, true)}
                      </div>
                    )}
                  </>
                ) : renderManagementActions(m, false)}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section class="controlled-nodes-section controlled-nodes-download-section">
        <div class="controlled-nodes-section-heading">
          <span class="controlled-nodes-section-index">02</span>
          <h3>{t('controlled_nodes.add_title')}</h3>
        </div>
        {availLoading && <p class="controlled-nodes-muted">{t('controlled_nodes.loading_availability')}</p>}
        {availError && <p class="controlled-nodes-error" role="alert">{availError}</p>}
        {showEmptyCatalog && (
          <p class="controlled-nodes-muted">{t('controlled_nodes.no_executables')}</p>
        )}
        <div class="controlled-nodes-downloads">
          {sortedTargets.map((target) => {
            const key = artifactSelectionKey(target);
            const meta = artifactMetaLine(findArtifactForTarget(artifacts, target), t);
            const expiry = ticketExpiryByKey[key];
            const isDownloading = downloadingKey === key;
            const isLinking = linkingKey === key;
            const isCopied = copiedKey === key;
            const isCommanding = commandKey === key;
            const isCommandCopied = copiedCommandKey === key;
            const linkExpiry = linkExpiryByKey[key];
            const rowBusy = isDownloading || isLinking || isCommanding;
            const platform = PLATFORM_PRESENTATION[target.os];
            return (
              <div key={key} class={`controlled-nodes-download-item is-${target.os}`}>
                <div class="controlled-nodes-platform">
                  <span class="controlled-nodes-platform-glyph" aria-hidden="true">{platform.glyph}</span>
                  <div class="controlled-nodes-platform-copy">
                    <strong>{platform.name}</strong>
                    {meta && <span class="controlled-nodes-artifact-meta">{meta}</span>}
                  </div>
                </div>
                <div class="controlled-nodes-download-actions">
                  <button
                    type="button"
                    class="controlled-nodes-download-btn"
                    disabled={rowBusy}
                    title={downloadLabel(target, t)}
                    onClick={() => onDownload(target)}
                  >
                    <span>{isDownloading
                      ? t('controlled_nodes.loading_download')
                      : t('controlled_nodes.download_action')}</span>
                    <span class="controlled-nodes-download-arrow" aria-hidden="true">↓</span>
                  </button>
                  <button
                    type="button"
                    class="controlled-nodes-copy-link-btn"
                    disabled={rowBusy}
                    title={t('controlled_nodes.copy_install_link_hint')}
                    aria-live="polite"
                    onClick={() => void onCopyInstallLink(target)}
                  >
                    {isLinking
                      ? t('controlled_nodes.copy_install_link_pending')
                      : isCopied
                        ? t('controlled_nodes.copy_install_link_copied')
                        : t('controlled_nodes.copy_install_link')}
                  </button>
                  <button
                    type="button"
                    class="controlled-nodes-copy-command-btn"
                    disabled={rowBusy}
                    title={t('controlled_nodes.copy_install_command_hint')}
                    aria-live="polite"
                    onClick={() => void onCopyInstallCommand(target)}
                  >
                    {isCommanding
                      ? t('controlled_nodes.copy_install_command_pending')
                      : isCommandCopied
                        ? t('controlled_nodes.copy_install_command_copied')
                        : t('controlled_nodes.copy_install_command')}
                  </button>
                </div>
                {expiry != null && (
                  <span class="controlled-nodes-ticket-expiry">
                    {t('controlled_nodes.ticket_expires_at', {
                      time: formatExpiryTime(expiry, i18n.language),
                    })}
                  </span>
                )}
                {linkExpiry != null && (
                  <span class="controlled-nodes-ticket-expiry">
                    {t('controlled_nodes.copy_install_link_expires_at', {
                      time: formatExpiryTime(linkExpiry, i18n.language),
                    })}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {downloadError && <p class="controlled-nodes-error" role="alert">{downloadError}</p>}
      </section>

      <section class="controlled-nodes-section controlled-nodes-usage-section">
        <div class="controlled-nodes-section-heading">
          <span class="controlled-nodes-section-index">03</span>
          <h3>{t('controlled_nodes.usage_title')}</h3>
        </div>
        <ol class="controlled-nodes-usage">
          {[
            t('controlled_nodes.usage_step1'),
            t('controlled_nodes.usage_step2'),
            t('controlled_nodes.usage_step3'),
            t('controlled_nodes.usage_step4'),
          ]
            .map((step, index) => (
              <li key={index}>
                <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <p>{step}</p>
              </li>
            ))}
        </ol>
        {availableOses.length > 0 && (
          <ul class="controlled-nodes-usage-os">
            {usageOsKeys
              .filter(({ os }) => availableOses.includes(os))
              .map(({ os, key }) => (
                <li key={os}>
                  <strong>{PLATFORM_PRESENTATION[os].name}</strong>
                  <span>{t(key)}</span>
                </li>
              ))}
          </ul>
        )}
      </section>

      {sharingMachine && (
        <ShareSessionDialog
          variant="machine"
          fixedTarget={{ kind: 'server', serverId: sharingMachine.serverId }}
          target={{
            serverId: sharingMachine.serverId,
            serverLabel: sharingMachine.displayName,
            sessionName: '',
            tabLabel: sharingMachine.displayName,
          }}
          remoteDesktopAccess={{
            hostId: sharingMachine.remoteDesktopHostId ?? null,
            endpointLabel: sharingMachine.displayName,
          }}
          onClose={() => setSharingMachine(null)}
          onSharesChanged={() => { void refreshPresence(); }}
        />
      )}
    </div>
  );
}
