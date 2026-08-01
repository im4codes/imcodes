import { describe, expect, it } from 'vitest';
import { buildBashNodeDatachannelRepair } from '../../src/util/node-datachannel-repair-script.js';

describe('buildBashNodeDatachannelRepair', () => {
  const block = buildBashNodeDatachannelRepair();

  it('verifies the native module by importing it from the installed package', () => {
    expect(block).toContain('verify_node_datachannel()');
    expect(block).toContain("import('node-datachannel')");
    expect(block).toContain('cd "$IMCODES_PACKAGE_DIR"');
  });

  it('runs only the dependency lifecycle with scripts explicitly enabled', () => {
    expect(block).toContain('rebuild node-datachannel --ignore-scripts=false --foreground-scripts');
    expect(block).not.toContain('install -g');
  });

  it('verifies again after rebuild and degrades to relay on failure', () => {
    const rebuildIndex = block.indexOf('rebuild node-datachannel');
    const verificationIndexes = [...block.matchAll(/verify_node_datachannel/g)].map((match) => match.index ?? -1);
    expect(verificationIndexes.some((index) => index > rebuildIndex)).toBe(true);
    expect(block).toContain('direct transfer unavailable; relay remains enabled');
    expect(block).not.toMatch(/\bexit\s+[1-9]/);
  });
});
