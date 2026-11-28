/**
 * Whose turn is a session in right now -- the question an agent-to-agent message must answer about its SENDER.
 *
 * A shared-session participant's message makes the owner's agent run a turn under restricted authority (machine access follows the
 * participant's own access, exec_remote is refused). If that agent could simply send_message a sibling session, the sibling
 * would run the same request as an ordinary owner turn: the restriction would end at the first hop. The sender's participant context
 * is therefore read here and stamped on the message (session-dispatch.ts), so the receiving turn is bound to the same participant.
 */
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import {
  readActiveTreeAuthorityForSession,
  readProcessSharedMachineAuthority,
  readProcessSharedMachineParticipants,
} from './shared-machine-authority-context.js';

export interface SenderParticipantTurn {
  /** The participant that started the turn; a placeholder when several users fed it. */
  actorUserId: string;
  /** The server-minted token of the single participant; null when there is none or several (the receiver then fails closed). */
  authority: string | null;
}

export const AMBIGUOUS_PARTICIPANT_ACTOR = 'participant';

/** Null when the sender is not in a participant turn (an owner turn, or no such session). Synchronous: in-memory registries only. */
export function readSenderParticipantTurn(senderSessionName: string | null | undefined): SenderParticipantTurn | null {
  if (!senderSessionName) return null;
  const record = getSession(senderSessionName);
  if (!record) return null;
  const tree = readActiveTreeAuthorityForSession(senderSessionName);
  const runtime = getTransportRuntime(senderSessionName);
  if (runtime) {
    // Every real runtime has these; a runtime-shaped stand-in that lacks them reads as an owner turn instead of failing the send.
    if (runtime.requiresSharedMachineAuthority?.()) {
      const actors = new Set(runtime.activeTurnParticipantUserIds?.()
        ?? (runtime.activeDispatchEntries ?? [])
          .filter((entry) => entry.sharedActor?.effectiveActorRole === 'participant')
          .map((entry) => entry.sharedActor!.actorUserId)
          .filter((id) => typeof id === 'string' && id));
      const localAuthority = runtime.getActiveSharedMachineAuthority?.() ?? null;
      if (tree?.kind === 'mixed') {
        return { actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR, authority: null };
      }
      if (!localAuthority) {
        return {
          actorUserId: actors.size === 1 ? [...actors][0]! : AMBIGUOUS_PARTICIPANT_ACTOR,
          authority: null,
        };
      }
      return {
        actorUserId: actors.size === 1 ? [...actors][0]! : (tree?.actorUserId ?? AMBIGUOUS_PARTICIPANT_ACTOR),
        authority: tree?.kind === 'participant' ? tree.authority : localAuthority,
      };
    }
    if (tree?.kind === 'participant' || tree?.kind === 'mixed') {
      return {
        actorUserId: tree.actorUserId ?? AMBIGUOUS_PARTICIPANT_ACTOR,
        authority: tree.kind === 'participant' ? tree.authority : null,
      };
    }
    return null;
  }
  if (!record.sessionInstanceId || !record.runtimeEpoch) {
    if (tree?.kind === 'participant' || tree?.kind === 'mixed') {
      return {
        actorUserId: tree.actorUserId ?? AMBIGUOUS_PARTICIPANT_ACTOR,
        authority: tree.kind === 'participant' ? tree.authority : null,
      };
    }
    return null;
  }
  const process = readProcessSharedMachineAuthority(
    senderSessionName,
    { sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch },
    Date.now(),
    record.state === 'running',
  );
  if (!process.required) {
    if (tree?.kind === 'participant' || tree?.kind === 'mixed') {
      return {
        actorUserId: tree.actorUserId ?? AMBIGUOUS_PARTICIPANT_ACTOR,
        authority: tree.kind === 'participant' ? tree.authority : null,
      };
    }
    return null;
  }
  if (!process.authority || tree?.kind === 'mixed') {
    const actors = readProcessSharedMachineParticipants(senderSessionName);
    return {
      actorUserId: actors.length === 1 ? actors[0]! : AMBIGUOUS_PARTICIPANT_ACTOR,
      authority: null,
    };
  }
  const actors = readProcessSharedMachineParticipants(senderSessionName);
  return {
    actorUserId: actors.length === 1 ? actors[0]! : (tree?.actorUserId ?? AMBIGUOUS_PARTICIPANT_ACTOR),
    authority: tree?.kind === 'participant' ? tree.authority : process.authority,
  };
}

/**
 * Returns the active owner-turn machine authority token when the sender session is running an
 * authenticated owner turn (never participant or mixed). Synchronous: in-memory registries only.
 */
export function readSenderOwnerMachineAuthority(senderSessionName: string | null | undefined): string | null {
  if (!senderSessionName) return null;
  if (readSenderParticipantTurn(senderSessionName)) return null;
  const record = getSession(senderSessionName);
  if (!record) return null;
  const tree = readActiveTreeAuthorityForSession(senderSessionName);
  if (tree?.kind === 'owner' && tree.authority) return tree.authority;
  const runtime = getTransportRuntime(senderSessionName);
  if (runtime) {
    return runtime.getActiveOwnerMachineAuthority?.() ?? null;
  }
  if (!record.sessionInstanceId || !record.runtimeEpoch) return null;
  const process = readProcessSharedMachineAuthority(
    senderSessionName,
    { sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch },
    Date.now(),
    record.state === 'running',
  );
  return !process.required ? process.authority : null;
}
