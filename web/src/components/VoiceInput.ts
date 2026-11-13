/**
 * VoiceInput — speech recognition wrapper.
 * Native Android/iOS use our shared offline streaming bridge when installed;
 * older shells retain the existing @capgo platform recognizer. On desktop browsers (Chrome / Edge / Safari) it falls back to
 * the Web Speech API (window.SpeechRecognition / webkitSpeechRecognition).
 * Firefox has no Web Speech API, so the button is hidden there.
 * Both paths share the same callback contract: onResult receives the FULL
 * cumulative transcript of the current session each time (the overlay replaces
 * the prior voice segment with it), plus an isFinal flag.
 */
import {
  getNativeSpeechRecognition,
  getPlatformFallbackSpeechRecognition,
  type NativeSpeechRecognition,
} from '../voice-recognition-backend.js';
import type { PluginListenerHandle } from '@capacitor/core';

/** Resolve the user's active UI language preference first, then fall back to system navigator.language. */
function resolvePreferredLanguageTag(preferredLang?: string): string {
  if (typeof preferredLang === 'string' && preferredLang.trim()) {
    return preferredLang.trim();
  }
  try {
    const saved = globalThis.localStorage?.getItem('imcodes_lang');
    if (typeof saved === 'string' && saved.trim()) {
      return saved.trim();
    }
  } catch { /* localStorage may be unavailable in restricted contexts */ }
  const docLang = typeof document !== 'undefined' ? document.documentElement?.lang?.trim() : '';
  if (docLang) return docLang;
  return (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'en-US';
}

/** Native (Capacitor) speech-recognition locale tags. */
export function pickLocale(preferredLang?: string): string {
  const lang = resolvePreferredLanguageTag(preferredLang).toLowerCase();
  if (lang.startsWith('zh')) {
    return lang.includes('tw') || lang.includes('hk') || lang.includes('hant') ? 'zh-Hant' : 'zh-Hans';
  }
  if (lang.startsWith('ja')) return 'ja-JP';
  if (lang.startsWith('ko')) return 'ko-KR';
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

/** Web Speech API locale tags (BCP-47, region-specific). */
export function pickWebLocale(preferredLang?: string): string {
  const lang = resolvePreferredLanguageTag(preferredLang).toLowerCase();
  if (lang.startsWith('zh')) {
    return lang.includes('tw') || lang.includes('hk') || lang.includes('hant') ? 'zh-TW' : 'zh-CN';
  }
  if (lang.startsWith('ja')) return 'ja-JP';
  if (lang.startsWith('ko')) return 'ko-KR';
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

function isNative(): boolean {
  return !!(globalThis as any).Capacitor?.isNativePlatform?.();
}

function getWebSpeechCtor(): any {
  const g = globalThis as any;
  return g.SpeechRecognition || g.webkitSpeechRecognition || null;
}

function isWebSpeechAvailable(): boolean {
  return !isNative() && !!getWebSpeechCtor();
}

export function isAvailable(): boolean {
  return isNative() || isWebSpeechAvailable();
}

interface NativeSession {
  generation: number;
  recognition: NativeSpeechRecognition;
  text: string | null;
  final: boolean;
  handles: PluginListenerHandle[];
}

let _listening = false;
let _generation = 0;
let _intentSeq = 0;
let _lastStopIntent = 0;
let _pendingStart: { promise: Promise<boolean>; generation: number } | null = null;
let _pendingStop: Promise<void> | null = null;
let _nativeSession: NativeSession | null = null;
let _onResult: ((text: string, isFinal: boolean) => void) | null = null;
let _onLevel: ((level: number) => void) | null = null;
let _onListeningChange: ((listening: boolean) => void) | null = null;
let _onError: ((error: string) => void) | null = null;
let _lastError: string | null = null;

function reportError(error: string): void {
  _lastError = error;
  _onError?.(error);
}

// --- Web Speech API fallback state (desktop browsers) ---
let _webRec: any = null;
let _webStream: MediaStream | null = null;
let _webAudioCtx: AudioContext | null = null;
let _webLevelRAF: number | null = null;

function setListening(next: boolean): void {
  _listening = next;
  _onListeningChange?.(next);
}

function forgetRecognitionCallbacks(): void {
  _onResult = null;
  _onListeningChange = null;
}

async function removeHandle(handle: PluginListenerHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await handle.remove();
  } catch { /* best effort listener cleanup */ }
}

async function cleanupSessionListeners(session: NativeSession | null): Promise<void> {
  if (!session || session.handles.length === 0) return;
  const handles = session.handles.splice(0);
  await Promise.all(handles.map((handle) => removeHandle(handle)));
}

/** Pause app-owned playback before activating a recording audio session. This
 * avoids a simultaneous playback/record route transition; never change the
 * system volume or attempt to control other apps. Resumption is user-owned. */
function pauseBackgroundAudio(): void {
  for (const media of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    try { if (!media.paused) media.pause(); } catch { /* best effort */ }
  }
  try { globalThis.speechSynthesis?.cancel(); } catch { /* unsupported */ }
}

async function attachSessionListeners(
  recognition: NativeSpeechRecognition,
  session: NativeSession,
): Promise<boolean> {
  const { generation } = session;
  let aborted = false;

  const registrations: Array<readonly [any, (data: any) => void]> = [
    ['partialResults', (data: { matches?: string[]; isFinal?: boolean }) => {
      if (_nativeSession !== session || session.final || !data.matches?.length) return;
      const text = data.matches[0];
      const final = data.isFinal === true;
      // Native owns committed + unfixed text and emits a cumulative snapshot,
      // not an append-only delta. Corrections may shorten the unfixed tail.
      // Keep this listener through stop ACK so its final short tail is retained.
      if (typeof text !== 'string' || (!final && session.text === text)) return;
      session.text = text;
      session.final = final;
      _onResult?.(text, final);
    }],
    // Audio level listener (emitted from native at ~15-20fps; ignore after stop advances generation)
    ['audioLevel', (data: any) => {
      if (_nativeSession !== session || generation !== _generation) return;
      _onLevel?.(data.level ?? 0);
    }],
    ['listeningState', (data: { status?: string }) => {
      if (_nativeSession !== session || generation !== _generation) return;
      if (data.status === 'started') {
        setListening(true);
        return;
      }
      // Serialize cleanup with the next start; a late stopped event from this
      // recognizer cannot tear down a new language session.
      void stopListening();
    }],
    ['recognitionError', (data: any) => {
      if (_nativeSession !== session) return;
      const message = typeof data?.message === 'string' && data.message.trim()
        ? data.message.trim()
        : 'Speech recognition error';
      console.warn('[voice] recognitionError:', message);
      reportError(message);
      void stopListening();
    }],
  ];

  try {
    const outcomes = await Promise.all(
      registrations.map(async ([eventName, handler]) => {
        const handle = await recognition.addListener(eventName, handler);
        if (aborted || generation !== _generation || _nativeSession !== session) {
          await removeHandle(handle);
          return false;
        }
        session.handles.push(handle);
        return true;
      }),
    );

    if (outcomes.some((ok) => !ok) || generation !== _generation || _nativeSession !== session) {
      aborted = true;
      await cleanupSessionListeners(session);
      return false;
    }

    return true;
  } catch (err) {
    aborted = true;
    await cleanupSessionListeners(session);
    throw err;
  }
}

async function resolveUsableFallbackRecognizer(
  primary: NativeSpeechRecognition,
): Promise<NativeSpeechRecognition | null> {
  const fallback = getPlatformFallbackSpeechRecognition();
  if (!fallback || fallback === primary || typeof fallback.available !== 'function') return null;
  try {
    const [perms, avail] = await Promise.all([
      typeof fallback.requestPermissions === 'function'
        ? fallback.requestPermissions()
        : Promise.resolve({ speechRecognition: 'granted' }),
      fallback.available(),
    ]);
    if (perms?.speechRecognition !== 'granted') return null;
    return avail?.available ? fallback : null;
  } catch {
    return null;
  }
}

async function startListeningInternal(generation: number): Promise<boolean> {
  const locale = pickLocale();
  const session: NativeSession = {
    generation,
    recognition: getNativeSpeechRecognition(),
    text: null,
    final: false,
    handles: [],
  };
  let recognition = session.recognition;
  _lastError = null;

  const prevSession = _nativeSession;
  if (generation !== _generation) return false;
  if (prevSession) {
    _nativeSession = null;
    await cleanupSessionListeners(prevSession);
    if (generation !== _generation) return false;
  }
  _nativeSession = session;

  try {
    const [perms, available] = await Promise.all([
      recognition.requestPermissions(),
      recognition.available().catch(() => ({ available: false })),
    ]);
    if (generation !== _generation) {
      await cleanupSessionListeners(session);
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }
    if (perms.speechRecognition !== 'granted') {
      console.warn('[voice] microphone permission denied');
      reportError('permission_denied');
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }
    if (!available?.available) {
      const fallback = await resolveUsableFallbackRecognizer(recognition);
      if (generation !== _generation) {
        await cleanupSessionListeners(session);
        if (_nativeSession === session) _nativeSession = null;
        return false;
      }
      if (fallback) {
        console.warn('[voice] custom offline speech unavailable, falling back to platform recognizer');
        recognition = fallback;
        session.recognition = fallback;
      } else {
        console.warn('[voice] speech recognition unavailable');
        reportError('Offline speech model unavailable');
        if (_nativeSession === session) _nativeSession = null;
        return false;
      }
    }

    const attached = await attachSessionListeners(recognition, session);
    if (!attached || generation !== _generation || _nativeSession !== session) {
      await cleanupSessionListeners(session);
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }

    pauseBackgroundAudio();
    try {
      await recognition.start({
        language: locale,
        partialResults: true,
        popup: false,
        addPunctuation: true,
      });
    } catch (startErr) {
      if (generation !== _generation) throw startErr;
      const startMsg = startErr instanceof Error ? startErr.message : String(startErr ?? '');
      if (!/permission|denied|not allowed/i.test(startMsg)) {
        const fallback = await resolveUsableFallbackRecognizer(recognition);
        if (fallback && generation === _generation) {
          console.warn('[voice] custom offline speech start failed, falling back to platform recognizer:', startMsg);
          await cleanupSessionListeners(session);
          recognition = fallback;
          session.recognition = fallback;
          const fallbackAttached = await attachSessionListeners(recognition, session);
          if (!fallbackAttached || generation !== _generation || _nativeSession !== session) {
            await cleanupSessionListeners(session);
            if (_nativeSession === session) _nativeSession = null;
            return false;
          }
          await recognition.start({
            language: locale,
            partialResults: true,
            popup: false,
            addPunctuation: true,
          });
        } else {
          throw startErr;
        }
      } else {
        throw startErr;
      }
    }

    if (generation !== _generation) {
      // Only stop native capture if no newer session has claimed _nativeSession;
      // stopping the shared plugin while a newer session owns it would kill the new session.
      if (!_nativeSession || _nativeSession === session) {
        try {
          await recognition.stop();
        } catch { /* stale start cleanup */ }
      }
      await cleanupSessionListeners(session);
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }

    setListening(true);
    return true;
  } catch (err) {
    console.warn('[voice] start failed:', err);
    if (generation === _generation) {
      const msg = err instanceof Error ? err.message : String(err ?? 'Failed to start speech recognition');
      reportError(/permission|denied|not allowed/i.test(msg) ? 'permission_denied' : msg);
      setListening(false);
    }
    await cleanupSessionListeners(session);
    if (_nativeSession === session) _nativeSession = null;
    return false;
  }
}

// --- Web Speech API fallback (desktop browsers) ---

function stopWebLevelMeter(): void {
  if (_webLevelRAF != null) {
    cancelAnimationFrame(_webLevelRAF);
    _webLevelRAF = null;
  }
  if (_webStream) {
    _webStream.getTracks().forEach((t) => t.stop());
    _webStream = null;
  }
  if (_webAudioCtx) {
    try { void _webAudioCtx.close(); } catch { /* already closed */ }
    _webAudioCtx = null;
  }
}

/** Best-effort waveform levels via Web Audio. Failure must not break recognition. */
async function startWebLevelMeter(generation: number): Promise<void> {
  // Transcript ownership intentionally survives Stop until final/onend, but
  // microphone/RAF ownership ends immediately when capture stops.
  const isCapturing = (): boolean => generation === _generation && _listening;
  try {
    if (!isCapturing() || !navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!isCapturing()) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    _webStream = stream;
    const AC = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC();
    _webAudioCtx = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = (): void => {
      if (!isCapturing()) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      _onLevel?.(Math.min(1, rms * 3));
      if (isCapturing()) _webLevelRAF = requestAnimationFrame(tick);
    };
    _webLevelRAF = requestAnimationFrame(tick);
  } catch { /* no level meter; recognition still works */ }
}

function startWebListening(): boolean {
  const Ctor = getWebSpeechCtor();
  if (!Ctor) {
    reportError('Speech recognition is not available');
    return false;
  }
  _lastError = null;

  // Tear down any prior instance so a fresh start never hits InvalidStateError.
  if (_webRec) {
    try {
      _webRec.onend = null;
      _webRec.onresult = null;
      _webRec.onerror = null;
      _webRec.abort();
    } catch { /* best effort */ }
    _webRec = null;
  }
  stopWebLevelMeter();

  const generation = ++_generation;
  try {
    const rec = new Ctor();
    rec.lang = pickWebLocale();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event: any): void => {
      if (generation !== _generation) return;
      let txt = '';
      for (let i = 0; i < event.results.length; i++) {
        txt += event.results[i][0]?.transcript ?? '';
      }
      const last = event.results[event.results.length - 1];
      _onResult?.(txt.trim(), !!last?.isFinal);
    };
    rec.onerror = (e: any): void => {
      // 'no-speech' / 'aborted' are routine; only surface real failures.
      if (e?.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[voice] web speech error:', e.error);
        if (generation === _generation) {
          const errStr = String(e.error);
          reportError(/not-allowed|service-not-allowed|permission/i.test(errStr) ? 'permission_denied' : errStr);
          void stopListening();
        }
      }
    };
    rec.onend = (): void => {
      if (generation !== _generation) return;
      // Browser auto-ends on silence; reflect not-listening so the UI updates.
      setListening(false);
      stopWebLevelMeter();
    };
    _webRec = rec;
    pauseBackgroundAudio();
    rec.start();
    setListening(true);
    void startWebLevelMeter(generation);
    return true;
  } catch (err) {
    console.warn('[voice] web start failed:', err);
    const msg = err instanceof Error ? err.message : String(err ?? 'Failed to start web speech');
    reportError(/permission|denied|not-allowed/i.test(msg) ? 'permission_denied' : msg);
    setListening(false);
    return false;
  }
}

/** Stop-only deadline: browser engines may omit onend on device failure.
 * Never applied to an active recording and never used as a 60s duration cap. */
const WEB_FINAL_DRAIN_MS = 2000;
/** Stop-only deadline for native offline drain so Pause->Mic / Send never wedge forever. */
export const NATIVE_FINAL_DRAIN_MS = 4000;
function stopWebListening(): Promise<void> {
  setListening(false);
  stopWebLevelMeter();
  const rec = _webRec;
  if (!rec) { _generation++; return Promise.resolve(); }
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopWebLevelMeter();
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      if (_webRec === rec) _webRec = null;
      _generation++;
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn('[voice] web final drain timed out');
      reportError('Speech final drain timed out');
      finish();
      try { rec.abort?.(); } catch { /* already ended */ }
    }, WEB_FINAL_DRAIN_MS);
    // Keep onresult and its generation alive until onend: stop() asks the
    // browser for the remaining final hypothesis, abort() would discard it.
    rec.onend = finish;
    try { rec.stop(); } catch {
      finish();
      try { rec.abort?.(); } catch { /* already ended */ }
    }
  });
}

