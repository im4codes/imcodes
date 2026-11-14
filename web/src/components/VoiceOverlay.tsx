import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useTranslation } from 'react-i18next';
import * as VoiceInput from './VoiceInput.js';
import { VoiceStreamingRobot } from './VoiceStreamingRobot.js';
import { holdScreenAwake } from '../screen-awake.js';
import {
  NOTEPAD_DRAFT_SAVE_INTERVAL_MS,
  buildNotepadInlineMessage,
  deleteVoiceNotepadDraft,
  readVoiceNotepadDraft,
  writeVoiceNotepadDraft,
  type VoiceNotepadDraft,
  type VoiceNotepadSegment,
  type VoiceNotepadSendOutcome,
  type VoiceNotepadSendRequest,
} from '../voice-notepad.js';

interface Props {
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => 'accepted' | 'pending' | 'rejected';
  initialText?: string;
  /** When false, opens the overlay with initialText for editing without auto-starting microphone capture. */
  autoStartListening?: boolean;
  /**
   * The session the overlay was opened from. Keys the notepad's local draft,
   * so an unfinished notepad is only ever offered back in that session.
   * Without it nothing is persisted.
   */
  draftScope?: string | null;
  /** Shown in the review step as where the notepad will be sent. */
  sessionLabel?: string;
  /**
   * Sends a reviewed notepad (instruction + transcript) through the
   * composer, which decides inline message vs. Markdown attachment. Without
   * it the notepad is sent inline through `onSend`.
   */
  onSendNotepad?: (request: VoiceNotepadSendRequest) => Promise<VoiceNotepadSendOutcome>;
}

interface NotepadReview {
  instruction: string;
  transcript: string;
}

const BAR_COUNT = 48;
export const VOICE_HOLD_MS = 350;
export const VOICE_DOUBLE_TAP_MS = 375;
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

