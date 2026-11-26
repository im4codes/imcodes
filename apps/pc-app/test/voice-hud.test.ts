import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVoiceHudSyncScript,
  createPcAppVoiceHud,
  VOICE_HUD_BAR_COUNT,
  VOICE_HUD_BAR_MAX_HEIGHT_PX,
  VOICE_HUD_BAR_MIN_HEIGHT_PX,
  VOICE_HUD_BAR_WIDTH_PX,
  VOICE_HUD_LEVEL_MIN_INTERVAL_MS,
  VOICE_HUD_ROOT_ID,
  VOICE_HUD_STYLE_ID,
  type VoiceHudWebContentsLike,
} from '../src/voice-hud.js';
import { createPcAppVoiceController, type PcAppVoiceEvent } from '../src/voice-ipc.js';

type FakeDomElement = {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeDomElement[];
  setAttribute: (k: string, v: string) => void;
  appendChild: (c: FakeDomElement) => FakeDomElement;
};

function createFakeDomHarness() {
  const byId = new Map<string, FakeDomElement>();

  const makeEl = (tagName: string): FakeDomElement => {
    let idValue = '';
    const el: FakeDomElement = {
      get id() {
        return idValue;
      },
      set id(next: string) {
        if (idValue) byId.delete(idValue);
        idValue = next;
        if (next) byId.set(next, el);
      },
      tagName,
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

  const head = makeEl('head');
  const body = makeEl('body');
  const fakeWindow: { __imcodesVoiceHudUpdate?: (state: unknown) => void } = {};
  const fakeDocument = {
    head,
    body,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (tag: string) => makeEl(tag),
  };

  const runScript = (code: string): void => {
    const runner = new Function('window', 'document', code);
    runner(fakeWindow, fakeDocument);
  };

  return { head, body, byId, fakeWindow, runScript };
}

function createMockWebContents(opts?: { loadingInitially?: boolean; runInDom?: boolean }) {
  const wcEmitter = new EventEmitter();
  let destroyed = false;
  let isLoading = opts?.loadingInitially ?? false;
  const executedScripts: string[] = [];
  let dom = createFakeDomHarness();

  const wc: VoiceHudWebContentsLike & {
    getExecutedScripts: () => string[];
    finishLoad: (resetDom?: boolean) => void;
    destroy: () => void;
    dom: () => ReturnType<typeof createFakeDomHarness>;
  } = {
    getExecutedScripts: () => executedScripts,
    finishLoad: (resetDom = false) => {
      isLoading = false;
      if (resetDom) {
        dom = createFakeDomHarness();
      }
      wcEmitter.emit('did-finish-load');
    },
    destroy: () => {
      destroyed = true;
    },
    dom: () => dom,
    isDestroyed: () => destroyed,
    isLoading: () => isLoading,
    on: (event, listener) => wcEmitter.on(event, listener),
    off: (event, listener) => wcEmitter.off(event, listener),
    removeListener: (event, listener) => wcEmitter.removeListener(event, listener),
    executeJavaScript: vi.fn(async (code: string) => {
      executedScripts.push(code);
      if (opts?.runInDom) {
        dom.runScript(code);
      }
    }),
  };

  return wc;
}

describe('PC App in-page transparent voice HUD', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-hud-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('injects a transparent, click-through overlay into the main page and drives loading -> listening -> level -> end/error', () => {
    const wc = createMockWebContents({ runInDom: true });

    const hud = createPcAppVoiceHud({
      getLocale: () => 'zh-CN',
      getWebContents: () => wc,
    });

    // Nothing injected before first active voice event
    expect(wc.getExecutedScripts()).toHaveLength(0);
    expect(wc.dom().byId.get(VOICE_HUD_ROOT_ID)).toBeUndefined();

    // 1. Loading state injects style + click-through transparent root
    hud.handleEvent({ type: 'loading', variant: '0.6b' });
    expect(wc.getExecutedScripts()).toHaveLength(1);

    const dom = wc.dom();
    const styleEl = dom.byId.get(VOICE_HUD_STYLE_ID)!;
    const rootEl = dom.byId.get(VOICE_HUD_ROOT_ID)!;
    const dotEl = dom.byId.get('imcodes-voice-hud-dot')!;
    const labelEl = dom.byId.get('imcodes-voice-hud-label')!;
    const barsEl = dom.byId.get('imcodes-voice-hud-bars')!;

    expect(styleEl).toBeDefined();
    expect(styleEl.textContent).toContain('pointer-events: none');
    expect(styleEl.textContent).toContain('user-select: none');
    expect(styleEl.textContent).toContain('background: transparent');
    expect(styleEl.textContent).toContain('flex-wrap: nowrap');
    expect(styleEl.textContent).toContain('.voice-active-service-chip');
    expect(styleEl.textContent).toContain('text-overflow: ellipsis');
    expect(styleEl.textContent).toContain(`width: ${VOICE_HUD_BAR_WIDTH_PX}px`);
    expect(styleEl.textContent).toContain(`max-height: ${VOICE_HUD_BAR_MAX_HEIGHT_PX}px`);
    expect(styleEl.textContent).not.toContain('rgba(15, 23, 42, 0.9)');

    expect(rootEl.style.position).toBe('fixed');
    expect(rootEl.style.bottom).toBe('76px');
    expect(rootEl.style.left).toBe('50%');
    expect(rootEl.style.transform).toBe('translateX(-50%)');
    expect(rootEl.style.zIndex).toBe('2147483645');
    expect(rootEl.style.pointerEvents).toBe('none');
    expect(rootEl.style.userSelect).toBe('none');
    expect(rootEl.style.background).toBe('transparent');
    expect(rootEl.style.display).toBe('flex');
    expect(rootEl.attrs['data-mode']).toBe('loading');
    expect(labelEl.textContent).toBe('正在加载语音模型…');
    expect(dotEl.className).toBe('');
    expect(barsEl.className).toBe('');
    expect(barsEl.children).toHaveLength(VOICE_HUD_BAR_COUNT);

    // 2. Listening state shows cyan/green dot + 16-bar waveform and animates levels
    hud.handleEvent({ type: 'start' });
    expect(rootEl.style.display).toBe('flex');
    expect(rootEl.attrs['data-mode']).toBe('listening');
    expect(dotEl.className).toBe('listening');
    expect(barsEl.className).toBe('active');
    expect(labelEl.textContent).toBe('请说话');

    hud.handleEvent({ type: 'level', value: 0.75 });
    expect(Number.parseInt(barsEl.children.at(-1)!.style.height, 10)).toBeGreaterThan(VOICE_HUD_BAR_MIN_HEIGHT_PX);
    expect(Number.parseInt(barsEl.children.at(-1)!.style.height, 10)).toBeLessThanOrEqual(VOICE_HUD_BAR_MAX_HEIGHT_PX);

    // 3. End hides immediately via display: none without removing or opening windows
    hud.handleEvent({ type: 'end' });
    expect(rootEl.style.display).toBe('none');
    expect(rootEl.attrs['data-mode']).toBe('hidden');
    expect(barsEl.className).toBe('');
    expect(barsEl.children.at(-1)!.style.height).toBe(`${VOICE_HUD_BAR_MIN_HEIGHT_PX}px`);

    // 4. Subsequent start reuses the exact same DOM node (no duplicate roots)
    hud.handleEvent({ type: 'start' });
    expect(dom.body.children.filter((c) => c.id === VOICE_HUD_ROOT_ID)).toHaveLength(1);
    expect(rootEl.style.display).toBe('flex');

    // 5. Error hides immediately
    hud.handleEvent({ type: 'error', code: 'mic_failed' });
    expect(rootEl.style.display).toBe('none');
    expect(rootEl.attrs['data-mode']).toBe('hidden');

    // 6. Dispose hides if visible and ignores subsequent events
    hud.handleEvent({ type: 'start' });
    expect(rootEl.style.display).toBe('flex');
    hud.dispose();
    expect(rootEl.style.display).toBe('none');

    const countAtDispose = wc.getExecutedScripts().length;
    hud.handleEvent({ type: 'start' });
    expect(wc.getExecutedScripts()).toHaveLength(countAtDispose);
  });

  it('throttles level events at ~15fps, ignores levels outside listening, and syncs locale live', () => {
    let nowMs = 1000;
    const wc = createMockWebContents();
    const hud = createPcAppVoiceHud({
      getLocale: () => 'en',
      now: () => nowMs,
      getWebContents: () => wc,
    });

    // Level before start is ignored
    hud.handleEvent({ type: 'level', value: 0.7 });
    expect(wc.getExecutedScripts()).toHaveLength(0);

    // Start listening
    hud.handleEvent({ type: 'start' });
    expect(wc.getExecutedScripts()).toHaveLength(1);
    expect(wc.getExecutedScripts()[0]).toContain('"text":"Listening"');

    // First level immediately after start is pushed
    nowMs = 1010;
    hud.handleEvent({ type: 'level', value: 0.45 });
    expect(wc.getExecutedScripts()).toHaveLength(2);
    expect(wc.getExecutedScripts()[1]).toContain('"level":0.45');

    // Level within 66ms window is throttled
    nowMs = 1010 + VOICE_HUD_LEVEL_MIN_INTERVAL_MS - 1;
    hud.handleEvent({ type: 'level', value: 0.8 });
    expect(wc.getExecutedScripts()).toHaveLength(2);

    // Level after >=66ms is pushed (and clamped to [0, 1])
    nowMs = 1010 + VOICE_HUD_LEVEL_MIN_INTERVAL_MS;
    hud.handleEvent({ type: 'level', value: 1.5 });
    expect(wc.getExecutedScripts()).toHaveLength(3);
    expect(wc.getExecutedScripts()[2]).toContain('"level":1');

    // Changing locale updates active HUD text immediately
    hud.setLocale('zh-CN');
    expect(wc.getExecutedScripts()).toHaveLength(4);
    expect(wc.getExecutedScripts()[3]).toContain('请说话');

    // Result events do not hide or alter HUD
    hud.handleEvent({ type: 'result', text: 'hello', isFinal: true });
    expect(wc.getExecutedScripts()).toHaveLength(4);

    hud.dispose();
  });

  it('resyncs active overlay after did-finish-load on navigation/reload and stays silent when hidden', () => {
    const wc = createMockWebContents({ loadingInitially: true, runInDom: true });
    const hud = createPcAppVoiceHud({
      getLocale: () => 'zh-CN',
      getWebContents: () => wc,
    });

    hud.handleEvent({ type: 'loading', variant: '1.7b' });
    // Page still loading: deferred until did-finish-load
    expect(wc.getExecutedScripts()).toHaveLength(0);

    hud.handleEvent({ type: 'start' });
    hud.handleEvent({ type: 'level', value: 0.6 });
    expect(wc.getExecutedScripts()).toHaveLength(0);

    wc.finishLoad();
    expect(wc.getExecutedScripts()).toHaveLength(1);
    expect(wc.getExecutedScripts()[0]).toContain('"mode":"listening"');
    expect(wc.getExecutedScripts()[0]).toContain('"level":0.6');
    expect(wc.dom().byId.get(VOICE_HUD_ROOT_ID)?.style.display).toBe('flex');

    // Simulate reload while still listening: DOM resets and did-finish-load re-injects overlay
    wc.finishLoad(true);
    expect(wc.getExecutedScripts()).toHaveLength(2);
    expect(wc.dom().byId.get(VOICE_HUD_ROOT_ID)?.style.display).toBe('flex');
    expect(wc.dom().byId.get(VOICE_HUD_ROOT_ID)?.attrs['data-mode']).toBe('listening');

    // After end, subsequent did-finish-load does NOT re-inject a hidden overlay
    hud.handleEvent({ type: 'end' });
    const beforeHiddenReload = wc.getExecutedScripts().length;
    wc.finishLoad(true);
    expect(wc.getExecutedScripts()).toHaveLength(beforeHiddenReload);
    expect(wc.dom().byId.get(VOICE_HUD_ROOT_ID)).toBeUndefined();

    // Direct buildVoiceHudSyncScript with hidden on fresh DOM is a safe no-op
    const freshDom = createFakeDomHarness();
    freshDom.runScript(buildVoiceHudSyncScript({ mode: 'hidden', text: '', level: 0 }));
    expect(freshDom.byId.get(VOICE_HUD_ROOT_ID)).toBeUndefined();

    hud.dispose();
  });

  it('fails safely when webContents is null, destroyed, or throwing and forwards voice-ipc events to HUD', async () => {
    // Missing getWebContents
    const noopHud = createPcAppVoiceHud();
    expect(() => {
      noopHud.handleEvent({ type: 'loading' });
      noopHud.handleEvent({ type: 'start' });
      noopHud.handleEvent({ type: 'level', value: 0.5 });
      noopHud.handleEvent({ type: 'end' });
      noopHud.setLocale('ja');
      noopHud.dispose();
    }).not.toThrow();

    // Destroyed webContents
    const destroyedWc = createMockWebContents();
    destroyedWc.destroy();
    const destroyedHud = createPcAppVoiceHud({
      getWebContents: () => destroyedWc,
    });
    destroyedHud.handleEvent({ type: 'loading' });
    destroyedHud.handleEvent({ type: 'start' });
    expect(destroyedWc.getExecutedScripts()).toHaveLength(0);

    // Throwing getWebContents fails safely without throwing
    const throwingHud = createPcAppVoiceHud({
      getWebContents: () => {
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