export async function startListening(
  onResult: (text: string, isFinal: boolean) => void,
  onListeningChange?: (listening: boolean) => void,
  onError?: (error: string) => void,
): Promise<boolean> {
  if (!isAvailable()) {
    const msg = 'Speech recognition is not available';
    _lastError = msg;
    (onError ?? _onError)?.(msg);
    return false;
  }

  const startIntent = ++_intentSeq;

  if (!isNative()) {
    if (_pendingStop) {
      await _pendingStop;
      if (startIntent < _lastStopIntent) return false;
    }
    _onResult = onResult;
    _onListeningChange = onListeningChange ?? null;
    if (onError !== undefined) {
      _onError = onError ?? null;
    }
    if (_listening) {
      setListening(true);
      return true;
    }
    return startWebListening();
  }

  if (_pendingStop) {
    await _pendingStop;
    if (startIntent < _lastStopIntent) return false;
  }

  _onResult = onResult;
  _onListeningChange = onListeningChange ?? null;
  if (onError !== undefined) {
    _onError = onError ?? null;
  }

  if (_listening) {
    setListening(true);
    return true;
  }

  if (_pendingStart && _pendingStart.generation === _generation) {
    return _pendingStart.promise;
  }

  const generation = ++_generation;
  const startPromise = startListeningInternal(generation);
  const entry = { promise: startPromise, generation };
  _pendingStart = entry;
  try {
    return await startPromise;
  } finally {
    if (_pendingStart === entry) {
      _pendingStart = null;
    }
  }
}

