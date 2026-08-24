import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { listControllableMachines } from '../api/machines.js';
import type { WsClient } from '../ws-client.js';
import {
  RemoteDesktopConnectionManager,
  remoteDesktopHostKey,
} from '../remote-desktop-connection-manager.js';
import {
  REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS,
  REMOTE_DESKTOP_WORKSPACE_WINDOW_ID,
  remoteDesktopWorkspaceHosts,
  type RemoteDesktopWorkspaceMachine,
  type RemoteDesktopWorkspaceState,
  type RemoteDesktopWorkspaceTabId,
} from '../remote-desktop-workspace-state.js';
import { FloatingPanel } from './FloatingPanel.js';
import { canOpenRemoteDesktop, RemoteDesktopPanel } from './RemoteDesktopPanel.js';
import './remote-desktop-workspace.css';

export interface RemoteDesktopWorkspaceProps {
  state: RemoteDesktopWorkspaceState;
  manager: RemoteDesktopConnectionManager;
  ws?: WsClient | null;
  minimized?: boolean;
  zIndex?: number;
  onFocus?(): void;
  onMinimize?(): void;
  onRestore?(): void;
  onOpenHost(machine: RemoteDesktopWorkspaceMachine): void;
  onActivateTab(tabId: RemoteDesktopWorkspaceTabId): void;
  onCloseHost(hostKey: string): void;
  onReorderHost(hostKey: string, direction: -1 | 1): void;
  onCloseWorkspace(): void;
  wallHostKeys?: ReadonlySet<string>;
}

