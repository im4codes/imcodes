import {
  REMOTE_VOICE_MAX_PCM_CHUNK_BYTES,
  REMOTE_VOICE_SAMPLE_RATE,
  REMOTE_VOICE_WS_PATH,
  resolveSessionTranscriptResult,
  type RemoteVoiceProviderInfo,
  type RemoteVoiceProvidersSnapshot,
  type RemoteVoiceServerFrame,
} from '@shared/remote-voice.js';
import {
  STREAMING_SPEECH_RAW_PCM_EVENT,
  type StreamingSpeechRawPcmEvent,
} from '@shared/voice-recognition.js';
import * as apiModule from './api.js';
import { getLocalPcAppRemoteDeviceId } from './remote-voice-provider.js';
import {
  getNativeRawPcmCapture,
  isCapacitorUnimplementedError,
  markNativeRawPcmCaptureUnsupported,
  resetNativeRawPcmCaptureSupportForTesting,
  type NativeRawPcmCapture,
} from './voice-recognition-backend.js';

function readOptionalApiMethod<K extends keyof typeof apiModule>(key: K): (typeof apiModule)[K] | null {
  try {
    const candidate = apiModule[key];
    return typeof candidate === 'function' ? candidate : null;
  } catch {
    return null;
  }
}

function getApiBaseUrlSafe(): string {
  const fn = readOptionalApiMethod('getApiBaseUrl');
  if (fn) return fn();
  return typeof window !== 'undefined' ? window.location.origin : '';
}

export const REMOTE_VOICE_CLIENT_READY_TIMEOUT_MS = 3_000;
export const REMOTE_VOICE_CLIENT_STOP_DRAIN_MS = 5_000;
export const REMOTE_VOICE_CLIENT_HTTP_ASR_STOP_DRAIN_MS = 28_000;
export const REMOTE_VOICE_FRESHNESS_TIMEOUT_MS = 800;
const REMOTE_VOICE_CACHE_FRESH_MS = 5_000;
const PCM_TARGET_CHUNK_SAMPLES = 1_600; // 100ms @ 16kHz = 3200 bytes
const MAX_PRE_READY_PCM_SAMPLES = REMOTE_VOICE_SAMPLE_RATE * 15; // 15s cap (~480KB)
const MAX_FALLBACK_PCM_SAMPLES = REMOTE_VOICE_SAMPLE_RATE * 30; // 30s cap = 480k samples (~960KB)

function appendBoundedSamples(target: number[], samples: Int16Array, maxSamples: number): void {
  if (samples.length === 0) return;
  for (let i = 0; i < samples.length; i += 1) {
    target.push(samples[i]!);
  }
  if (target.length > maxSamples) {
    target.splice(0, target.length - maxSamples);
  }
}

export interface RemoteVoiceClientState {
  primaryDeviceId: string | null;
  canManageServerSharing: boolean;
  canShareOwnProviderToServer: boolean;
  providers: RemoteVoiceProviderInfo[];
  fetchedAt: number;
  loading: boolean;
  fallbackNotice: string | null;
}

const DEFAULT_STATE: RemoteVoiceClientState = {
  primaryDeviceId: null,
  canManageServerSharing: false,
  canShareOwnProviderToServer: false,
  providers: [],
  fetchedAt: 0,
  loading: false,
  fallbackNotice: null,
};

let _state: RemoteVoiceClientState = { ...DEFAULT_STATE };
const _listeners = new Set<(state: RemoteVoiceClientState) => void>();
let _inFlightRefresh: Promise<RemoteVoiceClientState> | null = null;
let _refreshEpoch = 0;
let _remoteMicPermissionKnownGranted: boolean | null = null;
let _preferredBuiltInMicDeviceId: string | null = null;
let _primedCapture: PrimedRemoteVoiceCapture | null = null;

function emitState(): void {
  const snapshot = getRemoteVoiceState();
  for (const listener of [..._listeners]) {
    try {
      listener(snapshot);
    } catch {
      // Isolate subscribers.
    }
  }
}

export function getRemoteVoiceState(): RemoteVoiceClientState {
  return {
    ..._state,
    providers: [..._state.providers],
  };
}

export function subscribeRemoteVoiceState(
  listener: (state: RemoteVoiceClientState) => void,
): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

export function clearRemoteVoiceFallbackNotice(): void {
  if (_state.fallbackNotice === null) return;
  _state = { ..._state, fallbackNotice: null };
  emitState();
}

export function setRemoteVoiceFallbackNotice(notice: string | null): void {
  if (_state.fallbackNotice === notice) return;
  _state = { ..._state, fallbackNotice: notice };
  emitState();
}

export function isRemoteMicPermissionKnownGranted(): boolean {
  return _remoteMicPermissionKnownGranted === true;
}

export function markRemoteMicPermissionKnownGranted(granted: boolean): void {
  _remoteMicPermissionKnownGranted = granted;
}

export function resetRemoteVoiceClientForTesting(next?: Partial<RemoteVoiceClientState>): void {
  cancelRemoteVoiceCapturePrime();
  resetNativeRawPcmCaptureSupportForTesting();
  _remoteMicPermissionKnownGranted = null;
  _preferredBuiltInMicDeviceId = null;
  _refreshEpoch += 1;
  _inFlightRefresh = null;
  _state = {
    ...DEFAULT_STATE,
    ...(next ?? {}),
    providers: next?.providers ? [...next.providers] : [],
  };
  emitState();
}

