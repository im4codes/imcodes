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

export interface GlobalVoiceOverlayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CreateGlobalVoiceOverlayWindowOptions {
  width: number;
  height: number;
  x?: number;
  y?: number;
  frame: false;
  transparent: true;
  focusable: false;
  alwaysOnTop: true;
  skipTaskbar: true;
  resizable: false;
  movable: false;
  minimizable: false;
  maximizable: false;
  closable: false;
  hasShadow: false;
  show: false;
  webPreferences: {
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
  };
}

export interface GlobalVoiceOverlayWebContentsLike {
  isDestroyed?(): boolean;
  isLoading?(): boolean;
  once?(event: 'did-finish-load', listener: () => void): unknown;
  executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface GlobalVoiceOverlayWindowLike {
  isDestroyed?(): boolean;
  loadURL(url: string): Promise<void> | void;
  showInactive?(): void;
  hide?(): void;
  close?(): void;
  destroy?(): void;
  setAlwaysOnTop?(flag: boolean, level?: string): void;
  setIgnoreMouseEvents?(ignore: boolean, options?: { forward?: boolean }): void;
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void;
  webContents: GlobalVoiceOverlayWebContentsLike;
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
  createOverlayWindow?: (options: CreateGlobalVoiceOverlayWindowOptions) => GlobalVoiceOverlayWindowLike | null;
  getOverlayWorkArea?: () => GlobalVoiceOverlayWorkArea | null;
  spawnHelper?: (binPath: string, args: string[]) => ChildProcess;
  runPasteHelper?: (binPath: string, args: string[], stdinText: string) => Promise<string>;
  onStateChanged?: (enabled: boolean) => void;
  onError?: (code: string, message?: string) => void;
  onAccessibilityDenied?: (text: string) => void;
  onUipiDenied?: (text: string) => void;
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

function isAsarArchivePath(filePath: string): boolean {
  return filePath.includes('.asar/') || filePath.includes('.asar\\');
}

export function resolveGlobalVoiceOverlayIconPath(options?: {
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  moduleDir?: string;
}): string | null {
  const moduleDir = options?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const candidates: string[] = [];
  if (options?.resourcesPath) {
    if (options?.platform !== 'win32') {
      candidates.push(join(options.resourcesPath, 'icon.icns'));
    }
    candidates.push(join(options.resourcesPath, 'build', 'icon.png'));
    candidates.push(join(options.resourcesPath, 'icon.png'));
  }
  candidates.push(resolve(moduleDir, '../../build/icon.png'));
  candidates.push(resolve(moduleDir, '../build/icon.png'));
  return candidates.find((p) => !isAsarArchivePath(p) && existsSync(p)) ?? null;
}

const WIN_OVERLAY_WIDTH = 344;
const WIN_OVERLAY_HEIGHT = 68;
const WIN_OVERLAY_BAR_COUNT = 16;

function buildWinOverlayDataUri(iconPath: string | null): string {
  let iconSrc = '';
  if (iconPath && existsSync(iconPath)) {
    try {
      const ext = path.extname(iconPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.ico' ? 'image/x-icon' : '';
      if (mime) {
        iconSrc = `data:${mime};base64,${readFileSync(iconPath).toString('base64')}`;
      }
    } catch {
      iconSrc = '';
    }
  }
  const robotSvgFallback =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1e293b"/><circle cx="11" cy="15" r="2.5" fill="#22d3ee"/><circle cx="21" cy="15" r="2.5" fill="#22d3ee"/><rect x="10" y="21" width="12" height="2" rx="1" fill="#94a3b8"/></svg>',
    );
  const imgUrl = iconSrc || robotSvgFallback;
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden;
    pointer-events: none; user-select: none;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .pill {
    box-sizing: border-box;
    width: 100%; height: 100%;
    padding: 8px 14px;
    border-radius: 16px;
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.24);
    display: flex; align-items: center; gap: 10px;
  }
  .logo { width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0; object-fit: cover; }
  .dot { width: 8px; height: 8px; border-radius: 9999px; flex-shrink: 0; background: #f59e0b; }
  .dot.listening { background: #22d3ee; }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 12px; font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .text { font-size: 11px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bars { display: flex; align-items: center; gap: 2px; height: 26px; flex-shrink: 0; }
  .bar { width: 3px; height: 4px; border-radius: 9999px; background: linear-gradient(180deg, #34d399 0%, #22d3ee 100%); opacity: 0.6; transition: height 60ms ease-out; }
</style>
</head>
<body>
  <div class="pill">
    <img class="logo" src="${imgUrl}" alt="" />
    <span id="dot" class="dot"></span>
    <div class="meta">
      <div id="title" class="title"></div>
      <div id="text" class="text"></div>
    </div>
    <div id="bars" class="bars"></div>
  </div>
  <script>
    const BAR_COUNT = ${WIN_OVERLAY_BAR_COUNT};
    const barsEl = document.getElementById('bars');
    const history = new Array(BAR_COUNT).fill(0);
    for (let i = 0; i < BAR_COUNT; i++) {
      const b = document.createElement('span');
      b.className = 'bar';
      barsEl.appendChild(b);
    }
    let tick = 0;
    window.__imcodesWinVoiceOverlayUpdate = function(payload) {
      if (!payload || typeof payload !== 'object') return;
      const dot = document.getElementById('dot');
      const title = document.getElementById('title');
      const text = document.getElementById('text');
      dot.className = payload.state === 'listening' ? 'dot listening' : 'dot';
      title.textContent = typeof payload.title === 'string' ? payload.title : '';
      text.textContent = typeof payload.text === 'string' ? payload.text : '';
      const level = payload.state === 'listening' ? Math.max(0, Math.min(1, Number(payload.level) || 0)) : 0;
      history.shift();
      history.push(level);
      tick += 1;
      const nodes = barsEl.children;
      for (let i = 0; i < nodes.length; i++) {
        const sample = history[i] || 0;
        const env = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2) * 0.25;
        const jitter = sample > 0.01 ? (0.85 + 0.15 * Math.sin((tick + i) * 0.9)) : 1;
        const h = Math.round(4 + Math.min(1, sample * env * jitter) * 22);
        nodes[i].style.height = h + 'px';
        nodes[i].style.opacity = sample > 0.02 ? '1' : '0.45';
      }
    };
  </script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
 * Manage system-wide Double-Tap Shift hotkey detection (macOS NSEvent monitor / Windows WH_KEYBOARD_LL),
 * non-activating floating overlay (macOS NSPanel / Windows transparent BrowserWindow with IM.codes robot logo),
 * dictation lifecycle, and direct Unicode pasting into foreground applications.
 */
export function createPcAppGlobalVoice(deps: PcAppGlobalVoiceDeps): PcAppGlobalVoiceController {
  const isSupportedPlatform = deps.platform === 'darwin' || deps.platform === 'win32';
  const store = new PcAppGlobalVoiceStore(deps.userDataDir);
  const stored = store.load();
  let enabled = isSupportedPlatform ? (stored ?? true) : false;
  let disposed = false;
  let started = false;

  let hotkeyProc: ChildProcess | null = null;
  let hotkeyStdoutBuffer = '';
  let hotkeyRestartTimer: ReturnType<typeof setTimeout> | null = null;

  let overlayProc: ChildProcess | null = null;
  let winOverlayWin: GlobalVoiceOverlayWindowLike | null = null;
  let pendingWinOverlayState: Record<string, unknown> | null = null;

  let phase: DictationPhase = 'idle';
  let cancelRequestedDuringStart = false;
  let stopRequestedDuringStart = false;
  let pendingEnterOnPaste = false;
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
    if (deps.iconPath !== undefined) {
      if (deps.iconPath === null) return null;
      return isAsarArchivePath(deps.iconPath)
        ? resolveGlobalVoiceOverlayIconPath({ platform: deps.platform, resourcesPath: deps.resourcesPath })
        : deps.iconPath;
    }
    return resolveGlobalVoiceOverlayIconPath({ platform: deps.platform, resourcesPath: deps.resourcesPath });
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

  const computeWinOverlayBounds = () => {
    const workArea = deps.getOverlayWorkArea?.();
    if (!workArea) {
      return { width: WIN_OVERLAY_WIDTH, height: WIN_OVERLAY_HEIGHT };
    }
    const x = Math.round(workArea.x + (workArea.width - WIN_OVERLAY_WIDTH) / 2);
    const y = Math.round(workArea.y + workArea.height - WIN_OVERLAY_HEIGHT - 28);
    return { x, y, width: WIN_OVERLAY_WIDTH, height: WIN_OVERLAY_HEIGHT };
  };

  const pushWinOverlayPayload = (win: GlobalVoiceOverlayWindowLike, payload: Record<string, unknown>): void => {
    pendingWinOverlayState = payload;
    if (win.isDestroyed?.()) return;
    if (win.webContents.isLoading?.()) return;
    const script = `window.__imcodesWinVoiceOverlayUpdate && window.__imcodesWinVoiceOverlayUpdate(${JSON.stringify(payload)});`;
    void win.webContents.executeJavaScript?.(script, true)?.catch(() => {});
  };

  const ensureWinOverlayWindow = (): GlobalVoiceOverlayWindowLike | null => {
    if (disposed || !enabled || deps.platform !== 'win32') return null;
    if (!deps.createOverlayWindow) return null;
    if (winOverlayWin && !winOverlayWin.isDestroyed?.()) return winOverlayWin;

    const bounds = computeWinOverlayBounds();
    const win = deps.createOverlayWindow({
      ...bounds,
      frame: false,
      transparent: true,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    if (!win) return null;
    winOverlayWin = win;
    win.setAlwaysOnTop?.(true, 'screen-saver');
    win.setIgnoreMouseEvents?.(true, { forward: true });
    win.webContents.once?.('did-finish-load', () => {
      if (pendingWinOverlayState && winOverlayWin === win && !win.isDestroyed?.()) {
        pushWinOverlayPayload(win, pendingWinOverlayState);
      }
    });
    const iconPath = resolveIconPath();
    void Promise.resolve(win.loadURL(buildWinOverlayDataUri(iconPath))).catch(() => {});
    return win;
  };

  const destroyWinOverlayWindow = (): void => {
    const win = winOverlayWin;
    winOverlayWin = null;
    pendingWinOverlayState = null;
    if (!win || win.isDestroyed?.()) return;
    try {
      win.hide?.();
      if (win.destroy) {
        win.destroy();
      } else {
        win.close?.();
      }
    } catch {
      // Ignore already-destroyed overlay window.
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
    if (deps.platform === 'win32') {
      if (payload.cmd === 'hide') {
        pendingWinOverlayState = null;
        if (winOverlayWin && !winOverlayWin.isDestroyed?.()) {
          winOverlayWin.hide?.();
        }
        return;
      }
      const win = ensureWinOverlayWindow();
      if (!win) return;
      const bounds = computeWinOverlayBounds();
      if (bounds.x !== undefined && bounds.y !== undefined) {
        win.setBounds?.({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
      }
      win.setAlwaysOnTop?.(true, 'screen-saver');
      win.setIgnoreMouseEvents?.(true, { forward: true });
      win.showInactive?.();
      pushWinOverlayPayload(win, payload);
      return;
    }

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

  const pasteRecognizedText = async (text: string, sendEnter = false): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const bin = deps.getSpeechHelperPath();
    if (!bin) return;
    const runPaste = deps.runPasteHelper ?? defaultRunPasteHelper;
    try {
      const pasteArgs = sendEnter ? ['paste', '--stdin', '--enter'] : ['paste', '--stdin'];
      const stdout = await runPaste(bin, pasteArgs, trimmed);
      const line = stdout.trim().split('\n').pop() ?? '';
      if (line) {
        try {
          const parsed = JSON.parse(line) as { type?: string; code?: string; message?: string };
          if (parsed.type === 'error' && parsed.code) {
            if (parsed.code === 'accessibility_denied') {
              deps.onAccessibilityDenied?.(trimmed);
            } else if (parsed.code === 'uipi_elevated_target') {
              if (deps.onUipiDenied) {
                deps.onUipiDenied(trimmed);
              } else {
                deps.onAccessibilityDenied?.(trimmed);
              }
            }
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
    pendingEnterOnPaste = false;
    latestText = '';
    finalText = null;
    latestLevel = 0;
    lastLevelSentAt = 0;
  };

  const finishAndPasteCurrent = async (sessionId: number): Promise<void> => {
    if (phase !== 'listening' && phase !== 'starting') return;
    const shouldSendEnter = pendingEnterOnPaste;
    phase = 'draining';
    showOverlay('draining', latestText, 0);
    await deps.voice.stopListening();
    if (sessionId !== activeSessionId) return;
    hideOverlay();

    const textToPaste = (finalText ?? latestText).trim();
    if (textToPaste && !disposed && enabled) {
      phase = 'pasting';
      await pasteRecognizedText(textToPaste, shouldSendEnter);
    }
    if (sessionId === activeSessionId) {
      resetActiveDictationState();
    }
  };

  const startGlobalDictation = async (): Promise<void> => {
    if (disposed || !enabled || !isSupportedPlatform) return;
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
    if (disposed || !enabled || !isSupportedPlatform) return;
    if (phase === 'idle') {
      pendingEnterOnPaste = false;
      await startGlobalDictation();
      return;
    }
    if (phase === 'starting') {
      pendingEnterOnPaste = false;
      stopRequestedDuringStart = true;
      return;
    }
    if (phase === 'listening') {
      pendingEnterOnPaste = false;
      await finishAndPasteCurrent(activeSessionId);
    }
  };

  const handleHotkeyEvent = async (eventType: string): Promise<void> => {
    if (disposed || !enabled || !isSupportedPlatform) return;
    if (isMainWindowFocused()) return;

    if (eventType === 'double_tap') {
      if (phase === 'idle') {
        pendingEnterOnPaste = false;
        await startGlobalDictation();
        return;
      }
      if (phase === 'starting') {
        pendingEnterOnPaste = true;
        stopRequestedDuringStart = true;
        return;
      }
      if (phase === 'listening') {
        pendingEnterOnPaste = true;
        await finishAndPasteCurrent(activeSessionId);
      }
      return;
    }

    if (eventType === 'single_tap') {
      if (phase === 'idle') return;
      if (phase === 'starting') {
        pendingEnterOnPaste = false;
        stopRequestedDuringStart = true;
        return;
      }
      if (phase === 'listening') {
        pendingEnterOnPaste = false;
        await finishAndPasteCurrent(activeSessionId);
      }
      return;
    }

    // Legacy fallback alias
    if (eventType === 'toggle') {
      await toggleDictation();
    }
  };

  const spawnHotkeyMonitor = (): void => {
    if (disposed || !enabled || !started || !isSupportedPlatform) return;
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
            if (
              parsed?.type === 'double_tap' ||
              parsed?.type === 'single_tap' ||
              parsed?.type === 'toggle'
            ) {
              void handleHotkeyEvent(parsed.type);
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
    destroyWinOverlayWindow();
  };

  const start = (): void => {
    if (disposed || !isSupportedPlatform) return;
    started = true;
    if (enabled) {
      spawnHotkeyMonitor();
    }
  };

  const setEnabled = async (nextEnabled: boolean): Promise<boolean> => {
    if (disposed) return enabled;
    if (!isSupportedPlatform) {
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
