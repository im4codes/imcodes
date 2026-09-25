/**
 * Who authored a timeline `user.message`.
 *
 * `user.message` is the event type for everything delivered INTO a session's
 * input: what the human typed (web, mobile, voice), but also agent-to-agent
 * send_message deliveries, delegation notifications, supervision / task-pair /
 * heartbeat injections, cron runs, P2P and OpenSpec orchestration prompts.
 * The chat UI right-aligns only the human's own input, so the side is decided
 * by origin, never by event type.
 *
 * Every signal read here is daemon-authored (payload fields the daemon sets, or
 * the exact deterministic wrappers it prepends); none is model-controllable
 * prose. A message carrying none of them is the human's.
 */
import { AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER } from './agent-delegation.js';
import { parseDelegationProtocolMessage } from './agent-delegation-markers.js';
import { CRON_CONTROL_PROTOCOL, CRON_RUN_TIMELINE } from './cron-types.js';

export const CHAT_MESSAGE_ORIGINS = {
  /** Typed by the human (web, mobile, voice, resend). */
  USER: 'user',
  /** Delivered by another agent session (send_message, delegation). */
  AGENT: 'agent',
  /** Injected by the daemon (supervision, task pairs, heartbeat, cron, P2P, OpenSpec). */
  SYSTEM: 'system',
} as const;
export type ChatMessageOrigin = typeof CHAT_MESSAGE_ORIGINS[keyof typeof CHAT_MESSAGE_ORIGINS];

/** user.message payload fields that mark a daemon-authored message. */
export const USER_MESSAGE_ORIGIN_FIELDS = {
  /** Explicit origin stamp for daemon-authored prompts that carry no other marker. */
  ORIGIN: 'messageOrigin',
  AUTOMATION: 'automation',
  AUTOMATION_KIND: 'automationKind',
  P2P_RUN_ID: 'p2pRunId',
} as const;

export function isChatMessageOrigin(value: unknown): value is ChatMessageOrigin {
  return typeof value === 'string'
    && (Object.values(CHAT_MESSAGE_ORIGINS) as string[]).includes(value);
}

export function classifyUserMessageOrigin(payload: Record<string, unknown> | undefined): ChatMessageOrigin {
  if (!payload) return CHAT_MESSAGE_ORIGINS.USER;
  const stamped = payload[USER_MESSAGE_ORIGIN_FIELDS.ORIGIN];
  if (isChatMessageOrigin(stamped)) return stamped;
  const text = typeof payload.text === 'string' ? payload.text : '';
  // Agent deliveries: the daemon prepends the exact sender block; process
  // sessions echo it back verbatim from their own transcript.
  if (parseDelegationProtocolMessage(text).leadingSender) return CHAT_MESSAGE_ORIGINS.AGENT;
  if (text.trimStart().startsWith(AGENT_DELEGATION_COMPLETION_NOTIFICATION_MARKER)) return CHAT_MESSAGE_ORIGINS.AGENT;
  if (payload[USER_MESSAGE_ORIGIN_FIELDS.AUTOMATION] === true
    || typeof payload[USER_MESSAGE_ORIGIN_FIELDS.AUTOMATION_KIND] === 'string') {
    return CHAT_MESSAGE_ORIGINS.SYSTEM;
  }
  if (payload[CRON_RUN_TIMELINE.PAYLOAD_KEY] !== undefined) return CHAT_MESSAGE_ORIGINS.SYSTEM;
  if (text.trimStart().startsWith(CRON_CONTROL_PROTOCOL.OPEN_TAG)) return CHAT_MESSAGE_ORIGINS.SYSTEM;
  if (typeof payload[USER_MESSAGE_ORIGIN_FIELDS.P2P_RUN_ID] === 'string') return CHAT_MESSAGE_ORIGINS.SYSTEM;
  return CHAT_MESSAGE_ORIGINS.USER;
}
