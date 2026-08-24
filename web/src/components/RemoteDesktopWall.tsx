import { REMOTE_DESKTOP_ACCESS_LIMITS, REMOTE_DESKTOP_WALL_OPERATION } from '@shared/remote-desktop-access.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { listControllableMachines } from '../api/machines.js';
import {
  getRemoteDesktopWall,
  mutateRemoteDesktopWall,
  type RemoteDesktopWallSnapshot,
} from '../api/remote-desktop-wall.js';
import {
  remoteDesktopHostKey,
  type RemoteDesktopConnectionManager,
} from '../remote-desktop-connection-manager.js';
import { mutateRemoteDesktopWallWithOneReplay } from '../remote-desktop-wall-store.js';
import type { RemoteDesktopWorkspaceMachine } from '../remote-desktop-workspace-state.js';
import { FloatingPanel } from './FloatingPanel.js';
import { canOpenRemoteDesktop } from './RemoteDesktopPanel.js';
import { RemoteDesktopWallTile } from './RemoteDesktopWallTile.js';
import './remote-desktop-workspace.css';

export const REMOTE_DESKTOP_WALL_WINDOW_ID = 'remote-desktop-wall';

export interface RemoteDesktopWallProps {
  manager: RemoteDesktopConnectionManager;
  retainedHostKeys: ReadonlySet<string>;
  minimized?: boolean;
  zIndex?: number;
  onFocus?(): void;
  onMinimize?(): void;
  onRestore?(): void;
  onOpenHost(machine: RemoteDesktopWorkspaceMachine): void;
  onHostKeysChange(hostKeys: readonly string[]): void;
  onClose(hostKeys: readonly string[]): void;
}

function addSlotCount(hostCount: number): number {
  if (hostCount >= REMOTE_DESKTOP_ACCESS_LIMITS.WALL_MAX_HOSTS) return 0;
  return Math.max(1, 4 - hostCount);
}

