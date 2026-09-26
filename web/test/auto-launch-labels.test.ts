import { describe, it, expect } from 'vitest';
import { computeAutoLaunchLabels } from '../src/auto-launch-labels.js';

describe('computeAutoLaunchLabels', () => {
  it('returns the given label unchanged for a single launch', () => {
    expect(computeAutoLaunchLabels([], 'codex', 'my-worker', 1)).toEqual(['my-worker']);
  });

  it('returns undefined unchanged for a single launch with no label', () => {
    expect(computeAutoLaunchLabels([], 'codex', undefined, 1)).toEqual([undefined]);
  });

  it('mints cx1/cx2/cx3 style labels for a multi-launch with no label, matching the existing auto-label prefix convention', () => {
    expect(computeAutoLaunchLabels([], 'codex', undefined, 3)).toEqual(['Cx1', 'Cx2', 'Cx3']);
  });

  it('continues numbering after existing same-type siblings instead of restarting from 1', () => {
    const siblings = [
      { type: 'codex', label: 'Cx1' },
      { type: 'codex', label: 'Cx2' },
      { type: 'claude-code', label: 'CC1' },
    ];
    expect(computeAutoLaunchLabels(siblings, 'codex', undefined, 2)).toEqual(['Cx3', 'Cx4']);
  });

  it('auto-increments off a user-specified label instead of using the generic "type N" style', () => {
    expect(computeAutoLaunchLabels([], 'codex', 'worker', 3)).toEqual(['worker', 'worker2', 'worker3']);
  });

  it('skips labels already taken by existing siblings when auto-incrementing a specified label', () => {
    const siblings = [{ type: 'codex', label: 'worker2' }];
    expect(computeAutoLaunchLabels(siblings, 'codex', 'worker', 2)).toEqual(['worker', 'worker3']);
  });

  it('skips labels already taken by existing siblings when auto-generating a type-prefixed label', () => {
    const siblings = [{ type: 'codex', label: 'Cx1' }, { type: 'codex', label: 'Cx2' }];
    expect(computeAutoLaunchLabels(siblings, 'codex', undefined, 2)).toEqual(['Cx3', 'Cx4']);
  });

  it('leaves a single launch (count <= 1) untouched, deferring to create()s own auto-label derivation', () => {
    const siblings = [{ type: 'codex', label: 'Cx1' }];
    expect(computeAutoLaunchLabels(siblings, 'codex', undefined, 1)).toEqual([undefined]);
    expect(computeAutoLaunchLabels(siblings, 'codex', undefined, 0)).toEqual([undefined]);
  });
});
