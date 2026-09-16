import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_STOP_ORIGIN } from '@shared/remote-desktop.js';
import { listControllableMachines, type MachineListItem } from '../api/machines.js';
import { dismissHtmlSplashForDirectEntry } from '../html-splash.js';
import { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import {
  activateRemoteDesktopWorkspaceTab,
  closeRemoteDesktopWorkspace,
  closeRemoteDesktopWorkspaceHost,
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
  reorderRemoteDesktopWorkspaceHost,
} from '../remote-desktop-workspace-state.js';
import { RemoteDesktopWorkspace } from './RemoteDesktopWorkspace.js';
import { useQuickData } from './QuickInputPanel.js';

/** How long a freshly opened tab keeps looking for a usable host. */
export const REMOTE_DESKTOP_STANDALONE_RETRY_WINDOW_MS = 20_000;
export const REMOTE_DESKTOP_STANDALONE_RETRY_INTERVAL_MS = 1_500;

/**
 * A single machine popped out into its own browser window.
 *
 * This used to render one bare, unremovable `RemoteDesktopPanel` -- a window
 * that could only ever show the one machine it was opened for, with no way
 * to bring another machine into the SAME window the way the inline app and
 * the wall window both already let you. It now hosts the same tabbed
 * `RemoteDesktopWorkspace` they use, seeded with this window's own machine as
 * the first tab, so its "+" adds a second remote desktop right here instead
 * of forcing a trip back to the main app (or yet another popped-out window)
 * for anything beyond the first machine.
 */
export function RemoteDesktopStandalone({
  serverId,
  retryWindowMs = REMOTE_DESKTOP_STANDALONE_RETRY_WINDOW_MS,
  retryIntervalMs = REMOTE_DESKTOP_STANDALONE_RETRY_INTERVAL_MS,
}: {
  serverId: string;
  retryWindowMs?: number;
  retryIntervalMs?: number;
}) {
  const { t } = useTranslation();
  const [machine, setMachine] = useState<MachineListItem | null>(null);
  const [failed, setFailed] = useState(false);
  const quickData = useQuickData();
  const [attempt, setAttempt] = useState(0);
  const managerRef = useRef<RemoteDesktopConnectionManager | null>(null);
  if (!managerRef.current) managerRef.current = new RemoteDesktopConnectionManager();
  const manager = managerRef.current;
  const [workspace, setWorkspace] = useState(createRemoteDesktopWorkspaceState);
  // Whether the workspace has ever held a host, so the very first render (no
  // machine resolved yet, workspace legitimately empty) is not mistaken for
  // "the user closed everything" and closes the window before it has shown
  // anything.
  const everOpenedRef = useRef(false);

  useLayoutEffect(() => {
    dismissHtmlSplashForDirectEntry();
  }, []);

  // A tab opened a moment after a session ended can land while the host is
  // briefly listed without its remote-desktop profile (a node reconnects to
  // republish capabilities), offline for a heartbeat, or before the account
  // request settles. Failing on that single sample left the tab stuck on an
  // error until it was refreshed by hand, so keep looking for a short window.
  // Read through a ref: a re-render (quick-input data arriving, a new `t`
  // identity) must not restart the lookup and wipe its outcome.
  const translate = useRef(t);
  translate.current = t;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    setFailed(false);
    const retryOrFail = () => {
      if (!active) return;
      if (Date.now() - startedAt + retryIntervalMs > retryWindowMs) {
        setFailed(true);
        return;
      }
      timer = setTimeout(load, retryIntervalMs);
    };
    const load = () => {
      listControllableMachines()
        .then((machines) => {
          if (!active) return;
          const selected = machines.find((candidate) => candidate.serverId === serverId);
          if (!selected || !canOpenRemoteDesktopMachine(selected)) {
            retryOrFail();
            return;
          }
          document.title = translate.current('remote_desktop.title', { machine: selected.displayName });
          setMachine(selected);
        })
        .catch(retryOrFail);
    };
    load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, attempt, retryWindowMs, retryIntervalMs]);

  // Seeds the workspace with this window's own machine as soon as it
  // resolves. `openRemoteDesktopWorkspaceHost` is a no-op re-activate if the
  // host is already there, so this stays safe if `machine` is ever
  // re-resolved to a fresh object for the same server.
  useEffect(() => {
    if (!machine) return;
    setWorkspace((current) => openRemoteDesktopWorkspaceHost(current, machine));
  }, [machine]);

  // The window's only purpose is showing remote desktops. Once it has shown
  // at least one and the user closes every tab (individually, or via the
  // workspace's own "close all"), there is nothing left for the window to
  // do, so close it the same way the single-panel version always closed on
  // its one panel's own close button.
  useEffect(() => {
    if (workspace.open) {
      everOpenedRef.current = true;
      return;
    }
    if (everOpenedRef.current) window.close();
  }, [workspace.open]);

  useEffect(() => () => manager.stopAll(
    REMOTE_DESKTOP_STOP_ORIGIN.STANDALONE_UNMOUNT,
  ), [manager]);

  if (failed) {
    return (
      <div class="remote-desktop-standalone-status">
        <div role="alert">{t('controlled_nodes.error_generic')}</div>
        <button
          type="button"
          class="btn remote-desktop-standalone-retry"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >{t('remote_desktop.retry')}</button>
      </div>
    );
  }
  if (!workspace.open) {
    return <div class="remote-desktop-standalone-status" role="status">{t('controlled_nodes.loading')}</div>;
  }
  return (
    <RemoteDesktopWorkspace
      state={workspace}
      manager={manager}
      quickData={quickData}
      onOpenHost={(added) => setWorkspace((current) => openRemoteDesktopWorkspaceHost(current, added))}
      onActivateTab={(tabId) => setWorkspace((current) => activateRemoteDesktopWorkspaceTab(current, tabId))}
      onCloseHost={(hostKey) => setWorkspace((current) => closeRemoteDesktopWorkspaceHost(current, hostKey))}
      onReorderHost={(hostKey, direction) => setWorkspace((current) => (
        reorderRemoteDesktopWorkspaceHost(current, hostKey, direction)
      ))}
      onCloseWorkspace={() => setWorkspace((current) => closeRemoteDesktopWorkspace(current))}
    />
  );
}
