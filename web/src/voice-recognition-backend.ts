import { registerPlugin } from '@capacitor/core';
import { REMOTE_VOICE_ALLOWED_ERROR_CODES } from '@shared/remote-voice.js';
import {
  STREAMING_SPEECH_OFFLINE_MODEL_EVENT,
  STREAMING_SPEECH_PLUGIN_NAME,
  STREAMING_SPEECH_RAW_PCM_EVENT,
  STREAMING_SPEECH_TTS_STATE_EVENT,
  type OfflineSpeechModelDownloadResult,
  type OfflineSpeechModelStatus,
  type StreamingSpeechRawPcmEvent,
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
  voiceName?: string;
  voiceIdentifier?: string;
}

export function isSiriNativeVoiceIdentifier(identifier?: string | null): boolean {
  const lower = identifier?.trim().toLowerCase() ?? '';
  if (!lower) return false;
  return lower.includes('.siri') || lower.includes('ttsbundle.siri');
}

export function isHighQualityNativeTtsVoice(info?: NativeTtsVoiceQualityInfo | null): boolean {
  if (!info) return false;
  if (info.quality === 'premium' || info.quality === 'enhanced') return true;
  return isSiriNativeVoiceIdentifier(info.voiceIdentifier);
}

export function getNativeTtsVoiceQualityLabelKey(info?: NativeTtsVoiceQualityInfo | null): string {
  if (!info) return '';
  if (info.quality === 'premium') return 'settings.tts_quality_premium';
  if (info.quality === 'enhanced') return 'settings.tts_quality_enhanced';
  if (isSiriNativeVoiceIdentifier(info.voiceIdentifier)) return 'settings.tts_quality_siri';
  if (info.quality === 'default') return 'settings.tts_quality_default';
  return '';
}

