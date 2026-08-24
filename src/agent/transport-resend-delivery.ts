import {
  MEMORY_MCP_SEND_DELIVERY_MODES,
} from '../../shared/memory-mcp-contracts.js';
import type { ResendEntry } from '../daemon/transport-resend-queue.js';
import type {
  ExternalAppendResult,
  TransportSendMetadata,
  TransportSessionRuntime,
} from './transport-session-runtime.js';

export type TransportResendDeliveryResult = 'sent' | 'appended' | 'queued';

type ResendDeliveryRuntime = Pick<
  TransportSessionRuntime,
  'appendExternalMessageToActiveTurn' | 'send'
>;

function buildResendMetadata(entry: ResendEntry): TransportSendMetadata {
  return {
    ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
    ...(entry.providerText != null ? { providerText: entry.providerText } : {}),
    ...(entry.aliasAudit ? { aliasAudit: entry.aliasAudit } : {}),
    ...(entry.timelineCommitted ? { timelineCommitted: true } : {}),
    ...(entry.historyCommitted ? { historyCommitted: true } : {}),
  };
}

function canUseNativeAppend(entry: ResendEntry): boolean {
  return entry.deliveryMode === MEMORY_MCP_SEND_DELIVERY_MODES.APPEND
    && !entry.messagePreamble
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
): Promise<TransportResendDeliveryResult> {
  if (canUseNativeAppend(entry)) {
    const appendResult: ExternalAppendResult = await runtime.appendExternalMessageToActiveTurn(
      entry.providerText ?? entry.text,
      entry.clientMessageId ?? entry.commandId,
    );
    if (appendResult === 'sent' || appendResult === 'appended') return appendResult;
  }

  const attachments = entry.attachments ?? [];
  return runtime.send(
    entry.text,
    entry.commandId,
    attachments.length > 0 ? attachments : undefined,
    entry.messagePreamble,
    buildResendMetadata(entry),
  );
}
