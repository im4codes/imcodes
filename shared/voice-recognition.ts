/** Native Capacitor registration name; Android/iOS bindings are contract-tested. */
export const STREAMING_SPEECH_PLUGIN_NAME = 'StreamingSpeech';
export const STREAMING_SPEECH_TTS_STATE_EVENT = 'ttsState';
export const STREAMING_SPEECH_TTS_STATUS = {
  STARTED: 'started',
  STOPPED: 'stopped',
  ERROR: 'error',
} as const;
export type StreamingSpeechTtsStatus = typeof STREAMING_SPEECH_TTS_STATUS[keyof typeof STREAMING_SPEECH_TTS_STATUS];