export async function refreshRemoteVoiceProviders(
  options: { timeoutMs?: number } = {},
): Promise<RemoteVoiceClientState> {
  const fetchProvidersFn = readOptionalApiMethod('fetchRemoteVoiceProviders');
  if (!fetchProvidersFn) {
    return getRemoteVoiceState();
  }
  if (_inFlightRefresh && !options.timeoutMs) {
    return _inFlightRefresh;
  }

  const epoch = _refreshEpoch;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = options.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (controller && typeof timeoutMs === 'number' && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
  }

  _state = { ..._state, loading: true };
  emitState();

  const run = (async (): Promise<RemoteVoiceClientState> => {
    try {
      const snap: RemoteVoiceProvidersSnapshot = await fetchProvidersFn(
        controller ? { signal: controller.signal } : undefined,
      );
      if (epoch !== _refreshEpoch) return getRemoteVoiceState();
      _state = {
        ..._state,
        primaryDeviceId: snap.primaryDeviceId ?? null,
        canManageServerSharing: Boolean(snap.canManageServerSharing),
        canShareOwnProviderToServer: Boolean(snap.canShareOwnProviderToServer ?? snap.canManageServerSharing),
        providers: Array.isArray(snap.providers) ? [...snap.providers] : [],
        fetchedAt: Date.now(),
        loading: false,
      };
      emitState();
    } catch {
      if (epoch !== _refreshEpoch) return getRemoteVoiceState();
      _state = { ..._state, loading: false };
      emitState();
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    return getRemoteVoiceState();
  })();

  if (!options.timeoutMs) {
    let wrapped!: Promise<RemoteVoiceClientState>;
    wrapped = run.finally(() => {
      if (_inFlightRefresh === wrapped) {
        _inFlightRefresh = null;
      }
    });
    _inFlightRefresh = wrapped;
    return wrapped;
  }
  return run;
}

export async function selectPrimaryRemoteVoiceProvider(deviceId: string | null): Promise<void> {
  const prev = _state.primaryDeviceId;
  _state = { ..._state, primaryDeviceId: deviceId, fallbackNotice: null };
  emitState();
  try {
    const saveFn = readOptionalApiMethod('savePrimaryRemoteVoiceProvider');
    if (saveFn) {
      await saveFn(deviceId);
    }
  } catch (err) {
    _state = { ..._state, primaryDeviceId: prev };
    emitState();
    throw err;
  }
}

export async function updateRemoteVoiceNickname(
  deviceId: string,
  nickname: string | null,
): Promise<void> {
  const saveNickFn = readOptionalApiMethod('saveRemoteVoiceProviderNickname');
  if (!saveNickFn) throw new Error('remote_voice_api_unavailable');
  await saveNickFn(deviceId, nickname);
  await refreshRemoteVoiceProviders();
}

export async function toggleRemoteVoiceServerSharing(
  deviceId: string,
  shared: boolean,
  nickname?: string | null,
): Promise<void> {
  const shareFn = readOptionalApiMethod('setServerSharedRemoteVoiceProvider');
  if (!shareFn) throw new Error('remote_voice_api_unavailable');
  await shareFn(deviceId, shared, nickname);
  await refreshRemoteVoiceProviders();
}

export type RemoteVoiceRouteDecision =
  | { route: 'remote'; targetDeviceId: string; provider: RemoteVoiceProviderInfo }
  | { route: 'local'; reason: 'unconfigured' | 'self_device' }
  | { route: 'local_fallback'; reason: 'provider_offline' | 'provider_not_ready' | 'provider_busy' };

/**
 * Inspect whether voice recognition should route to a configured primary shared provider.
 * When `primaryDeviceId === null`, returns synchronously with zero network calls.
 * When `primaryDeviceId` is set, refreshes stale/offline state with a bounded <=800ms
 * timeout so a primary PC coming back online automatically switches back on the next utterance.
 */
export async function resolveRemoteVoiceRoute(
  options: { timeoutMs?: number } = {},
): Promise<RemoteVoiceRouteDecision> {
  const initial = _state;
  if (!initial.primaryDeviceId) {
    return { route: 'local', reason: 'unconfigured' };
  }

  const localDeviceId = getLocalPcAppRemoteDeviceId();
  if (localDeviceId && initial.primaryDeviceId === localDeviceId) {
    return { route: 'local', reason: 'self_device' };
  }

  const cachedPrimary = initial.providers.find((p) => p.deviceId === initial.primaryDeviceId);
  const age = Date.now() - initial.fetchedAt;
  if (cachedPrimary && cachedPrimary.ready) {
    if (age > REMOTE_VOICE_CACHE_FRESH_MS || cachedPrimary.busy) {
      void refreshRemoteVoiceProviders();
    }
    return { route: 'remote', targetDeviceId: cachedPrimary.deviceId, provider: cachedPrimary };
  }

  const needsRefresh = !cachedPrimary || !cachedPrimary.ready || age > REMOTE_VOICE_CACHE_FRESH_MS;
  const latest = needsRefresh
    ? await refreshRemoteVoiceProviders({ timeoutMs: options.timeoutMs ?? REMOTE_VOICE_FRESHNESS_TIMEOUT_MS })
    : initial;

  const primaryId = latest.primaryDeviceId;
  if (!primaryId) {
    return { route: 'local', reason: 'unconfigured' };
  }
  const freshLocalDeviceId = getLocalPcAppRemoteDeviceId();
  if (freshLocalDeviceId && primaryId === freshLocalDeviceId) {
    return { route: 'local', reason: 'self_device' };
  }

  const provider = latest.providers.find((p) => p.deviceId === primaryId);
  if (!provider) {
    return { route: 'local_fallback', reason: 'provider_offline' };
  }
  if (!provider.ready) {
    return { route: 'local_fallback', reason: 'provider_not_ready' };
  }
  if (provider.busy) {
    return { route: 'local_fallback', reason: 'provider_busy' };
  }
  return { route: 'remote', targetDeviceId: provider.deviceId, provider };
}

export function hasOnlinePrimaryRemoteProvider(): boolean {
  const id = _state.primaryDeviceId;
  if (!id) return false;
  const localId = getLocalPcAppRemoteDeviceId();
  if (localId && id === localId) return false;
  const match = _state.providers.find((p) => p.deviceId === id);
  return Boolean(match && match.ready);
}

export function installRemoteVoiceAutoRefresh(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onOnline = () => {
    void refreshRemoteVoiceProviders();
  };
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      void refreshRemoteVoiceProviders();
    }
  };
  window.addEventListener('online', onOnline);
  document?.addEventListener?.('visibilitychange', onVisible);
  void refreshRemoteVoiceProviders();
  return () => {
    window.removeEventListener('online', onOnline);
    document?.removeEventListener?.('visibilitychange', onVisible);
  };
}

function floatToInt16Sample(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

/**
 * Stateful streaming resampler that preserves continuous fractional phase,
 * tail samples, and 2nd-order Butterworth low-pass anti-aliasing filter state
 * across audio callbacks so no samples are dropped and no phase clicks occur.
 */
export class StreamingPcmResampler {
  private readonly sourceRate: number;
  private readonly targetRate: number;
  private readonly ratio: number;
  private readonly isIdentity: boolean;
  private readonly filterEnabled: boolean;
  private readonly b0: number = 1;
  private readonly b1: number = 0;
  private readonly b2: number = 0;
  private readonly a1: number = 0;
  private readonly a2: number = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private tail: Float32Array = new Float32Array(0);
  private pos = 0;

  constructor(sourceRate: number, targetRate = REMOTE_VOICE_SAMPLE_RATE) {
    this.sourceRate = sourceRate > 0 ? sourceRate : targetRate;
    this.targetRate = targetRate > 0 ? targetRate : REMOTE_VOICE_SAMPLE_RATE;
    this.isIdentity = Math.abs(this.sourceRate - this.targetRate) < 1;
    this.ratio = this.sourceRate / this.targetRate;
    this.filterEnabled = !this.isIdentity && this.sourceRate > this.targetRate;

    if (this.filterEnabled) {
      // Causal 2nd-order Butterworth LPF at 0.45 * targetRate (7.2 kHz for 16 kHz output)
      // to suppress aliasing above Nyquist while leaving speech band untouched.
      const cutoff = Math.min(0.45 * this.targetRate, 0.48 * this.sourceRate);
      const ita = 1 / Math.tan((Math.PI * cutoff) / this.sourceRate);
      const q = Math.SQRT2;
      const b0 = 1 / (1 + q * ita + ita * ita);
      this.b0 = b0;
      this.b1 = 2 * b0;
      this.b2 = b0;
      this.a1 = 2 * (ita * ita - 1) * b0;
      this.a2 = -(1 - q * ita + ita * ita) * b0;
    }
  }

  private applyLowPass(input: Float32Array): Float32Array {
    if (!this.filterEnabled) return input;
    const out = new Float32Array(input.length);
    let { x1, x2, y1, y2 } = this;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < input.length; i += 1) {
      const x0 = input[i]!;
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 + a1 * y1 + a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
    return out;
  }

  push(input: Float32Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    if (this.isIdentity) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        out[i] = floatToInt16Sample(input[i]!);
      }
      return out;
    }

    const filtered = this.applyLowPass(input);
    const combined = new Float32Array(this.tail.length + filtered.length);
    if (this.tail.length > 0) combined.set(this.tail, 0);
    combined.set(filtered, this.tail.length);

    if (combined.length < 2) {
      this.tail = combined;
      return new Int16Array(0);
    }

    const samples: number[] = [];
    let pos = this.pos;
    const lastReadable = combined.length - 1;
    while (pos < lastReadable) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = combined[idx]!;
      const s1 = combined[idx + 1]!;
      const interpolated = s0 + (s1 - s0) * frac;
      samples.push(floatToInt16Sample(interpolated));
      pos += this.ratio;
    }

    const consumed = Math.min(combined.length, Math.floor(pos));
    this.tail = combined.subarray(consumed).slice();
    this.pos = pos - consumed;
    return Int16Array.from(samples);
  }

  flush(): Int16Array {
    if (this.isIdentity || this.tail.length === 0) {
      this.tail = new Float32Array(0);
      this.pos = 0;
      return new Int16Array(0);
    }
    const samples: number[] = [];
    let pos = this.pos;
    while (pos < this.tail.length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = this.tail[idx]!;
      const s1 = this.tail[Math.min(this.tail.length - 1, idx + 1)]!;
      samples.push(floatToInt16Sample(s0 + (s1 - s0) * frac));
      pos += this.ratio;
    }
    this.tail = new Float32Array(0);
    this.pos = 0;
    return Int16Array.from(samples);
  }

  reset(): void {
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    this.tail = new Float32Array(0);
    this.pos = 0;
  }
}

export function downsampleFloat32ToInt16Le(input: Float32Array, sourceRate: number, targetRate = REMOTE_VOICE_SAMPLE_RATE): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (sourceRate <= 0 || Math.abs(sourceRate - targetRate) < 1) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      out[i] = floatToInt16Sample(input[i]!);
    }
    return out;
  }
  const ratio = sourceRate / targetRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j]!;
      count += 1;
    }
    const sample = count > 0 ? sum / count : input[Math.min(input.length - 1, start)]!;
    out[i] = floatToInt16Sample(sample);
  }
  return out;
}

export function encodeInt16PcmToBase64(samples: Int16Array): string {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, i + step);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export interface ActiveRemoteVoiceSessionHandle {
  stop: (abort?: boolean) => Promise<void>;
  /** Resolves as soon as local microphone / native capture hardware is released (before remote WS drain finishes). */
  micReleased?: Promise<void>;
}

export interface PrimeRemoteVoiceCaptureOptions {
  /** Allow interactive OS/browser permission prompt when state isn't yet known granted. Keep false on t=0 pointerdown. */
  allowPrompt?: boolean;
  /** Fired once local mic / native raw PCM capture begins recording into the pre-roll queue. */
  onCaptureStarted?: () => void;
  /** Fired with live audio levels while pre-rolling before WS session adoption. */
  onLevel?: (level: number) => void;
  /** Fired if pre-roll mic setup fails prior to adoption. */
  onError?: (reason: string, isPermissionDenied?: boolean) => void;
}

