import { describe, expect, it } from 'vitest';
import {
  AGENT_DELEGATION_ERROR_CODES,
  AGENT_DELEGATION_CONTEXT_HEADER,
  AGENT_DELEGATION_CONTEXT_OMITTED_MARKER,
  AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER,
  AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER,
  AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER,
  AGENT_DELEGATION_REPLY_VERSION,
  AGENT_DELEGATION_TARGET_FIELD,
  DELEGATION_REPLY_CAPABLE_AGENT_TYPES,
  DELEGATION_REPLY_CAPABLE_PROCESS_AGENT_TYPES,
  DELEGATION_EMPTY_TASK,
  DELEGATION_SELF_TARGET,
  DELEGATION_TARGET_FORBIDDEN,
  DELEGATION_TARGET_NOT_REPLY_CAPABLE,
  DELEGATION_TARGET_UNAVAILABLE,
  DELEGATION_UNSUPPORTED_INPUT,
  INVALID_DELEGATION_TARGET,
  MIXED_DELEGATION_P2P_FIELDS,
  buildAgentDelegationOrchestrationPrompt,
  buildAgentDelegationBlockerReportInstruction,
  buildAgentDelegationReplyInstruction,
  buildQuickAgentDelegationTask,
  decodeAgentDelegationReplyEnvelope,
  extractAgentDelegationReplyAuthorityFromInstruction,
  findForbiddenAgentDelegationCommandFields,
  findMixedAgentDelegationP2pFields,
  hasAgentDelegationTargetField,
  hasLegacyP2pControlToken,
  isAgentDelegationForwardedPayloadText,
  isAgentDelegationControlInstructionText,
  isCanonicalAgentDelegationSessionName,
  isDelegationReplyCapableAgentType,
  isDelegationUnsupportedControlText,
  parseAgentDelegationTargetPayload,
  stripAgentDelegationControlInstructions,
  type AgentDelegationErrorCode,
} from '../../shared/agent-delegation.js';
import { HERMES_AGENT_PROVIDER_ID } from '../../shared/hermes-agent.js';

const expectInvalid = (value: unknown) => {
  expect(parseAgentDelegationTargetPayload(value)).toEqual(expect.objectContaining({
    ok: false,
    code: INVALID_DELEGATION_TARGET,
  }));
};

