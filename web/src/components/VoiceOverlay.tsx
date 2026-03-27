import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import * as VoiceInput from './VoiceInput.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  initialText?: string;
}

const BAR_COUNT = 48;

export function VoiceOverlay({ open, onClose, onSend, initialText }: Props) {
  const { t } = useTranslation();
  const [listening, setListening] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(2));
  const [maxH, setMaxH] = useState('66vh');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const barsRef = useRef<number[]>(Array(BAR_COUNT).fill(2));
  // Voice zone: [insertPos, insertPos+voiceLen) is the active voice segment
  const insertPosRef = useRef(0);
  const voiceLenRef = useRef(0);
  // Guard: ignore partial callbacks while restarting session
  const restartingRef = useRef(false);
  // Track listening state in a ref so event handlers always see current value
  const listeningRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const init = initialText ?? '';
    if (taRef.current) { taRef.current.value = init; taRef.current.focus(); }
    setHasText(!!init.trim());
    setMaxH('66vh');
    setListening(false);
    listeningRef.current = false;
    insertPosRef.current = init.length;
    voiceLenRef.current = 0;
    restartingRef.current = false;
    setBars(Array(BAR_COUNT).fill(2));
    barsRef.current = Array(BAR_COUNT).fill(2);

    VoiceInput.onAudioLevel((level) => {
      const prev = barsRef.current;
      const isEmpty = prev.every((v) => v < 0.01);
      if (isEmpty && level > 0.01) {
        const filled = prev.map(() => level * (0.5 + Math.random() * 0.5));
        barsRef.current = filled;
        setBars(filled);
        return;
      }
      const next = [...prev.slice(1), level];
      barsRef.current = next;
      setBars(next);
    });

    const vv = window.visualViewport;
    const onResize = () => {
      if (!vv) return;
      const kbOpen = window.innerHeight - vv.height > 50;
      setMaxH(kbOpen ? `${vv.height}px` : '66vh');
    };
    vv?.addEventListener('resize', onResize);

    const timer = setTimeout(() => startSession(0), 150);
    return () => {
      clearTimeout(timer);
      vv?.removeEventListener('resize', onResize);
      VoiceInput.onAudioLevel(null);
      VoiceInput.stopListening();
      setListening(false);
      listeningRef.current = false;
    };
  }, [open]);

  /** Start a new recognition session, inserting at given position */
  const startSession = useCallback(async (atPos: number) => {
    const ta = taRef.current;
    if (!ta) return;
    insertPosRef.current = atPos;
    voiceLenRef.current = 0;

    try {
      const ok = await VoiceInput.startListening((partial) => {
        // Ignore callbacks arriving during a restart
        if (restartingRef.current) return;
        const ta = taRef.current;
        if (!ta) return;
        const pos = insertPosRef.current;
        const oldLen = voiceLenRef.current;
        const before = ta.value.slice(0, pos);
        const after = ta.value.slice(pos + oldLen);
        // Add a space separator if needed
        const needSpace = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') && oldLen === 0;
        const sep = needSpace ? ' ' : '';
        ta.value = before + sep + partial + after;
        const newVoiceLen = partial.length;
        const actualPos = pos + sep.length;
        if (sep.length > 0) insertPosRef.current = actualPos;
        voiceLenRef.current = newVoiceLen;
        // Move cursor to end of voice segment
        const cursorPos = actualPos + newVoiceLen;
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(cursorPos, cursorPos);
        });
        ta.scrollTop = ta.scrollHeight;
        setHasText(!!ta.value.trim());
      });
      if (ok) {
        setListening(true);
        listeningRef.current = true;
      }
    } catch { /* ignore */ }
  }, []);

  /** Stop current session, commit voice zone, restart at new cursor */
  const restartAtCursor = useCallback(async (newPos: number) => {
    restartingRef.current = true;
    await VoiceInput.stopListening();
    setListening(false);
    listeningRef.current = false;
    voiceLenRef.current = 0;
    restartingRef.current = false;
    // Start new session at the saved position
    await startSession(newPos);
  }, [startSession]);

  const handleToggle = useCallback(async () => {
    if (listeningRef.current) {
      await VoiceInput.stopListening();
      setListening(false);
      listeningRef.current = false;
      voiceLenRef.current = 0;
      setBars(Array(BAR_COUNT).fill(2));
      barsRef.current = Array(BAR_COUNT).fill(2);
    } else {
      const ta = taRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : 0;
      startSession(pos);
    }
  }, [startSession]);

  const handleSend = useCallback(() => {
    const text = (taRef.current?.value ?? '').trim();
    if (!text) return;
    VoiceInput.stopListening();
    setListening(false);
    listeningRef.current = false;
    onSend(text);
    onClose();
  }, [onSend, onClose]);

  const handleClose = useCallback(() => {
    VoiceInput.stopListening();
    setListening(false);
    listeningRef.current = false;
    onClose();
  }, [onClose]);

  /** Detect cursor move via multiple events (onSelect unreliable on iOS).
   *  If cursor moved outside the active voice zone while listening, restart session. */
  const handleCursorChange = useCallback(() => {
    if (restartingRef.current) return;
    const ta = taRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;

    // Use ref for listening state (closures capture stale state values)
    if (!listeningRef.current) return;
    const voiceStart = insertPosRef.current;
    const voiceEnd = voiceStart + voiceLenRef.current;
    // If cursor moved outside the active voice zone, restart session at new position
    if (cursor < voiceStart || cursor > voiceEnd) {
      restartAtCursor(cursor);
    }
  }, [restartAtCursor]);

  const handleInput = useCallback(() => {
    setHasText(!!(taRef.current?.value?.trim()));
  }, []);

  if (!open) return null;

  return (
    <div class="voice-overlay" style={{ height: maxH }}>
      <div class="voice-overlay-grid" />

      <div class="voice-overlay-header">
        <div class="voice-overlay-status">
          <div class={`voice-status-dot${listening ? ' voice-status-dot-active' : ''}`} />
          <span>{listening ? t('voice.listening') : t('voice.paused')}</span>
        </div>
        <button class="voice-overlay-close" onClick={handleClose}>✕</button>
      </div>

      <textarea
        ref={taRef}
        class="voice-overlay-text"
        placeholder={t('voice.speak_now')}
        spellcheck={false}
        onInput={handleInput}
        onSelect={handleCursorChange}
        onClick={handleCursorChange}
        onTouchEnd={handleCursorChange}
        onKeyUp={handleCursorChange}
      />

      <div class="voice-overlay-controls">
        <div class="voice-waveform-bg">
          {bars.map((level, i) => {
            const h = 2 + level * 44;
            return (
              <div
                key={i}
                class="voice-waveform-bar"
                style={{ height: `${h}px`, opacity: 0.15 + level * 0.35 }}
              />
            );
          })}
        </div>

        <button
          class={`voice-overlay-mic${listening ? ' voice-overlay-mic-active' : ''}`}
          onClick={handleToggle}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            {listening ? (
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
            ) : (
              <>
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </>
            )}
          </svg>
        </button>

        <button
          class="voice-overlay-send"
          onClick={handleSend}
          disabled={!hasText}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          <span>{t('voice.send')}</span>
        </button>
      </div>
    </div>
  );
}
