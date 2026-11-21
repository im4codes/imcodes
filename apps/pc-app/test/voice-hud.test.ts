import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVoiceHudDataUrl,
  createPcAppVoiceHud,
  VOICE_HUD_BAR_COUNT,
  VOICE_HUD_BOTTOM_MARGIN,
  VOICE_HUD_HEIGHT,
  VOICE_HUD_LEVEL_MIN_INTERVAL_MS,
  VOICE_HUD_WIDTH,
  type VoiceHudBrowserWindowOptions,
  type VoiceHudWindowLike,
} from '../src/voice-hud.js';
import { createPcAppVoiceController, type PcAppVoiceEvent } from '../src/voice-ipc.js';

function createMockHudWindow(opts?: { loadingInitially?: boolean }) {
  const winEmitter = new EventEmitter();
  const wcEmitter = new EventEmitter();
  let destroyed = false;
  let isLoading = opts?.loadingInitially ?? false;
  let loadedUrl = '';
  let windowOpenHandler: ((details: { url: string }) => { action: 'deny' }) | null = null;
  const executedScripts: string[] = [];

  const win: VoiceHudWindowLike & {
    showCalls: number;
    showInactiveCalls: number;
    hideCalls: number;
    closeCalls: number;
    destroyCalls: number;
    boundsHistory: Array<{ x: number; y: number; width: number; height: number }>;
    ignoreMouseCalls: Array<{ ignore: boolean; options?: { forward?: boolean } }>;
    alwaysOnTopCalls: Array<{ flag: boolean; level?: string }>;
    workspacesCalls: Array<{ visible: boolean; options?: { visibleOnFullScreen?: boolean } }>;
    getLoadedUrl: () => string;
    getExecutedScripts: () => string[];
    finishLoad: () => void;
    invokeWindowOpen: (url: string) => { action: 'deny' } | undefined;
  } = {
    showCalls: 0,
    showInactiveCalls: 0,
    hideCalls: 0,
    closeCalls: 0,
    destroyCalls: 0,
    boundsHistory: [],
    ignoreMouseCalls: [],
    alwaysOnTopCalls: [],
    workspacesCalls: [],
    getLoadedUrl: () => loadedUrl,
    getExecutedScripts: () => executedScripts,
    finishLoad: () => {
      isLoading = false;
      wcEmitter.emit('did-finish-load');
    },
    invokeWindowOpen: (url: string) => windowOpenHandler?.({ url }),
    loadURL: vi.fn((url: string) => {
      loadedUrl = url;
    }),
    show: vi.fn(() => {
      win.showCalls += 1;
    }),
    showInactive: vi.fn(() => {
      win.showInactiveCalls += 1;
    }),
    hide: vi.fn(() => {
      win.hideCalls += 1;
    }),
    close: vi.fn(() => {
      win.closeCalls += 1;
      destroyed = true;
      winEmitter.emit('closed');
    }),
    destroy: vi.fn(() => {
      win.destroyCalls += 1;
      destroyed = true;
      winEmitter.emit('closed');
    }),
    isDestroyed: () => destroyed,
    setIgnoreMouseEvents: vi.fn((ignore: boolean, options?: { forward?: boolean }) => {
      win.ignoreMouseCalls.push({ ignore, options });
    }),
    setAlwaysOnTop: vi.fn((flag: boolean, level?: string) => {
      win.alwaysOnTopCalls.push({ flag, level });
    }),
    setVisibleOnAllWorkspaces: vi.fn((visible: boolean, options?: { visibleOnFullScreen?: boolean }) => {
      win.workspacesCalls.push({ visible, options });
    }),
    setBounds: vi.fn((bounds) => {
      win.boundsHistory.push(bounds);
    }),
    on: (event: string, listener: () => void) => winEmitter.on(event, listener),
    webContents: {
      isLoading: () => isLoading,
      once: (event: string, listener: () => void) => wcEmitter.once(event, listener),
      setWindowOpenHandler: (handler) => {
        windowOpenHandler = handler;
      },
      executeJavaScript: vi.fn(async (code: string) => {
        executedScripts.push(code);
      }),
    },
  };

  return win;
}

