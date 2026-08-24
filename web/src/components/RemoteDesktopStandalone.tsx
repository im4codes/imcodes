import { useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { listControllableMachines, type MachineListItem } from '../api/machines.js';
import { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import {
  activateRemoteDesktopWorkspaceTab,
  closeRemoteDesktopWorkspace,
  closeRemoteDesktopWorkspaceHost,
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
  reorderRemoteDesktopWorkspaceHost,
} from '../remote-desktop-workspace-state.js';
import { canOpenRemoteDesktop } from './RemoteDesktopPanel.js';
import { RemoteDesktopWorkspace } from './RemoteDesktopWorkspace.js';

export function RemoteDesktopStandalone({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [machine, setMachine] = useState<MachineListItem | null>(null);
  const [failed, setFailed] = useState(false);
  const [workspace, setWorkspace] = useState(createRemoteDesktopWorkspaceState);
  const managerRef = useRef<RemoteDesktopConnectionManager | null>(null);
  if (!managerRef.current) managerRef.current = new RemoteDesktopConnectionManager();

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
        setWorkspace((current) => openRemoteDesktopWorkspaceHost(current, selected));
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
    <RemoteDesktopWorkspace
      state={workspace}
      manager={managerRef.current}
      onOpenHost={(next) => setWorkspace((current) => openRemoteDesktopWorkspaceHost(current, next))}
      onActivateTab={(tabId) => setWorkspace((current) => activateRemoteDesktopWorkspaceTab(current, tabId))}
      onCloseHost={(hostKey) => setWorkspace((current) => closeRemoteDesktopWorkspaceHost(current, hostKey))}
      onReorderHost={(hostKey, direction) => setWorkspace((current) => (
        reorderRemoteDesktopWorkspaceHost(current, hostKey, direction)
      ))}
      onCloseWorkspace={() => {
        setWorkspace((current) => closeRemoteDesktopWorkspace(current));
        window.close();
      }}
    />
  );
}