export function RemoteDesktopWall({
  manager,
  retainedHostKeys,
  minimized = false,
  zIndex,
  onFocus,
  onMinimize,
  onRestore,
  onOpenHost,
  onHostKeysChange,
  onClose,
}: RemoteDesktopWallProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<RemoteDesktopWallSnapshot | null>(null);
  const [wallError, setWallError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMachines, setPickerMachines] = useState<RemoteDesktopWorkspaceMachine[]>([]);
  const [pickerError, setPickerError] = useState(false);
  const addButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void getRemoteDesktopWall().then((next) => {
      if (!active) return;
      setSnapshot(next);
      onHostKeysChange(next.hosts.map(remoteDesktopHostKey));
    }).catch(() => {
      if (active) setWallError('load_failed');
    });
    return () => { active = false; };
  }, [onHostKeysChange]);

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

  const applySnapshot = useCallback((next: RemoteDesktopWallSnapshot) => {
    setSnapshot((current) => (!current || next.revision >= current.revision ? next : current));
    onHostKeysChange(next.hosts.map(remoteDesktopHostKey));
  }, [onHostKeysChange]);

  const mutateWall = useCallback(async (
    intent: Parameters<typeof mutateRemoteDesktopWallWithOneReplay>[0]['intent'],
  ) => {
    if (!snapshot) return null;
    const previous = snapshot;
    const result = await mutateRemoteDesktopWallWithOneReplay({
      snapshot: previous,
      intent,
      send: mutateRemoteDesktopWall,
    });
    applySnapshot(result.snapshot);
    setWallError(result.outcome === 'applied' ? null : result.outcome);
    const remaining = new Set(result.snapshot.hostIds);
    for (const host of previous.hosts) {
      const hostKey = remoteDesktopHostKey(host);
      if (!remaining.has(host.hostId) && !retainedHostKeys.has(hostKey)) manager.stop(hostKey);
    }
    return result;
  }, [applySnapshot, manager, retainedHostKeys, snapshot]);

  const addHost = useCallback(async (machine: RemoteDesktopWorkspaceMachine) => {
    const result = await mutateWall({
      operation: REMOTE_DESKTOP_WALL_OPERATION.ADD,
      hostId: remoteDesktopHostKey(machine),
    });
    if (result?.outcome === 'applied') {
      setPickerOpen(false);
      requestAnimationFrame(() => addButtonRef.current?.focus());
    }
  }, [mutateWall]);

  const removeHost = useCallback(async (hostId: string) => {
    await mutateWall({ operation: REMOTE_DESKTOP_WALL_OPERATION.REMOVE, hostId });
    requestAnimationFrame(() => addButtonRef.current?.focus());
  }, [mutateWall]);

  const availableMachines = useMemo(() => pickerMachines.filter((machine) => (
    !snapshot?.hosts.some((host) => remoteDesktopHostKey(host) === remoteDesktopHostKey(machine))
  )), [pickerMachines, snapshot?.hosts]);
  const slots = addSlotCount(snapshot?.hosts.length ?? 0);
  const cellCount = (snapshot?.hosts.length ?? 0) + slots;
  const columns = Math.max(1, Math.ceil(Math.sqrt(cellCount)));
  const hostKeys = snapshot?.hosts.map(remoteDesktopHostKey) ?? [];

  const content = (
    <div class="remote-desktop-wall" data-cell-count={cellCount}>
      <header class="remote-desktop-workspace-header remote-desktop-wall-header">
        <strong>{t('remote_desktop.workspace_wall')}</strong>
        <div class="remote-desktop-workspace-actions">
          {onMinimize && (
            <button class="remote-desktop-workspace-chrome-button" type="button" onClick={onMinimize} aria-label={t('window.minimize')}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
            </button>
          )}
          <button class="remote-desktop-workspace-chrome-button is-danger" type="button" onClick={() => onClose(hostKeys)} aria-label={t('window.close')}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
          </button>
        </div>
      </header>
      <main class="remote-desktop-workspace-wall">
        {wallError && <p role="alert">{t(`remote_desktop.wall_error_${wallError}`)}</p>}
        {snapshot && (
          <div
            class="remote-desktop-wall-grid"
            aria-label={t('remote_desktop.wall_grid')}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {snapshot.hosts.map((host, index) => (
              <RemoteDesktopWallTile
                key={host.hostId}
                host={host}
                manager={manager}
                wallVisible={!minimized}
                pressurePaused={(navigator as Navigator & { deviceMemory?: number }).deviceMemory !== undefined
                  && (navigator as Navigator & { deviceMemory?: number }).deviceMemory! <= 2
                  && index >= 4}
                onOpen={onOpenHost}
                onRemove={(hostId) => { void removeHost(hostId); }}
              />
            ))}
            {Array.from({ length: slots }, (_, index) => (
              <button
                ref={index === 0 ? addButtonRef : undefined}
                type="button"
                class="remote-desktop-wall-add-slot"
                key={`add-${index}`}
                aria-label={t('remote_desktop.wall_add')}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                onClick={() => setPickerOpen(true)}
              ><span aria-hidden="true">+</span></button>
            ))}
          </div>
        )}
        {pickerOpen && (
          <div class="remote-desktop-wall-picker" role="dialog" aria-modal="false" aria-label={t('remote_desktop.wall_picker')}>
            <div class="remote-desktop-wall-picker-head">
              <strong>{t('remote_desktop.wall_picker')}</strong>
              <button type="button" onClick={() => setPickerOpen(false)} aria-label={t('window.close')}>×</button>
            </div>
            {pickerError && <p role="alert">{t('remote_desktop.workspace_picker_failed')}</p>}
            {!pickerError && availableMachines.length === 0 && <p>{t('remote_desktop.workspace_picker_empty')}</p>}
            {availableMachines.map((machine) => (
              <button type="button" key={machine.serverId} onClick={() => { void addHost(machine); }}>
                <strong>{machine.displayName}</strong><span>{machine.refName}</span>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );

  return (
    <>
      <div class="remote-desktop-wall-window" hidden={minimized}>
        <FloatingPanel
          id={REMOTE_DESKTOP_WALL_WINDOW_ID}
          title={t('remote_desktop.workspace_wall')}
          onClose={() => onClose(hostKeys)}
          zIndex={zIndex ?? 10010}
          onFocus={onFocus}
          defaultW={1180}
          defaultH={760}
          minW={540}
          minH={360}
          className="remote-desktop-wall-shell"
          hideTitleBar
          dragHandleSelector=".remote-desktop-wall-header"
        >{content}</FloatingPanel>
      </div>
      {minimized && (
        <button type="button" class="remote-desktop-minimized-dock" onClick={onRestore}>
          {t('remote_desktop.workspace_wall')} · {snapshot?.hosts.length ?? 0}
        </button>
      )}
    </>
  );
}
