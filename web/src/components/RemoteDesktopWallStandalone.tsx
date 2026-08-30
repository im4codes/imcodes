import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { REMOTE_DESKTOP_STOP_ORIGIN } from '@shared/remote-desktop.js';
import { dismissHtmlSplashForDirectEntry } from '../html-splash.js';
import { RemoteDesktopConnectionManager } from '../remote-desktop-connection-manager.js';
import {
  activateRemoteDesktopWorkspaceTab,
  closeRemoteDesktopWorkspace,
  closeRemoteDesktopWorkspaceHost,
  createRemoteDesktopWorkspaceState,
  openRemoteDesktopWorkspaceHost,
  reorderRemoteDesktopWorkspaceHost,
} from '../remote-desktop-workspace-state.js';
import { RemoteDesktopWall } from './RemoteDesktopWall.js';
import { RemoteDesktopWorkspace } from './RemoteDesktopWorkspace.js';

export function RemoteDesktopWallStandalone() {
  const { t } = useTranslation();
  const managerRef = useRef<RemoteDesktopConnectionManager | null>(null);
  const [wallHostKeys, setWallHostKeys] = useState<readonly string[]>([]);
  const [workspace, setWorkspace] = useState(createRemoteDesktopWorkspaceState);
  if (!managerRef.current) managerRef.current = new RemoteDesktopConnectionManager();
  const manager = managerRef.current;
  const retainedWallHostKeys = useMemo(() => new Set(wallHostKeys), [wallHostKeys]);
  const retainedWorkspaceHostKeys = useMemo(
    () => new Set(workspace.orderedHostKeys),
    [workspace.orderedHostKeys],
  );

  useLayoutEffect(() => {
    dismissHtmlSplashForDirectEntry();
  }, []);

  useEffect(() => {
    document.title = t('remote_desktop.workspace_wall');
  }, [t]);

  // Transport lifetime belongs to the window, not to the translated title
  // effect. i18n refreshes may replace `t`; coupling cleanup to that dependency
  // previously sent STOP while the standalone window was still mounted.
  useEffect(() => () => manager.stopAll(
    REMOTE_DESKTOP_STOP_ORIGIN.STANDALONE_UNMOUNT,
  ), [manager]);

  return (
    <>
      <RemoteDesktopWall
        standalone
        manager={manager}
        retainedHostKeys={retainedWorkspaceHostKeys}
        onOpenHost={(machine) => setWorkspace((current) => (
          openRemoteDesktopWorkspaceHost(current, machine)
        ))}
        onHostKeysChange={setWallHostKeys}
        onClose={() => {
          manager.stopAll(REMOTE_DESKTOP_STOP_ORIGIN.WALL_CLOSE);
          window.close();
        }}
      />
      {workspace.open && (
        <RemoteDesktopWorkspace
          state={workspace}
          manager={manager}
          zIndex={10020}
          onOpenHost={(machine) => setWorkspace((current) => (
            openRemoteDesktopWorkspaceHost(current, machine)
          ))}
          onActivateTab={(tabId) => setWorkspace((current) => (
            activateRemoteDesktopWorkspaceTab(current, tabId)
          ))}
          onCloseHost={(hostKey) => setWorkspace((current) => (
            closeRemoteDesktopWorkspaceHost(current, hostKey)
          ))}
          onReorderHost={(hostKey, direction) => setWorkspace((current) => (
            reorderRemoteDesktopWorkspaceHost(current, hostKey, direction)
          ))}
          onCloseWorkspace={() => setWorkspace((current) => closeRemoteDesktopWorkspace(current))}
          wallHostKeys={retainedWallHostKeys}
        />
      )}
    </>
  );
}
