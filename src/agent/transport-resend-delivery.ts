import {
  MEMORY_MCP_SEND_DELIVERY_MODES,
} from '../../shared/memory-mcp-contracts.js';
import type { ResendEntry, ResendHandoffOwnership } from '../daemon/transport-resend-queue.js';
import type {
  ExternalAppendResult,
  TransportSendMetadata,
  TransportSessionRuntime,
} from './transport-session-runtime.js';

export type TransportResendDeliveryResult = 'sent' | 'appended' | 'queued' | 'retry';

type ResendDeliveryRuntime = Pick<
  TransportSessionRuntime,
  'appendExternalMessageToActiveTurn' | 'send'
>;

function buildResendMetadata(
  entry: ResendEntry,
  ownership?: ResendHandoffOwnership,
): TransportSendMetadata {
  return {
    ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
    ...(entry.sharedMachineAuthority ? { sharedMachineAuthority: entry.sharedMachineAuthority } : {}),
    ...(entry.providerText != null ? { providerText: entry.providerText } : {}),
    ...(entry.aliasAudit ? { aliasAudit: entry.aliasAudit } : {}),
    ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
    ...(entry.historyCommitted ? { historyCommitted: true } : {}),
    ...(entry.activeTurnDeliveryKind
      ? { activeTurnDeliveryKind: entry.activeTurnDeliveryKind }
      : {}),
    ...(entry.peerAudit ? { peerAudit: entry.peerAudit } : {}),
    ...(entry.delegationReply ? { delegationReply: entry.delegationReply } : {}),
    ...(entry.supervisionReference
      ? { supervisionReference: entry.supervisionReference }
      : {}),
    ...(entry.registeredSystemContract
      ? { registeredSystemContract: entry.registeredSystemContract }
      : {}),
    ...(ownership ? { queueHandoff: ownership } : {}),
  };
}

function buildAppendPrivateMetadata(
  entry: ResendEntry,
): Pick<TransportSendMetadata, 'activeTurnDeliveryKind' | 'peerAudit' | 'delegationReply'> | undefined {
  const metadata = {
    ...(entry.activeTurnDeliveryKind
      ? { activeTurnDeliveryKind: entry.activeTurnDeliveryKind }
      : {}),
    ...(entry.peerAudit ? { peerAudit: entry.peerAudit } : {}),
    ...(entry.delegationReply ? { delegationReply: entry.delegationReply } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function canUseNativeAppend(entry: ResendEntry): boolean {
  return entry.deliveryMode === MEMORY_MCP_SEND_DELIVERY_MODES.APPEND
    && !entry.messagePreamble
    && !entry.registeredSystemContract
    && !entry.sharedMachineAuthority
    && !entry.historyCommitted
    && (entry.attachments?.length ?? 0) === 0;
}

/**
 * Restore one durable resend entry without losing its original delivery policy.
 *
 * `append` entries first use the provider's live-query input channel. A stale
 * binding or a provider without native append support falls back to the normal
 * runtime FIFO so the durable at-least-once guarantee is unchanged.
 */
export async function deliverTransportResendEntry(
  runtime: ResendDeliveryRuntime,
  entry: ResendEntry,
  ownership?: ResendHandoffOwnership,
): Promise<TransportResendDeliveryResult> {
  if (canUseNativeAppend(entry)) {
    let appendResult: ExternalAppendResult;
    const privateMetadata = buildAppendPrivateMetadata(entry);
    if (ownership) {
      appendResult = privateMetadata
        ? await runtime.appendExternalMessageToActiveTurn(
            entry.providerText ?? entry.text,
            entry.clientMessageId ?? entry.commandId,
            entry.supervisionReference,
            ownership,
            privateMetadata,
          )
        : await runtime.appendExternalMessageToActiveTurn(
            entry.providerText ?? entry.text,
            entry.clientMessageId ?? entry.commandId,
            entry.supervisionReference,
            ownership,
          );
    } else if (entry.supervisionReference) {
      appendResult = privateMetadata
        ? await runtime.appendExternalMessageToActiveTurn(
            entry.providerText ?? entry.text,
            entry.clientMessageId ?? entry.commandId,
            entry.supervisionReference,
            undefined,
            privateMetadata,
          )
        : await runtime.appendExternalMessageToActiveTurn(
            entry.providerText ?? entry.text,
            entry.clientMessageId ?? entry.commandId,
            entry.supervisionReference,
          );
    } else if (privateMetadata) {
      appendResult = await runtime.appendExternalMessageToActiveTurn(
        entry.providerText ?? entry.text,
        entry.clientMessageId ?? entry.commandId,
        undefined,
        undefined,
        privateMetadata,
      );
    } else {
      appendResult = await runtime.appendExternalMessageToActiveTurn(
        entry.providerText ?? entry.text,
        entry.clientMessageId ?? entry.commandId,
      );
    }
    if (appendResult === 'sent' || appendResult === 'appended' || appendResult === 'retry') return appendResult;
  }

  const attachments = entry.attachments ?? [];
  return runtime.send(
    entry.text,
    entry.clientMessageId ?? entry.commandId,
    attachments.length > 0 ? attachments : undefined,
    entry.messagePreamble,
    buildResendMetadata(entry, ownership),
  );
}
