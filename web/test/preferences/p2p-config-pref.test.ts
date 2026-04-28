import { describe, expect, it } from 'vitest';
import {
  p2pSubSessionParentSignature,
  resolveP2pRootSession,
} from '../../src/preferences/p2p-config-pref.js';

describe('p2p config preference helpers', () => {
  it('resolves a sub-session to its parent session', () => {
    expect(resolveP2pRootSession('deck_sub_worker', [
      { sessionName: 'deck_sub_worker', parentSession: 'deck_main' },
    ])).toBe('deck_main');
  });

  it('falls back to the active main session when no active sub-session parent exists', () => {
    expect(resolveP2pRootSession('deck_main', [
      { sessionName: 'deck_sub_worker', parentSession: 'deck_main' },
    ])).toBe('deck_main');
    expect(resolveP2pRootSession(null, [])).toBe('');
  });

  it('keeps the parent signature stable across unrelated metadata changes', () => {
    const initial = p2pSubSessionParentSignature([
      { sessionName: 'deck_sub_worker', parentSession: 'deck_main' },
      { sessionName: 'deck_sub_reviewer', parentSession: 'deck_main' },
    ]);
    const withUnrelatedMetadata = p2pSubSessionParentSignature([
      { sessionName: 'deck_sub_worker', parentSession: 'deck_main' },
      { sessionName: 'deck_sub_reviewer', parentSession: 'deck_main' },
    ]);
    const withChangedParent = p2pSubSessionParentSignature([
      { sessionName: 'deck_sub_worker', parentSession: 'deck_other' },
      { sessionName: 'deck_sub_reviewer', parentSession: 'deck_main' },
    ]);

    expect(withUnrelatedMetadata).toBe(initial);
    expect(withChangedParent).not.toBe(initial);
  });
});
