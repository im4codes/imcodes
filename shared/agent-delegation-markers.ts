/**
 * Client-side (web) parsing of the daemon-injected agent-delegation protocol
 * markers that ride inside ordinary message text — never model-controllable,
 * always composed by the exact builders in `agent-delegation.ts`
 * (`buildAgentDelegationSenderLine`, `buildAgentDelegationReplyInstruction`).
 *
 * These blocks are meant for the receiving agent, not for a human reading the
 * chat transcript to parse by eye. This module extracts them from a message's
 * raw text so the web UI can render a compact collapsed-by-default card
 * instead of the raw tagged block, while the daemon-delivered text (what the
 * agent actually receives) is completely unchanged.
 *
 * The delegation-completion notification (`<imcodes-delegation-completed-v1>`)
 * is deliberately NOT handled here: the daemon emits it as a separate,
 * already-carded `delegation.reply` structured timeline event
 * (`AGENT_DELEGATION_REPLY_TIMELINE_EVENT`, see ChatView.tsx), so the raw
 * marker text is never rendered as a plain message bubble in the first place.
 *
 * Every extractor is anchored to the EXACT deterministic format its composer
 * produces (never a loose heuristic) — a message whose text merely mentions
 * one of these marker strings without matching the real shape is left alone.
 */
import {
  AGENT_DELEGATION_SENDER_MARKER,
  AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER,
  AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER,
} from './agent-delegation.js';

export interface DelegationSenderCard {
  kind: 'sender';
  sessionName: string;
  label?: string;
}

export interface DelegationReplyInstructionCard {
  kind: 'reply-instruction';
  version: 'v1' | 'v2';
  replyTool?: 'peer_audit_reply' | 'delegation_reply';
  target?: string;
  delegationId?: string;
  /** The exact matched block text, shown verbatim when expanded. */
  raw: string;
}

export interface ParsedDelegationMessage {
  /** Remaining human/agent-authored prose after any leading/trailing blocks are extracted. */
  prose: string;
  leadingSender?: DelegationSenderCard;
  trailingReply?: DelegationReplyInstructionCard;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SENDER_LEADING_RE = new RegExp(
  `^${escapeRegExp(AGENT_DELEGATION_SENDER_MARKER)}\\nMessage from IM\\.codes session: (\\S+)(?: \\(label: (.+?)\\))?\\n\\n`,
);

const V2_TRAILING_RE = new RegExp(
  `\\n\\n${escapeRegExp(AGENT_DELEGATION_STRUCTURED_REPLY_INSTRUCTION_MARKER)} (\\{.*\\})(?:\\n(\\{.*\\}))?$`,
);

const V1_TRAILING_RE = new RegExp(
  `\\n\\n${escapeRegExp(AGENT_DELEGATION_REPLY_INSTRUCTION_MARKER)}\\nAfter completing the above task, send your response using: imcodes send ("(?:[^"\\\\]|\\\\.)*") "(?:[^"\\\\]|\\\\.)*"$`,
);

export function parseDelegationProtocolMessage(text: string): ParsedDelegationMessage {
  let working = text;
  let leadingSender: DelegationSenderCard | undefined;
  const senderMatch = SENDER_LEADING_RE.exec(working);
  if (senderMatch) {
    leadingSender = { kind: 'sender', sessionName: senderMatch[1]!, label: senderMatch[2] };
    working = working.slice(senderMatch[0].length);
  }

  let trailingReply: DelegationReplyInstructionCard | undefined;
  const v2Match = V2_TRAILING_RE.exec(working);
  if (v2Match) {
    let delegationId: string | undefined;
    let replyTool: DelegationReplyInstructionCard['replyTool'];
    let target: string | undefined;
    try {
      const first = JSON.parse(v2Match[1]!) as { delegationId?: unknown };
      if (typeof first.delegationId === 'string') delegationId = first.delegationId;
    } catch { /* leave undefined — the raw block still renders */ }
    if (v2Match[2]) {
      try {
        const second = JSON.parse(v2Match[2]) as { tool?: unknown; binding?: { target?: unknown } };
        if (second.tool === 'peer_audit_reply' || second.tool === 'delegation_reply') replyTool = second.tool;
        if (typeof second.binding?.target === 'string') target = second.binding.target;
      } catch { /* leave undefined */ }
    }
    trailingReply = { kind: 'reply-instruction', version: 'v2', replyTool, target, delegationId, raw: v2Match[0].trim() };
    working = working.slice(0, working.length - v2Match[0].length);
  } else {
    const v1Match = V1_TRAILING_RE.exec(working);
    if (v1Match) {
      let target: string | undefined;
      try { target = JSON.parse(v1Match[1]!) as string; } catch { /* leave undefined */ }
      trailingReply = { kind: 'reply-instruction', version: 'v1', target, raw: v1Match[0].trim() };
      working = working.slice(0, working.length - v1Match[0].length);
    }
  }

  return { prose: working, leadingSender, trailingReply };
}
