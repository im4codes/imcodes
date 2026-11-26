/**
 * @vitest-environment jsdom
 */
import { h } from 'preact';
import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown, extra?: unknown) => {
      const opts = (typeof options === 'object' && options !== null ? options : extra) as
        | Record<string, unknown>
        | undefined;
      const template = typeof options === 'string'
        ? options
        : typeof (opts?.defaultValue) === 'string'
          ? (opts!.defaultValue as string)
          : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));

import { DelegationReplyInstructionCardView, DelegationSenderCardView } from '../../src/components/DelegationProtocolCard.js';
import {
  parseDelegationProtocolMessage,
  type DelegationReplyInstructionCard,
  type DelegationSenderCard,
} from '../../../shared/agent-delegation-markers.js';
import {
  buildAgentDelegationReplyInstruction,
  buildAgentDelegationSenderLine,
  type AgentDelegationReplyAuthority,
} from '../../../shared/agent-delegation.js';

afterEach(() => {
  cleanup();
});

describe('DelegationSenderCardView', () => {
  it('renders collapsed by default, with session name and label visible', () => {
    const card: DelegationSenderCard = { kind: 'sender', sessionName: 'deck_proj_brain', label: 'Brain' };
    const { container } = render(<DelegationSenderCardView card={card} />);

    const details = container.querySelector('details.delegation-protocol-card--sender') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.textContent).toContain('deck_proj_brain');
    expect(details.textContent).toContain('Brain');
  });

  it('renders only the session field, not a label field, when no label was given', () => {
    const card: DelegationSenderCard = { kind: 'sender', sessionName: 'deck_proj_w1' };
    const { container } = render(<DelegationSenderCardView card={card} />);

    expect(container.querySelectorAll('.delegation-protocol-card-field').length).toBe(1);
    expect(container.textContent).toContain('deck_proj_w1');
  });

  it('round-trips through the real parser and builder for a labeled sender', () => {
    const senderLine = buildAgentDelegationSenderLine('deck_proj_brain', 'Brain');
    const parsed = parseDelegationProtocolMessage(`${senderLine}\n\nhello`);
    expect(parsed.leadingSender).toBeDefined();

    const { container } = render(<DelegationSenderCardView card={parsed.leadingSender!} />);
    expect(container.textContent).toContain('deck_proj_brain');
    expect(container.textContent).toContain('Brain');
  });
});

describe('DelegationReplyInstructionCardView', () => {
  it('renders a v1 instruction collapsed with the reply target visible', () => {
    const card: DelegationReplyInstructionCard = {
      kind: 'reply-instruction', version: 'v1', target: 'deck_proj_brain', raw: 'raw v1 text',
    };
    const { container } = render(<DelegationReplyInstructionCardView card={card} />);

    const details = container.querySelector('details.delegation-protocol-card--reply') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.textContent).toContain('deck_proj_brain');
    expect(details.textContent).toContain('imcodes send');
  });

  it('renders a v2 delegation_reply instruction with delegationId and tool name', () => {
    const card: DelegationReplyInstructionCard = {
      kind: 'reply-instruction', version: 'v2', replyTool: 'delegation_reply',
      target: 'deck_proj_brain', delegationId: 'del_abc123', raw: '{"tool":"delegation_reply"}',
    };
    const { container } = render(<DelegationReplyInstructionCardView card={card} />);

    expect(container.textContent).toContain('delegation_reply');
    expect(container.textContent).toContain('del_abc123');
    expect(container.textContent).toContain('deck_proj_brain');
  });

  it('round-trips through the real parser and builder for a v2 peer_audit_reply instruction', () => {
    const authority: AgentDelegationReplyAuthority = {
      delegationId: 'del_xyz789',
      audit: {
        kind: 'supervision_audit', attemptId: 'auto-audit-1', auditedSessionName: 'deck_sub_worker',
        taskId: 'tsk_1', assignmentId: 'asg_1', revision: 'rev-1',
      },
    };
    const instruction = buildAgentDelegationReplyInstruction('deck_sub_auditor', authority);
    const parsed = parseDelegationProtocolMessage(`deliver exact existing audit\n\n${instruction}`);
    expect(parsed.trailingReply).toBeDefined();
    expect(parsed.prose).toBe('deliver exact existing audit');

    const { container } = render(<DelegationReplyInstructionCardView card={parsed.trailingReply!} />);
    expect(container.textContent).toContain('peer_audit_reply');
    expect(container.textContent).toContain('del_xyz789');
  });

  it('exposes the raw instruction text inside a nested collapsed details', () => {
    const card: DelegationReplyInstructionCard = {
      kind: 'reply-instruction', version: 'v1', target: 'deck_proj_brain', raw: 'the exact raw block',
    };
    const { container } = render(<DelegationReplyInstructionCardView card={card} />);

    const rawDetails = container.querySelector('.delegation-protocol-card-raw') as HTMLDetailsElement;
    expect(rawDetails).not.toBeNull();
    expect(rawDetails.hasAttribute('open')).toBe(false);
    expect(rawDetails.textContent).toContain('the exact raw block');
  });
});
