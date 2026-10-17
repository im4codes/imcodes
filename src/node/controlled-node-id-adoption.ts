/**
 * A credential written before controlled nodes had a public ID has no `nodeId`, and the node cannot work its ID out for itself: the
 * local management panel and the local aiDesk IPC (both keyed by that ID) then never start, whatever the node's version. The server
 * knows the ID (migration 086 backfilled it) and puts it, with the internal server ID, in every heartbeat ack of an authenticated
 * controlled node. This adopts it once:
 *
 *   - only an ID in the canonical 10-digit form, from an ack addressed to THIS node's own server ID;
 *   - an ID the credential already holds is never replaced by a different one (a warning is logged once instead);
 *   - the local management surface starts at once in the running process, whether or not the credential could be written yet;
 *   - the credential is written back through the protected, atomic writer (temp file + rename, 0600 / the Windows ACL commands);
 *     a failed write never affects the node, is logged on the first failure and again when it gives up, and is retried on the next ack
 *     up to a small bound.
 */
import {
  CONTROLLED_NODE_ACK_NODE_ID_FIELD,
  CONTROLLED_NODE_ACK_SERVER_ID_FIELD,
  parseControlledNodeId,
  type ControlledNodeId,
} from '../../shared/controlled-node-identity.js';
import type { ControlledNodeCredential } from './enrollment.js';

/** Writes of the credential attempted per process before giving up until the next start. */
export const CONTROLLED_NODE_ID_PERSIST_MAX_ATTEMPTS = 5;

export interface ControlledNodeIdAdoptionLog {
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
}

export interface ControlledNodeIdAdoptionOptions {
  credential: ControlledNodeCredential;
  persist(credential: ControlledNodeCredential): Promise<void>;
  /** Called once with the adopted ID, before the credential is written; a failure is logged and never reaches the node. */
  start(nodeId: ControlledNodeId): Promise<void> | void;
  log: ControlledNodeIdAdoptionLog;
  maxPersistAttempts?: number;
}

/** The identity part of a heartbeat ack (anything else on the ack is none of this module's business). */
export function assignedIdentityOfAck(ack: Record<string, unknown>): { nodeId: unknown; serverId: unknown } {
  return { nodeId: ack[CONTROLLED_NODE_ACK_NODE_ID_FIELD], serverId: ack[CONTROLLED_NODE_ACK_SERVER_ID_FIELD] };
}

export function createControlledNodeIdAdopter(
  options: ControlledNodeIdAdoptionOptions,
): (assigned: { nodeId: unknown; serverId: unknown }) => Promise<void> {
  const maxAttempts = options.maxPersistAttempts ?? CONTROLLED_NODE_ID_PERSIST_MAX_ATTEMPTS;
  const held = parseControlledNodeId(options.credential.nodeId);
  let adopted: ControlledNodeId | null = held;
  let started = held !== null;
  let persisted = held !== null;
  let attempts = 0;
  let persistInFlight = false;
  let warnedForeignServer = false;
  let warnedMismatch = false;
  let warnedGaveUp = false;

  return async (assigned) => {
    const nodeId = parseControlledNodeId(assigned.nodeId);
    if (!nodeId) return;
    if (assigned.serverId !== options.credential.serverId) {
      if (!warnedForeignServer) {
        warnedForeignServer = true;
        options.log.warn({ nodeId }, 'ignored a public node ID addressed to a different server ID');
      }
      return;
    }
    if (adopted && adopted !== nodeId) {
      if (!warnedMismatch) {
        warnedMismatch = true;
        options.log.warn({ held: adopted, offered: nodeId }, 'the server offered a different public node ID than this node already holds; keeping the one it holds');
      }
      return;
    }
    if (!started) {
      started = true;
      adopted = nodeId;
      try {
        await options.start(nodeId);
      } catch (error) {
        options.log.warn({ err: error, nodeId }, 'the local management surface could not start after adopting the public node ID');
      }
    }
    if (persisted || persistInFlight || attempts >= maxAttempts) return;
    persistInFlight = true;
    attempts += 1;
    try {
      await options.persist({ ...options.credential, nodeId });
      persisted = true;
      options.log.info({ nodeId, attempts }, 'recorded the public node ID in the credential');
    } catch (error) {
      if (attempts === 1) {
        options.log.warn({ err: error, nodeId }, 'could not record the public node ID in the credential; will retry on a later heartbeat');
      } else if (attempts >= maxAttempts && !warnedGaveUp) {
        warnedGaveUp = true;
        options.log.warn({ err: error, nodeId, attempts }, 'gave up recording the public node ID in the credential until the next start');
      }
    } finally {
      persistInFlight = false;
    }
  };
}