describe('PC App transparent floating voice HUD', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-hud-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a transparent, click-through, non-focusable BrowserWindow positioned bottom-center and reuses it across cycles', () => {
    const createdOptions: VoiceHudBrowserWindowOptions[] = [];
    const mockWins: Array<ReturnType<typeof createMockHudWindow>> = [];

    const hud = createPcAppVoiceHud({
      getLocale: () => 'zh-CN',
      getDisplayWorkArea: () => ({ x: 100, y: 50, width: 1920, height: 1080 }),
      createWindow: (opts) => {
        createdOptions.push(opts);
        const w = createMockHudWindow();
        mockWins.push(w);
        return w;
      },
    });

    // Window is lazily created on first loading/start event
    expect(mockWins).toHaveLength(0);

    hud.handleEvent({ type: 'loading', variant: '0.6b' });
    expect(mockWins).toHaveLength(1);
    const win = mockWins[0]!;
    const opts = createdOptions[0]!;

    expect(opts.width).toBe(VOICE_HUD_WIDTH);
    expect(opts.height).toBe(VOICE_HUD_HEIGHT);
    expect(opts.x).toBe(Math.round(100 + (1920 - VOICE_HUD_WIDTH) / 2));
    expect(opts.y).toBe(Math.round(50 + 1080 - VOICE_HUD_HEIGHT - VOICE_HUD_BOTTOM_MARGIN));
    expect(opts.frame).toBe(false);
    expect(opts.transparent).toBe(true);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.focusable).toBe(false);
    expect(opts.show).toBe(false);
    expect(opts.skipTaskbar).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.sandbox).toBe(true);

    expect(win.ignoreMouseCalls).toEqual([
      { ignore: true, options: { forward: true } },
      { ignore: true, options: { forward: true } },
    ]);
    expect(win.alwaysOnTopCalls).toEqual([{ flag: true, level: 'floating' }]);
    expect(win.workspacesCalls).toEqual([{ visible: true, options: { visibleOnFullScreen: true } }]);
    expect(win.invokeWindowOpen('https://evil.example')).toEqual({ action: 'deny' });
    expect(win.showCalls).toBe(0);
    expect(win.showInactiveCalls).toBe(1);
    expect(win.getExecutedScripts().at(-1)).toContain('"mode":"loading"');
    expect(win.getExecutedScripts().at(-1)).toContain('正在加载语音模型…');

    // Transition to ready/listening state
    hud.handleEvent({ type: 'start' });
    expect(win.showCalls).toBe(0);
    expect(win.showInactiveCalls).toBe(1);
    expect(win.getExecutedScripts().at(-1)).toContain('"mode":"listening"');
    expect(win.getExecutedScripts().at(-1)).toContain('请说话');

    // End hides the window cleanly without destroying it
    hud.handleEvent({ type: 'end' });
    expect(win.hideCalls).toBe(1);
    expect(win.isDestroyed()).toBe(false);
    expect(win.getExecutedScripts().at(-1)).toContain('"mode":"hidden"');

    // Subsequent start reuses the exact same BrowserWindow immediately
    hud.handleEvent({ type: 'start' });
    expect(mockWins).toHaveLength(1);
    expect(win.showCalls).toBe(0);
    expect(win.showInactiveCalls).toBe(2);

    // Error also hides cleanly
    hud.handleEvent({ type: 'error', code: 'mic_failed' });
    expect(win.hideCalls).toBe(2);
    expect(win.isDestroyed()).toBe(false);

    // Dispose destroys the window
    hud.dispose();
    expect(win.destroyCalls).toBe(1);
    expect(win.isDestroyed()).toBe(true);

    // Events after dispose are no-ops
    hud.handleEvent({ type: 'start' });
    expect(mockWins).toHaveLength(1);
  });

  it('throttles level events at ~15fps, ignores levels outside listening, and syncs locale live', () => {
    let nowMs = 1000;
    const win = createMockHudWindow();
    const hud = createPcAppVoiceHud({
      getLocale: () => 'en',
      now: () => nowMs,
      createWindow: () => win,
    });

    // Level before start is ignored
    hud.handleEvent({ type: 'level', value: 0.7 });
    expect(win.showInactiveCalls).toBe(0);
    expect(win.getExecutedScripts()).toHaveLength(0);

    // Start listening
    hud.handleEvent({ type: 'start' });
    expect(win.getExecutedScripts()).toHaveLength(1);
    expect(win.getExecutedScripts()[0]).toContain('"text":"Listening"');

    // First level immediately after start is pushed
    nowMs = 1010;
    hud.handleEvent({ type: 'level', value: 0.45 });
    expect(win.getExecutedScripts()).toHaveLength(2);
    expect(win.getExecutedScripts()[1]).toContain('"level":0.45');

    // Level within 66ms window is throttled
    nowMs = 1010 + VOICE_HUD_LEVEL_MIN_INTERVAL_MS - 1;
    hud.handleEvent({ type: 'level', value: 0.8 });
    expect(win.getExecutedScripts()).toHaveLength(2);

    // Level after >=66ms is pushed (and clamped to [0, 1])
    nowMs = 1010 + VOICE_HUD_LEVEL_MIN_INTERVAL_MS;
    hud.handleEvent({ type: 'level', value: 1.5 });
    expect(win.getExecutedScripts()).toHaveLength(3);
    expect(win.getExecutedScripts()[2]).toContain('"level":1');

    // Changing locale updates active HUD text immediately
    hud.setLocale('zh-CN');
    expect(win.getExecutedScripts()).toHaveLength(4);
    expect(win.getExecutedScripts()[3]).toContain('请说话');

    // Result events do not hide or alter HUD
    hud.handleEvent({ type: 'result', text: 'hello', isFinal: true });
    expect(win.hideCalls).toBe(0);

    hud.dispose();
  });

  it('flushes latest state once did-finish-load completes and runs HUD HTML script with 16 waveform bars', () => {
    const win = createMockHudWindow({ loadingInitially: true });
    const hud = createPcAppVoiceHud({
      getLocale: () => 'zh-CN',
      createWindow: () => win,
    });

    hud.handleEvent({ type: 'loading', variant: '1.7b' });
    // Still loading URL: script queued until did-finish-load
    expect(win.getExecutedScripts()).toHaveLength(0);

    hud.handleEvent({ type: 'start' });
    hud.handleEvent({ type: 'level', value: 0.6 });
    expect(win.getExecutedScripts()).toHaveLength(0);

    win.finishLoad();
    expect(win.getExecutedScripts()).toHaveLength(1);
    expect(win.getExecutedScripts()[0]).toContain('"mode":"listening"');
    expect(win.getExecutedScripts()[0]).toContain('"level":0.6');

    // Execute the generated HTML's inline script against a lightweight DOM harness to verify 16 bars & state updates
    const html = decodeURIComponent(buildVoiceHudDataUrl('zh-CN').replace('data:text/html;charset=utf-8,', ''));
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();

    type FakeEl = {
      id: string;
      className: string;
      textContent: string;
      style: Record<string, string>;
      attrs: Record<string, string>;
      children: FakeEl[];
      setAttribute: (k: string, v: string) => void;
      appendChild: (c: FakeEl) => FakeEl;
    };
    const makeEl = (id = ''): FakeEl => {
      const el: FakeEl = {
        id,
        className: '',
        textContent: '',
        style: {},
        attrs: {},
        children: [],
        setAttribute: (k, v) => {
          el.attrs[k] = v;
        },
        appendChild: (c) => {
          el.children.push(c);
          return c;
        },
      };
      return el;
    };
    const byId = new Map<string, FakeEl>([
      ['imcodes-voice-hud-pill', makeEl('imcodes-voice-hud-pill')],
      ['imcodes-voice-hud-dot', makeEl('imcodes-voice-hud-dot')],
      ['imcodes-voice-hud-label', makeEl('imcodes-voice-hud-label')],
      ['imcodes-voice-hud-bars', makeEl('imcodes-voice-hud-bars')],
    ]);
    const fakeWindow: { __imcodesVoiceHudUpdate?: (state: unknown) => void } = {};
    const fakeDocument = {
      getElementById: (id: string) => byId.get(id) ?? null,
      createElement: () => makeEl(),
    };
    const runner = new Function('window', 'document', scriptMatch![1]);
    runner(fakeWindow, fakeDocument);

    const barsEl = byId.get('imcodes-voice-hud-bars')!;
    expect(barsEl.children).toHaveLength(VOICE_HUD_BAR_COUNT);

    fakeWindow.__imcodesVoiceHudUpdate!({ mode: 'loading', text: '正在加载语音模型…', level: 0 });
    expect(byId.get('imcodes-voice-hud-pill')!.attrs['data-mode']).toBe('loading');
    expect(byId.get('imcodes-voice-hud-label')!.textContent).toBe('正在加载语音模型…');
    expect(barsEl.className).toBe('');

    fakeWindow.__imcodesVoiceHudUpdate!({ mode: 'listening', text: '请说话', level: 0.75 });
    expect(byId.get('imcodes-voice-hud-pill')!.attrs['data-mode']).toBe('listening');
    expect(byId.get('imcodes-voice-hud-dot')!.className).toBe('listening');
    expect(barsEl.className).toBe('active');
    expect(Number.parseInt(barsEl.children.at(-1)!.style.height, 10)).toBeGreaterThan(4);

    fakeWindow.__imcodesVoiceHudUpdate!({ mode: 'hidden', text: '', level: 0 });
    expect(barsEl.className).toBe('');
    expect(barsEl.children.at(-1)!.style.height).toBe('4px');

    hud.dispose();
  });

  it('fails safely when BrowserWindow is unavailable or throwing and forwards voice-ipc events to HUD even with options.onEvent or null trusted origin', async () => {
    // Missing createWindow (e.g. Electron BrowserWindow unavailable in unit test)
    const noopHud = createPcAppVoiceHud();
    expect(() => {
      noopHud.handleEvent({ type: 'loading' });
      noopHud.handleEvent({ type: 'start' });
      noopHud.handleEvent({ type: 'level', value: 0.5 });
      noopHud.handleEvent({ type: 'end' });
      noopHud.setLocale('ja');
      noopHud.dispose();
    }).not.toThrow();

    // Throwing createWindow fails safely without throwing
    const throwingHud = createPcAppVoiceHud({
      createWindow: () => {
        throw new Error('Electron headless unavailable');
      },
    });
    expect(() => {
      throwingHud.handleEvent({ type: 'loading' });
      throwingHud.handleEvent({ type: 'start' });
      throwingHud.handleEvent({ type: 'end' });
    }).not.toThrow();

    // voice-ipc forwards events to onVoiceEvent even when options.onEvent is passed or trusted origin is null
    const hudEvents: PcAppVoiceEvent[] = [];
    const customOnEvent: PcAppVoiceEvent[] = [];
    const rendererSent: PcAppVoiceEvent[] = [];

    const childEmitter = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    childEmitter.stdout = new EventEmitter();
    childEmitter.stderr = new EventEmitter();
    childEmitter.stdin = { write: vi.fn(), end: vi.fn() };
    childEmitter.kill = vi.fn(() => true);

    const voice = createPcAppVoiceController({
      platform: 'darwin',
      arch: 'arm64',
      userDataDir: tempDir,
      speechHelperPath: '/Applications/IM.codes.app/Contents/Resources/imcodes-speech',
      isMainWebContents: () => true,
      getCurrentTrustedOrigin: () => null,
      getActiveOrigin: () => null,
      getTrustedOrigins: () => new Set(['https://app.im.codes']),
      getSenderUrl: () => 'https://app.im.codes',
      sendToRenderer: (_ch, ev) => rendererSent.push(ev),
      getMediaAccessStatus: () => 'granted',
      runHelperAsync: async () => JSON.stringify({ mic: 'authorized', speech: 'authorized', speechAvailable: true }),
      spawnHelper: () => childEmitter as unknown as ChildProcess,
      onVoiceEvent: (ev) => {
        hudEvents.push(ev);
        if (ev.type === 'level') {
          throw new Error('HUD error should not break voice IPC');
        }
      },
    });

    const res = await voice.startListening({
      locale: 'zh-CN',
      onEvent: (ev) => customOnEvent.push(ev),
    });
    expect(res).toEqual({ ok: true });

    childEmitter.stdout.emit(
      'data',
      '{"type":"loading","variant":"0.6b"}\n{"type":"start"}\n{"type":"level","value":0.5}\n',
    );
    await voice.stopListening({ abort: true });

    expect(rendererSent).toHaveLength(0);
    expect(customOnEvent).toEqual([
      { type: 'loading', variant: '0.6b' },
      { type: 'start' },
      { type: 'level', value: 0.5 },
    ]);
    expect(hudEvents).toEqual([
      { type: 'loading', variant: '0.6b' },
      { type: 'start' },
      { type: 'level', value: 0.5 },
      { type: 'end' },
    ]);

    await voice.dispose();
  });
});
