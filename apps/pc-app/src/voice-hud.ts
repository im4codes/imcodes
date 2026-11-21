import { normalizePcAppLocale, tPcApp, type PcAppLocale } from './i18n.js';
import type { PcAppVoiceEvent } from './voice-ipc.js';

export const VOICE_HUD_ROOT_ID = 'imcodes-voice-hud-root';
export const VOICE_HUD_STYLE_ID = 'imcodes-voice-hud-style';
export const VOICE_HUD_BAR_COUNT = 16;
export const VOICE_HUD_LEVEL_MIN_INTERVAL_MS = 66;
export const VOICE_HUD_BAR_WIDTH_PX = 3;
export const VOICE_HUD_BAR_MIN_HEIGHT_PX = 5;
export const VOICE_HUD_BAR_MAX_HEIGHT_PX = 32;

export interface VoiceHudWebContentsLike {
  isDestroyed?(): boolean;
  isLoading?(): boolean;
  on?(event: 'did-finish-load', listener: () => void): unknown;
  off?(event: 'did-finish-load', listener: () => void): unknown;
  removeListener?(event: 'did-finish-load', listener: () => void): unknown;
  executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface CreatePcAppVoiceHudDeps {
  getWebContents?: () => VoiceHudWebContentsLike | null | undefined;
  getLocale?: () => string;
  now?: () => number;
}

export interface PcAppVoiceHudController {
  handleEvent(event: PcAppVoiceEvent): void;
  setLocale(locale: string): void;
  dispose(): void;
}

type VoiceHudMode = 'hidden' | 'loading' | 'listening';

export interface VoiceHudRenderState {
  mode: VoiceHudMode;
  text: string;
  level: number;
}

function clampLevel(raw: unknown): number {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return 0;
  if (num >= 1) return 1;
  return num;
}

/**
 * Build an idempotent script that ensures the transparent, click-through
 * in-page voice HUD overlay exists in `document.body` and renders `state`.
 */
export function buildVoiceHudSyncScript(state: VoiceHudRenderState): string {
  return `(function (state) {
  if (!state || typeof state !== 'object' || typeof document === 'undefined') return;
  var ROOT_ID = ${JSON.stringify(VOICE_HUD_ROOT_ID)};
  var STYLE_ID = ${JSON.stringify(VOICE_HUD_STYLE_ID)};
  var BAR_COUNT = ${VOICE_HUD_BAR_COUNT};
  var MIN_BAR_H = ${VOICE_HUD_BAR_MIN_HEIGHT_PX};
  var MAX_BAR_H = ${VOICE_HUD_BAR_MAX_HEIGHT_PX};

  var existingRoot = document.getElementById(ROOT_ID);
  if (!existingRoot && state.mode === 'hidden') return;
  if (!document.body) return;

  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '@keyframes imcodesVoiceHudPulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(0.75); opacity: 0.55; } }',
      '#' + ROOT_ID + ' { position: fixed; bottom: 76px; left: 50%; transform: translateX(-50%); z-index: 2147483645; pointer-events: none; user-select: none; background: transparent; display: flex; align-items: center; gap: 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; filter: drop-shadow(0 2px 10px rgba(2, 6, 23, 0.72)); }',
      '#' + ROOT_ID + ' * { pointer-events: none; user-select: none; }',
      '#imcodes-voice-hud-dot { width: 9px; height: 9px; border-radius: 9999px; flex-shrink: 0; background: #f59e0b; box-shadow: 0 0 10px rgba(245, 158, 11, 0.85); animation: imcodesVoiceHudPulse 1.2s ease-in-out infinite; }',
      '#imcodes-voice-hud-dot.listening { background: #22d3ee; box-shadow: 0 0 12px rgba(34, 211, 238, 0.9), 0 0 4px rgba(52, 211, 153, 0.85); animation: none; }',
      '#imcodes-voice-hud-label { font-size: 13px; font-weight: 600; line-height: 1; letter-spacing: 0.01em; color: #f8fafc; white-space: nowrap; text-shadow: 0 1px 6px rgba(2, 6, 23, 0.92), 0 0 2px rgba(2, 6, 23, 0.95); background: transparent; }',
      '#imcodes-voice-hud-bars { display: none; align-items: center; gap: 3px; height: ' + MAX_BAR_H + 'px; flex-shrink: 0; background: transparent; }',
      '#imcodes-voice-hud-bars.active { display: flex; }',
      '.imcodes-voice-hud-bar { width: ${VOICE_HUD_BAR_WIDTH_PX}px; height: ' + MIN_BAR_H + 'px; min-height: ' + MIN_BAR_H + 'px; max-height: ' + MAX_BAR_H + 'px; border-radius: 9999px; background: linear-gradient(180deg, #34d399 0%, #22d3ee 100%); box-shadow: 0 0 8px rgba(34, 211, 238, 0.65); opacity: 0.55; transition: height 65ms ease-out, opacity 80ms ease-out; }'
    ].join('\\n');
    (document.head || document.body).appendChild(style);
  }

  var root = existingRoot;
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('aria-hidden', 'true');
    root.style.position = 'fixed';
    root.style.bottom = '76px';
    root.style.left = '50%';
    root.style.transform = 'translateX(-50%)';
    root.style.zIndex = '2147483645';
    root.style.pointerEvents = 'none';
    root.style.userSelect = 'none';
    root.style.background = 'transparent';

    var dot = document.createElement('span');
    dot.id = 'imcodes-voice-hud-dot';
    var label = document.createElement('span');
    label.id = 'imcodes-voice-hud-label';
    var bars = document.createElement('div');
    bars.id = 'imcodes-voice-hud-bars';

    for (var i = 0; i < BAR_COUNT; i += 1) {
      var bar = document.createElement('span');
      bar.className = 'imcodes-voice-hud-bar';
      bars.appendChild(bar);
    }

    root.appendChild(dot);
    root.appendChild(label);
    root.appendChild(bars);
    document.body.appendChild(root);
  }

  if (typeof window.__imcodesVoiceHudUpdate !== 'function') {
    var history = [];
    for (var h = 0; h < BAR_COUNT; h += 1) history.push(0);
    var tick = 0;

    window.__imcodesVoiceHudUpdate = function (next) {
      var rootEl = document.getElementById(ROOT_ID);
      if (!rootEl || !next || typeof next !== 'object') return;
      var dotEl = document.getElementById('imcodes-voice-hud-dot');
      var labelEl = document.getElementById('imcodes-voice-hud-label');
      var barsEl = document.getElementById('imcodes-voice-hud-bars');
      var mode = next.mode || 'hidden';
      rootEl.setAttribute('data-mode', mode);
      if (labelEl && typeof next.text === 'string') {
        labelEl.textContent = next.text;
      }

      var barNodes = barsEl ? barsEl.children : [];
      if (mode === 'hidden') {
        rootEl.style.display = 'none';
        if (dotEl) dotEl.className = '';
        if (barsEl) barsEl.className = '';
        for (var r = 0; r < barNodes.length; r += 1) {
          history[r] = 0;
          barNodes[r].style.height = MIN_BAR_H + 'px';
          barNodes[r].style.opacity = '0.55';
        }
        return;
      }

      rootEl.style.display = 'flex';
      if (mode === 'loading') {
        if (dotEl) dotEl.className = '';
        if (barsEl) barsEl.className = '';
        for (var l = 0; l < barNodes.length; l += 1) {
          history[l] = 0;
          barNodes[l].style.height = MIN_BAR_H + 'px';
          barNodes[l].style.opacity = '0.55';
        }
        return;
      }

      if (dotEl) dotEl.className = 'listening';
      if (barsEl) barsEl.className = 'active';
      tick += 1;
      var clamped = Math.max(0, Math.min(1, Number(next.level) || 0));
      history.shift();
      history.push(clamped);
      for (var i = 0; i < barNodes.length; i += 1) {
        var sample = history[i] || 0;
        var centerDist = Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
        var envelope = 1 - centerDist * 0.25;
        var jitter = sample > 0.01 ? (0.85 + 0.15 * Math.sin((tick + i) * 0.9)) : 1;
        var px = Math.round(MIN_BAR_H + Math.min(1, sample * envelope * jitter) * (MAX_BAR_H - MIN_BAR_H));
        barNodes[i].style.height = px + 'px';
        barNodes[i].style.opacity = sample > 0.02 ? '1' : '0.55';
      }
    };
  }

  window.__imcodesVoiceHudUpdate(state);
})(${JSON.stringify(state)});`;
}

/**
 * Create an in-page transparent, click-through (`pointer-events: none`) voice HUD
 * controller rendered inside the main window's DOM without spawning any OS window.
 */
export function createPcAppVoiceHud(deps: CreatePcAppVoiceHudDeps = {}): PcAppVoiceHudController {
  let explicitLocale: PcAppLocale | null = null;
  let disposed = false;
  let mode: VoiceHudMode = 'hidden';
  let latestLevel = 0;
  let lastLevelPushAt = 0;
  let attachedWebContents: VoiceHudWebContentsLike | null = null;

  const currentNow = (): number => (deps.now ? deps.now() : Date.now());

  const resolveLocale = (): PcAppLocale => {
    if (explicitLocale) return explicitLocale;
    try {
      return normalizePcAppLocale(deps.getLocale?.());
    } catch {
      return 'en';
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

  const detachDidFinishLoad = (wc: VoiceHudWebContentsLike | null): void => {
    if (!wc) return;
    try {
      if (wc.off) {
        wc.off('did-finish-load', onDidFinishLoad);
      } else {
        wc.removeListener?.('did-finish-load', onDidFinishLoad);
      }
    } catch {
      // Ignore cleanup failures on destroyed webContents.
    }
  };

  const resolveWebContents = (): VoiceHudWebContentsLike | null => {
    if (disposed) return null;
    let wc: VoiceHudWebContentsLike | null | undefined;
    try {
      wc = deps.getWebContents?.();
    } catch {
      return null;
    }
    if (!wc || wc.isDestroyed?.()) {
      if (attachedWebContents === wc) {
        attachedWebContents = null;
      }
      return null;
    }
    if (attachedWebContents !== wc) {
      detachDidFinishLoad(attachedWebContents);
      attachedWebContents = wc;
      try {
        wc.on?.('did-finish-load', onDidFinishLoad);
      } catch {
        // Ignore listener registration errors.
      }
    }
    return wc;
  };

  const pushStateToPage = (state: VoiceHudRenderState): void => {
    const wc = resolveWebContents();
    if (!wc) return;
    if (wc.isLoading?.()) return;
    const code = buildVoiceHudSyncScript(state);
    try {
      const maybePromise = wc.executeJavaScript?.(code, false);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        void maybePromise.catch(() => {});
      }
    } catch {
      // Never let HUD script injection errors propagate to voice IPC.
    }
  };

  function onDidFinishLoad(): void {
    if (disposed || mode === 'hidden') return;
    pushStateToPage(buildCurrentState());
  }

  const showMode = (nextMode: 'loading' | 'listening'): void => {
    if (disposed) return;
    mode = nextMode;
    if (nextMode === 'loading') {
      latestLevel = 0;
      lastLevelPushAt = 0;
    }
    pushStateToPage(buildCurrentState());
  };

  const hideHud = (): void => {
    if (mode === 'hidden') return;
    mode = 'hidden';
    latestLevel = 0;
    lastLevelPushAt = 0;
    pushStateToPage(buildCurrentState());
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
        pushStateToPage(buildCurrentState());
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
      pushStateToPage(buildCurrentState());
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    const wasVisible = mode !== 'hidden';
    mode = 'hidden';
    latestLevel = 0;
    lastLevelPushAt = 0;
    if (wasVisible) {
      pushStateToPage(buildCurrentState());
    }
    disposed = true;
    detachDidFinishLoad(attachedWebContents);
    attachedWebContents = null;
  };

  return {
    handleEvent,
    setLocale,
    dispose,
  };
}
