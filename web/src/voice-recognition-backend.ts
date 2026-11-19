import { registerPlugin } from '@capacitor/core';
import {
  STREAMING_SPEECH_PLUGIN_NAME,
  STREAMING_SPEECH_TTS_STATE_EVENT,
  type StreamingSpeechTtsStatus,
  type StreamingSpeechTtsVoiceQuality,
} from '@shared/voice-recognition.js';
import { SpeechRecognition, type SpeechRecognitionPlugin } from '@capgo/capacitor-speech-recognition';

export interface NativeTtsSpeakOptions {
  text: string;
  lang?: string;
  rate?: number;
}

export interface NativeTtsStateEvent {
  status: StreamingSpeechTtsStatus;
  message?: string;
}

export interface NativeTtsVoiceQualityInfo {
  quality: StreamingSpeechTtsVoiceQuality;
  language?: string;
}

export interface NativeSystemTts {
  speak: (options: NativeTtsSpeakOptions) => Promise<void>;
  stopSpeaking: () => Promise<void>;
  isSpeaking?: () => Promise<{ speaking: boolean }>;
  getTtsVoiceQuality?: (options?: { lang?: string }) => Promise<NativeTtsVoiceQualityInfo>;
  addListener?: (
    eventName: typeof STREAMING_SPEECH_TTS_STATE_EVENT,
    listenerFunc: (event: NativeTtsStateEvent) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

export type NativeSpeechRecognition = Pick<SpeechRecognitionPlugin, 'available' | 'requestPermissions' | 'start' | 'stop' | 'addListener'> & {
  prewarm?: () => Promise<void>;
  performHaptic?: () => Promise<void>;
  speak?: (options: NativeTtsSpeakOptions) => Promise<void>;
  stopSpeaking?: () => Promise<void>;
  isSpeaking?: () => Promise<{ speaking: boolean }>;
  getTtsVoiceQuality?: (options?: { lang?: string }) => Promise<NativeTtsVoiceQualityInfo>;
};

export type VoiceRecognitionEngine = 'builtin' | 'system';
export const VOICE_ENGINE_STORAGE_KEY = 'imcodes_voice_engine';

const StreamingSpeech = registerPlugin<NativeSpeechRecognition>(STREAMING_SPEECH_PLUGIN_NAME);

export function isStreamingSpeechAvailable(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isPluginAvailable?: (name: string) => boolean } }).Capacitor;
  return capacitor?.isPluginAvailable?.(STREAMING_SPEECH_PLUGIN_NAME) === true;
}

export function isIosNativePlatform(): boolean {
  const capacitor = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return capacitor?.getPlatform?.() === 'ios';
}

/** Read the persisted native speech engine preference ('builtin' by default, or 'system'). */
export function getVoiceRecognitionEngine(): VoiceRecognitionEngine {
  try {
    const saved = globalThis.localStorage?.getItem(VOICE_ENGINE_STORAGE_KEY);
    return saved === 'system' ? 'system' : 'builtin';
  } catch {
    return 'builtin';
  }
}

/** Persist the native speech engine preference ('builtin' or 'system'). */
export function setVoiceRecognitionEngine(engine: VoiceRecognitionEngine): void {
  try {
    globalThis.localStorage?.setItem(VOICE_ENGINE_STORAGE_KEY, engine);
  } catch { /* localStorage may be unavailable in restricted contexts */ }
}

/** New shells use multilingual Qwen3-ASR by default unless the user selects system speech recognition.
 * Old shells without the plugin retain their platform recognizer. */
export function getNativeSpeechRecognition(): NativeSpeechRecognition {
  if (!isStreamingSpeechAvailable()) return SpeechRecognition;
  return getVoiceRecognitionEngine() === 'system' ? SpeechRecognition : StreamingSpeech;
}

/** Platform recognizer used as fallback when builtin StreamingSpeech is unavailable or fails to start. */
export function getPlatformFallbackSpeechRecognition(): NativeSpeechRecognition | null {
  return SpeechRecognition ?? null;
}

/** Native system TTS bridge exposed by the updated StreamingSpeech plugin. */
export function getNativeSystemTts(): NativeSystemTts | null {
  if (!isStreamingSpeechAvailable()) return null;
  const candidate = StreamingSpeech as unknown as Partial<NativeSystemTts>;
  if (typeof candidate.speak !== 'function' || typeof candidate.stopSpeaking !== 'function') {
    return null;
  }
  return candidate as NativeSystemTts;
}
