import type { MachineListItem } from './api/machines.js';

/**
 * A team is a group of machines that can be shared with people. Filtering the
 * machine list by one is therefore an ordinary grouping choice, offered
 * wherever machines are listed -- the panel and the quick menu -- from this one
 * definition rather than two that drift.
 */

/** Your own machines, plus any shared with you one at a time rather than via a group. */
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
  const byId = new Map<string, string>();
  for (const machine of machines) {
    // A machine can be in several groups, so every one of them belongs in the
    // chip row -- taking only the first would hide groups that exist.
    (machine.teamIds ?? []).forEach((id, index) => {
      if (!byId.has(id)) byId.set(id, machine.teamNames?.[index] || id);
    });
  }
  return Array.from(byId.entries());
}

/** Is this machine in that group? */
export function machineIsInGroup(machine: MachineListItem, group: string): boolean {
  return (machine.teamIds ?? []).includes(group);
}

export function machinesInGroup(
  machines: readonly MachineListItem[],
  group: string,
): MachineListItem[] {
  if (group === MACHINE_GROUP_ALL) return [...machines];
  // "Mine and shared with me" means in no group at all, not "in some other
  // group": a machine in two groups is in neither of those places.
  if (group === MACHINE_GROUP_DIRECT) {
    // A machine you own stays here whatever groups it is also in. Filing your
    // own device in a group is a sharing decision, not a decision to hide it
    // from your own default view -- and the default view is the one people
    // land on, so a device that vanishes from it has, as far as anyone can
    // tell, been lost.
    //
    // What this arm does exclude is a machine reachable ONLY through a group:
    // that one belongs under its group's chip, and putting it here as well
    // would make "direct" mean nothing.
    return machines.filter(
      (machine) => machine.accessRole === 'owner' || (machine.teamIds ?? []).length === 0,
    );
  }
  return machines.filter((machine) => machineIsInGroup(machine, group));
}

/** One filter tab: which group, and how many machines are behind it. */
export interface MachineGroupTab {
  id: string;
  /** The group's own name. Absent for the two synthetic tabs, which are translated. */
  name?: string;
  count: number;
}

/**
 * The filter tabs, counts included, for any list of machines.
 *
 * The count is the point: without it every chip looks alike and the only way
 * to find out whether a group holds anything is to click it and watch the list
 * empty. Built here rather than at each call site so the machines tab and the
 * quick menu cannot disagree about either the tabs or the numbers on them.
 */
export function machineGroupTabs(machines: readonly MachineListItem[]): MachineGroupTab[] {
  return [
    { id: MACHINE_GROUP_DIRECT, count: machinesInGroup(machines, MACHINE_GROUP_DIRECT).length },
    ...machineGroupsOf(machines).map(([id, name]) => ({
      id,
      name,
      count: machinesInGroup(machines, id).length,
    })),
    { id: MACHINE_GROUP_ALL, count: machines.length },
  ];
}