export interface RemoteVoiceFallbackInfo {
  bufferedPcm?: Int16Array;
  stoppedByCaller?: boolean;
}

export interface StartRemoteVoiceSessionOptions {
  targetDeviceId: string;
  locale?: string;
  hotwords?: string[];
  onResult: (text: string, isFinal: boolean) => void;
  onLevel?: (level: number) => void;
  onCaptureStarted?: (handle: ActiveRemoteVoiceSessionHandle) => void;
  onEnd?: () => void;
  onError?: (code: string) => void;
  onFallback?: (reason: string, info?: RemoteVoiceFallbackInfo) => boolean | void;
  signal?: AbortSignal;
  readyTimeoutMs?: number;
  stopDrainMs?: number;
  fetchTicket?: () => Promise<{ ticket: string }>;
  getWsBaseUrl?: () => string;
  createSocket?: (url: string) => WebSocket;
}

function makeSessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `rv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface RemoteAudioGraph {
  stream: MediaStream;
  audioCtx: AudioContext;
  sourceNode: MediaStreamAudioSourceNode;
  processorNode: ScriptProcessorNode;
  gainNode: GainNode;
  resampler: StreamingPcmResampler | null;
}

interface AudioFrameSink {
  active: boolean;
  onFrame: (level: number, samples: Int16Array) => void;
}

interface NativeCaptureState {
  bridge: NativeRawPcmCapture;
  listenerPromise: Promise<{ remove: () => Promise<void> }> | null;
}

interface PrimedRemoteVoiceCapture {
  cancelled: boolean;
  adopted: boolean;
  stopOnReady: boolean;
  captureEnded: boolean;
  captureReady: boolean;
  finishPromise: Promise<void> | null;
  failedReason: string | null;
  failedPermission: boolean;
  webAttempted: boolean;
  graph: RemoteAudioGraph | null;
  native: NativeCaptureState | null;
  pcmQueue: number[];
  hasLevel: boolean;
  lastLevel: number;
  sink: AudioFrameSink;
  onCaptureStarted: (() => void) | null;
  onLevel: ((level: number) => void) | null;
  onError: ((reason: string, isPermissionDenied?: boolean) => void) | null;
  onAdoptedReady: ((prime: PrimedRemoteVoiceCapture) => void) | null;
  onAdoptedError: ((reason: string) => void) | null;
  micPromise: Promise<MediaStream | null>;
}

const REMOTE_MIC_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: true,
};

const BUILTIN_MIC_LABEL_RE = /\b(built[- ]?in|internal|iphone|ipad|android|phone|bottom|front|back)\b|内置|内建|手机|听筒|主麦克风/i;
const HEADSET_OR_BT_MIC_LABEL_RE = /\b(airpods|bluetooth|headset|headphone|earbud|earphone|hands[- ]?free|hfp|sco|usb|external|wireless)\b|蓝牙|耳机|耳麦|外接/i;

export function selectPreferredBuiltInMicDeviceId(
  devices: ReadonlyArray<Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>>,
): string | undefined {
  const inputs = devices.filter(
    (d) => d.kind === 'audioinput' && typeof d.deviceId === 'string' && d.deviceId.trim().length > 0 && d.deviceId !== 'communications',
  );
  if (inputs.length === 0) return undefined;
  const explicitBuiltIn = inputs.find((d) => {
    const label = (d.label ?? '').trim();
    return label.length > 0 && BUILTIN_MIC_LABEL_RE.test(label) && !HEADSET_OR_BT_MIC_LABEL_RE.test(label);
  });
  if (explicitBuiltIn) return explicitBuiltIn.deviceId;
  const hasHeadset = inputs.some((d) => HEADSET_OR_BT_MIC_LABEL_RE.test(d.label ?? ''));
  if (hasHeadset) {
    const nonHeadset = inputs.find((d) => {
      const label = (d.label ?? '').trim();
      return label.length > 0 && !HEADSET_OR_BT_MIC_LABEL_RE.test(label);
    });
    if (nonHeadset) return nonHeadset.deviceId;
  }
  return undefined;
}

async function refreshPreferredBuiltInMicDeviceId(): Promise<string | undefined> {
  const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') return undefined;
  try {
    const devices = await mediaDevices.enumerateDevices();
    const selected = Array.isArray(devices) ? selectPreferredBuiltInMicDeviceId(devices) : undefined;
    _preferredBuiltInMicDeviceId = selected ?? null;
    return selected;
  } catch {
    return undefined;
  }
}

function buildMicConstraints(deviceId?: string | null): MediaTrackConstraints {
  return deviceId
    ? { ...REMOTE_MIC_AUDIO_CONSTRAINTS, deviceId: { ideal: deviceId } }
    : REMOTE_MIC_AUDIO_CONSTRAINTS;
}

export function decodeBase64ToInt16Pcm(pcmBase64: string): Int16Array {
  if (!pcmBase64) return new Int16Array(0);
  const binary = atob(pcmBase64);
  const len = Math.floor(binary.length / 2);
  const bytes = new Uint8Array(len * 2);
  for (let i = 0; i < len * 2; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

function removeNativeListener(listenerPromise: Promise<{ remove: () => Promise<void> }> | null): void {
  if (!listenerPromise) return;
  void listenerPromise.then((handle) => handle?.remove?.()).catch(() => {});
}

async function teardownNativeCapture(native: NativeCaptureState, awaitStop: boolean): Promise<void> {
  const listenerPromise = native.listenerPromise;
  if (awaitStop) {
    try {
      await native.bridge.stopRawPcmCapture();
    } catch { /* ignore */ }
    await Promise.resolve();
    native.listenerPromise = null;
    if (listenerPromise) {
      try {
        const handle = await listenerPromise;
        await handle?.remove?.();
      } catch { /* ignore */ }
    }
    return;
  }
  native.listenerPromise = null;
  removeNativeListener(listenerPromise);
  try {
    void native.bridge.stopRawPcmCapture().catch(() => {});
  } catch { /* ignore */ }
}

function getAudioContextConstructor(): (new (options?: AudioContextOptions) => AudioContext) | null {
  return (globalThis as { AudioContext?: new (options?: AudioContextOptions) => AudioContext; webkitAudioContext?: new (options?: AudioContextOptions) => AudioContext }).AudioContext
    || (globalThis as { webkitAudioContext?: new (options?: AudioContextOptions) => AudioContext }).webkitAudioContext
    || null;
}

function isMicPermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /permission|notallowed/i.test(message);
}

export function formatMicCaptureErrorReason(err: unknown): string {
  if (err && typeof err === 'object') {
    const rawName = (err as { name?: unknown }).name;
    const rawMessage = (err as { message?: unknown }).message;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
    if (name && name !== 'Error') {
      if (!message || message === name || message.startsWith(`${name}:`)) {
        return message || name;
      }
      return `${name}: ${message}`;
    }
    if (message) return message;
  }
  return 'mic_unavailable';
}

export async function acquireRemoteMicStream(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
  deviceId?: string | null,
  canRetry: () => boolean = () => true,
): Promise<MediaStream> {
  try {
    return await mediaDevices.getUserMedia({ audio: buildMicConstraints(deviceId) });
  } catch (err) {
    if (isMicPermissionDeniedError(err) || !canRetry()) {
      throw err;
    }
    return mediaDevices.getUserMedia({ audio: true });
  }
}

function stopMediaStreamTracks(micStream: MediaStream | null | undefined): void {
  if (!micStream) return;
  try {
    micStream.getTracks().forEach((t) => t.stop());
  } catch { /* ignore */ }
}

function teardownRemoteAudioGraph(
  graph: RemoteAudioGraph,
  flushResampler: boolean,
  onFlushSamples?: (samples: Int16Array) => void,
): void {
  if (graph.resampler) {
    if (flushResampler) {
      onFlushSamples?.(graph.resampler.flush());
    }
    graph.resampler = null;
  }
  try {
    graph.processorNode.onaudioprocess = null;
    graph.processorNode.disconnect();
  } catch { /* ignore */ }
  try { graph.sourceNode.disconnect(); } catch { /* ignore */ }
  try { graph.gainNode.disconnect(); } catch { /* ignore */ }
  try { void graph.audioCtx.close(); } catch { /* ignore */ }
  stopMediaStreamTracks(graph.stream);
}

function buildRemoteAudioGraph(
  AC: new (options?: AudioContextOptions) => AudioContext,
  micStream: MediaStream,
  sink: AudioFrameSink,
): RemoteAudioGraph {
  let ctx: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let gainNode: GainNode | null = null;
  try {
    try {
      ctx = new AC({ sampleRate: REMOTE_VOICE_SAMPLE_RATE });
    } catch {
      ctx = new AC();
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      void ctx.resume().catch(() => {});
    }
    const sourceRate = ctx.sampleRate || REMOTE_VOICE_SAMPLE_RATE;
    const bufferSize = sourceRate <= 24_000 ? 1024 : 2048;
    const resampler = new StreamingPcmResampler(sourceRate, REMOTE_VOICE_SAMPLE_RATE);
    sourceNode = ctx.createMediaStreamSource(micStream);
    processorNode = ctx.createScriptProcessor(bufferSize, 1, 1);
    gainNode = ctx.createGain();
    gainNode.gain.value = 0;

    const graph: RemoteAudioGraph = {
      stream: micStream,
      audioCtx: ctx,
      sourceNode,
      processorNode,
      gainNode,
      resampler,
    };

    processorNode.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!sink.active) return;
      const input = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i += 1) {
        const s = input[i]!;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / Math.max(1, input.length));
      const level = Math.min(1, rms * 3);
      const samples = graph.resampler ? graph.resampler.push(input) : new Int16Array(0);
      sink.onFrame(level, samples);
    };

    sourceNode.connect(processorNode);
    processorNode.connect(gainNode);
    gainNode.connect(ctx.destination);
    return graph;
  } catch (err) {
    try {
      if (processorNode) {
        processorNode.onaudioprocess = null;
        processorNode.disconnect();
      }
    } catch { /* ignore */ }
    try { sourceNode?.disconnect(); } catch { /* ignore */ }
    try { gainNode?.disconnect(); } catch { /* ignore */ }
    try { if (ctx) void ctx.close(); } catch { /* ignore */ }
    stopMediaStreamTracks(micStream);
    throw err;
  }
}

/**
 * Quietly query microphone permission via the Permissions API without prompting.
 * Caches known-granted state so `primeRemoteVoiceCapture()` can start zero-delay
 * pre-roll capture on `pointerdown` without ever risking an unexpected prompt on taps.
 */
export async function probeRemoteMicPermission(): Promise<void> {
  const nativeCapture = getNativeRawPcmCapture();
  if (nativeCapture?.checkPermissions) {
    try {
      const status = await nativeCapture.checkPermissions();
      if (status?.speechRecognition === 'granted') {
        _remoteMicPermissionKnownGranted = true;
      } else if (status?.speechRecognition === 'denied' || status?.speechRecognition === 'prompt') {
        _remoteMicPermissionKnownGranted = false;
      }
    } catch { /* ignore */ }
  } else {
    try {
      const permissions = typeof navigator !== 'undefined' ? navigator.permissions : undefined;
      const query = permissions?.query;
      if (permissions && typeof query === 'function') {
        const status = await query.call(permissions, { name: 'microphone' as PermissionName });
        if (status?.state === 'granted') {
          _remoteMicPermissionKnownGranted = true;
        } else if (status?.state === 'denied' || status?.state === 'prompt') {
          _remoteMicPermissionKnownGranted = false;
        }
      }
    } catch {
      // Ignore unsupported Permissions API queries (e.g. Safari/iOS WebView); keep prior runtime knowledge.
    }
  }
  await refreshPreferredBuiltInMicDeviceId();
}

/**
 * Start local PCM pre-roll capture for shared/remote voice.
 * By default (`allowPrompt: false`, used on `pointerdown`), only starts when mic permission
 * is already known granted so taps never trigger unexpected OS permission dialogs.
 * With `allowPrompt: true` (used after hold activation), starts local capture immediately
 * while WS/route setup proceeds in parallel, emitting `onCaptureStarted` and `onLevel`.
 */
export function primeRemoteVoiceCapture(options?: PrimeRemoteVoiceCaptureOptions): boolean {
  const allowPrompt = options?.allowPrompt === true;
  if (!allowPrompt && _remoteMicPermissionKnownGranted !== true) return false;
  const nativeCapture = getNativeRawPcmCapture();
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const AC = getAudioContextConstructor();
  const canWebAudio = Boolean(nav?.mediaDevices?.getUserMedia && AC);
  if (!nativeCapture && !canWebAudio) return false;

  if (_primedCapture && !_primedCapture.cancelled && !_primedCapture.adopted) {
    if (_primedCapture.failedReason === null && !_primedCapture.stopOnReady && !_primedCapture.captureEnded) {
      if (options?.onCaptureStarted) _primedCapture.onCaptureStarted = options.onCaptureStarted;
      if (options?.onLevel) _primedCapture.onLevel = options.onLevel;
      if (options?.onError) _primedCapture.onError = options.onError;
      if (_primedCapture.captureReady) {
        _primedCapture.onCaptureStarted?.();
        if (_primedCapture.hasLevel) {
          _primedCapture.onLevel?.(_primedCapture.lastLevel);
        }
      }
      return true;
    }
    _primedCapture = null;
  }

  const enqueuePrimeSamples = (samples: Int16Array) => {
    if (samples.length === 0) return;
    for (let i = 0; i < samples.length; i += 1) {
      prime.pcmQueue.push(samples[i]!);
    }
    if (prime.pcmQueue.length > MAX_PRE_READY_PCM_SAMPLES) {
      prime.pcmQueue.splice(0, prime.pcmQueue.length - MAX_PRE_READY_PCM_SAMPLES);
    }
  };

  const sink: AudioFrameSink = {
    active: true,
    onFrame: (level, samples) => {
      prime.lastLevel = level;
      prime.hasLevel = true;
      if (!prime.adopted) {
        prime.onLevel?.(level);
      }
      enqueuePrimeSamples(samples);
    },
  };

  const prime: PrimedRemoteVoiceCapture = {
    cancelled: false,
    adopted: false,
    stopOnReady: false,
    captureEnded: false,
    captureReady: false,
    finishPromise: null,
    failedReason: null,
    failedPermission: false,
    webAttempted: false,
    graph: null,
    native: nativeCapture ? { bridge: nativeCapture, listenerPromise: null } : null,
    pcmQueue: [],
    hasLevel: false,
    lastLevel: 0,
    sink,
    onCaptureStarted: options?.onCaptureStarted ?? null,
    onLevel: options?.onLevel ?? null,
    onError: options?.onError ?? null,
    onAdoptedReady: null,
    onAdoptedError: null,
    micPromise: Promise.resolve(null),
  };
  _primedCapture = prime;

  const startWebPrime = (): Promise<MediaStream | null> => {
    prime.webAttempted = true;
    return acquireRemoteMicStream(nav!.mediaDevices, _preferredBuiltInMicDeviceId, () => !prime.cancelled)
      .then((acquired) => {
        _remoteMicPermissionKnownGranted = true;
        if (_preferredBuiltInMicDeviceId === null) {
          void refreshPreferredBuiltInMicDeviceId();
        }
        if (prime.cancelled) {
          stopMediaStreamTracks(acquired);
          return null;
        }
        const audioGraph = buildRemoteAudioGraph(AC!, acquired, prime.sink);
        if (prime.stopOnReady) {
          teardownRemoteAudioGraph(audioGraph, true, enqueuePrimeSamples);
          prime.graph = null;
          prime.sink.active = false;
          prime.captureEnded = true;
          prime.captureReady = true;
          if (prime.adopted) {
            prime.onAdoptedReady?.(prime);
          }
          return acquired;
        }
        prime.graph = audioGraph;
        prime.captureReady = true;
        if (prime.adopted) {
          prime.onAdoptedReady?.(prime);
        } else {
          prime.onCaptureStarted?.();
          if (prime.hasLevel) {
            prime.onLevel?.(prime.lastLevel);
          }
        }
        return acquired;
      })
      .catch((err) => {
        const permissionDenied = isMicPermissionDeniedError(err);
        if (permissionDenied) {
          _remoteMicPermissionKnownGranted = false;
        }
        const reason = formatMicCaptureErrorReason(err);
        prime.failedReason = reason;
        prime.failedPermission = permissionDenied;
        if (_primedCapture === prime && !prime.adopted) {
          _primedCapture = null;
        }
        if (!prime.cancelled) {
          if (prime.adopted) {
            prime.onAdoptedError?.(reason);
          } else {
            prime.onError?.(reason, permissionDenied);
          }
        }
        return null;
      });
  };

  if (nativeCapture && prime.native) {
    const nativeState = prime.native;
    const listenerP = nativeCapture.addListener(STREAMING_SPEECH_RAW_PCM_EVENT, (ev: StreamingSpeechRawPcmEvent) => {
      if (prime.cancelled || !prime.sink.active) return;
      const samples = decodeBase64ToInt16Pcm(ev.pcmBase64);
      const level = typeof ev.level === 'number' && Number.isFinite(ev.level) ? ev.level : 0;
      prime.sink.onFrame(level, samples);
    });
    nativeState.listenerPromise = listenerP;
    prime.micPromise = listenerP
      .then(() => {
        if (prime.cancelled) return null;
        return nativeCapture.startRawPcmCapture();
      })
      .then(async () => {
        if (prime.cancelled) {
          void teardownNativeCapture(nativeState, false);
          return null;
        }
        _remoteMicPermissionKnownGranted = true;
        if (prime.stopOnReady) {
          await teardownNativeCapture(nativeState, true);
          prime.native = null;
          prime.sink.active = false;
          prime.captureEnded = true;
          prime.captureReady = true;
          if (prime.adopted) {
            prime.onAdoptedReady?.(prime);
          }
          return null;
        }
        prime.captureReady = true;
        if (prime.adopted) {
          prime.onAdoptedReady?.(prime);
        } else {
          prime.onCaptureStarted?.();
          if (prime.hasLevel) {
            prime.onLevel?.(prime.lastLevel);
          }
        }
        return null;
      })
      .catch((err) => {
        void teardownNativeCapture(nativeState, false);
        prime.native = null;
        const permissionDenied = isMicPermissionDeniedError(err);
        if (isCapacitorUnimplementedError(err)) {
          markNativeRawPcmCaptureUnsupported();
        }
        if (permissionDenied) {
          _remoteMicPermissionKnownGranted = false;
        } else if (!prime.cancelled && canWebAudio) {
          return startWebPrime();
        }
        const reason = formatMicCaptureErrorReason(err);
        prime.failedReason = reason;
        prime.failedPermission = permissionDenied;
        if (_primedCapture === prime && !prime.adopted) {
          _primedCapture = null;
        }
        if (!prime.cancelled) {
          if (prime.adopted) {
            prime.onAdoptedError?.(reason);
          } else {
            prime.onError?.(reason, permissionDenied);
          }
        }
        return null;
      });
    return true;
  }

  prime.micPromise = startWebPrime();

  return true;
}

/**
 * Stop an un-adopted pre-roll capture's hardware microphone immediately while keeping
 * its buffered PCM samples alive in `_primedCapture` so an in-flight `startRemoteVoiceSession`
 * can still adopt and flush the utterance once the WebSocket handshake completes.
 */
export async function finishRemoteVoiceCapturePrime(): Promise<void> {
  const prime = _primedCapture;
  if (!prime || prime.adopted || prime.cancelled || prime.captureEnded) return;
  if (prime.finishPromise) {
    await prime.finishPromise;
    return;
  }
  prime.stopOnReady = true;
  const task = (async () => {
    if (!prime.captureReady) {
      await prime.micPromise.catch(() => null);
      if (!prime.captureReady || prime.cancelled || prime.adopted || prime.captureEnded) return;
    }
    if (prime.graph) {
      const audioGraph = prime.graph;
      prime.graph = null;
      teardownRemoteAudioGraph(audioGraph, true, (samples) => {
        appendBoundedSamples(prime.pcmQueue, samples, MAX_PRE_READY_PCM_SAMPLES);
      });
    }
    if (prime.native) {
      const nativeState = prime.native;
      prime.native = null;
      await teardownNativeCapture(nativeState, true);
    }
    prime.sink.active = false;
    prime.captureEnded = true;
  })();
  prime.finishPromise = task;
  try {
    await task;
  } finally {
    if (prime.finishPromise === task) {
      prime.finishPromise = null;
    }
  }
}

/** Silently abort and tear down an un-adopted remote voice pre-roll capture. */
export function cancelRemoteVoiceCapturePrime(): void {
  const prime = _primedCapture;
  if (!prime || prime.adopted) return;
  _primedCapture = null;
  prime.cancelled = true;
  prime.onCaptureStarted = null;
  prime.onLevel = null;
  prime.onError = null;
  prime.sink.active = false;
  prime.pcmQueue.length = 0;
  if (prime.graph) {
    teardownRemoteAudioGraph(prime.graph, false);
    prime.graph = null;
  }
  if (prime.native) {
    void teardownNativeCapture(prime.native, false);
    prime.native = null;
  }
}

/**
 * Stop an un-adopted pre-roll capture and return its preserved 16kHz Int16 PCM samples
 * so a local fallback recognizer can transcribe speech spoken before fallback completed.
 */
export async function drainRemoteVoiceCapturePrimePcm(): Promise<Int16Array> {
  const prime = _primedCapture;
  if (!prime || prime.adopted || prime.cancelled) return new Int16Array(0);
  if (!prime.captureEnded) {
    await finishRemoteVoiceCapturePrime();
  }
  if (_primedCapture === prime) {
    _primedCapture = null;
  }
  prime.onCaptureStarted = null;
  prime.onLevel = null;
  prime.onError = null;
  prime.sink.active = false;
  if (prime.cancelled || prime.pcmQueue.length === 0) {
    prime.pcmQueue.length = 0;
    prime.cancelled = true;
    return new Int16Array(0);
  }
  const drained = Int16Array.from(prime.pcmQueue);
  prime.pcmQueue.length = 0;
  prime.cancelled = true;
  return drained;
}

export async function startRemoteVoiceSession(
  opts: StartRemoteVoiceSessionOptions,
): Promise<
  | { ok: true; cancelled?: false; handle: ActiveRemoteVoiceSessionHandle }
  | { ok: false; cancelled: boolean; reason: string; bufferedPcm?: Int16Array }
> {
  const sessionId = makeSessionId();
  const readyTimeoutMs = opts.readyTimeoutMs ?? REMOTE_VOICE_CLIENT_READY_TIMEOUT_MS;
  const stopDrainMs = opts.stopDrainMs ?? REMOTE_VOICE_CLIENT_STOP_DRAIN_MS;

  let cancelled = false;
  let terminated = false;
  let terminalReason: string | null = null;
  let stoppedByCaller = false;
  let stopSent = false;
  let readySettled = false;
  let readyReceived = false;
  let endReceived = false;
  let hasDeliveredTranscript = false;
  let lastNonEmptyText = '';
  let resolveReady!: (outcome: { ok: boolean; reason?: string }) => void;
  const readyPromise = new Promise<{ ok: boolean; reason?: string }>((res) => {
    resolveReady = res;
  });
  let micReleasedSettled = false;
  let resolveMicReleased!: () => void;
  const micReleasedPromise = new Promise<void>((res) => {
    resolveMicReleased = res;
  });
  const markMicReleased = () => {
    if (micReleasedSettled) return;
    micReleasedSettled = true;
    resolveMicReleased();
  };
  let resolveEnd: (() => void) | null = null;
  let graph: RemoteAudioGraph | null = null;
  let activeNative: NativeCaptureState | null = null;
  let pendingDirectNative: { state: NativeCaptureState; sink: AudioFrameSink; promise: Promise<unknown> } | null = null;
  let activeSink: AudioFrameSink | null = null;
  let adoptedPrime: PrimedRemoteVoiceCapture | null = null;
  let ws: WebSocket | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;
  const pcmQueue: number[] = [];
  const fallbackPcmQueue: number[] = [];

  const enqueueSamples = (samples: Int16Array) => {
    if (samples.length === 0) return;
    appendBoundedSamples(pcmQueue, samples, readyReceived ? Number.MAX_SAFE_INTEGER : MAX_PRE_READY_PCM_SAMPLES);
    if (!hasDeliveredTranscript && !cancelled) {
      appendBoundedSamples(fallbackPcmQueue, samples, MAX_FALLBACK_PCM_SAMPLES);
    }
  };

  const consumeFallbackPcm = (): Int16Array | undefined => {
    if (cancelled || hasDeliveredTranscript || fallbackPcmQueue.length === 0) {
      fallbackPcmQueue.length = 0;
      return undefined;
    }
    const copy = Int16Array.from(fallbackPcmQueue);
    fallbackPcmQueue.length = 0;
    return copy;
  };

  let audioDrainPromise: Promise<void> | null = null;

  const drainOrAbortAudio = (abort: boolean): Promise<void> | null => {
    if (abort) {
      if (activeSink) {
        activeSink.active = false;
        activeSink = null;
      }
      if (pendingDirectNative) {
        pendingDirectNative.sink.active = false;
        void teardownNativeCapture(pendingDirectNative.state, false);
        pendingDirectNative = null;
      }
      if (adoptedPrime) {
        adoptedPrime.cancelled = true;
        adoptedPrime.sink.active = false;
        adoptedPrime.pcmQueue.length = 0;
        adoptedPrime.onAdoptedReady = null;
        adoptedPrime.onAdoptedError = null;
        if (adoptedPrime.graph) {
          teardownRemoteAudioGraph(adoptedPrime.graph, false);
          adoptedPrime.graph = null;
        }
        if (adoptedPrime.native) {
          void teardownNativeCapture(adoptedPrime.native, false);
          adoptedPrime.native = null;
        }
        adoptedPrime = null;
      }
      if (graph) {
        const activeGraph = graph;
        graph = null;
        teardownRemoteAudioGraph(activeGraph, false);
      }
      if (activeNative) {
        const nativeState = activeNative;
        activeNative = null;
        void teardownNativeCapture(nativeState, false);
      }
      markMicReleased();
      return null;
    }

    if (audioDrainPromise) {
      return audioDrainPromise;
    }

    const primeRef = adoptedPrime;
    const activeGraphRef = graph;
    const nativeRef = activeNative;
    const directNativeRef = pendingDirectNative;
    const primeNativePending = Boolean(
      primeRef && (primeRef.native || (!primeRef.captureReady && !primeRef.captureEnded && primeRef.failedReason === null)),
    );

    if (!primeNativePending && !nativeRef && !directNativeRef) {
      if (primeRef) {
        if (!cancelled && !hasDeliveredTranscript && primeRef.pcmQueue.length > 0) {
          const primeSamples = Int16Array.from(primeRef.pcmQueue);
          appendBoundedSamples(pcmQueue, primeSamples, readyReceived ? Number.MAX_SAFE_INTEGER : MAX_PRE_READY_PCM_SAMPLES);
          appendBoundedSamples(fallbackPcmQueue, primeSamples, MAX_FALLBACK_PCM_SAMPLES);
        }
        primeRef.cancelled = true;
        primeRef.sink.active = false;
        primeRef.pcmQueue.length = 0;
        primeRef.onAdoptedReady = null;
        primeRef.onAdoptedError = null;
        if (primeRef.graph) {
          const pg = primeRef.graph;
          primeRef.graph = null;
          teardownRemoteAudioGraph(pg, !cancelled, enqueueSamples);
        }
        adoptedPrime = null;
      }
      if (activeGraphRef) {
        graph = null;
        teardownRemoteAudioGraph(activeGraphRef, !cancelled, enqueueSamples);
      }
      if (activeSink) {
        activeSink.active = false;
        activeSink = null;
      }
      markMicReleased();
      return null;
    }

    const drainTask = (async () => {
      if (primeRef) {
        if (!primeRef.captureReady && !primeRef.captureEnded && primeRef.failedReason === null) {
          primeRef.stopOnReady = true;
          await primeRef.micPromise.catch(() => null);
        }
        if (primeRef.graph) {
          const pg = primeRef.graph;
          primeRef.graph = null;
          teardownRemoteAudioGraph(pg, !cancelled, enqueueSamples);
        }
        if (primeRef.native) {
          const pn = primeRef.native;
          primeRef.native = null;
          await teardownNativeCapture(pn, true);
        }
        if (!cancelled && !hasDeliveredTranscript && primeRef.pcmQueue.length > 0) {
          const primeSamples = Int16Array.from(primeRef.pcmQueue);
          appendBoundedSamples(pcmQueue, primeSamples, readyReceived ? Number.MAX_SAFE_INTEGER : MAX_PRE_READY_PCM_SAMPLES);
          appendBoundedSamples(fallbackPcmQueue, primeSamples, MAX_FALLBACK_PCM_SAMPLES);
        }
        primeRef.cancelled = true;
        primeRef.sink.active = false;
        primeRef.pcmQueue.length = 0;
        primeRef.onAdoptedReady = null;
        primeRef.onAdoptedError = null;
        if (adoptedPrime === primeRef) {
          adoptedPrime = null;
        }
      }
      if (pendingDirectNative) {
        const pn = pendingDirectNative;
        await pn.promise.catch(() => null);
        if (pendingDirectNative === pn) {
          pendingDirectNative = null;
        }
      }
      if (graph) {
        const activeGraph = graph;
        graph = null;
        teardownRemoteAudioGraph(activeGraph, !cancelled, enqueueSamples);
      }
      if (activeNative) {
        const nativeState = activeNative;
        activeNative = null;
        await teardownNativeCapture(nativeState, true);
      }
      if (activeSink) {
        activeSink.active = false;
        activeSink = null;
      }
      markMicReleased();
    })();
    audioDrainPromise = drainTask;
    return drainTask;
  };

  const runAfterDrain = (abortDrain: boolean, fn: () => void) => {
    const p = drainOrAbortAudio(abortDrain);
    if (p) {
      void p.finally(fn);
    } else {
      fn();
    }
  };

  const stopCaptureBeforeDrain = async () => {
    const p = drainOrAbortAudio(false);
    if (p) await p;
  };

  const cleanupWs = () => {
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    if (ws) {
      const socket = ws;
      ws = null;
      try {
        socket.close(1000, 'session_done');
      } catch { /* ignore */ }
    }
  };

  const flushPcmChunks = (forceRemainder: boolean) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !readyReceived || terminated || cancelled) return;
    const maxSamples = Math.floor(REMOTE_VOICE_MAX_PCM_CHUNK_BYTES / 2);
    while (pcmQueue.length >= PCM_TARGET_CHUNK_SAMPLES || (forceRemainder && pcmQueue.length > 0)) {
      const take = Math.min(maxSamples, forceRemainder ? pcmQueue.length : PCM_TARGET_CHUNK_SAMPLES);
      const chunk = pcmQueue.splice(0, take);
      const int16 = new Int16Array(chunk);
      const pcmBase64 = encodeInt16PcmToBase64(int16);
      try {
        ws.send(JSON.stringify({ type: 'voice.session.audio', sessionId, pcmBase64 }));
      } catch {
        break;
      }
    }
  };

  const settleReady = (outcome: { ok: boolean; reason?: string }) => {
    if (readySettled) return;
    if (outcome.ok && (terminated || cancelled)) return;
    readySettled = true;
    if (readyTimer !== null) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
    resolveReady(outcome);
  };

  const cancelOrStopEarly = () => {
    cancelled = true;
    terminated = true;
    terminalReason = 'cancelled';
    drainOrAbortAudio(true);
    pcmQueue.length = 0;
    fallbackPcmQueue.length = 0;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'voice.session.abort', sessionId }));
      } catch { /* ignore */ }
    }
    resolveEnd?.();
    cleanupWs();
    settleReady({ ok: false, reason: 'cancelled' });
  };

  if (opts.signal?.aborted) {
    cancelRemoteVoiceCapturePrime();
    return { ok: false, cancelled: true, reason: 'cancelled' };
  }
  const onAbortSignal = () => cancelOrStopEarly();
  opts.signal?.addEventListener('abort', onAbortSignal, { once: true });

  const handle: ActiveRemoteVoiceSessionHandle = {
    micReleased: micReleasedPromise,
    stop: async (abort = false) => {
      if (abort) {
        cancelOrStopEarly();
        return;
      }
      stoppedByCaller = true;
      await stopCaptureBeforeDrain();
      if (!readyReceived) {
        const outcome = await readyPromise;
        if (!outcome.ok || cancelled || terminated || !readyReceived) {
          cleanupWs();
          return;
        }
      }
      flushPcmChunks(true);
      if (ws && ws.readyState === WebSocket.OPEN && !endReceived) {
        if (!stopSent) {
          stopSent = true;
          try {
            ws.send(JSON.stringify({ type: 'voice.session.stop', sessionId }));
          } catch { /* ignore */ }
        }
        await new Promise<void>((res) => {
          let settled = false;
          let drainTimer: ReturnType<typeof setTimeout> | null = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (drainTimer !== null) {
              clearTimeout(drainTimer);
              drainTimer = null;
            }
            resolveEnd = null;
            res();
          };
          resolveEnd = finish;
          drainTimer = setTimeout(finish, stopDrainMs);
        });
      }
      cleanupWs();
    },
  };

  try {
    const nativeCapture = getNativeRawPcmCapture();
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const AC = getAudioContextConstructor();
    const canWebAudio = Boolean(nav?.mediaDevices?.getUserMedia && AC);
    if (!nativeCapture && !nav?.mediaDevices?.getUserMedia) {
      cancelRemoteVoiceCapturePrime();
      return { ok: false, cancelled: false, reason: 'get_user_media_unavailable' };
    }
    if (!nativeCapture && !AC) {
      cancelRemoteVoiceCapturePrime();
      return { ok: false, cancelled: false, reason: 'audio_context_unavailable' };
    }

    const fetchTicketFn = opts.fetchTicket ?? readOptionalApiMethod('fetchRemoteVoiceWsTicket');
    if (!fetchTicketFn) {
      const drainedPrime = await drainRemoteVoiceCapturePrimePcm();
      return {
        ok: false,
        cancelled: false,
        reason: 'ws_ticket_unavailable',
        ...(drainedPrime.length > 0 ? { bufferedPcm: drainedPrime } : {}),
      };
    }

    let setupFailed = false;
    const beginTermination = (reason: string): boolean => {
      if (cancelled || terminated) return false;
      terminated = true;
      terminalReason = reason;
      setupFailed = true;
      if (readyTimer !== null) {
        clearTimeout(readyTimer);
        readyTimer = null;
      }
      return true;
    };

    const onSessionFrame = (level: number, samples: Int16Array) => {
      if (cancelled) return;
      opts.onLevel?.(level);
      enqueueSamples(samples);
      if (!terminated && !setupFailed) {
        flushPcmChunks(false);
      }
    };

    const failAudioSetup = (reason: string) => {
      if (beginTermination(reason)) {
        runAfterDrain(false, () => {
          cleanupWs();
          settleReady({ ok: false, reason });
        });
      }
    };

    const startCapturePipeline = (micStream: MediaStream, sink: AudioFrameSink): boolean => {
      if (cancelled || terminated || setupFailed || stoppedByCaller) {
        stopMediaStreamTracks(micStream);
        return false;
      }
      const builtGraph = buildRemoteAudioGraph(AC!, micStream, sink);
      activeSink = sink;
      graph = builtGraph;
      opts.onCaptureStarted?.(handle);
      return true;
    };

    const startWebFallbackCapture = (): Promise<MediaStream | null> => {
      if (!canWebAudio || !nav?.mediaDevices?.getUserMedia) {
        return Promise.resolve(null);
      }
      const directSink: AudioFrameSink = {
        active: true,
        onFrame: onSessionFrame,
      };
      if (_preferredBuiltInMicDeviceId === null) {
        void refreshPreferredBuiltInMicDeviceId();
      }
      return acquireRemoteMicStream(
        nav.mediaDevices,
        _preferredBuiltInMicDeviceId,
        () => !cancelled && !terminated && !setupFailed && !stoppedByCaller,
      )
        .then((acquired) => {
          _remoteMicPermissionKnownGranted = true;
          if (_preferredBuiltInMicDeviceId === null) {
            void refreshPreferredBuiltInMicDeviceId();
          }
          if (!startCapturePipeline(acquired, directSink)) return null;
          return acquired;
        })
        .catch((err) => {
          if (isMicPermissionDeniedError(err)) {
            _remoteMicPermissionKnownGranted = false;
          }
          failAudioSetup(formatMicCaptureErrorReason(err));
          return null;
        });
    };

    const adoptPrimedCapture = (prime: PrimedRemoteVoiceCapture) => {
      if (cancelled) {
        prime.cancelled = true;
        prime.sink.active = false;
        prime.pcmQueue.length = 0;
        if (prime.graph) {
          teardownRemoteAudioGraph(prime.graph, false);
          prime.graph = null;
        }
        if (prime.native) {
          void teardownNativeCapture(prime.native, false);
          prime.native = null;
        }
        adoptedPrime = null;
        return;
      }
      if (terminated || setupFailed || stoppedByCaller) {
        // Non-abort drain owns extracting prime.pcmQueue after prime.micPromise / stopOnReady
        // drain completes; clearing here while drainOrAbortAudio awaits :1265 would lose pre-roll/tail PCM.
        if (adoptedPrime === prime) {
          return;
        }
        if (!hasDeliveredTranscript && prime.pcmQueue.length > 0) {
          const primeSamples = Int16Array.from(prime.pcmQueue);
          appendBoundedSamples(pcmQueue, primeSamples, readyReceived ? Number.MAX_SAFE_INTEGER : MAX_PRE_READY_PCM_SAMPLES);
          appendBoundedSamples(fallbackPcmQueue, primeSamples, MAX_FALLBACK_PCM_SAMPLES);
        }
        prime.cancelled = true;
        prime.sink.active = false;
        prime.pcmQueue.length = 0;
        if (prime.graph) {
          teardownRemoteAudioGraph(prime.graph, true, enqueueSamples);
          prime.graph = null;
        }
        if (prime.native) {
          void teardownNativeCapture(prime.native, true);
          prime.native = null;
        }
        return;
      }
      if (!prime.graph && !prime.native && !prime.captureEnded) return;
      if (prime.graph) {
        graph = prime.graph;
        prime.graph = null;
      }
      if (prime.native) {
        activeNative = prime.native;
        prime.native = null;
      }
      adoptedPrime = null;
      if (!prime.captureEnded) {
        activeSink = prime.sink;
      }
      if (prime.pcmQueue.length > 0) {
        const primeSamples = Int16Array.from(prime.pcmQueue);
        appendBoundedSamples(pcmQueue, primeSamples, readyReceived ? Number.MAX_SAFE_INTEGER : MAX_PRE_READY_PCM_SAMPLES);
        if (!hasDeliveredTranscript && !cancelled) {
          appendBoundedSamples(fallbackPcmQueue, primeSamples, MAX_FALLBACK_PCM_SAMPLES);
        }
        prime.pcmQueue.length = 0;
      }
      if (!prime.captureEnded) {
        prime.sink.onFrame = onSessionFrame;
      }
      opts.onCaptureStarted?.(handle);
      if (!prime.captureEnded && prime.hasLevel) {
        opts.onLevel?.(prime.lastLevel);
      }
    };

    const candidatePrime = _primedCapture && !_primedCapture.cancelled && !_primedCapture.adopted
      ? _primedCapture
      : null;
    if (candidatePrime && candidatePrime.failedReason !== null) {
      const primeErr = candidatePrime.failedReason;
      const primePermDenied = candidatePrime.failedPermission;
      _primedCapture = null;
      if (primePermDenied) {
        opts.signal?.removeEventListener('abort', onAbortSignal);
        markMicReleased();
        return { ok: false, cancelled: false, reason: primeErr };
      }
    }

    let micPromise: Promise<MediaStream | null>;
    if (candidatePrime && candidatePrime.failedReason === null) {
      candidatePrime.adopted = true;
      _primedCapture = null;
      adoptedPrime = candidatePrime;
      if (candidatePrime.captureReady && (candidatePrime.graph || candidatePrime.native || candidatePrime.captureEnded)) {
        adoptPrimedCapture(candidatePrime);
        micPromise = candidatePrime.micPromise;
      } else {
        candidatePrime.onAdoptedReady = adoptPrimedCapture;
        let nativeFallbackPromise: Promise<MediaStream | null> | null = null;
        candidatePrime.onAdoptedError = (reason) => {
          if (candidatePrime.native === null && !candidatePrime.webAttempted && canWebAudio && !candidatePrime.failedPermission) {
            adoptedPrime = null;
            nativeFallbackPromise = startWebFallbackCapture();
            return;
          }
          failAudioSetup(reason);
        };
        micPromise = candidatePrime.micPromise.then((res) => nativeFallbackPromise ?? res);
      }
    } else if (nativeCapture) {
      if (_preferredBuiltInMicDeviceId === null) {
        void refreshPreferredBuiltInMicDeviceId();
      }
      const directSink: AudioFrameSink = {
        active: true,
        onFrame: onSessionFrame,
      };
      const nativeState: NativeCaptureState = { bridge: nativeCapture, listenerPromise: null };
      const pendingEntry: { state: NativeCaptureState; sink: AudioFrameSink; promise: Promise<unknown> } = {
        state: nativeState,
        sink: directSink,
        promise: Promise.resolve(),
      };
      pendingDirectNative = pendingEntry;
      const listenerP = nativeCapture.addListener(STREAMING_SPEECH_RAW_PCM_EVENT, (ev: StreamingSpeechRawPcmEvent) => {
        if (cancelled || !directSink.active) return;
        const samples = decodeBase64ToInt16Pcm(ev.pcmBase64);
        const level = typeof ev.level === 'number' && Number.isFinite(ev.level) ? ev.level : 0;
        directSink.onFrame(level, samples);
      });
      nativeState.listenerPromise = listenerP;
      micPromise = listenerP
        .then(() => {
          if (cancelled || terminated || setupFailed || stoppedByCaller) {
            if (pendingDirectNative === pendingEntry) pendingDirectNative = null;
            directSink.active = false;
            void teardownNativeCapture(nativeState, false);
            return null;
          }
          return nativeCapture.startRawPcmCapture().then(() => {
            if (pendingDirectNative === pendingEntry) pendingDirectNative = null;
            if (cancelled) {
              directSink.active = false;
              void teardownNativeCapture(nativeState, false);
              return null;
            }
            _remoteMicPermissionKnownGranted = true;
            activeSink = directSink;
            activeNative = nativeState;
            if (!terminated && !setupFailed && !stoppedByCaller) {
              opts.onCaptureStarted?.(handle);
            }
            return null;
          });
        })
        .catch((err) => {
          if (pendingDirectNative === pendingEntry) pendingDirectNative = null;
          directSink.active = false;
          void teardownNativeCapture(nativeState, false);
          if (isCapacitorUnimplementedError(err)) {
            markNativeRawPcmCaptureUnsupported();
          }
          if (isMicPermissionDeniedError(err)) {
            _remoteMicPermissionKnownGranted = false;
            failAudioSetup(formatMicCaptureErrorReason(err));
            return null;
          }
          if (canWebAudio && !cancelled && !terminated && !setupFailed && !stoppedByCaller) {
            return startWebFallbackCapture();
          }
          failAudioSetup(formatMicCaptureErrorReason(err));
          return null;
        });
      pendingEntry.promise = micPromise;
    } else {
      micPromise = startWebFallbackCapture();
    }

    const ticketPromise = fetchTicketFn().catch((err) => {
      const reason = err instanceof Error ? err.message : 'ws_ticket_failed';
      if (beginTermination(reason)) {
        runAfterDrain(cancelled, () => {
          cleanupWs();
          settleReady({ ok: false, reason });
        });
      }
      throw err;
    });

    const ticketRace = await Promise.race([
      ticketPromise.then((res) => ({ ok: true as const, res })),
      readyPromise.then((outcome) => ({ ok: false as const, outcome })),
    ]);
    if (!ticketRace.ok) {
      void ticketPromise.catch(() => {});
      void micPromise.catch(() => {});
      opts.signal?.removeEventListener('abort', onAbortSignal);
      const drainP = drainOrAbortAudio(cancelled);
      if (drainP) await drainP;
      cleanupWs();
      const bufferedPcm = cancelled ? undefined : consumeFallbackPcm();
      return {
        ok: false,
        cancelled,
        reason: ticketRace.outcome.reason || terminalReason || 'cancelled',
        ...(bufferedPcm && bufferedPcm.length > 0 ? { bufferedPcm } : {}),
      };
    }
    const ticketRes = ticketRace.res;
    if (cancelled) {
      drainOrAbortAudio(true);
      fallbackPcmQueue.length = 0;
      return { ok: false, cancelled: true, reason: 'cancelled' };
    }
    if (terminated) {
      const drainP = drainOrAbortAudio(false);
      if (drainP) await drainP;
      cleanupWs();
      const bufferedPcm = consumeFallbackPcm();
      return {
        ok: false,
        cancelled: false,
        reason: terminalReason || 'remote_start_failed',
        ...(bufferedPcm && bufferedPcm.length > 0 ? { bufferedPcm } : {}),
      };
    }

    const wsBase = opts.getWsBaseUrl ? opts.getWsBaseUrl() : getApiBaseUrlSafe();
    const wsUrl = `${wsBase.replace(/^http/, 'ws').replace(/\/$/, '')}${REMOTE_VOICE_WS_PATH}?ticket=${encodeURIComponent(ticketRes.ticket)}`;
    ws = opts.createSocket ? opts.createSocket(wsUrl) : new WebSocket(wsUrl);
    let wsOpened = false;

    readyTimer = setTimeout(() => {
      const timeoutReason = wsOpened ? 'ready_timeout' : 'ws_open_timeout';
      if (!beginTermination(timeoutReason)) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'voice.session.abort', sessionId })); } catch { /* ignore */ }
      }
      runAfterDrain(false, () => {
        cleanupWs();
        settleReady({ ok: false, reason: timeoutReason });
      });
    }, readyTimeoutMs);

    ws.addEventListener('open', () => {
      wsOpened = true;
      if (cancelled || terminated || !ws) return;
      try {
        ws.send(JSON.stringify({
          type: 'voice.session.start',
          sessionId,
          targetDeviceId: opts.targetDeviceId,
          ...(opts.locale ? { locale: opts.locale } : {}),
          ...(opts.hotwords && opts.hotwords.length > 0 ? { hotwords: opts.hotwords } : {}),
          sampleRate: REMOTE_VOICE_SAMPLE_RATE,
        }));
      } catch {
        if (beginTermination('ws_send_failed')) {
          runAfterDrain(false, () => {
            cleanupWs();
            settleReady({ ok: false, reason: 'ws_send_failed' });
          });
        }
      }
    });

    ws.addEventListener('message', (event) => {
      if (cancelled || terminated) return;
      let frame: RemoteVoiceServerFrame;
      try {
        frame = JSON.parse(String((event as MessageEvent).data)) as RemoteVoiceServerFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object' || !('sessionId' in frame) || frame.sessionId !== sessionId) {
        return;
      }
      if (frame.type === 'voice.session.ready') {
        if (terminated || cancelled) return;
        readyReceived = true;
        flushPcmChunks(true);
        settleReady({ ok: true });
        return;
      }
      if (frame.type === 'voice.session.result') {
        const resolved = resolveSessionTranscriptResult(frame.text, frame.isFinal, lastNonEmptyText);
        lastNonEmptyText = resolved.nextLastNonEmptyText;
        if (!resolved.emit) {
          return;
        }
        if (resolved.text.trim()) {
          hasDeliveredTranscript = true;
          fallbackPcmQueue.length = 0;
        }
        opts.onResult(resolved.text, frame.isFinal);
        return;
      }
      if (frame.type === 'voice.session.end') {
        endReceived = true;
        if (!readyReceived) {
          if (!beginTermination('ws_closed')) return;
          runAfterDrain(cancelled, () => {
            cleanupWs();
            resolveEnd?.();
            settleReady({ ok: false, reason: 'ws_closed' });
          });
          return;
        }
        if (!beginTermination('session_end')) return;
        fallbackPcmQueue.length = 0;
        runAfterDrain(cancelled, () => {
          cleanupWs();
          resolveEnd?.();
          opts.onEnd?.();
        });
        return;
      }
      if (frame.type === 'voice.session.error') {
        endReceived = true;
        if (!beginTermination(frame.code)) return;
        runAfterDrain(cancelled, () => {
          cleanupWs();
          resolveEnd?.();
          if (!readyReceived) {
            settleReady({ ok: false, reason: frame.code });
            return;
          }
          if (!hasDeliveredTranscript && !cancelled) {
            const bufferedPcm = consumeFallbackPcm();
            const handled = opts.onFallback?.(frame.code, { bufferedPcm, stoppedByCaller });
            if (!opts.onFallback || handled === false) {
              opts.onError?.(frame.code);
            }
          } else {
            opts.onError?.(frame.code);
          }
        });
      }
    });

    ws.addEventListener('error', () => {
      if (!readyReceived && beginTermination('ws_error')) {
        runAfterDrain(false, () => {
          cleanupWs();
          settleReady({ ok: false, reason: 'ws_error' });
        });
      }
    });

    ws.addEventListener('close', () => {
      if (cancelled || terminated || endReceived) return;
      endReceived = true;
      if (!beginTermination('ws_closed')) return;
      runAfterDrain(cancelled, () => {
        resolveEnd?.();
        if (!readyReceived) {
          settleReady({ ok: false, reason: 'ws_closed' });
          return;
        }
        if (!hasDeliveredTranscript && !cancelled) {
          const bufferedPcm = consumeFallbackPcm();
          const handled = opts.onFallback?.('ws_closed', { bufferedPcm, stoppedByCaller });
          if (!opts.onFallback || handled === false) {
            opts.onEnd?.();
          }
        } else {
          opts.onEnd?.();
        }
      });
    });

    const outcome = await readyPromise;
    opts.signal?.removeEventListener('abort', onAbortSignal);
    if (!outcome.ok) {
      setupFailed = true;
      const drainP = drainOrAbortAudio(cancelled);
      if (drainP) await drainP;
      cleanupWs();
      const bufferedPcm = cancelled ? undefined : consumeFallbackPcm();
      return {
        ok: false,
        cancelled,
        reason: outcome.reason || terminalReason || 'remote_start_failed',
        ...(bufferedPcm && bufferedPcm.length > 0 ? { bufferedPcm } : {}),
      };
    }
    void micPromise;
    return { ok: true, handle };
  } catch (err) {
    opts.signal?.removeEventListener('abort', onAbortSignal);
    const drainP = drainOrAbortAudio(cancelled);
    if (drainP) await drainP;
    cleanupWs();
    const bufferedPcm = cancelled ? undefined : consumeFallbackPcm();
    return {
      ok: false,
      cancelled,
      reason: err instanceof Error ? err.message : 'remote_start_failed',
      ...(bufferedPcm && bufferedPcm.length > 0 ? { bufferedPcm } : {}),
    };
  }
}
