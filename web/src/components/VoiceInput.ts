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
import { getNativeSpeechRecognition, type NativeSpeechRecognition } from '../voice-recognition-backend.js';
import type { PluginListenerHandle } from '@capacitor/core';

/** Native (Capacitor) speech-recognition locale tags. */
export function pickLocale(): string {
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('zh')) return 'zh-Hans';
  if (lang.startsWith('ja')) return 'ja-JP';
  if (lang.startsWith('ko')) return 'ko-KR';
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

/** Web Speech API locale tags (BCP-47, region-specific). */
export function pickWebLocale(): string {
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('zh')) return lang.includes('tw') || lang.includes('hk') ? 'zh-TW' : 'zh-CN';
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

let _listening = false;
let _generation = 0;
let _pendingStart: Promise<boolean> | null = null;
let _pendingStop: Promise<void> | null = null;
let _nativeSession: { recognition: NativeSpeechRecognition } | null = null;
let _removePartial: (() => void | Promise<void>) | null = null;
let _removeLevel: (() => void | Promise<void>) | null = null;
let _removeListeningState: (() => void | Promise<void>) | null = null;
let _removeRecognitionError: (() => void | Promise<void>) | null = null;
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

async function removeRecognitionListeners(): Promise<void> {
  const removePartial = _removePartial;
  const removeLevel = _removeLevel;
  const removeListeningState = _removeListeningState;
  const removeRecognitionError = _removeRecognitionError;
  _removePartial = null;
  _removeLevel = null;
  _removeListeningState = null;
  _removeRecognitionError = null;
  await Promise.all([
    Promise.resolve().then(() => removePartial?.()).catch(() => undefined),
    Promise.resolve().then(() => removeLevel?.()).catch(() => undefined),
    Promise.resolve().then(() => removeListeningState?.()).catch(() => undefined),
    Promise.resolve().then(() => removeRecognitionError?.()).catch(() => undefined),
  ]);
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

async function startListeningInternal(generation: number): Promise<boolean> {
  const locale = pickLocale();
  const session = { recognition: getNativeSpeechRecognition(), text: null as string | null, final: false };
  const recognition = session.recognition;
  _lastError = null;
  await removeRecognitionListeners();
  if (generation !== _generation) return false;
  _nativeSession = session;

  try {
    const perms = await recognition.requestPermissions();
    if (perms.speechRecognition !== 'granted') {
      console.warn('[voice] microphone permission denied');
      if (generation === _generation) reportError('permission_denied');
      return false;
    }
    if (generation !== _generation) return false;

    const available = await recognition.available();
    if (!available.available) {
      console.warn('[voice] speech recognition unavailable');
      if (generation === _generation) reportError('Offline speech model unavailable');
      return false;
    }
    if (generation !== _generation) return false;

    // Partial results listener
    const h1 = await recognition.addListener('partialResults', (data) => {
      if (_nativeSession !== session || session.final || !data.matches?.length) return;
      const text = data.matches[0];
      const final = (data as { isFinal?: boolean }).isFinal === true;
      // Native owns committed + unfixed text and emits a cumulative snapshot,
      // not an append-only delta. Corrections may shorten the unfixed tail.
      // Keep this listener through stop ACK so its final short tail is retained.
      if (typeof text !== 'string' || (!final && session.text === text)) return;
      session.text = text;
      session.final = final;
      _onResult?.(text, final);
    });
    _removePartial = () => removeHandle(h1);

    // Audio level listener (emitted from native at ~15fps)
    const h2 = await recognition.addListener('audioLevel' as any, (data: any) => {
      if (_nativeSession !== session) return;
      _onLevel?.(data.level ?? 0);
    });
    _removeLevel = () => removeHandle(h2);

    const h3 = await recognition.addListener('listeningState', (data) => {
      if (_nativeSession !== session || generation !== _generation) return;
      if (data.status === 'started') {
        setListening(true);
        return;
      }
      // Serialize cleanup with the next start; a late stopped event from this
      // recognizer cannot tear down a new language session.
      void stopListening();
    });
    _removeListeningState = () => removeHandle(h3);

    const h4 = await recognition.addListener('recognitionError' as any, (data: any) => {
      if (_nativeSession !== session) return;
      const message = typeof data?.message === 'string' && data.message.trim()
        ? data.message.trim()
        : 'Speech recognition error';
      console.warn('[voice] recognitionError:', message);
      reportError(message);
    });
    _removeRecognitionError = () => removeHandle(h4);

    if (generation !== _generation) {
      await removeRecognitionListeners();
      if (_nativeSession === session) _nativeSession = null;
      return false;
    }
    pauseBackgroundAudio();
    await recognition.start({
      language: locale,
      partialResults: true,
      popup: false,
      addPunctuation: true,
    });

    if (generation !== _generation) {
      try {
        await recognition.stop();
      } catch { /* stale start cleanup */ }
      await removeRecognitionListeners();
      if (_nativeSession === session) _nativeSession = null;
      setListening(false);
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
    await removeRecognitionListeners();
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
  if (onError !== undefined) {
    _onError = onError ?? null;
  }
  if (!isAvailable()) {
    reportError('Speech recognition is not available');
    return false;
  }

  if (!isNative()) {
    if (_pendingStop) await _pendingStop;
    _onResult = onResult;
    _onListeningChange = onListeningChange ?? null;
    if (_listening) {
      setListening(true);
      return true;
    }
    return startWebListening();
  }

  if (_pendingStop) {
    await _pendingStop;
  }

  _onResult = onResult;
  _onListeningChange = onListeningChange ?? null;

  if (_listening) {
    setListening(true);
    return true;
  }

  if (_pendingStart) return _pendingStart;

  const generation = ++_generation;
  const startPromise = startListeningInternal(generation);
  _pendingStart = startPromise;
  try {
    return await startPromise;
  } finally {
    if (_pendingStart === startPromise) {
      _pendingStart = null;
    }
  }
}

export async function stopListening(): Promise<void> {
  if (!isAvailable()) return;

  if (!isNative()) {
    if (_pendingStop) return _pendingStop;
    const stopping = stopWebListening().then(() => { forgetRecognitionCallbacks(); });
    _pendingStop = stopping;
    try { await stopping; }
    finally { if (_pendingStop === stopping) _pendingStop = null; }
    return;
  }

  if (_pendingStop) return _pendingStop;
  const startPromise = _pendingStart;
  const session = _nativeSession;
  const shouldStopNative = _listening || !!startPromise;
  _generation++;
  setListening(false);

  if (!shouldStopNative) {
    await removeRecognitionListeners();
    if (_nativeSession === session) _nativeSession = null;
    forgetRecognitionCallbacks();
    return;
  }

  const stopPromise = (async () => {
    try {
      await session?.recognition.stop();
    } catch (err) {
      console.warn('[voice] stop failed:', err);
    }

    try {
      await startPromise;
    } catch { /* start failure already logged */ }

    await removeRecognitionListeners();
    if (_nativeSession === session) _nativeSession = null;
    forgetRecognitionCallbacks();
    setListening(false);
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
