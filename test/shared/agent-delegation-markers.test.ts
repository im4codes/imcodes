import { describe, expect, it } from 'vitest';
import {
  buildAgentDelegationReplyInstruction,
  buildAgentDelegationSenderLine,
  type AgentDelegationReplyAuthority,
} from '../../shared/agent-delegation.js';
import { parseDelegationProtocolMessage } from '../../shared/agent-delegation-markers.js';

describe('parseDelegationProtocolMessage', () => {
  it('extracts a leading sender line built by buildAgentDelegationSenderLine, with a label', () => {
    const senderLine = buildAgentDelegationSenderLine('deck_proj_brain', 'Brain');
    const text = `${senderLine}\n\nhello there`;

    const parsed = parseDelegationProtocolMessage(text);

    expect(parsed.leadingSender).toEqual({ kind: 'sender', sessionName: 'deck_proj_brain', label: 'Brain' });
    expect(parsed.prose).toBe('hello there');
    expect(parsed.trailingReply).toBeUndefined();
  });

  it('extracts a leading sender line without a label', () => {
    const senderLine = buildAgentDelegationSenderLine('deck_proj_w1');
    const text = `${senderLine}\n\nqueue this`;

    const parsed = parseDelegationProtocolMessage(text);

    expect(parsed.leadingSender).toEqual({ kind: 'sender', sessionName: 'deck_proj_w1', label: undefined });
    expect(parsed.prose).toBe('queue this');
  });

  it('leaves the message untouched when no marker is present', () => {
    const parsed = parseDelegationProtocolMessage('just an ordinary message');
    expect(parsed.leadingSender).toBeUndefined();
    expect(parsed.trailingReply).toBeUndefined();
    expect(parsed.prose).toBe('just an ordinary message');
  });

  it('extracts a v1 (unstructured) trailing reply instruction', () => {
    const instruction = buildAgentDelegationReplyInstruction('deck_proj_brain');
    const text = `start assigned work\n\n${instruction}`;

    const parsed = parseDelegationProtocolMessage(text);

    expect(parsed.prose).toBe('start assigned work');
    expect(parsed.trailingReply).toMatchObject({ kind: 'reply-instruction', version: 'v1', target: 'deck_proj_brain' });
    expect(parsed.trailingReply?.raw).toContain('imcodes send');
  });

  it('extracts a v2 structured delegation_reply instruction', () => {
    const authority: AgentDelegationReplyAuthority = { delegationId: 'del_abc123XYZ_-9' };
    const instruction = buildAgentDelegationReplyInstruction('deck_proj_brain', authority);
    const text = `continue exact assignment\n\n${instruction}`;

    const parsed = parseDelegationProtocolMessage(text);

    expect(parsed.prose).toBe('continue exact assignment');
    expect(parsed.trailingReply).toMatchObject({
      kind: 'reply-instruction',
      version: 'v2',
      replyTool: 'delegation_reply',
      target: 'deck_proj_brain',
      delegationId: 'del_abc123XYZ_-9',
    });
  });

  it('extracts a v2 structured peer_audit_reply instruction', () => {
    const authority: AgentDelegationReplyAuthority = {
      delegationId: 'del_abc123XYZ_-9',
      audit: {
        kind: 'supervision_audit', attemptId: 'auto-audit-1', auditedSessionName: 'deck_sub_worker',
        taskId: 'tsk_1', assignmentId: 'asg_1', revision: 'rev-1',
      },
    };
    const instruction = buildAgentDelegationReplyInstruction('deck_sub_auditor', authority);
    const text = `deliver exact existing audit\n\n${instruction}`;

    const parsed = parseDelegationProtocolMessage(text);

    expect(parsed.prose).toBe('deliver exact existing audit');
    expect(parsed.trailingReply).toMatchObject({
      kind: 'reply-instruction',
      version: 'v2',
      replyTool: 'peer_audit_reply',
      delegationId: 'del_abc123XYZ_-9',
    });
    // peer_audit_reply's binding carries taskId/assignmentId/attemptId/revision, not a bare target session.
    expect(parsed.trailingReply?.target).toBeUndefined();
  });

  it('extracts both a leading sender and a trailing reply instruction from the same message', () => {
    const senderLine = buildAgentDelegationSenderLine('deck_proj_brain', 'Brain');
    const authority: AgentDelegationReplyAuthority = { delegationId: 'del_abc123XYZ_-9' };
    const instruction = buildAgentDelegationReplyInstruction('deck_proj_brain', authority);
    const text = `${senderLine}\n\nplease do this\n\n${instruction}`;

    const parsed = parseDelegationProtocolMessage(text);

    expect(parsed.leadingSender).toEqual({ kind: 'sender', sessionName: 'deck_proj_brain', label: 'Brain' });
    expect(parsed.prose).toBe('please do this');
    expect(parsed.trailingReply).toMatchObject({ version: 'v2', replyTool: 'delegation_reply' });
  });

  it('does not match a message that merely mentions the marker text without the exact composed shape', () => {
    const parsed = parseDelegationProtocolMessage('here is a doc explaining <imcodes-agent-delegation-sender-v1> format');
    expect(parsed.leadingSender).toBeUndefined();
    expect(parsed.prose).toBe('here is a doc explaining <imcodes-agent-delegation-sender-v1> format');
  });
});
