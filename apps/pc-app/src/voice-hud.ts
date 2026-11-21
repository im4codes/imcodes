import { normalizePcAppLocale, tPcApp, type PcAppLocale } from './i18n.js';
import { MAIN_WINDOW_WEB_PREFERENCES } from './security.js';
import type { PcAppVoiceEvent } from './voice-ipc.js';

export const VOICE_HUD_WIDTH = 260;
export const VOICE_HUD_HEIGHT = 56;
export const VOICE_HUD_BOTTOM_MARGIN = 28;
export const VOICE_HUD_BAR_COUNT = 16;
export const VOICE_HUD_LEVEL_MIN_INTERVAL_MS = 66;

export interface VoiceHudDisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VoiceHudWindowLike {
  loadURL(url: string): Promise<void> | void;
  showInactive?(): void;
  show?(): void;
  hide?(): void;
  close(): void;
  destroy?(): void;
  isDestroyed(): boolean;
  setIgnoreMouseEvents?(ignore: boolean, options?: { forward?: boolean }): void;
  setAlwaysOnTop?(flag: boolean, level?: string): void;
  setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setBounds?(bounds: { x: number; y: number; width: number; height: number }): void;
  on?(event: string, listener: () => void): unknown;
  webContents: {
    isLoading?(): boolean;
    once?(event: string, listener: () => void): unknown;
    setWindowOpenHandler?(handler: (details: { url: string }) => { action: 'deny' }): void;
    executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
  };
}

export interface VoiceHudBrowserWindowOptions {
  width: number;
  height: number;
  x: number;
  y: number;
  frame: false;
  transparent: true;
  backgroundColor: string;
  alwaysOnTop: true;
  resizable: false;
  movable: false;
  minimizable: false;
  maximizable: false;
  closable: false;
  skipTaskbar: true;
  focusable: false;
  show: false;
  hasShadow: false;
  webPreferences: typeof MAIN_WINDOW_WEB_PREFERENCES & { partition: string };
}

