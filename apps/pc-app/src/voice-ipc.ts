import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSameActiveOrigin } from './security.js';
import {
  choiceToSpeechVariant,
  isValidSpeechModelChoice,
  PcAppSpeechModelDownloader,
  PcAppSpeechModelStore,
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
  mlxHelperPath?: string;
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
    execFileSync('swiftc', ['-O', '-target', `${arch}-apple-macosx12.0`, srcPath, '-o', outPath], {
      stdio: 'pipe',
      timeout: 60_000,
    });
    chmodSync(outPath, 0o755);
    return outPath;
  } catch {
    return null;
  }
}

export function createPcAppVoiceController(deps: PcAppVoiceControllerDeps) {
  let activeChild: ChildProcess | null = null;
  let activeStopTimer: ReturnType<typeof setTimeout> | null = null;
  let cachedDevHelperPath: string | null = null;
  let cachedMlxSupport: boolean | null =
    deps.platform !== 'darwin' || (deps.arch ?? process.arch) !== 'arm64' ? false : null;
  let lastProgressNotifiedBucket = -1;
  let lastProgressNotifiedState: PcAppSpeechModelStatus['state'] | null = null;
  let lastProgressNotifiedDownloading: PcAppSpeechVariant | null = null;
  let lastProgressNotifiedMlx: boolean | null = cachedMlxSupport;

  const modelStore = new PcAppSpeechModelStore(deps.userDataDir);
  const loadedModel = modelStore.load();
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
    if (cachedMlxSupport === false) {
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
    if (cachedMlxSupport === false) return 'system';
    const variant = choiceToSpeechVariant(selectedModel);
    if (!variant) return 'system';
    return downloader.isModelReadySync(variant) ? selectedModel : 'system';
  };

  const computeStatusSync = (): PcAppSpeechModelStatus => {
    const mlxSupported = cachedMlxSupport ?? false;
    const status06 = getVariantStatusSync('0.6b');
    const status17 = getVariantStatusSync('1.7b');
    const models = {
      'qwen3-0.6b': status06,
      'qwen3-1.7b': status17,
    };
    const downloadingModel = downloadingVariant ? variantToChoice(downloadingVariant) : null;
    const effectiveSelected = getEffectiveSelectedModel();
    const activeBackend: PcAppSpeechModelChoice = mlxSupported ? effectiveSelected : 'system';

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
        modelDir: dlStatus.modelDir,
        downloadingModel,
        models,
      };
    }

    if (cachedMlxSupport === false && (selectedModel !== 'system' || lastStatusVariant !== null)) {
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
        state: mlxSupported ? activeStatus.state : 'unsupported',
        progress: mlxSupported ? activeStatus.progress : 0,
        downloadedBytes: mlxSupported ? activeStatus.downloadedBytes : 0,
        totalBytes: activeStatus.totalBytes,
        mlxSupported,
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
      downloadingModel: null,
      models,
    };
  };

  const notifyStatusChanged = (force = false) => {
    const status = computeStatusSync();
    const bucket = status.state === 'downloading' ? Math.floor(status.progress * 100) : -1;
    if (
      !force
      && status.state === lastProgressNotifiedState
      && bucket === lastProgressNotifiedBucket
      && downloadingVariant === lastProgressNotifiedDownloading
      && status.mlxSupported === lastProgressNotifiedMlx
    ) {
      return;
    }
    lastProgressNotifiedState = status.state;
    lastProgressNotifiedBucket = bucket;
    lastProgressNotifiedDownloading = downloadingVariant;
    lastProgressNotifiedMlx = status.mlxSupported;
    deps.onSpeechModelStatusChanged?.(status);
  };

  const downloader = new PcAppSpeechModelDownloader({
    modelsBaseDir: deps.speechModelsDir ?? join(deps.userDataDir, 'speech-models'),
    manifests: deps.manifests,
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
    if (deps.platform !== 'darwin') return null;
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

  const stopListening = async (options?: { abort?: boolean }): Promise<void> => {
    if (activeStopTimer !== null) {
      clearTimeout(activeStopTimer);
      activeStopTimer = null;
    }
    const child = activeChild;
    if (!child) return;
    if (options?.abort) {
      activeChild = null;
      try {
        child.kill('SIGTERM');
      } catch { /* already exited */ }
      return;
    }
    try {
      child.stdin?.write('stop\n');
      child.stdin?.end();
    } catch {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
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
      child.once('exit', done);
      activeStopTimer = setTimeout(() => {
        if (activeChild === child) {
          activeChild = null;
        }
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        done();
      }, 2_200);
    });
  };

  const startListening = async (options?: {
    locale?: string;
    onEvent?: (event: PcAppVoiceEvent) => void;
  }): Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }> => {
    if (deps.platform !== 'darwin') {
      return { ok: false, error: 'unsupported_platform' };
    }
    const perms = await requestPermissions();
    if (perms.mic !== 'granted') {
      appendVoiceLog(`startListening denied target=mic selectedModel=${selectedModel} device=${selectedInputDevice}`);
      return { ok: false, error: 'permission_denied', target: 'mic' };
    }

    const variant = choiceToSpeechVariant(selectedModel);
    let bin: string | null = null;
    let args: string[];

    if (variant && (await checkMlxSupported()) && downloader.isModelReadySync(variant)) {
      const mlxBin = resolveMlxHelperPath();
      const verified = await downloader.verifyModelFilesOnDisk(variant);
      if (mlxBin && verified) {
        bin = mlxBin;
        args = ['listen', '--model-dir', downloader.getModelDirectory(variant), '--variant', variant];
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
      if (perms.speech !== 'granted') {
        appendVoiceLog(`startListening denied target=speech selectedModel=${selectedModel} device=${selectedInputDevice}`);
        return { ok: false, error: 'permission_denied', target: 'speech' };
      }
      bin = resolveSpeechHelperPath();
      if (!bin) {
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

    appendVoiceLog(`startListening model=${selectedModel} device=${selectedInputDevice} bin=${bin} args=${JSON.stringify(args)}`);
    const child = (deps.spawnHelper ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(bin, args);
    activeChild = child;

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let loggedFirstLevel = false;
    let loggedFirstResult = false;
    const emitSafe = (payload: PcAppVoiceEvent) => {
      if (payload.type === 'level' && !loggedFirstLevel && payload.value > 0.01) {
        loggedFirstLevel = true;
        appendVoiceLog(`first level value=${payload.value.toFixed(4)}`);
      } else if (payload.type === 'result' && !loggedFirstResult && payload.text.trim()) {
        loggedFirstResult = true;
        appendVoiceLog(
          `first result isFinal=${payload.isFinal} len=${payload.text.trim().length} text=${JSON.stringify(payload.text.trim().slice(0, 80))}`,
        );
      } else if (payload.type === 'error') {
        appendVoiceLog(`helper error code=${payload.code} target=${payload.target ?? '-'} message=${payload.message ?? '-'}`);
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
    const prevMlx = cachedMlxSupport;
    await checkMlxSupported();
    if (prevMlx !== cachedMlxSupport) {
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
    if (deps.platform !== 'darwin') {
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
    dispose: () => {
      downloader.cancelActive();
      return stopListening({ abort: true });
    },
  };
}
