import type { SharedActorEnvelope } from '../../../shared/tab-sharing.js';
import {
  OWNER_MACHINE_AUTHORITY_FIELD,
  SHARED_MACHINE_AUTHORITY_FIELD,
} from '../../../shared/shared-machine-authority.js';
import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../../shared/memory-mcp-contracts.js';
import { getSession } from '../../store/session-store.js';
import type { SessionDispatchActorOption } from '../session-dispatch.js';
import {
  AMBIGUOUS_PARTICIPANT_ACTOR,
  readSenderOwnerMachineAuthority,
  readSenderParticipantTurn,
} from '../sender-participant-turn.js';

/**
 * Persisted machine-control authority context for a task pair or decision wake
 * notification. Never exported to UI/MCP snapshots or timeline payloads.
 */
export type TaskPairAuthorityContext =
  | {
      kind: 'owner';
      ownerMachineAuthority: string;
    }
  | {
      kind: 'participant';
      sharedActor: SharedActorEnvelope;
      sharedMachineAuthority?: string;
    };

function buildParticipantActorEnvelope(
  actorUserId: string,
  senderSessionName: string,
  now = Date.now(),
): SharedActorEnvelope {
  const senderRecord = getSession(senderSessionName);
  const actorDisplayName = senderRecord?.label?.trim() || senderRecord?.name || senderSessionName;
  const targetSnapshot = senderSessionName.startsWith('deck_sub_')
    ? {
        kind: 'subsession' as const,
        serverId: 'local',
        subSessionId: senderSessionName,
        ...(senderRecord?.label ? { subSessionDisplayName: senderRecord.label } : {}),
      }
    : {
        kind: 'main' as const,
        serverId: 'local',
        sessionName: senderSessionName,
      };
  return {
    actorUserId,
    actorDisplayName,
    snapshot: {
      target: targetSnapshot,
      effectiveRole: 'participant',
      historyCutoffAt: 0,
      nextCoverageRecheckAt: null,
      coveringShareIds: [],
      primaryShareId: null,
      authorizedAt: now,
    },
    primaryShareId: null,
    effectiveActorRole: 'participant',
    actionId: `pair-participant-${now}`,
    origin: 'server-member',
    authorizedAt: now,
    queuedAt: now,
  };
}

function isValidSharedActorEnvelope(value: unknown): value is SharedActorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.effectiveActorRole === 'participant'
    && typeof record.actorUserId === 'string'
    && record.actorUserId.trim().length > 0
    && typeof record.snapshot === 'object'
    && record.snapshot !== null;
}

export function parseTaskPairAuthority(raw: unknown): TaskPairAuthorityContext | undefined {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'owner') {
    const token = typeof record.ownerMachineAuthority === 'string' ? record.ownerMachineAuthority.trim() : '';
    return token ? { kind: 'owner', ownerMachineAuthority: token } : undefined;
  }
  if (record.kind === 'participant') {
    if (!isValidSharedActorEnvelope(record.sharedActor)) return undefined;
    const token = typeof record.sharedMachineAuthority === 'string' ? record.sharedMachineAuthority.trim() : '';
    return {
      kind: 'participant',
      sharedActor: record.sharedActor,
      ...(token ? { sharedMachineAuthority: token } : {}),
    };
  }
  return undefined;
}

export function serializeTaskPairAuthority(authority: TaskPairAuthorityContext | undefined): string | null {
  return authority ? JSON.stringify(authority) : null;
}

/**
 * Capture the active turn's machine authority from a daemon session (Brain / Executor / Auditor).
 * Returns `participant` when the caller is in a shared-participant turn, `owner` when the caller
 * is in an authenticated owner turn, or `undefined` when no turn authority is present.
 */
export function captureCallerPairAuthority(
  senderSessionName: string | null | undefined,
): TaskPairAuthorityContext | undefined {
  if (!senderSessionName) return undefined;
  const participantTurn = readSenderParticipantTurn(senderSessionName);
  if (participantTurn) {
    return {
      kind: 'participant',
      sharedActor: buildParticipantActorEnvelope(participantTurn.actorUserId, senderSessionName),
      ...(participantTurn.authority ? { sharedMachineAuthority: participantTurn.authority } : {}),
    };
  }
  const ownerAuthority = readSenderOwnerMachineAuthority(senderSessionName);
  if (ownerAuthority) {
    return {
      kind: 'owner',
      ownerMachineAuthority: ownerAuthority,
    };
  }
  return undefined;
}

/**
 * Extract server-stamped authority from an inbound WS/console command (e.g. `TASK_PAIR_DECISION_MSG.FEEDBACK`).
 * Participant actor/authority always wins over any owner token field.
 */