export function VoiceOverlay({
  open,
  onClose,
  onSend,
  initialText,
  autoStartListening = true,
  draftScope,
  sessionLabel,
  onSendNotepad,
}: Props) {
  const { t } = useTranslation();
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(open && autoStartListening);
  const startingTokenRef = useRef<number | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [hasText, setHasText] = useState(false);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));
  const [maxH, setMaxH] = useState('var(--vvh, 100dvh)');
  const [streamMirror, setStreamMirror] = useState<{ before: string; after: string }>({ before: '', after: '' });
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const recognizingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heldRef = useRef(false);
  const suppressMicClickRef = useRef(false);
  const lastMicTapRef = useRef<number | null>(null);
  const micPointerRef = useRef<number | null>(null);
  const barsRef = useRef<number[]>(Array(BAR_COUNT).fill(0));
  // Voice zone: [insertPos, insertPos+voiceLen) is the active voice segment
  const insertPosRef = useRef(0);
  const voiceLenRef = useRef(0);
  // Session token: monotonic counter — partials with stale token are discarded
  const sessionTokenRef = useRef(0);
  const flushingTokenRef = useRef<number | null>(null);
  const stoppingTokenRef = useRef<number | null>(null);
  const stopErrorTokenRef = useRef<number | null>(null);
  const pendingFlushRef = useRef<{ token: number; promise: Promise<boolean> } | null>(null);
  const voiceSendPendingRef = useRef(false);
  const voiceRetryPendingRef = useRef(false);
  const pendingResumeAfterStopRef = useRef(false);
  const pendingResumeWaiterRef = useRef<Promise<void> | null>(null);
  const openSeqRef = useRef(0);
  // Track listening state in a ref so event handlers always see current value
  const listeningRef = useRef(false);
  // Guard: true while a programmatic write (partial callback) is in progress
  const programmaticWriteRef = useRef(false);
  // Guard: true while overlay is open
  const openRef = useRef(false);
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
  // Crash-safe draft. The scope is read when the overlay opens; a notepad
  // started (or resumed) in this opening keeps writing to it until it is sent
  // or discarded -- after which nothing may write it back.
  const draftScopeRef = useRef<string | null>(draftScope ?? null);
  draftScopeRef.current = draftScope ?? null;
  // The composer text this opening started from. A fresh notepad keeps it at
  // the top of the transcript; an adopted draft must keep it too, or a send
  // would clear composer text the user never saw in the overlay.
  const initialTextRef = useRef('');
  const draftActiveRef = useRef(false);
  const draftSettledRef = useRef(false);
  const draftStartedAtRef = useRef(0);
  const draftSegmentsRef = useRef<VoiceNotepadSegment[]>([]);
  const draftInstructionRef = useRef<string | undefined>(undefined);
  const lastSavedDraftRef = useRef('');
  // An unfinished notepad found for this session when the overlay opened.
  const [recoverableDraft, setRecoverableDraft] = useState<VoiceNotepadDraft | null>(null);
  // Review step: shown when a notepad stops or Send is tapped in notepad mode.
  const [review, setReviewState] = useState<NotepadReview | null>(null);
  const reviewRef = useRef<NotepadReview | null>(null);
  const [sendingNotepad, setSendingNotepad] = useState(false);
  const [notepadSendFailed, setNotepadSendFailed] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const setReview = useCallback((next: NotepadReview | null) => {
    reviewRef.current = next;
    setReviewState(next);
  }, []);

  /** Write the notepad as it stands now. No-op once sent or discarded. */
  const saveDraft = useCallback(() => {
    const scope = draftScopeRef.current;
    if (!scope || !draftActiveRef.current || draftSettledRef.current) return;
    const current = reviewRef.current;
    const text = current ? current.transcript : (taRef.current?.value ?? '');
    if (!text.trim()) return;
    const instruction = current ? current.instruction : draftInstructionRef.current;
    const fingerprint = JSON.stringify([text, instruction ?? null, draftSegmentsRef.current.length]);
    if (fingerprint === lastSavedDraftRef.current) return;
    // One unsent notepad per session. Another one already stored under this
    // key (not yet answered, or written by a second window on the same
    // session) is the user's data too, and is never overwritten.
    const stored = readVoiceNotepadDraft(scope);
    if (stored && stored.startedAt !== draftStartedAtRef.current) return;
    if (writeVoiceNotepadDraft({
      version: 1,
      scope,
      text,
      ...(instruction !== undefined ? { instruction } : {}),
      segments: draftSegmentsRef.current,
      startedAt: draftStartedAtRef.current,
      updatedAt: Date.now(),
    })) {
      lastSavedDraftRef.current = fingerprint;
    }
  }, []);

  /** The notepad was sent or discarded: delete it and never write it again. */
  const settleDraft = useCallback(() => {
    draftSettledRef.current = true;
    const scope = draftScopeRef.current;
    if (scope) deleteVoiceNotepadDraft(scope);
  }, []);

  /** Start (or adopt) the draft this opening of the overlay writes to. */
  const beginDraft = useCallback((from?: VoiceNotepadDraft) => {
    draftActiveRef.current = true;
    draftSettledRef.current = false;
    lastSavedDraftRef.current = '';
    draftStartedAtRef.current = from?.startedAt ?? Date.now();
    draftSegmentsRef.current = from ? [...from.segments] : [];
    draftInstructionRef.current = from?.instruction;
  }, []);

  /** Record the voice segment being committed, relative to the notepad start. */
  const recordCommittedSegment = useCallback(() => {
    if (!notepadRef.current || !draftActiveRef.current) return;
    const ta = taRef.current;
    const length = voiceLenRef.current;
    if (!ta || length <= 0) return;
    const text = ta.value.slice(insertPosRef.current, insertPosRef.current + length).trim();
    if (!text) return;
    draftSegmentsRef.current.push({ atMs: Math.max(0, Date.now() - draftStartedAtRef.current), text });
  }, []);

  const clearRecognizingTimer = useCallback(() => {
    if (!recognizingTimerRef.current) return;
    clearTimeout(recognizingTimerRef.current);
    recognizingTimerRef.current = null;
  }, []);

  const pulseRecognizing = useCallback((durationMs = 1600) => {
    if (!openRef.current || !listeningRef.current) return;
    setRecognizing(true);
    clearRecognizingTimer();
    recognizingTimerRef.current = setTimeout(() => {
      recognizingTimerRef.current = null;
      if (openRef.current) setRecognizing(false);
    }, durationMs);
  }, [clearRecognizingTimer]);

  const setListeningState = useCallback((next: boolean) => {
    // stopListening() reports `false` synchronously while the effect is being
    // cleaned up. Never enqueue hook state once the overlay is closed or
    // unmounting; the next open initializes both values below.
    if (!openRef.current) {
      listeningRef.current = false;
      clearRecognizingTimer();
      return;
    }
    listeningRef.current = next;
    setListening(next);
    if (next) {
      setStarting(false);
    } else {
      clearRecognizingTimer();
      setRecognizing(false);
    }
  }, [clearRecognizingTimer]);

  const clearRestartTimer = useCallback(() => {
    if (!restartTimerRef.current) return;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
  }, []);

  const syncStreamMirror = useCallback((explicitPos?: number, explicitLen?: number) => {
    const ta = taRef.current;
    if (!ta) {
      setStreamMirror({ before: '', after: '' });
      return;
    }
    const value = ta.value;
    const pos = explicitPos ?? insertPosRef.current;
    const len = explicitLen ?? voiceLenRef.current;
    const splitAt = Math.max(0, Math.min(value.length, pos + len));
    setStreamMirror({
      before: value.slice(0, splitAt),
      after: value.slice(splitAt),
    });
    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = ta.scrollTop;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      openRef.current = false;
      openSeqRef.current++;
      stoppingTokenRef.current = null;
      stopErrorTokenRef.current = null;
      pendingResumeAfterStopRef.current = false;
      pendingResumeWaiterRef.current = null;
      return;
    }
    openRef.current = true;
    openSeqRef.current++;
    stoppingTokenRef.current = null;
    stopErrorTokenRef.current = null;
    pendingResumeAfterStopRef.current = false;
    pendingResumeWaiterRef.current = null;
    stopErrorTokenRef.current = null;
    const init = initialText ?? '';
    initialTextRef.current = init;
    // Never auto-focus the textarea on open: popping up the mobile soft keyboard
    // occludes the Send button. The keyboard only opens when the user manually taps the textarea.
    if (taRef.current) { taRef.current.value = init; }
    setHasText(!!init.trim());
    setMaxH('var(--vvh, 100dvh)');
    setListening(false);
    setRecognizing(false);
    clearRecognizingTimer();
    listeningRef.current = false;
    notepadRef.current = false;
    setNotepad(false);
    setNotepadStartedAt(null);
    shortSegmentsRef.current = 0;
    restartPausedRef.current = false;
    draftActiveRef.current = false;
    draftSettledRef.current = false;
    draftSegmentsRef.current = [];
    draftInstructionRef.current = undefined;
    lastSavedDraftRef.current = '';
    reviewRef.current = null;
    setReviewState(null);
    setSendingNotepad(false);
    setNotepadSendFailed(false);
    setVoiceError(null);
    voiceRetryPendingRef.current = false;
    flushingTokenRef.current = null;
    pendingFlushRef.current = null;
    const scope = draftScopeRef.current;
    const recoverable = scope ? readVoiceNotepadDraft(scope) : null;
    setRecoverableDraft(recoverable);
    startingTokenRef.current = null;
    setStarting(!recoverable && autoStartListening);
    insertPosRef.current = init.length;
    voiceLenRef.current = 0;
    syncStreamMirror(init.length, 0);
    sessionTokenRef.current++;
    setBars(Array(BAR_COUNT).fill(0));
    barsRef.current = Array(BAR_COUNT).fill(0);

    VoiceInput.onAudioLevel((rawLevel) => {
      const level = Math.max(0, Math.min(1, Number.isFinite(rawLevel) ? rawLevel : 0));
      if (level > 0.015 && listeningRef.current) {
        pulseRecognizing(1800);
      }
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
    const syncViewportHeight = () => {
      if (!vv) {
        setMaxH('var(--vvh, 100dvh)');
        return;
      }
      const kbOpen = window.innerHeight - vv.height > 50;
      setMaxH(kbOpen ? `${vv.height}px` : 'var(--vvh, 100dvh)');
    };
    syncViewportHeight();
    vv?.addEventListener('resize', syncViewportHeight);
    vv?.addEventListener('scroll', syncViewportHeight);

    // Start voice session immediately at end of initial text (not 0). An unfinished
    // notepad waits for the user's choice instead: dictation starting on its
    // own would talk over the offer to resume it.
    if (!recoverable && autoStartListening) {
      void startSession(init.length);
    } else if (Object.prototype.hasOwnProperty.call(VoiceInput, 'cancelWebGesturePrime')) {
      const cancelPrime = (VoiceInput as { cancelWebGesturePrime?: () => void }).cancelWebGesturePrime;
      if (typeof cancelPrime === 'function') cancelPrime();
    }
    return () => {
      clearRestartTimer();
      clearRecognizingTimer();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      heldRef.current = false;
      lastMicTapRef.current = null;
      micPointerRef.current = null;
      notepadRef.current = false;
      openRef.current = false;
      openSeqRef.current++;
      sessionTokenRef.current++;
      startingTokenRef.current = null;
      voiceRetryPendingRef.current = false;
      pendingResumeAfterStopRef.current = false;
      pendingResumeWaiterRef.current = null;
      flushingTokenRef.current = null;
      stoppingTokenRef.current = null;
      stopErrorTokenRef.current = null;
      pendingFlushRef.current = null;
      vv?.removeEventListener('resize', syncViewportHeight);
      vv?.removeEventListener('scroll', syncViewportHeight);
      VoiceInput.onAudioLevel(null);
      VoiceInput.stopListening();
      // Effect cleanup also runs during unmount. Updating hook state here queues
      // a Preact render after the component has already left the tree, leaving
      // its after-paint RAF alive past test/page teardown. Keep the synchronous
      // ref truthful; the next open initializes both ref and rendered state.
      listeningRef.current = false;
    };
  }, [open, clearRestartTimer, setListeningState]);

  /** Stop current session and commit voice zone */
  const commitAndStop = useCallback((flush = false): Promise<boolean> => {
    startingTokenRef.current = null;
    setStarting(false);
    const token = sessionTokenRef.current;
    // A tap-stop and double-tap-send can await the SAME native stop ACK.
    // Share the whole commit, not merely stopListening(): incrementing the
    // token twice would make the send waiter look stale and silently cancel it.
    const pending = pendingFlushRef.current;
    if (flush && pending?.token === token) return pending.promise;
    stoppingTokenRef.current = token;
    stopErrorTokenRef.current = null;
    if (flush) {
      flushingTokenRef.current = token;
    } else {
      flushingTokenRef.current = null;
      sessionTokenRef.current++;
    }
    const expectedToken = token + (flush ? 0 : 1);
    const stopping = (async () => {
      let stopThrew = false;
      try {
        await VoiceInput.stopListening();
      } catch (err) {
        stopThrew = true;
        console.warn('[voice] stopListening failed:', err);
        if (openRef.current && sessionTokenRef.current === expectedToken) {
          const msg = err instanceof Error && err.message.trim() ? err.message.trim() : 'permission_denied';
          setVoiceError((prev) => prev ?? msg);
        }
      } finally {
        if (flushingTokenRef.current === token) {
          flushingTokenRef.current = null;
        }
        if (stoppingTokenRef.current === token) {
          stoppingTokenRef.current = null;
        }
      }
      const drainFailed = stopThrew || stopErrorTokenRef.current === token;
      if (stopErrorTokenRef.current === token) {
        stopErrorTokenRef.current = null;
      }
      if (sessionTokenRef.current !== expectedToken) return false;
      if (flush) {
        sessionTokenRef.current++;
      }
      setListeningState(false);
      // Commit text boundary so any preserved partial stays intact and is not overwritten on retry.
      recordCommittedSegment();
      const committedLen = voiceLenRef.current;
      insertPosRef.current += committedLen;
      voiceLenRef.current = 0;
      syncStreamMirror(insertPosRef.current, 0);
      if (committedLen > 0 && taRef.current && document.activeElement === taRef.current) {
        const endPos = insertPosRef.current;
        taRef.current.setSelectionRange(endPos, endPos);
      }
      return !drainFailed;
    })();
    if (flush) {
      const entry = { token, promise: stopping };
      pendingFlushRef.current = entry;
      const clear = () => { if (pendingFlushRef.current === entry) pendingFlushRef.current = null; };
      void stopping.then(clear, clear);
    }
    return stopping;
  }, [recordCommittedSegment, setListeningState]);

  /** Start a new recognition session, inserting at given position */
  const startSession = useCallback(async (atPos: number) => {
    pendingResumeAfterStopRef.current = false;
    if (!openRef.current || startingTokenRef.current !== null) return;
    const ta = taRef.current;
    if (!ta) return;
    const token = ++sessionTokenRef.current;
    startingTokenRef.current = token;
    setStarting(true);
    insertPosRef.current = atPos;
    voiceLenRef.current = 0;
    syncStreamMirror(atPos, 0);
    segmentStartedAtRef.current = Date.now();
    setVoiceError(null);

    let sessionActive = false;
    let lastReportedListening: boolean | null = null;
    let startCallSettled = false;
    let pendingErrorWhileStarting = false;
    let keepStartingPending = false;
    try {
      const ok = await VoiceInput.startListening((partial) => {
        // Discard if session token changed (stale callback from old session)
        if (sessionTokenRef.current !== token) return;
        if (!openRef.current) return;
        if (flushingTokenRef.current === token && !sessionActive) return;
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
        // Move cursor to end of voice segment only if the user already focused the textarea;
        // never focus programmatically, as that pops up the mobile soft keyboard over the Send button.
        const cursorPos = actualPos + newVoiceLen;
        requestAnimationFrame(() => {
          if (document.activeElement === ta) {
            ta.setSelectionRange(cursorPos, cursorPos);
          }
        });
        ta.scrollTop = ta.scrollHeight;
        setHasText(!!ta.value.trim());
        syncStreamMirror(actualPos, newVoiceLen);
        pulseRecognizing(900);
      }, (next) => {
        if (sessionTokenRef.current !== token) return;
        if (!openRef.current && next) return;
        if (next && (flushingTokenRef.current === token || stoppingTokenRef.current === token)) return;
        lastReportedListening = next;
        if (next) {
          sessionActive = true;
          if (startingTokenRef.current === token) {
            startingTokenRef.current = null;
          }
        } else if (startingTokenRef.current === token) {
          startingTokenRef.current = null;
          if (openRef.current) setStarting(false);
        }
        setListeningState(next);
        // A stop with a still-current token was not requested by the user
        // (user stops bump the token first): the recognizer ended a segment.
        if (!next && flushingTokenRef.current !== token && notepadRef.current && openRef.current) scheduleNotepadRestart();
      }, (err) => {
        if (!openRef.current) return;
        if (stoppingTokenRef.current === token) {
          setVoiceError(err || 'permission_denied');
          stopNotepadAutoRestart();
          stopErrorTokenRef.current = token;
          return;
        }
        if (sessionTokenRef.current !== token) return;
        setVoiceError(err || 'permission_denied');
        stopNotepadAutoRestart();
        if (sessionActive || listeningRef.current || (startCallSettled && startingTokenRef.current === token)) {
          void commitAndStop(true);
        } else if (startingTokenRef.current === token) {
          pendingErrorWhileStarting = true;
        }
      });
      startCallSettled = true;
      const currentValid = sessionTokenRef.current === token
        && flushingTokenRef.current !== token
        && stoppingTokenRef.current !== token
        && openRef.current;
      // Check guards after async — overlay may have closed or session may have changed
      if (ok && currentValid) {
        if (lastReportedListening === false) {
          setListeningState(false);
        } else if (lastReportedListening === true) {
          sessionActive = true;
          setListeningState(true);
        } else if (pendingErrorWhileStarting) {
          void commitAndStop(true);
        } else {
          // Capture request submitted (e.g. Web Speech rec.start()) without synchronous confirmation yet.
          // Preserve starting + cancellable startingTokenRef until onListeningChange(true), error, end, stop, or close.
          keepStartingPending = true;
        }
      } else if (!ok && currentValid) {
        setListeningState(false);
        stopNotepadAutoRestart();
        setVoiceError((prev) => prev ?? 'permission_denied');
      }
    } catch (err) {
      startCallSettled = true;
      if (sessionTokenRef.current === token && openRef.current) {
        setListeningState(false);
        stopNotepadAutoRestart();
        setVoiceError(err instanceof Error ? err.message : 'permission_denied');
      }
    } finally {
      if (!keepStartingPending && startingTokenRef.current === token) {
        startingTokenRef.current = null;
        if (openRef.current) setStarting(false);
      }
    }
  }, [commitAndStop, setListeningState]);

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
    recordCommittedSegment();
    insertPosRef.current += voiceLenRef.current;
    voiceLenRef.current = 0;
    saveDraft();
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

  /**
   * End the notepad and show what will be sent. Nothing leaves the device
   * here; the draft is written so the review itself survives a crash.
   */
  const openReview = useCallback(async () => {
    pendingResumeAfterStopRef.current = false;
    clearRestartTimer();
    if (!await commitAndStop(true) || !openRef.current) return;
    setBars(Array(BAR_COUNT).fill(0));
    barsRef.current = Array(BAR_COUNT).fill(0);
    setNotepadSendFailed(false);
    setReview({
      instruction: draftInstructionRef.current ?? t('voice.notepad_summary_instruction'),
      transcript: taRef.current?.value ?? '',
    });
    saveDraft();
  }, [clearRestartTimer, commitAndStop, saveDraft, setReview, t]);

  /** Stop, commit, then restart at new cursor position */
  const restartAtCursor = useCallback(async (newPos: number) => {
    if (!await commitAndStop()) return;
    await startSession(newPos);
  }, [commitAndStop, startSession]);

  const handleRetry = useCallback(async () => {
    if (voiceRetryPendingRef.current) return;
    voiceRetryPendingRef.current = true;
    pendingResumeAfterStopRef.current = false;
    try {
      clearRestartTimer();
      restartPausedRef.current = false;
      shortSegmentsRef.current = 0;
      if (listeningRef.current || startingTokenRef.current !== null || pendingFlushRef.current) {
        if (!await commitAndStop(true) || !openRef.current) return;
      }
      if (!openRef.current) return;
      const ta = taRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : 0;
      await startSession(pos);
    } finally {
      voiceRetryPendingRef.current = false;
    }
  }, [clearRestartTimer, commitAndStop, startSession]);

  const handleToggle = useCallback(async () => {
    if ((listeningRef.current || startingTokenRef.current !== null || restartTimerRef.current !== null || pendingFlushRef.current !== null) && notepadRef.current) {
      pendingResumeAfterStopRef.current = false;
      await openReview();
      return;
    }
    if (listeningRef.current || startingTokenRef.current !== null || restartTimerRef.current) {
      pendingResumeAfterStopRef.current = false;
      clearRestartTimer();
      const committed = await commitAndStop(true);
      setBars(Array(BAR_COUNT).fill(0));
      barsRef.current = Array(BAR_COUNT).fill(0);
      if (!committed) return;
    } else {
      if (voiceRetryPendingRef.current) return;
      restartPausedRef.current = false;
      shortSegmentsRef.current = 0;
      if (pendingFlushRef.current) {
        // Coalesce Pause -> Mic clicks while native stop is draining instead of
        // spawning competing waits or starting a stale session after Send/Close.
        pendingResumeAfterStopRef.current = true;
        if (pendingResumeWaiterRef.current) return;
        const resumeOpenSeq = openSeqRef.current;
        let waiter!: Promise<void>;
        waiter = (async () => {
          let committed = false;
          try {
            committed = await commitAndStop(true);
          } finally {
            if (pendingResumeWaiterRef.current === waiter) {
              pendingResumeWaiterRef.current = null;
            }
          }
          if (!committed || !pendingResumeAfterStopRef.current || !openRef.current || openSeqRef.current !== resumeOpenSeq) {
            pendingResumeAfterStopRef.current = false;
            return;
          }
          pendingResumeAfterStopRef.current = false;
          if (listeningRef.current || startingTokenRef.current !== null) return;
          const ta = taRef.current;
          const pos = ta ? (ta.selectionStart ?? ta.value.length) : 0;
          void startSession(pos);
        })();
        pendingResumeWaiterRef.current = waiter;
        await waiter;
        return;
      }
      const ta = taRef.current;
      const pos = ta ? (ta.selectionStart ?? ta.value.length) : 0;
      void startSession(pos);
    }
  }, [startSession, commitAndStop, clearRestartTimer, openReview]);

  const handleNotepadToggle = useCallback(() => {
    const next = !notepadRef.current;
    if (next && !draftActiveRef.current) {
      // Starting fresh would write over this session's unsent notepad. It has
      // to be resumed, sent or discarded first, so offer it instead.
      const scope = draftScopeRef.current;
      const unsent = scope ? readVoiceNotepadDraft(scope) : null;
      if (unsent) {
        setRecoverableDraft(unsent);
        return;
      }
    }
    notepadRef.current = next;
    setNotepad(next);
    shortSegmentsRef.current = 0;
    restartPausedRef.current = false;
    if (!next) {
      clearRestartTimer();
      setNotepadStartedAt(null);
      return;
    }
    if (!draftActiveRef.current) beginDraft();
    setNotepadStartedAt(draftStartedAtRef.current);
    setNow(Date.now());
    if (!listeningRef.current) {
      void startSession(taRef.current?.value.length ?? 0);
    }
  }, [beginDraft, clearRestartTimer, startSession]);

  // Elapsed-time clock while notepad mode is on.
  useEffect(() => {
    if (!notepad) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [notepad]);

  // Keep the screen on during a notepad: a locked screen backgrounds the app
  // and the foreground recognizer stops.
  const reviewing = review !== null;
  useEffect(() => {
    if (!notepad || !open || reviewing) return;
    return holdScreenAwake();
  }, [notepad, open, reviewing]);

  // Crash-safe draft: write every few seconds while a notepad is recording or
  // under review, and whenever the page is being hidden or torn down.
  useEffect(() => {
    if (!open || (!notepad && !reviewing)) return;
    const id = setInterval(saveDraft, NOTEPAD_DRAFT_SAVE_INTERVAL_MS);
    const onPageHide = () => saveDraft();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveDraft();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [open, notepad, reviewing, saveDraft]);

  const handleSend = useCallback(async () => {
    if (voiceSendPendingRef.current) return;
    if (notepadRef.current) {
      void openReview();
      return;
    }
    voiceSendPendingRef.current = true;
    pendingResumeAfterStopRef.current = false;
    const sendOpenSeq = openSeqRef.current;
    try {
      clearRestartTimer();
      if (listeningRef.current || startingTokenRef.current !== null || restartTimerRef.current !== null || pendingFlushRef.current !== null) {
        if (!await commitAndStop(true)) return;
      }
      if (!openRef.current || openSeqRef.current !== sendOpenSeq) return;
      const transcript = (taRef.current?.value ?? '').trim();
      if (!transcript) return;
      if (onSend(transcript) === 'accepted') {
        if (draftActiveRef.current) settleDraft();
        onClose();
      }
    } finally { voiceSendPendingRef.current = false; }
  }, [onSend, onClose, openReview, commitAndStop, clearRestartTimer, settleDraft]);

  const endMicPress = useCallback((pointerId: number, cancelled = false) => {
    if (micPointerRef.current !== pointerId) return;
    micPointerRef.current = null;
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    if (heldRef.current) {
      heldRef.current = false;
      suppressMicClickRef.current = true;
      lastMicTapRef.current = null;
      void commitAndStop(true);
    } else if (cancelled) {
      suppressMicClickRef.current = true;
      lastMicTapRef.current = null;
    }
  }, [commitAndStop]);

  const handleReviewSend = useCallback(async () => {
    const current = reviewRef.current;
    if (!current || sendingNotepad) return;
    const transcript = current.transcript.trim();
    if (!transcript) return;
    saveDraft();
    setNotepadSendFailed(false);
    if (!onSendNotepad) {
      const text = buildNotepadInlineMessage(current.instruction, t('voice.notepad_transcript_label'), transcript);
      if (onSend(text) === 'accepted') {
        settleDraft();
        onClose();
      }
      return;
    }
    setSendingNotepad(true);
    let outcome: VoiceNotepadSendOutcome;
    try {
      outcome = await onSendNotepad({
        instruction: current.instruction,
        transcript,
        onAccepted: settleDraft,
      });
    } catch {
      outcome = 'rejected';
    }
    if (!openRef.current) return;
    setSendingNotepad(false);
    if (outcome === 'accepted') onClose();
    else if (outcome === 'rejected') setNotepadSendFailed(true);
  }, [onClose, onSend, onSendNotepad, saveDraft, sendingNotepad, settleDraft, t]);

  const handleReviewDiscard = useCallback(() => {
    if (!window.confirm(t('voice.notepad_discard_confirm'))) return;
    settleDraft();
    notepadRef.current = false;
    onClose();
  }, [onClose, settleDraft, t]);

  /** Back from review to recording, keeping every edit made there. */
  const handleReviewContinue = useCallback(() => {
    const current = reviewRef.current;
    if (!current) return;
    draftInstructionRef.current = current.instruction;
    const ta = taRef.current;
    if (ta) {
      ta.value = current.transcript;
      setHasText(!!current.transcript.trim());
    }
    setReview(null);
    notepadRef.current = true;
    setNotepad(true);
    shortSegmentsRef.current = 0;
    restartPausedRef.current = false;
    void startSession(ta?.value.length ?? 0);
  }, [setReview, startSession]);

  /** Adopt the unfinished notepad into this opening of the overlay. */
  const adoptRecoverableDraft = useCallback((draft: VoiceNotepadDraft): string => {
    setRecoverableDraft(null);
    beginDraft(draft);
    // Whatever the overlay sends clears the composer, so the composer text it
    // opened with stays on screen above the recovered transcript -- the same
    // place a fresh notepad keeps it -- unless the draft already starts with it.
    const composerText = initialTextRef.current.trim();
    const text = composerText && !draft.text.startsWith(composerText)
      ? `${composerText}\n${draft.text}`
      : draft.text;
    const ta = taRef.current;
    if (ta) ta.value = text;
    setHasText(!!text.trim());
    insertPosRef.current = text.length;
    voiceLenRef.current = 0;
    syncStreamMirror(text.length, 0);
    notepadRef.current = true;
    setNotepad(true);
    setNotepadStartedAt(draft.startedAt);
    setNow(Date.now());
    return text;
  }, [beginDraft]);

  const handleResumeDraft = useCallback((draft: VoiceNotepadDraft) => {
    const text = adoptRecoverableDraft(draft);
    shortSegmentsRef.current = 0;
    restartPausedRef.current = false;
    void startSession(text.length);
  }, [adoptRecoverableDraft, startSession]);

  const handleReviewRecoverableDraft = useCallback((draft: VoiceNotepadDraft) => {
    const text = adoptRecoverableDraft(draft);
    setNotepadSendFailed(false);
    setReview({
      instruction: draft.instruction ?? t('voice.notepad_summary_instruction'),
      transcript: text,
    });
  }, [adoptRecoverableDraft, setReview, t]);

  const handleDiscardRecoverableDraft = useCallback((draft: VoiceNotepadDraft) => {
    if (!window.confirm(t('voice.notepad_discard_confirm'))) return;
    deleteVoiceNotepadDraft(draft.scope);
    setRecoverableDraft(null);
    // What the user opened the overlay for: ordinary dictation.
    void startSession(taRef.current?.value.length ?? 0);
  }, [startSession, t]);

  const handleClose = useCallback(() => {
    // Closing is neither sending nor discarding: the notepad stays on this
    // device and is offered again the next time voice input opens here.
    saveDraft();
    clearRestartTimer();
    pendingResumeAfterStopRef.current = false;
    pendingResumeWaiterRef.current = null;
    stopErrorTokenRef.current = null;
    notepadRef.current = false;
    openSeqRef.current++;
    sessionTokenRef.current++;
    startingTokenRef.current = null;
    setStarting(false);
    VoiceInput.stopListening();
    setListeningState(false);
    onClose();
  }, [onClose, saveDraft, setListeningState, clearRestartTimer]);

  /** User manually edited the textarea — commit voice zone and stop recognition */
  const handleInput = useCallback(() => {
    setHasText(!!(taRef.current?.value?.trim()));
    syncStreamMirror();
    // Ignore programmatic writes from partial callbacks
    if (programmaticWriteRef.current) return;
    // User typed/pasted/deleted — commit current voice segment and stop
    if (listeningRef.current || startingTokenRef.current !== null || restartTimerRef.current) {
      pendingResumeAfterStopRef.current = false;
      clearRestartTimer();
      void commitAndStop();
    }
  }, [commitAndStop, clearRestartTimer, syncStreamMirror]);

  useEffect(() => {
    if ((listening || starting) && mirrorRef.current && taRef.current) {
      mirrorRef.current.scrollTop = taRef.current.scrollTop;
    }
  }, [streamMirror, listening, starting]);

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
    <>
    <div class="voice-overlay-backdrop" aria-hidden="true" />
    <div class="voice-overlay" role="dialog" aria-modal="true" style={{ height: maxH }}>
      <div class="voice-overlay-grid" />

      <div class="voice-overlay-header">
        <div class="voice-overlay-status">
          <div class={`voice-status-dot${listening ? ' voice-status-dot-active' : ''}${recognizing ? ' voice-status-dot-recognizing' : ''}`} />
          <span role="status" aria-live="polite">
            {starting && !listening ? t('voice.starting') : listening
              ? t(recognizing ? 'voice.recognizing' : 'voice.listening')
              : t('voice.ready')}
          </span>
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
            disabled={recoverableDraft !== null && !review}
            onClick={handleNotepadToggle}
          >
            📝 {t('voice.notepad')}
          </button>
          <button class="voice-overlay-close" onClick={handleClose} aria-label={t('common.close')}>✕</button>
        </div>
      </div>

      {voiceError && !review && (
        <div class="voice-overlay-error" role="alert">
          <span class="voice-overlay-error-text">
            {voiceError === 'permission_denied'
              ? t('voice.mic_permission_failed')
              : t('voice.error', { error: voiceError })}
          </span>
          <button
            type="button"
            class="voice-overlay-retry"
            onClick={() => { void handleRetry(); }}
          >
            {t('voice.retry')}
          </button>
        </div>
      )}

      {recoverableDraft && !review && (
        <div class="voice-notepad-recovery" role="status">
          <span class="voice-notepad-recovery-text">
            {t('voice.notepad_draft_found', {
              time: new Date(recoverableDraft.updatedAt).toLocaleString(),
              count: recoverableDraft.text.length,
            })}
          </span>
          <div class="voice-notepad-recovery-actions">
            <button type="button" class="voice-notepad-resume" onClick={() => handleResumeDraft(recoverableDraft)}>
              {t('voice.notepad_resume')}
            </button>
            <button type="button" class="voice-notepad-review-draft" onClick={() => handleReviewRecoverableDraft(recoverableDraft)}>
              {t('voice.notepad_send')}
            </button>
            <button type="button" class="voice-notepad-discard-draft" onClick={() => handleDiscardRecoverableDraft(recoverableDraft)}>
              {t('voice.notepad_discard')}
            </button>
          </div>
        </div>
      )}

      {review && (
        <div class="voice-notepad-review">
          <div class="voice-notepad-review-title">{t('voice.notepad_review_title')}</div>
          {sessionLabel && (
            <div class="voice-notepad-review-target">
              {t('voice.notepad_review_target', { session: sessionLabel })}
            </div>
          )}
          <label class="voice-notepad-review-label">
            {t('voice.notepad_review_instruction')}
            <textarea
              class="voice-notepad-review-instruction"
              spellcheck={false}
              value={review.instruction}
              onInput={(event) => setReview({
                ...review,
                instruction: (event.currentTarget as HTMLTextAreaElement).value,
              })}
            />
          </label>
          <label class="voice-notepad-review-label">
            {t('voice.notepad_review_transcript')}
            <textarea
              class="voice-notepad-review-transcript"
              spellcheck={false}
              value={review.transcript}
              onInput={(event) => setReview({
                ...review,
                transcript: (event.currentTarget as HTMLTextAreaElement).value,
              })}
            />
          </label>
          {notepadSendFailed && (
            <div class="voice-notepad-review-error" role="alert">{t('voice.notepad_send_failed')}</div>
          )}
          <div class="voice-notepad-review-actions">
            <button type="button" class="voice-notepad-continue" onClick={handleReviewContinue} disabled={sendingNotepad}>
              {t('voice.notepad_continue')}
            </button>
            <button type="button" class="voice-notepad-discard" onClick={handleReviewDiscard} disabled={sendingNotepad}>
              {t('voice.notepad_discard')}
            </button>
            <button
              type="button"
              class="voice-overlay-send voice-notepad-review-send"
              onClick={() => { void handleReviewSend(); }}
              disabled={sendingNotepad || !review.transcript.trim()}
            >
              <span>{sendingNotepad ? t('voice.notepad_sending') : t('voice.notepad_send')}</span>
            </button>
          </div>
        </div>
      )}

      <div class={`voice-overlay-editor-wrap${listening || recognizing ? ' voice-editor-marquee' : ''}`} style={review ? { display: 'none' } : undefined}>
        {(listening || starting) && !review && (
          <div
            ref={mirrorRef}
            class="voice-overlay-stream-mirror"
            aria-hidden="true"
          >
            {streamMirror.before}
            <VoiceStreamingRobot active={recognizing || listening} />
            {streamMirror.after}
          </div>
        )}
        <textarea
          ref={taRef}
          class={`voice-overlay-text${listening || starting ? ' voice-overlay-text-streaming' : ''}`}
          placeholder={t('voice.speak_now')}
          spellcheck={false}
          readOnly={listening || starting}
          inputMode={listening || starting ? 'none' : undefined}
          onInput={handleInput}
          onScroll={() => {
            if (mirrorRef.current && taRef.current) {
              mirrorRef.current.scrollTop = taRef.current.scrollTop;
            }
          }}
          onSelect={handleCursorChange}
          onClick={handleCursorChange}
          onTouchEnd={handleCursorChange}
          onKeyUp={handleCursorChange}
        />
      </div>

      <div class="voice-overlay-controls" style={review ? { display: 'none' } : undefined}>
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
          style={{ touchAction: 'none' }}
          aria-label={t('voice.voice_input')}
          onPointerDown={(event) => {
            if (event.button !== 0 || micPointerRef.current !== null || notepadRef.current) return;
            micPointerRef.current = event.pointerId;
            suppressMicClickRef.current = false;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            holdTimerRef.current = setTimeout(() => {
              holdTimerRef.current = null;
              heldRef.current = true;
              if (!listeningRef.current) void handleToggle();
            }, VOICE_HOLD_MS);
          }}
          onPointerUp={(event) => endMicPress(event.pointerId)}
          onPointerCancel={(event) => endMicPress(event.pointerId, true)}
          // Implicit capture release is not pointer cancellation (notably on WebKit).
          onLostPointerCapture={(event) => endMicPress(event.pointerId)}
          onClick={(event) => {
            if (suppressMicClickRef.current) { suppressMicClickRef.current = false; return; }
            const now = Date.now();
            const prior = lastMicTapRef.current;
            lastMicTapRef.current = event.detail > 0 ? now : null;
            if (event.detail > 0 && prior !== null && now - prior <= VOICE_DOUBLE_TAP_MS) {
              lastMicTapRef.current = null;
              void handleSend(); // Uses the existing final-drain + accepted-send guard.
            } else { void handleToggle(); }
          }}
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
    </>
  ), document.body);
}
