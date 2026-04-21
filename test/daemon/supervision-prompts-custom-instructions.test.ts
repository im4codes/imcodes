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
  it('concatenates global + session when override is false and labels it as merged', () => {
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
    // Merged heading kicks in only when BOTH sides are non-empty and
    // override is false. Wording frames these as RULES the supervisor
    // enforces, matching the cross-party semantics (supervisor judges
    // against them; target session must comply with them).
    expect(prompt).toContain('Supervision rules set by the user (global baseline first, then session-specific additions — supervision enforces all of them):');
    // Must not mislabel the merged case as pure session-specific.
    expect(prompt).not.toMatch(/Session-specific supervision rules set by the user[^\n]*\nprefer TDD style/);
  });

  it('uses only session and keeps the session-specific heading when override is true', () => {
    const req = makeRequest({
      customInstructions: 'session only text',
      globalCustomInstructions: 'this should be ignored',
      customInstructionsOverride: true,
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).toContain('session only text');
    expect(prompt).not.toContain('this should be ignored');
    expect(prompt).toContain('Session-specific supervision rules set by the user (supervision enforces these on this session):');
    expect(prompt).not.toContain('Global supervision rules set by the user');
  });

  it('falls back to global when session is empty and labels it as global', () => {
    const req = makeRequest({
      customInstructions: '',
      globalCustomInstructions: 'global fallback',
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).toContain('global fallback');
    // This is the original reported bug: pure-global must not be
    // mislabeled as "Session-specific".
    expect(prompt).toContain('Global supervision rules set by the user (supervision enforces these on every session, including this one):');
    expect(prompt).not.toMatch(/Session-specific supervision rules set by the user[^\n]*\nglobal fallback/);
  });

  it('omits the supervision-rules block entirely when both empty', () => {
    const req = makeRequest({
      customInstructions: '',
      globalCustomInstructions: '',
    });
    const prompt = buildSupervisionDecisionPrompt(req);
    expect(prompt).not.toContain('Session-specific supervision rules');
    expect(prompt).not.toContain('Global supervision rules');
    expect(prompt).not.toContain('Supervision rules set by the user');
  });

  it('passes the merged value into the repair prompt with the merged heading', () => {
    const req = makeRequest({
      customInstructions: 'retry me',
      globalCustomInstructions: 'global retry',
    });
    const prompt = buildSupervisionDecisionRepairPrompt(req, '{"bad":"json"}');
    expect(prompt).toContain('global retry\n\nretry me');
    expect(prompt).toContain('Supervision rules set by the user (global baseline first, then session-specific additions — supervision enforces all of them):');
  });

  it('buildSupervisionContinuePrompt keeps the bare-string contract labeled session-specific', () => {
    // Bare string keeps historic behavior: treated as session-specific
    // (callers without snapshot context default to the session heading).
    const prompt = buildSupervisionContinuePrompt(
      'the task',
      'last assistant turn',
      'keep going',
      'PRE-MERGED TEXT',
    );
    expect(prompt).toContain('PRE-MERGED TEXT');
    expect(prompt).toContain('Session-specific supervision rules set by the user (supervision enforces these on this session):');
  });

  it('buildSupervisionContinuePrompt accepts a detail object and uses the source label', () => {
    const prompt = buildSupervisionContinuePrompt(
      'the task',
      'last assistant turn',
      'keep going',
      { text: 'always commit', source: 'global' },
    );
    expect(prompt).toContain('always commit');
    expect(prompt).toContain('Global supervision rules set by the user (supervision enforces these on every session, including this one):');
    expect(prompt).not.toContain('Session-specific supervision rules set by the user');
  });

  it('buildSupervisionContinuePrompt leads with nextAction when structured instructions are supplied', () => {
    // This is the loop-breaker: when the supervisor supplied a concrete
    // nextAction, the target must see it as the first imperative line.
    // Without this the agent only saw the reason field and kept rewriting
    // the same answer.
    const prompt = buildSupervisionContinuePrompt(
      'the task',
      'last assistant turn',
      {
        reason: 'tests missing',
        nextAction: 'Add a regression test for the new guardrail and run `npx vitest run`.',
        gap: 'no test covers the new fallback branch',
      },
    );
    expect(prompt).toContain('Next action required: Add a regression test for the new guardrail and run `npx vitest run`.');
    expect(prompt).toContain("What's missing: no test covers the new fallback branch");
    expect(prompt).toContain('Supervisor reason: tests missing');
    // nextAction appears BEFORE the Supervisor reason line.
    const idxNext = prompt.indexOf('Next action required:');
    const idxReason = prompt.indexOf('Supervisor reason:');
    expect(idxNext).toBeGreaterThanOrEqual(0);
    expect(idxReason).toBeGreaterThanOrEqual(0);
    expect(idxNext).toBeLessThan(idxReason);
  });

  it('buildSupervisionContinuePrompt omits nextAction / gap lines when not provided', () => {
    const prompt = buildSupervisionContinuePrompt(
      'the task',
      'last assistant turn',
      { reason: 'just continue' },
    );
    expect(prompt).not.toContain('Next action required:');
    expect(prompt).not.toContain("What's missing:");
    expect(prompt).toContain('Supervisor reason: just continue');
  });
});
