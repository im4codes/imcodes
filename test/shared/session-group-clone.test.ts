import { describe, expect, it } from 'vitest';
import type { P2pSavedConfig } from '../../shared/p2p-modes.js';
import {
  SESSION_GROUP_CLONE_CAPABILITY_V1,
  P2P_SESSION_REFERENCE_CLASSIFIED_PATHS,
  P2P_SESSION_REFERENCE_PRESERVE_PATHS,
  P2P_SESSION_REFERENCE_REMAP_PATHS,
  P2P_SESSION_REFERENCE_WARNING_ONLY_PATHS,
  cloneP2pConfigWithSessionRemap,
  defaultCloneTargetProjectName,
  isRoleCompatibleMainSession,
  mainSessionNameForProjectSlug,
  resolveCloneTargetProject,
} from '../../shared/session-group-clone.js';

describe('session group clone shared contract', () => {
  it('exposes the stable daemon capability string', () => {
    expect(SESSION_GROUP_CLONE_CAPABILITY_V1).toBe('session-group-clone:v1');
  });

  it('derives role-compatible main names from sanitized project input', () => {
    expect(resolveCloneTargetProject(' P2P Design Review ')).toEqual({
      rawTargetProjectName: 'P2P Design Review',
      targetProjectSlug: 'p2p_design_review',
      targetMainSessionName: 'deck_p2p_design_review_brain',
    });
    expect(() => resolveCloneTargetProject('   ')).toThrow(/Target project name is required/);
    expect(mainSessionNameForProjectSlug('cd_1')).toBe('deck_cd_1_brain');
  });

  it('allocates default suffixes inside the project slug before the role suffix', () => {
    const unavailable = new Set(['deck_cd_1_brain', 'deck_cd_2_brain']);
    expect(defaultCloneTargetProjectName('cd', (name) => !unavailable.has(name))).toBe('cd_3');
    expect(defaultCloneTargetProjectName('cd_1', () => true)).toBe('cd_1_1');
  });

  it('validates role-compatible source main sessions', () => {
    expect(isRoleCompatibleMainSession({
      name: 'deck_cd_brain',
      projectName: 'cd',
      role: 'brain',
    })).toBe(true);
    expect(isRoleCompatibleMainSession({
      name: 'deck_cd_brain_1',
      projectName: 'cd',
      role: 'brain',
    })).toBe(false);
    expect(isRoleCompatibleMainSession({
      name: 'deck_sub_abc',
      projectName: 'sub',
      role: 'brain',
    })).toBe(false);
  });

  it('structurally remaps modeled P2P session references without broad string replacement', () => {
    const sourceConfig: P2pSavedConfig = {
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
        deck_sub_a: { enabled: true, mode: 'review' },
      },
      rounds: 2,
      extraPrompt: 'Keep literal deck_cd_brain mention as a warning only.',
      contextReducer: {
        mode: 'reuse_existing_session',
        sessionName: 'deck_cd_brain',
        templateSession: 'deck_sub_a',
      },
      workflowLaunchEnvelope: {
        workflowSchemaVersion: 1,
        workflowKind: 'advanced',
        launchContext: { sessionName: 'deck_cd_brain', userText: 'run from deck_cd_brain' },
        oldAdvanced: {
          contextReducer: {
            mode: 'reuse_existing_session',
            sessionName: 'deck_sub_a',
            templateSession: 'deck_cd_brain',
          },
          advancedRounds: [
            { id: 'r1', promptAppend: 'ask deck_sub_a for review' },
          ],
        },
        advancedDraft: {
          schemaVersion: 1,
          id: 'wf1',
          nodes: [
            {
              id: 'n1',
              nodeKind: 'llm',
              preset: 'audit',
              permissionScope: 'analysis_only',
              promptAppend: 'literal deck_cd_brain remains warning-only',
            },
          ],
          edges: [],
        },
      },
      workflowLibrary: [
        {
          schemaVersion: 1,
          id: 'wf-lib',
          nodes: [
            {
              id: 'n1',
              nodeKind: 'llm',
              preset: 'audit',
              permissionScope: 'analysis_only',
              summaryPromptOverride: 'summarize deck_sub_a',
            },
          ],
          edges: [],
        },
      ],
      activeWorkflowId: 'wf-lib',
    };

    const result = cloneP2pConfigWithSessionRemap(sourceConfig, {
      deck_cd_brain: 'deck_cd_1_brain',
      deck_sub_a: 'deck_sub_b',
    }, 123);

    expect(result.config.sessions).toEqual({
      deck_cd_1_brain: { enabled: true, mode: 'audit' },
      deck_sub_b: { enabled: true, mode: 'review' },
    });
    expect(result.config.contextReducer?.sessionName).toBe('deck_cd_1_brain');
    expect(result.config.contextReducer?.templateSession).toBe('deck_sub_b');
    expect(result.config.workflowLaunchEnvelope?.launchContext?.sessionName).toBe('deck_cd_1_brain');
    expect(result.config.workflowLaunchEnvelope?.launchContext?.userText).toBe('run from deck_cd_brain');
    expect(result.config.workflowLaunchEnvelope?.oldAdvanced?.contextReducer?.sessionName).toBe('deck_sub_b');
    expect(result.config.workflowLaunchEnvelope?.oldAdvanced?.contextReducer?.templateSession).toBe('deck_cd_1_brain');
    expect(result.config.activeWorkflowId).toBe('wf-lib');
    expect(result.config.updatedAt).toBe(123);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'p2p_prompt_session_reference', fieldPath: 'extraPrompt', sourceSessionName: 'deck_cd_brain' }),
      expect.objectContaining({ code: 'p2p_prompt_session_reference', fieldPath: 'workflowLaunchEnvelope.advancedDraft.nodes[0].promptAppend', sourceSessionName: 'deck_cd_brain' }),
      expect.objectContaining({ code: 'p2p_prompt_session_reference', fieldPath: 'workflowLibrary[0].nodes[0].summaryPromptOverride', sourceSessionName: 'deck_sub_a' }),
    ]));
  });

  it('drops skipped source-group P2P participants while preserving external sessions', () => {
    const sourceConfig: P2pSavedConfig = {
      sessions: {
        deck_cd_brain: { enabled: true, mode: 'audit' },
        deck_sub_active: { enabled: true, mode: 'review' },
        deck_sub_stopped: { enabled: true, mode: 'summarize' },
        deck_external_brain: { enabled: true, mode: 'audit' },
      },
      rounds: 1,
    };

    const result = cloneP2pConfigWithSessionRemap(sourceConfig, {
      deck_cd_brain: 'deck_cd_1_brain',
      deck_sub_active: 'deck_sub_clone',
    }, 123, {
      sourceGroupSessionNames: ['deck_cd_brain', 'deck_sub_active', 'deck_sub_stopped'],
    });

    expect(result.config.sessions).toEqual({
      deck_cd_1_brain: { enabled: true, mode: 'audit' },
      deck_sub_clone: { enabled: true, mode: 'review' },
      deck_external_brain: { enabled: true, mode: 'audit' },
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'p2p_skipped_participant_dropped',
        fieldPath: 'sessions.deck_sub_stopped',
        sourceSessionName: 'deck_sub_stopped',
      }),
    ]));
  });

  it('classifies persisted P2P session-reference fields for clone remap contract coverage', () => {
    expect(P2P_SESSION_REFERENCE_REMAP_PATHS).toEqual(expect.arrayContaining([
      'sessions.*',
      'contextReducer.sessionName',
      'contextReducer.templateSession',
      'workflowLaunchEnvelope.launchContext.sessionName',
      'workflowLaunchEnvelope.oldAdvanced.contextReducer.sessionName',
      'workflowLaunchEnvelope.oldAdvanced.contextReducer.templateSession',
    ]));
    expect(P2P_SESSION_REFERENCE_PRESERVE_PATHS).toEqual(expect.arrayContaining([
      'workflowLaunchEnvelope.advancedDraft',
      'workflowDraft',
      'workflowLibrary[*]',
      'advancedRounds',
    ]));
    expect(P2P_SESSION_REFERENCE_WARNING_ONLY_PATHS).toEqual(expect.arrayContaining([
      'extraPrompt',
      'workflowLaunchEnvelope.oldAdvanced.advancedRounds[*].promptAppend',
      'workflowLibrary[*].nodes[*].summaryPromptOverride',
    ]));

    const persistedSessionReferencePaths = [
      'sessions.*',
      'contextReducer.sessionName',
      'contextReducer.templateSession',
      'workflowLaunchEnvelope.launchContext.sessionName',
      'workflowLaunchEnvelope.oldAdvanced.contextReducer.sessionName',
      'workflowLaunchEnvelope.oldAdvanced.contextReducer.templateSession',
    ];
    const classified = new Set<string>(P2P_SESSION_REFERENCE_CLASSIFIED_PATHS);
    for (const fieldPath of persistedSessionReferencePaths) {
      expect(classified.has(fieldPath), `${fieldPath} must be classified for clone remapping`).toBe(true);
    }
  });
});
