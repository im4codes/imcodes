import { ASK_ANSWER_COMMAND } from '../../../shared/ask-answer.js';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import { SHARE_BROWSER_COMMANDS } from '../../../shared/tab-sharing.js';
import { TRANSPORT_MSG } from '../../../shared/transport-events.js';

/**
 * Ordering lanes for the messages of one share-scoped browser socket.
 *
 * - `priority`: never queued. Stop, approval/feedback answers and pings must not
 *   wait behind anything (CLAUDE.md: the priority path is never blocked by
 *   ordinary command work).
 * - `input`: keyboard input and terminal resize. Strict arrival order, and never
 *   delayed by a slow command in the other lane.
 * - `command`: everything else, in arrival order.
 */
export const SHARE_MESSAGE_LANE = {
  PRIORITY: 'priority',
  INPUT: 'input',
  COMMAND: 'command',
} as const;
export type ShareMessageLane = (typeof SHARE_MESSAGE_LANE)[keyof typeof SHARE_MESSAGE_LANE];

/** Messages one socket may have waiting in one lane before further ones are dropped (and counted). */
export const SHARE_MESSAGE_LANE_MAX_PENDING = 2_000;

const PRIORITY_TYPES: ReadonlySet<string> = new Set([
  'ping',
  DAEMON_COMMAND_TYPES.SESSION_CANCEL,
  TRANSPORT_MSG.APPROVAL_RESPONSE,
  SHARE_BROWSER_COMMANDS.CHAT_APPROVAL_RESPONSE,
  ASK_ANSWER_COMMAND,
]);

const INPUT_TYPES: ReadonlySet<string> = new Set([
  DAEMON_COMMAND_TYPES.SESSION_INPUT,
  DAEMON_COMMAND_TYPES.SESSION_RESIZE,
  SHARE_BROWSER_COMMANDS.TERMINAL_INPUT,
  SHARE_BROWSER_COMMANDS.TERMINAL_RESIZE,
]);

// Every browser client writes `type` first, so a prefix match avoids parsing
// the whole payload just to pick a lane. A message that does not match falls
// into the ordinary command lane, which is always safe.
const TYPE_PREFIX_RE = /^\s*\{\s*"type"\s*:\s*"([^"\\]{1,80})"/u;

export function shareBrowserMessageLane(data: unknown): ShareMessageLane {
  const head = typeof data === 'string'
    ? data.slice(0, 160)
    : (data as Buffer).subarray(0, 160).toString('utf8');
  const type = head.match(TYPE_PREFIX_RE)?.[1];
  if (!type) return SHARE_MESSAGE_LANE.COMMAND;
  if (PRIORITY_TYPES.has(type)) return SHARE_MESSAGE_LANE.PRIORITY;
  if (INPUT_TYPES.has(type)) return SHARE_MESSAGE_LANE.INPUT;
  return SHARE_MESSAGE_LANE.COMMAND;
}
