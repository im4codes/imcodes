import { describe, expect, it } from 'vitest';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import {
  buildSupervisionContinuePrompt,
  buildSupervisionDecisionPrompt,
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

    expect(prompt).toContain('openspec status --change "<name>" --json');
    expect(prompt).toContain('@@all(discuss) <message>');
    expect(prompt).toContain('imcodes send --list');
  });

  it('includes IM.codes workflow background in the continue prompt', () => {
    const prompt = buildSupervisionContinuePrompt(
      'Finish the task with the right IM.codes tools',
      'Partial implementation complete',
      'OpenSpec and follow-up work remain',
      'Prefer OpenSpec when a change is already referenced.',
    );

    expect(prompt).toContain('openspec new change "<name>"');
    expect(prompt).toContain('@@<label-or-session>(audit) <message>');
    expect(prompt).toContain('imcodes send --type codex "<message>"');
    expect(prompt).toContain('Prefer OpenSpec when a change is already referenced.');
  });
});
