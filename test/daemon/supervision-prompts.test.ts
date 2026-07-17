import { describe, expect, it } from 'vitest';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import {
  buildPeerAuditBriefV1,
  buildSupervisionContinuePrompt,
  buildSupervisionDecisionPrompt,
  buildSupervisionDecisionRepairPrompt,
} from '../../src/daemon/supervision-prompts.js';
import { PEER_AUDIT_BRIEF_TOTAL_BYTES, peerAuditByteLength } from '../../shared/peer-audit.js';

describe('supervision prompts', () => {
  it('builds a bounded lightweight brief with non-destructive executable validation and structured reply', () => {
    const prompt = buildPeerAuditBriefV1({
      attemptId: 'attempt_1',
      replyCapability: 'A'.repeat(32),
      taskRequest: 'Implement the requested behavior',
      completedResult: 'Implementation and tests complete',
      acceptanceCriteria: ['Focused tests pass', 'No tracked source is modified by the audit'],
      projectPath: '/repo',
      changePath: '/repo/openspec/changes/example',
      changedPaths: ['src/example.ts'],
      validations: [{ kind: 'test', label: 'focused', outcome: 'passed', summary: '3 tests passed' }],
      supervisorRationale: 'Looks complete, but verify independently.',
    });

    expect(prompt).toContain('[Contract: supervision_peer_audit_v1]');
    expect(prompt).toContain('focused/unit/integration tests, typecheck, lint, build');
    expect(prompt).toContain('already-authorized devices/environments');
    expect(prompt).toContain('MUST NOT modify tracked source, commit, push, deploy, mutate production');
    expect(prompt).toContain('Inspect worktree state before and after');
    expect(prompt).toContain('Report exact commands/tools/devices/environments and observed outcomes');
    expect(prompt).toContain('imcodes audit-reply --attempt-id attempt_1');
    expect(prompt).toContain('--capability ' + 'A'.repeat(32));
    expect(prompt).not.toContain('P2P_VERDICT');
    expect(prompt).not.toContain('Selected automation audit mode');
    expect(peerAuditByteLength(prompt)).toBeLessThanOrEqual(PEER_AUDIT_BRIEF_TOTAL_BYTES);
  });

  it('redacts secrets before UTF-8 truncation and omits provider metadata', () => {
    const secret = `Bearer ${'s'.repeat(40)}`;
    const prompt = buildPeerAuditBriefV1({
      attemptId: 'attempt_2',
      replyCapability: 'B'.repeat(32),
      taskRequest: `${'你'.repeat(2800)} ${secret}`,
      completedResult: `done ${secret}`,
      acceptanceCriteria: ['No secret survives'],
      changedPaths: ['src/provider-independent.ts'],
    });
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain('[REDACTED:bearer]');
    expect(prompt).not.toContain('providerId');
    expect(prompt).not.toContain('activeModel');
    expect(peerAuditByteLength(prompt)).toBeLessThanOrEqual(PEER_AUDIT_BRIEF_TOTAL_BYTES);
  });

  it('enforces list/total budgets and describes unavailable checks and disposable side effects', () => {
    const prompt = buildPeerAuditBriefV1({
      attemptId: 'attempt_budget',
      replyCapability: 'C'.repeat(32),
      taskRequest: 'Exact acceptance: preserve ordinary send --reply behavior.',
      completedResult: 'Result summary without raw history, tool payloads, or file bodies.',
      acceptanceCriteria: Array.from({ length: 100 }, (_, index) => `criterion-${index}-${'你'.repeat(200)}`),
      changedPaths: Array.from({ length: 200 }, (_, index) => `src/path-${index}.ts`),
      validations: Array.from({ length: 100 }, (_, index) => ({
        kind: index % 2 === 0 ? 'test' as const : 'device' as const,
        label: `check-${index}`,
        outcome: 'unavailable' as const,
        summary: `fixture unavailable ${index}`,
      })),
    });

    expect(prompt).toContain('Exact acceptance: preserve ordinary send --reply behavior.');
    expect(prompt).toContain('Explain unavailable checks');
    expect(prompt).toContain('disposable local files');
    expect(prompt).toContain('Do not run reset/clean');
    expect(prompt).toContain('stop/report if validation creates an unexpected tracked diff');
    expect(prompt).not.toContain('criterion-99-');
    expect(prompt).not.toContain('src/path-199.ts');
    expect(prompt).not.toContain('check-99');
    expect(peerAuditByteLength(prompt)).toBeLessThanOrEqual(PEER_AUDIT_BRIEF_TOTAL_BYTES);
  });

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
    expect(prompt).toContain('imcodes send --reply "<label-or-session-name>" "<message>"');
    expect(prompt).toContain('do not poll session state, logs, transcripts, or the target');
  });

  it('tells supervised audit to hold commit and push until peer review finishes', () => {
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED_AUDIT,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const prompt = buildSupervisionDecisionPrompt({
      snapshot,
      taskRequest: 'Implement, audit, then commit and push',
      assistantResponse: 'Implementation and tests are complete; changes are not committed.',
    });

    expect(prompt).toContain('Peer audit MUST finish before repository commit/push finalization.');
    expect(prompt).toContain('the daemon will hold it until peer-audit PASS instead of sending it now');
    expect(prompt).toContain('Never combine substantive pre-audit work and post-audit commit/push in one nextAction.');
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