describe('agent delegation shared contract', () => {
  it('exports the top-level delegate target field name', () => {
    expect(AGENT_DELEGATION_TARGET_FIELD).toBe('delegateTarget');
    expect(hasAgentDelegationTargetField({ delegateTarget: { session: 'deck_repo_w1' } })).toBe(true);
  });

  it('accepts an exact valid payload shape with a canonical session name', () => {
    expect(parseAgentDelegationTargetPayload({ session: 'deck_repo_w1' })).toEqual({
      ok: true,
      payload: { session: 'deck_repo_w1' },
    });
    expect(parseAgentDelegationTargetPayload({ session: 'deck_repo_brain' })).toEqual({
      ok: true,
      payload: { session: 'deck_repo_brain' },
    });
    expect(parseAgentDelegationTargetPayload({ session: 'deck_sub_worker-1' })).toEqual({
      ok: true,
      payload: { session: 'deck_sub_worker-1' },
    });
  });

  it('rejects malformed payloads', () => {
    expectInvalid(null);
    expectInvalid(undefined);
    expectInvalid('deck_repo_w1');
    expectInvalid(['deck_repo_w1']);
    expectInvalid({});
    expectInvalid({ session: '' });
    expectInvalid({ session: ' deck_repo_w1' });
    expectInvalid({ session: 'deck_repo_w1 ' });
    expectInvalid({ session: 123 });
    expectInvalid({ session: ['deck_repo_w1'] });
  });

  it('rejects __all__, display labels, short roles, and agent-type-like values', () => {
    for (const value of ['__all__', 'Worker A', 'brain', 'w1', 'codex', 'claude-code', 'gemini', 'opencode', 'shell', 'script']) {
      expect(isCanonicalAgentDelegationSessionName(value)).toBe(false);
      expectInvalid({ session: value });
    }
  });

  it('rejects forbidden extra fields in the target payload', () => {
    expectInvalid({ session: 'deck_repo_w1', replyTo: 'deck_repo_brain' });
    expectInvalid({ session: 'deck_repo_w1', contextTail: 'client context' });
    expectInvalid({ session: 'deck_repo_w1', delegationId: 'abc' });
  });

  it('identifies forbidden command-level fields when delegation is present', () => {
    expect(findForbiddenAgentDelegationCommandFields({
      delegateTarget: { session: 'deck_repo_w1' },
      text: 'do work',
      replyTo: 'deck_repo_brain',
      origin: 'deck_other_brain',
      context: 'client context',
      delegationContext: 'client supplied',
      files: ['a.ts'],
      quote: 'quoted',
      quotedMessage: { id: 'm1' },
      broadcast: true,
      clone: { kind: 'execution_clone' },
      idempotencyKey: 'same',
      delegationId: 'future',
      sharedActor: { actorUserId: 'u1' },
      shareScope: { kind: 'project' },
    })).toEqual(['replyTo', 'origin', 'context', 'delegationContext', 'files', 'quotedMessage', 'quote', 'broadcast', 'clone', 'idempotencyKey', 'delegationId', 'sharedActor', 'shareScope']);

    expect(findForbiddenAgentDelegationCommandFields({ text: 'normal send', files: ['a.ts'] })).toEqual([]);
  });

  it('identifies all mixed P2P fields including future p2p-prefixed controls', () => {
    expect(findMixedAgentDelegationP2pFields({
      delegateTarget: { session: 'deck_repo_w1' },
      p2pAtTargets: ['deck_repo_w2'],
      p2pExcludeSameType: true,
      p2pFutureFlag: true,
      directTargetSession: 'deck_repo_w2',
      text: 'task',
    }).sort()).toEqual(['directTargetSession', 'p2pAtTargets', 'p2pExcludeSameType', 'p2pFutureFlag'].sort());
    expect(findMixedAgentDelegationP2pFields({ text: 'normal', p2pFutureFlag: true })).toEqual([]);
  });

  it('exports reply-capable agent target predicate and rejects non-agent types', () => {
    expect(DELEGATION_REPLY_CAPABLE_AGENT_TYPES).toEqual([
      'claude-code-sdk',
      'claude-code',
      'codex-sdk',
      'codex',
      'copilot-sdk',
      'cursor-headless',
      'opencode-sdk',
      'opencode',
      'gemini-sdk',
      'grok-sdk',
      'gemini',
      'qwen',
      'openclaw',
      'kimi-sdk',
      HERMES_AGENT_PROVIDER_ID,
      'deepseek-harness',
      'pi',
      'codebuddy-cn',
      'codebuddy-international',
    ]);
    expect(DELEGATION_REPLY_CAPABLE_PROCESS_AGENT_TYPES).toBe(DELEGATION_REPLY_CAPABLE_AGENT_TYPES);
    for (const agentType of DELEGATION_REPLY_CAPABLE_AGENT_TYPES) {
      expect(isDelegationReplyCapableAgentType(agentType)).toBe(true);
    }
    for (const agentType of ['shell', 'script', 'unknown', undefined, null]) {
      expect(isDelegationReplyCapableAgentType(agentType as string | undefined | null)).toBe(false);
    }
  });

  it('detects unsupported slash controls before delegation dispatch', () => {
    for (const text of ['/stop', '/model gpt-5.2', '/thinking high', '/effort medium', '/clear', '/compact', '/resume abc', '/restart']) {
      expect(isDelegationUnsupportedControlText(text)).toBe(true);
    }
    expect(isDelegationUnsupportedControlText('please /stop after this')).toBe(false);
    expect(isDelegationUnsupportedControlText('normal task')).toBe(false);
  });

  it('exports stable delegation error codes and union values', () => {
    const codes: AgentDelegationErrorCode[] = [
      MIXED_DELEGATION_P2P_FIELDS,
      INVALID_DELEGATION_TARGET,
      DELEGATION_SELF_TARGET,
      DELEGATION_TARGET_UNAVAILABLE,
      DELEGATION_TARGET_FORBIDDEN,
      DELEGATION_TARGET_NOT_REPLY_CAPABLE,
      DELEGATION_EMPTY_TASK,
      DELEGATION_UNSUPPORTED_INPUT,
    ];

    expect(codes).toEqual([
      'mixed_delegation_p2p_fields',
      'invalid_delegation_target',
      'delegation_self_target',
      'delegation_target_unavailable',
      'delegation_target_forbidden',
      'delegation_target_not_reply_capable',
      'delegation_empty_task',
      'delegation_unsupported_input',
    ]);
    expect(Object.values(AGENT_DELEGATION_ERROR_CODES).sort()).toEqual([...codes].sort());
  });

  it('builds marked best-effort reply instructions', () => {
    const instruction = buildAgentDelegationReplyInstruction('deck_repo_brain');
    expect(instruction).toContain(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER);
    expect(instruction).toContain('imcodes send "deck_repo_brain"');
    expect(instruction).toContain('Task: <brief summary of the request>\\nResult: <your response>');
    expect(isAgentDelegationControlInstructionText(instruction)).toBe(true);
  });

  it('builds and validates a reusable bounded structured delegation reply authority', () => {
    const delegationId = 'delegation_identity_1234567890';
    const replyCapability = 'reply_capability_1234567890_ABCDEFG';
    const instruction = buildAgentDelegationReplyInstruction('deck_repo_brain', {
      delegationId,
      replyCapability,
    });
    expect(instruction).toContain(AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER);
    expect(instruction).toContain('delegation_reply');
    expect(instruction).toContain(delegationId);
    expect(instruction).toContain(replyCapability);
    expect(instruction).toContain('multiple structured replies until it expires');
    expect(instruction).not.toContain('send your response using: imcodes send');
    expect(stripAgentDelegationControlInstructions(`task\n${instruction}`)).toBe('task');
    expect(extractAgentDelegationReplyAuthorityFromInstruction(instruction)).toEqual({
      delegationId,
      replyCapability,
    });
    expect(extractAgentDelegationReplyAuthorityFromInstruction(
      `${AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER} {"delegationId":"${delegationId}","replyCapability":"${replyCapability}","forged":true}`,
    )).toBeUndefined();

    expect(decodeAgentDelegationReplyEnvelope({
      version: AGENT_DELEGATION_REPLY_VERSION,
      delegationId,
      replyCapability,
      result: 'PASS with evidence',
    })).toEqual({
      ok: true,
      value: {
        version: AGENT_DELEGATION_REPLY_VERSION,
        delegationId,
        replyCapability,
        result: 'PASS with evidence',
      },
    });
    expect(decodeAgentDelegationReplyEnvelope({
      version: AGENT_DELEGATION_REPLY_VERSION,
      delegationId,
      replyCapability,
      result: 'ok',
      forged: true,
    })).toEqual({ ok: false, error: 'unknown_field' });
  });

  it('pins blocker escalation to the durable task and assignment identities', () => {
    const instruction = buildAgentDelegationBlockerReportInstruction({
      taskId: 'supervision_task_exact',
      assignmentId: 'supervision_assignment_exact',
    });
    expect(instruction).toContain('blocker, illegal_transition, contract contradiction');
    expect(instruction).toContain('must immediately use its authenticated reply-capable channel');
    expect(instruction).toContain('taskId="supervision_task_exact"');
    expect(instruction).toContain('assignmentId="supervision_assignment_exact"');
    for (const field of ['exactError', 'completedSafeWork', 'recommendedNextAction']) {
      expect(instruction).toContain(field);
    }
    expect(instruction).toContain('must never claim a verdict');
    expect(buildAgentDelegationBlockerReportInstruction({ taskId: '', assignmentId: 'a' })).toBe('');
  });

  it('renders supervision-audit reply authorities as peer_audit_reply instructions, not free-text delegation replies', () => {
    const delegationId = 'delegation_identity_1234567890';
    const replyCapability = 'reply_capability_1234567890_ABCDEFG';
    const instruction = buildAgentDelegationReplyInstruction('deck_repo_brain', {
      delegationId,
      replyCapability,
      audit: {
        kind: 'supervision_audit',
        attemptId: 'attempt-r5',
        auditedSessionName: 'deck_sub_implementation',
      },
    });
    expect(instruction).toContain(AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER);
    expect(instruction).toContain('peer_audit_reply');
    expect(instruction).toContain('"attemptId": "attempt-r5"');
    expect(instruction).toContain('"replyCapability":');
    expect(instruction).not.toContain('Use the delegation_reply tool');
    expect(extractAgentDelegationReplyAuthorityFromInstruction(instruction)).toEqual({
      delegationId,
      replyCapability,
    });
  });

  it('builds a current-session orchestration prompt for UI-picked single-agent delegation', () => {
    const prompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: 'deck_repo_w1',
      targetLabel: 'Worker One',
      task: 'review the queue sync bug',
    });
    expect(prompt).toContain('current session orchestrator');
    expect(prompt).toContain('Target label: Worker One');
    expect(prompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_repo_w1');
    expect(prompt).toContain('review the queue sync bug');
    expect(prompt).toContain('Prepare one concise, self-contained brief from the current context');
    expect(prompt).toContain('Do not forward the raw task alone.');
    expect(prompt).toContain('send_message(target="deck_repo_w1", reply=true)');
    expect(prompt).toContain('Do not call send_list_targets.');
    expect(prompt).toContain('imcodes send --reply "deck_repo_w1"');
    expect(prompt).not.toContain('imcodes send --no-reply "deck_repo_w1"');
    expect(prompt).toContain('do not poll session state, logs, or transcripts');
    expect(prompt).not.toContain('multiple replies until expiry');
    expect(prompt).not.toContain('multiple @ delegates');
    expect(prompt).not.toContain('Quick Audit cycle after each delegated reply:');
    expect(prompt).not.toContain('<!-- IMCODES_AUTOMATIC_AUDIT:');
  });

  it('bounds an oversized delegation task instead of flooding the target turn', () => {
    const prompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: 'deck_repo_w1',
      task: '超'.repeat(10_000),
    });
    expect(prompt).toContain('[truncated]');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(6 * 1024);
    expect(prompt).toContain('Target ID (pass directly to send_message; do not look it up): deck_repo_w1');
    expect(prompt.match(/imcodes send --reply/g)).toHaveLength(1);
  });

  it('keeps the Quick Audit marker and repair/re-audit cycle outside task truncation', () => {
    const prompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: 'deck_repo_w1',
      targetLabel: 'Reviewer',
      task: '超'.repeat(10_000),
      auditCycle: true,
    });
    expect(prompt).toContain('[truncated]');
    expect(prompt).toContain('Quick Audit cycle after each delegated reply:');
    expect(prompt).toContain('<!-- IMCODES_AUTOMATIC_AUDIT: PASS -->');
    expect(prompt).toContain('<!-- IMCODES_AUTOMATIC_AUDIT: REWORK -->');
    expect(prompt).toContain('REWORK is not a stopping response');
    expect(prompt).toContain('do not merely output REWORK and wait');
    expect(prompt).toContain('Apply the findings, run the relevant validation');
    expect(prompt).toContain('prepare the next audit brief yourself');
    expect(prompt).toContain('send one fresh reply-enabled audit to the same Target ID');
    expect(prompt).toContain('Repeat repair -> re-audit autonomously until PASS');
    expect(prompt).toContain('Only when an exact blocker or safety limit prevents another cycle');
    expect(prompt).toContain('Never finalize the repository or delivery from a REWORK verdict.');
  });

  it('localizes quick-audit orchestration while preserving exact protocol tokens', () => {
    const task = buildQuickAgentDelegationTask('audit', '', 'zh-CN');
    expect(task).toContain('独立审计本会话最近的工作');
    expect(task).not.toContain('Ask the selected delegate');

    const prompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: 'deck_sub_reviewer',
      targetLabel: '审计员',
      task,
      auditCycle: true,
      uiLocale: 'zh-CN',
    });
    expect(prompt).toContain('目标 ID（直接传给 send_message，不要再查询）：deck_sub_reviewer');
    expect(prompt).toContain('修复→复审');
    expect(prompt).toContain('send_message(target="deck_sub_reviewer", reply=true)');
    expect(prompt).toContain('<!-- IMCODES_AUTOMATIC_AUDIT: PASS -->');
    expect(prompt).not.toContain('You are the current session orchestrator');
  });

  it('builds quick presets as ordinary delegation tasks and keeps custom text exact', () => {
    const audit = buildQuickAgentDelegationTask('audit');
    expect(audit).toContain('current session context');
    expect(audit).toContain('non-destructive tests');
    expect(audit).toContain('PASS or REWORK');
    expect(audit).not.toContain('replyCapability');
    expect(audit).not.toContain('baseline');

    expect(buildQuickAgentDelegationTask('discussion')).toContain('challenge the approach');
    expect(buildQuickAgentDelegationTask('brainstorm')).toContain('practical alternatives');
    expect(buildQuickAgentDelegationTask('custom', '  inspect the cache race  ')).toBe('inspect the cache race');
  });

  it('detects and strips historical reply/delegation/imcodes-send/P2P control instructions from context', () => {
    const context = [
      'User asked for a refactor.',
      buildAgentDelegationReplyInstruction('deck_repo_brain'),
      'After completing the above task, send your response using: imcodes send --no-reply "deck_other_brain" "Task: old\\nResult: old"',
      'imcodes send --no-reply deck_other_brain "old reply"',
      'delegateTarget: { session: "deck_repo_w2" }',
      'Please discuss this @@discuss(deck_repo_w2,mode=review) before coding.',
      'Team token only: @@all(mode=audit)',
      'Config token: @@p2p-config(saved)',
      'Keep this useful line.',
    ].join('\n');

    expect(isAgentDelegationControlInstructionText(context)).toBe(true);
    expect(hasLegacyP2pControlToken(context)).toBe(true);

    const stripped = stripAgentDelegationControlInstructions(context);
    expect(stripped).toContain('User asked for a refactor.');
    expect(stripped).toContain('Please discuss this before coding.');
    expect(stripped).toContain('Keep this useful line.');
    expect(stripped).not.toContain(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER);
    expect(stripped).not.toContain('imcodes send --no-reply');
    expect(stripped).not.toContain('delegateTarget');
    expect(stripped).not.toContain('@@discuss(');
    expect(stripped).not.toContain('@@all(');
    expect(stripped).not.toContain('@@p2p-config(');
  });

  it('detects forwarded delegation payload wrappers so they are never nested into later context', () => {
    expect(isAgentDelegationForwardedPayloadText(`${AGENT_DELEGATION_CONTEXT_HEADER}\nUser: prior`)).toBe(true);
    expect(isAgentDelegationForwardedPayloadText(`${AGENT_DELEGATION_CONTEXT_OMITTED_MARKER} omitted`)).toBe(true);
    expect(isAgentDelegationForwardedPayloadText(`${AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER} truncated`)).toBe(true);
    expect(isAgentDelegationForwardedPayloadText(buildAgentDelegationReplyInstruction('deck_repo_brain'))).toBe(true);
    expect(isAgentDelegationForwardedPayloadText('plain task')).toBe(false);
  });
});
