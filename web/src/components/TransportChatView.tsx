/**
 * TransportChatView — chat message UI for transport-backed sessions (e.g. OpenClaw).
 *
 * Replaces TerminalView for sessions whose runtimeType === 'transport'.
 * Renders a scrollable message list with markdown support for assistant messages
 * and a text input at the bottom.
 */
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { useTransportChat } from '../hooks/useTransportChat.js';
import { ChatMarkdown } from './ChatMarkdown.js';
import type { WsClient } from '../ws-client.js';

interface Props {
  sessionName: string;
  ws: WsClient | null;
}

export function TransportChatView({ sessionName, ws }: Props) {
  const { t } = useTranslation();
  const { messages, isStreaming, sendMessage } = useTransportChat(sessionName, ws);

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputText, setInputText] = useState('');
  // Track whether the user has scrolled up so we don't forcibly jump to bottom
  const atBottomRef = useRef(true);

  // Auto-scroll to bottom when new messages arrive (only when user is at bottom)
  useEffect(() => {
    if (!atBottomRef.current) return;
    const el = listRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isStreaming]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distFromBottom < 60;
  }, []);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || !ws) return;
    sendMessage(text);
    setInputText('');
    atBottomRef.current = true;
    // Scroll to bottom after sending
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
  }, [inputText, ws, sendMessage]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <div class="transport-chat-wrap">
      {/* Message list */}
      <div
        class="chat-view transport-chat-messages"
        ref={listRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 && !isStreaming && (
          <div class="chat-loading" style={{ color: '#475569', fontSize: 13 }}>
            {t('transport_chat.empty')}
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'user') {
            return (
              <div key={msg.id} class="chat-event" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div class="chat-user">
                  <span class="chat-bubble-content">{msg.content}</span>
                </div>
              </div>
            );
          }

          // Assistant message
          const isError = msg.status === 'error';
          return (
            <div key={msg.id} class="chat-event">
              <div
                class="chat-assistant"
                style={isError ? { color: '#f87171', borderLeft: '3px solid #f87171', paddingLeft: 8 } : undefined}
              >
                {isError ? (
                  <span>
                    <span style={{ marginRight: 6, fontWeight: 700 }}>{t('transport_chat.error')}</span>
                    {msg.content}
                  </span>
                ) : (
                  <ChatMarkdown text={msg.content} />
                )}
                {msg.status === 'streaming' && (
                  <span class="chat-thinking-dots" style={{ marginLeft: 4, color: '#818cf8' }}>
                    {'...'}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator when no messageId yet (agent started thinking) */}
        {isStreaming && messages.length > 0 && messages[messages.length - 1].status !== 'streaming' && (
          <div class="chat-event">
            <div class="chat-assistant chat-thinking-label">
              <span class="chat-thinking-dots">{'...'}</span>
              <span style={{ marginLeft: 6, color: '#64748b', fontSize: 12 }}>
                {t('transport_chat.streaming')}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div class="transport-chat-input-row">
        {isStreaming && (
          <div class="chat-thinking-bar" style={{ padding: '4px 12px', fontSize: 12 }}>
            <span class="chat-thinking-dots">{'...'}</span>
            {' '}
            <span style={{ color: '#64748b' }}>{t('transport_chat.streaming')}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: '#1e293b', borderTop: '1px solid #334155' }}>
          <textarea
            ref={inputRef}
            class="transport-chat-textarea"
            placeholder={t('transport_chat.inputPlaceholder')}
            value={inputText}
            onInput={(e) => setInputText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={handleKeyDown}
            rows={1}
            style={{
              flex: 1,
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 6,
              color: '#e2e8f0',
              fontFamily: 'inherit',
              fontSize: 14,
              padding: '7px 10px',
              resize: 'none',
              outline: 'none',
              lineHeight: '1.4',
              maxHeight: 120,
              overflowY: 'auto',
            }}
          />
          <button
            class="btn btn-primary"
            onClick={handleSend}
            disabled={!inputText.trim() || !ws || !ws.connected}
            style={{ flexShrink: 0, padding: '0 16px', fontSize: 13 }}
          >
            {t('transport_chat.send')}
          </button>
        </div>
      </div>
    </div>
  );
}
