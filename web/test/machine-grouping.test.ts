import { describe, it, expect } from 'vitest';
import {
  MACHINE_GROUP_ALL,
  MACHINE_GROUP_DIRECT,
  machineGroupsOf,
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
  const ops = machine({ displayName: 'Ops box', teamId: 'team-1', teamName: 'Ops' });
  const opsToo = machine({ displayName: 'Ops two', teamId: 'team-1', teamName: 'Ops' });
  const nameless = machine({ displayName: 'Nameless', teamId: 'team-2' });
  const all = [mine, ops, opsToo, nameless];

  it('lists each group once, and never a nameless one', () => {
    // The id stands in for a missing name: a filter chip with no label is a
    // control nobody can choose on purpose.
    expect(machineGroupsOf(all)).toEqual([['team-1', 'Ops'], ['team-2', 'team-2']]);
  });

  it('offers no groups when nothing is in one', () => {
    expect(machineGroupsOf([mine])).toEqual([]);
  });

  it('keeps team machines out of the default view, and loses none under All', () => {
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
