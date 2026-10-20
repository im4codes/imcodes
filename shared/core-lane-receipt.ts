import { MSG_COMMAND_ACK } from './ack-protocol.js';

export type CoreLaneSessionSendReceipt = {
  commandId: string;
  session: string;
};

export function coreLaneSessionSendReceipt(message: unknown): CoreLaneSessionSendReceipt | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.type !== 'session.send'
    || typeof value.commandId !== 'string'
    || value.commandId.trim().length === 0
    || typeof value.text !== 'string') return null;
  const session = typeof value.sessionName === 'string' ? value.sessionName : value.session;
  return typeof session === 'string' && session.length > 0
    ? { commandId: value.commandId, session }
    : null;
}

export function coreLaneReceiptFrame(receipt: CoreLaneSessionSendReceipt, status: 'accepted' | 'error', error?: string): string {
  return JSON.stringify({
    type: MSG_COMMAND_ACK,
    commandId: receipt.commandId,
    status,
    session: receipt.session,
    ...(error ? { error } : {}),
  });
}

export function coreLaneSessionAuthorized(session: string, allowed: ReadonlySet<string>, ready: boolean): boolean {
  return !ready || allowed.has(session);
}
