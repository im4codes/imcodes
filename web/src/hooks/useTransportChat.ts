/**
 * useTransportChat — subscribes to transport events via WsClient and manages
 * real-time chat message state for transport-backed sessions (e.g. OpenClaw).
 *
 * Events flow: Daemon → Server WsBridge → Browser via the structured JSON
 * channel defined in shared/transport-events.ts.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { TRANSPORT_EVENT, TRANSPORT_MSG } from '@shared/transport-events.js';
import type { WsClient } from '../ws-client.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete' | 'error';
  timestamp: number;
}

export interface UseTransportChatResult {
  messages: ChatMessage[];
  isStreaming: boolean;
  sendMessage: (text: string) => void;
}

export function useTransportChat(
  sessionName: string,
  ws: WsClient | null,
): UseTransportChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    if (!ws || !ws.connected) return;

    // Subscribe to transport events for this session
    try {
      ws.send({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId: sessionName });
    } catch {
      // Not connected yet — ws.connected check above guards most cases,
      // but race conditions on first render are handled gracefully.
      return;
    }

    const unsubscribe = ws.onMessage((msg) => {
      // Narrow to transport event shapes — msg.type is the discriminant.
      const raw = msg as Record<string, unknown>;
      const type = raw['type'];

      if (type === TRANSPORT_EVENT.CHAT_DELTA) {
        const sessionId = raw['sessionId'] as string | undefined;
        if (sessionId !== sessionName) return;
        const messageId = raw['messageId'] as string;
        const delta = (raw['delta'] as string) ?? '';

        setIsStreaming(true);
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === messageId);
          if (existing) {
            return prev.map((m) =>
              m.id === messageId
                ? { ...m, content: m.content + delta, status: 'streaming' as const }
                : m,
            );
          }
          return [
            ...prev,
            {
              id: messageId,
              role: 'assistant',
              content: delta,
              status: 'streaming' as const,
              timestamp: Date.now(),
            },
          ];
        });
      } else if (type === TRANSPORT_EVENT.CHAT_COMPLETE) {
        const sessionId = raw['sessionId'] as string | undefined;
        if (sessionId !== sessionName) return;
        const messageId = raw['messageId'] as string;

        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, status: 'complete' as const } : m,
          ),
        );
      } else if (type === TRANSPORT_EVENT.CHAT_ERROR) {
        const sessionId = raw['sessionId'] as string | undefined;
        if (sessionId !== sessionName) return;
        const error = (raw['error'] as string | undefined) ?? 'Unknown error';

        setIsStreaming(false);
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: 'assistant',
            content: error,
            status: 'error' as const,
            timestamp: Date.now(),
          },
        ]);
      }
    });

    return () => {
      unsubscribe();
      try {
        ws.send({ type: TRANSPORT_MSG.CHAT_UNSUBSCRIBE, sessionId: sessionName });
      } catch {
        // Ignore — connection may already be closed during cleanup.
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionName, ws, ws ? ws.connected : false]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!ws) return;
      // Add user message to local state immediately (optimistic)
      setMessages((prev) => [
        ...prev,
        {
          id: `user-${Date.now()}`,
          role: 'user',
          content: text,
          status: 'complete',
          timestamp: Date.now(),
        },
      ]);
      // Send to daemon via existing session.send mechanism
      try {
        ws.send({ type: 'session.send', session: sessionName, message: text });
      } catch {
        // Ignore send errors — the optimistic message remains visible.
      }
    },
    [sessionName, ws],
  );

  return { messages, isStreaming, sendMessage };
}
