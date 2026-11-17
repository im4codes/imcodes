import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import type { MemoryMcpSendDeliveryMode } from '../../shared/memory-mcp-contracts.js';
import type { TransportSendMetadata, TransportSessionRuntime } from '../agent/transport-session-runtime.js';
import { getSession } from '../store/session-store.js';
import {
  readSenderOwnerMachineAuthority,
  readSenderParticipantTurn,
} from './sender-participant-turn.js';
import {
  buildAuthorizedSendOptions,
  type TurnMachineAuthorityContext,
} from './machine-authority.js';

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

/**
 * Capture the active turn's machine authority from a daemon session (Brain / Executor / Auditor / Origin).
 * Returns `participant` when the caller is in a shared-participant turn, `owner` when the caller
 * is in an authenticated owner turn, or `undefined` when no turn authority is present.
 */
export function captureSessionMachineAuthority(
  senderSessionName: string | null | undefined,
): TurnMachineAuthorityContext | undefined {
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

/** Alias retained for task-pair callers adopting the shared machine-authority helper. */
export const captureCallerPairAuthority = captureSessionMachineAuthority;

/**
 * Capture a delegation origin's authority context at creation time.
 * Live session authority (especially participant taint) takes strict precedence over any fallback owner token.
 */
export function captureDelegationOriginAuthority(
  originSessionName: string | null | undefined,
  fallbackOwnerMachineAuthority?: string,
): TurnMachineAuthorityContext | undefined {
  const live = captureSessionMachineAuthority(originSessionName);
  if (live) return live;
  const fallback = typeof fallbackOwnerMachineAuthority === 'string'
    ? fallbackOwnerMachineAuthority.trim()
    : '';
  return fallback ? { kind: 'owner', ownerMachineAuthority: fallback } : undefined;
}

/**
 * Capture owner authority from a live runtime BEFORE interrupting/cancelling it (e.g. watchdog `continue`).
 * Tolerates minimal test runtime mocks without `requiresSharedMachineAuthority` / `getActiveOwnerMachineAuthority`.
 * Fails closed (`undefined`) whenever `requiresSharedMachineAuthority?.()` is true.
 */
export function captureRuntimeOwnerAuthorityBeforeInterrupt(
  runtime: {
    requiresSharedMachineAuthority?: () => boolean;
    getActiveOwnerMachineAuthority?: () => string | null;
  } | null | undefined,
): TurnMachineAuthorityContext | undefined {
  if (!runtime || runtime.requiresSharedMachineAuthority?.()) return undefined;
  const token = runtime.getActiveOwnerMachineAuthority?.();
  return typeof token === 'string' && token.trim()
    ? { kind: 'owner', ownerMachineAuthority: token.trim() }
    : undefined;
}

/**
 * Send a message through a `TransportSessionRuntime` with unified fail-closed authority options.
 */
export function sendRuntimeWithPreservedAuthority(
  runtime: Pick<TransportSessionRuntime, 'send'>,
  text: string,
  commandId: string,
  authority: TurnMachineAuthorityContext | undefined,
  options?: Omit<TransportSendMetadata, 'ownerMachineAuthority' | 'sharedActor' | 'sharedMachineAuthority' | 'deliveryMode'> & {
    defaultDeliveryMode?: MemoryMcpSendDeliveryMode;
    fallbackOwnerMachineAuthority?: string;
  },
): ReturnType<TransportSessionRuntime['send']> {
  const { defaultDeliveryMode, fallbackOwnerMachineAuthority, messageOrigin, ...rest } = options ?? {};
  const authorized = buildAuthorizedSendOptions(authority, {
    ...(messageOrigin ? { messageOrigin } : {}),
    ...(defaultDeliveryMode ? { defaultDeliveryMode } : {}),
    ...(fallbackOwnerMachineAuthority ? { fallbackOwnerMachineAuthority } : {}),
  });
  return runtime.send(text, commandId, undefined, undefined, {
    ...rest,
    ...authorized,
  });
}
