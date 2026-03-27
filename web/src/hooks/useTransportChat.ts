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

let _idCounter = 0;
function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete' | 'error';
  timestamp: number;
}

export type TransportStatus = 'idle' | 'streaming' | 'thinking' | 'tool_running' | 'permission' | 'error' | 'unknown';

export interface UseTransportChatResult {
  messages: ChatMessage[];
  isStreaming: boolean;
  agentStatus: TransportStatus;
  sendMessage: (text: string) => void;
}

export function useTransportChat(
  sessionName: string,
  ws: WsClient | null,
): UseTransportChatResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState<TransportStatus>('idle');

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
      const raw = msg as Record<string, unknown>;
      const type = raw['type'];

      // History replay — batch of cached events sent on subscribe
      if (type === 'chat.history') {
        const sid = raw['sessionId'] as string | undefined;
        if (sid !== sessionName) return;
        const events = raw['events'] as Array<Record<string, unknown>> | undefined;
        if (!events || events.length === 0) return;
        // Rebuild messages from cached delta/complete/error events
        const rebuilt = new Map<string, ChatMessage>();
        for (const evt of events) {
          const evtType = evt['type'] as string;
          const ts = (evt['_ts'] as number) ?? Date.now();
          if (evtType === TRANSPORT_EVENT.CHAT_DELTA) {
            const mid = evt['messageId'] as string;
            const delta = (evt['delta'] as string) ?? '';
            const existing = rebuilt.get(mid);
            if (existing) {
              existing.content += delta;
            } else {
              rebuilt.set(mid, { id: mid, role: 'assistant', content: delta, status: 'streaming', timestamp: ts });
            }
          } else if (evtType === TRANSPORT_EVENT.CHAT_COMPLETE) {
            const mid = evt['messageId'] as string;
            const existing = rebuilt.get(mid);
            if (existing) existing.status = 'complete';
          } else if (evtType === TRANSPORT_EVENT.CHAT_ERROR) {
            const error = (evt['error'] as string) ?? 'Error';
            rebuilt.set(uniqueId('error'), { id: uniqueId('error'), role: 'assistant', content: error, status: 'error', timestamp: ts });
          }
        }
        // Merge into state without duplicating
        setMessages((prev) => {
          const existingIds = new Set(prev.map(m => m.id));
          const newMsgs = [...rebuilt.values()].filter(m => !existingIds.has(m.id));
          return newMsgs.length > 0 ? [...newMsgs, ...prev] : prev;
        });
        return;
      }

      if (type === TRANSPORT_EVENT.CHAT_DELTA) {
        const sessionId = raw['sessionId'] as string | undefined;
        if (sessionId !== sessionName) return;
        const messageId = raw['messageId'] as string;
        const delta = (raw['delta'] as string) ?? '';

        setIsStreaming(true);
        setAgentStatus('streaming');
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
        setAgentStatus('idle');
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
        setAgentStatus('error');
        setMessages((prev) => [
          ...prev,
          {
            id: uniqueId('error'),
            role: 'assistant',
            content: error,
            status: 'error' as const,
            timestamp: Date.now(),
          },
        ]);
      } else if (type === TRANSPORT_EVENT.CHAT_STATUS) {
        const sessionId = raw['sessionId'] as string | undefined;
        if (sessionId !== sessionName) return;
        const status = raw['status'] as TransportStatus | undefined;
        if (status) setAgentStatus(status);
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
      if (!ws || isStreaming) return;
      // Add user message to local state immediately (optimistic)
      setMessages((prev) => [
        ...prev,
        {
          id: uniqueId('user'),
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
    [sessionName, ws, isStreaming],
  );

  return { messages, isStreaming, agentStatus, sendMessage };
}
