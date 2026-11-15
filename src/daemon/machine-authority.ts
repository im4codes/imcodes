import type { ChatMessageOrigin } from '../../shared/chat-message-origin.js';
import {
  MEMORY_MCP_SEND_DELIVERY_MODES,
  type MemoryMcpSendDeliveryMode,
} from '../../shared/memory-mcp-contracts.js';
import {
  OWNER_MACHINE_AUTHORITY_FIELD,
  SHARED_MACHINE_AUTHORITY_FIELD,
} from '../../shared/shared-machine-authority.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';

/** Placeholder actor id used when multiple shared participants taint a single turn or notice. */
export const AMBIGUOUS_PARTICIPANT_ACTOR = 'participant';

/**
 * Persisted or in-flight machine-control authority context for a turn, delegation,
 * or task pair. Never exported to UI/MCP snapshots or timeline payloads.
 */
export type TurnMachineAuthorityContext =
  | {
      kind: 'owner';
      ownerMachineAuthority: string;
    }
  | {
      kind: 'participant';
      sharedActor: SharedActorEnvelope;
      sharedMachineAuthority?: string;
    };

export interface AuthorizedSendOptions {
  ownerMachineAuthority?: string;
  sharedActor?: SharedActorEnvelope;
  sharedMachineAuthority?: string;
  deliveryMode?: MemoryMcpSendDeliveryMode;
  messageOrigin?: ChatMessageOrigin;
}

export interface TurnAuthorityFieldCarrier {
  sharedActor?: SharedActorEnvelope;
  sharedMachineAuthority?: string;
  ownerMachineAuthority?: string;
}

export function isValidSharedActorEnvelope(value: unknown): value is SharedActorEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.effectiveActorRole === 'participant'
    && typeof record.actorUserId === 'string'
    && record.actorUserId.trim().length > 0
    && typeof record.snapshot === 'object'
    && record.snapshot !== null;
}

export function parseMachineAuthority(raw: unknown): TurnMachineAuthorityContext | undefined {
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

export function serializeMachineAuthority(authority: TurnMachineAuthorityContext | undefined): string | null {
  return authority ? JSON.stringify(authority) : null;
}

/**
 * Extract server-stamped authority from an inbound WS/console command (e.g. `FEEDBACK`, cron dispatch).
 * Participant actor/authority always wins over any owner token field.
 */
export function captureInboundCommandAuthority(
  cmd: Record<string, unknown> | null | undefined,
): TurnMachineAuthorityContext | undefined {
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
 * Merge stored and incoming authority while enforcing non-escalation:
 * a participant-originated binding never upgrades to `owner` automatically on background
 * markers/heartbeats; only explicit authoritative Brain actions (`allowOwnerOverride: true`)
 * may replace an existing participant binding with an active Owner token.
 */
export function mergeMachineAuthority(
  existing: TurnMachineAuthorityContext | undefined,
  incoming: TurnMachineAuthorityContext | undefined,
  options?: { allowOwnerOverride?: boolean },
): TurnMachineAuthorityContext | undefined {
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
  if (existing?.kind === 'participant' && !options?.allowOwnerOverride) {
    return existing;
  }
  return incoming;
}

/**
 * Resolve authority across one or more bindings/pairs for aggregate scheduler notices.
 * Mixed owner + participant sets fail closed under participant restriction so an owner
 * token is never attached to a turn carrying participant-originated state.
 */
export function resolveAggregateMachineAuthority(
  authorities: ReadonlyArray<TurnMachineAuthorityContext | undefined>,
): TurnMachineAuthorityContext | undefined {
  const present = authorities.filter((entry): entry is TurnMachineAuthorityContext => entry !== undefined);
  if (present.length === 0) return undefined;
  const participants = present.filter(
    (entry): entry is Extract<TurnMachineAuthorityContext, { kind: 'participant' }> => entry.kind === 'participant',
  );
  const owners = present.filter(
    (entry): entry is Extract<TurnMachineAuthorityContext, { kind: 'owner' }> => entry.kind === 'owner',
  );
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

/**
 * Convert a `TurnMachineAuthorityContext` (and optional fallback owner token) into send options.
 * Fail-closed: participant authority always strips owner tokens and forces `QUEUE` delivery unless
 * the caller explicitly omits deliveryMode handling downstream.
 */
export function buildAuthorizedSendOptions(
  authority: TurnMachineAuthorityContext | undefined,
  options?: {
    messageOrigin?: ChatMessageOrigin;
    defaultDeliveryMode?: MemoryMcpSendDeliveryMode;
    fallbackOwnerMachineAuthority?: string;
    forceParticipantQueue?: boolean;
  },
): AuthorizedSendOptions {
  const baseOrigin = options?.messageOrigin ? { messageOrigin: options.messageOrigin } : {};
  if (authority?.kind === 'participant') {
    const forceQueue = options?.forceParticipantQueue !== false;
    return {
      ...baseOrigin,
      sharedActor: authority.sharedActor,
      ...(authority.sharedMachineAuthority ? { sharedMachineAuthority: authority.sharedMachineAuthority } : {}),
      ...(forceQueue ? { deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE } : {}),
    };
  }
  const ownerToken = authority?.kind === 'owner'
    ? authority.ownerMachineAuthority
    : options?.fallbackOwnerMachineAuthority?.trim() || undefined;
  return {
    ...baseOrigin,
    ...(ownerToken ? { ownerMachineAuthority: ownerToken } : {}),
    ...(options?.defaultDeliveryMode ? { deliveryMode: options.defaultDeliveryMode } : {}),
  };
}

/**
 * Extract only defined authority carrier fields from a send/dispatch entry while enforcing
 * non-escalation: if `sharedActor` is a participant, `ownerMachineAuthority` is dropped.
 */
export function pickTurnAuthorityFields(
  source: TurnAuthorityFieldCarrier | null | undefined,
): TurnAuthorityFieldCarrier {
  if (!source) return {};
  const isParticipant = source.sharedActor?.effectiveActorRole === 'participant';
  return {
    ...(source.sharedActor ? { sharedActor: source.sharedActor } : {}),
    ...(source.sharedMachineAuthority ? { sharedMachineAuthority: source.sharedMachineAuthority } : {}),
    ...(!isParticipant && source.ownerMachineAuthority ? { ownerMachineAuthority: source.ownerMachineAuthority } : {}),
  };
}
