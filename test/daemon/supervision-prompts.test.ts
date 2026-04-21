import { describe, expect, it } from 'vitest';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import {
  buildSupervisionContinuePrompt,
  buildSupervisionDecisionPrompt,
  buildSupervisionDecisionRepairPrompt,
} from '../../src/daemon/supervision-prompts.js';

describe('supervision prompts', () => {
  it('includes IM.codes workflow background in the decision prompt', () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const prompt = buildSupervisionDecisionPrompt({
      snapshot,
      taskRequest: 'Use OpenSpec and P2P when helpful',
      assistantResponse: 'I can continue from here.',
    });

    expect(prompt).toContain('Use this background mainly to interpret the user\'s requested workflow and custom instructions.');
    expect(prompt).toContain('that is usually work the agent can continue doing autonomously');
    expect(prompt).toContain('openspec status --change "<name>" --json');
    expect(prompt).toContain('@@all(discuss) <message>');
    expect(prompt).toContain('imcodes send --list');
  });

  it('does NOT include IM.codes workflow background in the continue prompt', () => {
    // Regression guard. The continue prompt is sent to the TARGET session's
    // chat, not to the supervisor judge. Injecting the IM.codes capability
    // background here used to dump ~80 lines of operator docs (contract
    // wrappers, OpenSpec / P2P / imcodes send reference) into every
    // supervisor-driven continue turn, which the user then saw in their
    // chat and which polluted downstream P2P runs that harvested the last
    // message as `userText`. The background belongs only on the supervisor
    // decision/repair prompts — they judge whether an IM.codes workflow
    // counts as autonomous continuation, the target agent does not need
    // re-teaching about its own tools.
    const prompt = buildSupervisionContinuePrompt(
      'Finish the task with the right IM.codes tools',
      'Partial implementation complete',
      'OpenSpec and follow-up work remain',
      'Prefer OpenSpec when a change is already referenced.',
    );

    // Background docs must NOT leak into the target session.
    expect(prompt).not.toContain('IM.codes capability background');
    expect(prompt).not.toContain('Do not treat the mere need to use one of these IM.codes workflows as a reason to ask_human');
    expect(prompt).not.toContain('openspec new change "<name>"');
    expect(prompt).not.toContain('@@<label-or-session>(audit) <message>');
    expect(prompt).not.toContain('imcodes send --type codex "<message>"');

    // The lightweight nudge contract and user-supplied custom instructions
    // (which ARE session-scoped guidance, not operator docs) stay.
    expect(prompt).toContain('Continue working on the same task.');
    expect(prompt).toContain('Supervisor reason: OpenSpec and follow-up work remain');
    expect(prompt).toContain('Prefer OpenSpec when a change is already referenced.');
    expect(prompt).toContain('Original task request:');
    expect(prompt).toContain('Finish the task with the right IM.codes tools');
  });

  it('keeps IM.codes workflow background on the decision-repair prompt (supervisor-facing)', () => {
    // Companion check — the repair prompt is also supervisor-facing, so
    // unlike the continue prompt, it SHOULD retain the background. This
    // test documents the asymmetry so future edits don't accidentally
    // strip the background from both sides.
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });
    const prompt = buildSupervisionDecisionRepairPrompt(
      { snapshot, taskRequest: 'OpenSpec flow', assistantResponse: 'partial' },
      'not valid json',
    );
    expect(prompt).toContain('IM.codes capability background');
    expect(prompt).toContain('openspec status --change "<name>" --json');
  });
});
