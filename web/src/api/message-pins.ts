import {
  MESSAGE_PINS_API_PATH,
  type CreateMessagePinInput,
  type MessagePin,
} from '@shared/message-pins.js';
import { apiFetch } from '../api.js';

function scopedMessagePinsPath(serverId: string, sessionName?: string, pinId?: string): string {
  const query = new URLSearchParams({ serverId });
  if (sessionName) query.set('sessionName', sessionName);
  const suffix = pinId ? `/${encodeURIComponent(pinId)}` : '';
  return `${MESSAGE_PINS_API_PATH}${suffix}?${query.toString()}`;
}

export async function fetchMessagePins(serverId: string, sessionName?: string): Promise<MessagePin[]> {
  const response = await apiFetch<{ pins?: MessagePin[] }>(scopedMessagePinsPath(serverId, sessionName));
  return Array.isArray(response.pins) ? response.pins : [];
}

export async function saveMessagePin(
  serverId: string,
  sessionName: string,
  pin: CreateMessagePinInput,
): Promise<MessagePin> {
  const response = await apiFetch<{ pin: MessagePin }>(scopedMessagePinsPath(serverId, sessionName), {
    method: 'POST',
    body: JSON.stringify(pin),
  });
  return response.pin;
}

export async function removeMessagePin(serverId: string, pinId: string): Promise<void> {
  await apiFetch(scopedMessagePinsPath(serverId, undefined, pinId), { method: 'DELETE' });
}
