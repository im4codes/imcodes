import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import * as VoiceInput from './VoiceInput.js';
import { holdScreenAwake } from '../screen-awake.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => 'accepted' | 'pending' | 'rejected';
  initialText?: string;
}

const BAR_COUNT = 48;
/** Delay before re-arming the recognizer after it ends a segment by itself. */
export const NOTEPAD_RESTART_DELAY_MS = 250;
/** A notepad segment shorter than this counts as a failed restart. */
export const NOTEPAD_SHORT_SEGMENT_MS = 1500;
/** Consecutive short segments after which notepad auto-restart gives up. */
export const NOTEPAD_MAX_SHORT_SEGMENTS = 5;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

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
  // Session token: monotonic counter — partials with stale token are discarded
  const sessionTokenRef = useRef(0);
  // Track listening state in a ref so event handlers always see current value
  const listeningRef = useRef(false);
  // Guard: true while a programmatic write (partial callback) is in progress
  const programmaticWriteRef = useRef(false);
  // Guard: true while overlay is open
  const openRef = useRef(false);
  const autoStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Notepad mode: keep listening across recognizer segments until the user stops.
  const [notepad, setNotepad] = useState(false);
  const notepadRef = useRef(false);
  const [notepadStartedAt, setNotepadStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const segmentStartedAtRef = useRef(0);
  const shortSegmentsRef = useRef(0);
  // Set when auto-restart gave up; only a user action re-arms it.
  const restartPausedRef = useRef(false);

  const setListeningState = useCallback((next: boolean) => {
    // stopListening() reports `false` synchronously while the effect is being
    // cleaned up. Never enqueue hook state once the overlay is closed or
    // unmounting; the next open initializes both values below.
    if (!openRef.current) {
      listeningRef.current = false;
      return;
    }
    listeningRef.current = next;
    setListening(next);
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (!restartTimerRef.current) return;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
  }, []);

  const clearAutoStartTimer = useCallback(() => {
    if (!autoStartTimerRef.current) return;
    clearTimeout(autoStartTimerRef.current);
    autoStartTimerRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) { openRef.current = false; return; }
    openRef.current = true;
    const init = initialText ?? '';
    if (taRef.current) { taRef.current.value = init; taRef.current.focus(); }
    setHasText(!!init.trim());
    setMaxH('66vh');
    setListening(false);
    listeningRef.current = false;
    notepadRef.current = false;
    setNotepad(false);
    setNotepadStartedAt(null);
    shortSegmentsRef.current = 0;
    restartPausedRef.current = false;
    insertPosRef.current = init.length;
    voiceLenRef.current = 0;
    sessionTokenRef.current++;
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

    // Start voice session at end of initial text (not 0)
    clearAutoStartTimer();
    autoStartTimerRef.current = setTimeout(() => {
      autoStartTimerRef.current = null;
      void startSession(init.length);
    }, 150);
    return () => {
      clearAutoStartTimer();
      clearRestartTimer();
      notepadRef.current = false;
      openRef.current = false;
      vv?.removeEventListener('resize', onResize);
      VoiceInput.onAudioLevel(null);
      VoiceInput.stopListening();
      // Effect cleanup also runs during unmount. Updating hook state here queues
      // a Preact render after the component has already left the tree, leaving
      // its after-paint RAF alive past test/page teardown. Keep the synchronous
      // ref truthful; the next open initializes both ref and rendered state.
      listeningRef.current = false;
    };
  }, [open, clearAutoStartTimer, clearRestartTimer, setListeningState]);

  /** Start a new recognition session, inserting at given position */
  const startSession = useCallback(async (atPos: number) => {
    if (!openRef.current) return;
    const ta = taRef.current;
    if (!ta) return;
    const token = ++sessionTokenRef.current;
    insertPosRef.current = atPos;
    voiceLenRef.current = 0;
    segmentStartedAtRef.current = Date.now();

    try {
      const ok = await VoiceInput.startListening((partial) => {
        // Discard if session token changed (stale callback from old session)
        if (sessionTokenRef.current !== token) return;
        if (!openRef.current) return;
        const ta = taRef.current;
        if (!ta) return;
        const pos = insertPosRef.current;
        const oldLen = voiceLenRef.current;
        const before = ta.value.slice(0, pos);
        const after = ta.value.slice(pos + oldLen);
        // Add a space separator if needed
        const needSep = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') && oldLen === 0;
        // Notepad segments end at pauses, so each one starts on its own line.
        const sep = needSep ? (notepadRef.current ? '\n' : ' ') : '';
        programmaticWriteRef.current = true;
        ta.value = before + sep + partial + after;
        programmaticWriteRef.current = false;
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
      }, (next) => {
        if (sessionTokenRef.current !== token) return;
        if (!openRef.current && next) return;
        setListeningState(next);
        // A stop with a still-current token was not requested by the user
        // (user stops bump the token first): the recognizer ended a segment.
        if (!next && notepadRef.current && openRef.current) scheduleNotepadRestart();
      });
      // Check guards after async — overlay may have closed or session may have changed
      if (ok && sessionTokenRef.current === token && openRef.current) {
        setListeningState(true);
      } else if (!ok && sessionTokenRef.current === token) {
        setListeningState(false);
        stopNotepadAutoRestart();
      }
    } catch { /* ignore */ }
  }, [setListeningState]);

  /** Recognizer ended a segment on its own in notepad mode: keep going at the end. */
  function scheduleNotepadRestart(): void {
    if (restartPausedRef.current) return;
    const lasted = Date.now() - segmentStartedAtRef.current;
    shortSegmentsRef.current = lasted < NOTEPAD_SHORT_SEGMENT_MS ? shortSegmentsRef.current + 1 : 0;
    if (shortSegmentsRef.current >= NOTEPAD_MAX_SHORT_SEGMENTS) {
      stopNotepadAutoRestart();
      return;
    }
    // Commit the finished segment; the next one appends after it.
    insertPosRef.current += voiceLenRef.current;
    voiceLenRef.current = 0;
    clearRestartTimer();
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (!notepadRef.current || !openRef.current || listeningRef.current) return;
      void startSession(taRef.current?.value.length ?? 0);
    }, NOTEPAD_RESTART_DELAY_MS);
  }

  /** Leave notepad listening paused (recognizer unavailable or failing fast). */
  function stopNotepadAutoRestart(): void {
    clearRestartTimer();
    restartPausedRef.current = true;
  }

  /** Stop current session and commit voice zone */
  const commitAndStop = useCallback(async () => {
    sessionTokenRef.current++;
    await VoiceInput.stopListening();
    setListeningState(false);
    // Commit: advance insertPos past the committed voice text
    insertPosRef.current += voiceLenRef.current;
    voiceLenRef.current = 0;
  }, [setListeningState]);

  /** Stop, commit, then restart at new cursor position */
  const restartAtCursor = useCallback(async (newPos: number) => {
    await commitAndStop();
    await startSession(newPos);
  }, [commitAndStop, startSession]);

  const handleToggle = useCallback(async () => {
    if (listeningRef.current || restartTimerRef.current) {
      clearRestartTimer();
      await commitAndStop();
      setBars(Array(BAR_COUNT).fill(2));
      barsRef.current = Array(BAR_COUNT).fill(2);
    } else {
      clearAutoStartTimer();
      restartPausedRef.current = false;
      shortSegmentsRef.current = 0;
      const ta = taRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : 0;
      void startSession(pos);
    }
  }, [startSession, commitAndStop, clearAutoStartTimer, clearRestartTimer]);

  const handleNotepadToggle = useCallback(() => {
    const next = !notepadRef.current;
    notepadRef.current = next;
    setNotepad(next);
    shortSegmentsRef.current = 0;
    restartPausedRef.current = false;
    if (!next) {
      clearRestartTimer();
      setNotepadStartedAt(null);
      return;
    }
    setNotepadStartedAt(Date.now());
    setNow(Date.now());
    if (!listeningRef.current) {
      clearAutoStartTimer();
      void startSession(taRef.current?.value.length ?? 0);
    }
  }, [clearAutoStartTimer, clearRestartTimer, startSession]);

  // Elapsed-time clock while notepad mode is on.
  useEffect(() => {
    if (!notepad) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [notepad]);

  // Keep the screen on during a notepad: a locked screen backgrounds the app
  // and the foreground recognizer stops.
  useEffect(() => {
    if (!notepad || !open) return;
    return holdScreenAwake();
  }, [notepad, open]);

  const handleSend = useCallback(() => {
    const transcript = (taRef.current?.value ?? '').trim();
    if (!transcript) return;
    const text = notepadRef.current ? `${t('voice.notepad_summary_prompt')}\n\n${transcript}` : transcript;
    clearRestartTimer();
    sessionTokenRef.current++;
    VoiceInput.stopListening();
    setListeningState(false);
    if (onSend(text) === 'accepted') onClose();
  }, [onSend, onClose, setListeningState, clearRestartTimer, t]);

  const handleClose = useCallback(() => {
    clearRestartTimer();
    notepadRef.current = false;
    sessionTokenRef.current++;
    VoiceInput.stopListening();
    setListeningState(false);
    onClose();
  }, [onClose, setListeningState, clearRestartTimer]);

  /** User manually edited the textarea — commit voice zone and stop recognition */
  const handleInput = useCallback(() => {
    setHasText(!!(taRef.current?.value?.trim()));
    // Ignore programmatic writes from partial callbacks
    if (programmaticWriteRef.current) return;
    // User typed/pasted/deleted — commit current voice segment and stop
    if (listeningRef.current || restartTimerRef.current) {
      clearRestartTimer();
      void commitAndStop();
    }
  }, [commitAndStop, clearRestartTimer]);

  /** Cursor moved outside the active voice zone while listening — restart at new position */
  const handleCursorChange = useCallback(() => {
    // Skip if not listening or if a programmatic write just moved the cursor
    if (!listeningRef.current || programmaticWriteRef.current) return;
    const ta = taRef.current;
    if (!ta) return;
    const cursor = ta.selectionStart;
    const voiceStart = insertPosRef.current;
    const voiceEnd = voiceStart + voiceLenRef.current;
    if (cursor < voiceStart || cursor > voiceEnd) {
      void restartAtCursor(cursor);
    }
  }, [restartAtCursor]);

  if (!open) return null;

  // Portal to <body>: a sub-session window is its own stacking context
  // (`isolation: isolate`), so rendering in place traps the overlay's z-index
  // beneath the app chrome and hides the close button.
  return createPortal((
    <div class="voice-overlay" style={{ height: maxH }}>
      <div class="voice-overlay-grid" />

      <div class="voice-overlay-header">
        <div class="voice-overlay-status">
          <div class={`voice-status-dot${listening ? ' voice-status-dot-active' : ''}`} />
          <span>{listening ? t('voice.listening') : t('voice.paused')}</span>
          {notepad && notepadStartedAt !== null && (
            <span class="voice-notepad-elapsed">{formatElapsed(now - notepadStartedAt)}</span>
          )}
        </div>
        <div class="voice-overlay-actions">
          <button
            type="button"
            class={`voice-notepad-toggle${notepad ? ' voice-notepad-toggle-active' : ''}`}
            aria-pressed={notepad}
            title={t('voice.notepad_hint')}
            onClick={handleNotepadToggle}
          >
            📝 {t('voice.notepad')}
          </button>
          <button class="voice-overlay-close" onClick={handleClose} aria-label={t('common.close')}>✕</button>
        </div>
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
          <span>{notepad ? t('voice.notepad_send') : t('voice.send')}</span>
        </button>
      </div>
    </div>
  ), document.body);
}