export async function stopListening(): Promise<void> {
  _lastStopIntent = ++_intentSeq;
  if (!isAvailable()) return;

  if (!isNative()) {
    if (_pendingStop) return _pendingStop;
    const stopping = stopWebListening().then(() => { forgetRecognitionCallbacks(); });
    _pendingStop = stopping;
    try { await stopping; }
    finally { if (_pendingStop === stopping) _pendingStop = null; }
    return;
  }

  if (_pendingStop) {
    _generation++;
    _pendingStart = null;
    return _pendingStop;
  }
  const startPromise = _pendingStart?.promise ?? null;
  _pendingStart = null;
  const session = _nativeSession;
  const shouldStopNative = _listening || !!startPromise;
  _generation++;
  setListening(false);

  if (!shouldStopNative) {
    await cleanupSessionListeners(session);
    if (_nativeSession === session) _nativeSession = null;
    forgetRecognitionCallbacks();
    return;
  }

  let stopPromise!: Promise<void>;
  stopPromise = (async () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopFailure: string | null = null;
    let timedOut = false;
    try {
      const drain = (async () => {
        try {
          await session?.recognition.stop();
        } catch (err) {
          console.warn('[voice] stop failed:', err);
          const msg = err instanceof Error && err.message.trim() ? err.message.trim() : String(err ?? '');
          stopFailure = msg || 'Speech recognition stop failed';
        }

        try {
          await startPromise;
        } catch { /* start failure already handled */ }
      })();

      timedOut = await Promise.race([
        drain.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), NATIVE_FINAL_DRAIN_MS);
        }),
      ]);
      if (timedOut) {
        console.warn('[voice] native final drain timed out');
        reportError('Speech final drain timed out');
      } else if (stopFailure) {
        reportError(stopFailure);
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    await cleanupSessionListeners(session);
    if (_nativeSession === session) _nativeSession = null;
    if (_pendingStop === stopPromise) {
      forgetRecognitionCallbacks();
      setListening(false);
    }
  })();

  _pendingStop = stopPromise;
  try {
    await stopPromise;
  } finally {
    if (_pendingStop === stopPromise) {
      _pendingStop = null;
    }
  }
}

/** Register a callback for real-time audio level (0..1). Call before startListening. */
export function onAudioLevel(cb: ((level: number) => void) | null): void {
  _onLevel = cb;
}

/** Register a callback for recognition / permission / startup errors. */
export function onRecognitionError(cb: ((error: string) => void) | null): void {
  _onError = cb;
}

export function getLastError(): string | null {
  return _lastError;
}

export function isListening(): boolean {
  return _listening;
}
