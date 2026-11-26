/** Native Capacitor registration name; Android/iOS bindings are contract-tested. */
export const STREAMING_SPEECH_PLUGIN_NAME = 'StreamingSpeech';
export const STREAMING_SPEECH_TTS_STATE_EVENT = 'ttsState';
export const STREAMING_SPEECH_RAW_PCM_EVENT = 'rawPcmChunk' as const;
export interface StreamingSpeechRawPcmEvent {
  /** Base64-encoded little-endian 16-bit signed mono PCM at 16kHz. */
  pcmBase64: string;
  /** Normalized RMS input level in [0, 1]. */
  level: number;
}
export const STREAMING_SPEECH_TTS_STATUS = {
  STARTED: 'started',
  STOPPED: 'stopped',
  ERROR: 'error',
} as const;
export type StreamingSpeechTtsStatus = typeof STREAMING_SPEECH_TTS_STATUS[keyof typeof STREAMING_SPEECH_TTS_STATUS];
export const STREAMING_SPEECH_TTS_VOICE_QUALITY = {
  PREMIUM: 'premium',
  ENHANCED: 'enhanced',
  DEFAULT: 'default',
  UNAVAILABLE: 'unavailable',
} as const;
export type StreamingSpeechTtsVoiceQuality =
  typeof STREAMING_SPEECH_TTS_VOICE_QUALITY[keyof typeof STREAMING_SPEECH_TTS_VOICE_QUALITY];

export const STREAMING_SPEECH_OFFLINE_MODEL_EVENT = 'offlineModelStatus' as const;

export type OfflineSpeechModelLifecycle = 'idle' | 'downloading' | 'ready' | 'failed';
export type OfflineSpeechNetworkType = 'wifi' | 'cellular' | 'offline' | 'unknown';

export interface OfflineSpeechModelStatus {
  status: OfflineSpeechModelLifecycle;
  /** Normalized download/verification progress in [0, 1]. */
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  allowCellular: boolean;
  networkType: OfflineSpeechNetworkType;
  requiresCellularConfirmation?: boolean;
  error?: string | null;
  supported: boolean;
  bundled?: boolean;
}

export interface OfflineSpeechModelDownloadResult {
  started: boolean;
  requiresCellularConfirmation?: boolean;
  status: OfflineSpeechModelStatus;
}
