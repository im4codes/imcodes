import { describe, it, expect } from 'vitest';
import {
  MACHINE_GROUP_ALL,
  MACHINE_GROUP_DIRECT,
  machineGroupTabs,
  machineGroupsOf,
  machineIsInGroup,
  machinesInGroup,
} from '../src/machine-grouping.js';
import type { MachineListItem } from '../src/api/machines.js';

const machine = (over: Partial<MachineListItem>): MachineListItem => ({
  serverId: `srv-${over.displayName ?? 'x'}`,
  nodeId: '1234567890',
  refName: 'r',
  displayName: 'M',
  online: true,
  execEnabled: true,
  ...over,
});

describe('machine grouping', () => {
  const mine = machine({ displayName: 'Mine' });
  const ops = machine({ displayName: 'Ops box', teamIds: ['team-1'], teamNames: ['Ops'] });
  const opsToo = machine({ displayName: 'Ops two', teamIds: ['team-1'], teamNames: ['Ops'] });
  const nameless = machine({ displayName: 'Nameless', teamIds: ['team-2'] });
  const all = [mine, ops, opsToo, nameless];

  it('lists each group once, and never a nameless one', () => {
    // The id stands in for a missing name: a filter chip with no label is a
    // control nobody can choose on purpose.
    expect(machineGroupsOf(all)).toEqual([['team-1', 'Ops'], ['team-2', 'team-2']]);
  });

  it('offers no groups when nothing is in one', () => {
    expect(machineGroupsOf([mine])).toEqual([]);
  });

  it('keeps machines reachable only through a group out of the default view, and loses none under All', () => {
    expect(machinesInGroup(all, MACHINE_GROUP_DIRECT)).toEqual([mine]);
    expect(machinesInGroup(all, 'team-1')).toEqual([ops, opsToo]);
    // Nothing a grouping choice can hide outright.
    expect(machinesInGroup(all, MACHINE_GROUP_ALL)).toEqual(all);
  });

  it('returns nothing for a group that holds nothing, rather than everything', () => {
    // Falling back to the full list on an unknown group would quietly show
    // machines the chosen filter says are not there.
    expect(machinesInGroup(all, 'team-gone')).toEqual([]);
  });
});

describe('a machine in more than one group', () => {
  const both = machine({
    displayName: 'Shared twice',
    teamIds: ['team-1', 'team-2'],
    teamNames: ['Ops', 'Support'],
  });
  const mine = machine({ displayName: 'Mine' });

  it('appears under every group it is in', () => {
    expect(machinesInGroup([both, mine], 'team-1')).toEqual([both]);
    expect(machinesInGroup([both, mine], 'team-2')).toEqual([both]);
    expect(machineIsInGroup(both, 'team-1')).toBe(true);
    expect(machineIsInGroup(both, 'team-3')).toBe(false);
  });

  it('is not ungrouped, and is listed once under All', () => {
    // Someone else's machine, reachable only because a group was shared with
    // you, belongs under that group's chip and not in "mine".
    expect(machinesInGroup([both, mine], MACHINE_GROUP_DIRECT)).toEqual([mine]);
    expect(machinesInGroup([both, mine], MACHINE_GROUP_ALL)).toEqual([both, mine]);
  });

  it('contributes every one of its groups to the chip row, each once', () => {
    // Reading only the first would hide a group that exists, and listing the
    // machine per group would repeat a chip.
    expect(machineGroupsOf([both, mine])).toEqual([['team-1', 'Ops'], ['team-2', 'Support']]);
    expect(machineGroupsOf([both, both])).toHaveLength(2);
  });

  it('falls back to the id when the names do not line up with the ids', () => {
    // Parallel arrays from the server: a short or missing name list must not
    // shift labels onto the wrong groups or produce an unnamed chip.
    const skewed = machine({ displayName: 'Skewed', teamIds: ['a', 'b'], teamNames: ['Only one'] });
    expect(machineGroupsOf([skewed])).toEqual([['a', 'Only one'], ['b', 'b']]);
  });
});

describe('your own machine, once you file it in a group', () => {
  const ownGrouped = machine({
    displayName: 'Desk',
    accessRole: 'owner',
    teamIds: ['team-1'],
    teamNames: ['Ops'],
  });
  const ownLoose = machine({ displayName: 'Laptop', accessRole: 'owner' });
  const theirs = machine({
    displayName: 'Theirs',
    accessRole: 'viewer',
    teamIds: ['team-1'],
    teamNames: ['Ops'],
  });

  it('is still on the default view', () => {
    // Adding your own device to a group is a decision about who else can
    // reach it. It is not a decision to remove it from the list you land on,
    // and a device that silently leaves that list reads as a lost device.
    expect(machinesInGroup([ownGrouped, ownLoose, theirs], MACHINE_GROUP_DIRECT))
      .toEqual([ownGrouped, ownLoose]);
  });

  it('is under its group too, without being duplicated inside one list', () => {
    expect(machinesInGroup([ownGrouped, ownLoose, theirs], 'team-1'))
      .toEqual([ownGrouped, theirs]);
    expect(machinesInGroup([ownGrouped, ownLoose, theirs], MACHINE_GROUP_ALL))
      .toHaveLength(3);
  });
});

describe('machineGroupTabs', () => {
  const mine = machine({ displayName: 'Mine', accessRole: 'owner' });
  const ops = machine({
    displayName: 'Ops box', accessRole: 'viewer', teamIds: ['team-1'], teamNames: ['Ops'],
  });
  const both = machine({
    displayName: 'Both', accessRole: 'viewer',
    teamIds: ['team-1', 'team-2'], teamNames: ['Ops', 'Support'],
  });

  it('counts each tab by what that tab actually shows', () => {
    // Every count must equal the length of the list the tab opens, or the
    // superscript is a lie -- that is the whole contract between them.
    const tabs = machineGroupTabs([mine, ops, both]);
    expect(tabs.map((tab) => tab.id))
      .toEqual([MACHINE_GROUP_DIRECT, 'team-1', 'team-2', MACHINE_GROUP_ALL]);
    for (const tab of tabs) {
      expect(tab.count, tab.id).toBe(machinesInGroup([mine, ops, both], tab.id).length);
    }
    expect(tabs.map((tab) => tab.count)).toEqual([1, 2, 1, 3]);
  });

  it('names the real groups and leaves the two synthetic tabs to be translated', () => {
    const tabs = machineGroupTabs([mine, ops, both]);
    expect(tabs[0].name, 'a hardcoded English label here would never be translated').toBeUndefined();
    expect(tabs.at(-1)?.name).toBeUndefined();
    expect(tabs[1].name).toBe('Ops');
    expect(tabs[2].name).toBe('Support');
  });

  it('still offers the two synthetic tabs when nothing is grouped', () => {
    expect(machineGroupTabs([mine]).map((tab) => [tab.id, tab.count]))
      .toEqual([[MACHINE_GROUP_DIRECT, 1], [MACHINE_GROUP_ALL, 1]]);
  });
});
