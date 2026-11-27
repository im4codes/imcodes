import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSameActiveOrigin } from './security.js';

const REMOTE_VOICE_MAX_PCM_CHUNK_BYTES = 64 * 1024;
const PC_LOCAL_MAX_PREFILL_PCM_BYTES = 16_000 * 30 * 2; // 30s @ 16kHz Int16 = 960KB
const REMOTE_VOICE_SAFE_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const REMOTE_VOICE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const REMOTE_VOICE_MAX_DEVICE_NAME_CHARS = 64;
const GENERIC_PC_DEVICE_NAME_RE = /^(?:localhost(?:\.localdomain)?|127\.0\.0\.1|::1)$/i;
const PC_VOICE_HOTWORDS_MAX_TERMS = 60;
const PC_VOICE_HOTWORDS_MAX_TERM_CHARS = 64;
const PC_VOICE_HOTWORDS_MAX_CONTEXT_CHARS = 1000;

export function normalizePcAppVoiceHotwordsTerms(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kept: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    if (kept.length >= PC_VOICE_HOTWORDS_MAX_TERMS) break;
    const clean = item
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PC_VOICE_HOTWORDS_MAX_TERM_CHARS)
      .trim();
    if (!clean) continue;
    const key = /^[\x20-\x7E]+$/.test(clean) ? clean.toLowerCase() : clean;
    if (seen.has(key)) continue;
    const sepLen = kept.length === 0 ? 0 : 2;
    if (totalChars + sepLen + clean.length > PC_VOICE_HOTWORDS_MAX_CONTEXT_CHARS) continue;
    seen.add(key);
    kept.push(clean);
    totalChars += sepLen + clean.length;
  }
  return kept.length > 0 ? kept : undefined;
}

export function normalizePcAppVoiceHotwordsContext(raw: unknown): string | undefined {
  const kept = normalizePcAppVoiceHotwordsTerms(raw);
  return kept ? kept.join(', ') : undefined;
}

export function normalizePcAppDeviceName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.(?:localdomain|local|lan)$/i, '')
    .trim();
  if (!cleaned || GENERIC_PC_DEVICE_NAME_RE.test(cleaned)) return undefined;
  const bounded = cleaned.slice(0, REMOTE_VOICE_MAX_DEVICE_NAME_CHARS).trim();
  return bounded || undefined;
}

function pickFirstValidPcAppDeviceName(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const normalized = normalizePcAppDeviceName(candidate);
    if (normalized) return normalized;
  }
  return undefined;
}

function readDarwinScutilValue(key: 'ComputerName' | 'LocalHostName'): Promise<string | null> {
  return new Promise((resolveOut) => {
    try {
      execFile('scutil', ['--get', key], { encoding: 'utf8', timeout: 1_500, windowsHide: true }, (err, stdout) => {
        if (err || typeof stdout !== 'string') {
          resolveOut(null);
          return;
        }
        const trimmed = stdout.trim();
        resolveOut(trimmed || null);
      });
    } catch {
      resolveOut(null);
    }
  });
}

function isValidRemoteVoiceId(value: unknown): value is string {
  return typeof value === 'string' && REMOTE_VOICE_SAFE_ID_RE.test(value);
}

function isValidPcmBase64Chunk(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length % 4 !== 0 || !REMOTE_VOICE_BASE64_RE.test(trimmed)) return false;
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0;
  const bytes = (trimmed.length / 4) * 3 - padding;
  return bytes > 0 && bytes % 2 === 0 && bytes <= REMOTE_VOICE_MAX_PCM_CHUNK_BYTES;
}

function splitBase64PcmIntoChunks(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.length % 4 !== 0 || !REMOTE_VOICE_BASE64_RE.test(trimmed)) return null;
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length === 0 || buf.length % 2 !== 0) return null;
  const bounded = buf.length > PC_LOCAL_MAX_PREFILL_PCM_BYTES
    ? buf.subarray(buf.length - PC_LOCAL_MAX_PREFILL_PCM_BYTES)
    : buf;
  const chunks: string[] = [];
  for (let offset = 0; offset < bounded.length; offset += REMOTE_VOICE_MAX_PCM_CHUNK_BYTES) {
    chunks.push(bounded.subarray(offset, Math.min(bounded.length, offset + REMOTE_VOICE_MAX_PCM_CHUNK_BYTES)).toString('base64'));
  }
  return chunks;
}

function formatRemoteVoiceModelLabel(choice: PcAppSpeechModelChoice): PcAppRemoteVoiceModelLabel | null {
  if (choice === 'qwen3-1.7b') return 'Qwen3-ASR 1.7B';
  if (choice === 'qwen3-0.6b') return 'Qwen3-ASR 0.6B';
  return null;
}

const PC_APP_REMOTE_ERROR_ALLOWLIST = new Set<string>([
  'provider_offline',
  'provider_not_ready',
  'provider_busy',
  'invalid_frame',
  'chunk_too_large',
  'session_timeout',
  'session_not_found',
  'unauthorized',
  'helper_error',
]);

const REMOTE_WORKER_WRITE_ERRNO_ALLOWLIST = new Set<string>([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'EINVAL',
  'ECONNRESET',
  'EBADF',
  'EIO',
  'EAGAIN',
]);

function sanitizeRemoteVoiceErrorCode(code: unknown): string {
  if (typeof code === 'string') {
    const trimmed = code.trim();
    if (PC_APP_REMOTE_ERROR_ALLOWLIST.has(trimmed)) {
      return trimmed;
    }
  }
  return 'helper_error';
}
import {
  choiceToSpeechVariant,
  getSpeechModelManifests,
  isValidSpeechModelChoice,
  PcAppSpeechModelDownloader,
  PcAppSpeechModelStore,
  WIN32_GPU_MIN_VRAM_MB,
  type PcAppSpeechModelChoice,
  type PcAppSpeechModelManifest,
  type PcAppSpeechModelStatus,
  type PcAppSpeechVariant,
} from './speech-models.js';

export const PC_APP_VOICE_CHANNELS = Object.freeze({
  getPermissions: 'imcodes:pc-voice:get-permissions',
  requestPermissions: 'imcodes:pc-voice:request-permissions',
  openPrivacySettings: 'imcodes:pc-voice:open-privacy-settings',
  startListening: 'imcodes:pc-voice:start',
  stopListening: 'imcodes:pc-voice:stop',
  finalizePcmListening: 'imcodes:pc-voice:finalize-pcm',
  getSpeechModel: 'imcodes:pc-voice:get-speech-model',
  setSpeechModel: 'imcodes:pc-voice:set-speech-model',
  getSpeechModelStatus: 'imcodes:pc-voice:get-speech-model-status',
  getInputDevices: 'imcodes:pc-voice:get-input-devices',
  getInputDevice: 'imcodes:pc-voice:get-input-device',
  setInputDevice: 'imcodes:pc-voice:set-input-device',
  event: 'imcodes:pc-voice:event',
  getRemoteProviderInfo: 'imcodes:pc-voice:get-remote-provider-info',
  startRemoteSession: 'imcodes:pc-voice:start-remote-session',
  pushRemotePcm: 'imcodes:pc-voice:push-remote-pcm',
  stopRemoteSession: 'imcodes:pc-voice:stop-remote-session',
  remoteEvent: 'imcodes:pc-voice:remote-event',
} as const);

export type PcAppRemoteVoiceModelChoice = 'qwen3-0.6b' | 'qwen3-1.7b';
export type PcAppRemoteVoiceModelLabel = 'Qwen3-ASR 0.6B' | 'Qwen3-ASR 1.7B';

export interface PcAppRemoteVoiceProviderInfo {
  deviceId: string;
  deviceName?: string;
  hostname?: string;
  localServerId?: string;
  model: PcAppRemoteVoiceModelChoice;
  modelLabel: PcAppRemoteVoiceModelLabel;
  ready: boolean;
  busy: boolean;
}

export type PcAppRemoteVoiceEvent =
  | { type: 'provider.info'; info: PcAppRemoteVoiceProviderInfo | null }
  | { type: 'voice.session.ready'; sessionId: string }
  | { type: 'voice.session.result'; sessionId: string; text: string; isFinal: boolean }
  | { type: 'voice.session.end'; sessionId: string }
  | { type: 'voice.session.error'; sessionId: string; code: string };

export interface PcAppInputDevice {
  uid: string;
  name: string;
  transport: string;
  isDefault: boolean;
  isPhysical: boolean;
}

export type PcAppMediaAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
export type PcAppPrivacyTarget = 'microphone' | 'speech';

export interface PcAppVoicePermissions {
  mic: PcAppMediaAccessStatus;
  speech: PcAppMediaAccessStatus | 'unavailable';
  platform: NodeJS.Platform;
  nativeSpeechAvailable: boolean;
}

export type PcAppVoiceEvent =
  | { type: 'loading'; variant?: string }
  | { type: 'ready'; variant?: string }
  | { type: 'start' }
  | { type: 'level'; value: number }
  | { type: 'result'; text: string; isFinal: boolean }
  | { type: 'error'; code: string; target?: 'mic' | 'speech'; message?: string }
  | { type: 'end' };

export interface PcAppIpcInvokeEventLike {
  sender: unknown;
  senderFrame?: { url?: string } | null;
}

export interface PcAppIpcMainLike {
  handle(
    channel: string,
    listener: (event: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown,
  ): void;
  removeHandler?(channel: string): void;
}

export interface PcAppVoiceControllerDeps {
  platform: NodeJS.Platform;
  arch?: string;
  userDataDir: string;
  speechModelsDir?: string;
  resourcesPath?: string;
  speechHelperPath?: string;
  winSpeechHelperPath?: string;
  linuxSpeechHelperPath?: string;
  mlxHelperPath?: string;
  winProvider?: 'auto' | 'directml' | 'cpu';
  linuxProvider?: 'auto' | 'cuda' | 'cpu';
  isMainWebContents: (sender: unknown) => boolean;
  getCurrentTrustedOrigin: () => string | null;
  getActiveOrigin: () => string | null;
  getTrustedOrigins: () => ReadonlySet<string>;
  getSenderUrl: () => string;
  sendToRenderer: (channel: string, payload: PcAppVoiceEvent | PcAppRemoteVoiceEvent) => void;
  getMediaAccessStatus?: (mediaType: 'microphone') => PcAppMediaAccessStatus;
  askForMediaAccess?: (mediaType: 'microphone') => Promise<boolean>;
  openSystemUrl?: (url: string) => Promise<void> | void;
  runHelperSync?: (binPath: string, args: string[]) => string;
  runHelperAsync?: (binPath: string, args: string[]) => Promise<string>;
  spawnHelper?: (binPath: string, args: string[]) => ChildProcess;
  buildDevHelper?: (outPath: string) => string | null;
  isMlxSupported?: boolean | (() => Promise<boolean> | boolean);
  fetchModel?: typeof fetch;
  mirrorOrigins?: readonly string[] | null;
  customMirrors?: readonly string[] | string | null;
  manifests?: Record<PcAppSpeechVariant, PcAppSpeechModelManifest>;
  locale?: string;
  timeZone?: string;
  onSpeechModelStatusChanged?: (status: PcAppSpeechModelStatus) => void;
  onInputDevicesChanged?: (devices: PcAppInputDevice[], selectedUid: string) => void;
  onVoiceEvent?: (event: PcAppVoiceEvent) => void;
  useResidentMlxWorker?: boolean;
  remoteSessionIdleTimeoutMs?: number;
  resolveDeviceName?: () => Promise<string | null> | string | null;
  resolveHostname?: () => Promise<string | null> | string | null;
  resolveDeviceIdentity?: () => Promise<{ deviceName?: string | null; hostname?: string | null }> | { deviceName?: string | null; hostname?: string | null };
  readDarwinSysctlValue?: (key: 'ComputerName' | 'LocalHostName') => Promise<string | null>;
  getEnvComputerName?: () => string | undefined;
  getOsHostname?: () => string;
  getLocalBoundServerId?: () => string | null;
}

const MAC_PRIVACY_URLS: Record<PcAppPrivacyTarget, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  speech: 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
};

export function resolvePrivacySettingsUrl(platform: NodeJS.Platform, target: unknown): string | null {
  if (target !== 'microphone' && target !== 'speech') return null;
  if (platform === 'darwin') {
    return MAC_PRIVACY_URLS[target];
  }
  if (platform === 'win32' && target === 'microphone') {
    return 'ms-settings:privacy-microphone';
  }
  return null;
}

function mapHelperStatus(raw: unknown): PcAppMediaAccessStatus {
  switch (raw) {
    case 'authorized':
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'restricted':
      return 'restricted';
    case 'not-determined':
      return 'not-determined';
    default:
      return 'unknown';
  }
}

function defaultRunHelperAsync(binPath: string, args: string[]): Promise<string> {
  return new Promise((resolveOut, rejectOut) => {
    execFile(binPath, args, { encoding: 'utf8', timeout: 35_000 }, (err, stdout) => {
      if (err) {
        rejectOut(err);
        return;
      }
      resolveOut(stdout);
    });
  });
}

