import { describe, expect, it } from 'vitest';
import {
  isKnownTestProjectDir,
  isKnownTestProjectName,
  isKnownTestSessionLike,
  isKnownTestSessionName,
} from '../../shared/test-session-guard.js';

describe('test session guard', () => {
  it('matches known leaked main-session names', () => {
    expect(isKnownTestSessionName('deck_bootmainabc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_modeawaree2eabc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_qwene2e_ab12cd_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_realproj_brain')).toBe(false);
  });

  it('matches known leaked project names and temp e2e paths', () => {
    expect(isKnownTestProjectName('bootmainabc123')).toBe(true);
    expect(isKnownTestProjectName('modeawaree2eabc123')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/cxsdk-sub-e2e')).toBe(true);
    expect(isKnownTestProjectDir('/Users/me/src/myapp')).toBe(false);
  });

  it('matches sub-session records via parent or cwd context', () => {
    expect(isKnownTestSessionLike({
      name: 'deck_sub_abcd1234',
      parentSession: 'deck_modeawaree2eabc123_brain',
    })).toBe(true);
    expect(isKnownTestSessionLike({
      name: 'deck_sub_abcd1234',
      cwd: '/tmp/ccsdk-minimax-sub-e2e',
    })).toBe(true);
    expect(isKnownTestSessionLike({
      name: 'deck_sub_real',
      cwd: '/Users/me/project',
      parentSession: 'deck_cd_brain',
    })).toBe(false);
  });
});
