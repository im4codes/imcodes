import { useState, useRef } from 'preact/hooks';

interface MobileControlsProps {
  sessions: string[];
  activeSession: string;
  onSessionChange: (session: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

/**
 * Mobile-optimized terminal controls:
 * - Touch-friendly large send button
 * - Swipe gesture for session switching (left/right swipe)
 * - Session indicator dots
 */
export function MobileControls({ sessions, activeSession, onSessionChange, onSend, onStop }: MobileControlsProps) {
  const [input, setInput] = useState('');
  const touchStartX = useRef<number | null>(null);
  const currentIndex = sessions.indexOf(activeSession);

  function handleTouchStart(e: TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e: TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const THRESHOLD = 60;

    if (Math.abs(dx) > THRESHOLD) {
      if (dx < 0 && currentIndex < sessions.length - 1) {
        onSessionChange(sessions[currentIndex + 1]);
      } else if (dx > 0 && currentIndex > 0) {
        onSessionChange(sessions[currentIndex - 1]);
      }
    }
    touchStartX.current = null;
  }

  function handleSend() {
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div
      class="mobile-controls"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Session swipe indicator */}
      <div class="session-dots">
        {sessions.map((s, i) => (
          <button
            key={s}
            class={`session-dot${i === currentIndex ? ' session-dot--active' : ''}`}
            onClick={() => onSessionChange(s)}
            title={s}
          />
        ))}
      </div>

      {/* Input row */}
      <div class="mobile-input-row">
        <textarea
          class="mobile-input"
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder="Send message…"
          rows={1}
        />
        <button class="btn-mobile-stop" onClick={onStop} title="Stop">■</button>
        <button
          class="btn-mobile-send"
          onClick={handleSend}
          disabled={!input.trim()}
          title="Send"
        >
          ▶
        </button>
      </div>
    </div>
  );
}