function defaultBuildDevHelper(outPath: string, arch = process.arch === 'x64' ? 'x86_64' : 'arm64'): string | null {
  if (process.platform !== 'darwin') return null;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, '../../native/imcodes-speech.swift'),
    resolve(moduleDir, '../native/imcodes-speech.swift'),
  ];
  const srcPath = candidates.find((p) => existsSync(p));
  if (!srcPath) return null;
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    execFileSync(
      'swiftc',
      [
        '-O',
        '-target',
        `${arch}-apple-macosx12.0`,
        '-framework',
        'Cocoa',
        '-framework',
        'CoreGraphics',
        '-framework',
        'ApplicationServices',
        '-framework',
        'IOKit',
        srcPath,
        '-o',
        outPath,
      ],
      {
        stdio: 'pipe',
        timeout: 60_000,
      },
    );
    chmodSync(outPath, 0o755);
    try {
      execFileSync(
        'codesign',
        ['--force', '--sign', '-', '-i', 'codes.im.pc', outPath],
        { stdio: 'pipe', timeout: 15_000 },
      );
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) {
        throw err;
      }
    }
    return outPath;
  } catch {
    return null;
  }
}

export function createPcAppVoiceController(deps: PcAppVoiceControllerDeps) {
  const isDarwin = deps.platform === 'darwin';
  const isWin32 = deps.platform === 'win32';
  const isLinux = deps.platform === 'linux';
  const isOnnxPlatform = isWin32 || isLinux;
  let activeChild: ChildProcess | null = null;
  let activeChildIsMlx = false;
  let activeChildSource: 'in-app' | 'global' | undefined;
  let activeStopTimer: ReturnType<typeof setTimeout> | null = null;
  let cachedDevHelperPath: string | null = null;
  let cachedMlxSupport: boolean | null =
    !isDarwin || (deps.arch ?? process.arch) !== 'arm64' ? false : null;
  let cachedWinOnnxSupport: boolean | null = isOnnxPlatform ? null : false;
  let cachedWinGpuName: string | null = null;
  let cachedWinVramMb: number | null = null;
  let cachedWinProvider: 'directml' | 'cuda' | 'cpu' = isLinux
    ? (deps.linuxProvider === 'cuda' ? 'cuda' : 'cpu')
    : (deps.winProvider === 'directml' ? 'directml' : 'cpu');
  let lastProgressNotifiedBucket = -1;
  let lastProgressNotifiedState: PcAppSpeechModelStatus['state'] | null = null;
  let lastProgressNotifiedDownloading: PcAppSpeechVariant | null = null;
  let lastProgressNotifiedMlx: boolean | null = isOnnxPlatform ? cachedWinOnnxSupport : cachedMlxSupport;
  let lastProgressNotifiedAt = 0;

  interface ActiveWorkerUtterance {
    source?: 'in-app' | 'global' | 'remote';
    sessionId?: string;
    remoteEnded?: boolean;
    stopRequested?: boolean;
    onEvent?: (event: PcAppVoiceEvent) => void;
    loggedFirstLevel: boolean;
    loggedFirstResult: boolean;
    waitersForEnd: Array<() => void>;
  }

  interface ResidentMlxWorker {
    proc: ChildProcess;
    variant: PcAppSpeechVariant;
    modelDir: string;
    state: 'starting' | 'loading' | 'ready' | 'stopping';
    stdoutBuffer: string;
    stderrBuffer: string;
    utterance: ActiveWorkerUtterance | null;
    awaitingAbortedEnd?: boolean;
    abortedEndWait: {
      promise: Promise<boolean>;
      resolve: (drained: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null;
    killTimer: ReturnType<typeof setTimeout> | null;
  }

  const SYSTEM_SPEECH_STOP_TIMEOUT_MS = 2_200;
  // Local Qwen3-ASR full-utterance final re-decode runs up to 30s of audio (and CPU ONNX can exceed real-time).
  const QWEN_LOCAL_FINALIZE_TIMEOUT_MS = 45_000;
  // Bounded wait for an aborted resident worker to emit its terminating `end` before isolating it cleanly.
  const ABORT_END_DRAIN_TIMEOUT_MS = 250;
  const DEFAULT_REMOTE_SESSION_IDLE_TIMEOUT_MS = 30_000;
  const remoteSessionIdleTimeoutMs =
    typeof deps.remoteSessionIdleTimeoutMs === 'number'
    && Number.isFinite(deps.remoteSessionIdleTimeoutMs)
    && deps.remoteSessionIdleTimeoutMs > 0
      ? deps.remoteSessionIdleTimeoutMs
      : DEFAULT_REMOTE_SESSION_IDLE_TIMEOUT_MS;
  let mlxWorker: ResidentMlxWorker | null = null;
  let activeWorkerUtterance: ActiveWorkerUtterance | null = null;
  let startRequestSeq = 0;
  interface PendingStartRequest {
    seq: number;
    source?: 'in-app' | 'global';
    finalizeOnly: boolean;
    aborted: boolean;
    wakeOnCancel?: () => void;
  }
  let pendingStartRequest: PendingStartRequest | null = null;
  let activeRemoteSession: { sessionId: string; utt: ActiveWorkerUtterance } | null = null;
  let remoteStopTimer: ReturnType<typeof setTimeout> | null = null;
  let remoteIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let workerSpawnInFlight: { variant: PcAppSpeechVariant; promise: Promise<ResidentMlxWorker | null> } | null = null;
  let serveUnsupported = false;
  let localBackendPermanentlyUnavailable = false;
  let controllerDisposed = false;
  let lastRemoteInfoSignature = '';
  let remoteBridgeActivated = false;
  let resolvedDeviceName: string | undefined;
  let resolvedHostname: string | undefined;
  let deviceNameResolved = false;
  let deviceNamePromise: Promise<string | undefined> | null = null;
  const remoteSubscribers = new Set<(event: PcAppRemoteVoiceEvent) => void>();

  const voiceDeviceIdPath = join(deps.userDataDir, 'voice-device-id.json');
  const loadOrCreateVoiceDeviceId = (): string => {
    try {
      const raw = readFileSync(voiceDeviceIdPath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown; deviceId?: unknown } | null;
      if (parsed && parsed.version === 1 && isValidRemoteVoiceId(parsed.deviceId)) {
        return parsed.deviceId;
      }
    } catch {
      // Generate a new persistent UUID below.
    }
    const generated = randomUUID();
    const tmpPath = `${voiceDeviceIdPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(deps.userDataDir, { recursive: true, mode: 0o700 });
      writeFileSync(tmpPath, JSON.stringify({ version: 1, deviceId: generated }, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, voiceDeviceIdPath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Fail soft when userDataDir is unwritable.
      }
    }
    return generated;
  };
  const voiceDeviceId = loadOrCreateVoiceDeviceId();

  const shouldUseResidentMlxWorker = (): boolean =>
    !controllerDisposed && !serveUnsupported && (deps.useResidentMlxWorker ?? (deps.spawnHelper === undefined));

  const modelStore = new PcAppSpeechModelStore(deps.userDataDir);
  const loadedModel = modelStore.load(isOnnxPlatform ? 'qwen3-0.6b' : 'system');
  let selectedModel: PcAppSpeechModelChoice = loadedModel;
  let pendingStartupModel: Exclude<PcAppSpeechModelChoice, 'system'> | null =
    loadedModel !== 'system' ? loadedModel : null;
  const inputDeviceStorePath = join(deps.userDataDir, 'speech-input-device.json');
  const loadSelectedInputDevice = (): string => {
    try {
      const raw = readFileSync(inputDeviceStorePath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown; uid?: unknown } | null;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return 'auto';
      const uid = typeof parsed.uid === 'string' ? parsed.uid.trim() : '';
      return uid || 'auto';
    } catch {
      return 'auto';
    }
  };
  const saveSelectedInputDevice = (uid: string): void => {
    const tmpPath = `${inputDeviceStorePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(deps.userDataDir, { recursive: true, mode: 0o700 });
      writeFileSync(tmpPath, JSON.stringify({ version: 1, uid }, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmpPath, inputDeviceStorePath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Fail soft when userDataDir is unwritable.
      }
    }
  };
  let selectedInputDevice: string = loadSelectedInputDevice();
  let cachedInputDevices: PcAppInputDevice[] = [];
  type VariantDownloadMeta = {
    state: 'idle' | 'downloading' | 'ready' | 'failed';
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
    error?: string;
  };
  let downloadingVariant: PcAppSpeechVariant | null = null;
  let targetModelAfterDownload: Exclude<PcAppSpeechModelChoice, 'system'> | null = null;
  let lastStatusVariant: PcAppSpeechVariant | null = null;

  const voiceLogPath = join(deps.userDataDir, 'voice.log');
  const VOICE_LOG_MAX_BYTES = 64 * 1024;
  const appendVoiceLog = (message: string): void => {
    try {
      mkdirSync(dirname(voiceLogPath), { recursive: true });
      const clean = message.replaceAll('\r', ' ').replaceAll('\n', ' | ').slice(0, 2048);
      const entry = `[${new Date().toISOString()}] ${clean}\n`;
      if (existsSync(voiceLogPath)) {
        const st = statSync(voiceLogPath);
        if (st.size + Buffer.byteLength(entry) > VOICE_LOG_MAX_BYTES) {
          const prev = readFileSync(voiceLogPath, 'utf8');
          const keepBytes = Math.max(0, Math.floor(VOICE_LOG_MAX_BYTES / 2));
          const tail = Buffer.from(prev, 'utf8').subarray(-keepBytes).toString('utf8');
          const firstNewline = tail.indexOf('\n');
          const trimmed = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
          writeFileSync(voiceLogPath, `${trimmed}${entry}`, 'utf8');
          return;
        }
      }
      appendFileSync(voiceLogPath, entry, 'utf8');
    } catch {
      // Best-effort diagnostics must never throw or block voice input.
    }
  };

  const resolveWinSpeechHelperPath = (): string | null => {
    if (!isWin32) return null;
    if (deps.winSpeechHelperPath) return deps.winSpeechHelperPath;
    if (deps.speechHelperPath && deps.speechHelperPath.toLowerCase().endsWith('.exe')) {
      return deps.speechHelperPath;
    }
    if (deps.resourcesPath) {
      const packaged = join(deps.resourcesPath, 'imcodes-speech-win.exe');
      if (existsSync(packaged)) return packaged;
    }
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDir, '../../native/win/build/Release/imcodes-speech-win.exe'),
      resolve(moduleDir, '../../native/win/build/imcodes-speech-win.exe'),
      resolve(moduleDir, '../native/win/build/Release/imcodes-speech-win.exe'),
      resolve(moduleDir, '../native/win/build/imcodes-speech-win.exe'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  };

  const resolveLinuxSpeechHelperPath = (): string | null => {
    if (!isLinux) return null;
    if (deps.linuxSpeechHelperPath) return deps.linuxSpeechHelperPath;
    if (deps.speechHelperPath && !deps.speechHelperPath.toLowerCase().endsWith('.exe')) {
      return deps.speechHelperPath;
    }
    if (deps.resourcesPath) {
      const packaged = join(deps.resourcesPath, 'imcodes-speech-linux');
      if (existsSync(packaged)) return packaged;
    }
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDir, '../../native/linux/build/imcodes-speech-linux'),
      resolve(moduleDir, '../native/linux/build/imcodes-speech-linux'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  };

  const resolveMlxHelperPath = (): string | null => {
    if (deps.platform !== 'darwin') return null;
    if ((deps.arch ?? process.arch) !== 'arm64') return null;
    if (deps.mlxHelperPath) return deps.mlxHelperPath;
    if (deps.resourcesPath) {
      const packaged = join(deps.resourcesPath, 'imcodes-speech-mlx');
      if (existsSync(packaged)) return packaged;
    }
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDir, '../../native/qwen3-asr/.build/release/imcodes-speech-mlx'),
      resolve(moduleDir, '../../native/qwen3-asr/.build/debug/imcodes-speech-mlx'),
      resolve(moduleDir, '../native/qwen3-asr/.build/release/imcodes-speech-mlx'),
      resolve(moduleDir, '../native/qwen3-asr/.build/debug/imcodes-speech-mlx'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  };

  const resolveLocalBackendHelperPath = (): string | null =>
    isWin32 ? resolveWinSpeechHelperPath() : isLinux ? resolveLinuxSpeechHelperPath() : resolveMlxHelperPath();

  const isLocalAsrSupportedSync = (): boolean =>
    isOnnxPlatform ? (cachedWinOnnxSupport ?? false) : (cachedMlxSupport ?? false);

  const variantManifestTotal = (variant: PcAppSpeechVariant): number =>
    downloader.getManifest(variant).files.reduce((sum, f) => sum + f.expectedSize, 0);

  const buildInitialVariantMeta = (): Record<PcAppSpeechVariant, VariantDownloadMeta> => ({
    '0.6b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 0 },
    '1.7b': { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 0 },
  });
  const variantMeta: Record<PcAppSpeechVariant, VariantDownloadMeta> = buildInitialVariantMeta();

  const variantToChoice = (variant: PcAppSpeechVariant): Exclude<PcAppSpeechModelChoice, 'system'> =>
    variant === '0.6b' ? 'qwen3-0.6b' : 'qwen3-1.7b';

  const getVariantStatusSync = (variant: PcAppSpeechVariant) => {
    const totalBytes = variantMeta[variant].totalBytes || variantManifestTotal(variant);
    const modelDir = downloader.getModelDirectory(variant);
    const cachedSupport = isOnnxPlatform ? cachedWinOnnxSupport : cachedMlxSupport;
    if (cachedSupport === false) {
      return {
        state: 'unsupported' as const,
        progress: 0,
        downloadedBytes: 0,
        totalBytes,
        modelDir,
      };
    }
    const meta = variantMeta[variant];
    if (downloadingVariant === variant || meta.state === 'downloading') {
      return {
        state: 'downloading' as const,
        progress: meta.progress,
        downloadedBytes: meta.downloadedBytes,
        totalBytes,
        modelDir,
      };
    }
    if (downloader.isModelReadySync(variant)) {
      return {
        state: 'ready' as const,
        progress: 1,
        downloadedBytes: totalBytes,
        totalBytes,
        modelDir,
      };
    }
    if (meta.state === 'failed') {
      return {
        state: 'failed' as const,
        progress: 0,
        downloadedBytes: 0,
        totalBytes,
        ...(meta.error ? { error: meta.error } : {}),
        modelDir,
      };
    }
    return {
      state: 'idle' as const,
      progress: 0,
      downloadedBytes: 0,
      totalBytes,
      modelDir,
    };
  };

  const getEffectiveSelectedModel = (): PcAppSpeechModelChoice => {
    const cachedSupport = isOnnxPlatform ? cachedWinOnnxSupport : cachedMlxSupport;
    if (cachedSupport === false) return 'system';
    const variant = choiceToSpeechVariant(selectedModel);
    if (!variant) return 'system';
    return downloader.isModelReadySync(variant) ? selectedModel : 'system';
  };

  const computeStatusSync = (): PcAppSpeechModelStatus => {
    const mlxSupported = isDarwin ? (cachedMlxSupport ?? false) : false;
    const localAsrSupported = isLocalAsrSupportedSync();
    const status06 = getVariantStatusSync('0.6b');
    const status17 = getVariantStatusSync('1.7b');
    const models = {
      'qwen3-0.6b': status06,
      'qwen3-1.7b': status17,
    };
    const downloadingModel = downloadingVariant ? variantToChoice(downloadingVariant) : null;
    const effectiveSelected = getEffectiveSelectedModel();
    const activeBackend: PcAppSpeechModelChoice = localAsrSupported ? effectiveSelected : 'system';
    const winMeta = isOnnxPlatform
      ? {
          localAsrSupported,
          executionProvider: activeBackend === 'system' ? ('system' as const) : cachedWinProvider,
          gpuName: cachedWinGpuName,
          vramMb: cachedWinVramMb,
          ...(isWin32
            ? {
                lowVramWarning:
                  selectedModel === 'qwen3-1.7b' &&
                  cachedWinVramMb !== null &&
                  cachedWinVramMb < WIN32_GPU_MIN_VRAM_MB,
              }
            : {}),
        }
      : {
          localAsrSupported,
          executionProvider: activeBackend === 'system' ? ('system' as const) : ('mlx' as const),
        };

    if (downloadingVariant) {
      const dlStatus = downloadingVariant === '0.6b' ? status06 : status17;
      return {
        selectedModel: effectiveSelected,
        activeBackend,
        state: 'downloading',
        progress: dlStatus.progress,
        downloadedBytes: dlStatus.downloadedBytes,
        totalBytes: dlStatus.totalBytes,
        mlxSupported,
        ...winMeta,
        modelDir: dlStatus.modelDir,
        downloadingModel,
        models,
      };
    }

    const cachedSupport = isOnnxPlatform ? cachedWinOnnxSupport : cachedMlxSupport;
    if (cachedSupport === false && (selectedModel !== 'system' || lastStatusVariant !== null)) {
      const refVariant = choiceToSpeechVariant(selectedModel) ?? lastStatusVariant ?? '0.6b';
      const refStatus = refVariant === '0.6b' ? status06 : status17;
      return {
        selectedModel: 'system',
        activeBackend: 'system',
        state: 'unsupported',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: refStatus.totalBytes,
        mlxSupported: false,
        ...winMeta,
        modelDir: refStatus.modelDir,
        downloadingModel: null,
        models,
      };
    }

    if (lastStatusVariant) {
      const lastStatus = lastStatusVariant === '0.6b' ? status06 : status17;
      if (lastStatus.state === 'failed') {
        return {
          selectedModel: effectiveSelected,
          activeBackend,
          state: 'failed',
          progress: 0,
          downloadedBytes: 0,
          totalBytes: lastStatus.totalBytes,
          mlxSupported,
          ...winMeta,
          ...(lastStatus.error ? { error: lastStatus.error } : {}),
          modelDir: lastStatus.modelDir,
          downloadingModel: null,
          models,
        };
      }
    }

    const activeVariant = choiceToSpeechVariant(effectiveSelected);
    if (activeVariant) {
      const activeStatus = activeVariant === '0.6b' ? status06 : status17;
      return {
        selectedModel: effectiveSelected,
        activeBackend,
        state: localAsrSupported ? activeStatus.state : 'unsupported',
        progress: localAsrSupported ? activeStatus.progress : 0,
        downloadedBytes: localAsrSupported ? activeStatus.downloadedBytes : 0,
        totalBytes: activeStatus.totalBytes,
        mlxSupported,
        ...winMeta,
        modelDir: activeStatus.modelDir,
        downloadingModel: null,
        models,
      };
    }

    return {
      selectedModel: 'system',
      activeBackend: 'system',
      state: 'idle',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      mlxSupported,
      ...winMeta,
      downloadingModel: null,
      models,
    };
  };

  const notifyStatusChanged = (force = false) => {
    const status = computeStatusSync();
    const clampedProgress = Number.isFinite(status.progress) ? Math.max(0, Math.min(1, status.progress)) : 0;
    const bucket = status.state === 'downloading' ? Math.floor(clampedProgress * 100000) : -1;
    const now = Date.now();
    const currentSupport = status.localAsrSupported ?? status.mlxSupported;
    const sameContext =
      status.state === lastProgressNotifiedState
      && downloadingVariant === lastProgressNotifiedDownloading
      && currentSupport === lastProgressNotifiedMlx;
    if (
      !force
      && sameContext
      && (bucket === lastProgressNotifiedBucket
        || (status.state === 'downloading' && now - lastProgressNotifiedAt < 200))
    ) {
      return;
    }
    lastProgressNotifiedState = status.state;
    lastProgressNotifiedBucket = bucket;
    lastProgressNotifiedDownloading = downloadingVariant;
    lastProgressNotifiedMlx = currentSupport;
    lastProgressNotifiedAt = now;
    deps.onSpeechModelStatusChanged?.(status);
    emitRemoteProviderInfoChanged();
  };

  const downloader = new PcAppSpeechModelDownloader({
    modelsBaseDir: deps.speechModelsDir ?? join(deps.userDataDir, 'speech-models'),
    platform: deps.platform,
    manifests: deps.manifests ?? getSpeechModelManifests(deps.platform),
    explicitMirrors: deps.mirrorOrigins,
    customMirrors: deps.customMirrors,
    locale: deps.locale,
    timeZone: deps.timeZone,
    fetchFn: deps.fetchModel,
    onProgress: (ev) => {
      const manifestTotal = variantManifestTotal(ev.variant);
      if (ev.state === 'downloading') {
        downloadingVariant = ev.variant;
      } else if (downloadingVariant === ev.variant) {
        downloadingVariant = null;
      }
      variantMeta[ev.variant] = {
        state: ev.state,
        progress: ev.progress,
        downloadedBytes: ev.downloadedBytes,
        totalBytes: ev.totalBytes || manifestTotal,
        ...(ev.error ? { error: ev.error } : {}),
      };
      notifyStatusChanged(ev.state !== 'downloading');
    },
  });

  if (selectedModel !== 'system') {
    const initVariant = choiceToSpeechVariant(selectedModel);
    if (initVariant && !downloader.isModelReadySync(initVariant)) {
      selectedModel = 'system';
    }
  }

  const checkMlxSupported = async (): Promise<boolean> => {
    if (isOnnxPlatform) {
      if (localBackendPermanentlyUnavailable || cachedWinOnnxSupport === false) {
        cachedWinOnnxSupport = false;
        return false;
      }
      if (cachedWinOnnxSupport !== null) return cachedWinOnnxSupport;
      const onnxBin = resolveLocalBackendHelperPath();
      if (!onnxBin) {
        cachedWinOnnxSupport = false;
        cachedWinGpuName = null;
        cachedWinVramMb = null;
        cachedWinProvider = 'cpu';
        return false;
      }
      try {
        const raw = deps.runHelperSync
          ? deps.runHelperSync(onnxBin, ['probe'])
          : await (deps.runHelperAsync ?? defaultRunHelperAsync)(onnxBin, ['probe']);
        if (localBackendPermanentlyUnavailable || cachedWinOnnxSupport === false) {
          cachedWinOnnxSupport = false;
          return false;
        }
        const parsed = JSON.parse(raw.trim()) as {
          ok?: unknown;
          gpuName?: unknown;
          vramMb?: unknown;
          provider?: unknown;
          cudaEligible?: unknown;
          localAsrSupported?: unknown;
        };
        const vram = typeof parsed.vramMb === 'number' && Number.isFinite(parsed.vramMb)
          ? Math.max(0, Math.round(parsed.vramMb))
          : 0;
        const probeGpuName = typeof parsed.gpuName === 'string' && parsed.gpuName.trim() ? parsed.gpuName.trim() : null;
        let probeProvider: 'cpu' | 'directml' | 'cuda';
        if (isLinux) {
          if (deps.linuxProvider === 'cpu') {
            probeProvider = 'cpu';
          } else {
            probeProvider = parsed.provider === 'cuda' || (deps.linuxProvider === 'cuda' && parsed.cudaEligible === true)
              ? 'cuda'
              : 'cpu';
          }
        } else {
          // Enforce benchmark policy: DirectML ONLY when dedicated VRAM >= 4096 MB; < 4 GB uses CPU.
          if (deps.winProvider === 'cpu') {
            probeProvider = 'cpu';
          } else if (deps.winProvider === 'directml') {
            probeProvider = vram >= WIN32_GPU_MIN_VRAM_MB ? 'directml' : 'cpu';
          } else {
            probeProvider = vram >= WIN32_GPU_MIN_VRAM_MB && parsed.provider === 'directml'
              ? 'directml'
              : 'cpu';
          }
        }
        if (localBackendPermanentlyUnavailable || cachedWinOnnxSupport === false) {
          cachedWinOnnxSupport = false;
          return false;
        }
        cachedWinGpuName = probeGpuName;
        cachedWinVramMb = vram;
        cachedWinProvider = probeProvider;
        cachedWinOnnxSupport = parsed.ok === true && parsed.localAsrSupported === true;
      } catch {
        if (!localBackendPermanentlyUnavailable && cachedWinOnnxSupport !== false) {
          cachedWinGpuName = null;
          cachedWinVramMb = 0;
          cachedWinProvider = 'cpu';
        }
        cachedWinOnnxSupport = false;
      }
      return cachedWinOnnxSupport;
    }

    if (deps.platform !== 'darwin' || (deps.arch ?? process.arch) !== 'arm64') {
      cachedMlxSupport = false;
      return false;
    }
    if (cachedMlxSupport !== null) return cachedMlxSupport;
    if (deps.isMlxSupported !== undefined) {
      try {
        cachedMlxSupport = Boolean(
          typeof deps.isMlxSupported === 'function'
            ? await deps.isMlxSupported()
            : deps.isMlxSupported,
        );
      } catch {
        cachedMlxSupport = false;
      }
      return cachedMlxSupport;
    }
    const mlxBin = resolveMlxHelperPath();
    if (!mlxBin) {
      cachedMlxSupport = false;
      return false;
    }
    try {
      const raw = deps.runHelperSync
        ? deps.runHelperSync(mlxBin, ['probe'])
        : await (deps.runHelperAsync ?? defaultRunHelperAsync)(mlxBin, ['probe']);
      const parsed = JSON.parse(raw.trim()) as { mlxSupported?: unknown };
      cachedMlxSupport = parsed.mlxSupported === true;
    } catch {
      cachedMlxSupport = false;
    }
    return cachedMlxSupport;
  };

  const startBackgroundDownload = (choice: Exclude<PcAppSpeechModelChoice, 'system'>): void => {
    const variant = choiceToSpeechVariant(choice);
    if (!variant) return;
    const totalBytes = variantManifestTotal(variant);
    downloadingVariant = variant;
    targetModelAfterDownload = choice;
    lastStatusVariant = variant;
    variantMeta[variant] = {
      state: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes,
    };
    notifyStatusChanged(true);
    void downloader.ensureDownloaded(variant).then((ok) => {
      if (downloadingVariant === variant) {
        downloadingVariant = null;
      }
      if (!ok) {
        if (targetModelAfterDownload === choice) {
          targetModelAfterDownload = null;
        }
        notifyStatusChanged(true);
        return;
      }
      variantMeta[variant] = {
        state: 'ready',
        progress: 1,
        downloadedBytes: totalBytes,
        totalBytes,
      };
      if (targetModelAfterDownload === choice) {
        targetModelAfterDownload = null;
        selectedModel = choice;
        modelStore.save(choice);
        void ensureResidentMlxWorker(variant, { skipVerify: true });
      }
      notifyStatusChanged(true);
    });
  };

  const triggerDownloadIfSelected = async (): Promise<void> => {
    const candidate = targetModelAfterDownload ?? pendingStartupModel ?? (selectedModel !== 'system' ? selectedModel : null);
    pendingStartupModel = null;
    if (!candidate) return;
    const variant = choiceToSpeechVariant(candidate);
    if (!variant) return;
    lastStatusVariant = variant;
    const supported = await checkMlxSupported();
    if (!supported) {
      selectedModel = 'system';
      notifyStatusChanged(true);
      return;
    }
    if (downloader.isModelReadySync(variant)) {
      const valid = await downloader.verifyModelFilesOnDisk(variant);
      if (valid) {
        const totalBytes = variantManifestTotal(variant);
        variantMeta[variant] = {
          state: 'ready',
          progress: 1,
          downloadedBytes: totalBytes,
          totalBytes,
        };
        selectedModel = candidate;
        notifyStatusChanged(true);
        void ensureResidentMlxWorker(variant, { skipVerify: true });
        return;
      }
    }
    startBackgroundDownload(candidate);
  };

  const isTrustedSender = (event: PcAppIpcInvokeEventLike): boolean => {
    if (!deps.isMainWebContents(event.sender)) return false;
    if (!deps.getCurrentTrustedOrigin()) return false;
    const frameUrl = event.senderFrame?.url || deps.getSenderUrl();
    return isSameActiveOrigin(frameUrl, deps.getActiveOrigin(), deps.getTrustedOrigins());
  };

  const assertTrustedSender = (event: PcAppIpcInvokeEventLike): void => {
    if (!isTrustedSender(event)) {
      throw new Error('Untrusted origin');
    }
  };

  const resolveSpeechHelperPath = (): string | null => {
    if (isWin32) {
      return resolveWinSpeechHelperPath();
    }
    if (isLinux) {
      return resolveLinuxSpeechHelperPath();
    }
    if (!isDarwin) return null;
    if (deps.speechHelperPath) return deps.speechHelperPath;
    if (deps.resourcesPath) {
      const packaged = join(deps.resourcesPath, 'imcodes-speech');
      if (existsSync(packaged)) return packaged;
    }
    if (cachedDevHelperPath && existsSync(cachedDevHelperPath)) {
      return cachedDevHelperPath;
    }
    const devOut = join(deps.userDataDir, 'bin', 'imcodes-speech');
    if (existsSync(devOut)) {
      cachedDevHelperPath = devOut;
      return devOut;
    }
    const built = (deps.buildDevHelper ?? defaultBuildDevHelper)(devOut);
    if (built) {
      cachedDevHelperPath = built;
    }
    return built;
  };

  const runHelper = async (args: string[]): Promise<{
    mic?: string;
    speech?: string;
    speechAvailable?: boolean;
  } | null> => {
    const bin = resolveSpeechHelperPath();
    if (!bin) return null;
    try {
      const raw = deps.runHelperSync
        ? deps.runHelperSync(bin, args)
        : await (deps.runHelperAsync ?? defaultRunHelperAsync)(bin, args);
      const parsed = JSON.parse(raw.trim()) as {
        mic?: string;
        speech?: string;
        speechAvailable?: boolean;
      };
      return parsed;
    } catch {
      return null;
    }
  };

  const getPermissions = async (): Promise<PcAppVoicePermissions> => {
    if (isOnnxPlatform) {
      const onnxBin = resolveLocalBackendHelperPath();
      if (!onnxBin) {
        return {
          mic: 'unknown',
          speech: 'unavailable',
          platform: deps.platform,
          nativeSpeechAvailable: false,
        };
      }
      return {
        mic: 'granted',
        speech: 'granted',
        platform: deps.platform,
        nativeSpeechAvailable: true,
      };
    }
    if (deps.platform !== 'darwin') {
      return {
        mic: 'unknown',
        speech: 'unavailable',
        platform: deps.platform,
        nativeSpeechAvailable: false,
      };
    }
    const sysMic = mapHelperStatus(deps.getMediaAccessStatus?.('microphone') ?? 'unknown');
    const helper = await runHelper(['status']);
    const helperMic = helper?.mic ? mapHelperStatus(helper.mic) : 'unknown';
    const mic: PcAppMediaAccessStatus = sysMic !== 'unknown' ? sysMic : helperMic;
    const speech = helper?.speech ? mapHelperStatus(helper.speech) : 'unavailable';
    return {
      mic,
      speech,
      platform: deps.platform,
      nativeSpeechAvailable: Boolean(resolveSpeechHelperPath()) && (helper?.speechAvailable ?? true),
    };
  };

  const requestPermissions = async (): Promise<PcAppVoicePermissions> => {
    if (deps.platform !== 'darwin') {
      return getPermissions();
    }
    let sysMic = mapHelperStatus(deps.getMediaAccessStatus?.('microphone') ?? 'unknown');
    if (sysMic === 'not-determined' && deps.askForMediaAccess) {
      try {
        const granted = await deps.askForMediaAccess('microphone');
        sysMic = granted ? 'granted' : mapHelperStatus(deps.getMediaAccessStatus?.('microphone') ?? 'denied');
      } catch {
        sysMic = 'denied';
      }
    }
    const helper = await runHelper(['request']);
    const mic: PcAppMediaAccessStatus = sysMic !== 'unknown'
      ? sysMic
      : mapHelperStatus(helper?.mic ?? 'unknown');
    const speech = helper?.speech ? mapHelperStatus(helper.speech) : 'unavailable';
    return {
      mic,
      speech,
      platform: deps.platform,
      nativeSpeechAvailable: Boolean(resolveSpeechHelperPath()) && (helper?.speechAvailable ?? true),
    };
  };

  const ensureMediaAccessOnWebPermissionRequest = async (): Promise<boolean> => {
    if (deps.platform !== 'darwin') return true;
    const current = mapHelperStatus(deps.getMediaAccessStatus?.('microphone') ?? 'unknown');
    if (current === 'granted') return true;
    if (current === 'denied' || current === 'restricted') return false;
    if (!deps.askForMediaAccess) return false;
    try {
      return await deps.askForMediaAccess('microphone');
    } catch {
      return false;
    }
  };

  const notifyVoiceEvent = (payload: PcAppVoiceEvent): void => {
    try {
      deps.onVoiceEvent?.(payload);
    } catch {
      // Never allow HUD or external voice-event listeners to break voice IPC.
    }
  };

  const logVoiceEvent = (
    payload: PcAppVoiceEvent,
    state: { loggedFirstLevel: boolean; loggedFirstResult: boolean },
  ): void => {
    if (payload.type === 'loading') {
      appendVoiceLog(`helper model loading variant=${payload.variant ?? '-'}`);
    } else if (payload.type === 'ready') {
      appendVoiceLog(`helper model ready variant=${payload.variant ?? '-'}`);
    } else if (payload.type === 'level' && !state.loggedFirstLevel && payload.value > 0.01) {
      state.loggedFirstLevel = true;
      appendVoiceLog(`first level value=${payload.value.toFixed(4)}`);
    } else if (payload.type === 'result') {
      const trimmed = payload.text.trim();
      if (!state.loggedFirstResult && trimmed) {
        state.loggedFirstResult = true;
        appendVoiceLog(
          `first result isFinal=${payload.isFinal} len=${trimmed.length} text=${JSON.stringify(trimmed.slice(0, 80))}`,
        );
      }
      if (payload.isFinal) {
        appendVoiceLog(`final result len=${trimmed.length} text=${JSON.stringify(trimmed.slice(0, 80))}`);
      }
    } else if (payload.type === 'error') {
      appendVoiceLog(`helper error code=${payload.code} target=${payload.target ?? '-'} message=${payload.message ?? '-'}`);
    }
  };

  const resolveUtteranceWaiters = (utt: ActiveWorkerUtterance): void => {
    const waiters = utt.waitersForEnd.splice(0, utt.waitersForEnd.length);
    for (const resolveWaiter of waiters) {
      resolveWaiter();
    }
  };

  const readDarwinValue = deps.readDarwinSysctlValue ?? readDarwinScutilValue;
  const readEnvComputerName = deps.getEnvComputerName ?? (() => process.env.COMPUTERNAME);
  const readOsHostname = deps.getOsHostname ?? osHostname;
  const resolveWindowsDeviceName = (): string | undefined =>
    pickFirstValidPcAppDeviceName(readEnvComputerName(), readOsHostname());

  const getSyncDeviceName = (): string | undefined => {
    if (deviceNameResolved) return resolvedDeviceName;
    if (deps.resolveDeviceName || deps.resolveDeviceIdentity) return undefined;
    return isWin32 ? resolveWindowsDeviceName() : normalizePcAppDeviceName(readOsHostname());
  };

  const getSyncHostname = (): string | undefined => {
    if (deviceNameResolved) return resolvedHostname;
    if (deps.resolveDeviceName || deps.resolveHostname || deps.resolveDeviceIdentity) return undefined;
    return normalizePcAppDeviceName(readOsHostname());
  };

  const getLocalServerIdSync = (): string | undefined => {
    try {
      const candidate = deps.getLocalBoundServerId?.();
      return isValidRemoteVoiceId(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  };

  const computeRemoteProviderInfoSync = (): PcAppRemoteVoiceProviderInfo | null => {
    if (selectedModel !== 'qwen3-0.6b' && selectedModel !== 'qwen3-1.7b') {
      return null;
    }
    const variant = choiceToSpeechVariant(selectedModel);
    const modelLabel = formatRemoteVoiceModelLabel(selectedModel);
    const backendSupported = isOnnxPlatform ? cachedWinOnnxSupport === true : cachedMlxSupport === true;
    const ready = Boolean(
      (isDarwin || isOnnxPlatform)
      && variant
      && modelLabel
      && backendSupported
      && !serveUnsupported
      && shouldUseResidentMlxWorker()
      && downloader.isModelReadySync(variant)
      && resolveLocalBackendHelperPath(),
    );
    if (!ready || !modelLabel) {
      return null;
    }
    const busy = Boolean(activeRemoteSession || activeWorkerUtterance || activeChild);
    const deviceName = getSyncDeviceName();
    const hostname = getSyncHostname();
    const localServerId = getLocalServerIdSync();
    return {
      deviceId: voiceDeviceId,
      ...(deviceName ? { deviceName } : {}),
      ...(hostname ? { hostname } : {}),
      ...(localServerId ? { localServerId } : {}),
      model: selectedModel,
      modelLabel,
      ready: true,
      busy,
    };
  };

  const emitRemoteEvent = (event: PcAppRemoteVoiceEvent): void => {
    for (const cb of [...remoteSubscribers]) {
      try {
        cb(event);
      } catch {
        // Isolate remote subscribers.
      }
    }
    if (event.type === 'provider.info' && !remoteBridgeActivated) return;
    if (!deps.getCurrentTrustedOrigin()) return;
    deps.sendToRenderer(PC_APP_VOICE_CHANNELS.remoteEvent, event);
  };

  const ensureDeviceNameResolved = async (): Promise<string | undefined> => {
    if (deviceNameResolved) return resolvedDeviceName;
    if (deviceNamePromise) return deviceNamePromise;
    const prevDeviceNameSync = getSyncDeviceName();
    const prevHostnameSync = getSyncHostname();
    deviceNamePromise = (async () => {
      let nextDeviceName: string | undefined;
      let nextHostname: string | undefined;
      if (deps.resolveDeviceIdentity) {
        try {
          const identity = await deps.resolveDeviceIdentity();
          nextDeviceName = normalizePcAppDeviceName(identity?.deviceName);
          nextHostname = normalizePcAppDeviceName(identity?.hostname);
        } catch {
          nextDeviceName = undefined;
          nextHostname = undefined;
        }
      } else {
        if (deps.resolveDeviceName) {
          try {
            nextDeviceName = normalizePcAppDeviceName(await deps.resolveDeviceName());
          } catch {
            nextDeviceName = undefined;
          }
        } else if (isDarwin) {
          nextDeviceName =
            normalizePcAppDeviceName(await readDarwinValue('ComputerName'))
            ?? normalizePcAppDeviceName(await readDarwinValue('LocalHostName'))
            ?? normalizePcAppDeviceName(readOsHostname());
        } else if (isWin32) {
          nextDeviceName = resolveWindowsDeviceName();
        } else {
          nextDeviceName = normalizePcAppDeviceName(readOsHostname());
        }

        if (deps.resolveHostname) {
          try {
            nextHostname = normalizePcAppDeviceName(await deps.resolveHostname());
          } catch {
            nextHostname = undefined;
          }
        } else if (!deps.resolveDeviceName) {
          nextHostname = normalizePcAppDeviceName(readOsHostname());
        }
      }
      resolvedDeviceName = nextDeviceName;
      resolvedHostname = nextHostname;
      deviceNameResolved = true;
      return resolvedDeviceName;
    })().finally(() => {
      deviceNamePromise = null;
      if (!controllerDisposed && (prevDeviceNameSync !== resolvedDeviceName || prevHostnameSync !== resolvedHostname)) {
        emitRemoteProviderInfoChanged();
      }
    });
    return deviceNamePromise;
  };

  const emitRemoteProviderInfoChanged = (): void => {
    const info = computeRemoteProviderInfoSync();
    if (info !== null && !deviceNameResolved && !deviceNamePromise) {
      void ensureDeviceNameResolved();
    }
    const signature = JSON.stringify(info);
    if (signature === lastRemoteInfoSignature) return;
    lastRemoteInfoSignature = signature;
    emitRemoteEvent({ type: 'provider.info', info });
  };

  const getRemoteProviderInfo = async (): Promise<PcAppRemoteVoiceProviderInfo | null> => {
    await Promise.all([checkMlxSupported(), ensureDeviceNameResolved()]);
    return computeRemoteProviderInfoSync();
  };

  const markBackendUnavailable = (reasonCode: string): void => {
    serveUnsupported = true;
    if ((reasonCode === 'onnxruntime_unavailable' || reasonCode === 'sherpa_onnx_unavailable') && isOnnxPlatform) {
      localBackendPermanentlyUnavailable = true;
      cachedWinOnnxSupport = false;
    }
    notifyStatusChanged(true);
  };

  const subscribeRemoteEvents = (listener: (event: PcAppRemoteVoiceEvent) => void): (() => void) => {
    if (typeof listener !== 'function') return () => {};
    remoteSubscribers.add(listener);
    return () => {
      remoteSubscribers.delete(listener);
    };
  };

  const emitWorkerUtteranceEvent = (utt: ActiveWorkerUtterance | null, payload: PcAppVoiceEvent): void => {
    if (!utt) return;
    if (utt.source === 'remote') {
      // Never log remote audio, session details, or recognized transcripts to voice.log.
      if (payload.type === 'error') {
        appendVoiceLog(`remote helper error code=${payload.code}`);
      }
      utt.onEvent?.(payload);
      return;
    }
    logVoiceEvent(payload, utt);
    if (utt.source !== 'global') {
      notifyVoiceEvent(payload);
    }
    if (utt.onEvent) {
      utt.onEvent(payload);
      return;
    }
    if (!deps.getCurrentTrustedOrigin()) return;
    deps.sendToRenderer(PC_APP_VOICE_CHANNELS.event, payload);
  };

  const resolveAbortedEndWait = (worker: ResidentMlxWorker, drained: boolean): void => {
    const wait = worker.abortedEndWait;
    if (!wait) return;
    worker.abortedEndWait = null;
    clearTimeout(wait.timer);
    wait.resolve(drained);
  };

  const shutdownMlxWorker = (target?: ResidentMlxWorker | null): void => {
    const worker = target ?? mlxWorker;
    if (!worker) return;
    if (mlxWorker === worker) {
      mlxWorker = null;
    }
    if (workerSpawnInFlight && !target) {
      workerSpawnInFlight = null;
    }
    worker.awaitingAbortedEnd = false;
    resolveAbortedEndWait(worker, false);
    if (worker.state === 'stopping') return;
    worker.state = 'stopping';

    if (worker.utterance) {
      const utt = worker.utterance;
      worker.utterance = null;
      if (activeWorkerUtterance === utt) {
        activeWorkerUtterance = null;
      }
      emitWorkerUtteranceEvent(utt, { type: 'end' });
      resolveUtteranceWaiters(utt);
    }

    appendVoiceLog(`mlx serve shutdown variant=${worker.variant}`);
    try {
      worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`);
      worker.proc.stdin?.end();
    } catch {
      try {
        worker.proc.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    }

    if (worker.killTimer !== null) {
      clearTimeout(worker.killTimer);
    }
    worker.killTimer = setTimeout(() => {
      worker.killTimer = null;
      try {
        worker.proc.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    }, 1_500);
    if (typeof worker.killTimer.unref === 'function') {
      worker.killTimer.unref();
    }
  };

  const ensureResidentMlxWorker = async (
    variant: PcAppSpeechVariant,
    opts?: { skipVerify?: boolean },
  ): Promise<ResidentMlxWorker | null> => {
    if (controllerDisposed || !shouldUseResidentMlxWorker()) return null;
    if (mlxWorker && mlxWorker.variant === variant && mlxWorker.state !== 'stopping') {
      return mlxWorker;
    }
    if (mlxWorker && mlxWorker.variant !== variant) {
      shutdownMlxWorker(mlxWorker);
    }
    if (workerSpawnInFlight && workerSpawnInFlight.variant === variant) {
      return workerSpawnInFlight.promise;
    }

    const spawnPromise = (async (): Promise<ResidentMlxWorker | null> => {
      if (controllerDisposed || !shouldUseResidentMlxWorker()) return null;
      if (!(await checkMlxSupported())) return null;
      const mlxBin = resolveLocalBackendHelperPath();
      if (!mlxBin || !downloader.isModelReadySync(variant)) return null;

      if (!opts?.skipVerify) {
        const verified = await downloader.verifyModelFilesOnDisk(variant);
        if (!verified) {
          void triggerDownloadIfSelected();
          return null;
        }
      }

      if (controllerDisposed || !shouldUseResidentMlxWorker()) return null;
      if (choiceToSpeechVariant(selectedModel) !== variant) return null;
      if (mlxWorker && mlxWorker.variant === variant && mlxWorker.state !== 'stopping') {
        return mlxWorker;
      }
      if (mlxWorker) {
        shutdownMlxWorker(mlxWorker);
      }

      const modelDir = downloader.getModelDirectory(variant);
      const args = isOnnxPlatform
        ? ['serve', '--model-dir', modelDir, '--variant', variant, '--provider', cachedWinProvider]
        : ['serve', '--model-dir', modelDir, '--variant', variant];
      appendVoiceLog(`mlx serve spawn variant=${variant} bin=${mlxBin} args=${JSON.stringify(args)}`);
      const proc = (deps.spawnHelper ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(mlxBin, args);
      const worker: ResidentMlxWorker = {
        proc,
        variant,
        modelDir,
        state: 'starting',
        stdoutBuffer: '',
        stderrBuffer: '',
        utterance: null,
        abortedEndWait: null,
        killTimer: null,
      };
      mlxWorker = worker;

      proc.stderr?.on('data', (chunk: Buffer | string) => {
        const text = String(chunk);
        if (text.trim()) {
          appendVoiceLog(`mlx serve stderr: ${text.trim()}`);
        }
        worker.stderrBuffer += text;
        if (worker.stderrBuffer.length > 512) {
          worker.stderrBuffer = worker.stderrBuffer.slice(-512);
        }
      });

      proc.stdout?.on('data', (chunk: Buffer | string) => {
        worker.stdoutBuffer += String(chunk);
        let idx = worker.stdoutBuffer.indexOf('\n');
        while (idx !== -1) {
          const line = worker.stdoutBuffer.slice(0, idx).trim();
          worker.stdoutBuffer = worker.stdoutBuffer.slice(idx + 1);
          idx = worker.stdoutBuffer.indexOf('\n');
          if (!line) continue;
          let parsed: PcAppVoiceEvent;
          try {
            parsed = JSON.parse(line) as PcAppVoiceEvent;
          } catch {
            continue;
          }
          if (!parsed || typeof parsed.type !== 'string') continue;

          if (parsed.type === 'loading') {
            if (worker.state !== 'stopping') {
              worker.state = 'loading';
            }
            if (worker.utterance) {
              if (activeRemoteSession?.utt === worker.utterance) {
                refreshRemoteIdleTimer(worker.utterance);
              }
              emitWorkerUtteranceEvent(worker.utterance, parsed);
            } else {
              appendVoiceLog(`mlx serve prewarm loading variant=${parsed.variant ?? worker.variant}`);
            }
            continue;
          }

          if (parsed.type === 'ready') {
            if (worker.state !== 'stopping') {
              worker.state = 'ready';
            }
            const readyProvider = (parsed as { provider?: unknown }).provider;
            if (
              isOnnxPlatform
              && (readyProvider === 'cpu' || readyProvider === 'directml' || readyProvider === 'cuda')
              && readyProvider !== cachedWinProvider
            ) {
              cachedWinProvider = readyProvider;
              notifyStatusChanged(true);
            }
            if (worker.utterance && activeRemoteSession?.utt === worker.utterance) {
              refreshRemoteIdleTimer(worker.utterance);
            }
            appendVoiceLog(`mlx serve ready variant=${parsed.variant ?? worker.variant}`);
            emitRemoteProviderInfoChanged();
            continue;
          }

          if (worker.awaitingAbortedEnd) {
            if (parsed.type === 'end') {
              worker.awaitingAbortedEnd = false;
              resolveAbortedEndWait(worker, true);
              continue;
            }
            if (parsed.type === 'error') {
              if (
                (parsed.code === 'unknown_command' && worker.state !== 'ready')
                || parsed.code === 'onnxruntime_unavailable'
                || parsed.code === 'sherpa_onnx_unavailable'
              ) {
                markBackendUnavailable(parsed.code);
              }
              appendVoiceLog(`mlx serve aborted background error code=${parsed.code} message=${parsed.message ?? '-'}`);
            }
            // Drop every queued pre-abort utterance frame (partial, result, level, start) until `end` confirms boundary.
            continue;
          }

          if (parsed.type === 'error') {
            if (
              (parsed.code === 'unknown_command' && worker.state !== 'ready')
              || parsed.code === 'onnxruntime_unavailable'
              || parsed.code === 'sherpa_onnx_unavailable'
            ) {
              markBackendUnavailable(parsed.code);
            }
            if (worker.utterance) {
              emitWorkerUtteranceEvent(worker.utterance, parsed);
            } else {
              appendVoiceLog(`mlx serve background error code=${parsed.code} message=${parsed.message ?? '-'}`);
            }
            continue;
          }

          if (parsed.type === 'end') {
            const utt = worker.utterance;
            if (utt) {
              worker.utterance = null;
              if (activeWorkerUtterance === utt) {
                activeWorkerUtterance = null;
              }
              emitWorkerUtteranceEvent(utt, parsed);
              resolveUtteranceWaiters(utt);
            }
            continue;
          }

          if (
            worker.utterance
            && activeRemoteSession?.utt === worker.utterance
            && (parsed.type === 'start' || parsed.type === 'result')
          ) {
            refreshRemoteIdleTimer(worker.utterance);
          }
          emitWorkerUtteranceEvent(worker.utterance, parsed);
        }
      });

      proc.once('exit', (code, signal) => {
        appendVoiceLog(`mlx serve exit variant=${worker.variant} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if (worker.killTimer !== null) {
          clearTimeout(worker.killTimer);
          worker.killTimer = null;
        }
        if (mlxWorker === worker) {
          mlxWorker = null;
        }
        const wasStopping = worker.state === 'stopping';
        worker.state = 'stopping';
        worker.awaitingAbortedEnd = false;
        resolveAbortedEndWait(worker, false);
        const utt = worker.utterance;
        if (utt) {
          worker.utterance = null;
          if (activeWorkerUtterance === utt) {
            activeWorkerUtterance = null;
          }
          if (!wasStopping && ((code !== null && code !== 0) || signal !== null)) {
            const message = worker.stderrBuffer.trim();
            emitWorkerUtteranceEvent(utt, {
              type: 'error',
              code: 'helper_exited',
              ...(message ? { message } : {}),
            });
          }
          emitWorkerUtteranceEvent(utt, { type: 'end' });
          resolveUtteranceWaiters(utt);
        }
      });

      proc.once('error', (err) => {
        appendVoiceLog(`mlx serve spawn_error variant=${worker.variant}: ${err.message}`);
        if (worker.killTimer !== null) {
          clearTimeout(worker.killTimer);
          worker.killTimer = null;
        }
        if (mlxWorker === worker) {
          mlxWorker = null;
        }
        const wasStopping = worker.state === 'stopping';
        worker.state = 'stopping';
        worker.awaitingAbortedEnd = false;
        resolveAbortedEndWait(worker, false);
        const utt = worker.utterance;
        if (utt) {
          worker.utterance = null;
          if (activeWorkerUtterance === utt) {
            activeWorkerUtterance = null;
          }
          if (!wasStopping) {
            emitWorkerUtteranceEvent(utt, {
              type: 'error',
              code: 'helper_spawn_failed',
              message: err.message,
            });
          }
          emitWorkerUtteranceEvent(utt, { type: 'end' });
          resolveUtteranceWaiters(utt);
        }
      });

      return worker;
    })();

    workerSpawnInFlight = { variant, promise: spawnPromise };
    try {
      return await spawnPromise;
    } finally {
      if (workerSpawnInFlight?.promise === spawnPromise) {
        workerSpawnInFlight = null;
      }
    }
  };

  const clearRemoteStopTimer = (): void => {
    if (remoteStopTimer !== null) {
      clearTimeout(remoteStopTimer);
      remoteStopTimer = null;
    }
  };

  const clearRemoteIdleTimer = (): void => {
    if (remoteIdleTimer !== null) {
      clearTimeout(remoteIdleTimer);
      remoteIdleTimer = null;
    }
  };

  const isolateWorker = (worker: ResidentMlxWorker): void => {
    worker.awaitingAbortedEnd = false;
    resolveAbortedEndWait(worker, false);
    shutdownMlxWorker(worker);
    if (isOnnxPlatform) {
      try {
        worker.proc.kill('SIGTERM');
      } catch { /* ignore */ }
    }
  };

  const isResidentWorkerUsable = (candidate: ResidentMlxWorker | null): candidate is ResidentMlxWorker =>
    Boolean(candidate && candidate === mlxWorker && candidate.state !== 'stopping' && !serveUnsupported);

  const detachAndAbortWorker = (
    worker: ResidentMlxWorker | null,
    utt: ActiveWorkerUtterance,
    options?: { shutdownIfNotReady?: boolean; writeAbort?: boolean },
  ): void => {
    if (!worker) return;
    worker.utterance = null;
    if (utt.stopRequested || (options?.shutdownIfNotReady && (worker.state === 'starting' || worker.state === 'loading'))) {
      // Isolate & shut down any worker whose in-flight final decode is aborted or timed out
      // (both macOS MLX and Windows Sherpa) so delayed result/end frames never hit a new utterance.
      isolateWorker(worker);
      return;
    }
    if (options?.writeAbort !== false) {
      worker.awaitingAbortedEnd = true;
      if (!worker.abortedEndWait) {
        let resolveWait!: (drained: boolean) => void;
        const promise = new Promise<boolean>((resolve) => {
          resolveWait = resolve;
        });
        const timer = setTimeout(() => {
          isolateWorker(worker);
        }, ABORT_END_DRAIN_TIMEOUT_MS);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
        worker.abortedEndWait = { promise, resolve: resolveWait, timer };
      }
      try {
        worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'abort' })}\n`);
      } catch {
        isolateWorker(worker);
      }
    }
  };

  const waitForCleanResidentWorker = async (
    initialWorker: ResidentMlxWorker | null,
    variant: PcAppSpeechVariant,
    isCancelled: () => boolean,
    registerCancelWakeup?: (wake: () => void) => void,
  ): Promise<ResidentMlxWorker | null> => {
    let worker = initialWorker;
    if (!worker || serveUnsupported) return null;
    if (worker.awaitingAbortedEnd && worker.abortedEndWait) {
      const drained = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        registerCancelWakeup?.(() => finish(false));
        void worker!.abortedEndWait!.promise.then(finish);
      });
      if (isCancelled()) return null;
      if (!drained || worker.awaitingAbortedEnd || !isResidentWorkerUsable(worker)) {
        isolateWorker(worker);
        worker = await ensureResidentMlxWorker(variant, { skipVerify: true });
        if (isCancelled()) return null;
      }
    } else if (worker.awaitingAbortedEnd || !isResidentWorkerUsable(worker)) {
      isolateWorker(worker);
      worker = await ensureResidentMlxWorker(variant, { skipVerify: true });
      if (isCancelled()) return null;
    }
    return isResidentWorkerUsable(worker) ? worker : null;
  };

  const cleanupRemoteSession = (
    utt: ActiveWorkerUtterance,
    options: {
      sendWorkerAbort: boolean;
      shutdownIfNotReady?: boolean;
      errorCode?: string;
      emitEnd: boolean;
    },
  ): void => {
    const sessionId = utt.sessionId ?? '';
    clearRemoteStopTimer();
    clearRemoteIdleTimer();
    if (activeRemoteSession?.utt === utt) {
      activeRemoteSession = null;
    }
    if (activeWorkerUtterance === utt) {
      activeWorkerUtterance = null;
    }
    const worker = mlxWorker && mlxWorker.utterance === utt ? mlxWorker : null;
    detachAndAbortWorker(worker, utt, {
      shutdownIfNotReady: options.shutdownIfNotReady,
      writeAbort: options.sendWorkerAbort,
    });
    resolveUtteranceWaiters(utt);
    emitRemoteProviderInfoChanged();
    if (options.errorCode && sessionId) {
      emitRemoteEvent({
        type: 'voice.session.error',
        sessionId,
        code: options.errorCode,
      });
    }
    if (options.emitEnd && sessionId && !utt.remoteEnded) {
      utt.remoteEnded = true;
      emitRemoteEvent({
        type: 'voice.session.end',
        sessionId,
      });
    }
  };

  const refreshRemoteIdleTimer = (utt: ActiveWorkerUtterance): void => {
    clearRemoteIdleTimer();
    if (controllerDisposed || activeRemoteSession?.utt !== utt) return;
    const timer = setTimeout(() => {
      if (remoteIdleTimer !== timer) return;
      remoteIdleTimer = null;
      if (controllerDisposed || activeRemoteSession?.utt !== utt) return;
      appendVoiceLog('mlx serve remote session idle timeout');
      cleanupRemoteSession(utt, {
        sendWorkerAbort: true,
        shutdownIfNotReady: true,
        emitEnd: true,
      });
    }, remoteSessionIdleTimeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    remoteIdleTimer = timer;
  };

  const abortRemoteSessionForLocalPriority = (): void => {
    const active = activeRemoteSession;
    if (!active) return;
    cleanupRemoteSession(active.utt, {
      sendWorkerAbort: true,
      shutdownIfNotReady: true,
      errorCode: 'provider_busy',
      emitEnd: false,
    });
  };

  const stopListening = async (options?: {
    abort?: boolean;
    source?: 'in-app' | 'global';
    exceptStartSeq?: number;
  }): Promise<void> => {
    const matchesSource = (activeSource: 'in-app' | 'global' | undefined): boolean =>
      !options?.source || (activeSource ?? 'in-app') === options.source;

    if (
      pendingStartRequest
      && pendingStartRequest.seq !== options?.exceptStartSeq
      && matchesSource(pendingStartRequest.source)
      && (options?.abort || !pendingStartRequest.finalizeOnly)
    ) {
      pendingStartRequest.aborted = true;
      pendingStartRequest.wakeOnCancel?.();
      pendingStartRequest.wakeOnCancel = undefined;
      if (pendingStartRequest.source !== 'global') {
        notifyVoiceEvent({ type: 'end' });
      }
    }

    if (activeWorkerUtterance && activeWorkerUtterance.source !== 'remote') {
      if (!matchesSource(activeWorkerUtterance.source)) {
        return;
      }
      if (activeStopTimer !== null) {
        clearTimeout(activeStopTimer);
        activeStopTimer = null;
      }
      const utt = activeWorkerUtterance;
      const worker = mlxWorker && mlxWorker.utterance === utt ? mlxWorker : null;
      if (options?.abort) {
        activeWorkerUtterance = null;
        detachAndAbortWorker(worker, utt);
        resolveUtteranceWaiters(utt);
        emitWorkerUtteranceEvent(utt, { type: 'end' });
        return;
      }

      if (!worker || worker.state === 'stopping') {
        activeWorkerUtterance = null;
        if (worker) worker.utterance = null;
        resolveUtteranceWaiters(utt);
        emitWorkerUtteranceEvent(utt, { type: 'end' });
        return;
      }

      utt.stopRequested = true;
      try {
        worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
      } catch {
        activeWorkerUtterance = null;
        worker.utterance = null;
        resolveUtteranceWaiters(utt);
        shutdownMlxWorker(worker);
        return;
      }

      await new Promise<void>((resolveStop) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (activeStopTimer !== null) {
            clearTimeout(activeStopTimer);
            activeStopTimer = null;
          }
          resolveStop();
        };
        utt.waitersForEnd.push(done);
        activeStopTimer = setTimeout(() => {
          if (activeWorkerUtterance === utt) {
            activeWorkerUtterance = null;
          }
          if (worker.utterance === utt) {
            detachAndAbortWorker(worker, utt);
          }
          emitWorkerUtteranceEvent(utt, { type: 'end' });
          resolveUtteranceWaiters(utt);
          done();
        }, QWEN_LOCAL_FINALIZE_TIMEOUT_MS);
      });
      return;
    }

    const child = activeChild;
    const isMlxChild = activeChildIsMlx;
    if (!child || !matchesSource(activeChildSource)) return;
    if (activeStopTimer !== null) {
      clearTimeout(activeStopTimer);
      activeStopTimer = null;
    }
    if (options?.abort) {
      activeChild = null;
      activeChildIsMlx = false;
      activeChildSource = undefined;
      try {
        child.kill('SIGTERM');
      } catch { /* already exited */ }
      notifyVoiceEvent({ type: 'end' });
      return;
    }
    try {
      child.stdin?.write('stop\n');
      child.stdin?.end();
    } catch {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    const stopTimeoutMs = isMlxChild ? QWEN_LOCAL_FINALIZE_TIMEOUT_MS : SYSTEM_SPEECH_STOP_TIMEOUT_MS;
    await new Promise<void>((resolveStop) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (activeStopTimer !== null) {
          clearTimeout(activeStopTimer);
          activeStopTimer = null;
        }
        resolveStop();
      };
      child.once('exit', done);
      activeStopTimer = setTimeout(() => {
        if (activeChild === child) {
          activeChild = null;
          activeChildIsMlx = false;
          activeChildSource = undefined;
        }
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        done();
      }, stopTimeoutMs);
    });
  };

  const startListening = async (options?: {
    locale?: string;
    initialPcmBase64?: string;
    finalizeOnly?: boolean;
    hotwords?: string[];
    source?: 'in-app' | 'global';
    onEvent?: (event: PcAppVoiceEvent) => void;
  }): Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }> => {
    const isGlobalSource = options?.source === 'global';
    if (!isDarwin && !isOnnxPlatform) {
      return { ok: false, error: 'unsupported_platform' };
    }
    const finalizeOnly = options?.finalizeOnly === true;
    let prefillChunks: string[] = [];
    if (typeof options?.initialPcmBase64 === 'string' && options.initialPcmBase64.trim()) {
      const parsedChunks = splitBase64PcmIntoChunks(options.initialPcmBase64);
      if (!parsedChunks) {
        return { ok: false, error: 'invalid_pcm' };
      }
      prefillChunks = parsedChunks;
    }
    if (finalizeOnly && prefillChunks.length === 0) {
      return { ok: false, error: 'empty_pcm' };
    }
    let perms: PcAppVoicePermissions | null = null;
    const myStartReq: PendingStartRequest = {
      seq: ++startRequestSeq,
      source: options?.source,
      finalizeOnly,
      aborted: false,
    };
    if (pendingStartRequest && (!options?.source || (pendingStartRequest.source ?? 'in-app') === options.source)) {
      pendingStartRequest.aborted = true;
      pendingStartRequest.wakeOnCancel?.();
      pendingStartRequest.wakeOnCancel = undefined;
    }
    pendingStartRequest = myStartReq;
    const isCancelledBeforeDispatch = (): boolean =>
      controllerDisposed || myStartReq.aborted || pendingStartRequest !== myStartReq;
    const clearPendingStartIfCurrent = () => {
      if (pendingStartRequest === myStartReq) {
        pendingStartRequest = null;
      }
    };

    if (!finalizeOnly) {
      perms = await requestPermissions();
      if (isCancelledBeforeDispatch()) {
        clearPendingStartIfCurrent();
        return { ok: false, error: 'cancelled' };
      }
      if (perms.mic !== 'granted') {
        clearPendingStartIfCurrent();
        if (isOnnxPlatform) {
          return { ok: false, error: 'speech_helper_unavailable' };
        }
        appendVoiceLog(`startListening denied target=mic selectedModel=${selectedModel} device=${selectedInputDevice}`);
        return { ok: false, error: 'permission_denied', target: 'mic' };
      }
    }

    if (activeRemoteSession) {
      abortRemoteSessionForLocalPriority();
    }

    const variant = choiceToSpeechVariant(selectedModel);
    let bin: string | null = null;
    let args: string[];
    let isMlxHelper = false;

    const mlxSupported = variant ? await checkMlxSupported() : false;
    if (isCancelledBeforeDispatch()) {
      clearPendingStartIfCurrent();
      return { ok: false, error: 'cancelled' };
    }

    if (variant && mlxSupported && downloader.isModelReadySync(variant)) {
      const mlxBin = resolveLocalBackendHelperPath();
      if (mlxBin && shouldUseResidentMlxWorker()) {
        const alreadyReady = Boolean(mlxWorker && mlxWorker.variant === variant && mlxWorker.state === 'ready');
        if (!alreadyReady) {
          if (isGlobalSource) {
            options?.onEvent?.({ type: 'loading', variant });
          } else {
            notifyVoiceEvent({ type: 'loading', variant });
          }
        }
        let worker = await ensureResidentMlxWorker(variant, { skipVerify: alreadyReady });
        if (isCancelledBeforeDispatch()) {
          clearPendingStartIfCurrent();
          return { ok: false, error: 'cancelled' };
        }
        if (worker && worker.state !== 'stopping' && !serveUnsupported) {
          await stopListening({ abort: true, exceptStartSeq: myStartReq.seq });
          worker = await waitForCleanResidentWorker(
            worker,
            variant,
            isCancelledBeforeDispatch,
            (wake) => {
              myStartReq.wakeOnCancel = wake;
            },
          );
          myStartReq.wakeOnCancel = undefined;
          if (isCancelledBeforeDispatch()) {
            clearPendingStartIfCurrent();
            return { ok: false, error: 'cancelled' };
          }
        }
        if (worker && worker.state !== 'stopping' && !serveUnsupported) {
          if (worker.state !== 'ready') {
            if (isGlobalSource) {
              options?.onEvent?.({ type: 'loading', variant });
            } else {
              notifyVoiceEvent({ type: 'loading', variant });
            }
          }
          const utterance: ActiveWorkerUtterance = {
            source: options?.source,
            onEvent: options?.onEvent,
            loggedFirstLevel: false,
            loggedFirstResult: false,
            waitersForEnd: [],
          };
          worker.utterance = utterance;
          activeWorkerUtterance = utterance;
          clearPendingStartIfCurrent();
          try {
            const hotwordsTerms = normalizePcAppVoiceHotwordsTerms(options?.hotwords);
            if (finalizeOnly) {
              const startPcmCmd: { cmd: 'start_pcm'; locale?: string; hotwords?: string[] } = { cmd: 'start_pcm' };
              if (typeof options?.locale === 'string' && options.locale.trim()) {
                startPcmCmd.locale = options.locale.trim();
              }
              if (hotwordsTerms) {
                startPcmCmd.hotwords = hotwordsTerms;
              }
              appendVoiceLog(`mlx serve finalizeOnly variant=${variant} chunks=${prefillChunks.length}`);
              utterance.stopRequested = true;
              worker.proc.stdin?.write(`${JSON.stringify(startPcmCmd)}\n`);
              for (const chunk of prefillChunks) {
                worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'pcm', data: chunk })}\n`);
              }
              worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
              return { ok: true };
            }
            const startCmd: { cmd: 'start'; locale?: string; device?: string; hotwords?: string[] } = { cmd: 'start' };
            if (typeof options?.locale === 'string' && options.locale.trim()) {
              startCmd.locale = options.locale.trim();
            }
            if (hotwordsTerms) {
              startCmd.hotwords = hotwordsTerms;
            }
            if (selectedInputDevice !== 'auto') {
              startCmd.device = selectedInputDevice;
            }
            appendVoiceLog(`mlx serve start variant=${variant} device=${selectedInputDevice} prefillChunks=${prefillChunks.length}`);
            if (prefillChunks.length > 0) {
              worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'prefill_reset' })}\n`);
              for (const chunk of prefillChunks) {
                worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'prefill_pcm', data: chunk })}\n`);
              }
            }
            worker.proc.stdin?.write(`${JSON.stringify(startCmd)}\n`);
            return { ok: true };
          } catch {
            worker.utterance = null;
            if (activeWorkerUtterance === utterance) {
              activeWorkerUtterance = null;
            }
            shutdownMlxWorker(worker);
          }
        }
      }
      if (finalizeOnly) {
        clearPendingStartIfCurrent();
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        return { ok: false, error: 'speech_helper_unavailable' };
      }

      if (mlxBin) {
        if (isGlobalSource) {
          options?.onEvent?.({ type: 'loading', variant });
        } else {
          notifyVoiceEvent({ type: 'loading', variant });
        }
      }
      const verified = mlxBin ? await downloader.verifyModelFilesOnDisk(variant) : false;
      if (isCancelledBeforeDispatch()) {
        clearPendingStartIfCurrent();
        return { ok: false, error: 'cancelled' };
      }
      if (mlxBin && verified) {
        bin = mlxBin;
        isMlxHelper = true;
        args = isOnnxPlatform
          ? ['listen', '--model-dir', downloader.getModelDirectory(variant), '--variant', variant, '--provider', cachedWinProvider]
          : ['listen', '--model-dir', downloader.getModelDirectory(variant), '--variant', variant];
        if (typeof options?.locale === 'string' && options.locale.trim()) {
          args.push('--locale', options.locale.trim());
        }
        if (selectedInputDevice !== 'auto') {
          args.push('--device', selectedInputDevice);
        }
      } else {
        if (!verified) {
          void triggerDownloadIfSelected();
        }
        bin = null;
        args = [];
      }
    } else {
      if (variant) {
        void triggerDownloadIfSelected();
      }
      if (finalizeOnly) {
        clearPendingStartIfCurrent();
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        return { ok: false, error: variant ? 'speech_model_downloading' : 'speech_model_required' };
      }
      args = [];
    }

    if (!bin) {
      if (isOnnxPlatform) {
        clearPendingStartIfCurrent();
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        const errCode = variant ? 'speech_model_downloading' : 'speech_model_required';
        appendVoiceLog(`startListening ${deps.platform} unavailable reason=${errCode} selectedModel=${selectedModel}`);
        return { ok: false, error: errCode };
      }
      if (!perms || perms.speech !== 'granted') {
        clearPendingStartIfCurrent();
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        appendVoiceLog(`startListening denied target=speech selectedModel=${selectedModel} device=${selectedInputDevice}`);
        return { ok: false, error: 'permission_denied', target: 'speech' };
      }
      bin = resolveSpeechHelperPath();
      if (!bin) {
        clearPendingStartIfCurrent();
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        appendVoiceLog(`startListening speech_helper_unavailable selectedModel=${selectedModel} device=${selectedInputDevice}`);
        return { ok: false, error: 'speech_helper_unavailable' };
      }
      args = ['listen'];
      if (typeof options?.locale === 'string' && options.locale.trim()) {
        args.push('--locale', options.locale.trim());
      }
      if (selectedInputDevice !== 'auto') {
        args.push('--device', selectedInputDevice);
      }
    }

    await stopListening({ abort: true, exceptStartSeq: myStartReq.seq });
    if (isCancelledBeforeDispatch()) {
      clearPendingStartIfCurrent();
      return { ok: false, error: 'cancelled' };
    }
    clearPendingStartIfCurrent();
    if (isMlxHelper && variant) {
      if (isGlobalSource) {
        options?.onEvent?.({ type: 'loading', variant });
      } else {
        notifyVoiceEvent({ type: 'loading', variant });
      }
    }

    appendVoiceLog(`startListening model=${selectedModel} device=${selectedInputDevice} bin=${bin} args=${JSON.stringify(args)}`);
    const child = (deps.spawnHelper ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(bin, args);
    activeChild = child;
    activeChildIsMlx = isMlxHelper;
    activeChildSource = options?.source;

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let loggedFirstLevel = false;
    let loggedFirstResult = false;
    const emitSafe = (payload: PcAppVoiceEvent) => {
      if (payload.type === 'loading') {
        appendVoiceLog(`helper model loading variant=${payload.variant ?? '-'}`);
      } else if (payload.type === 'level' && !loggedFirstLevel && payload.value > 0.01) {
        loggedFirstLevel = true;
        appendVoiceLog(`first level value=${payload.value.toFixed(4)}`);
      } else if (payload.type === 'result') {
        const trimmed = payload.text.trim();
        if (!loggedFirstResult && trimmed) {
          loggedFirstResult = true;
          appendVoiceLog(
            `first result isFinal=${payload.isFinal} len=${trimmed.length} text=${JSON.stringify(trimmed.slice(0, 80))}`,
          );
        }
        if (payload.isFinal) {
          appendVoiceLog(`final result len=${trimmed.length} text=${JSON.stringify(trimmed.slice(0, 80))}`);
        }
      } else if (payload.type === 'error') {
        appendVoiceLog(`helper error code=${payload.code} target=${payload.target ?? '-'} message=${payload.message ?? '-'}`);
        if (payload.code === 'onnxruntime_unavailable' || payload.code === 'sherpa_onnx_unavailable') {
          markBackendUnavailable(payload.code);
        }
      }
      if (!isGlobalSource) {
        notifyVoiceEvent(payload);
      }
      if (options?.onEvent) {
        options.onEvent(payload);
        return;
      }
      if (!deps.getCurrentTrustedOrigin()) return;
      deps.sendToRenderer(PC_APP_VOICE_CHANNELS.event, payload);
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      if (text.trim()) {
        appendVoiceLog(`helper stderr: ${text.trim()}`);
      }
      stderrBuffer += text;
      if (stderrBuffer.length > 512) {
        stderrBuffer = stderrBuffer.slice(-512);
      }
    });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += String(chunk);
      let idx = stdoutBuffer.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        idx = stdoutBuffer.indexOf('\n');
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as PcAppVoiceEvent;
          if (parsed && typeof parsed.type === 'string') {
            emitSafe(parsed);
          }
        } catch {
          // Ignore malformed stdout fragment
        }
      }
    });

    child.once('exit', (code, signal) => {
      appendVoiceLog(`helper exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (activeChild === child) {
        activeChild = null;
        activeChildIsMlx = false;
        activeChildSource = undefined;
        if (code && code !== 0) {
          const message = stderrBuffer.trim();
          emitSafe({
            type: 'error',
            code: 'helper_exited',
            ...(message ? { message } : {}),
          });
        }
        emitSafe({ type: 'end' });
      }
    });

    child.once('error', (err) => {
      appendVoiceLog(`helper spawn_error: ${err.message}`);
      if (activeChild === child) {
        activeChild = null;
        activeChildIsMlx = false;
        activeChildSource = undefined;
      }
      emitSafe({ type: 'error', code: 'helper_spawn_failed', message: err.message });
      emitSafe({ type: 'end' });
    });

    return { ok: true };
  };

  const openPrivacySettings = async (target: unknown): Promise<boolean> => {
    const url = resolvePrivacySettingsUrl(deps.platform, target);
    if (!url || !deps.openSystemUrl) return false;
    await deps.openSystemUrl(url);
    return true;
  };

  const getSpeechModel = (): PcAppSpeechModelChoice => getEffectiveSelectedModel();

  const getSpeechModelStatus = async (): Promise<PcAppSpeechModelStatus> => {
    const prevSupport = isOnnxPlatform ? cachedWinOnnxSupport : cachedMlxSupport;
    const prevProvider = cachedWinProvider;
    const prevVram = cachedWinVramMb;
    await checkMlxSupported();
    const nextSupport = isOnnxPlatform ? cachedWinOnnxSupport : cachedMlxSupport;
    if (prevSupport !== nextSupport || prevProvider !== cachedWinProvider || prevVram !== cachedWinVramMb) {
      notifyStatusChanged(true);
    }
    return computeStatusSync();
  };

  const setSpeechModel = async (rawModel: unknown): Promise<PcAppSpeechModelStatus> => {
    if (!isValidSpeechModelChoice(rawModel)) {
      throw new Error(`Invalid speech model: ${String(rawModel)}`);
    }

    if (rawModel === 'system') {
      downloader.cancelActive();
      if (downloadingVariant) {
        const prevDl = downloadingVariant;
        downloadingVariant = null;
        if (variantMeta[prevDl].state === 'downloading') {
          variantMeta[prevDl] = { state: 'idle', progress: 0, downloadedBytes: 0, totalBytes: 0 };
        }
      }
      targetModelAfterDownload = null;
      pendingStartupModel = null;
      lastStatusVariant = null;
      selectedModel = 'system';
      modelStore.save('system');
      shutdownMlxWorker();
      notifyStatusChanged(true);
      return computeStatusSync();
    }

    const variant = choiceToSpeechVariant(rawModel)!;
    pendingStartupModel = null;
    lastStatusVariant = variant;
    const supported = await checkMlxSupported();
    if (!supported) {
      downloader.cancelActive();
      downloadingVariant = null;
      targetModelAfterDownload = null;
      selectedModel = 'system';
      shutdownMlxWorker();
      notifyStatusChanged(true);
      return computeStatusSync();
    }

    if (downloader.isModelReadySync(variant)) {
      const valid = await downloader.verifyModelFilesOnDisk(variant);
      if (valid) {
        downloader.cancelActive();
        downloadingVariant = null;
        targetModelAfterDownload = null;
        const totalBytes = variantManifestTotal(variant);
        variantMeta[variant] = {
          state: 'ready',
          progress: 1,
          downloadedBytes: totalBytes,
          totalBytes,
        };
        selectedModel = rawModel;
        modelStore.save(rawModel);
        if (mlxWorker && mlxWorker.variant !== variant) {
          shutdownMlxWorker(mlxWorker);
        }
        void ensureResidentMlxWorker(variant, { skipVerify: true });
        notifyStatusChanged(true);
        return computeStatusSync();
      }
    }

    // Not downloaded yet: keep selectedModel on current active ready model (e.g. 'system')
    // and start background download; promote once verified on disk.
    if (downloadingVariant === variant) {
      targetModelAfterDownload = rawModel;
      notifyStatusChanged(true);
      return computeStatusSync();
    }
    startBackgroundDownload(rawModel);
    return computeStatusSync();
  };

  const getInputDevices = async (): Promise<PcAppInputDevice[]> => {
    if (!isDarwin && !isOnnxPlatform) {
      return [];
    }
    const bin = resolveSpeechHelperPath();
    if (!bin) return [...cachedInputDevices];
    try {
      const raw = deps.runHelperSync
        ? deps.runHelperSync(bin, ['devices'])
        : await (deps.runHelperAsync ?? defaultRunHelperAsync)(bin, ['devices']);
      const parsed = JSON.parse(raw.trim()) as unknown;
      if (!Array.isArray(parsed)) return [...cachedInputDevices];
      const next: PcAppInputDevice[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const uid = typeof rec.uid === 'string' ? rec.uid.trim() : '';
        if (!uid) continue;
        const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : uid;
        const transport = typeof rec.transport === 'string' && rec.transport.trim() ? rec.transport.trim() : 'other';
        next.push({
          uid,
          name,
          transport,
          isDefault: rec.isDefault === true,
          isPhysical: rec.isPhysical === true,
        });
      }
      cachedInputDevices = next;
      deps.onInputDevicesChanged?.([...cachedInputDevices], selectedInputDevice);
    } catch {
      // Keep cached devices on helper failure.
    }
    return [...cachedInputDevices];
  };

  const getSelectedInputDevice = (): string => selectedInputDevice;

  const setSelectedInputDevice = (rawUid: unknown): string => {
    if (typeof rawUid !== 'string') {
      throw new Error(`Invalid input device UID: ${String(rawUid)}`);
    }
    const next = rawUid.trim() || 'auto';
    selectedInputDevice = next;
    saveSelectedInputDevice(next);
    deps.onInputDevicesChanged?.([...cachedInputDevices], selectedInputDevice);
    return selectedInputDevice;
  };

    const startRemoteSession = async (options: {
      sessionId: string;
      locale?: string;
      hotwords?: string[];
    }): Promise<{ ok: boolean; error?: string }> => {
      const rawSessionId: unknown = options?.sessionId;
      if (!isValidRemoteVoiceId(rawSessionId)) {
        appendVoiceLog('startRemoteSession rejected reason=invalid_session');
        return { ok: false, error: 'invalid_session' };
      }
      const sessionId = rawSessionId;
      if (controllerDisposed) {
        appendVoiceLog(`startRemoteSession rejected reason=not_ready detail=controller_disposed sessionId=${sessionId}`);
        return { ok: false, error: 'not_ready' };
      }
      const hasLocalActive = Boolean(
        activeChild
        || (activeWorkerUtterance && activeWorkerUtterance.source !== 'remote'),
      );
      if (hasLocalActive || activeRemoteSession !== null) {
        appendVoiceLog(
          `startRemoteSession rejected reason=busy detail=already_active localActive=${hasLocalActive} remoteActive=${activeRemoteSession !== null} sessionId=${sessionId}`,
        );
        return { ok: false, error: 'busy' };
      }
      if (!isDarwin && !isOnnxPlatform) {
        appendVoiceLog(`startRemoteSession rejected reason=not_ready detail=unsupported_platform sessionId=${sessionId}`);
        return { ok: false, error: 'not_ready' };
      }
      const variant = choiceToSpeechVariant(selectedModel);
      if (!variant) {
        appendVoiceLog(`startRemoteSession rejected reason=not_ready detail=invalid_model sessionId=${sessionId}`);
        return { ok: false, error: 'not_ready' };
      }
      const notReadyDetail = !(await checkMlxSupported())
        ? 'mlx_unsupported'
        : !downloader.isModelReadySync(variant)
          ? 'model_not_ready'
          : !shouldUseResidentMlxWorker()
            ? 'resident_worker_disabled'
            : null;
      if (notReadyDetail) {
        appendVoiceLog(`startRemoteSession rejected reason=not_ready detail=${notReadyDetail} sessionId=${sessionId}`);
        return { ok: false, error: 'not_ready' };
      }
      const alreadyReady = Boolean(mlxWorker && mlxWorker.variant === variant && mlxWorker.state === 'ready');
      const initialWorker = await ensureResidentMlxWorker(variant, { skipVerify: alreadyReady });
      const worker = await waitForCleanResidentWorker(
        initialWorker,
        variant,
        () =>
          controllerDisposed
          || activeRemoteSession !== null
          || Boolean(activeChild || (activeWorkerUtterance && activeWorkerUtterance.source !== 'remote')),
      );
      const postWorkerLocalActive = Boolean(
        activeChild
        || (activeWorkerUtterance && activeWorkerUtterance.source !== 'remote'),
      );
      if (postWorkerLocalActive || activeRemoteSession !== null) {
        appendVoiceLog(
          `startRemoteSession rejected reason=busy detail=post_worker_race localActive=${postWorkerLocalActive} remoteActive=${activeRemoteSession !== null} sessionId=${sessionId}`,
        );
        return { ok: false, error: 'busy' };
      }
      if (controllerDisposed || !worker || worker.state === 'stopping' || serveUnsupported) {
        const detail = controllerDisposed
          ? 'controller_disposed'
          : !worker
            ? 'worker_unavailable'
            : worker.state === 'stopping'
              ? 'worker_stopping'
              : 'serve_unsupported';
        appendVoiceLog(`startRemoteSession rejected reason=not_ready detail=${detail} sessionId=${sessionId}`);
        return { ok: false, error: 'not_ready' };
      }

      const utt: ActiveWorkerUtterance = {
        source: 'remote',
        sessionId,
        loggedFirstLevel: false,
        loggedFirstResult: false,
        waitersForEnd: [],
        onEvent: (payload) => {
          if (payload.type === 'start') {
            refreshRemoteIdleTimer(utt);
            emitRemoteEvent({ type: 'voice.session.ready', sessionId });
          } else if (payload.type === 'result') {
            refreshRemoteIdleTimer(utt);
            emitRemoteEvent({
              type: 'voice.session.result',
              sessionId,
              text: payload.text,
              isFinal: payload.isFinal,
            });
          } else if (payload.type === 'error') {
            emitRemoteEvent({
              type: 'voice.session.error',
              sessionId,
              code: sanitizeRemoteVoiceErrorCode(payload.code),
            });
          } else if (payload.type === 'end') {
            clearRemoteIdleTimer();
            clearRemoteStopTimer();
            if (activeRemoteSession?.utt === utt) {
              activeRemoteSession = null;
            }
            emitRemoteProviderInfoChanged();
            if (!utt.remoteEnded) {
              utt.remoteEnded = true;
              emitRemoteEvent({ type: 'voice.session.end', sessionId });
            }
          }
        },
      };

      worker.utterance = utt;
      activeWorkerUtterance = utt;
      activeRemoteSession = { sessionId, utt };

      const startCmd: { cmd: 'start_pcm'; locale?: string; hotwords?: string[] } = { cmd: 'start_pcm' };
      if (typeof options.locale === 'string' && options.locale.trim()) {
        startCmd.locale = options.locale.trim();
      }
      const hotwordsTerms = normalizePcAppVoiceHotwordsTerms(options.hotwords);
      if (hotwordsTerms) {
        startCmd.hotwords = hotwordsTerms;
      }
      try {
        appendVoiceLog(`mlx serve start_pcm variant=${variant} sessionId=${sessionId}`);
        worker.proc.stdin?.write(`${JSON.stringify(startCmd)}\n`);
        refreshRemoteIdleTimer(utt);
        emitRemoteProviderInfoChanged();
        return { ok: true };
      } catch (err) {
        const rawErrCode = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
        const safeErrCode = typeof rawErrCode === 'string' && REMOTE_WORKER_WRITE_ERRNO_ALLOWLIST.has(rawErrCode)
          ? rawErrCode
          : 'unknown';
        appendVoiceLog(`startRemoteSession rejected reason=worker_write_failed sessionId=${sessionId} code=${safeErrCode}`);
        clearRemoteIdleTimer();
        clearRemoteStopTimer();
        activeRemoteSession = null;
        if (activeWorkerUtterance === utt) {
          activeWorkerUtterance = null;
        }
        worker.utterance = null;
        shutdownMlxWorker(worker);
        emitRemoteProviderInfoChanged();
        return { ok: false, error: 'worker_write_failed' };
      }
    };

    const pushRemotePcm = (options: {
      sessionId: string;
      pcmBase64: string;
    }): { ok: boolean; error?: string } => {
      if (!activeRemoteSession || activeRemoteSession.sessionId !== options?.sessionId) {
        return { ok: false, error: 'session_not_found' };
      }
      if (!isValidPcmBase64Chunk(options.pcmBase64)) {
        return { ok: false, error: 'invalid_pcm' };
      }
      const worker = mlxWorker;
      if (!worker || worker.state === 'stopping' || worker.utterance !== activeRemoteSession.utt) {
        return { ok: false, error: 'session_not_found' };
      }
      try {
        worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'pcm', data: options.pcmBase64.trim() })}\n`);
        refreshRemoteIdleTimer(activeRemoteSession.utt);
        return { ok: true };
      } catch {
        const utt = activeRemoteSession.utt;
        cleanupRemoteSession(utt, {
          sendWorkerAbort: false,
          errorCode: 'helper_error',
          emitEnd: true,
        });
        shutdownMlxWorker(worker);
        return { ok: false, error: 'worker_write_failed' };
      }
    };

    const stopRemoteSession = async (options: {
      sessionId: string;
      abort?: boolean;
    }): Promise<{ ok: boolean; error?: string }> => {
      const current = activeRemoteSession;
      if (options?.sessionId === '*' && options.abort) {
        if (!current) return { ok: true };
        cleanupRemoteSession(current.utt, {
          sendWorkerAbort: true,
          shutdownIfNotReady: true,
          emitEnd: true,
        });
        return { ok: true };
      }
      if (!current || current.sessionId !== options?.sessionId) {
        return { ok: false, error: 'session_not_found' };
      }
      const { utt } = current;
      const worker = mlxWorker && mlxWorker.utterance === utt ? mlxWorker : null;

      clearRemoteIdleTimer();
      clearRemoteStopTimer();

      if (options.abort) {
        cleanupRemoteSession(utt, {
          sendWorkerAbort: true,
          shutdownIfNotReady: true,
          emitEnd: true,
        });
        return { ok: true };
      }

      if (!worker || worker.state === 'stopping') {
        cleanupRemoteSession(utt, {
          sendWorkerAbort: false,
          emitEnd: true,
        });
        return { ok: true };
      }

      utt.stopRequested = true;
      try {
        worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
      } catch {
        cleanupRemoteSession(utt, {
          sendWorkerAbort: false,
          emitEnd: true,
        });
        shutdownMlxWorker(worker);
        return { ok: true };
      }

      await new Promise<void>((resolveStop) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearRemoteStopTimer();
          resolveStop();
        };
        utt.waitersForEnd.push(done);
        remoteStopTimer = setTimeout(() => {
          cleanupRemoteSession(utt, {
            sendWorkerAbort: true,
            shutdownIfNotReady: true,
            emitEnd: true,
          });
          done();
        }, QWEN_LOCAL_FINALIZE_TIMEOUT_MS);
      });
      return { ok: true };
    };

    const registerIpc = (ipcMain: PcAppIpcMainLike) => {
    ipcMain.handle(PC_APP_VOICE_CHANNELS.getPermissions, async (event) => {
      assertTrustedSender(event);
      return getPermissions();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.requestPermissions, async (event) => {
      assertTrustedSender(event);
      return requestPermissions();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.openPrivacySettings, async (event, target) => {
      assertTrustedSender(event);
      return openPrivacySettings(target);
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.startListening, async (event, opts) => {
      assertTrustedSender(event);
      const obj = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
      return startListening({
        locale: typeof obj.locale === 'string' ? obj.locale : undefined,
        initialPcmBase64: typeof obj.initialPcmBase64 === 'string' ? obj.initialPcmBase64 : undefined,
        finalizeOnly: obj.finalizeOnly === true,
        hotwords: Array.isArray(obj.hotwords) ? obj.hotwords.filter((item): item is string => typeof item === 'string') : undefined,
      });
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.stopListening, async (event, opts) => {
      assertTrustedSender(event);
      const abort = Boolean(opts && typeof opts === 'object' && (opts as { abort?: unknown }).abort);
      await stopListening({ abort });
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.finalizePcmListening, async (event, opts) => {
      assertTrustedSender(event);
      const obj = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
      return startListening({
        locale: typeof obj.locale === 'string' ? obj.locale : undefined,
        initialPcmBase64: typeof obj.pcmBase64 === 'string' ? obj.pcmBase64 : undefined,
        finalizeOnly: true,
        hotwords: Array.isArray(obj.hotwords) ? obj.hotwords.filter((item): item is string => typeof item === 'string') : undefined,
      });
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.getSpeechModel, async (event) => {
      assertTrustedSender(event);
      return getSpeechModel();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.setSpeechModel, async (event, model) => {
      assertTrustedSender(event);
      return setSpeechModel(model);
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.getSpeechModelStatus, async (event) => {
      assertTrustedSender(event);
      return getSpeechModelStatus();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.getInputDevices, async (event) => {
      assertTrustedSender(event);
      return getInputDevices();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.getInputDevice, async (event) => {
      assertTrustedSender(event);
      return getSelectedInputDevice();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.setInputDevice, async (event, uid) => {
      assertTrustedSender(event);
      return setSelectedInputDevice(uid);
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.getRemoteProviderInfo, async (event) => {
      assertTrustedSender(event);
      remoteBridgeActivated = true;
      return getRemoteProviderInfo();
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.startRemoteSession, async (event, opts) => {
      assertTrustedSender(event);
      remoteBridgeActivated = true;
      const rec = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
      return startRemoteSession({
        sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
        locale: typeof rec.locale === 'string' ? rec.locale : undefined,
        hotwords: Array.isArray(rec.hotwords) ? rec.hotwords.filter((item): item is string => typeof item === 'string') : undefined,
      });
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.pushRemotePcm, async (event, opts) => {
      assertTrustedSender(event);
      const rec = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
      return pushRemotePcm({
        sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
        pcmBase64: typeof rec.pcmBase64 === 'string' ? rec.pcmBase64 : '',
      });
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.stopRemoteSession, async (event, opts) => {
      assertTrustedSender(event);
      const rec = opts && typeof opts === 'object' ? (opts as Record<string, unknown>) : {};
      return stopRemoteSession({
        sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : '',
        abort: Boolean(rec.abort),
      });
    });
  };

  const unregisterIpc = (ipcMain: PcAppIpcMainLike) => {
    for (const channel of [
      PC_APP_VOICE_CHANNELS.getPermissions,
      PC_APP_VOICE_CHANNELS.requestPermissions,
      PC_APP_VOICE_CHANNELS.openPrivacySettings,
      PC_APP_VOICE_CHANNELS.startListening,
      PC_APP_VOICE_CHANNELS.stopListening,
      PC_APP_VOICE_CHANNELS.finalizePcmListening,
      PC_APP_VOICE_CHANNELS.getSpeechModel,
      PC_APP_VOICE_CHANNELS.setSpeechModel,
      PC_APP_VOICE_CHANNELS.getSpeechModelStatus,
      PC_APP_VOICE_CHANNELS.getInputDevices,
      PC_APP_VOICE_CHANNELS.getInputDevice,
      PC_APP_VOICE_CHANNELS.setInputDevice,
      PC_APP_VOICE_CHANNELS.getRemoteProviderInfo,
      PC_APP_VOICE_CHANNELS.startRemoteSession,
      PC_APP_VOICE_CHANNELS.pushRemotePcm,
      PC_APP_VOICE_CHANNELS.stopRemoteSession,
    ]) {
      ipcMain.removeHandler?.(channel);
    }
  };

  return {
    isTrustedSender,
    appendLog: appendVoiceLog,
    getSpeechHelperPath: resolveSpeechHelperPath,
    getPermissions,
    requestPermissions,
    ensureMediaAccessOnWebPermissionRequest,
    openPrivacySettings,
    startListening,
    stopListening,
    getSpeechModel,
    setSpeechModel,
    getSpeechModelStatus,
    getSpeechModelStatusSync: computeStatusSync,
    getInputDevices,
    getInputDevicesSync: (): PcAppInputDevice[] => [...cachedInputDevices],
    getSelectedInputDevice,
    setSelectedInputDevice,
    getRemoteProviderInfo,
    startRemoteSession,
    pushRemotePcm,
    stopRemoteSession,
    subscribeRemoteEvents,
    warmSelectedSpeechModel: triggerDownloadIfSelected,
    registerIpc,
    unregisterIpc,
    dispose: async () => {
      controllerDisposed = true;
      clearRemoteIdleTimer();
      clearRemoteStopTimer();
      downloader.cancelActive();
      if (activeRemoteSession) {
        await stopRemoteSession({ sessionId: activeRemoteSession.sessionId, abort: true });
      }
      await stopListening({ abort: true });
      shutdownMlxWorker();
    },
  };
}
