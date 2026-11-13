/**
 * @vitest-environment jsdom
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';

const voiceMock = vi.hoisted(() => ({
  partialHandler: null as ((partial: string) => void) | null,
  listeningHandler: null as ((listening: boolean) => void) | null,
  errorHandler: null as ((error: string) => void) | null,
  levelHandler: null as ((level: number) => void) | null,
  isAvailable: vi.fn(() => true),
  startListening: vi.fn(),
  stopListening: vi.fn(),
  onAudioLevel: vi.fn(),
}));

const overlaySpy = vi.hoisted(() => ({
  lastProps: null as Record<string, any> | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('../../src/components/VoiceOverlay.js', () => ({
  VoiceOverlay: (props: Record<string, any>) => {
    overlaySpy.lastProps = props;
    if (!props.open) return null;
    return (
      <div
        class="mock-voice-overlay"
        data-initial-text={props.initialText ?? ''}
        data-auto-start={String(props.autoStartListening ?? true)}
      />
    );
  },
}));

vi.mock('../../src/components/VoiceInput.js', () => ({
  isAvailable: () => voiceMock.isAvailable(),
  startListening: (...args: unknown[]) => voiceMock.startListening(...args),
  stopListening: (...args: unknown[]) => voiceMock.stopListening(...args),
  onAudioLevel: (cb: ((level: number) => void) | null) => {
    voiceMock.levelHandler = cb;
    voiceMock.onAudioLevel(cb);
  },
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
  addCommand: vi.fn(),
  addPhrase: vi.fn(),
  removeCommand: vi.fn(),
  removePhrase: vi.fn(),
  removeHistory: vi.fn(),
  removeSessionHistory: vi.fn(),
  clearHistory: vi.fn(),
  clearSessionHistory: vi.fn(),
});

function dispatchPointer(el: Element, type: string, clientX: number, clientY = 500, pointerId = 1): boolean {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX, clientY, pointerId, button: 0 });
  return fireEvent(el, event);
}

describe('Mobile composer hold-to-talk & 3-zone gesture HUD', () => {
  const vibrate = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
    vibrate.mockReset();
    overlaySpy.lastProps = null;
    voiceMock.partialHandler = null;
    voiceMock.listeningHandler = null;
    voiceMock.errorHandler = null;
    voiceMock.levelHandler = null;
    voiceMock.isAvailable.mockReturnValue(true);
    voiceMock.startListening.mockReset().mockImplementation(async (
      onResult: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      voiceMock.partialHandler = onResult;
      voiceMock.listeningHandler = onListeningChange ?? null;
      voiceMock.errorHandler = onError ?? null;
      onListeningChange?.(true);
      return true;
    });
    voiceMock.stopListening.mockReset().mockResolvedValue(undefined);
    voiceMock.onAudioLevel.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('short tap (<240ms) focuses composer input for keyboard typing without starting voice recording', async () => {
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
    const composer = document.querySelector('.controls-composer') as HTMLElement;
    expect(document.activeElement).not.toBe(input);

    // Must not call preventDefault on pointerdown so iOS/Android tap-to-open-IME still fires natively.
    expect(dispatchPointer(input, 'pointerdown', 180)).toBe(true);
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(true);
    expect(input.style.userSelect).toBe('none');
    expect(input.getAttribute('contenteditable')).toBe('true');

    await vi.advanceTimersByTimeAsync(120);
    dispatchPointer(input, 'pointerup', 180);

    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(false);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.style.userSelect).toBe('');
  });

  it('shields composer focus from stale compatibility mousedown after a touch short tap while allowing genuine subsequent taps', async () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    render(
      <div>
        <div class="chat-view" tabIndex={-1}>messages</div>
        <SessionControls
          ws={ws}
          activeSession={makeSession()}
          quickData={makeQuickData()}
          sessions={[]}
          subSessions={[]}
          serverId="srv-1"
        />
      </div>,
    );

    const chatView = document.querySelector('.chat-view') as HTMLElement;
    const input = document.querySelector('.controls-input') as HTMLElement;

    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(down, { clientX: 180, clientY: 500, pointerId: 1, button: 0, pointerType: 'touch' });
    fireEvent(input, down);

    await vi.advanceTimersByTimeAsync(80);

    const up = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.assign(up, { clientX: 180, clientY: 500, pointerId: 1, button: 0, pointerType: 'touch' });
    fireEvent(input, up);
    expect(document.activeElement).toBe(input);

    // Delayed compatibility mousedown landing on sibling .chat-view after layout expansion is prevented
    const compatDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    expect(fireEvent(chatView, compatDown)).toBe(false);
    expect(compatDown.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);

    // Positive control: a fresh genuine interaction (pointerdown before mousedown) disarms the shield
    const secondDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(secondDown, { clientX: 180, clientY: 500, pointerId: 2, button: 0, pointerType: 'touch' });
    fireEvent(input, secondDown);
    await vi.advanceTimersByTimeAsync(80);
    input.blur();
    const secondUp = new Event('pointerup', { bubbles: true, cancelable: true });
    Object.assign(secondUp, { clientX: 180, clientY: 500, pointerId: 2, button: 0, pointerType: 'touch' });
    fireEvent(input, secondUp);

    const nextTapPointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(nextTapPointerDown, { clientX: 100, clientY: 100, pointerId: 3, button: 0, pointerType: 'touch' });
    fireEvent(chatView, nextTapPointerDown);
    const genuineMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    expect(fireEvent(chatView, genuineMouseDown)).toBe(true);
    expect(genuineMouseDown.defaultPrevented).toBe(false);
  });

  it('holds 240ms -> vibrates & suppresses iOS loupe/keyboard -> shows 3-zone sci-fi HUD with SVG arrows -> releases in center to auto-send', async () => {
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
    const composer = document.querySelector('.controls-composer') as HTMLElement;
    dispatchPointer(input, 'pointerdown', 180);

    // Not triggered at 239ms; still pending with selection/callout lock
    await vi.advanceTimersByTimeAsync(239);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(true);
    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(false);

    // Triggers exactly at 240ms (+1ms)
    await vi.advanceTimersByTimeAsync(1);

    expect(vibrate).toHaveBeenCalledWith(20);
    expect(document.activeElement).not.toBe(input);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(false);
    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(true);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // HUD shows all 3 gesture prompts, recognizing status, sci-fi grid, status dot, and SVG arrows
    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud).not.toBeNull();
    expect(hud.getAttribute('data-zone')).toBe('send');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('0px');
    expect(hud.querySelector('.voice-hold-hud-grid')).not.toBeNull();
    expect(hud.querySelector('.voice-status-dot.voice-status-dot-active')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-zone-cancel svg')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-zone-edit svg')).not.toBeNull();
    expect(hud.textContent).toContain('voice.slide_left_cancel');
    expect(hud.textContent).toContain('voice.release_to_send');
    expect(hud.textContent).toContain('voice.slide_right_edit');
    expect(hud.textContent).toContain('voice.recognizing');
    expect(hud.textContent).toContain('voice.buffering_hint');

    voiceMock.levelHandler?.(0.4);
    voiceMock.partialHandler?.('你好 IM.codes');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud-transcript')?.textContent).toBe('你好 IM.codes');

    // Release in center zone drains stopListening and sends immediately, restoring contenteditable
    voiceMock.stopListening.mockImplementationOnce(async () => {
      voiceMock.partialHandler?.('你好 IM.codes 最终');
    });
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: '你好 IM.codes 最终',
    }));
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(false);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.style.userSelect).toBe('');
  });

  it('holds 240ms -> slides left into cancel zone -> highlights red & discards recording on release', async () => {
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
    dispatchPointer(input, 'pointerdown', 200);
    await vi.advanceTimersByTimeAsync(240);

    voiceMock.partialHandler?.('誤って話した内容');
    dispatchPointer(input, 'pointermove', 130); // dx = -70 <= -44 (left cancel zone)
    await vi.advanceTimersByTimeAsync(0);

    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud.getAttribute('data-zone')).toBe('cancel');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('-70px');
    expect(document.querySelector('.voice-hold-zone-cancel')?.classList.contains('is-active')).toBe(true);
    expect(document.querySelector('.voice-hold-hud-active-hint')?.textContent).toBe('voice.release_to_cancel');

    dispatchPointer(input, 'pointerup', 130);
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(document.querySelector('.mock-voice-overlay')).toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('true');
  });

  it('holds 240ms -> slides right into edit zone -> highlights blue & opens VoiceOverlay in edit mode on release', async () => {
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
    dispatchPointer(input, 'pointerdown', 160);
    await vi.advanceTimersByTimeAsync(240);

    voiceMock.partialHandler?.('需要二次修改的文字');
    dispatchPointer(input, 'pointermove', 230); // dx = +70 >= +44 (right edit zone)
    await vi.advanceTimersByTimeAsync(0);

    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud.getAttribute('data-zone')).toBe('edit');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('70px');
    expect(document.querySelector('.voice-hold-zone-edit')?.classList.contains('is-active')).toBe(true);
    expect(document.querySelector('.voice-hold-hud-active-hint')?.textContent).toBe('voice.release_to_edit');

    dispatchPointer(input, 'pointerup', 230);
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    const overlay = document.querySelector('.mock-voice-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('data-initial-text')).toBe('需要二次修改的文字');
    expect(overlay.getAttribute('data-auto-start')).toBe('false');
    expect(input.getAttribute('contenteditable')).toBe('true');
  });

  it('failed microphone start shows localized error banner and never sends existing unsent draft on release', async () => {
    voiceMock.startListening.mockImplementation(async (_r, _l, onError) => {
      onError?.('permission_denied');
      return false;
    });
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
    input.textContent = 'existing unsent draft';
    fireEvent.input(input);

    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-error-banner')?.textContent).toContain('voice.mic_permission_failed');
    expect(input.textContent).toBe('existing unsent draft');
  });

  it('a new hold while stopListening is draining cannot discard or overwrite the prior hold final tail', async () => {
    let releaseDrain!: () => void;
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
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);

    const firstResult = voiceMock.partialHandler!;
    firstResult('first partial');
    voiceMock.stopListening.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { releaseDrain = r; });
      firstResult('first final tail');
    });

    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    // Attempt another hold while the first stop is still draining
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);

    releaseDrain();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'first final tail',
    }));
  });

  it('unmount invalidates a pending stop drain instead of sending after leaving the composer', async () => {
    let releaseDrain!: () => void;
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const view = render(
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
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    voiceMock.partialHandler?.('do not send after leaving');
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseDrain = r; }));

    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    view.unmount();
    releaseDrain();
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('releasing during pending native start requests stop without waiting for the start promise', async () => {
    let release!: (ok: boolean) => void;
    voiceMock.startListening.mockImplementationOnce(() => new Promise<boolean>((r) => { release = r; }));
    voiceMock.stopListening.mockImplementationOnce(async () => {
      release(false);
    });
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
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    try {
      expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    } finally {
      release(false);
      await vi.advanceTimersByTimeAsync(0);
    }

    // Subsequent hold after aborted pending start still works cleanly
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(2);
  });

  it('failed start followed by cancel movement releases the transaction so a new hold can start', async () => {
    voiceMock.startListening.mockResolvedValueOnce(false);
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
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    dispatchPointer(input, 'pointermove', 90);
    dispatchPointer(input, 'pointerup', 90);
    await vi.advanceTimersByTimeAsync(0);

    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);

    expect(voiceMock.startListening).toHaveBeenCalledTimes(2);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
  });

  it('runtime recognitionError joins stopListening drain before releasing hold transaction so retry release never leaves microphone active', async () => {
    let releaseOldStop!: () => void;
    const oldStop = new Promise<void>((r) => { releaseOldStop = r; });
    let activeListening = false;
    voiceMock.startListening.mockImplementation(async (
      onResult: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      voiceMock.partialHandler = onResult;
      voiceMock.listeningHandler = onListeningChange ?? null;
      voiceMock.errorHandler = onError ?? null;
      activeListening = true;
      onListeningChange?.(true);
      return true;
    });
    voiceMock.stopListening
      .mockImplementationOnce(async () => {
        await oldStop;
        activeListening = false;
      })
      .mockImplementation(async () => {
        activeListening = false;
      });

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
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);

    // Runtime error during active hold triggers failTransaction -> finalizeVoiceHold('failed')
    voiceMock.errorHandler?.('decoder interrupted');
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);

    // Retry hold and release while old stop ACK is still draining
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    releaseOldStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(activeListening).toBe(false);

    // After old error drain completes, a fresh hold can start and stop cleanly
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(2);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(activeListening).toBe(false);
  });

  it('uses mobile voice hold placeholder and controls-composer-voice-ready only when mobile + connected + VoiceInput available', () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const { rerender } = render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );

    const mobileInput = document.querySelector('.controls-input') as HTMLElement;
    const mobileComposer = document.querySelector('.controls-composer') as HTMLElement;
    expect(mobileInput.getAttribute('data-placeholder')).toBe('session.send_placeholder_mobile_voice');
    expect(mobileComposer.classList.contains('controls-composer-voice-ready')).toBe(true);

    // Non-voice mobile fallback keeps session.send_placeholder and omits voice-ready
    voiceMock.isAvailable.mockReturnValue(false);
    rerender(
      <SessionControls
        ws={{ ...ws, connected: true }}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('session.send_placeholder');
    expect(document.querySelector('.controls-composer')?.classList.contains('controls-composer-voice-ready')).toBe(false);

    // Disconnected mobile shows send_queued and omits voice-ready
    voiceMock.isAvailable.mockReturnValue(true);
    rerender(
      <SessionControls
        ws={{ ...ws, connected: false }}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );
    expect(document.querySelector('.controls-input')?.getAttribute('data-placeholder')).toBe('session.send_queued');
    expect(document.querySelector('.controls-composer')?.classList.contains('controls-composer-voice-ready')).toBe(false);

    // Desktop layout keeps desktop shortcuts placeholder and never marks voice-ready or starts 240ms voice hold
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    rerender(
      <SessionControls
        ws={{ ...ws, connected: true }}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );
    const desktopInput = document.querySelector('.controls-input') as HTMLElement;
    expect(desktopInput.getAttribute('data-placeholder')).toBe('session.send_placeholder_desktop_shortcuts');
    expect(document.querySelector('.controls-composer')?.classList.contains('controls-composer-voice-ready')).toBe(false);
    dispatchPointer(desktopInput, 'pointerdown', 180);
    vi.advanceTimersByTime(300);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
  });

  it('suppresses selectstart and contextmenu during pending/active hold and restores contenteditable/styles across fail, cancel, lostcapture, and unmount', async () => {
    const removeAllRanges = vi.fn();
    const origGetSelection = window.getSelection;
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({ removeAllRanges }),
    });
    try {
      const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
      const view = render(
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

      // Short tap: pending suppresses selectstart/contextmenu, then release cleanly re-enables them
      dispatchPointer(input, 'pointerdown', 180);
      const pendingSelect = new Event('selectstart', { bubbles: true, cancelable: true });
      const pendingMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      expect(fireEvent(input, pendingSelect)).toBe(false);
      expect(fireEvent(input, pendingMenu)).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      dispatchPointer(input, 'pointerup', 180);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(input.style.userSelect).toBe('');
      expect(fireEvent(input, new Event('selectstart', { bubbles: true, cancelable: true }))).toBe(true);
      expect(fireEvent(input, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true);

      // Failed mic start restores contenteditable="true" and clears inline userSelect
      voiceMock.startListening.mockResolvedValueOnce(false);
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(240);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(input.style.userSelect).toBe('');

      // Active hold suppresses selectstart/contextmenu & calls removeAllRanges, then pointercancel restores
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(240);
      expect(removeAllRanges).toHaveBeenCalled();
      expect(input.getAttribute('contenteditable')).toBe('false');
      expect(fireEvent(input, new Event('selectstart', { bubbles: true, cancelable: true }))).toBe(false);
      expect(fireEvent(input, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false);

      dispatchPointer(input, 'pointercancel', 180);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(input.style.userSelect).toBe('');

      // lostpointercapture during active hold cancels & restores
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(240);
      expect(input.getAttribute('contenteditable')).toBe('false');
      dispatchPointer(input, 'lostpointercapture', 180);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(input.style.userSelect).toBe('');

      // Unmount mid-drain restores contenteditable and inline userSelect on the composer element
      let releaseDrain!: () => void;
      voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseDrain = r; }));
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(240);
      dispatchPointer(input, 'pointerup', 180);
      await vi.advanceTimersByTimeAsync(0);
      view.unmount();
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(input.style.userSelect).toBe('');
      releaseDrain();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      Object.defineProperty(window, 'getSelection', { configurable: true, value: origGetSelection });
    }
  });

  it('tracks ±44px zone boundaries, clamps --voice-slide-x to ±84px, and auto-scrolls transcript on growth', async () => {
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
    dispatchPointer(input, 'pointerdown', 200);
    await vi.advanceTimersByTimeAsync(240);

    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    const transcript = document.querySelector('.voice-hold-hud-transcript') as HTMLElement;
    Object.defineProperty(transcript, 'scrollHeight', { configurable: true, value: 420 });

    voiceMock.partialHandler?.('Line 1\nLine 2\nLine 3\nLine 4\nLine 5');
    await vi.advanceTimersByTimeAsync(0);
    expect(transcript.scrollTop).toBe(420);

    // -43 stays in send zone, -44 flips to cancel, -150 clamps --voice-slide-x to -84px
    dispatchPointer(input, 'pointermove', 157);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-zone')).toBe('send');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('-43px');

    dispatchPointer(input, 'pointermove', 156);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-zone')).toBe('cancel');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('-44px');

    dispatchPointer(input, 'pointermove', 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-zone')).toBe('cancel');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('-84px');

    // +43 stays in send zone, +44 flips to edit, +180 clamps --voice-slide-x to 84px
    dispatchPointer(input, 'pointermove', 243);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-zone')).toBe('send');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('43px');

    dispatchPointer(input, 'pointermove', 244);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-zone')).toBe('edit');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('44px');

    dispatchPointer(input, 'pointermove', 380);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-zone')).toBe('edit');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('84px');

    dispatchPointer(input, 'pointerup', 380);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('provides non-empty mobile voice placeholder and clean slide zone labels across all 7 locales', () => {
    const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/i18n/locales');
    for (const locale of ['en', 'es', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW']) {
      const data = JSON.parse(readFileSync(resolve(localesDir, `${locale}.json`), 'utf8')) as {
        session: Record<string, string>;
        voice: Record<string, string>;
      };
      expect(typeof data.session.send_placeholder_mobile_voice).toBe('string');
      expect(data.session.send_placeholder_mobile_voice.trim().length).toBeGreaterThan(0);
      expect(data.voice.slide_left_cancel.trim().length).toBeGreaterThan(0);
      expect(data.voice.slide_right_edit.trim().length).toBeGreaterThan(0);
      expect(data.voice.slide_left_cancel).not.toContain('👈');
      expect(data.voice.slide_right_edit).not.toContain('👉');
    }
  });

  it('portals .voice-hold-hud directly to document.body outside .controls stacking context', async () => {
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const view = render(
      <div class="subcard">
        <div class="controls-wrapper">
          <SessionControls
            ws={ws}
            activeSession={makeSession()}
            quickData={makeQuickData()}
            sessions={[]}
            subSessions={[]}
            serverId="srv-1"
          />
        </div>
      </div>,
    );

    const input = view.container.querySelector('.controls-input') as HTMLElement;
    dispatchPointer(input, 'pointerdown', 200);
    await vi.advanceTimersByTimeAsync(240);

    const hud = document.body.querySelector(':scope > .voice-hold-hud') as HTMLElement | null;
    expect(hud).not.toBeNull();
    expect(hud?.parentElement).toBe(document.body);
    expect(view.container.querySelector('.controls .voice-hold-hud')).toBeNull();
    expect(view.container.querySelector('.voice-hold-hud')).toBeNull();

    dispatchPointer(input, 'pointermove', 50);
    await vi.advanceTimersByTimeAsync(0);
    dispatchPointer(input, 'pointerup', 50);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.body.querySelector('.voice-hold-hud')).toBeNull();
  });

  it('disables animations/transitions under prefers-reduced-motion, fits all 7 locales safely, and stacks above isolated session activity strips in chromium', { timeout: 60000 }, async () => {
    vi.useRealTimers();
    const require = createRequire(import.meta.url);
    const browserType = (require('playwright') as typeof import('playwright')).chromium;
    if (!existsSync(browserType.executablePath())) {
      return;
    }
    const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css');
    const css = readFileSync(stylesPath, 'utf8');
    const localesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/i18n/locales');
    const locales = ['en', 'es', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW'].map((code) => ({
      code,
      json: JSON.parse(readFileSync(resolve(localesDir, `${code}.json`), 'utf8')) as { voice: Record<string, string> },
    }));
    const barsHtml = Array.from({ length: 16 }, () => '<span class="voice-hold-hud-bar" style="height: 16px; opacity: 0.8"></span>').join('');
    const longText = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: holding to dictate long technical text across multiple lines on iOS mobile viewport.`).join('\n');

    const browser = await browserType.launch({ headless: true });
    try {
      for (const reducedMotion of ['reduce', 'no-preference'] as const) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
        const page = await context.newPage();
        try {
          await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
            <div class="controls-composer controls-composer-voice-ready controls-composer-voice-pending controls-composer-voice-holding">
              <div class="controls-input"></div>
            </div>
            <button class="btn-voice btn-voice-active"></button>
            <div class="voice-hold-hud voice-hold-hud-zone-send">
              <div class="voice-hold-hud-card">
                <div class="voice-hold-hud-grid"></div>
                <div class="voice-hold-hud-header">
                  <span class="voice-hold-hud-recognizing is-recognizing">
                    <span class="voice-status-dot voice-status-dot-active voice-status-dot-recognizing"></span>
                    <span class="voice-recognizing-dots"><i></i><i></i><i></i></span>
                    <span>Listening</span>
                  </span>
                  <div class="voice-hold-hud-waveform">${barsHtml}</div>
                </div>
                <div class="voice-hold-hud-transcript">Hello</div>
                <div class="voice-hold-hud-active-hint is-send">Hint</div>
                <div class="voice-hold-hud-zones">
                  <div class="voice-hold-zone voice-hold-zone-cancel"><span class="voice-hold-zone-label">Cancel</span></div>
                  <div class="voice-hold-zone voice-hold-zone-send is-active"><span class="voice-hold-zone-label">Send</span></div>
                  <div class="voice-hold-zone voice-hold-zone-edit"><span class="voice-hold-zone-label">Edit</span></div>
                </div>
              </div>
            </div>
          </body></html>`);

          for (const zone of ['send', 'cancel', 'edit'] as const) {
            const computed = await page.evaluate((z) => {
              const hud = document.querySelector('.voice-hold-hud')!;
              hud.className = `voice-hold-hud voice-hold-hud-zone-${z}`;
              const hint = document.querySelector('.voice-hold-hud-active-hint')!;
              hint.className = `voice-hold-hud-active-hint is-${z}`;
              for (const k of ['cancel', 'send', 'edit']) {
                document.querySelector(`.voice-hold-zone-${k}`)!.classList.toggle('is-active', k === z);
              }
              const gs = (sel: string, pseudo?: string) => getComputedStyle(document.querySelector(sel)!, pseudo);
              return {
                composerReadyAfter: gs('.controls-composer-voice-ready', '::after').animationName,
                composerInput: gs('.controls-composer-voice-holding .controls-input').animationName,
                btnVoiceActive: gs('.btn-voice-active').animationName,
                hudCardBefore: gs('.voice-hold-hud-card', '::before').animationName,
                hudGrid: gs('.voice-hold-hud-grid').animationName,
                dotActive: gs('.voice-status-dot-active').animationName,
                recDot: gs('.voice-recognizing-dots i').animationName,
                dotTrans: gs('.voice-status-dot').transitionProperty,
                hintTrans: gs('.voice-hold-hud-active-hint').transitionProperty,
                zoneTrans: gs('.voice-hold-zone').transitionProperty,
              };
            }, zone);

            if (reducedMotion === 'reduce') {
              expect(computed.composerReadyAfter).toBe('none');
              expect(computed.composerInput).toBe('none');
              expect(computed.btnVoiceActive).toBe('none');
              expect(computed.hudCardBefore).toBe('none');
              expect(computed.hudGrid).toBe('none');
              expect(computed.dotActive).toBe('none');
              expect(computed.recDot).toBe('none');
              expect(computed.dotTrans).toBe('none');
              expect(computed.hintTrans).toBe('none');
              expect(computed.zoneTrans).toBe('none');
            } else {
              expect(computed.composerReadyAfter).toBe('voice-editor-orbit');
              expect(computed.composerInput).toBe('voice-composer-energy-pulse');
              expect(computed.hudCardBefore).toBe('voice-editor-orbit');
              expect(computed.hudGrid).toBe('voice-grid-scroll');
              expect(computed.dotActive).toBe('voice-dot-pulse');
              expect(computed.recDot).toBe('voice-recognizing-bounce');
            }
          }
        } finally {
          await context.close();
        }
      }

      const viewports = [
        { width: 320, height: 568, sat: 0, sab: 0 },
        { width: 430, height: 932, sat: 59, sab: 34 },
      ];
      for (const vp of viewports) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });
        const page = await context.newPage();
        try {
          await page.setContent(`<!doctype html><html style="--sat:${vp.sat}px;--sab:${vp.sab}px;"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
            <div class="subcard" style="isolation:isolate;position:relative;z-index:1;height:100vh;">
              <div class="controls-wrapper" style="position:fixed;bottom:0;left:0;right:0;z-index:13;">
                <span class="session-live-status-inline working" style="position:fixed;left:0;right:0;bottom:140px;height:44px;z-index:999999;">Running command</span>
              </div>
            </div>
            <div class="voice-hold-hud voice-hold-hud-zone-send">
              <div class="voice-hold-hud-card">
                <div class="voice-hold-hud-grid"></div>
                <div class="voice-hold-hud-header">
                  <span class="voice-hold-hud-recognizing is-recognizing">
                    <span class="voice-status-dot voice-status-dot-active voice-status-dot-recognizing"></span>
                    <span class="voice-recognizing-dots"><i></i><i></i><i></i></span>
                    <span class="test-rec-label"></span>
                  </span>
                  <div class="voice-hold-hud-waveform">${barsHtml}</div>
                </div>
                <div class="voice-hold-hud-transcript"></div>
                <div class="voice-hold-hud-active-hint is-send"></div>
                <div class="voice-hold-hud-zones">
                  <div class="voice-hold-zone voice-hold-zone-cancel">
                    <svg class="voice-hold-zone-arrow" viewBox="0 0 24 24" width="20" height="20"><path d="M19 12H5"/></svg>
                    <span class="voice-hold-zone-label test-cancel-label"></span>
                  </div>
                  <div class="voice-hold-zone voice-hold-zone-send is-active">
                    <span class="voice-hold-zone-label test-send-label"></span>
                  </div>
                  <div class="voice-hold-zone voice-hold-zone-edit">
                    <span class="voice-hold-zone-label test-edit-label"></span>
                    <svg class="voice-hold-zone-arrow" viewBox="0 0 24 24" width="20" height="20"><path d="M5 12h14"/></svg>
                  </div>
                </div>
              </div>
            </div>
          </body></html>`);

          for (const { code, json } of locales) {
            const v = json.voice;
            for (const zone of ['send', 'cancel', 'edit'] as const) {
              const activeHint = zone === 'cancel' ? v.release_to_cancel : zone === 'edit' ? v.release_to_edit : v.release_to_send;
              for (const [mode, textVal] of [['short', 'Hello'], ['long', longText]] as const) {
                const m = await page.evaluate(({ zone: z, recLabel, textVal: tv, activeHint: ah, cancelLabel, sendLabel, editLabel }) => {
                  const hudEl = document.querySelector('.voice-hold-hud')!;
                  hudEl.className = `voice-hold-hud voice-hold-hud-zone-${z}`;
                  document.querySelector('.test-rec-label')!.textContent = recLabel;
                  const trEl = document.querySelector('.voice-hold-hud-transcript')!;
                  trEl.textContent = tv;
                  const hintEl = document.querySelector('.voice-hold-hud-active-hint')!;
                  hintEl.className = `voice-hold-hud-active-hint is-${z}`;
                  hintEl.textContent = ah;
                  document.querySelector('.test-cancel-label')!.textContent = cancelLabel;
                  document.querySelector('.test-send-label')!.textContent = sendLabel;
                  document.querySelector('.test-edit-label')!.textContent = editLabel;
                  for (const k of ['cancel', 'send', 'edit']) {
                    document.querySelector(`.voice-hold-zone-${k}`)!.classList.toggle('is-active', k === z);
                  }
                  const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
                  const card = r('.voice-hold-hud-card');
                  const header = r('.voice-hold-hud-header');
                  const transcript = r('.voice-hold-hud-transcript');
                  const hint = r('.voice-hold-hud-active-hint');
                  const zones = r('.voice-hold-hud-zones');
                  const strip = r('.session-live-status-inline');
                  const stripMidX = strip.left + strip.width / 2;
                  const stripMidY = strip.top + strip.height / 2;
                  const prevPe = (hudEl as HTMLElement).style.pointerEvents;
                  (hudEl as HTMLElement).style.pointerEvents = 'auto';
                  const topAtStrip = document.elementFromPoint(stripMidX, stripMidY);
                  (hudEl as HTMLElement).style.pointerEvents = prevPe;
                  return {
                    hudZ: getComputedStyle(hudEl).zIndex,
                    cardTop: Math.round(card.top),
                    cardBottom: Math.round(card.bottom),
                    headerTop: Math.round(header.top),
                    zonesBottom: Math.round(zones.bottom),
                    hintBottom: Math.round(hint.bottom),
                    transcriptH: Math.round(transcript.height),
                    transcriptScrollH: trEl.scrollHeight,
                    transcriptClientH: trEl.clientHeight,
                    scrollOverflow: document.documentElement.scrollWidth > window.innerWidth,
                    hudCoversStrip: card.top <= stripMidY && card.bottom >= stripMidY ? Boolean(topAtStrip?.closest('.voice-hold-hud')) : true,
                  };
                }, {
                  zone,
                  recLabel: v.recognizing,
                  textVal,
                  activeHint,
                  cancelLabel: v.slide_left_cancel,
                  sendLabel: v.release_to_send,
                  editLabel: v.slide_right_edit,
                });

                expect(m.hudZ, `${code}/${zone}/${mode} z-index`).toBe('2147483642');
                expect(m.hudCoversStrip, `${code}/${zone}/${mode} covered by live strip`).toBe(true);
                expect(m.cardTop, `${code}/${zone}/${mode} cardTop`).toBeGreaterThanOrEqual(15 + vp.sat);
                expect(m.cardBottom, `${code}/${zone}/${mode} cardBottom`).toBeLessThanOrEqual(vp.height - 67 - vp.sab);
                expect(m.headerTop, `${code}/${zone}/${mode} headerTop`).toBeGreaterThanOrEqual(m.cardTop);
                expect(m.zonesBottom, `${code}/${zone}/${mode} zonesBottom`).toBeLessThanOrEqual(m.cardBottom);
                expect(m.hintBottom, `${code}/${zone}/${mode} hintBottom`).toBeLessThanOrEqual(m.cardBottom);
                expect(m.scrollOverflow, `${code}/${zone}/${mode} overflow`).toBe(false);
                if (mode === 'long') {
                  expect(m.transcriptScrollH, `${code}/${zone}/long scrollable`).toBeGreaterThan(m.transcriptClientH);
                } else {
                  expect(m.transcriptH, `${code}/${zone}/short transcriptH`).toBeGreaterThanOrEqual(88);
                }
              }
            }
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
});
