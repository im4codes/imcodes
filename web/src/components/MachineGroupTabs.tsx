import { useTranslation } from 'react-i18next';
import type { MachineListItem } from '../api/machines.js';
import { MACHINE_GROUP_DIRECT, machineGroupTabs } from '../machine-grouping.js';

/** Shared group chips for remote desktop and composer machine pickers. */
export function MachineGroupTabs({ machines, group, onSelect, testIdPrefix, menu = false }: {
  machines: readonly MachineListItem[];
  group: string;
  onSelect(group: string): void;
  testIdPrefix: string;
  menu?: boolean;
}) {
  const { t } = useTranslation();
  return <>{machineGroupTabs(machines).map(({ id, name, count }) => (
    <button
      key={id}
      type="button"
      role={menu ? 'none' : 'tab'}
      aria-selected={menu ? undefined : group === id}
      class={`controlled-nodes-team-chip${group === id ? ' is-active' : ''}`}
      data-testid={`${testIdPrefix}-${id}`}
      onClick={() => onSelect(id)}
    >
      {name ?? t(id === MACHINE_GROUP_DIRECT ? 'controlled_nodes.group_direct' : 'controlled_nodes.group_all')}
      <span class="controlled-nodes-team-chip-count">{count}</span>
    </button>
  ))}</>;
}
