/**
 * VoiceInput — Capacitor speech recognition wrapper.
 * Picks a mixed-language locale and streams partial results.
 * Only activates on native (Capacitor).
 */
import { SpeechRecognition } from '@capgo/capacitor-speech-recognition';

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
let _removePartial: (() => void) | null = null;
let _removeLevel: (() => void) | null = null;
let _onLevel: ((level: number) => void) | null = null;

export async function startListening(onResult: (text: string, isFinal: boolean) => void): Promise<boolean> {
  if (!isAvailable() || _listening) return false;

  try {
    const perms = await SpeechRecognition.requestPermissions();
    if (perms.speechRecognition !== 'granted') return false;

    const available = await SpeechRecognition.available();
    if (!available.available) return false;

    const locale = pickLocale();

    // Partial results listener
    const h1 = await SpeechRecognition.addListener('partialResults', (data) => {
      if (data.matches?.length) {
        onResult(data.matches[0], false);
      }
    });
    _removePartial = () => h1.remove();

    // Audio level listener (emitted from native at ~15fps)
    const h2 = await SpeechRecognition.addListener('audioLevel' as any, (data: any) => {
      _onLevel?.(data.level ?? 0);
    });
    _removeLevel = () => h2.remove();

    await SpeechRecognition.start({
      language: locale,
      partialResults: true,
      popup: false,
      addPunctuation: true,
    });

    _listening = true;
    return true;
  } catch (err) {
    console.warn('[voice] start failed:', err);
    return false;
  }
}

export async function stopListening(): Promise<void> {
  if (!_listening) return;
  _listening = false;

  try {
    await SpeechRecognition.stop();
  } catch (err) {
    console.warn('[voice] stop failed:', err);
  } finally {
    _removePartial?.();
    _removePartial = null;
    _removeLevel?.();
    _removeLevel = null;
    _onLevel = null;
  }
}

/** Register a callback for real-time audio level (0..1). Call before startListening. */
export function onAudioLevel(cb: ((level: number) => void) | null): void {
  _onLevel = cb;
}

export function isListening(): boolean {
  return _listening;
}