export interface NativeSystemTts {
  speak: (options: NativeTtsSpeakOptions) => Promise<void>;
  stopSpeaking: () => Promise<void>;
  isSpeaking?: () => Promise<{ speaking: boolean }>;
  getTtsVoiceQuality?: (options?: { lang?: string }) => Promise<NativeTtsVoiceQualityInfo>;
  openTtsSettings?: () => Promise<{ opened?: boolean } | void>;
  addListener?: (
    eventName: typeof STREAMING_SPEECH_TTS_STATE_EVENT,
    listenerFunc: (event: NativeTtsStateEvent) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

export type NativePermissionStatus = {
  speechRecognition?: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
};

export interface NativeRawPcmCapture {
  checkPermissions?: () => Promise<NativePermissionStatus>;
  requestPermissions?: () => Promise<NativePermissionStatus>;
  startRawPcmCapture: () => Promise<void>;
  stopRawPcmCapture: () => Promise<void>;
  addListener: (
    eventName: typeof STREAMING_SPEECH_RAW_PCM_EVENT,
    listenerFunc: (event: StreamingSpeechRawPcmEvent) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

export interface NativeOfflineSpeechModelManager {
  getOfflineModelStatus: () => Promise<OfflineSpeechModelStatus>;
  downloadOfflineModel: (options?: { allowCellular?: boolean }) => Promise<OfflineSpeechModelDownloadResult>;
  cancelOfflineModelDownload: () => Promise<{ cancelled: boolean; status: OfflineSpeechModelStatus }>;
  deleteOfflineModel: () => Promise<{ deleted: boolean; status: OfflineSpeechModelStatus }>;
  addListener: (
    eventName: typeof STREAMING_SPEECH_OFFLINE_MODEL_EVENT,
    listenerFunc: (event: OfflineSpeechModelStatus) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

export type HapticFeedbackStyle = 'light' | 'medium' | 'selection' | 'success' | 'warning';

export type NativeSpeechRecognition = Omit<
  Pick<SpeechRecognitionPlugin, 'available' | 'checkPermissions' | 'requestPermissions' | 'start' | 'stop' | 'addListener'>,
  'start'
> & {
  start: (options?: {
    language?: string;
    maxResults?: number;
    prompt?: string;
    partialResults?: boolean;
    popup?: boolean;
    addPunctuation?: boolean;
    initialPcmBase64?: string;
  }) => Promise<{ matches?: string[] } | void>;
  transcribePcm?: (options: { pcmBase64: string; language?: string }) => Promise<{ text?: string }>;
  prewarm?: () => Promise<void>;
  performHaptic?: (options?: { style?: HapticFeedbackStyle }) => Promise<void>;
  startRawPcmCapture?: () => Promise<void>;
  stopRawPcmCapture?: () => Promise<void>;
  speak?: (options: NativeTtsSpeakOptions) => Promise<void>;
  stopSpeaking?: () => Promise<void>;
  isSpeaking?: () => Promise<{ speaking: boolean }>;
  getTtsVoiceQuality?: (options?: { lang?: string }) => Promise<NativeTtsVoiceQualityInfo>;
  openTtsSettings?: () => Promise<{ opened?: boolean } | void>;
  openAppSettings?: () => Promise<{ opened?: boolean } | void>;
  getOfflineModelStatus?: () => Promise<OfflineSpeechModelStatus>;
  downloadOfflineModel?: (options?: { allowCellular?: boolean }) => Promise<OfflineSpeechModelDownloadResult>;
  cancelOfflineModelDownload?: () => Promise<{ cancelled: boolean; status: OfflineSpeechModelStatus }>;
  deleteOfflineModel?: () => Promise<{ deleted: boolean; status: OfflineSpeechModelStatus }>;
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

const RAW_PCM_CAPTURE_PLUGIN_METHODS = [
  'startRawPcmCapture',
  'stopRawPcmCapture',
] as const;

let _nativeRawPcmCaptureUnsupported = false;

/** Latch that the current Capacitor shell returned UNIMPLEMENTED for native raw PCM capture. */
export function markNativeRawPcmCaptureUnsupported(): void {
  _nativeRawPcmCaptureUnsupported = true;
}

/** Reset the runtime native raw PCM capture support latch (for tests). */
export function resetNativeRawPcmCaptureSupportForTesting(): void {
  _nativeRawPcmCaptureUnsupported = false;
}

/** Native raw 16kHz PCM capture bridge (enforces physical built-in mic without triggering WKWebView BT HFP). */
export function getNativeRawPcmCapture(): NativeRawPcmCapture | null {
  if (_nativeRawPcmCaptureUnsupported) return null;
  if (!isStreamingSpeechAvailable()) return null;
  const capacitor = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  if (capacitor?.getPlatform?.() === 'web') return null;
  const candidate = StreamingSpeech as unknown as Partial<NativeRawPcmCapture> & Record<string, unknown>;
  if (
    !hasNativePluginMethods(STREAMING_SPEECH_PLUGIN_NAME, candidate, RAW_PCM_CAPTURE_PLUGIN_METHODS)
    || typeof candidate.startRawPcmCapture !== 'function'
    || typeof candidate.stopRawPcmCapture !== 'function'
    || typeof candidate.addListener !== 'function'
  ) {
    return null;
  }
  return candidate as NativeRawPcmCapture;
}

const OFFLINE_MODEL_PLUGIN_METHODS = [
  'getOfflineModelStatus',
  'downloadOfflineModel',
  'cancelOfflineModelDownload',
  'deleteOfflineModel',
] as const;

type CapacitorPluginHeader = {
  name?: string;
  methods?: Array<{ name?: string; rtype?: string }>;
};

type CapacitorBridgeGlobal = {
  isPluginAvailable?: (name: string) => boolean;
  getPlatform?: () => string;
  PluginHeaders?: CapacitorPluginHeader[];
};

function hasNativePluginMethods(
  pluginName: string,
  candidate: Record<string, unknown>,
  methodNames: readonly string[],
): boolean {
  const headers = (globalThis as { Capacitor?: CapacitorBridgeGlobal }).Capacitor?.PluginHeaders;
  if (Array.isArray(headers)) {
    const header = headers.find((entry) => entry?.name === pluginName);
    if (!header) return false;
    if (Array.isArray(header.methods)) {
      const implemented = new Set(
        header.methods.map((method) => method?.name).filter((name): name is string => typeof name === 'string'),
      );
      return methodNames.every((name) => implemented.has(name));
    }
  }
  return methodNames.every((name) => typeof candidate[name] === 'function');
}

export function isCapacitorUnimplementedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && /is not implemented|unimplemented/i.test(err);
  }
  const record = err as { code?: unknown; message?: unknown };
  if (typeof record.code === 'string' && record.code.toUpperCase() === 'UNIMPLEMENTED') {
    return true;
  }
  return typeof record.message === 'string' && /\bis not implemented\b/i.test(record.message);
}

/** Native iOS offline speech model download & storage manager (only available on iOS native shells with updated plugin). */
export function getNativeOfflineSpeechModelManager(): NativeOfflineSpeechModelManager | null {
  if (!isIosNativePlatform() || !isStreamingSpeechAvailable()) return null;
  const candidate = StreamingSpeech as unknown as Partial<NativeOfflineSpeechModelManager> & Record<string, unknown>;
  if (!hasNativePluginMethods(STREAMING_SPEECH_PLUGIN_NAME, candidate, OFFLINE_MODEL_PLUGIN_METHODS)) {
    return null;
  }
  return candidate as NativeOfflineSpeechModelManager;
}

/** True on older iOS native shells that expose StreamingSpeech without the offline model management methods. */
export function isNativeOfflineModelShellOutdated(): boolean {
  return isIosNativePlatform() && isStreamingSpeechAvailable() && getNativeOfflineSpeechModelManager() === null;
}

/** True when built-in StreamingSpeech exposes `transcribePcm` (absent on old shells or `'system'` engine). */
export function isNativeTranscribePcmSupported(): boolean {
  if (!isStreamingSpeechAvailable() || getVoiceRecognitionEngine() === 'system') return false;
  const candidate = StreamingSpeech as unknown as Partial<NativeSpeechRecognition> & Record<string, unknown>;
  return hasNativePluginMethods(STREAMING_SPEECH_PLUGIN_NAME, candidate, ['transcribePcm'])
    && typeof candidate.transcribePcm === 'function';
}

/** Transcribe a finalized 16kHz Int16 PCM buffer on the built-in native speech plugin without opening live mic capture. */
export async function transcribeNativePcm(options: {
  pcmBase64: string;
  language?: string;
}): Promise<{ ok: true; text: string } | { ok: false; unimplemented?: boolean; error: string }> {
  if (!isNativeTranscribePcmSupported()) {
    return { ok: false, unimplemented: true, error: 'transcribePcm not supported' };
  }
  const candidate = StreamingSpeech as unknown as Partial<NativeSpeechRecognition>;
  try {
    const res = await candidate.transcribePcm!(options);
    return { ok: true, text: typeof res?.text === 'string' ? res.text : '' };
  } catch (err) {
    if (isCapacitorUnimplementedError(err)) {
      return { ok: false, unimplemented: true, error: 'UNIMPLEMENTED' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err ?? 'transcribePcm failed'),
    };
  }
}

/** True when StreamingSpeech exposes `openAppSettings()` on the current native shell. */
export function isOpenNativeAppSettingsAvailable(): boolean {
  if (!isStreamingSpeechAvailable()) return false;
  const candidate = StreamingSpeech as unknown as Partial<NativeSpeechRecognition> & Record<string, unknown>;
  return hasNativePluginMethods(STREAMING_SPEECH_PLUGIN_NAME, candidate, ['openAppSettings']);
}

/** Open the OS Application Details / Privacy Settings page for this app on native Capacitor shells. */
export async function openNativeAppSettings(): Promise<boolean> {
  if (!isOpenNativeAppSettingsAvailable()) return false;
  const candidate = StreamingSpeech as unknown as Partial<NativeSpeechRecognition>;
  if (typeof candidate.openAppSettings !== 'function') return false;
  try {
    const result = await candidate.openAppSettings();
    return result?.opened === true;
  } catch {
    return false;
  }
}

export type ActiveVoiceServiceKind =
  | 'remote_desktop'
  | 'remote_http_asr'
  | 'local_pc_model'
  | 'local_builtin'
  | 'local_system'
  | 'local_web';

export interface ActiveVoiceServiceInfo {
  kind: ActiveVoiceServiceKind;
  label?: string;
  isFallback?: boolean;
}

/** Format an active runtime voice service info object into a concise localized UI label. */
export function formatActiveVoiceServiceLabel(
  info: ActiveVoiceServiceInfo | null | undefined,
  t: (key: string, opts?: Record<string, unknown>) => string,
  isIos = isIosNativePlatform(),
): string {
  if (!info) return '';
  let base: string;
  switch (info.kind) {
    case 'remote_desktop':
    case 'remote_http_asr':
      base = info.label?.trim() || t('voice.engine_local');
      break;
    case 'local_pc_model':
      base = info.label?.trim() || t('voice.engine_system');
      break;
    case 'local_builtin':
      base = t('voice.engine_builtin');
      break;
    case 'local_system':
      base = t(isIos ? 'voice.engine_apple' : 'voice.engine_system');
      break;
    case 'local_web':
      base = t('voice.engine_web');
      break;
  }
  return info.isFallback ? `${base} (${t('voice.service_fallback_tag')})` : base;
}

/** Safely read `getActiveVoiceService()` from a VoiceInput module (guards partial test mocks). */
export function getActiveVoiceServiceFrom(voiceInputMod: unknown): ActiveVoiceServiceInfo | null {
  if (!voiceInputMod || typeof voiceInputMod !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(voiceInputMod, 'getActiveVoiceService')) return null;
  const fn = (voiceInputMod as { getActiveVoiceService?: () => ActiveVoiceServiceInfo | null }).getActiveVoiceService;
  return typeof fn === 'function' ? fn() : null;
}

/** Safely subscribe to `subscribeActiveVoiceService()` on a VoiceInput module (guards partial test mocks). */
export function subscribeActiveVoiceServiceFrom(
  voiceInputMod: unknown,
  listener: (info: ActiveVoiceServiceInfo | null) => void,
): () => void {
  if (!voiceInputMod || typeof voiceInputMod !== 'object') return () => {};
  if (!Object.prototype.hasOwnProperty.call(voiceInputMod, 'subscribeActiveVoiceService')) return () => {};
  const fn = (voiceInputMod as { subscribeActiveVoiceService?: (cb: typeof listener) => () => void }).subscribeActiveVoiceService;
  return typeof fn === 'function' ? fn(listener) : () => {};
}

const REMOTE_VOICE_CLIENT_REASON_CODES = new Set<string>([
  ...REMOTE_VOICE_ALLOWED_ERROR_CODES,
  'unconfigured',
  'self_device',
  'cancelled',
  'get_user_media_unavailable',
  'audio_context_unavailable',
  'ws_ticket_unavailable',
  'ws_ticket_failed',
  'connect_failed',
  'remote_start_failed',
  'ws_open_timeout',
  'ready_timeout',
  'ws_send_failed',
  'ws_closed',
  'session_end',
  'ws_error',
  'mic_unavailable',
  'audio_pipeline_failed',
  'invalid_session',
  'not_ready',
  'busy',
  'worker_write_failed',
  'local_fallback',
]);

const REMOTE_VOICE_STANDARD_MIC_ERROR_NAMES = new Set<string>([
  'NotAllowedError',
  'PermissionDeniedError',
  'NotFoundError',
  'DevicesNotFoundError',
  'NotReadableError',
  'TrackStartError',
  'OverconstrainedError',
  'ConstraintNotSatisfiedError',
  'AbortError',
  'SecurityError',
  'InvalidStateError',
  'NotSupportedError',
  'TypeError',
  'NetworkError',
  'TimeoutError',
]);

/** Allowlist remote-voice fallback reasons to known protocol codes or standard browser error names (returns null when empty). */
export function formatRemoteVoiceFallbackReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  if (REMOTE_VOICE_CLIENT_REASON_CODES.has(trimmed)) return trimmed;
  const errorNameMatch = /^([A-Za-z]+Error)(?:$|:|\s)/.exec(trimmed);
  if (errorNameMatch && REMOTE_VOICE_STANDARD_MIC_ERROR_NAMES.has(errorNameMatch[1]!)) {
    return errorNameMatch[1]!;
  }
  return 'remote_start_failed';
}
