import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path, { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizePcAppLocale, tPcApp, type PcAppLocale } from './i18n.js';
import type { PcAppVoiceEvent } from './voice-ipc.js';

export const GLOBAL_VOICE_LEVEL_MIN_INTERVAL_MS = 66;

export interface GlobalVoiceWindowLike {
  isDestroyed?(): boolean;
  isFocused?(): boolean;
}

export interface GlobalVoicePasteResult {
  stdout: string;
}

export interface PcAppGlobalVoiceDeps {
  platform: NodeJS.Platform;
  userDataDir: string;
  resourcesPath?: string;
  iconPath?: string | null;
  getLocale: () => PcAppLocale | string;
  getMainWindow: () => GlobalVoiceWindowLike | null;
  getSpeechHelperPath: () => string | null;
  voice: {
    startListening(options?: {
      locale?: string;
      source?: 'in-app' | 'global';
      onEvent?: (event: PcAppVoiceEvent) => void;
    }): Promise<{ ok: boolean; error?: string; target?: 'mic' | 'speech' }>;
    stopListening(options?: { abort?: boolean }): Promise<void>;
  };
  spawnHelper?: (binPath: string, args: string[]) => ChildProcess;
  runPasteHelper?: (binPath: string, args: string[], stdinText: string) => Promise<string>;
  onStateChanged?: (enabled: boolean) => void;
  onError?: (code: string, message?: string) => void;
  now?: () => number;
}

export interface PcAppGlobalVoiceController {
  isEnabled(): boolean;
  start(): void;
  setEnabled(enabled: boolean): Promise<boolean>;
  toggleDictation(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Atomic file-backed persistence for the PC App global voice toggle (`global-voice.json`).
 */
export class PcAppGlobalVoiceStore {
  private readonly filePath: string;

  constructor(userDataDir: string, fileName = 'global-voice.json') {
    this.filePath = path.join(userDataDir, fileName);
  }

  load(): boolean | null {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown; enabled?: unknown } | null;
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
      return typeof parsed.enabled === 'boolean' ? parsed.enabled : null;
    } catch {
      return null;
    }
  }

  save(enabled: boolean): void {
    const dir = path.dirname(this.filePath);
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(
        tmpPath,
        JSON.stringify({ version: 1, enabled }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );
      renameSync(tmpPath, this.filePath);
    } catch {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Fail soft on unwritable userDataDir.
      }
    }
  }
}

export function resolveGlobalVoiceOverlayIconPath(options?: {
  resourcesPath?: string;
  moduleDir?: string;
}): string | null {
  const moduleDir = options?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  if (options?.resourcesPath) {
    candidates.push(join(options.resourcesPath, 'icon.icns'));
    candidates.push(join(options.resourcesPath, 'build', 'icon.png'));
  }
  candidates.push(resolve(moduleDir, '../../build/icon.png'));
  candidates.push(resolve(moduleDir, '../build/icon.png'));
  return candidates.find((p) => existsSync(p)) ?? null;
}

function defaultRunPasteHelper(binPath: string, args: string[], stdinText: string): Promise<string> {
  return new Promise((resolveOut, rejectOut) => {
    const child = execFile(binPath, args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout) => {
      if (err) {
        if (stdout && stdout.trim()) {
          resolveOut(stdout);
          return;
        }
        rejectOut(err);
        return;
      }
      resolveOut(stdout);
    });
    child.stdin?.write(stdinText);
    child.stdin?.end();
  });
}

