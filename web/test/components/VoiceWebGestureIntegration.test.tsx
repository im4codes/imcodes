/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts?.error ? `${key}:${String(opts.error)}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../../src/screen-awake.js', () => ({
  holdScreenAwake: () => () => {},
}));

vi.mock('../../src/components/AtPicker.js', () => ({
  AtPicker: () => null,
}));

vi.mock('../../src/components/P2pConfigPanel.js', () => ({
  P2pConfigPanel: () => null,
}));

vi.mock('../../src/components/p2p-combos.js', () => ({
  useP2pCustomCombos: () => ({ allCombos: { presets: [], custom: [] } }),
}));

vi.mock('../../src/hooks/useSwipeBack.js', () => ({
  useSwipeBack: () => ({ current: null }),
}));

vi.mock('../../src/hooks/useMachines.js', () => ({
  useMachines: () => ({
    machines: [],
    filtered: [],
    loaded: true,
    loading: false,
    error: null,
    stale: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../src/api.js', () => ({
  uploadFile: vi.fn(),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  fetchSessionSupervisorDefaults: vi.fn().mockResolvedValue(null),
  saveSessionSupervisorDefaults: vi.fn().mockResolvedValue({}),
  getUserPref: vi.fn().mockResolvedValue(null),
  saveUserPref: vi.fn().mockResolvedValue(undefined),
  onUserPrefChanged: vi.fn(() => () => {}),
  apiFetch: vi.fn().mockResolvedValue({ data: { history: [], sessionHistory: {}, commands: [], phrases: [] } }),
}));

import { SessionControls } from '../../src/components/SessionControls.js';
import * as VoiceInput from '../../src/components/VoiceInput.js';
import type { SessionInfo } from '../../src/types.js';

const makeSession = (): SessionInfo => ({
  name: 'deck_main',
  project: 'main',
  role: 'main',
  agentType: 'claude-code-sdk',
  state: 'idle',
  runtimeType: 'transport',
  projectDir: '/tmp/project',
});

const makeQuickData = () => ({
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(),
  refresh: vi.fn(),
  addCommand: vi.fn(),
  addPhrase: vi.fn(),
  removeCommand: vi.fn(),
  removePhrase: vi.fn(),
} as any);

interface FakeRecInstance {
  startCallDepthInsideGesture: boolean;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

describe('Mobile Web Speech real integration (SessionControls + VoiceOverlay + VoiceInput)', () => {
  let instances: FakeRecInstance[] = [];
  let inUserGesture = false;
  let origTouchPoints: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = [];
    inUserGesture = false;
    origTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });

    class FakeSpeechRecognition {
      startCallDepthInsideGesture = false;
      onstart: (() => void) | null = null;
      onaudiostart: (() => void) | null = null;
      onresult: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn(() => {
        this.startCallDepthInsideGesture = inUserGesture;
      });
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
  });

  afterEach(async () => {
    await VoiceInput.stopListening({ abort: true });
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (origTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', origTouchPoints);
    else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
  });

  it('starts Web Speech synchronously inside the embedded mic button gesture, deduplicates pointerdown+click, adopts in VoiceOverlay, and sends transcript', async () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const micBtn = document.querySelector('.btn-voice-embedded') as HTMLButtonElement;
    expect(micBtn).not.toBeNull();

    inUserGesture = true;
    fireEvent.pointerDown(micBtn, { pointerId: 1, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = false;
    // Trailing synthetic click in same tap must be ignored (no double open/abort)
    fireEvent.click(micBtn);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('.voice-overlay')).not.toBeNull();
    expect(instances).toHaveLength(1);
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(instances[0].startCallDepthInsideGesture).toBe(true);
    expect(instances[0].abort).not.toHaveBeenCalled();

    const rec = instances[0];
    rec.onstart?.();
    rec.onresult?.({
      results: {
        length: 1,
        0: { 0: { transcript: '语音按钮测试' }, isFinal: false },
      },
    });
    // Natural browser end before Send promotes interim & lets Send complete immediately
    rec.onend?.();
    await vi.advanceTimersByTimeAsync(0);

    const textarea = document.querySelector('.voice-overlay-text') as HTMLTextAreaElement;
    expect(textarea.value).toBe('语音按钮测试');

    const sendBtn = document.querySelector('.voice-overlay-send') as HTMLButtonElement;
    fireEvent.click(sendBtn);
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: '语音按钮测试',
    }));
  });

  it('primes Web Speech in synchronous pointerdown, aborts silently on short tap to allow typing/paste, and completes hold-to-talk even with lostpointercapture(buttons=0) + early onend', async () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = document.querySelector('.controls-input') as HTMLElement;

    // 1. Short tap: primes in pointerdown, aborts cleanly on <175ms pointerup with zero error banner & focuses composer
    inUserGesture = true;
    fireEvent(input, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 1, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true,
    }));
    inUserGesture = false;
    expect(instances).toHaveLength(1);
    expect(instances[0].startCallDepthInsideGesture).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    fireEvent(input, Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 1, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(instances[0].abort).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.voice-hold-error-banner')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('true');

    // Return to unfocused voice-ready
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // 2. Real hold: primes in pointerdown, adopts after 175ms WITHOUT aborting, survives lostpointercapture(buttons=0), emits interim+onend, sends immediately
    inUserGesture = true;
    fireEvent(input, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 2, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true,
    }));
    inUserGesture = false;
    expect(instances).toHaveLength(2);
    expect(instances[1].startCallDepthInsideGesture).toBe(true);
    await vi.advanceTimersByTimeAsync(175);
    expect(instances).toHaveLength(2);
    expect(instances[1].abort).not.toHaveBeenCalled();

    // iOS WebKit lostpointercapture(buttons=0) right after blur/setPointerCapture must NOT abort hold
    fireEvent(input, Object.assign(new Event('lostpointercapture', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 2, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();

    const holdRec = instances[1];
    holdRec.onstart?.();
    holdRec.onresult?.({
      results: {
        length: 1,
        0: { 0: { transcript: '按住说话成功出字' }, isFinal: false },
      },
    });
    holdRec.onend?.();

    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 2, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: '按住说话成功出字',
    }));
  });

  it('keeps primed hold alive across 50ms pending lostpointercapture(buttons=0), adopts same recognizer at 175ms, and still cancels cleanly on window pointerup/cancel', async () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const input = document.querySelector('.controls-input') as HTMLElement;

    // 1. Prime -> onstart -> 50ms pending lostpointercapture(buttons=0) MUST NOT abort; 175ms adopts same instance and sends
    inUserGesture = true;
    fireEvent(input, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 10, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true,
    }));
    inUserGesture = false;
    expect(instances).toHaveLength(1);
    const rec1 = instances[0];
    rec1.onstart?.();

    await vi.advanceTimersByTimeAsync(50);
    fireEvent(input, Object.assign(new Event('lostpointercapture', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 10, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    expect(rec1.abort).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(125); // 50 + 125 = 175ms
    expect(instances).toHaveLength(1);
    expect(rec1.abort).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();

    rec1.onresult?.({
      results: {
        length: 1,
        0: { 0: { transcript: '预热期内丢捕获仍出字' }, isFinal: true },
      },
    });
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 10, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rec1.stop).toHaveBeenCalledTimes(1);
    rec1.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: '预热期内丢捕获仍出字',
    }));

    // 2. Pending lostpointercapture at 50ms + window pointerup/cancel at 70ms silently aborts prime & focuses composer
    for (const [idx, endType] of (['pointerup', 'pointercancel'] as const).entries()) {
      const pid = 11 + idx;
      input.blur();
      fireEvent.blur(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('false');

      const beforeLen = instances.length;
      fireEvent(input, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
        clientX: 160, clientY: 500, pointerId: pid, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true,
      }));
      expect(instances).toHaveLength(beforeLen + 1);
      const rec = instances[beforeLen];
      await vi.advanceTimersByTimeAsync(50);
      fireEvent(input, Object.assign(new Event('lostpointercapture', { bubbles: true, cancelable: true }), {
        clientX: 160, clientY: 500, pointerId: pid, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
      }));
      expect(rec.abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      fireEvent(window, Object.assign(new Event(endType, { bubbles: true, cancelable: true }), {
        clientX: 160, clientY: 500, pointerId: pid, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(rec.abort).toHaveBeenCalledTimes(1);
      expect(document.querySelector('.voice-hold-hud')).toBeNull();
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
    }
  });

  it('leaves VoiceOverlay editable (not stuck listening) when primed capture ends with transcript before startListening adopts', async () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const micBtn = document.querySelector('.btn-voice-embedded') as HTMLButtonElement;
    // Simulate synchronous onstart + interim result + onend happening inside rec.start() before VoiceOverlay useEffect runs
    inUserGesture = true;
    fireEvent.pointerDown(micBtn, { pointerId: 21, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = false;
    expect(instances).toHaveLength(1);
    const rec = instances[0];
    rec.onstart?.();
    rec.onresult?.({
      results: {
        length: 1,
        0: { 0: { transcript: '预热提前结束仍可编辑' }, isFinal: false },
      },
    });
    rec.onend?.();

    await vi.advanceTimersByTimeAsync(0);

    const textarea = document.querySelector('.voice-overlay-text') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('预热提前结束仍可编辑');
    expect(textarea.readOnly).toBe(false);
    expect(document.querySelector('.voice-overlay-mic-active')).toBeNull();
  });
});