export interface CreatePcAppVoiceHudDeps {
  createWindow?: (options: VoiceHudBrowserWindowOptions) => VoiceHudWindowLike;
  getDisplayWorkArea?: () => VoiceHudDisplayWorkArea;
  getLocale?: () => string;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface PcAppVoiceHudController {
  handleEvent(event: PcAppVoiceEvent): void;
  setLocale(locale: string): void;
  dispose(): void;
}

type VoiceHudMode = 'hidden' | 'loading' | 'listening';

interface VoiceHudRenderState {
  mode: VoiceHudMode;
  text: string;
  level: number;
}

const DEFAULT_WORK_AREA: VoiceHudDisplayWorkArea = {
  x: 0,
  y: 0,
  width: 1440,
  height: 900,
};

function clampLevel(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

function computeHudBounds(workArea?: VoiceHudDisplayWorkArea): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const area =
    workArea &&
    Number.isFinite(workArea.x) &&
    Number.isFinite(workArea.y) &&
    Number.isFinite(workArea.width) &&
    Number.isFinite(workArea.height) &&
    workArea.width > 0 &&
    workArea.height > 0
      ? workArea
      : DEFAULT_WORK_AREA;

  return {
    x: Math.round(area.x + (area.width - VOICE_HUD_WIDTH) / 2),
    y: Math.round(area.y + area.height - VOICE_HUD_HEIGHT - VOICE_HUD_BOTTOM_MARGIN),
    width: VOICE_HUD_WIDTH,
    height: VOICE_HUD_HEIGHT,
  };
}

/**
 * Build the self-contained transparent pill HTML loaded into the floating voice HUD window.
 */
export function buildVoiceHudDataUrl(initialLocale: PcAppLocale = 'en'): string {
  const initialLoadingText = tPcApp(initialLocale, 'voiceHud.loading');
  const html = `<!doctype html>
<html lang="${initialLocale}">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: transparent;
    overflow: hidden;
    user-select: none;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  @keyframes imcodesHudPulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(0.76); opacity: 0.55; }
  }
  #imcodes-voice-hud-pill {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    height: 38px;
    max-width: ${VOICE_HUD_WIDTH - 16}px;
    padding: 0 14px;
    border-radius: 9999px;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid rgba(148, 163, 184, 0.28);
    box-shadow: 0 8px 24px rgba(2, 6, 23, 0.45);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    color: #f8fafc;
  }
  #imcodes-voice-hud-dot {
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    flex-shrink: 0;
    background: #f59e0b;
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.75);
    animation: imcodesHudPulse 1.2s ease-in-out infinite;
  }
  #imcodes-voice-hud-dot.listening {
    background: #22d3ee;
    box-shadow: 0 0 8px rgba(34, 211, 238, 0.8);
    animation: none;
  }
  #imcodes-voice-hud-label {
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.01em;
    color: #f8fafc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #imcodes-voice-hud-bars {
    display: none;
    align-items: center;
    gap: 2.5px;
    height: 22px;
    flex-shrink: 0;
  }
  #imcodes-voice-hud-bars.active {
    display: flex;
  }
  .imcodes-hud-bar {
    width: 2.5px;
    height: 4px;
    min-height: 4px;
    max-height: 20px;
    border-radius: 2px;
    background: linear-gradient(180deg, #34d399 0%, #22d3ee 100%);
    opacity: 0.45;
    transition: height 65ms ease-out, opacity 80ms ease-out;
  }
</style>
</head>
<body>
  <div id="imcodes-voice-hud-pill" data-mode="loading">
    <span id="imcodes-voice-hud-dot"></span>
    <span id="imcodes-voice-hud-label">${initialLoadingText.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</span>
    <div id="imcodes-voice-hud-bars" aria-hidden="true"></div>
  </div>
  <script>
    (function () {
      var BAR_COUNT = ${VOICE_HUD_BAR_COUNT};
      var pillEl = document.getElementById('imcodes-voice-hud-pill');
      var dotEl = document.getElementById('imcodes-voice-hud-dot');
      var labelEl = document.getElementById('imcodes-voice-hud-label');
      var barsEl = document.getElementById('imcodes-voice-hud-bars');
      var bars = [];
      var history = [];
      var tick = 0;

      for (var i = 0; i < BAR_COUNT; i += 1) {
        var bar = document.createElement('span');
        bar.className = 'imcodes-hud-bar';
        barsEl.appendChild(bar);
        bars.push(bar);
        history.push(0);
      }

      function resetBars() {
        for (var i = 0; i < BAR_COUNT; i += 1) {
          history[i] = 0;
          bars[i].style.height = '4px';
          bars[i].style.opacity = '0.45';
        }
      }

      function renderLevel(level) {
        tick += 1;
        var clamped = Math.max(0, Math.min(1, Number(level) || 0));
        history.shift();
        history.push(clamped);
        for (var i = 0; i < BAR_COUNT; i += 1) {
          var sample = history[i];
          var centerDist = Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
          var envelope = 1 - centerDist * 0.25;
          var jitter = sample > 0.01 ? (0.85 + 0.15 * Math.sin((tick + i) * 0.9)) : 1;
          var px = Math.round(4 + Math.min(1, sample * envelope * jitter) * 16);
          bars[i].style.height = px + 'px';
          bars[i].style.opacity = sample > 0.02 ? '1' : '0.45';
        }
      }

      window.__imcodesVoiceHudUpdate = function (state) {
        if (!state || typeof state !== 'object') return;
        var mode = state.mode || 'hidden';
        pillEl.setAttribute('data-mode', mode);
        if (typeof state.text === 'string') {
          labelEl.textContent = state.text;
        }
        if (mode === 'loading') {
          dotEl.className = '';
          barsEl.className = '';
          resetBars();
          return;
        }
        if (mode === 'listening') {
          dotEl.className = 'listening';
          barsEl.className = 'active';
          renderLevel(state.level || 0);
          return;
        }
        dotEl.className = '';
        barsEl.className = '';
        resetBars();
      };
    })();
  </script>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Create a global transparent, non-focusable, click-through floating voice HUD controller.
 * Fails safely when Electron's `BrowserWindow` factory is omitted or unavailable.
 */
export function createPcAppVoiceHud(deps: CreatePcAppVoiceHudDeps = {}): PcAppVoiceHudController {
  let explicitLocale: PcAppLocale | null = null;
  let win: VoiceHudWindowLike | null = null;
  let pageReady = false;
  let disposed = false;
  let mode: VoiceHudMode = 'hidden';
  let latestLevel = 0;
  let lastLevelPushAt = 0;

  const currentNow = (): number => (deps.now ? deps.now() : Date.now());

  const resolveLocale = (): PcAppLocale => {
    if (explicitLocale) return explicitLocale;
    try {
      return normalizePcAppLocale(deps.getLocale?.());
    } catch {
      return 'en';
    }
  };

  const resolveWorkArea = (): VoiceHudDisplayWorkArea | undefined => {
    try {
      return deps.getDisplayWorkArea?.();
    } catch {
      return undefined;
    }
  };

  const labelForMode = (targetMode: VoiceHudMode): string => {
    const locale = resolveLocale();
    if (targetMode === 'loading') return tPcApp(locale, 'voiceHud.loading');
    if (targetMode === 'listening') return tPcApp(locale, 'voiceHud.listening');
    return '';
  };

  const buildCurrentState = (): VoiceHudRenderState => ({
    mode,
    text: labelForMode(mode),
    level: mode === 'listening' ? latestLevel : 0,
  });

  const pushStateToWindow = (state: VoiceHudRenderState): void => {
    if (!win || win.isDestroyed() || !pageReady) return;
    const code = `window.__imcodesVoiceHudUpdate && window.__imcodesVoiceHudUpdate(${JSON.stringify(state)})`;
    try {
      const maybePromise = win.webContents.executeJavaScript?.(code, false);
      if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
        void (maybePromise as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Never let HUD script injection errors propagate to voice IPC.
    }
  };

  const ensureHudWindow = (): VoiceHudWindowLike | null => {
    if (disposed || !deps.createWindow) return null;
    if (win && !win.isDestroyed()) return win;

    try {
      const bounds = computeHudBounds(resolveWorkArea());
      const created = deps.createWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        skipTaskbar: true,
        focusable: false,
        show: false,
        hasShadow: false,
        webPreferences: {
          ...MAIN_WINDOW_WEB_PREFERENCES,
          partition: 'pc-app-voice-hud-ephemeral',
        },
      });
      if (!created || created.isDestroyed()) return null;

      win = created;
      pageReady = false;
      created.setIgnoreMouseEvents?.(true, { forward: true });
      created.setAlwaysOnTop?.(true, 'floating');
      created.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
      created.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
      created.on?.('closed', () => {
        if (win === created) {
          win = null;
          pageReady = false;
        }
      });
      created.webContents.once?.('did-finish-load', () => {
        if (win !== created || created.isDestroyed() || disposed) return;
        pageReady = true;
        pushStateToWindow(buildCurrentState());
      });

      void Promise.resolve(created.loadURL(buildVoiceHudDataUrl(resolveLocale()))).catch(() => {});
      if (!created.webContents.isLoading?.()) {
        pageReady = true;
      }
      return created;
    } catch {
      win = null;
      pageReady = false;
      return null;
    }
  };

  const showMode = (nextMode: 'loading' | 'listening'): void => {
    if (disposed) return;
    const wasHidden = mode === 'hidden';
    mode = nextMode;
    if (nextMode === 'loading') {
      latestLevel = 0;
      lastLevelPushAt = 0;
    }

    const hudWin = ensureHudWindow();
    if (!hudWin) return;

    if (wasHidden) {
      try {
        hudWin.setBounds?.(computeHudBounds(resolveWorkArea()));
      } catch {
        // Keep existing bounds if display lookup fails.
      }
      hudWin.setIgnoreMouseEvents?.(true, { forward: true });
    }

    pushStateToWindow(buildCurrentState());
    if (wasHidden) {
      hudWin.showInactive?.();
    }
  };

  const hideHud = (): void => {
    if (mode === 'hidden' && (!win || win.isDestroyed())) return;
    mode = 'hidden';
    latestLevel = 0;
    lastLevelPushAt = 0;
    if (!win || win.isDestroyed()) return;
    pushStateToWindow(buildCurrentState());
    win.hide?.();
  };

  const handleEvent = (event: PcAppVoiceEvent): void => {
    if (disposed || !event || typeof event !== 'object') return;
    switch (event.type) {
      case 'loading':
        showMode('loading');
        return;
      case 'start':
        latestLevel = 0;
        lastLevelPushAt = 0;
        showMode('listening');
        return;
      case 'level': {
        if (mode !== 'listening') return;
        latestLevel = clampLevel(event.value);
        const now = currentNow();
        if (lastLevelPushAt > 0 && now - lastLevelPushAt < VOICE_HUD_LEVEL_MIN_INTERVAL_MS) {
          return;
        }
        lastLevelPushAt = now;
        pushStateToWindow(buildCurrentState());
        return;
      }
      case 'error':
      case 'end':
        hideHud();
        return;
      case 'result':
        return;
    }
  };

  const setLocale = (locale: string): void => {
    explicitLocale = normalizePcAppLocale(locale);
    if (!disposed && mode !== 'hidden') {
      pushStateToWindow(buildCurrentState());
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    mode = 'hidden';
    latestLevel = 0;
    lastLevelPushAt = 0;
    const target = win;
    win = null;
    pageReady = false;
    if (!target || target.isDestroyed()) return;
    try {
      target.hide?.();
    } catch {
      // Ignore hide failure during teardown.
    }
    try {
      if (target.destroy) {
        target.destroy();
      } else {
        target.close();
      }
    } catch {
      // Ignore close failure during teardown.
    }
  };

  return {
    handleEvent,
    setLocale,
    dispose,
  };
}
