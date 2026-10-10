import { describe, expect, it } from 'vitest';
import {
  isKnownTestProjectDir,
  isKnownTestProjectName,
  isKnownTestSessionLike,
  isKnownTestSessionName,
  isTransportQueueFixtureSessionName,
} from '../../shared/test-session-guard.js';

describe('test session guard', () => {
  it('matches known leaked main-session names', () => {
    for (const fixture of ['s1', 's2', 's-snapshot', 'alpha', 'beta', 'b', 'deck_transport_brain', 'deck_codex_expired_resend_brain']) {
      expect(isTransportQueueFixtureSessionName(fixture), fixture).toBe(true);
      expect(isKnownTestSessionName(fixture), fixture).toBe(false);
    }
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
    expect(isKnownTestSessionName('deck_existing_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_existing_w1')).toBe(true);
    expect(isKnownTestSessionName('imc_perf_test_abc123')).toBe(true);
    expect(isKnownTestSessionName('deck_wtproj_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_sub_wtexec')).toBe(true);
    expect(isKnownTestSessionName('deck_sub_wtaud')).toBe(true);
    expect(isKnownTestProjectName('wtproj')).toBe(true);
    // Real production names stay untouched.
    expect(isKnownTestSessionName('deck_sub_wtexecx')).toBe(false);
    expect(isKnownTestSessionName('deck_wtproject_brain')).toBe(false);
    expect(isKnownTestSessionName('deck_test_preview_abc123_brain')).toBe(true);
    expect(isKnownTestSessionName('deck_test_p2p_workflow_abc123_brain')).toBe(true);
    expect(isKnownTestSessionName('imcodes-test-p2p-workflow-abc123')).toBe(true);
    expect(isKnownTestSessionName('deck_sub_e2e_mcp_abc123')).toBe(true);
    // Execution-clone lifecycle TEST sessions (deck_sub_* clone family).
    expect(isKnownTestSessionName('deck_sub_execclone_abc123')).toBe(true);
    expect(isKnownTestSessionName('deck_sub_e2e_execclone_run1')).toBe(true);
    expect(isKnownTestSessionName('deck_realproj_brain')).toBe(false);
    expect(isKnownTestSessionName('deck_performance_real_brain')).toBe(false);
    // A REAL execution clone (random hex id from subSessionName) must NEVER be
    // matched as test-like — that would delete a live clone on startup.
    expect(isKnownTestSessionName('deck_sub_0123456789ab')).toBe(false);
    expect(isKnownTestSessionName('deck_sub_clone01')).toBe(false);
  });

  it('matches known leaked project names and temp e2e paths', () => {
    expect(isKnownTestProjectName('bootmainabc123')).toBe(true);
    expect(isKnownTestProjectName('modeawaree2eabc123')).toBe(true);
    expect(isKnownTestProjectName('restorecheckabc123')).toBe(true);
    expect(isKnownTestProjectName('storecheckabc123')).toBe(true);
    expect(isKnownTestProjectName('shutdownabc123')).toBe(true);
    expect(isKnownTestProjectName('perflat_abc123')).toBe(true);
    expect(isKnownTestProjectName('storm_abc123')).toBe(true);
    expect(isKnownTestProjectName('existing')).toBe(true);
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
    expect(isKnownTestProjectDir('/tmp/existing-project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/existing-project/sub')).toBe(true);
    expect(isKnownTestProjectDir('C:\\tmp\\existing-project')).toBe(true);
    expect(isKnownTestProjectDir('C:\\tmp\\existing-project\\sub')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/execclone-abc123/project')).toBe(true);
    expect(isKnownTestProjectDir('/tmp/imc_execclone_abc123/project')).toBe(true);
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

  it('matches the leaked existing-brain fixture by every persisted identity field', () => {
    expect(isKnownTestSessionLike({
      name: 'deck_existing_brain',
      projectName: 'existing',
      projectDir: 'C:\\tmp\\existing-project',
    })).toBe(true);
  });

  it('matches execution-clone test sub-sessions by name or temp cwd', () => {
    // Recognized directly by the clone-test naming family.
    expect(isKnownTestSessionLike({ name: 'deck_sub_execclone_run1' })).toBe(true);
    // Recognized via a temp clone cwd even when the name is a bare clone id.
    expect(isKnownTestSessionLike({
      name: 'deck_sub_abcd1234',
      cwd: '/tmp/execclone-run1',
    })).toBe(true);
    // A REAL execution clone (random hex id, real project cwd, real parent) is
    // NOT test-like and must survive startup cleanup.
    expect(isKnownTestSessionLike({
      name: 'deck_sub_0123456789ab',
      cwd: '/Users/me/project',
      parentSession: 'deck_realproj_brain',
    })).toBe(false);
  });
});
