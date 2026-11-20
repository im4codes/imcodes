import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSameActiveOrigin } from './security.js';

export const PC_APP_VOICE_CHANNELS = Object.freeze({
  getPermissions: 'imcodes:pc-voice:get-permissions',
  requestPermissions: 'imcodes:pc-voice:request-permissions',
  openPrivacySettings: 'imcodes:pc-voice:open-privacy-settings',
  startListening: 'imcodes:pc-voice:start',
  stopListening: 'imcodes:pc-voice:stop',
  event: 'imcodes:pc-voice:event',
} as const);

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
  userDataDir: string;
  resourcesPath?: string;
  speechHelperPath?: string;
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
  }): Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }> => {
    if (deps.platform !== 'darwin') {
      return { ok: false, error: 'unsupported_platform' };
    }
    const perms = await requestPermissions();
    if (perms.mic !== 'granted') {
      return { ok: false, error: 'permission_denied', target: 'mic' };
    }
    if (perms.speech !== 'granted') {
      return { ok: false, error: 'permission_denied', target: 'speech' };
    }
    const bin = resolveSpeechHelperPath();
    if (!bin) {
      return { ok: false, error: 'speech_helper_unavailable' };
    }
    await stopListening({ abort: true });

    const args = ['listen'];
    if (typeof options?.locale === 'string' && options.locale.trim()) {
      args.push('--locale', options.locale.trim());
    }

    const child = (deps.spawnHelper ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(bin, args);
    activeChild = child;

    let stdoutBuffer = '';
    const emitSafe = (payload: PcAppVoiceEvent) => {
      if (!deps.getCurrentTrustedOrigin()) return;
      deps.sendToRenderer(PC_APP_VOICE_CHANNELS.event, payload);
    };

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
          emitSafe({ type: 'error', code: 'helper_exited' });
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
  };

  const unregisterIpc = (ipcMain: PcAppIpcMainLike) => {
    for (const channel of [
      PC_APP_VOICE_CHANNELS.getPermissions,
      PC_APP_VOICE_CHANNELS.requestPermissions,
      PC_APP_VOICE_CHANNELS.openPrivacySettings,
      PC_APP_VOICE_CHANNELS.startListening,
      PC_APP_VOICE_CHANNELS.stopListening,
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
    registerIpc,
    unregisterIpc,
    dispose: () => stopListening({ abort: true }),
  };
}
