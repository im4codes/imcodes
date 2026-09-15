import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_STOP_ORIGIN } from '@shared/remote-desktop.js';
import { listControllableMachines, type MachineListItem } from '../api/machines.js';
import { dismissHtmlSplashForDirectEntry } from '../html-splash.js';
import { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import { RemoteDesktopPanel } from './RemoteDesktopPanel.js';
import { useQuickData } from './QuickInputPanel.js';

/** How long a freshly opened tab keeps looking for a usable host. */
export const REMOTE_DESKTOP_STANDALONE_RETRY_WINDOW_MS = 20_000;
export const REMOTE_DESKTOP_STANDALONE_RETRY_INTERVAL_MS = 1_500;

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

  useEffect(() => () => managerRef.current?.stopAll(
    REMOTE_DESKTOP_STOP_ORIGIN.STANDALONE_UNMOUNT,
  ), []);

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
  if (!machine) {
    return <div class="remote-desktop-standalone-status" role="status">{t('controlled_nodes.loading')}</div>;
  }
  return (
    <RemoteDesktopPanel
      machine={machine}
      connectionManager={managerRef.current}
      quickData={quickData}
      standalone
      onClose={() => window.close()}
    />
  );
}
