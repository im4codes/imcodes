/**
 * Whose turn is a session in right now -- the question an agent-to-agent message must answer about its SENDER.
 *
 * A shared-session participant's message makes the owner's agent run a turn under restricted authority (machine access follows the
 * participant's own access, owner-level MCP tools are refused). If that agent could simply send_message a sibling session, the sibling
 * would run the same request as an ordinary owner turn: the restriction would end at the first hop. The sender's participant context
 * is therefore read here and stamped on the message (session-dispatch.ts), so the receiving turn is bound to the same participant.
 */
import { getSession } from '../store/session-store.js';
import { getTransportRuntime } from '../agent/session-manager.js';
import { readProcessSharedMachineAuthority, readProcessSharedMachineParticipants } from './shared-machine-authority-context.js';

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
  const runtime = getTransportRuntime(senderSessionName);
  if (runtime) {
    // Every real runtime has these; a runtime-shaped stand-in that lacks them reads as an owner turn instead of failing the send.
    if (!runtime.requiresSharedMachineAuthority?.()) return null;
    const actors = new Set((runtime.activeDispatchEntries ?? [])
      .filter((entry) => entry.sharedActor?.effectiveActorRole === 'participant')
      .map((entry) => entry.sharedActor!.actorUserId)
      .filter((id) => typeof id === 'string' && id));
    return {
      actorUserId: actors.size === 1 ? [...actors][0]! : AMBIGUOUS_PARTICIPANT_ACTOR,
      authority: runtime.getActiveSharedMachineAuthority?.() ?? null,
    };
  }
  if (!record.sessionInstanceId || !record.runtimeEpoch) return null;
  const process = readProcessSharedMachineAuthority(
    senderSessionName,
    { sessionInstanceId: record.sessionInstanceId, runtimeEpoch: record.runtimeEpoch },
    Date.now(),
    record.state === 'running',
  );
  if (!process.required) return null;
  const actors = readProcessSharedMachineParticipants(senderSessionName);
  return {
    actorUserId: actors.length === 1 ? actors[0]! : AMBIGUOUS_PARTICIPANT_ACTOR,
    authority: process.authority,
  };
}
