import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindProcessSharedMachineAuthority,
  clearProcessSharedMachineAuthoritiesForTests,
  readProcessSharedMachineAuthority,
} from '../../src/daemon/shared-machine-authority-context.js';

const identity = { sessionInstanceId: 'instance-1', runtimeEpoch: 'epoch-1' };

describe('process shared machine authority context', () => {
  beforeEach(clearProcessSharedMachineAuthoritiesForTests);

  it('is exact-runtime scoped and is cleared by the next non-shared turn', () => {
    bindProcessSharedMachineAuthority('deck_a', identity, 'signed', true, 1_000);
    expect(readProcessSharedMachineAuthority('deck_a', identity, 1_001))
      .toEqual({ required: true, authority: 'signed' });
    expect(readProcessSharedMachineAuthority('deck_a', { ...identity, runtimeEpoch: 'epoch-2' }, 1_001))
      .toEqual({ required: true, authority: null });

    bindProcessSharedMachineAuthority('deck_a', identity, 'signed', true, 2_000);
    bindProcessSharedMachineAuthority('deck_a', identity, undefined, false, 2_001);
    expect(readProcessSharedMachineAuthority('deck_a', identity, 2_002))
      .toEqual({ required: false, authority: null });
  });

  it('expires the local handoff independently of the server token', () => {
    bindProcessSharedMachineAuthority('deck_a', identity, 'signed', true, 1_000);
    expect(readProcessSharedMachineAuthority('deck_a', identity, 1_000 + 10 * 60 * 1_000))
      .toEqual({ required: true, authority: null });
  });

  it('retains a fail-closed marker when a participant turn arrives without a token', () => {
    bindProcessSharedMachineAuthority('deck_a', identity, undefined, true, 1_000);
    expect(readProcessSharedMachineAuthority('deck_a', identity, 1_001))
      .toEqual({ required: true, authority: null });

    // A later owner-authored turn is the only operation that clears the marker.
    bindProcessSharedMachineAuthority('deck_a', identity, undefined, false, 1_002);
    expect(readProcessSharedMachineAuthority('deck_a', identity, 1_003))
      .toEqual({ required: false, authority: null });
  });
});