export function captureInboundCommandAuthority(
  cmd: Record<string, unknown> | null | undefined,
): TaskPairAuthorityContext | undefined {
  if (!cmd) return undefined;
  const rawActor = cmd.sharedActor;
  if (isValidSharedActorEnvelope(rawActor)) {
    const rawSharedToken = cmd[SHARED_MACHINE_AUTHORITY_FIELD];
    const sharedMachineAuthority = typeof rawSharedToken === 'string' && rawSharedToken.trim()
      ? rawSharedToken.trim()
      : undefined;
    return {
      kind: 'participant',
      sharedActor: rawActor,
      ...(sharedMachineAuthority ? { sharedMachineAuthority } : {}),
    };
  }
  const rawOwnerToken = cmd[OWNER_MACHINE_AUTHORITY_FIELD];
  const ownerMachineAuthority = typeof rawOwnerToken === 'string' && rawOwnerToken.trim()
    ? rawOwnerToken.trim()
    : undefined;
  if (ownerMachineAuthority) {
    return {
      kind: 'owner',
      ownerMachineAuthority,
    };
  }
  return undefined;
}

/**
 * Merge stored and incoming pair authority while enforcing non-escalation:
 * a participant-originated pair never upgrades to `owner` automatically on background
 * markers/heartbeats; only explicit authoritative Brain actions (`allowOwnerOverride: true`)
 * may replace an existing participant binding with an active Owner token.
 */
export function mergePairAuthority(
  existing: TaskPairAuthorityContext | undefined,
  incoming: TaskPairAuthorityContext | undefined,
  options?: { allowOwnerOverride?: boolean },
): TaskPairAuthorityContext | undefined {
  if (!incoming) return existing;
  if (incoming.kind === 'participant') {
    if (
      existing?.kind === 'participant'
      && existing.sharedActor.actorUserId !== incoming.sharedActor.actorUserId
    ) {
      return {
        kind: 'participant',
        sharedActor: {
          ...incoming.sharedActor,
          actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR,
          effectiveActorRole: 'participant',
        },
      };
    }
    return incoming;
  }
  // incoming.kind === 'owner'
  if (existing?.kind === 'participant' && !options?.allowOwnerOverride) {
    return existing;
  }
  return incoming;
}

export function toSessionDispatchActorOption(
  authority: TaskPairAuthorityContext | undefined,
): SessionDispatchActorOption {
  if (!authority) return {};
  if (authority.kind === 'owner') {
    return { ownerMachineAuthority: authority.ownerMachineAuthority };
  }
  return {
    sharedActor: authority.sharedActor,
    ...(authority.sharedMachineAuthority ? { sharedMachineAuthority: authority.sharedMachineAuthority } : {}),
    deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE,
  };
}

/**
 * Resolve authority across one or more task pairs for aggregate scheduler notices.
 * Mixed owner + participant sets fail closed under participant restriction so an owner
 * token is never attached to a turn carrying participant-originated state.
 */
export function resolveAggregatePairAuthority(
  authorities: ReadonlyArray<TaskPairAuthorityContext | undefined>,
): TaskPairAuthorityContext | undefined {
  const present = authorities.filter((entry): entry is TaskPairAuthorityContext => entry !== undefined);
  if (present.length === 0) return undefined;
  const participants = present.filter((entry): entry is Extract<TaskPairAuthorityContext, { kind: 'participant' }> => entry.kind === 'participant');
  const owners = present.filter((entry): entry is Extract<TaskPairAuthorityContext, { kind: 'owner' }> => entry.kind === 'owner');
  if (participants.length > 0) {
    const actors = new Set(participants.map((entry) => entry.sharedActor.actorUserId));
    const tokens = new Set(
      participants
        .map((entry) => entry.sharedMachineAuthority)
        .filter((token): token is string => typeof token === 'string' && token.length > 0),
    );
    if (actors.size === 1 && owners.length === 0 && tokens.size <= 1) {
      const last = participants[participants.length - 1]!;
      const token = tokens.size === 1 ? [...tokens][0] : undefined;
      return {
        kind: 'participant',
        sharedActor: last.sharedActor,
        ...(token ? { sharedMachineAuthority: token } : {}),
      };
    }
    return {
      kind: 'participant',
      sharedActor: {
        ...participants[0]!.sharedActor,
        actorUserId: AMBIGUOUS_PARTICIPANT_ACTOR,
        effectiveActorRole: 'participant',
      },
    };
  }
  return owners[owners.length - 1];
}
