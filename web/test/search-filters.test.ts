import { describe, expect, it } from 'vitest';
import type { AliasEntry } from '@shared/alias-types.js';
import { filterAliases } from '../src/hooks/useAliases.js';
import { filterMachines, type MachineListItem } from '../src/hooks/useMachines.js';

const aliases: AliasEntry[] = [
  { name: 'DeployProd', value: 'secret', description: 'Ship CAFÉ safely', tags: [], createdAt: '', updatedAt: '', source: 'web' },
  { name: 'other', value: 'value', description: 'unrelated', tags: [], createdAt: '', updatedAt: '', source: 'web' },
];

const machines: MachineListItem[] = [
  { serverId: 'srv-1', nodeId: '1000000001', refName: 'WinBox-A1', displayName: 'Windows Box', online: true, execEnabled: true },
  { serverId: 'srv-2', nodeId: '1000000002', refName: 'macmini-b2', displayName: 'Mac Mini', online: false, execEnabled: true },
];

describe('composer search filters', () => {
  it('matches aliases by mixed-case name and NFC-equivalent description', () => {
    expect(filterAliases(aliases, 'pRoD')).toEqual([aliases[0]]);
    expect(filterAliases(aliases, 'café')).toEqual([aliases[0]]);
    expect(filterAliases(aliases, '   ')).toEqual(aliases);
  });

  it('matches machines by mixed-case refName and displayName without changing rows', () => {
    expect(filterMachines(machines, 'wINbOX')).toEqual([machines[0]]);
    expect(filterMachines(machines, 'mAc mInI')).toEqual([machines[1]]);
    expect(filterMachines(machines, '1000000002')).toEqual([machines[1]]);
    expect(filterMachines(machines, '')).toEqual(machines);
  });
});
