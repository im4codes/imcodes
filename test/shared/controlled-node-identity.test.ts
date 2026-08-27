import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_NODE_ID_LENGTH,
  CONTROLLED_NODE_ID_MAX,
  CONTROLLED_NODE_ID_MIN,
  CONTROLLED_NODE_ID_PATTERN_SOURCE,
  isControlledNodeId,
  parseControlledNodeId,
} from '../../shared/controlled-node-identity.js';
import { buildResolvedMachines, classifyMachineTarget } from '../../shared/machine-reference.js';

describe('canonical controlled-node identity', () => {
  it('accepts exactly the inclusive canonical bounds as strings', () => {
    expect(CONTROLLED_NODE_ID_LENGTH).toBe(10);
    expect(CONTROLLED_NODE_ID_PATTERN_SOURCE).toBe('^[1-9][0-9]{9}$');
    expect(isControlledNodeId(CONTROLLED_NODE_ID_MIN)).toBe(true);
    expect(isControlledNodeId(CONTROLLED_NODE_ID_MAX)).toBe(true);
    expect(parseControlledNodeId('1234567890')).toBe('1234567890');
  });

  it.each([
    '0000000001', '0123456789', '0000000000', '123456789', '12345678901',
    '-123456789', '+123456789', ' 1234567890', '1234567890 ', '1e9',
    '123456789.0', '１２３４５６７８９０', '١٢٣٤٥٦٧٨٩٠', '', 1234567890,
  ])('rejects non-canonical value %j', (value) => {
    expect(isControlledNodeId(value)).toBe(false);
    expect(parseControlledNodeId(value)).toBeNull();
  });

  it('uses disjoint canonical and legacy lookup, with canonical grammar winning', () => {
    expect(classifyMachineTarget('^^(1234567890)')).toEqual({ kind: 'node_id', value: '1234567890' });
    expect(classifyMachineTarget('^^(old-host-a1b2c3)')).toEqual({ kind: 'legacy_ref_name', value: 'old-host-a1b2c3' });
    const machines = [
      { serverId: 'canonical-server', nodeId: '1234567890', refName: 'old-host-a1b2c3', online: true },
      // This malformed historical alias must never capture canonical grammar.
      { serverId: 'alias-server', nodeId: '9999999999', refName: '1234567890', online: true },
    ];
    expect(buildResolvedMachines('run ^^(1234567890)', machines).resolvedMachines)
      .toEqual({ '1234567890': 'canonical-server' });
    expect(buildResolvedMachines('run ^^(old-host-a1b2c3)', machines).resolvedMachines)
      .toEqual({ 'old-host-a1b2c3': 'canonical-server' });
  });
});
