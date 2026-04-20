/**
 * Regression coverage for supervision-global-custom-instructions:
 * the merged (global + session + override) custom-instructions block
 * must reach every supervision prompt path (decision, repair, continue).
 */
import { describe, expect, it } from 'vitest';
import {
  SUPERVISION_MODE,
  normalizeSessionSupervisionSnapshot,
} from '../../shared/supervision-config.js';
import { CODEX_MODEL_IDS } from '../../src/shared/models/options.js';
import {
  buildSupervisionContinuePrompt,
  buildSupervisionDecisionPrompt,
  buildSupervisionDecisionRepairPrompt,
} from '../../src/daemon/supervision-prompts.js';
import type { SupervisionBrokerRequest } from '../../src/daemon/supervision-broker.js';

function makeRequest(snapshotPartial: Partial<Parameters<typeof normalizeSessionSupervisionSnapshot>[0]>): SupervisionBrokerRequest {
  const snapshot = normalizeSessionSupervisionSnapshot({
    mode: SUPERVISION_MODE.SUPERVISED,
    backend: 'codex-sdk',
    model: CODEX_MODEL_IDS[0],
    ...snapshotPartial,
  });
  return {
    requestId: 'test-req',
    sessionName: 'deck_test_brain',
    snapshot,
    taskRequest: 'write tests',
    assistantResponse: 'done.',
    description: undefined,
    cwd: undefined,
  } as unknown as SupervisionBrokerRequest;
}

describe('supervision prompt custom-instructions merge', () => {
  it('concatenates global + session when override is false', () => {
    const req = makeRequest({
      customInstructions: 'always cite a test path',
      globalCustomInstructions: 'prefer TDD style',
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).toContain('prefer TDD style');
    expect(prompt).toContain('always cite a test path');
    // Expect concat order: global first, blank line, then session.
    expect(prompt.indexOf('prefer TDD style')).toBeLessThan(prompt.indexOf('always cite a test path'));
    expect(prompt).toContain('prefer TDD style\n\nalways cite a test path');
  });

  it('uses only session when override is true', () => {
    const req = makeRequest({
      customInstructions: 'session only text',
      globalCustomInstructions: 'this should be ignored',
      customInstructionsOverride: true,
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).toContain('session only text');
    expect(prompt).not.toContain('this should be ignored');
  });

  it('falls back to global when session is empty and override is false', () => {
    const req = makeRequest({
      customInstructions: '',
      globalCustomInstructions: 'global fallback',
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).toContain('global fallback');
  });

  it('omits the custom-instructions block entirely when both empty', () => {
    const req = makeRequest({
      customInstructions: '',
      globalCustomInstructions: '',
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).not.toContain('Session-specific supervision instructions');
  });

  it('passes the merged value into the repair prompt', () => {
    const req = makeRequest({
      customInstructions: 'retry me',
      globalCustomInstructions: 'global retry',
    });
    const prompt = buildSupervisionDecisionRepairPrompt(req, '{"bad":"json"}');
    expect(prompt).toContain('global retry\n\nretry me');
  });

  it('buildSupervisionContinuePrompt keeps the single-arg contract with caller-merged value', () => {
    // Continue prompt takes a pre-merged string — automation is responsible
    // for calling resolveEffectiveCustomInstructions before invoking.
    const prompt = buildSupervisionContinuePrompt(
      'the task',
      'last assistant turn',
      'keep going',
      'PRE-MERGED TEXT',
    );
    expect(prompt).toContain('PRE-MERGED TEXT');
  });
});
