import { describe, expect, it } from 'vitest';
import {
  AGENT_DELEGATION_ERROR_CODES,
  AGENT_DELEGATION_CONTEXT_HEADER,
  AGENT_DELEGATION_CONTEXT_OMITTED_MARKER,
  AGENT_DELEGATION_CONTEXT_TRUNCATED_MARKER,
  AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER,
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
  buildAgentDelegationReplyInstruction,
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
      'opencode',
      'gemini-sdk',
      'gemini',
      'qwen',
      'openclaw',
      'kimi-sdk',
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

  it('builds a current-session orchestration prompt for UI-picked single-agent delegation', () => {
    const prompt = buildAgentDelegationOrchestrationPrompt({
      targetSession: 'deck_repo_w1',
      targetLabel: 'Worker One',
      task: 'review the queue sync bug',
    });
    expect(prompt).toContain('current session orchestrator');
    expect(prompt).toContain('Worker One (deck_repo_w1)');
    expect(prompt).toContain('review the queue sync bug');
    expect(prompt).toContain('organize the relevant current-session context yourself');
    expect(prompt).toContain('Do not send the raw user task by itself.');
    expect(prompt).toContain('imcodes send --reply "deck_repo_w1"');
    expect(prompt).not.toContain('imcodes send --no-reply "deck_repo_w1"');
    expect(prompt).toContain('multiple @ delegates');
    expect(prompt).toContain('separate per-delegate briefs');
    expect(prompt).toContain('each delegate result separately');
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
