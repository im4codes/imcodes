import { MEMORY_MCP_SEND_DELIVERY_MODES } from '../../../shared/memory-mcp-contracts.js';
import type { SharedActorEnvelope } from '../../../shared/tab-sharing.js';
import {
  buildAuthorizedSendOptions,
  captureInboundCommandAuthority,
  mergeMachineAuthority,
  parseMachineAuthority,
  resolveAggregateMachineAuthority,
  serializeMachineAuthority,
  type TurnMachineAuthorityContext,
} from '../machine-authority.js';

/**
 * Pure persistence/merge helpers for task-pair machine authority.
 * Kept free of runtime (`session-manager` / `tmux`) dependencies so `store.ts`
 * and `TransportSessionRuntime` never transitively trigger multiplexer detection.
 */
export type TaskPairAuthorityContext = TurnMachineAuthorityContext;

export interface TaskPairDispatchActorOption {
  sharedActor?: SharedActorEnvelope;
  sharedMachineAuthority?: string;
  ownerMachineAuthority?: string;
  deliveryMode?: typeof MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE;
}

export const parseTaskPairAuthority = parseMachineAuthority;
export const serializeTaskPairAuthority = serializeMachineAuthority;
export { captureInboundCommandAuthority };
export const mergePairAuthority = mergeMachineAuthority;
export const resolveAggregatePairAuthority = resolveAggregateMachineAuthority;

export function toSessionDispatchActorOption(
  authority: TaskPairAuthorityContext | undefined,
): TaskPairDispatchActorOption {
  const authorized = buildAuthorizedSendOptions(authority);
  return {
    ...(authorized.sharedActor ? { sharedActor: authorized.sharedActor } : {}),
    ...(authorized.sharedMachineAuthority ? { sharedMachineAuthority: authorized.sharedMachineAuthority } : {}),
    ...(authorized.ownerMachineAuthority ? { ownerMachineAuthority: authorized.ownerMachineAuthority } : {}),
    ...(authorized.deliveryMode === MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE
      ? { deliveryMode: MEMORY_MCP_SEND_DELIVERY_MODES.QUEUE }
      : {}),
  };
}
