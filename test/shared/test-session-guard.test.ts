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
    expect(isKnownTestSessionName('deck_e2epptestabc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_modeawaree2eabc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_qwene2e_ab12cd_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_restorecheckabc123_w10')).toBe(true);
    expect(isKnownTestSessionName('deck_storecheckabc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_shutdownabc123_probe')).toBe(true);
    expect(isKnownTestSessionName('deck_perflat_abc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_perflat_abc123_w2')).toBe(true);
    expect(isKnownTestSessionName('deck_storm_abc123_probe')).toBe(true);
    expect(isKnownTestSessionName('imc_perf_test_abc123')).toBe(true);
    expect(isKnownTestSessionName('deck_test_preview_abc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_test_p2p_workflow_abc123_brain')).toBe(true);
    expect(isKnownTestSessionName('imcodes-test-p2p-workflow-abc123')).toBe(true);
    expect(isKnownTestSessionName('deck_sub_e2e_mcp_abc123')).toBe(true);
    expect(isKnownTestSessionName('deck_realproj_brain')).toBe(false);
    expect(isKnownTestSessionName('deck_performance_real_brain')).toBe(false);
  });

  it('matches known leaked project names and temp e2e paths', () => {
    expect(isKnownTestProjectName('bootmainabc123')).toBe(true);
    expect(isKnownTestProjectName('modeawaree2eabc123')).toBe(true);
    expect(isKnownTestProjectName('restorecheckabc123')).toBe(true);
    expect(isKnownTestProjectName('storecheckabc123')).toBe(true);
    expect(isKnownTestProjectName('shutdownabc123')).toBe(true);
    expect(isKnownTestProjectName('perflat_abc123')).toBe(true);
    expect(isKnownTestProjectName('storm_abc123')).toBe(true);
    expect(isKnownTestProjectName('imc_perf_test_abc123')).toBe(true);
    expect(isKnownTestProjectName('imcodes-test-preview-dist')).toBe(true);
    expect(isKnownTestProjectName('imcodes-test-p2p-workflow-dist')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/cxsdk-sub-e2e')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/deck_perflat_abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/perflat_abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/deck_storm_abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/storm_abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/imc_perf_test_abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/imcodes-test-preview-dist-abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/imcodes-test-p2p-workflow-abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/imc_p2p_wf_test_abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/Users/me/src/myapp')).toBe(false);
    expect(isKnownTestProjectDir('/tmp/stormcenter-real/project')).toBe(false);
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
      name: 'deck_sub_abcd1234',
      parentSession: 'deck_shutdownabc123_w1',
    })).toBe(true);
    expect(isKnownTestSessionLike({
      name: 'deck_sub_real',
      cwd: '/Users/me/project',
      parentSession: 'deck_cd_brain',
    })).toBe(false);
  });
});
