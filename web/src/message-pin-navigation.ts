import type { MessagePin } from '@shared/message-pins.js';

const MESSAGE_PIN_NAVIGATION_EVENT = 'imcodes:message-pin-navigation';

export interface MessagePinNavigationRequest {
  pin: MessagePin;
  sourceSessionName: string | null;
}

let pendingNavigation: MessagePinNavigationRequest | null = null;

export function clearMessagePinNavigation(): void {
  pendingNavigation = null;
}

export function __resetMessagePinNavigationForTests(): void {
  clearMessagePinNavigation();
}

export function requestMessagePinNavigation(pin: MessagePin, sourceSessionName?: string | null): void {
  pendingNavigation = { pin, sourceSessionName: sourceSessionName ?? null };
  window.dispatchEvent(new CustomEvent<MessagePinNavigationRequest>(MESSAGE_PIN_NAVIGATION_EVENT, {
    detail: pendingNavigation,
  }));
}

export function getPendingMessagePin(sessionName: string): MessagePin | null {
  return pendingNavigation?.pin.sessionName === sessionName ? pendingNavigation.pin : null;
}

export function peekPendingMessagePin(): MessagePin | null {
  return pendingNavigation?.pin ?? null;
}

export function peekPendingMessagePinNavigation(): MessagePinNavigationRequest | null {
  return pendingNavigation;
}

export function clearPendingMessagePin(pinId: string): void {
  if (pendingNavigation?.pin.id === pinId) pendingNavigation = null;
}

export function subscribeMessagePinNavigation(
  listener: (pin: MessagePin, sourceSessionName: string | null) => void,
): () => void {
  const handler = (event: Event) => {
    const request = (event as CustomEvent<MessagePinNavigationRequest>).detail;
    if (request?.pin) listener(request.pin, request.sourceSessionName);
  };
  window.addEventListener(MESSAGE_PIN_NAVIGATION_EVENT, handler);
  return () => window.removeEventListener(MESSAGE_PIN_NAVIGATION_EVENT, handler);
}
