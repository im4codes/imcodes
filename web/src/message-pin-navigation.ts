import type { MessagePin } from '@shared/message-pins.js';

const MESSAGE_PIN_NAVIGATION_EVENT = 'imcodes:message-pin-navigation';
let pendingMessagePin: MessagePin | null = null;

export function clearMessagePinNavigation(): void {
  pendingMessagePin = null;
}

export function __resetMessagePinNavigationForTests(): void {
  clearMessagePinNavigation();
}

export function requestMessagePinNavigation(pin: MessagePin): void {
  pendingMessagePin = pin;
  window.dispatchEvent(new CustomEvent<MessagePin>(MESSAGE_PIN_NAVIGATION_EVENT, { detail: pin }));
}

export function getPendingMessagePin(sessionName: string): MessagePin | null {
  return pendingMessagePin?.sessionName === sessionName ? pendingMessagePin : null;
}

export function peekPendingMessagePin(): MessagePin | null {
  return pendingMessagePin;
}

export function clearPendingMessagePin(pinId: string): void {
  if (pendingMessagePin?.id === pinId) pendingMessagePin = null;
}

export function subscribeMessagePinNavigation(listener: (pin: MessagePin) => void): () => void {
  const handler = (event: Event) => {
    const pin = (event as CustomEvent<MessagePin>).detail;
    if (pin) listener(pin);
  };
  window.addEventListener(MESSAGE_PIN_NAVIGATION_EVENT, handler);
  return () => window.removeEventListener(MESSAGE_PIN_NAVIGATION_EVENT, handler);
}
