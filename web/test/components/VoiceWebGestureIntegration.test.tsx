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
    await vi.advanceTimersByTimeAsync(300);
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
    await vi.advanceTimersByTimeAsync(300);
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

  it('transitions hold HUD cleanly to voice.no_speech (never stuck on recognizing) on empty primed end and mid-hold onend', async () => {
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

    // 1. Primed recognition starts & ends cleanly with no speech BEFORE 175ms timer: must not restart outside gesture or freeze in recognizing
    inUserGesture = true;
    fireEvent(input, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 30, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true,
    }));
    inUserGesture = false;
    expect(instances).toHaveLength(1);
    instances[0].onstart?.();
    instances[0].onend?.();

    await vi.advanceTimersByTimeAsync(175);
    expect(instances).toHaveLength(1);
    const hud1 = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud1).not.toBeNull();
    expect(hud1.getAttribute('data-phase')).toBe('ended');
    expect(hud1.textContent).toContain('voice.no_speech');
    expect(hud1.textContent).not.toContain('voice.recognizing');
    expect(hud1.textContent).not.toContain('voice.buffering_hint');
    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 30, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // 2. Active hold gets onstart -> shows ambient wave + voice.listening -> iOS WebKit silent onend -> switches to ended cleanly
    inUserGesture = true;
    fireEvent(input, Object.assign(new Event('pointerdown', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 31, button: 0, buttons: 1, pointerType: 'touch', isPrimary: true,
    }));
    inUserGesture = false;
    await vi.advanceTimersByTimeAsync(175);
    expect(instances).toHaveLength(2);
    const rec2 = instances[1];
    const hud2 = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud2.getAttribute('data-phase')).toBe('starting');
    rec2.onstart?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(hud2.getAttribute('data-phase')).toBe('recording');
    expect(hud2.querySelector('.voice-hold-hud-waveform.is-ambient-wave')).not.toBeNull();

    rec2.onerror?.({ error: 'no-speech' });
    rec2.onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(hud2.getAttribute('data-phase')).toBe('ended');
    expect(hud2.textContent).toContain('voice.no_speech');
    expect(hud2.querySelector('.voice-hold-hud-waveform.is-ambient-wave')).toBeNull();
    expect(hud2.querySelector('.voice-hold-hud-waveform.is-ended')).not.toBeNull();

    fireEvent(window, Object.assign(new Event('pointerup', { bubbles: true, cancelable: true }), {
      clientX: 160, clientY: 500, pointerId: 31, button: 0, buttons: 0, pointerType: 'touch', isPrimary: true,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('keeps standalone VoiceOverlay in voice.starting until onstart/onaudiostart confirms and promotes on late onstart', async () => {
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
    inUserGesture = true;
    fireEvent.pointerDown(micBtn, { pointerId: 40, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = false;
    await vi.advanceTimersByTimeAsync(0);

    expect(instances).toHaveLength(1);
    expect(instances[0].start).toHaveBeenCalledTimes(1);
    expect(VoiceInput.isListening()).toBe(false);

    const status = document.querySelector('.voice-overlay-status [role="status"]') as HTMLElement;
    const dot = document.querySelector('.voice-status-dot') as HTMLElement;
    const overlayMic = document.querySelector('.voice-overlay-mic') as HTMLButtonElement;
    const ta = document.querySelector('.voice-overlay-text') as HTMLTextAreaElement;
    expect(status.textContent).toBe('voice.starting');
    expect(dot.classList.contains('voice-status-dot-active')).toBe(false);
    expect(overlayMic.classList.contains('voice-overlay-mic-active')).toBe(false);
    expect(ta.readOnly).toBe(true);

    // Late onstart confirms capture and activates listening + mic UI
    instances[0].onstart?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(VoiceInput.isListening()).toBe(true);
    expect(status.textContent).toBe('voice.listening');
    expect(dot.classList.contains('voice-status-dot-active')).toBe(true);
    expect(overlayMic.classList.contains('voice-overlay-mic-active')).toBe(true);

    instances[0].onresult?.({
      results: { length: 1, 0: { 0: { transcript: 'delayed confirm ok' }, isFinal: false } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe('voice.recognizing');
    expect(ta.value).toBe('delayed confirm ok');
  });

  it('exits voice.starting cleanly to editable error state on unconfirmed onend or async not-allowed and supports Retry', async () => {
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
    inUserGesture = true;
    fireEvent.pointerDown(micBtn, { pointerId: 41, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = false;
    await vi.advanceTimersByTimeAsync(0);

    const status = document.querySelector('.voice-overlay-status [role="status"]') as HTMLElement;
    const ta = document.querySelector('.voice-overlay-text') as HTMLTextAreaElement;
    expect(status.textContent).toBe('voice.starting');
    expect(ta.readOnly).toBe(true);

    // 1. Unconfirmed onend (rec ends before onstart ever fires)
    instances[0].onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(VoiceInput.isListening()).toBe(false);
    expect(status.textContent).toBe('voice.ready');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('voice.mic_permission_failed');
    expect(ta.readOnly).toBe(false);

    // 2. Retry starts a new session, async not-allowed while pending starting clears starting and restores editing
    const retryBtn = document.querySelector('.voice-overlay-retry') as HTMLButtonElement;
    inUserGesture = true;
    fireEvent.click(retryBtn);
    inUserGesture = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(instances).toHaveLength(2);
    expect(status.textContent).toBe('voice.starting');
    expect(ta.readOnly).toBe(true);

    instances[1].onerror?.({ error: 'not-allowed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(VoiceInput.isListening()).toBe(false);
    expect(status.textContent).toBe('voice.ready');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('voice.mic_permission_failed');
    expect(ta.readOnly).toBe(false);
    expect(instances[1].stop).toHaveBeenCalledTimes(1);
    instances[1].onend?.();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('cancels pending voice.starting via mic stop or close and blocks late stale onstart/onresult', async () => {
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
    inUserGesture = true;
    fireEvent.pointerDown(micBtn, { pointerId: 42, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = false;
    await vi.advanceTimersByTimeAsync(0);

    const status = document.querySelector('.voice-overlay-status [role="status"]') as HTMLElement;
    const overlayMic = document.querySelector('.voice-overlay-mic') as HTMLButtonElement;
    const ta = document.querySelector('.voice-overlay-text') as HTMLTextAreaElement;
    expect(status.textContent).toBe('voice.starting');

    // 1. Tap overlay mic button while in pending voice.starting to cancel and edit manually
    fireEvent.click(overlayMic);
    await vi.advanceTimersByTimeAsync(0);
    expect(instances[0].stop).toHaveBeenCalledTimes(1);
    expect(status.textContent).toBe('voice.ready');
    expect(ta.readOnly).toBe(false);

    // Late callbacks on cancelled instance (before/after onend) cannot revive listening or clobber text
    instances[0].onstart?.();
    instances[0].onresult?.({
      results: { length: 1, 0: { 0: { transcript: 'stale ghost text' }, isFinal: true } },
    });
    instances[0].onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(VoiceInput.isListening()).toBe(false);
    expect(status.textContent).toBe('voice.ready');
    expect(ta.value).toBe('');

    // 2. Restart -> still pending starting -> Close overlay -> late callbacks are fenced
    inUserGesture = true;
    fireEvent.click(overlayMic);
    inUserGesture = false;
    await vi.advanceTimersByTimeAsync(0);
    expect(instances).toHaveLength(2);
    expect(status.textContent).toBe('voice.starting');

    const closeBtn = document.querySelector('.voice-overlay-close') as HTMLButtonElement;
    fireEvent.click(closeBtn);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-overlay')).toBeNull();
    expect(instances[1].stop).toHaveBeenCalledTimes(1);

    instances[1].onstart?.();
    instances[1].onresult?.({
      results: { length: 1, 0: { 0: { transcript: 'after close ghost' }, isFinal: true } },
    });
    instances[1].onend?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(VoiceInput.isListening()).toBe(false);
  });

  it('recovers primed mobile Web hold-to-talk stuck at voice.starting when WebKit never emits onstart/onerror/onend and allows immediate retry', async () => {
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
    const ev1Down = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(ev1Down, { clientX: 180, clientY: 500, pointerId: 10, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = true;
    fireEvent(input, ev1Down);
    inUserGesture = false;
    expect(instances).toHaveLength(1);

    // Hold 175ms enters HUD in 'starting' phase waiting for WebKit onstart/onaudiostart
    await vi.advanceTimersByTimeAsync(175);
    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud).not.toBeNull();
    expect(hud.getAttribute('data-phase')).toBe('starting');

    // WebKit never emits onstart/onaudiostart/onerror/onend -> bounded confirm timeout recovers cleanly
    await vi.advanceTimersByTimeAsync(VoiceInput.WEB_START_CONFIRM_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(instances[0].abort).toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.querySelector('.voice-hold-error-banner')?.textContent).toContain('Speech recognition timed out');
    expect(VoiceInput.isListening()).toBe(false);
    expect(input.getAttribute('contenteditable')).toBe('true');

    // Release stuck finger & blur back to voice-ready -> second hold starts and sends speech cleanly
    const ev1Up = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.assign(ev1Up, { clientX: 180, clientY: 500, pointerId: 10, button: 0, pointerType: 'touch', isPrimary: true });
    fireEvent(window, ev1Up);
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(0);

    const ev2Down = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(ev2Down, { clientX: 180, clientY: 500, pointerId: 11, button: 0, pointerType: 'touch', isPrimary: true });
    inUserGesture = true;
    fireEvent(input, ev2Down);
    inUserGesture = false;
    expect(instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(175);

    const hud2 = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud2.getAttribute('data-phase')).toBe('starting');
    instances[1].onstart?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(hud2.getAttribute('data-phase')).toBe('recording');
    instances[1].onresult?.({
      results: { length: 1, 0: { 0: { transcript: 'recovered second attempt' }, isFinal: true } },
    });
    const ev2Up = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.assign(ev2Up, { clientX: 180, clientY: 500, pointerId: 11, button: 0, pointerType: 'touch', isPrimary: true });
    fireEvent(window, ev2Up);
    instances[1].onend?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'recovered second attempt',
    }));
  });
});
