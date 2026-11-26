/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQuickDataResult } from '../../src/components/QuickInputPanel.js';

type VoiceResultCb = (text: string, isFinal: boolean) => void;
type VoiceListeningCb = (listening: boolean) => void;
type VoiceErrorCb = (err: string) => void;
type VoiceLevelCb = ((level: number) => void) | null;

const voiceState = vi.hoisted(() => ({
  onResult: null as VoiceResultCb | null,
  onListeningChange: null as VoiceListeningCb | null,
  onError: null as VoiceErrorCb | null,
  onLevel: null as VoiceLevelCb,
  startListening: vi.fn(async (onResult: VoiceResultCb, onListeningChange?: VoiceListeningCb, onError?: VoiceErrorCb) => {
    voiceState.onResult = onResult;
    voiceState.onListeningChange = onListeningChange ?? null;
    voiceState.onError = onError ?? null;
    onListeningChange?.(true);
    return true;
  }),
  stopListening: vi.fn(async () => {
    voiceState.onListeningChange?.(false);
  }),
  isAvailable: vi.fn(() => true),
  prewarm: vi.fn(),
  onAudioLevel: vi.fn((cb: VoiceLevelCb) => {
    voiceState.onLevel = cb;
  }),
  onModelLoading: vi.fn(),
  primeVoiceGesture: vi.fn(() => true),
  cancelVoiceGesturePrime: vi.fn(),
}));

