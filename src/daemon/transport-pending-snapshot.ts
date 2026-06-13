import type { PendingTransportMessage } from '../agent/transport-session-runtime.js';
import type { SharedActorEnvelope } from '../../shared/tab-sharing.js';
import { getResendEntries } from './transport-resend-queue.js';

export interface TransportPendingMessageEntry {
  clientMessageId: string;
  text: string;
  sharedActor?: SharedActorEnvelope;
}

export interface TransportPendingQueueSnapshot {
  pendingMessages: string[];
  pendingEntries: TransportPendingMessageEntry[];
  pendingVersion?: number;
  source: 'runtime' | 'resend' | 'empty';
}

export interface TransportPendingRuntimeSnapshot {
  pendingMessages?: string[];
  pendingEntries?: PendingTransportMessage[];
  pendingVersion?: number;
}

function normalizeRuntimeEntries(entries: PendingTransportMessage[] | undefined): TransportPendingMessageEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => typeof entry.clientMessageId === 'string' && typeof entry.text === 'string' && entry.text.length > 0)
    .map((entry) => ({
      clientMessageId: entry.clientMessageId,
      text: entry.text,
      ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
    }));
}

function synthesizeEntriesFromMessages(sessionName: string, messages: string[]): TransportPendingMessageEntry[] {
  return messages.map((text, index) => ({
    clientMessageId: `${sessionName}:legacy:${index}:${text}`,
    text,
  }));
}

export function buildTransportPendingQueueSnapshot(
  sessionName: string,
  runtime: TransportPendingRuntimeSnapshot | null | undefined,
): TransportPendingQueueSnapshot {
  const runtimeMessages = Array.isArray(runtime?.pendingMessages)
    ? runtime.pendingMessages.filter((message): message is string => typeof message === 'string' && message.length > 0)
    : [];
  const runtimeEntries = normalizeRuntimeEntries(runtime?.pendingEntries);
  if (runtimeMessages.length > 0 || runtimeEntries.length > 0) {
    const pendingMessages = runtimeMessages.length > 0
      ? runtimeMessages
      : runtimeEntries.map((entry) => entry.text);
    const pendingEntries = runtimeEntries.length > 0
      ? runtimeEntries
      : synthesizeEntriesFromMessages(sessionName, pendingMessages);
    return {
      pendingMessages,
      pendingEntries,
      ...(typeof runtime?.pendingVersion === 'number' ? { pendingVersion: runtime.pendingVersion } : {}),
      source: 'runtime',
    };
  }

  const resendEntries = getResendEntries(sessionName);
  if (resendEntries.length > 0) {
    return {
      pendingMessages: resendEntries.map((entry) => entry.text),
      pendingEntries: resendEntries.map((entry) => ({
        clientMessageId: entry.commandId,
        text: entry.text,
        ...(entry.sharedActor ? { sharedActor: entry.sharedActor } : {}),
      })),
      source: 'resend',
    };
  }

  return {
    pendingMessages: [],
    pendingEntries: [],
    ...(typeof runtime?.pendingVersion === 'number' ? { pendingVersion: runtime.pendingVersion } : {}),
    source: 'empty',
  };
}