function clampLevel(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

type DictationPhase = 'idle' | 'starting' | 'listening' | 'draining' | 'pasting';

/**
 * Manage macOS system-wide Double-Tap Ctrl hotkey detection, non-activating
 * floating NSPanel overlay (with IM.codes robot logo), dictation lifecycle,
 * and Accessibility Unicode pasting into foreground applications.
 */
export function createPcAppGlobalVoice(deps: PcAppGlobalVoiceDeps): PcAppGlobalVoiceController {
  const store = new PcAppGlobalVoiceStore(deps.userDataDir);
  const stored = store.load();
  let enabled = deps.platform === 'darwin' ? (stored ?? true) : false;
  let disposed = false;
  let started = false;

  let hotkeyProc: ChildProcess | null = null;
  let hotkeyStdoutBuffer = '';
  let hotkeyRestartTimer: ReturnType<typeof setTimeout> | null = null;

  let overlayProc: ChildProcess | null = null;

  let phase: DictationPhase = 'idle';
  let cancelRequestedDuringStart = false;
  let stopRequestedDuringStart = false;
  let latestText = '';
  let finalText: string | null = null;
  let latestLevel = 0;
  let lastLevelSentAt = 0;
  let activeSessionId = 0;

  const currentNow = (): number => (deps.now ? deps.now() : Date.now());
  const resolveLocale = (): PcAppLocale => normalizePcAppLocale(deps.getLocale());

  const spawnHelper = (binPath: string, args: string[]): ChildProcess =>
    (deps.spawnHelper ?? ((p, a) => spawn(p, a, { stdio: ['pipe', 'pipe', 'pipe'] })))(binPath, args);

  const resolveIconPath = (): string | null => {
    if (deps.iconPath !== undefined) return deps.iconPath;
    return resolveGlobalVoiceOverlayIconPath({ resourcesPath: deps.resourcesPath });
  };

  const clearHotkeyRestartTimer = (): void => {
    if (hotkeyRestartTimer !== null) {
      clearTimeout(hotkeyRestartTimer);
      hotkeyRestartTimer = null;
    }
  };

  const terminateChild = (proc: ChildProcess | null): void => {
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      // Ignore closed stdin.
    }
    try {
      proc.kill('SIGTERM');
    } catch {
      // Already exited.
    }
  };

  const ensureOverlayProcess = (): ChildProcess | null => {
    if (disposed || !enabled || deps.platform !== 'darwin') return null;
    if (overlayProc) return overlayProc;
    const bin = deps.getSpeechHelperPath();
    if (!bin) return null;
    const iconPath = resolveIconPath();
    const args = ['overlay'];
    if (iconPath) {
      args.push('--icon', iconPath);
    }
    try {
      const proc = spawnHelper(bin, args);
      overlayProc = proc;
      proc.once('exit', () => {
        if (overlayProc === proc) {
          overlayProc = null;
        }
      });
      proc.once('error', () => {
        if (overlayProc === proc) {
          overlayProc = null;
        }
      });
      return proc;
    } catch {
      return null;
    }
  };

  const sendOverlayCommand = (payload: Record<string, unknown>): void => {
    if (payload.cmd === 'hide' && !overlayProc) return;
    const proc = payload.cmd === 'hide' ? overlayProc : ensureOverlayProcess();
    if (!proc) return;
    try {
      proc.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      if (overlayProc === proc) {
        overlayProc = null;
      }
    }
  };

  const showOverlay = (state: 'loading' | 'listening' | 'draining', text = '', level = 0): void => {
    const locale = resolveLocale();
    const titleKey =
      state === 'loading'
        ? 'voiceHud.loading'
        : state === 'draining'
          ? 'voiceHud.finishing'
          : 'voiceHud.listening';
    const iconPath = resolveIconPath();
    sendOverlayCommand({
      cmd: 'show',
      state,
      title: tPcApp(locale, titleKey),
      text,
      level,
      ...(iconPath ? { iconPath } : {}),
    });
  };

  const hideOverlay = (): void => {
    sendOverlayCommand({ cmd: 'hide' });
  };

  const isMainWindowFocused = (): boolean => {
    try {
      const win = deps.getMainWindow();
      return Boolean(win && !win.isDestroyed?.() && win.isFocused?.() === true);
    } catch {
      return false;
    }
  };

  const pasteRecognizedText = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const bin = deps.getSpeechHelperPath();
    if (!bin) return;
    const runPaste = deps.runPasteHelper ?? defaultRunPasteHelper;
    try {
      const stdout = await runPaste(bin, ['paste', '--stdin'], trimmed);
      const line = stdout.trim().split('\n').pop() ?? '';
      if (line) {
        try {
          const parsed = JSON.parse(line) as { type?: string; code?: string; message?: string };
          if (parsed.type === 'error' && parsed.code) {
            deps.onError?.(parsed.code, parsed.message);
          }
        } catch {
          // Ignore non-JSON paste output.
        }
      }
    } catch (err) {
      deps.onError?.('paste_failed', err instanceof Error ? err.message : String(err));
    }
  };

  const resetActiveDictationState = (): void => {
    phase = 'idle';
    cancelRequestedDuringStart = false;
    stopRequestedDuringStart = false;
    latestText = '';
    finalText = null;
    latestLevel = 0;
    lastLevelSentAt = 0;
  };

  const finishAndPasteCurrent = async (sessionId: number): Promise<void> => {
    if (phase !== 'listening' && phase !== 'starting') return;
    phase = 'draining';
    showOverlay('draining', latestText, 0);
    await deps.voice.stopListening();
    if (sessionId !== activeSessionId) return;
    hideOverlay();

    const textToPaste = (finalText ?? latestText).trim();
    if (textToPaste && !disposed && enabled) {
      phase = 'pasting';
      await pasteRecognizedText(textToPaste);
    }
    if (sessionId === activeSessionId) {
      resetActiveDictationState();
    }
  };

  const startGlobalDictation = async (): Promise<void> => {
    if (disposed || !enabled || deps.platform !== 'darwin') return;
    if (phase !== 'idle') return;

    const sessionId = ++activeSessionId;
    phase = 'starting';
    cancelRequestedDuringStart = false;
    stopRequestedDuringStart = false;
    latestText = '';
    finalText = null;
    latestLevel = 0;
    lastLevelSentAt = 0;

    showOverlay('loading', '', 0);

    const locale = resolveLocale();
    const res = await deps.voice.startListening({
      locale,
      source: 'global',
      onEvent: (ev) => {
        if (sessionId !== activeSessionId) return;
        switch (ev.type) {
          case 'loading':
            if (phase === 'starting') {
              showOverlay('loading', '', 0);
            }
            return;
          case 'ready':
          case 'start':
            if (phase === 'starting' || phase === 'listening') {
              phase = 'listening';
              showOverlay('listening', latestText, latestLevel);
            }
            return;
          case 'level': {
            if (phase !== 'listening') return;
            latestLevel = clampLevel(ev.value);
            const now = currentNow();
            if (lastLevelSentAt > 0 && now - lastLevelSentAt < GLOBAL_VOICE_LEVEL_MIN_INTERVAL_MS) {
              return;
            }
            lastLevelSentAt = now;
            showOverlay('listening', latestText, latestLevel);
            return;
          }
          case 'result':
            latestText = ev.text;
            if (ev.isFinal) {
              finalText = ev.text;
            }
            if (phase === 'listening' || phase === 'draining') {
              showOverlay(phase === 'draining' ? 'draining' : 'listening', latestText, phase === 'draining' ? 0 : latestLevel);
            }
            return;
          case 'error':
            hideOverlay();
            resetActiveDictationState();
            deps.onError?.(ev.code, ev.message);
            return;
          case 'end':
            if (phase === 'starting' || phase === 'listening') {
              hideOverlay();
              resetActiveDictationState();
            }
            return;
        }
      },
    });

    if (sessionId !== activeSessionId) return;

    if (!res.ok) {
      hideOverlay();
      resetActiveDictationState();
      deps.onError?.(res.error ?? 'start_failed');
      return;
    }

    if (cancelRequestedDuringStart || disposed || !enabled) {
      await deps.voice.stopListening({ abort: true });
      if (sessionId === activeSessionId) {
        hideOverlay();
        resetActiveDictationState();
      }
      return;
    }

    if (stopRequestedDuringStart) {
      await finishAndPasteCurrent(sessionId);
    }
  };

  const toggleDictation = async (): Promise<void> => {
    if (disposed || !enabled || deps.platform !== 'darwin') return;
    if (phase === 'idle') {
      await startGlobalDictation();
      return;
    }
    if (phase === 'starting') {
      stopRequestedDuringStart = true;
      return;
    }
    if (phase === 'listening') {
      await finishAndPasteCurrent(activeSessionId);
    }
  };

  const spawnHotkeyMonitor = (): void => {
    if (disposed || !enabled || !started || deps.platform !== 'darwin') return;
    if (hotkeyProc) return;
    const bin = deps.getSpeechHelperPath();
    if (!bin) return;

    clearHotkeyRestartTimer();
    try {
      const proc = spawnHelper(bin, ['hotkey']);
      hotkeyProc = proc;
      hotkeyStdoutBuffer = '';

      proc.stdout?.on('data', (chunk: Buffer | string) => {
        if (hotkeyProc !== proc || disposed || !enabled) return;
        hotkeyStdoutBuffer += String(chunk);
        let idx = hotkeyStdoutBuffer.indexOf('\n');
        while (idx !== -1) {
          const line = hotkeyStdoutBuffer.slice(0, idx).trim();
          hotkeyStdoutBuffer = hotkeyStdoutBuffer.slice(idx + 1);
          idx = hotkeyStdoutBuffer.indexOf('\n');
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as { type?: string };
            if (parsed?.type === 'toggle') {
              if (isMainWindowFocused()) {
                continue;
              }
              void toggleDictation();
            }
          } catch {
            // Ignore malformed stdout line.
          }
        }
      });

      const scheduleRestart = () => {
        if (hotkeyProc === proc) {
          hotkeyProc = null;
        }
        if (disposed || !enabled || !started) return;
        if (hotkeyRestartTimer !== null) return;
        hotkeyRestartTimer = setTimeout(() => {
          hotkeyRestartTimer = null;
          spawnHotkeyMonitor();
        }, 1_500);
        if (typeof hotkeyRestartTimer.unref === 'function') {
          hotkeyRestartTimer.unref();
        }
      };

      proc.once('exit', scheduleRestart);
      proc.once('error', scheduleRestart);
    } catch {
      hotkeyProc = null;
    }
  };

  const stopHelpers = async (abortActiveDictation: boolean): Promise<void> => {
    clearHotkeyRestartTimer();
    activeSessionId += 1;
    if (abortActiveDictation && (phase === 'starting' || phase === 'listening' || phase === 'draining')) {
      cancelRequestedDuringStart = true;
      try {
        await deps.voice.stopListening({ abort: true });
      } catch {
        // Ignore stop errors during teardown.
      }
    }
    hideOverlay();
    resetActiveDictationState();

    const hk = hotkeyProc;
    hotkeyProc = null;
    terminateChild(hk);

    const ov = overlayProc;
    overlayProc = null;
    terminateChild(ov);
  };

  const start = (): void => {
    if (disposed || deps.platform !== 'darwin') return;
    started = true;
    if (enabled) {
      spawnHotkeyMonitor();
    }
  };

  const setEnabled = async (nextEnabled: boolean): Promise<boolean> => {
    if (disposed) return enabled;
    if (deps.platform !== 'darwin') {
      enabled = false;
      return false;
    }
    const normalized = Boolean(nextEnabled);
    enabled = normalized;
    store.save(normalized);
    if (normalized) {
      if (started) {
        spawnHotkeyMonitor();
      }
    } else {
      await stopHelpers(true);
    }
    deps.onStateChanged?.(enabled);
    return enabled;
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    started = false;
    await stopHelpers(true);
  };

  return {
    isEnabled: () => enabled,
    start,
    setEnabled,
    toggleDictation,
    dispose,
  };
}