const platformState = vi.hoisted(() => ({
  macDesktop: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

vi.mock('../../src/components/VoiceInput.js', () => voiceState);

vi.mock('../../src/native-platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/native-platform.js')>('../../src/native-platform.js');
  return {
    ...actual,
    isNativeMacDesktop: () => platformState.macDesktop,
  };
});

import { SessionControls, readComposerElementText } from '../../src/components/SessionControls.js';

const quickData: UseQuickDataResult = {
  data: { history: [], sessionHistory: {}, commands: [], phrases: [] },
  loaded: true,
  recordHistory: vi.fn(), addCommand: vi.fn(), addPhrase: vi.fn(),
  removeCommand: vi.fn(), removePhrase: vi.fn(), removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(), clearHistory: vi.fn(), clearSessionHistory: vi.fn(),
};

function makeWs() {
  return {
    connected: true,
    sendSessionCommand: vi.fn(() => 'cmd-1'),
    sendSessionCommandUrgent: vi.fn(),
    send: vi.fn(),
    sendInput: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    getDaemonCapabilitySnapshot: vi.fn(() => null),
    onDaemonCapabilitySnapshot: vi.fn(() => () => {}),
    isDaemonCapabilityStale: vi.fn(() => false),
  } as any;
}

function setComposerTextAndCaret(el: HTMLDivElement, text: string, caretOffset: number) {
  el.textContent = text;
  const textNode = el.firstChild;
  const sel = window.getSelection();
  if (sel && textNode) {
    const range = document.createRange();
    range.setStart(textNode, caretOffset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function doubleTapShift() {
  fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft' });
  fireEvent.keyDown(window, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  fireEvent.keyUp(window, { key: 'Shift', code: 'ShiftLeft' });
}

function renderComposer(width = 1200) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  const ws = makeWs();
  const onSend = vi.fn();
  const rendered = render(
    <SessionControls
      ws={ws}
      activeSession={{
        name: 'deck_app_brain',
        project: 'app',
        role: 'brain',
        state: 'idle',
        projectDir: '/work/app',
        agentType: 'claude-code',
      } as never}
      quickData={quickData}
      serverId="srv1"
      sessions={[]}
      subSessions={[]}
      onSend={onSend}
    />,
  );
  const input = rendered.container.querySelector('.controls-input') as HTMLDivElement;
  return { ...rendered, ws, onSend, input };
}

describe('Mac app inline composer voice input', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    platformState.macDesktop = true;
    voiceState.onResult = null;
    voiceState.onListeningChange = null;
    voiceState.onError = null;
    voiceState.onLevel = null;
    voiceState.startListening.mockClear();
    voiceState.stopListening.mockClear();
    voiceState.onAudioLevel.mockClear();
    voiceState.isAvailable.mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('starts inline voice in composer (no VoiceOverlay) when clicking desktop mic or double-tapping Shift, inserts at cursor with robot cursor, and clears cleanly on send', async () => {
    const { container, input, onSend } = renderComposer(1200);
    input.focus();
    setComposerTextAndCaret(input, 'hello world', 5);

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    expect(micBtn).not.toBeNull();
    fireEvent.click(micBtn);

    expect(voiceState.startListening).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.voice-overlay')).toBeNull();
    expect(document.body.querySelector('.voice-overlay')).toBeNull();
    expect(micBtn.classList.contains('btn-voice-inline-active')).toBe(true);
    expect(micBtn.getAttribute('data-inline-voice-active')).toBe('true');

    // Robot cursor mounts inside .controls-input without polluting extracted text
    expect(input.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    // Stream live partials at cursor between 'hello' and ' world'
    voiceState.onResult?.('there', false);
    expect(readComposerElementText(input)).toBe('hello there world');
    expect(input.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    voiceState.onResult?.('there my friend', false);
    expect(readComposerElementText(input)).toBe('hello there my friend world');

    // Sending via Enter stops recognition cleanly and sends clean text without robot residue
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(voiceState.stopListening).toHaveBeenCalledWith({ abort: true });
    });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();
    expect(micBtn.classList.contains('btn-voice-inline-active')).toBe(false);
  });

  it('works identically in narrow / iPhone-compat Mac windows (stays contenteditable, keeps embedded mic button, no VoiceOverlay)', async () => {
    const { container, input } = renderComposer(390);
    // Must not lock contenteditable into touch-hold read-only mode on Mac
    expect(input.getAttribute('contenteditable')).toBe('true');

    setComposerTextAndCaret(input, 'prefix ', 7);
    fireEvent.input(input);

    const embeddedMic = container.querySelector('.btn-voice-embedded') as HTMLButtonElement;
    expect(embeddedMic).not.toBeNull();

    fireEvent.click(embeddedMic);
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.voice-overlay')).toBeNull();
    expect(embeddedMic.classList.contains('btn-voice-inline-active')).toBe(true);

    voiceState.onResult?.('dictated', false);
    expect(readComposerElementText(input)).toBe('prefix dictated');
    expect(input.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    // Clicking mic again toggles inline voice off and preserves text
    fireEvent.click(embeddedMic);
    expect(voiceState.stopListening).toHaveBeenCalledTimes(1);
    expect(readComposerElementText(input)).toBe('prefix dictated');
    expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();
    expect(embeddedMic.classList.contains('btn-voice-inline-active')).toBe(false);
  });

  it('interrupts recognition cleanly on manual typing or paste while keeping recognized text and user edits', async () => {
    const { container, input } = renderComposer(1200);
    input.focus();
    setComposerTextAndCaret(input, 'start', 5);

    doubleTapShift();
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);
    voiceState.onResult?.('spoken', false);
    expect(readComposerElementText(input)).toBe('start spoken');
    expect(input.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    // Simulate user typing a character manually right after spoken text
    const firstText = input.firstChild as Text;
    firstText.data = 'start spoken!';
    fireEvent.input(input);

    expect(voiceState.stopListening).toHaveBeenCalledWith({ abort: true });
    expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();
    expect(container.querySelector('.btn-voice-inline-active')).toBeNull();
    expect(readComposerElementText(input)).toBe('start spoken!');

    // Any stale late voice callback must NOT overwrite user edit
    voiceState.onResult?.('stale overwrite', false);
    expect(readComposerElementText(input)).toBe('start spoken!');
  });

  it('second double-tap stops recognition and sends when non-empty, or stops without sending when empty', () => {
    const { input, onSend } = renderComposer(1200);
    input.focus();

    // 1st double-tap Shift starts recognition on empty composer
    doubleTapShift();
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);

    // 2nd double-tap Shift when empty -> stops without sending
    doubleTapShift();
    expect(voiceState.stopListening).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    // Start again, dictate non-empty text, then 2nd double-tap -> stops AND submits
    doubleTapShift();
    expect(voiceState.startListening).toHaveBeenCalledTimes(2);
    voiceState.onResult?.('ship it', false);
    expect(readComposerElementText(input)).toBe('ship it');

    doubleTapShift();
    expect(voiceState.stopListening).toHaveBeenCalledTimes(2);
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();
  });

  it('preserves standard VoiceOverlay and disables double-tap shortcut outside native Mac app', () => {
    platformState.macDesktop = false;
    const { container } = renderComposer(1200);

    doubleTapShift();
    expect(voiceState.startListening).not.toHaveBeenCalled();

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    fireEvent.click(micBtn);
    expect(document.body.querySelector('.voice-overlay')).not.toBeNull();
  });

  it('drives the surround waveform level on VoiceStreamingRobot from VoiceInput.onAudioLevel and clears it on stop', async () => {
    const { container, input } = renderComposer(1200);
    input.focus();

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    fireEvent.click(micBtn);

    expect(voiceState.onAudioLevel).toHaveBeenCalledTimes(1);
    expect(voiceState.onLevel).toBeTypeOf('function');

    const cursor = input.querySelector('.voice-streaming-robot-cursor') as HTMLElement;
    expect(cursor).not.toBeNull();
    expect(cursor.textContent).toBe('');
    expect(cursor.classList.contains('has-level')).toBe(false);
    expect(cursor.style.getPropertyValue('--voice-robot-level')).toBe('0.000');

    voiceState.onLevel?.(0.72);
    await waitFor(() => {
      const updated = input.querySelector('.voice-streaming-robot-cursor') as HTMLElement;
      expect(updated.classList.contains('has-level')).toBe(true);
      expect(updated.style.getPropertyValue('--voice-robot-level')).toBe('0.720');
      expect(readComposerElementText(input)).toBe('');
    });

    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(voiceState.onLevel).toBeNull();
      expect(voiceState.onAudioLevel).toHaveBeenLastCalledWith(null);
      expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();
    });
  });

  it('applies partial/final results emitted during stopInlineVoice({ abort: false }) drain and ignores callbacks after drain or abort or restart', async () => {
    let resolveStop!: () => void;
    voiceState.stopListening.mockImplementation(() => new Promise<void>((resolve) => {
      resolveStop = resolve;
    }));

    const { container, input } = renderComposer(1200);
    input.focus();
    setComposerTextAndCaret(input, 'prefix ', 7);

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    fireEvent.click(micBtn);
    expect(voiceState.startListening).toHaveBeenCalledTimes(1);

    const firstOnResult = voiceState.onResult!;
    firstOnResult('partial', false);
    expect(readComposerElementText(input)).toBe('prefix partial');
    expect(input.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    // Stop without abort: UI stops immediately, robot cursor detaches, but drained results still apply until stop settles
    fireEvent.click(micBtn);
    expect(voiceState.stopListening).toHaveBeenCalledWith({ abort: false });
    expect(micBtn.classList.contains('btn-voice-inline-active')).toBe(false);
    expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();

    firstOnResult('partial final tail', true);
    expect(readComposerElementText(input)).toBe('prefix partial final tail');
    expect(input.querySelector('.voice-streaming-robot-cursor')).toBeNull();

    resolveStop();
    await Promise.resolve();
    await Promise.resolve();

    // Once drain settles, late stale callbacks must be ignored
    firstOnResult('too late', true);
    expect(readComposerElementText(input)).toBe('prefix partial final tail');

    // Boundary: starting a new inline session while previous stop is still draining invalidates the old token immediately
    let resolveDrain2!: () => void;
    voiceState.stopListening.mockImplementation(() => new Promise<void>((resolve) => {
      resolveDrain2 = resolve;
    }));
    fireEvent.click(micBtn);
    const oldSessionCallback = voiceState.onResult!;
    oldSessionCallback('round two', false);
    fireEvent.click(micBtn); // draining round two (abort: false)

    // Immediately start round three before round two finishes draining
    fireEvent.click(micBtn);
    const newSessionCallback = voiceState.onResult!;
    oldSessionCallback('stale from draining round two', true);
    expect(readComposerElementText(input)).not.toContain('stale from draining round two');

    newSessionCallback('round three', false);
    expect(readComposerElementText(input)).toContain('round three');
    resolveDrain2();

    // Abort (Enter/send): discards any late callback immediately without waiting for drain
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    await waitFor(() => {
      expect(voiceState.stopListening).toHaveBeenLastCalledWith({ abort: true });
    });
    newSessionCallback('dropped after abort', true);
    expect(readComposerElementText(input)).toBe('');
  });
});
