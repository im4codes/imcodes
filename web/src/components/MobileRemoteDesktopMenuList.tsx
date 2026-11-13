import { useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { MachineListItem } from '../api/machines.js';
import { useMachines } from '../hooks/useMachines.js';
import {
  machineGroupsOf,
  machinesInGroup,
  resolveMachineGroup,
  useRememberedMachineGroup,
} from '../machine-grouping.js';
import { canOpenRemoteDesktopMachine } from '../remote-desktop-profile.js';
import { MachineGroupTabs } from './MachineGroupTabs.js';

export interface MobileRemoteDesktopMenuListProps {
  onSelect: (machine: MachineListItem) => void;
}

/**
 * Compact remote-desktop node switcher shown inside the mobile server dropdown's
 * right-hand "Remote" tab. Reuses the shared `useMachines()` cache and refetches
 * on entry without adding desktop/closed-menu fetch overhead.
 */
export function MobileRemoteDesktopMenuList({ onSelect }: MobileRemoteDesktopMenuListProps) {
  const { t } = useTranslation();
  const { machines, loaded, error, refetch } = useMachines();
  const [rememberedGroup, setGroup] = useRememberedMachineGroup();
  const groups = machineGroupsOf(machines);
  const group = resolveMachineGroup(rememberedGroup, machines);
  const visible = machinesInGroup(machines, group);

  useEffect(() => {
    void refetch().catch(() => {});
    // Refetch once per opening when the user enters the Remote tab.
  }, []);

  return (
    <div
      class="mobile-server-menu-remote-panel"
      role="tabpanel"
      id="mobile-menu-panel-remote"
      aria-labelledby="mobile-menu-tab-remote"
      data-testid="mobile-menu-panel-remote"
    >
      {groups.length > 0 && (
        <div class="mobile-server-menu-remote-groups" role="none">
          <MachineGroupTabs
            machines={machines}
            group={group}
            onSelect={setGroup}
            testIdPrefix="mobile-remote-menu-group"
          />
        </div>
      )}
      {!loaded && !error && (
        <div class="mobile-server-menu-remote-state">
          {t('common.loading', { defaultValue: 'Loading…' })}
        </div>
      )}
      {error != null && machines.length === 0 && (
        <div class="mobile-server-menu-remote-state is-error" role="alert">
          {t('controlled_nodes.refresh_error', {
            defaultValue: 'Could not refresh node status. Showing the last known data.',
          })}
        </div>
      )}
      {loaded && visible.length === 0 && error == null && (
        <div class="mobile-server-menu-remote-state">
          {t('controlled_nodes.empty', { defaultValue: 'No controlled nodes yet.' })}
        </div>
      )}
      {visible.length > 0 && (
        <div class="mobile-server-menu-remote-grid">
          {visible.map((machine) => {
            const selectable = canOpenRemoteDesktopMachine(machine);
            const statusSymbol = machine.online ? '●' : '○';
            const disabledReason = !machine.online
              ? t('controlled_nodes.offline', { defaultValue: 'Offline' })
              : !machine.execEnabled
                ? t('controlled_nodes.exec_off', { defaultValue: 'Exec disabled' })
                : t('mobile_menu.remote_unavailable', { defaultValue: 'Remote desktop unavailable' });
            const buttonTitle = selectable
              ? t('mobile_menu.remote_connect_label', {
                  name: machine.displayName,
                  defaultValue: `Open remote desktop: ${machine.displayName}`,
                })
              : disabledReason;
            const accessibleLabel = selectable
              ? buttonTitle
              : `${machine.displayName} (${disabledReason})`;

            return (
              <button
                key={machine.serverId}
                type="button"
                data-testid={`mobile-remote-node-${machine.serverId}`}
                class={`mobile-server-menu-remote-btn${machine.online ? ' is-online' : ' is-offline'}${selectable ? ' is-selectable' : ' is-disabled'}`}
                aria-disabled={selectable ? undefined : 'true'}
                title={buttonTitle}
                aria-label={accessibleLabel}
                onClick={() => {
                  if (!selectable) return;
                  onSelect(machine);
                }}
              >
                <span
                  class={`mobile-server-menu-remote-dot ${machine.online ? 'is-online' : 'is-offline'}`}
                  aria-hidden="true"
                >
                  {statusSymbol}
                </span>
                <span class="mobile-server-menu-remote-name">{machine.displayName}</span>
                <span class="mobile-server-menu-remote-connect" aria-hidden="true">
                  →
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
