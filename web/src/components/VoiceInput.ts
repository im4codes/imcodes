/**
 * VoiceInput — speech recognition wrapper.
 * On native (Capacitor) it uses the platform's SFSpeechRecognizer via the
 * @capgo plugin. On desktop browsers (Chrome / Edge / Safari) it falls back to
 * the Web Speech API (window.SpeechRecognition / webkitSpeechRecognition).
 * Firefox has no Web Speech API, so the button is hidden there.
 * Both paths share the same callback contract: onResult receives the FULL
 * cumulative transcript of the current session each time (the overlay replaces
 * the prior voice segment with it), plus an isFinal flag.
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';
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
let _removePartial: (() => void | Promise<void>) | null = null;
let _removeLevel: (() => void | Promise<void>) | null = null;
let _removeListeningState: (() => void | Promise<void>) | null = null;
let _onResult: ((text: string, isFinal: boolean) => void) | null = null;
let _onLevel: ((level: number) => void) | null = null;
let _onListeningChange: ((listening: boolean) => void) | null = null;

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
  _removePartial = null;
  _removeLevel = null;
  _removeListeningState = null;
  await Promise.all([
    Promise.resolve().then(() => removePartial?.()).catch(() => undefined),
    Promise.resolve().then(() => removeLevel?.()).catch(() => undefined),
    Promise.resolve().then(() => removeListeningState?.()).catch(() => undefined),
  ]);
}

async function startListeningInternal(generation: number): Promise<boolean> {
  await removeRecognitionListeners();
  if (generation !== _generation) return false;

  try {
    const perms = await SpeechRecognition.requestPermissions();
    if (perms.speechRecognition !== 'granted') return false;
    if (generation !== _generation) return false;

    const available = await SpeechRecognition.available();
    if (!available.available) return false;
    if (generation !== _generation) return false;

    const locale = pickLocale();

    // Partial results listener
    const h1 = await SpeechRecognition.addListener('partialResults', (data) => {
      if (data.matches?.length) {
        _onResult?.(data.matches[0], false);
      }
    });
    _removePartial = () => removeHandle(h1);

    // Audio level listener (emitted from native at ~15fps)
    const h2 = await SpeechRecognition.addListener('audioLevel' as any, (data: any) => {
      _onLevel?.(data.level ?? 0);
    });
    _removeLevel = () => removeHandle(h2);

    const h3 = await SpeechRecognition.addListener('listeningState', (data) => {
      if (data.status === 'started') {
        setListening(true);
        return;
      }
      _generation++;
      setListening(false);
      void removeRecognitionListeners().then(forgetRecognitionCallbacks);
    });
    _removeListeningState = () => removeHandle(h3);

    await SpeechRecognition.start({
      language: locale,
      partialResults: true,
      popup: false,
      addPunctuation: true,
    });

    if (generation !== _generation) {
      try {
        await SpeechRecognition.stop();
      } catch { /* stale start cleanup */ }
      await removeRecognitionListeners();
      setListening(false);
      return false;
    }

    setListening(true);
    return true;
  } catch (err) {
    console.warn('[voice] start failed:', err);
    if (generation === _generation) setListening(false);
    await removeRecognitionListeners();
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
  try {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== _generation) {
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
      if (generation !== _generation) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      _onLevel?.(Math.min(1, rms * 3));
      _webLevelRAF = requestAnimationFrame(tick);
    };
    _webLevelRAF = requestAnimationFrame(tick);
  } catch { /* no level meter; recognition still works */ }
}

function startWebListening(): boolean {
  const Ctor = getWebSpeechCtor();
  if (!Ctor) return false;

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
      }
    };
    rec.onend = (): void => {
      if (generation !== _generation) return;
      // Browser auto-ends on silence; reflect not-listening so the UI updates.
      setListening(false);
      stopWebLevelMeter();
    };
    _webRec = rec;
    rec.start();
    setListening(true);
    void startWebLevelMeter(generation);
    return true;
  } catch (err) {
    console.warn('[voice] web start failed:', err);
    setListening(false);
    return false;
  }
}

function stopWebListening(): void {
  _generation++;
  setListening(false);
  stopWebLevelMeter();
  const rec = _webRec;
  _webRec = null;
  if (rec) {
    try {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.stop();
      rec.abort?.();
    } catch { /* best effort */ }
  }
}

export async function startListening(
  onResult: (text: string, isFinal: boolean) => void,
  onListeningChange?: (listening: boolean) => void,
): Promise<boolean> {
  if (!isAvailable()) return false;

  if (!isNative()) {
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
    stopWebListening();
    forgetRecognitionCallbacks();
    return;
  }

  const startPromise = _pendingStart;
  const shouldStopNative = _listening || !!startPromise;
  _generation++;
  setListening(false);

  if (!shouldStopNative) {
    await removeRecognitionListeners();
    forgetRecognitionCallbacks();
    return;
  }

  const stopPromise = (async () => {
    try {
      await SpeechRecognition.stop();
    } catch (err) {
      console.warn('[voice] stop failed:', err);
    }

    try {
      await startPromise;
    } catch { /* start failure already logged */ }

    await removeRecognitionListeners();
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

export function isListening(): boolean {
  return _listening;
}
