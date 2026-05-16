import { createSendDispatchId, createSendMessageId } from '../../shared/send-message-id.js';

/** Print the result of a /send call to stdout. */
export function printSendResult(res: Record<string, unknown>): void {
  if (res.ok) {
    if (Array.isArray(res.delivered)) {
      if (res.delivered.length > 0) console.log(`Sent to ${res.delivered.length} sessions: ${(res.delivered as string[]).join(', ')}`);
      if (Array.isArray(res.queued) && res.queued.length > 0) console.log(`Queued for ${res.queued.length}: ${(res.queued as string[]).join(', ')}`);
      if (Array.isArray(res.errors) && res.errors.length > 0) console.warn(`Errors: ${(res.errors as string[]).join('; ')}`);
    } else if (res.queued) {
      console.log(`Message queued for ${res.target ?? 'target'} (agent busy).`);
    } else {
      console.log(`Sent to ${res.target ?? 'target'}.`);
    }
    if (typeof res.dispatchId === 'string') console.log(`dispatchId: ${res.dispatchId}`);
    if (typeof res.messageId === 'string') console.log(`messageId: ${res.messageId}`);
    if (Array.isArray(res.messages)) {
      for (const item of res.messages as Array<{ target?: unknown; messageId?: unknown }>) {
        if (typeof item.target === 'string' && typeof item.messageId === 'string') {
          console.log(`${item.target} messageId: ${item.messageId}`);
        }
      }
    }
  } else {
    console.error(`Error: ${res.error ?? 'unknown error'}`);
    if (Array.isArray(res.available) && res.available.length > 0) {
      console.error('Available targets:');
      for (const t of res.available) {
        console.error(`  ${t}`);
      }
    }
    process.exit(1);
  }
}

export function printDirectSendResult(
  target: string,
  dispatchId = createSendDispatchId(),
  messageId = createSendMessageId(),
): void {
  console.log(`Sent to ${target}.`);
  console.log(`dispatchId: ${dispatchId}`);
  console.log(`messageId: ${messageId}`);
}
