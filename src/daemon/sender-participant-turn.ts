/**
 * Whose turn is a session in right now -- the question an agent-to-agent message must answer about its SENDER.
 *
 * A shared-session participant's message makes the owner's agent run a turn under restricted authority (machine access follows the
 * participant's own access, exec_remote is refused). Both agent-to-agent participant/owner stamping and hook resolution read the exact
 * same canonical tree-turn resolver so local runtime/process state and tree state cannot disagree.
 */
import { SHARED_MACHINE_AUTHORITY_ACTOR_KIND } from '../../shared/shared-machine-authority.js';
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import {
  AMBIGUOUS_TREE_PARTICIPANT_ACTOR,
  resolveCanonicalTurnAuthority,
} from './shared-machine-authority-context.js';

export interface SenderParticipantTurn {
  /** The participant that started the turn; a placeholder when several users fed it. */
  actorUserId: string;
  /** The server-minted token of the single participant; null when there is none or several (the receiver then fails closed). */
  authority: string | null;
}

export const AMBIGUOUS_PARTICIPANT_ACTOR = AMBIGUOUS_TREE_PARTICIPANT_ACTOR;

/** Null when the sender is not in a participant turn (an owner turn, or no such session). Synchronous: in-memory registries only. */
export function readSenderParticipantTurn(senderSessionName: string | null | undefined): SenderParticipantTurn | null {
  if (!senderSessionName) return null;
  const record = getSession(senderSessionName);
  if (!record) return null;
  const runtime = getTransportRuntime(senderSessionName) ?? null;
  const identity = record.sessionInstanceId && record.runtimeEpoch
    ? { sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch }
    : null;
  const resolved = resolveCanonicalTurnAuthority({
    sessionName: senderSessionName,
    identity,
    sessionRunning: record.state === 'running',
    runtime,
  });
  if (!resolved.isParticipantScoped && !resolved.required) return null;
  return {
    actorUserId: resolved.actorUserId ?? AMBIGUOUS_PARTICIPANT_ACTOR,
    authority: resolved.authority,
  };
}

/**
 * Returns the active owner-turn machine authority token when the sender session is running an
 * authenticated owner turn (never participant or mixed). Synchronous: in-memory registries only.
 */
export function readSenderOwnerMachineAuthority(senderSessionName: string | null | undefined): string | null {
  if (!senderSessionName) return null;
  const record = getSession(senderSessionName);
  if (!record) return null;
  const runtime = getTransportRuntime(senderSessionName) ?? null;
  const identity = record.sessionInstanceId && record.runtimeEpoch
    ? { sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch }
    : null;
  const resolved = resolveCanonicalTurnAuthority({
    sessionName: senderSessionName,
    identity,
    sessionRunning: record.state === 'running',
    runtime,
  });
  if (resolved.isParticipantScoped || resolved.required) return null;
  return resolved.actorKind === SHARED_MACHINE_AUTHORITY_ACTOR_KIND.OWNER ? resolved.authority : null;
}
