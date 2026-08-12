import { useCallback, useEffect, useState } from 'preact/hooks';
import type { CreateMessagePinInput, MessagePin } from '@shared/message-pins.js';
import { fetchMessagePins, removeMessagePin, saveMessagePin } from '../api/message-pins.js';

const MESSAGE_PINS_CHANGED_EVENT = 'imcodes:message-pins-changed';
const pinsCache = new Map<string, MessagePin[]>();
const pinsInflight = new Map<string, Promise<MessagePin[]>>();
let pinsCacheGeneration = 0;

export function clearMessagePinsCache(): void {
  pinsCacheGeneration += 1;
  pinsCache.clear();
  pinsInflight.clear();
}

export function __resetMessagePinsCacheForTests(): void {
  clearMessagePinsCache();
}

function broadcastPinsChanged(serverId: string, pins: MessagePin[]): void {
  pinsCache.set(serverId, pins);
  window.dispatchEvent(new CustomEvent(MESSAGE_PINS_CHANGED_EVENT, { detail: { serverId, pins } }));
}

function fetchSharedMessagePins(serverId: string): Promise<MessagePin[]> {
  const cached = pinsCache.get(serverId);
  if (cached) return Promise.resolve(cached);
  const existing = pinsInflight.get(serverId);
  if (existing) return existing;
  const generation = pinsCacheGeneration;
  const request = fetchMessagePins(serverId).then((pins) => {
    if (generation !== pinsCacheGeneration) return [];
    pinsCache.set(serverId, pins);
    return pins;
  }).finally(() => {
    if (pinsInflight.get(serverId) === request) pinsInflight.delete(serverId);
  });
  pinsInflight.set(serverId, request);
  return request;
}

export interface UseMessagePinsResult {
  pins: MessagePin[];
  loading: boolean;
  mutating: boolean;
  error: string | null;
  pinMessage: (pin: CreateMessagePinInput) => Promise<MessagePin | null>;
  unpinMessage: (pin: MessagePin) => Promise<boolean>;
  clearError: () => void;
}

export function useMessagePins(
  serverId: string | null | undefined,
  sessionName: string | null | undefined,
  enabled = true,
): UseMessagePinsResult {
  const [pins, setPins] = useState<MessagePin[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !serverId) {
      setPins((current) => current.length === 0 ? current : []);
      setLoading(false);
      return undefined;
    }
    let active = true;
    const cached = pinsCache.get(serverId);
    if (cached) setPins(cached);
    setLoading(!cached);
    void fetchSharedMessagePins(serverId).then((next) => {
      if (!active) return;
      setPins(next);
      setError(null);
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (active) setLoading(false);
    });
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ serverId?: string; pins?: MessagePin[] }>).detail;
      if (detail?.serverId === serverId && Array.isArray(detail.pins)) {
        setPins(detail.pins);
        setError(null);
      }
    };
    window.addEventListener(MESSAGE_PINS_CHANGED_EVENT, handler);
    return () => {
      active = false;
      window.removeEventListener(MESSAGE_PINS_CHANGED_EVENT, handler);
    };
  }, [enabled, serverId]);

  const pinMessage = useCallback(async (pin: CreateMessagePinInput): Promise<MessagePin | null> => {
    if (!serverId || !sessionName || mutating) return null;
    const generation = pinsCacheGeneration;
    setMutating(true);
    setError(null);
    try {
      const saved = await saveMessagePin(serverId, sessionName, pin);
      if (generation !== pinsCacheGeneration) return null;
      const previous = pinsCache.get(serverId) ?? pins;
      const next = [saved, ...previous.filter((candidate) => candidate.id !== saved.id)];
      setPins(next);
      broadcastPinsChanged(serverId, next);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setMutating(false);
    }
  }, [mutating, pins, serverId, sessionName]);

  const unpinMessage = useCallback(async (pin: MessagePin): Promise<boolean> => {
    if (!serverId || mutating) return false;
    const generation = pinsCacheGeneration;
    setMutating(true);
    setError(null);
    try {
      await removeMessagePin(serverId, pin.id);
      if (generation !== pinsCacheGeneration) return false;
      const previous = pinsCache.get(serverId) ?? pins;
      const next = previous.filter((candidate) => candidate.id !== pin.id);
      setPins(next);
      broadcastPinsChanged(serverId, next);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setMutating(false);
    }
  }, [mutating, pins, serverId]);

  return {
    pins,
    loading,
    mutating,
    error,
    pinMessage,
    unpinMessage,
    clearError: useCallback(() => setError(null), []),
  };
}
