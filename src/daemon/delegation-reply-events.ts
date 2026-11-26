import type { DelegationReplyRecord } from './delegation-reply-store.js';

type DelegationReplyDeliveredListener = (record: DelegationReplyRecord) => void;

const deliveredListeners = new Set<DelegationReplyDeliveredListener>();

export function onDelegationReplyDelivered(
  listener: DelegationReplyDeliveredListener,
): () => void {
  deliveredListeners.add(listener);
  return () => deliveredListeners.delete(listener);
}

export function emitDelegationReplyDelivered(record: DelegationReplyRecord): void {
  for (const listener of deliveredListeners) listener(record);
}
