import type { MachineListItem } from './api/machines.js';

/**
 * A team is a group of machines that can be shared with people. Filtering the
 * machine list by one is therefore an ordinary grouping choice, offered
 * wherever machines are listed -- the panel and the quick menu -- from this one
 * definition rather than two that drift.
 */

/** Machines in no group: your own, plus any shared with you one at a time. */
export const MACHINE_GROUP_DIRECT = 'direct';
/** Everything visible, so no grouping choice can hide a machine outright. */
export const MACHINE_GROUP_ALL = 'all';

/**
 * The groups present among these machines, as [id, label].
 *
 * Derived from the machines themselves rather than from the team list: a group
 * you belong to but that holds nothing visible is a filter that empties the
 * screen, and the id falls back as the label so a group is never nameless.
 */
export function machineGroupsOf(machines: readonly MachineListItem[]): [string, string][] {
  return Array.from(
    new Map(
      machines
        .filter((machine) => machine.teamId)
        .map((machine) => [machine.teamId!, machine.teamName || machine.teamId!] as const),
    ).entries(),
  );
}

export function machinesInGroup(
  machines: readonly MachineListItem[],
  group: string,
): MachineListItem[] {
  if (group === MACHINE_GROUP_ALL) return [...machines];
  if (group === MACHINE_GROUP_DIRECT) return machines.filter((machine) => !machine.teamId);
  return machines.filter((machine) => machine.teamId === group);
}
