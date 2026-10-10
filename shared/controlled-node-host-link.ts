import { DAEMON_MSG } from './daemon-events.js';

/**
 * Automatic link between a controlled node and the daemon on the same computer.
 *
 * The node runs with system rights, so it can see which daemons are bound on
 * its computer (each user's `.imcodes/server.json`). It reports only their
 * serverIds; the server decides whether to link, and links only a daemon of
 * the node's own owner. Either install order works: a node installed after the
 * daemon reports it at startup, a daemon installed after the node is found by
 * the node's periodic rescan.
 */

/** A report longer than this is not a real computer's daemon list. */
export const CONTROLLED_NODE_LOCAL_DAEMONS_MAX = 16;

/** How often the node rescans for daemons installed after it. */
export const CONTROLLED_NODE_LOCAL_DAEMONS_RESCAN_MS = 60_000;

/** Upper bound on the daemon credential file the node is willing to read. */
export const CONTROLLED_NODE_LOCAL_DAEMON_CREDENTIAL_MAX_BYTES = 64 * 1024;

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isPlausibleServerId(value: unknown): value is string {
  return typeof value === 'string' && SERVER_ID_PATTERN.test(value);
}

export interface ControlledNodeLocalDaemonsMessage {
  type: typeof DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS;
  serverIds: string[];
}

/** Exact-shape validation; anything else is dropped by the receiver. */
export function validateControlledNodeLocalDaemonsMessage(
  value: unknown,
): ControlledNodeLocalDaemonsMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('serverIds')) return null;
  if (record.type !== DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS) return null;
  const serverIds = record.serverIds;
  if (!Array.isArray(serverIds)
    || serverIds.length === 0
    || serverIds.length > CONTROLLED_NODE_LOCAL_DAEMONS_MAX
    || !serverIds.every(isPlausibleServerId)
    || new Set(serverIds).size !== serverIds.length) {
    return null;
  }
  return { type: DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS, serverIds: [...serverIds] };
}

/** What the server did with one report; for logs and tests. */
export const CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME = {
  LINKED: 'linked',
  /** The node already points at a live daemon of its owner; left alone. */
  KEPT: 'kept',
  /** None of the reported daemons belongs to the node's owner. */
  NONE: 'none',
  /** More than one of the owner's daemons is on this computer. */
  AMBIGUOUS: 'ambiguous',
  /** That daemon already has another node linked. */
  TAKEN: 'taken',
  /** The two already carry different remote-desktop host identities. */
  CONFLICT: 'conflict',
  NOT_FOUND: 'not_found',
} as const;
export type ControlledNodeHostAutoLinkOutcome =
  (typeof CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME)[keyof typeof CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME];
