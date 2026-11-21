import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  let cachedMlxSupport: boolean | null = null;
  let lastProgressNotifiedBucket = -1;
  let lastProgressNotifiedState: PcAppSpeechModelStatus['state'] | null = null;

  const modelStore = new PcAppSpeechModelStore(deps.userDataDir);
  let selectedModel: PcAppSpeechModelChoice = modelStore.load();
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
  let modelDownloadState: PcAppSpeechModelStatus['state'] = 'idle';
  let modelDownloadProgress = 0;
  let modelDownloadedBytes = 0;
  let modelTotalBytes = 0;
  let modelDownloadError: string | undefined;

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

  const computeStatusSync = (): PcAppSpeechModelStatus => {
    const variant = choiceToSpeechVariant(selectedModel);
    const mlxSupported = cachedMlxSupport ?? false;
    if (!variant) {
      return {
        selectedModel: 'system',
        activeBackend: 'system',
        state: 'idle',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        mlxSupported,
      };
    }
    const manifest = downloader.getManifest(variant);
    const totalBytes = manifest.files.reduce((sum, f) => sum + f.expectedSize, 0);
    const modelDir = downloader.getModelDirectory(variant);
    const ready = downloader.isModelReadySync(variant);
    if (ready) {
      return {
        selectedModel,
        activeBackend: mlxSupported ? selectedModel : 'system',
        state: mlxSupported ? 'ready' : 'unsupported',
        progress: 1,
        downloadedBytes: totalBytes,
        totalBytes,
        mlxSupported,
        modelDir,
      };
    }
    const effectiveState: PcAppSpeechModelStatus['state'] =
      cachedMlxSupport === false
        ? 'unsupported'
        : modelDownloadState;
    return {
      selectedModel,
      activeBackend: 'system',
      state: effectiveState,
      progress: modelDownloadProgress,
      downloadedBytes: modelDownloadedBytes,
      totalBytes: modelTotalBytes || totalBytes,
      mlxSupported,
      ...(modelDownloadError ? { error: modelDownloadError } : {}),
      modelDir,
    };
  };

  const notifyStatusChanged = (force = false) => {
    const status = computeStatusSync();
    const bucket = status.state === 'downloading' ? Math.floor(status.progress * 10) : -1;
    if (!force && status.state === lastProgressNotifiedState && bucket === lastProgressNotifiedBucket) {
      return;
    }
    lastProgressNotifiedState = status.state;
    lastProgressNotifiedBucket = bucket;
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
      if (choiceToSpeechVariant(selectedModel) !== ev.variant) return;
      modelDownloadState = ev.state;
      modelDownloadProgress = ev.progress;
      modelDownloadedBytes = ev.downloadedBytes;
      modelTotalBytes = ev.totalBytes;
      modelDownloadError = ev.error;
      notifyStatusChanged(ev.state !== 'downloading');
    },
  });

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

  const triggerDownloadIfSelected = async (): Promise<void> => {
    const variant = choiceToSpeechVariant(selectedModel);
    if (!variant) return;
    const supported = await checkMlxSupported();
    if (!supported) {
      modelDownloadState = 'unsupported';
      notifyStatusChanged(true);
      return;
    }
    if (downloader.isModelReadySync(variant)) {
      const valid = await downloader.verifyModelFilesOnDisk(variant);
      if (valid) {
        modelDownloadState = 'ready';
        modelDownloadProgress = 1;
        notifyStatusChanged(true);
        return;
      }
    }
    const manifest = downloader.getManifest(variant);
    modelTotalBytes = manifest.files.reduce((sum, f) => sum + f.expectedSize, 0);
    modelDownloadError = undefined;
    void downloader.ensureDownloaded(variant);
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
        return { ok: false, error: 'permission_denied', target: 'speech' };
      }
      bin = resolveSpeechHelperPath();
      if (!bin) {
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

    const child = (deps.spawnHelper ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(bin, args);
    activeChild = child;

    let stdoutBuffer = '';
    let stderrBuffer = '';
    const emitSafe = (payload: PcAppVoiceEvent) => {
      if (options?.onEvent) {
        options.onEvent(payload);
        return;
      }
      if (!deps.getCurrentTrustedOrigin()) return;
      deps.sendToRenderer(PC_APP_VOICE_CHANNELS.event, payload);
    };

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBuffer += String(chunk);
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

    child.once('exit', (code) => {
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

  const getSpeechModel = (): PcAppSpeechModelChoice => selectedModel;

  const getSpeechModelStatus = async (): Promise<PcAppSpeechModelStatus> => {
    if (choiceToSpeechVariant(selectedModel)) {
      await checkMlxSupported();
    }
    return computeStatusSync();
  };

  const setSpeechModel = async (rawModel: unknown): Promise<PcAppSpeechModelStatus> => {
    if (!isValidSpeechModelChoice(rawModel)) {
      throw new Error(`Invalid speech model: ${String(rawModel)}`);
    }
    selectedModel = rawModel;
    modelStore.save(rawModel);
    modelDownloadError = undefined;
    modelDownloadProgress = 0;
    modelDownloadedBytes = 0;
    modelTotalBytes = 0;

    if (rawModel === 'system') {
      downloader.cancelActive();
      modelDownloadState = 'idle';
      notifyStatusChanged(true);
      return computeStatusSync();
    }

    modelDownloadState = 'idle';
    await triggerDownloadIfSelected();
    notifyStatusChanged(true);
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