export function RemoteDesktopWorkspace({
  state,
  manager,
  ws = null,
  minimized = false,
  zIndex,
  onFocus,
  onMinimize,
  onRestore,
  onOpenHost,
  onActivateTab,
  onCloseHost,
  onReorderHost,
  onCloseWorkspace,
  wallHostKeys = new Set(),
}: RemoteDesktopWorkspaceProps) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMachines, setPickerMachines] = useState<RemoteDesktopWorkspaceMachine[]>([]);
  const [pickerError, setPickerError] = useState(false);
  const tabButtonsRef = useRef(new Map<RemoteDesktopWorkspaceTabId, HTMLButtonElement>());
  const hosts = remoteDesktopWorkspaceHosts(state);

  useEffect(() => {
    if (!pickerOpen) return;
    let active = true;
    setPickerError(false);
    void listControllableMachines().then((machines) => {
      if (active) setPickerMachines(machines.filter(canOpenRemoteDesktop));
    }).catch(() => {
      if (active) setPickerError(true);
    });
    return () => { active = false; };
  }, [pickerOpen]);

  const activate = useCallback((tabId: RemoteDesktopWorkspaceTabId) => {
    if (tabId === state.activeTabId) return;
    manager.releaseInput(state.activeTabId);
    onActivateTab(tabId);
  }, [manager, onActivateTab, state.activeTabId]);

  const closeHost = useCallback((hostKey: string) => {
    if (!wallHostKeys.has(hostKey)) manager.stop(hostKey);
    onCloseHost(hostKey);
  }, [manager, onCloseHost, wallHostKeys]);

  const closeWorkspace = useCallback(() => {
    for (const hostKey of state.orderedHostKeys) {
      if (!wallHostKeys.has(hostKey)) manager.stop(hostKey);
    }
    onCloseWorkspace();
  }, [manager, onCloseWorkspace, state.orderedHostKeys, wallHostKeys]);

  const selectHost = useCallback((machine: RemoteDesktopWorkspaceMachine) => {
    onOpenHost(machine);
    setPickerOpen(false);
  }, [onOpenHost]);

  const tabIds = [...state.orderedHostKeys];
  const handleTabKeyDown = (event: KeyboardEvent, tabId: RemoteDesktopWorkspaceTabId) => {
    const index = tabIds.indexOf(tabId);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabIds.length) % tabIds.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabIds.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tabIds.length - 1;
    if (event.key === 'Delete') {
      event.preventDefault();
      closeHost(tabId);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTabId = tabIds[nextIndex];
    activate(nextTabId);
    requestAnimationFrame(() => tabButtonsRef.current.get(nextTabId)?.focus());
  };

  const content = (
    <div class="remote-desktop-workspace" data-active-tab={state.activeTabId}>
      <header class="remote-desktop-workspace-header">
        <strong>{t('remote_desktop.workspace_title')}</strong>
        <div class="remote-desktop-workspace-actions">
          {onMinimize && (
            <button class="remote-desktop-workspace-chrome-button" type="button" onClick={onMinimize} aria-label={t('window.minimize')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
            </button>
          )}
          <button class="remote-desktop-workspace-chrome-button is-danger" type="button" onClick={closeWorkspace} aria-label={t('remote_desktop.workspace_stop_all')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
          </button>
        </div>
      </header>

      <div class="remote-desktop-workspace-tabbar">
        <div role="tablist" aria-label={t('remote_desktop.workspace_tabs')}>
          {hosts.map(({ hostKey, machine }, index) => (
            <span class="remote-desktop-workspace-host-tab" key={hostKey}>
              <button
                class="remote-desktop-workspace-tab"
                type="button"
                role="tab"
                ref={(element) => {
                  if (element) tabButtonsRef.current.set(hostKey, element);
                  else tabButtonsRef.current.delete(hostKey);
                }}
                aria-selected={state.activeTabId === hostKey}
                tabIndex={state.activeTabId === hostKey ? 0 : -1}
                onClick={() => activate(hostKey)}
                onKeyDown={(event) => handleTabKeyDown(event, hostKey)}
              >{machine.displayName}</button>
              <button
                class="remote-desktop-workspace-icon-button"
                type="button"
                onClick={() => onReorderHost(hostKey, -1)}
                disabled={index === 0}
                aria-label={t('remote_desktop.workspace_move_left', { machine: machine.displayName })}
              ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 5-5 5 5 5" /></svg></button>
              <button
                class="remote-desktop-workspace-icon-button"
                type="button"
                onClick={() => onReorderHost(hostKey, 1)}
                disabled={index === hosts.length - 1}
                aria-label={t('remote_desktop.workspace_move_right', { machine: machine.displayName })}
              ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5 5 5-5 5" /></svg></button>
              <button
                class="remote-desktop-workspace-icon-button is-danger"
                type="button"
                onClick={() => closeHost(hostKey)}
                aria-label={t('remote_desktop.workspace_close_tab', { machine: machine.displayName })}
              ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg></button>
            </span>
          ))}
        </div>
        <button
          type="button"
          class="remote-desktop-workspace-add remote-desktop-workspace-icon-button"
          aria-expanded={pickerOpen}
          aria-label={t('remote_desktop.workspace_add')}
          onClick={() => setPickerOpen((current) => !current)}
        ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>
      </div>

      <label class="remote-desktop-workspace-mobile-selector">
        <span>{t('remote_desktop.workspace_select')}</span>
        <select value={state.activeTabId} onInput={(event) => activate(event.currentTarget.value)}>
          {hosts.map(({ hostKey, machine }) => (
            <option value={hostKey} key={hostKey}>{machine.displayName}</option>
          ))}
        </select>
      </label>

      {pickerOpen && (
        <div class="remote-desktop-workspace-picker" role="dialog" aria-label={t('remote_desktop.workspace_picker')}>
          {pickerError && <p role="alert">{t('remote_desktop.workspace_picker_failed')}</p>}
          {!pickerError && pickerMachines.length === 0 && <p>{t('remote_desktop.workspace_picker_empty')}</p>}
          {pickerMachines.map((machine) => (
            <button
              type="button"
              key={machine.serverId}
              disabled={hosts.length >= REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS
                && !state.hosts[remoteDesktopHostKey(machine)]}
              onClick={() => selectHost(machine)}
            >
              <strong>{machine.displayName}</strong>
              <span>{machine.refName}</span>
            </button>
          ))}
          {hosts.length >= REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS && (
            <p role="status">{t('remote_desktop.workspace_limit', { count: REMOTE_DESKTOP_WORKSPACE_MAX_HOSTS })}</p>
          )}
        </div>
      )}

      {hosts.map(({ hostKey, machine }) => (
        <RemoteDesktopPanel
          key={hostKey}
          machine={machine}
          connectionManager={manager}
          ws={ws}
          embedded
          active={state.activeTabId === hostKey}
          inputActive={state.activeTabId === hostKey}
          onClose={() => closeHost(hostKey)}
          onAuthorityLost={() => closeHost(hostKey)}
        />
      ))}
    </div>
  );

  return (
    <>
      <div class="remote-desktop-workspace-window" hidden={minimized}>
        <FloatingPanel
          id={REMOTE_DESKTOP_WORKSPACE_WINDOW_ID}
          title={t('remote_desktop.workspace_title')}
          onClose={closeWorkspace}
          zIndex={zIndex ?? 10020}
          onFocus={onFocus}
          defaultW={1240}
          defaultH={800}
          minW={680}
          minH={460}
          className="remote-desktop-workspace-shell"
          hideTitleBar
          dragHandleSelector=".remote-desktop-workspace-header"
        >{content}</FloatingPanel>
      </div>
      {minimized && (
        <button
          type="button"
          class="remote-desktop-minimized-dock"
          onClick={onRestore}
          aria-label={t('remote_desktop.workspace_title')}
        >{t('remote_desktop.workspace_title')} · {hosts.length}</button>
      )}
    </>
  );
}
