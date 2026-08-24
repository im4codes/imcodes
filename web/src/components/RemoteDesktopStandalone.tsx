import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { listControllableMachines, type MachineListItem } from '../api/machines.js';
import { dismissHtmlSplashForDirectEntry } from '../html-splash.js';
import { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import { canOpenRemoteDesktop, RemoteDesktopPanel } from './RemoteDesktopPanel.js';

export function RemoteDesktopStandalone({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [machine, setMachine] = useState<MachineListItem | null>(null);
  const [failed, setFailed] = useState(false);
  const managerRef = useRef<RemoteDesktopConnectionManager | null>(null);
  if (!managerRef.current) managerRef.current = new RemoteDesktopConnectionManager();

  useLayoutEffect(() => {
    dismissHtmlSplashForDirectEntry();
  }, []);

  useEffect(() => {
    let active = true;
    listControllableMachines()
      .then((machines) => {
        if (!active) return;
        const selected = machines.find((candidate) => candidate.serverId === serverId);
        if (!selected || !canOpenRemoteDesktop(selected)) {
          setFailed(true);
          return;
        }
        document.title = t('remote_desktop.title', { machine: selected.displayName });
        setMachine(selected);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => { active = false; };
  }, [serverId, t]);

  useEffect(() => () => managerRef.current?.stopAll(), []);

  if (failed) {
    return <div class="remote-desktop-standalone-status" role="alert">{t('controlled_nodes.error_generic')}</div>;
  }
  if (!machine) {
    return <div class="remote-desktop-standalone-status" role="status">{t('controlled_nodes.loading')}</div>;
  }
  return (
    <RemoteDesktopPanel
      machine={machine}
      connectionManager={managerRef.current}
      standalone
      onClose={() => window.close()}
    />
  );
}
