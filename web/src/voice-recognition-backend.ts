import { registerPlugin } from '@capacitor/core';
import { STREAMING_SPEECH_PLUGIN_NAME } from '@shared/voice-recognition.js';
import { SpeechRecognition, type SpeechRecognitionPlugin } from '@capgo/capacitor-speech-recognition';

export type NativeSpeechRecognition = Pick<SpeechRecognitionPlugin, 'available' | 'requestPermissions' | 'start' | 'stop' | 'addListener'>;
const StreamingSpeech = registerPlugin<NativeSpeechRecognition>(STREAMING_SPEECH_PLUGIN_NAME);
/** New shells use multilingual Qwen3-ASR for every locale, without cloud/system ASR.
 * Only an old shell without the plugin retains its platform recognizer. */
export function getNativeSpeechRecognition(): NativeSpeechRecognition {
  const capacitor = (globalThis as any).Capacitor;
  return capacitor?.isPluginAvailable?.(STREAMING_SPEECH_PLUGIN_NAME) ? StreamingSpeech : SpeechRecognition;
}
