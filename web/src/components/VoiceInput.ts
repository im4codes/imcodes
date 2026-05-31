/**
 * VoiceInput — Capacitor speech recognition wrapper.
 * Picks a mixed-language locale and streams partial results.
 * Only activates on native (Capacitor).
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';
import type { PluginListenerHandle } from '@capacitor/core';

export function pickLocale(): string {
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('zh')) return 'zh-Hans';
  if (lang.startsWith('ja')) return 'ja-JP';
  if (lang.startsWith('ko')) return 'ko-KR';
  if (lang.startsWith('es')) return 'es-ES';
  if (lang.startsWith('ru')) return 'ru-RU';
  return 'en-US';
}

export function isAvailable(): boolean {
  return !!(globalThis as any).Capacitor?.isNativePlatform?.();
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

export async function startListening(
  onResult: (text: string, isFinal: boolean) => void,
  onListeningChange?: (listening: boolean) => void,
): Promise<boolean> {
  if (!isAvailable()) return false;

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
