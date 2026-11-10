import { registerPlugin } from '@capacitor/core';
import { SpeechRecognition, type SpeechRecognitionPlugin } from '@capgo/capacitor-speech-recognition';

// Old installed shells do not have this native plugin. Keep their existing
// platform recognizer; new Android/iOS binaries use the shared offline bridge.
type NativeSpeechRecognition = Pick<SpeechRecognitionPlugin, 'available' | 'requestPermissions' | 'start' | 'stop' | 'addListener'>;
const StreamingSpeech = registerPlugin<NativeSpeechRecognition>('StreamingSpeech');
export function getNativeSpeechRecognition(): NativeSpeechRecognition {
  const capacitor = (globalThis as any).Capacitor;
  const language = navigator.language.toLowerCase().split('-')[0];
  const bilingual = language === 'zh' || language === 'en';
  return bilingual && capacitor?.isPluginAvailable?.('StreamingSpeech') ? StreamingSpeech : SpeechRecognition;
}
