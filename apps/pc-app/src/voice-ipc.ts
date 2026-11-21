import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSameActiveOrigin } from './security.js';
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
  getSpeechModel: 'imcodes:pc-voice:get-speech-model',
  setSpeechModel: 'imcodes:pc-voice:set-speech-model',
  getSpeechModelStatus: 'imcodes:pc-voice:get-speech-model-status',
  getInputDevices: 'imcodes:pc-voice:get-input-devices',
  getInputDevice: 'imcodes:pc-voice:get-input-device',
  setInputDevice: 'imcodes:pc-voice:set-input-device',
  event: 'imcodes:pc-voice:event',
} as const);

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
  mlxHelperPath?: string;
  winProvider?: 'auto' | 'directml' | 'cpu';
  isMainWebContents: (sender: unknown) => boolean;
  getCurrentTrustedOrigin: () => string | null;
  getActiveOrigin: () => string | null;
  getTrustedOrigins: () => ReadonlySet<string>;
  getSenderUrl: () => string;
  sendToRenderer: (channel: string, payload: PcAppVoiceEvent) => void;
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
  let activeChild: ChildProcess | null = null;
  let activeChildIsMlx = false;
  let activeStopTimer: ReturnType<typeof setTimeout> | null = null;
  let cachedDevHelperPath: string | null = null;
  let cachedMlxSupport: boolean | null =
    !isDarwin || (deps.arch ?? process.arch) !== 'arm64' ? false : null;
  let cachedWinOnnxSupport: boolean | null = isWin32 ? null : false;
  let cachedWinGpuName: string | null = null;
  let cachedWinVramMb: number | null = null;
  let cachedWinProvider: 'directml' | 'cpu' = deps.winProvider === 'directml' ? 'directml' : 'cpu';
  let lastProgressNotifiedBucket = -1;
  let lastProgressNotifiedState: PcAppSpeechModelStatus['state'] | null = null;
  let lastProgressNotifiedDownloading: PcAppSpeechVariant | null = null;
  let lastProgressNotifiedMlx: boolean | null = isWin32 ? cachedWinOnnxSupport : cachedMlxSupport;
  let lastProgressNotifiedAt = 0;

  interface ActiveWorkerUtterance {
    source?: 'in-app' | 'global';
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
    killTimer: ReturnType<typeof setTimeout> | null;
  }

  let mlxWorker: ResidentMlxWorker | null = null;
  let activeWorkerUtterance: ActiveWorkerUtterance | null = null;
  let workerSpawnInFlight: { variant: PcAppSpeechVariant; promise: Promise<ResidentMlxWorker | null> } | null = null;
  let serveUnsupported = false;
  let controllerDisposed = false;

  const shouldUseResidentMlxWorker = (): boolean =>
    !controllerDisposed && !serveUnsupported && (deps.useResidentMlxWorker ?? (deps.spawnHelper === undefined));

  const modelStore = new PcAppSpeechModelStore(deps.userDataDir);
  const loadedModel = modelStore.load(isWin32 ? 'qwen3-0.6b' : 'system');
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
    isWin32 ? resolveWinSpeechHelperPath() : resolveMlxHelperPath();

  const isLocalAsrSupportedSync = (): boolean =>
    isWin32 ? (cachedWinOnnxSupport ?? false) : (cachedMlxSupport ?? false);

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
    const cachedSupport = isWin32 ? cachedWinOnnxSupport : cachedMlxSupport;
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
    const cachedSupport = isWin32 ? cachedWinOnnxSupport : cachedMlxSupport;
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
    const winMeta = isWin32
      ? {
          localAsrSupported,
          executionProvider: activeBackend === 'system' ? ('system' as const) : cachedWinProvider,
          gpuName: cachedWinGpuName,
          vramMb: cachedWinVramMb,
          lowVramWarning:
            selectedModel === 'qwen3-1.7b' &&
            cachedWinVramMb !== null &&
            cachedWinVramMb < WIN32_GPU_MIN_VRAM_MB,
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

    const cachedSupport = isWin32 ? cachedWinOnnxSupport : cachedMlxSupport;
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
    if (isWin32) {
      if (cachedWinOnnxSupport !== null) return cachedWinOnnxSupport;
      const winBin = resolveWinSpeechHelperPath();
      if (!winBin) {
        cachedWinOnnxSupport = false;
        cachedWinGpuName = null;
        cachedWinVramMb = null;
        cachedWinProvider = 'cpu';
        return false;
      }
      try {
        const raw = deps.runHelperSync
          ? deps.runHelperSync(winBin, ['probe'])
          : await (deps.runHelperAsync ?? defaultRunHelperAsync)(winBin, ['probe']);
        const parsed = JSON.parse(raw.trim()) as {
          ok?: unknown;
          gpuName?: unknown;
          vramMb?: unknown;
          provider?: unknown;
          localAsrSupported?: unknown;
        };
        const vram = typeof parsed.vramMb === 'number' && Number.isFinite(parsed.vramMb)
          ? Math.max(0, Math.round(parsed.vramMb))
          : 0;
        cachedWinGpuName = typeof parsed.gpuName === 'string' && parsed.gpuName.trim() ? parsed.gpuName.trim() : null;
        cachedWinVramMb = vram;
        // Enforce benchmark policy: DirectML ONLY when dedicated VRAM >= 4096 MB; < 4 GB uses CPU.
        if (deps.winProvider === 'cpu') {
          cachedWinProvider = 'cpu';
        } else if (deps.winProvider === 'directml') {
          cachedWinProvider = vram >= WIN32_GPU_MIN_VRAM_MB ? 'directml' : 'cpu';
        } else {
          cachedWinProvider = vram >= WIN32_GPU_MIN_VRAM_MB && parsed.provider === 'directml'
            ? 'directml'
            : 'cpu';
        }
        cachedWinOnnxSupport = parsed.localAsrSupported !== false && parsed.ok !== false;
      } catch {
        cachedWinGpuName = null;
        cachedWinVramMb = 0;
        cachedWinProvider = 'cpu';
        cachedWinOnnxSupport = true;
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
    if (isWin32) {
      const winBin = resolveWinSpeechHelperPath();
      if (!winBin) {
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

  const emitWorkerUtteranceEvent = (utt: ActiveWorkerUtterance | null, payload: PcAppVoiceEvent): void => {
    if (!utt) return;
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

  const shutdownMlxWorker = (target?: ResidentMlxWorker | null): void => {
    const worker = target ?? mlxWorker;
    if (!worker) return;
    if (mlxWorker === worker) {
      mlxWorker = null;
    }
    if (workerSpawnInFlight && !target) {
      workerSpawnInFlight = null;
    }
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
      const args = isWin32
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
            appendVoiceLog(`mlx serve ready variant=${parsed.variant ?? worker.variant}`);
            continue;
          }

          if (parsed.type === 'error') {
            if (parsed.code === 'unknown_command' && worker.state !== 'ready') {
              serveUnsupported = true;
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
        const utt = worker.utterance;
        if (utt) {
          worker.utterance = null;
          if (activeWorkerUtterance === utt) {
            activeWorkerUtterance = null;
          }
          if (!wasStopping && code && code !== 0) {
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

  const stopListening = async (options?: { abort?: boolean }): Promise<void> => {
    if (activeStopTimer !== null) {
      clearTimeout(activeStopTimer);
      activeStopTimer = null;
    }

    if (activeWorkerUtterance) {
      const utt = activeWorkerUtterance;
      const worker = mlxWorker && mlxWorker.utterance === utt ? mlxWorker : null;
      if (options?.abort) {
        activeWorkerUtterance = null;
        if (worker) {
          worker.utterance = null;
          try {
            worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'abort' })}\n`);
          } catch {
            shutdownMlxWorker(worker);
          }
        }
        resolveUtteranceWaiters(utt);
        notifyVoiceEvent({ type: 'end' });
        return;
      }

      if (!worker || worker.state === 'stopping') {
        activeWorkerUtterance = null;
        if (worker) worker.utterance = null;
        resolveUtteranceWaiters(utt);
        notifyVoiceEvent({ type: 'end' });
        return;
      }

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
            worker.utterance = null;
            try {
              worker.proc.stdin?.write(`${JSON.stringify({ cmd: 'abort' })}\n`);
            } catch {
              shutdownMlxWorker(worker);
            }
          }
          notifyVoiceEvent({ type: 'end' });
          resolveUtteranceWaiters(utt);
          done();
        }, 12_000);
      });
      return;
    }

    const child = activeChild;
    const isMlxChild = activeChildIsMlx;
    if (!child) return;
    if (options?.abort) {
      activeChild = null;
      activeChildIsMlx = false;
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
    const stopTimeoutMs = isMlxChild ? 12_000 : 2_200;
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
        }
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        done();
      }, stopTimeoutMs);
    });
  };

  const startListening = async (options?: {
    locale?: string;
    source?: 'in-app' | 'global';
    onEvent?: (event: PcAppVoiceEvent) => void;
  }): Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }> => {
    const isGlobalSource = options?.source === 'global';
    if (!isDarwin && !isWin32) {
      return { ok: false, error: 'unsupported_platform' };
    }
    const perms = await requestPermissions();
    if (perms.mic !== 'granted') {
      if (isWin32) {
        return { ok: false, error: 'speech_helper_unavailable' };
      }
      appendVoiceLog(`startListening denied target=mic selectedModel=${selectedModel} device=${selectedInputDevice}`);
      return { ok: false, error: 'permission_denied', target: 'mic' };
    }

    const variant = choiceToSpeechVariant(selectedModel);
    let bin: string | null = null;
    let args: string[];
    let isMlxHelper = false;

    if (variant && (await checkMlxSupported()) && downloader.isModelReadySync(variant)) {
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
        const worker = await ensureResidentMlxWorker(variant, { skipVerify: alreadyReady });
        if (worker && worker.state !== 'stopping' && !serveUnsupported) {
          await stopListening({ abort: true });
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
          const startCmd: { cmd: 'start'; locale?: string; device?: string } = { cmd: 'start' };
          if (typeof options?.locale === 'string' && options.locale.trim()) {
            startCmd.locale = options.locale.trim();
          }
          if (selectedInputDevice !== 'auto') {
            startCmd.device = selectedInputDevice;
          }
          try {
            appendVoiceLog(`mlx serve start variant=${variant} device=${selectedInputDevice}`);
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

      if (mlxBin) {
        if (isGlobalSource) {
          options?.onEvent?.({ type: 'loading', variant });
        } else {
          notifyVoiceEvent({ type: 'loading', variant });
        }
      }
      const verified = mlxBin ? await downloader.verifyModelFilesOnDisk(variant) : false;
      if (mlxBin && verified) {
        bin = mlxBin;
        isMlxHelper = true;
        args = isWin32
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
      args = [];
    }

    if (!bin) {
      if (isWin32) {
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        const errCode = variant ? 'speech_model_downloading' : 'speech_model_required';
        appendVoiceLog(`startListening win32 unavailable reason=${errCode} selectedModel=${selectedModel}`);
        return { ok: false, error: errCode };
      }
      if (perms.speech !== 'granted') {
        if (!isGlobalSource) notifyVoiceEvent({ type: 'end' });
        appendVoiceLog(`startListening denied target=speech selectedModel=${selectedModel} device=${selectedInputDevice}`);
        return { ok: false, error: 'permission_denied', target: 'speech' };
      }
      bin = resolveSpeechHelperPath();
      if (!bin) {
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

    await stopListening({ abort: true });
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
    const prevSupport = isWin32 ? cachedWinOnnxSupport : cachedMlxSupport;
    const prevProvider = cachedWinProvider;
    const prevVram = cachedWinVramMb;
    await checkMlxSupported();
    const nextSupport = isWin32 ? cachedWinOnnxSupport : cachedMlxSupport;
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
    if (!isDarwin && !isWin32) {
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
      const locale = opts && typeof opts === 'object' && 'locale' in opts
        ? (opts as { locale?: unknown }).locale
        : undefined;
      return startListening({ locale: typeof locale === 'string' ? locale : undefined });
    });
    ipcMain.handle(PC_APP_VOICE_CHANNELS.stopListening, async (event, opts) => {
      assertTrustedSender(event);
      const abort = Boolean(opts && typeof opts === 'object' && (opts as { abort?: unknown }).abort);
      await stopListening({ abort });
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
  };

  const unregisterIpc = (ipcMain: PcAppIpcMainLike) => {
    for (const channel of [
      PC_APP_VOICE_CHANNELS.getPermissions,
      PC_APP_VOICE_CHANNELS.requestPermissions,
      PC_APP_VOICE_CHANNELS.openPrivacySettings,
      PC_APP_VOICE_CHANNELS.startListening,
      PC_APP_VOICE_CHANNELS.stopListening,
      PC_APP_VOICE_CHANNELS.getSpeechModel,
      PC_APP_VOICE_CHANNELS.setSpeechModel,
      PC_APP_VOICE_CHANNELS.getSpeechModelStatus,
      PC_APP_VOICE_CHANNELS.getInputDevices,
      PC_APP_VOICE_CHANNELS.getInputDevice,
      PC_APP_VOICE_CHANNELS.setInputDevice,
    ]) {
      ipcMain.removeHandler?.(channel);
    }
  };

  return {
    isTrustedSender,
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
    warmSelectedSpeechModel: triggerDownloadIfSelected,
    registerIpc,
    unregisterIpc,
    dispose: async () => {
      controllerDisposed = true;
      downloader.cancelActive();
      await stopListening({ abort: true });
      shutdownMlxWorker();
    },
  };
}
