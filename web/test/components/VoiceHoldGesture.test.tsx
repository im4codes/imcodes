/**
 * @vitest-environment jsdom
 */
import { execFileSync } from 'node:child_process';
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
  prewarm: vi.fn(async () => {}),
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
  prewarm: (...args: unknown[]) => voiceMock.prewarm(...args),
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
import { focusComposerElement } from '../../src/util/composer-focus.js';
import type { SessionInfo } from '../../src/types.js';

/** jsdom 28 drops non-standard `-webkit-user-modify` from `cssstyle`, keeping only `style.webkitUserModify`. */
function readInlineWebkitUserModify(el: HTMLElement): string {
  const style = el.style as CSSStyleDeclaration & { webkitUserModify?: string };
  return style.getPropertyValue('-webkit-user-modify') || style.webkitUserModify || '';
}

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
    voiceMock.prewarm.mockReset().mockResolvedValue(undefined);
    voiceMock.onAudioLevel.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('short tap (<240ms, both quick <50ms and realistic 140ms mobile tap, unfocused and focused) focuses composer input for keyboard typing without starting voice recording', async () => {
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

    // Unfocused mobile voice-ready input starts contenteditable="false" to block iOS UIKit magnifying loupe.
    expect(input.getAttribute('contenteditable')).toBe('false');
    // Must not call preventDefault on pointerdown so iOS/Android tap-to-open-IME still fires natively.
    expect(dispatchPointer(input, 'pointerdown', 180)).toBe(true);
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(true);
    expect(input.style.userSelect).toBe('none');
    expect(input.getAttribute('contenteditable')).toBe('false');

    // Quick <50ms tap focuses composer cleanly without triggering voice capture.
    await vi.advanceTimersByTimeAsync(25);
    dispatchPointer(input, 'pointerup', 180);

    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(false);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.style.userSelect).toBe('');

    // Already-focused 140ms mobile tap keeps editable focus & never triggers voice capture.
    expect(dispatchPointer(input, 'pointerdown', 180, 500, 2)).toBe(true);
    await vi.advanceTimersByTimeAsync(140);
    dispatchPointer(input, 'pointerup', 180, 500, 2);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.style.userSelect).toBe('');

    // Blurring returns unfocused mobile voice-ready composer to contenteditable="false".
    fireEvent.blur(input);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // Realistic 140ms mobile single tap on unfocused composer opens typing mode cleanly without false-triggering voice.
    expect(dispatchPointer(input, 'pointerdown', 180, 500, 3)).toBe(true);
    await vi.advanceTimersByTimeAsync(140);
    dispatchPointer(input, 'pointerup', 180, 500, 3);
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

    await vi.advanceTimersByTimeAsync(25);

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
    await vi.advanceTimersByTimeAsync(25);
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

  it('holds 240ms -> vibrates & suppresses iOS loupe/keyboard -> shows borderless diffused aurora HUD with 28 waveform capsules -> releases in center to auto-send', async () => {
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
    expect(voiceMock.prewarm).toHaveBeenCalledWith({ requestPermission: false });
    dispatchPointer(input, 'pointerdown', 180);

    // Not triggered at 174ms; still pending with selection/callout lock (keeps <=140ms taps safe)
    await vi.advanceTimersByTimeAsync(174);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(true);
    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(false);

    // Triggers exactly at 175ms (+1ms) on unfocused composer
    await vi.advanceTimersByTimeAsync(1);

    expect(vibrate).toHaveBeenCalledWith(20);
    expect(document.activeElement).not.toBe(input);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    expect(composer.classList.contains('controls-composer-voice-pending')).toBe(false);
    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(true);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // HUD shows borderless diffused atmosphere + aurora layers + 28 waveform capsules + 3 borderless zone cues (no SVG fan boxes)
    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud).not.toBeNull();
    expect(hud.getAttribute('data-zone')).toBe('send');
    expect(hud.style.getPropertyValue('--voice-slide-x')).toBe('0px');
    expect(hud.querySelector('.voice-hold-hud-atmosphere')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-hud-aurora')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-hud-aurora-core')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-hud-transcript-stage .voice-hold-hud-transcript')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-hud-card .voice-hold-hud-transcript')).toBeNull();
    expect(hud.querySelector('.voice-hold-hud-grid')).toBeNull();
    expect(hud.querySelector('.voice-hold-fan-svg')).toBeNull();
    expect(hud.querySelector('.voice-hold-fan-sector')).toBeNull();
    expect(hud.querySelector('.voice-status-dot.voice-status-dot-active')).not.toBeNull();
    expect(hud.querySelectorAll('.voice-hold-hud-waveform .voice-hold-hud-bar')).toHaveLength(28);
    expect(hud.querySelectorAll('.voice-hold-hud-zones [data-zone-target]')).toHaveLength(3);
    expect(hud.querySelector('.voice-hold-zone-cancel svg')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-zone-send svg')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-zone-edit svg')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-zone-send.is-active')).not.toBeNull();
    expect(hud.textContent).toContain('voice.slide_left_cancel');
    expect(hud.textContent).toContain('voice.release_to_send');
    expect(hud.textContent).toContain('voice.slide_right_edit');
    expect(hud.textContent).toContain('voice.listening');
    expect(hud.textContent).toContain('voice.speak_now');

    voiceMock.levelHandler?.(0.4);
    voiceMock.partialHandler?.('你好 IM.codes');
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.textContent).toContain('voice.recognizing');
    const transcriptEl = document.querySelector('.voice-hold-hud-transcript') as HTMLElement;
    expect(transcriptEl.textContent).toBe('你好 IM.codes');
    expect(transcriptEl.querySelector('.voice-streaming-robot-cursor')).not.toBeNull();

    // Release in center zone drains stopListening, animates drop-into-composer, and sends, returning unfocused composer to contenteditable="false"
    voiceMock.stopListening.mockImplementationOnce(async () => {
      voiceMock.partialHandler?.('你好 IM.codes 最终');
    });
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(300);

    expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: '你好 IM.codes 最终',
    }));
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(false);
    expect(input.getAttribute('contenteditable')).toBe('false');
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
    expect(input.getAttribute('contenteditable')).toBe('false');
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
    expect(input.getAttribute('contenteditable')).toBe('false');
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
    await vi.advanceTimersByTimeAsync(300);

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

    // Holding while focused after fallback stays native; blurring back enables subsequent hold cleanly
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(350);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(100);

    // Subsequent hold after aborted pending start still works cleanly once unfocused
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

    // Pre-recording failure focused composer; blur back to voice-ready before starting a new hold
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(100);

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

    // After old error drain completes and composer returns to unfocused voice-ready, a fresh hold can start and stop cleanly
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(100);
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

  it('suppresses selectstart and contextmenu during pending/active hold, ignores lostpointercapture via window tracking, and restores cleanly on pointercancel and unmount', async () => {
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

      // Short tap: pending suppresses selectstart/contextmenu and sets inline -webkit-user-modify: read-only, then release transitions to contenteditable="true" + focus and clears lock
      dispatchPointer(input, 'pointerdown', 180);
      expect(readInlineWebkitUserModify(input)).toBe('read-only');
      const pendingSelect = new Event('selectstart', { bubbles: true, cancelable: true });
      const pendingMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      expect(fireEvent(input, pendingSelect)).toBe(false);
      expect(fireEvent(input, pendingMenu)).toBe(false);

      await vi.advanceTimersByTimeAsync(25);
      dispatchPointer(input, 'pointerup', 180);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(input.style.userSelect).toBe('');
      expect(readInlineWebkitUserModify(input)).toBe('');
      expect(fireEvent(input, new Event('selectstart', { bubbles: true, cancelable: true }))).toBe(true);
      expect(fireEvent(input, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(true);
      fireEvent.blur(input);
      expect(input.getAttribute('contenteditable')).toBe('false');

      // Failed mic start clears inline lock, shows error, and guarantees click-to-type fallback (contenteditable="true" + focused)
      voiceMock.startListening.mockResolvedValueOnce(false);
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(175);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
      expect(input.style.userSelect).toBe('');
      expect(readInlineWebkitUserModify(input)).toBe('');
      fireEvent.blur(input);
      expect(input.getAttribute('contenteditable')).toBe('false');

      // Active hold suppresses selectstart/contextmenu, sets inline read-only, prevents touchmove pan, then pointercancel restores cleanly
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(175);
      expect(removeAllRanges).toHaveBeenCalled();
      expect(input.getAttribute('contenteditable')).toBe('false');
      expect(readInlineWebkitUserModify(input)).toBe('read-only');
      expect(fireEvent(input, new Event('selectstart', { bubbles: true, cancelable: true }))).toBe(false);
      expect(fireEvent(input, new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))).toBe(false);
      const activeTouchMove = new Event('touchmove', { bubbles: true, cancelable: true });
      window.dispatchEvent(activeTouchMove);
      expect(activeTouchMove.defaultPrevented).toBe(true);

      dispatchPointer(input, 'pointercancel', 180);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('false');
      expect(input.style.userSelect).toBe('');
      expect(readInlineWebkitUserModify(input)).toBe('');

      // lostpointercapture during active hold MUST NOT cancel; window pointermove + pointerup finish cleanly
      dispatchPointer(input, 'pointerdown', 180);
      await vi.advanceTimersByTimeAsync(240);
      expect(input.getAttribute('contenteditable')).toBe('false');
      expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
      const stopCallsBeforeLost = voiceMock.stopListening.mock.calls.length;
      dispatchPointer(input, 'lostpointercapture', 180);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
      expect(voiceMock.stopListening).toHaveBeenCalledTimes(stopCallsBeforeLost);

      voiceMock.partialHandler?.('Window slide text');
      const winMove = new Event('pointermove', { bubbles: true, cancelable: true });
      Object.assign(winMove, { clientX: 250, clientY: 500, pointerId: 1 });
      window.dispatchEvent(winMove);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-zone')).toBe('edit');

      const winUp = new Event('pointerup', { bubbles: true, cancelable: true });
      Object.assign(winUp, { clientX: 250, clientY: 500, pointerId: 1 });
      window.dispatchEvent(winUp);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.voice-hold-hud')).toBeNull();
      expect(document.querySelector('.mock-voice-overlay')?.getAttribute('data-initial-text')).toBe('Window slide text');
      // After release, window touchmove listener is cleaned up and no longer blocks scrolling.
      const idleTouchMove = new Event('touchmove', { bubbles: true, cancelable: true });
      window.dispatchEvent(idleTouchMove);
      expect(idleTouchMove.defaultPrevented).toBe(false);
    } finally {
      Object.defineProperty(window, 'getSelection', { configurable: true, value: origGetSelection });
    }
  });

  it('restores contenteditable and inline touch lock when unmounted mid-drain', async () => {
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
    let releaseDrain!: () => void;
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseDrain = r; }));
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(240);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);
    view.unmount();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.style.userSelect).toBe('');
    expect(readInlineWebkitUserModify(input)).toBe('');
    releaseDrain();
    await vi.advanceTimersByTimeAsync(0);
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
      expect(data.session.send_placeholder_mobile_voice).not.toContain('·');
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

  it('uses distinct emerald-green aurora palette for edit zone contrasting send (blue) and cancel (red)', () => {
    const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css');
    const css = readFileSync(stylesPath, 'utf8');
    const readRule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      expect(match, `missing CSS rule for ${selector}`).not.toBeNull();
      return match![1];
    };

    const atmosphere = readRule('.voice-hold-hud-zone-edit .voice-hold-hud-atmosphere');
    expect(atmosphere).toContain('rgba(6, 42, 28');
    expect(atmosphere).toContain('rgba(16, 118, 76');

    const aurora = readRule('.voice-hold-hud-zone-edit .voice-hold-hud-aurora');
    expect(aurora).toContain('rgba(16, 185, 129');
    expect(aurora).toContain('rgba(110, 231, 183');
    expect(aurora).not.toContain('99, 102, 241');
    expect(aurora).not.toContain('59, 130, 246');

    const auroraCore = readRule('.voice-hold-hud-zone-edit .voice-hold-hud-aurora-core');
    expect(auroraCore).toContain('rgba(52, 211, 153');

    const bar = readRule('.voice-hold-hud-zone-edit .voice-hold-hud-bar');
    expect(bar).toContain('rgba(110, 231, 183');

    const activeHint = readRule('.voice-hold-hud-active-hint.is-edit');
    expect(activeHint).toContain('#a7f3d0');

    const zoneEdit = readRule('.voice-hold-zone-edit');
    expect(zoneEdit).toContain('rgba(167, 243, 208');

    const zoneEditActive = readRule('.voice-hold-zone-edit.is-active');
    expect(zoneEditActive).toContain('rgba(16, 185, 129');
    expect(zoneEditActive).toContain('rgba(52, 211, 153');
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
    const barsHtml = Array.from({ length: 28 }, () => '<span class="voice-hold-hud-bar" style="height: 16px; opacity: 0.8"></span>').join('');
    const longText = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: holding to dictate long technical text across multiple lines on iOS mobile viewport.`).join('\n');

    const zonesHtml = `
      <div class="voice-hold-zone voice-hold-zone-cancel" data-zone-target="cancel">
        <svg class="voice-hold-zone-arrow" width="14" height="14" viewBox="0 0 24 24"><path d="M19 12H5" /></svg>
        <span class="voice-hold-zone-label test-cancel-label">Cancel</span>
      </div>
      <div class="voice-hold-zone voice-hold-zone-send is-active" data-zone-target="send">
        <svg class="voice-hold-zone-arrow voice-hold-zone-send-icon" width="14" height="14" viewBox="0 0 24 24"><path d="M12 19V5" /></svg>
        <span class="voice-hold-zone-label test-send-label">Send</span>
      </div>
      <div class="voice-hold-zone voice-hold-zone-edit" data-zone-target="edit">
        <span class="voice-hold-zone-label test-edit-label">Edit</span>
        <svg class="voice-hold-zone-arrow" width="14" height="14" viewBox="0 0 24 24"><path d="M5 12h14" /></svg>
      </div>`;

    const browser = await browserType.launch({ headless: true });
    try {
      for (const reducedMotion of ['reduce', 'no-preference'] as const) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
        const page = await context.newPage();
        try {
          await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
            <div class="controls-composer controls-composer-voice-ready controls-composer-voice-pending controls-composer-voice-holding">
              <div class="controls-input controls-input-with-trailing-2" contenteditable="false"></div>
            </div>
            <div class="controls-composer controls-composer-voice-ready test-idle-ready">
              <div class="controls-input controls-input-with-trailing-1 test-idle-input" contenteditable="false"></div>
            </div>
            <div class="voice-overlay" style="display:none"></div>
            <button class="btn-voice btn-voice-active"></button>
            <div class="voice-hold-hud voice-hold-hud-zone-send" style="--voice-slide-x:0px;">
              <div class="voice-hold-hud-atmosphere">
                <div class="voice-hold-hud-aurora"></div>
                <div class="voice-hold-hud-aurora-core"></div>
              </div>
              <div class="voice-hold-hud-transcript-stage">
                <div class="voice-hold-hud-transcript">Hello<span class="voice-streaming-robot-cursor is-active"><svg><circle class="voice-robot-antenna"></circle></svg></span></div>
              </div>
              <div class="voice-hold-hud-card">
                <div class="voice-hold-hud-header">
                  <span class="voice-hold-hud-recognizing is-recognizing">
                    <span class="voice-status-dot voice-status-dot-active voice-status-dot-recognizing"></span>
                    <span class="voice-recognizing-dots"><i></i><i></i><i></i></span>
                    <span>Listening</span>
                  </span>
                </div>
                <div class="voice-hold-hud-active-hint is-send">Hint</div>
                <div class="voice-hold-hud-waveform">${barsHtml}</div>
                <div class="voice-hold-hud-zones">${zonesHtml}</div>
              </div>
            </div>
          </body></html>`);

          for (const zone of ['send', 'cancel', 'edit'] as const) {
            const computed = await page.evaluate(async ({ z, waitMs }) => {
              const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
              hud.className = `voice-hold-hud voice-hold-hud-zone-${z}`;
              hud.style.setProperty('--voice-slide-x', z === 'cancel' ? '-52px' : z === 'edit' ? '52px' : '0px');
              const hint = document.querySelector('.voice-hold-hud-active-hint')!;
              hint.className = `voice-hold-hud-active-hint is-${z}`;
              for (const k of ['cancel', 'send', 'edit']) {
                document.querySelector(`.voice-hold-zone-${k}`)!.classList.toggle('is-active', k === z);
              }
              if (waitMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
              const gs = (sel: string, pseudo?: string) => getComputedStyle(document.querySelector(sel)!, pseudo);
              return {
                composerReadyAfter: gs('.controls-composer-voice-ready', '::after').animationName,
                composerInput: gs('.controls-composer-voice-holding .controls-input').animationName,
                btnVoiceActive: gs('.btn-voice-active').animationName,
                hudAurora: gs('.voice-hold-hud-aurora').animationName,
                hudAuroraCore: gs('.voice-hold-hud-aurora-core').animationName,
                dotActive: gs('.voice-status-dot-active').animationName,
                recDot: gs('.voice-recognizing-dots i').animationName,
                robotCursor: gs('.voice-streaming-robot-cursor.is-active').animationName,
                robotAntenna: gs('.voice-robot-antenna').animationName,
                atmosphereTrans: gs('.voice-hold-hud-atmosphere').transitionProperty,
                hudTrans: gs('.voice-hold-hud').transitionProperty,
                auroraTrans: gs('.voice-hold-hud-aurora').transitionProperty,
                auroraCoreTrans: gs('.voice-hold-hud-aurora-core').transitionProperty,
                transcriptTrans: gs('.voice-hold-hud-transcript').transitionProperty,
                barTrans: gs('.voice-hold-hud-bar').transitionProperty,
                dotTrans: gs('.voice-status-dot').transitionProperty,
                hintTrans: gs('.voice-hold-hud-active-hint').transitionProperty,
                zoneTrans: gs('.voice-hold-zone').transitionProperty,
                atmosphereBlur: gs('.voice-hold-hud-atmosphere').backdropFilter,
                atmosphereMask: gs('.voice-hold-hud-atmosphere').maskImage || gs('.voice-hold-hud-atmosphere').webkitMaskImage,
                auroraFilter: gs('.voice-hold-hud-aurora').filter,
                cardBorderTopStyle: gs('.voice-hold-hud-card').borderTopStyle,
                cardBorderTopWidth: gs('.voice-hold-hud-card').borderTopWidth,
                transcriptBorderTopStyle: gs('.voice-hold-hud-transcript').borderTopStyle,
                transcriptBorderTopWidth: gs('.voice-hold-hud-transcript').borderTopWidth,
                transcriptBorderTopColor: gs('.voice-hold-hud-transcript').borderTopColor,
                transcriptBorderRadius: gs('.voice-hold-hud-transcript').borderRadius,
                transcriptBackgroundImage: gs('.voice-hold-hud-transcript').backgroundImage,
                transcriptBoxShadow: gs('.voice-hold-hud-transcript').boxShadow,
                transcriptBackdropFilter: gs('.voice-hold-hud-transcript').backdropFilter || gs('.voice-hold-hud-transcript').getPropertyValue('-webkit-backdrop-filter'),
                transcriptPointerEvents: gs('.voice-hold-hud-transcript').pointerEvents,
                hudPointerEvents: gs('.voice-hold-hud').pointerEvents,
                hintBorderTopStyle: gs('.voice-hold-hud-active-hint').borderTopStyle,
                zoneBorderTopStyle: gs(`.voice-hold-zone-${z}`).borderTopStyle,
                trailing2PaddingRight: gs('.controls-input-with-trailing-2').paddingRight,
                trailing1PaddingRight: gs('.test-idle-input').paddingRight,
                idleTouchAction: gs('.test-idle-input').touchAction,
                idleUserSelect: gs('.test-idle-input').getPropertyValue('-webkit-user-select'),
                overlayBorderRadius: gs('.voice-overlay').borderRadius,
                overlayZIndex: gs('.voice-overlay').zIndex,
              };
            }, { z: zone, waitMs: reducedMotion === 'no-preference' && zone !== 'send' ? 240 : 0 });

            expect(computed.trailing2PaddingRight).toBe('96px');
            expect(computed.trailing1PaddingRight).toBe('54px');
            expect(computed.idleTouchAction).toBe('manipulation');
            expect(computed.idleUserSelect).toBe('none');
            expect(computed.overlayBorderRadius).toBe('0px');
            expect(computed.overlayZIndex).toBe('2147483021');
            expect(computed.atmosphereBlur).toContain('blur(');
            expect(computed.atmosphereMask).toContain('linear-gradient');
            expect(computed.auroraFilter).toContain('blur(');
            expect(computed.cardBorderTopStyle).toBe('none');
            expect(computed.cardBorderTopWidth).toBe('0px');
            expect(computed.transcriptBorderTopStyle).toBe('solid');
            expect(computed.transcriptBorderTopWidth).toBe('1px');
            expect(computed.transcriptBorderRadius).toBe('20px');
            expect(computed.transcriptBackgroundImage).toContain('linear-gradient');
            expect(computed.transcriptBoxShadow).not.toBe('none');
            expect(computed.transcriptBackdropFilter).toContain('blur(');
            expect(computed.transcriptPointerEvents).toBe('none');
            expect(computed.hudPointerEvents).toBe('none');
            if (zone === 'send') expect(computed.transcriptBorderTopColor).toContain('56, 189, 248');
            if (zone === 'cancel') expect(computed.transcriptBorderTopColor).toContain('248, 113, 113');
            if (zone === 'edit') expect(computed.transcriptBorderTopColor).toContain('52, 211, 153');
            expect(computed.hintBorderTopStyle).toBe('none');
            expect(computed.zoneBorderTopStyle).toBe('none');

            if (reducedMotion === 'reduce') {
              expect(computed.composerReadyAfter).toBe('none');
              expect(computed.composerInput).toBe('none');
              expect(computed.btnVoiceActive).toBe('none');
              expect(computed.hudAurora).toBe('none');
              expect(computed.hudAuroraCore).toBe('none');
              expect(computed.dotActive).toBe('none');
              expect(computed.recDot).toBe('none');
              expect(computed.robotCursor).toBe('none');
              expect(computed.robotAntenna).toBe('none');
              expect(computed.hudTrans).toBe('none');
              expect(computed.atmosphereTrans).toBe('none');
              expect(computed.auroraTrans).toBe('none');
              expect(computed.auroraCoreTrans).toBe('none');
              expect(computed.transcriptTrans).toBe('none');
              expect(computed.barTrans).toBe('none');
              expect(computed.dotTrans).toBe('none');
              expect(computed.hintTrans).toBe('none');
              expect(computed.zoneTrans).toBe('none');
            } else {
              expect(computed.composerReadyAfter).toBe('voice-editor-orbit');
              expect(computed.composerInput).toBe('voice-composer-energy-pulse');
              expect(computed.hudAurora).toBe('voice-aurora-drift');
              expect(computed.hudAuroraCore).toBe('voice-aurora-pulse');
              expect(computed.dotActive).toBe('voice-dot-pulse');
              expect(computed.recDot).toBe('voice-recognizing-bounce');
              expect(computed.robotCursor).toBe('voice-robot-bob');
              expect(computed.robotAntenna).toBe('voice-robot-antenna-pulse');
            }
          }
        } finally {
          await context.close();
        }
      }

      const viewports = [
        { width: 320, height: 568, sat: 0, sab: 0 },
        { width: 390, height: 500, sat: 0, sab: 0 },
        { width: 390, height: 844, sat: 47, sab: 34 },
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
              <div class="voice-hold-hud-atmosphere">
                <div class="voice-hold-hud-aurora"></div>
                <div class="voice-hold-hud-aurora-core"></div>
              </div>
              <div class="voice-hold-hud-transcript-stage">
                <div class="voice-hold-hud-transcript"></div>
              </div>
              <div class="voice-hold-hud-card">
                <div class="voice-hold-hud-header">
                  <span class="voice-hold-hud-recognizing is-recognizing">
                    <span class="voice-status-dot voice-status-dot-active voice-status-dot-recognizing"></span>
                    <span class="voice-recognizing-dots"><i></i><i></i><i></i></span>
                    <span class="test-rec-label"></span>
                  </span>
                </div>
                <div class="voice-hold-hud-active-hint is-send"></div>
                <div class="voice-hold-hud-waveform">${barsHtml}</div>
                <div class="voice-hold-hud-zones">${zonesHtml}</div>
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
                  const atmosphere = r('.voice-hold-hud-atmosphere');
                  const header = r('.voice-hold-hud-header');
                  const transcript = r('.voice-hold-hud-transcript');
                  const hint = r('.voice-hold-hud-active-hint');
                  const zones = r('.voice-hold-hud-zones');
                  const cancelCue = r('[data-zone-target="cancel"]');
                  const sendCue = r('[data-zone-target="send"]');
                  const editCue = r('[data-zone-target="edit"]');
                  const cancelCenterX = cancelCue.left + cancelCue.width / 2;
                  const sendCenterX = sendCue.left + sendCue.width / 2;
                  const editCenterX = editCue.left + editCue.width / 2;
                  const strip = r('.session-live-status-inline');
                  const stripMidX = strip.left + strip.width / 2;
                  const stripMidY = strip.top + strip.height / 2;
                  const prevPe = (hudEl as HTMLElement).style.pointerEvents;
                  (hudEl as HTMLElement).style.pointerEvents = 'auto';
                  const topAtStrip = document.elementFromPoint(stripMidX, stripMidY);
                  (hudEl as HTMLElement).style.pointerEvents = prevPe;
                  return {
                    hudZ: getComputedStyle(hudEl).zIndex,
                    atmosphereBottom: Math.round(atmosphere.bottom),
                    cardTop: Math.round(card.top),
                    cardBottom: Math.round(card.bottom),
                    cardLeft: Math.round(card.left),
                    cardRight: Math.round(card.right),
                    headerTop: Math.round(header.top),
                    zonesBottom: Math.round(zones.bottom),
                    cancelCenterX,
                    sendCenterX,
                    editCenterX,
                    cancelLeft: cancelCue.left,
                    editRight: editCue.right,
                    hintBottom: Math.round(hint.bottom),
                    transcriptTop: Math.round(transcript.top),
                    transcriptBottom: Math.round(transcript.bottom),
                    transcriptCenterX: Math.round(transcript.left + transcript.width / 2),
                    transcriptCenterY: Math.round(transcript.top + transcript.height / 2),
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

                expect(m.hudZ, `${code}/${zone}/${mode} z-index`).toBe('2147483022');
                expect(m.hudCoversStrip, `${code}/${zone}/${mode} covered by live strip`).toBe(true);
                expect(m.atmosphereBottom, `${code}/${zone}/${mode} atmosphereBottom`).toBe(vp.height);
                expect(m.cardTop, `${code}/${zone}/${mode} cardTop`).toBeGreaterThanOrEqual(11 + vp.sat);
                expect(m.cardBottom, `${code}/${zone}/${mode} cardBottom`).toBeLessThanOrEqual(vp.height);
                expect(m.headerTop, `${code}/${zone}/${mode} headerTop`).toBeGreaterThanOrEqual(m.cardTop);
                expect(m.zonesBottom, `${code}/${zone}/${mode} zonesBottom`).toBeLessThanOrEqual(vp.height - 20 - vp.sab);
                expect(m.hintBottom, `${code}/${zone}/${mode} hintBottom`).toBeLessThanOrEqual(m.cardBottom);
                expect(m.transcriptTop, `${code}/${zone}/${mode} transcriptTop`).toBeGreaterThanOrEqual(12 + vp.sat);
                expect(m.transcriptBottom, `${code}/${zone}/${mode} transcriptBottom vs cardTop`).toBeLessThanOrEqual(m.cardTop);
                expect(Math.abs(m.transcriptCenterX - vp.width / 2), `${code}/${zone}/${mode} transcriptCenterX`).toBeLessThanOrEqual(2);
                if (vp.height >= 800) {
                  expect(m.transcriptCenterY, `${code}/${zone}/${mode} transcriptCenterY`).toBeGreaterThanOrEqual(vp.height * 0.38);
                  expect(m.transcriptCenterY, `${code}/${zone}/${mode} transcriptCenterY`).toBeLessThanOrEqual(vp.height * 0.56);
                } else {
                  expect(m.transcriptCenterY, `${code}/${zone}/${mode} short-screen transcriptCenterY`).toBeLessThan(m.cardTop);
                }
                expect(m.scrollOverflow, `${code}/${zone}/${mode} overflow`).toBe(false);
                expect(m.cancelCenterX).toBeLessThan(m.sendCenterX);
                expect(m.sendCenterX).toBeLessThan(m.editCenterX);
                expect(m.cancelLeft).toBeGreaterThanOrEqual(m.cardLeft);
                expect(m.editRight).toBeLessThanOrEqual(m.cardRight);
                if (mode === 'long') {
                  expect(m.transcriptScrollH, `${code}/${zone}/long scrollable`).toBeGreaterThan(m.transcriptClientH);
                } else {
                  expect(m.transcriptH, `${code}/${zone}/short transcriptH`).toBeGreaterThanOrEqual(32);
                }
              }
            }
          }
        } finally {
          await context.close();
        }
      }

      // Compressed --vvh portrait/landscape counterexamples: physical viewport height unchanged, only --vvh shrinks
      const compressedCases = [
        { width: 390, height: 844, sat: 47, sab: 34, vvh: 250 },
        { width: 844, height: 390, sat: 0, sab: 21, vvh: 200 },
        { width: 844, height: 390, sat: 0, sab: 21, vvh: undefined },
      ];
      for (const vc of compressedCases) {
        const effectiveH = vc.vvh ?? vc.height;
        const context = await browser.newContext({ viewport: { width: vc.width, height: vc.height }, hasTouch: true });
        const page = await context.newPage();
        try {
          const vvhStyle = vc.vvh !== undefined ? `--vvh:${vc.vvh}px;` : '';
          await page.setContent(`<!doctype html><html style="--sat:${vc.sat}px;--sab:${vc.sab}px;${vvhStyle}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>
            <div class="voice-hold-hud voice-hold-hud-zone-send">
              <div class="voice-hold-hud-atmosphere">
                <div class="voice-hold-hud-aurora"></div>
                <div class="voice-hold-hud-aurora-core"></div>
              </div>
              <div class="voice-hold-hud-transcript-stage">
                <div class="voice-hold-hud-transcript"></div>
              </div>
              <div class="voice-hold-hud-card">
                <div class="voice-hold-hud-header">
                  <span class="voice-hold-hud-recognizing is-recognizing">
                    <span class="voice-status-dot voice-status-dot-active voice-status-dot-recognizing"></span>
                    <span class="voice-recognizing-dots"><i></i><i></i><i></i></span>
                    <span class="test-rec-label"></span>
                  </span>
                </div>
                <div class="voice-hold-hud-active-hint is-send"></div>
                <div class="voice-hold-hud-waveform">${barsHtml}</div>
                <div class="voice-hold-hud-zones">${zonesHtml}</div>
              </div>
            </div>
          </body></html>`);

          for (const { code, json } of locales) {
            const v = json.voice;
            for (const zone of ['send', 'cancel', 'edit'] as const) {
              const activeHint = zone === 'cancel' ? v.release_to_cancel : zone === 'edit' ? v.release_to_edit : v.release_to_send;
              for (const [mode, textVal] of [['short', 'Hello'], ['long', longText]] as const) {
                const m = await page.evaluate(({ zone: z, recLabel, textVal: tv, activeHint: ah, cancelLabel, sendLabel, editLabel }) => {
                  const hudEl = document.querySelector('.voice-hold-hud') as HTMLElement;
                  hudEl.className = `voice-hold-hud voice-hold-hud-zone-${z}`;
                  document.querySelector('.test-rec-label')!.textContent = recLabel;
                  const trEl = document.querySelector('.voice-hold-hud-transcript') as HTMLElement;
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
                  const cardEl = document.querySelector('.voice-hold-hud-card') as HTMLElement;
                  const stageEl = document.querySelector('.voice-hold-hud-transcript-stage') as HTMLElement;
                  const r = (el: Element) => el.getBoundingClientRect();
                  const hud = r(hudEl);
                  const stage = r(stageEl);
                  const transcript = r(trEl);
                  const card = r(cardEl);
                  const zones = r(document.querySelector('.voice-hold-hud-zones')!);
                  return {
                    hudBottom: Math.round(hud.bottom),
                    stageTop: Math.round(stage.top),
                    transcriptTop: Math.round(transcript.top),
                    transcriptBottom: Math.round(transcript.bottom),
                    transcriptCenterX: Math.round(transcript.left + transcript.width / 2),
                    cardTop: Math.round(card.top),
                    cardBottom: Math.round(card.bottom),
                    cardScrollH: cardEl.scrollHeight,
                    cardClientH: cardEl.clientHeight,
                    zonesBottom: Math.round(zones.bottom),
                    transcriptScrollH: trEl.scrollHeight,
                    transcriptClientH: trEl.clientHeight,
                    scrollOverflow: document.documentElement.scrollWidth > window.innerWidth,
                    hudPointerEvents: getComputedStyle(hudEl).pointerEvents,
                    transcriptPointerEvents: getComputedStyle(trEl).pointerEvents,
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

                const label = `${vc.width}x${vc.height}/vvh=${vc.vvh ?? 'none'}/${code}/${zone}/${mode}`;
                expect(m.hudBottom, `${label} hudBottom`).toBe(effectiveH);
                expect(m.stageTop, `${label} stageTop`).toBeGreaterThanOrEqual(12 + vc.sat);
                expect(m.transcriptTop, `${label} transcriptTop`).toBeGreaterThanOrEqual(12 + vc.sat);
                expect(m.transcriptBottom, `${label} transcriptBottom <= cardTop`).toBeLessThanOrEqual(m.cardTop);
                expect(m.cardBottom, `${label} cardBottom`).toBeLessThanOrEqual(effectiveH);
                expect(m.cardScrollH, `${label} card not clipped`).toBeLessThanOrEqual(m.cardClientH + 1);
                expect(m.zonesBottom, `${label} zonesBottom`).toBeLessThanOrEqual(effectiveH - vc.sab);
                expect(Math.abs(m.transcriptCenterX - vc.width / 2), `${label} centerX`).toBeLessThanOrEqual(2);
                expect(m.scrollOverflow, `${label} overflow`).toBe(false);
                expect(m.hudPointerEvents).toBe('none');
                expect(m.transcriptPointerEvents).toBe('none');
                if (mode === 'long') {
                  expect(m.transcriptScrollH, `${label} scrollable`).toBeGreaterThan(m.transcriptClientH);
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

  it('enforces read-only CSS editing across ready/pending/holding/disabled voice states and restores plaintext editing on short tap and desktop in chromium', { timeout: 60_000 }, async () => {
    vi.useRealTimers();
    const require = createRequire(import.meta.url);
    const browserType = (require('playwright') as typeof import('playwright')).chromium;
    if (!existsSync(browserType.executablePath())) {
      return;
    }
    const stylesCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css'), 'utf8');
    expect(stylesCss).toContain('-webkit-touch-callout: none');
    const browser = await browserType.launch({ headless: true });
    try {
      const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await mobileContext.newPage();

      // Non-editable mobile states MUST enforce -webkit-user-modify: read-only and reject keyboard mutation
      const lockedCases = [
        { name: 'ready-unfocused', composerClass: 'controls-composer controls-composer-voice-ready', inputClass: 'controls-input', ce: 'false' },
        { name: 'pending-unfocused', composerClass: 'controls-composer controls-composer-voice-ready controls-composer-voice-pending', inputClass: 'controls-input', ce: 'false' },
        { name: 'holding', composerClass: 'controls-composer controls-composer-voice-ready controls-composer-voice-holding', inputClass: 'controls-input', ce: 'false' },
        { name: 'disabled', composerClass: 'controls-composer', inputClass: 'controls-input controls-input-disabled', ce: 'false' },
      ];

      for (const tc of lockedCases) {
        await page.setContent(
          `<!doctype html><html><head><style>${stylesCss}</style></head><body>` +
          `<div class="${tc.composerClass}"><div class="${tc.inputClass}" contenteditable="${tc.ce}">hello</div></div>` +
          `</body></html>`,
        );
        await page.$eval('.controls-input', (el) => (el as HTMLElement).focus());
        await page.keyboard.type('X');
        const result = await page.$eval('.controls-input', (el) => {
          const cs = getComputedStyle(el);
          return {
            modify: cs.getPropertyValue('-webkit-user-modify'),
            select: cs.getPropertyValue('-webkit-user-select'),
            touchAction: cs.getPropertyValue('touch-action'),
            text: el.textContent,
          };
        });
        expect(result.modify, `${tc.name} -webkit-user-modify`).toBe('read-only');
        expect(result.select, `${tc.name} -webkit-user-select`).toBe('none');
        expect(result.text, `${tc.name} rejects typing`).toBe('hello');
        if (tc.name === 'holding') {
          expect(result.touchAction, `${tc.name} touch-action`).toBe('none');
        } else if (tc.name !== 'disabled') {
          expect(result.touchAction, `${tc.name} touch-action`).toBe('manipulation');
        }
      }

      // Short-tap focused mobile state MUST restore read-write-plaintext-only and accept typing
      await page.setContent(
        `<!doctype html><html><head><style>${stylesCss}</style></head><body>` +
        `<div class="controls-composer controls-composer-voice-ready"><div class="controls-input" contenteditable="true">hello</div></div>` +
        `</body></html>`,
      );
      await page.$eval('.controls-input', (el) => (el as HTMLElement).focus());
      await page.keyboard.type('X');
      const mobileFocused = await page.$eval('.controls-input', (el) => {
        const cs = getComputedStyle(el);
        return {
          modify: cs.getPropertyValue('-webkit-user-modify'),
          select: cs.getPropertyValue('-webkit-user-select'),
          text: el.textContent,
        };
      });
      expect(mobileFocused.modify).toBe('read-write-plaintext-only');
      expect(mobileFocused.select).toBe('text');
      expect(mobileFocused.text).toBe('Xhello');
      await mobileContext.close();

      // Desktop layout MUST keep read-write-plaintext-only editing intact
      const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const desktopPage = await desktopContext.newPage();
      await desktopPage.setContent(
        `<!doctype html><html><head><style>${stylesCss}</style></head><body>` +
        `<div class="controls-composer"><div class="controls-input" contenteditable="true">hello</div></div>` +
        `</body></html>`,
      );
      await desktopPage.$eval('.controls-input', (el) => (el as HTMLElement).focus());
      await desktopPage.keyboard.type('D');
      const desktopState = await desktopPage.$eval('.controls-input', (el) => {
        const cs = getComputedStyle(el);
        return {
          modify: cs.getPropertyValue('-webkit-user-modify'),
          select: cs.getPropertyValue('-webkit-user-select'),
          text: el.textContent,
        };
      });
      expect(desktopState.modify).toBe('read-write-plaintext-only');
      expect(desktopState.select).toBe('text');
      expect(desktopState.text).toBe('Dhello');
      await desktopContext.close();
    } finally {
      await browser.close();
    }
  });

  it('exercises real interactive SessionControls touch/pointer tap-guard, slide-hold, failed-hold keyboard fallback, and active cancel in mobile Chromium', { timeout: 60000 }, async () => {
    vi.useRealTimers();
    const require = createRequire(import.meta.url);
    const browserType = (require('playwright') as typeof import('playwright')).chromium;
    if (!existsSync(browserType.executablePath())) {
      return;
    }
    const testDir = dirname(fileURLToPath(import.meta.url));
    const webDir = resolve(testDir, '../..');
    const stylesCss = readFileSync(resolve(webDir, 'src/styles.css'), 'utf8');

    const entrySource = `
      import { render } from 'preact';
      import { SessionControls } from './src/components/SessionControls.tsx';
      const ws = { connected: true, send: () => {}, sendSessionCommand: () => {}, onMessage: () => () => {} };
      const session = { name: 'deck_main', project: 'main', role: 'main', agentType: 'claude-code-sdk', state: 'idle', runtimeType: 'transport', projectDir: '/tmp/project' };
      const quickData = { data: { history: [], sessionHistory: {}, commands: [], phrases: [] }, loaded: true, recordHistory: () => {}, addCommand: () => {}, addPhrase: () => {}, removeCommand: () => {}, removePhrase: () => {}, removeHistory: () => {}, removeSessionHistory: () => {}, clearHistory: () => {}, clearSessionHistory: () => {} };
      render(<SessionControls ws={ws} activeSession={session} quickData={quickData} sessions={[]} subSessions={[]} serverId="srv-1" />, document.getElementById('app'));
    `;

    // Bundle in a clean Node subprocess to avoid jsdom cross-realm TextEncoder/Uint8Array mismatch in esbuild
    const bundleCode = execFileSync(
      process.execPath,
      [
        '-e',
        `
        const esbuild = require(require('path').resolve(process.cwd(), 'node_modules/esbuild'));
        const entry = process.env.BUILD_ENTRY;
        const stubPlugin = {
          name: 'chromium-session-controls-stubs',
          setup(build) {
            build.onResolve({ filter: /^\\.\\/VoiceInput\\.js$/ }, (args) =>
              args.importer.endsWith('SessionControls.tsx') ? { path: 'voice-input-stub', namespace: 'stub' } : null,
            );
            build.onResolve({ filter: /^\\.\\/VoiceOverlay\\.js$/ }, (args) =>
              args.importer.endsWith('SessionControls.tsx') ? { path: 'voice-overlay-stub', namespace: 'stub' } : null,
            );
            build.onResolve({ filter: /^react-i18next$/ }, () => ({ path: 'i18n-stub', namespace: 'stub' }));
            build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
              if (args.path === 'voice-input-stub') {
                return {
                  contents: 'export const isAvailable=()=>true;export const prewarm=(o)=>window.__voiceMock.prewarm(o);export const primeWebGesture=(o)=>window.__voiceMock.primeWebGesture?.(o)??false;export const cancelWebGesturePrime=()=>window.__voiceMock.cancelWebGesturePrime?.();export const startListening=(...a)=>window.__voiceMock.startListening(...a);export const stopListening=()=>window.__voiceMock.stopListening();export const onAudioLevel=(cb)=>window.__voiceMock.onAudioLevel(cb);',
                  loader: 'js',
                };
              }
              if (args.path === 'voice-overlay-stub') {
                return { contents: 'export const VoiceOverlay = () => null;', loader: 'js' };
              }
              return { contents: 'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en" } });', loader: 'js' };
            });
          },
        };
        esbuild.build({
          stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' },
          absWorkingDir: process.cwd(),
          bundle: true,
          format: 'iife',
          write: false,
          jsx: 'automatic',
          jsxImportSource: 'preact',
          tsconfig: require('path').resolve(process.cwd(), 'tsconfig.json'),
          plugins: [stubPlugin],
        }).then((built) => {
          process.stdout.write(built.outputFiles[0].text);
        }).catch((err) => {
          console.error(err);
          process.exit(1);
        });
        `,
      ],
      {
        cwd: webDir,
        env: { ...process.env, BUILD_ENTRY: entrySource },
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const page = await context.newPage();
      await page.route('https://imcodes.test/**', async (route) => {
        const url = route.request().url();
        if (url === 'https://imcodes.test/') {
          await route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${stylesCss}</style></head><body><div id="app"></div></body></html>`,
          });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await page.addInitScript(() => {
        const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
        let vvHeight = 844;
        const fakeVv = {
          get height() { return vvHeight; },
          get width() { return window.innerWidth; },
          offsetTop: 0,
          offsetLeft: 0,
          pageTop: 0,
          pageLeft: 0,
          scale: 1,
          addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(fn);
          },
          removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
            listeners.get(type)?.delete(fn);
          },
        };
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          get: () => fakeVv,
        });
        (window as any).__setFakeVvHeight = (h: number) => {
          vvHeight = h;
          const ev = new Event('resize');
          listeners.get('resize')?.forEach((fn) => {
            if (typeof fn === 'function') fn(ev);
            else fn.handleEvent(ev);
          });
        };
      });

      await page.goto('https://imcodes.test/');
      await page.evaluate(() => {
        (window as any).__voiceCalls = { start: 0, stop: 0, prime: 0, cancelPrime: 0, nextStartResult: true };
        (window as any).__voiceMock = {
          prewarm: async () => {},
          primeWebGesture: () => {
            (window as any).__voiceCalls.prime += 1;
            return true;
          },
          cancelWebGesturePrime: () => {
            (window as any).__voiceCalls.cancelPrime += 1;
          },
          startListening: async (_onResult: unknown, onListeningChange?: (listening: boolean) => void) => {
            (window as any).__voiceCalls.start += 1;
            const ok = !!(window as any).__voiceCalls.nextStartResult;
            if (ok) onListeningChange?.(true);
            return ok;
          },
          stopListening: async () => {
            (window as any).__voiceCalls.stop += 1;
          },
          onAudioLevel: () => () => {},
        };
      });
      await page.addScriptTag({ content: bundleCode });
      await page.waitForSelector('.controls-composer-voice-ready .controls-input');

      // 1. Real mobile tap (60ms with dx=12 thumb drift) must focus composer for real Chromium typing and never start voice
      const box = await page.locator('.controls-input').boundingBox();
      expect(box).not.toBeNull();
      const cx = box!.x + box!.width / 2;
      const cy = box!.y + box!.height / 2;

      await page.evaluate(async ({ x, y }) => {
        const el = document.querySelector('.controls-input')!;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 60));
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x + 12, clientY: y + 1, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x + 12, clientY: y + 1, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
      }, { x: cx, y: cy });

      await page.keyboard.type('abc');
      const tapResult = await page.evaluate(() => {
        const el = document.querySelector('.controls-input') as HTMLElement;
        return {
          starts: (window as any).__voiceCalls.start,
          ce: el.getAttribute('contenteditable'),
          focused: document.activeElement === el,
          text: el.textContent,
        };
      });
      expect(tapResult.starts).toBe(0);
      expect(tapResult.ce).toBe('true');
      expect(tapResult.focused).toBe(true);
      expect(tapResult.text).toBe('abc');

      // Clear & reset to unfocused
      await page.evaluate(() => {
        const el = document.querySelector('.controls-input') as HTMLElement;
        el.textContent = '';
        el.blur();
      });

      // 2. Slide-hold (>=95ms move, >145ms promote) whose startListening resolves false MUST still focus composer so real typing succeeds
      await page.evaluate(async ({ x, y }) => {
        (window as any).__voiceCalls.nextStartResult = false;
        const el = document.querySelector('.controls-input')!;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 100));
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x + 22, clientY: y + 1, pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 65));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x + 22, clientY: y + 1, pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
      }, { x: cx, y: cy });

      await page.keyboard.type('ok');
      const failedHoldResult = await page.evaluate(() => {
        const el = document.querySelector('.controls-input') as HTMLElement;
        return {
          starts: (window as any).__voiceCalls.start,
          ce: el.getAttribute('contenteditable'),
          focused: document.activeElement === el,
          text: el.textContent,
          hudPresent: !!document.querySelector('.voice-hold-hud'),
        };
      });
      expect(failedHoldResult.starts).toBe(1);
      expect(failedHoldResult.ce).toBe('true');
      expect(failedHoldResult.focused).toBe(true);
      expect(failedHoldResult.text).toBe('ok');
      expect(failedHoldResult.hudPresent).toBe(false);

      // Reset to unfocused
      await page.evaluate(() => {
        const el = document.querySelector('.controls-input') as HTMLElement;
        el.textContent = '';
        el.blur();
      });

      // 3. Active hold (startListening -> true) + slide left into cancel & release stays unfocused and clears HUD
      await page.evaluate(async ({ x, y }) => {
        (window as any).__voiceCalls.nextStartResult = true;
        const el = document.querySelector('.controls-input')!;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 100));
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x + 20, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 65));
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: x - 110, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x - 110, clientY: y, pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
        await new Promise((r) => setTimeout(r, 20));
      }, { x: cx, y: cy });

      const activeCancelResult = await page.evaluate(() => {
        const el = document.querySelector('.controls-input') as HTMLElement;
        return {
          starts: (window as any).__voiceCalls.start,
          stops: (window as any).__voiceCalls.stop,
          ce: el.getAttribute('contenteditable'),
          focused: document.activeElement === el,
          hudPresent: !!document.querySelector('.voice-hold-hud'),
        };
      });
      expect(activeCancelResult.starts).toBe(2);
      expect(activeCancelResult.stops).toBe(2); // 1 defensive stop from step 2 failed hold + 1 from step 3 active cancel
      expect(activeCancelResult.ce).toBe('false');
      expect(activeCancelResult.focused).toBe(false);
      expect(activeCancelResult.hudPresent).toBe(false);

      // 4. Chromium check: soft keyboard open -> dismiss without blur restores contenteditable=false & hold-to-talk (plus lostpointercapture & embedded mic dedup)
      const dismissResult = await page.evaluate(async ({ x, y }) => {
        const el = document.querySelector('.controls-input') as HTMLElement;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 4, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 30));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 4, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
        await new Promise((r) => setTimeout(r, 20));
        const focusedAfterTap = document.activeElement === el;
        const ceAfterTap = el.getAttribute('contenteditable');

        // Soft keyboard opens (844 -> 500): must keep composer focused & editable
        (window as any).__setFakeVvHeight(500);
        await new Promise((r) => setTimeout(r, 20));
        const focusedWhileKbOpen = document.activeElement === el;
        const ceWhileKbOpen = el.getAttribute('contenteditable');

        // Soft keyboard dismisses via viewport restore WITHOUT firing blur: must blur & restore contenteditable=false
        (window as any).__setFakeVvHeight(844);
        await new Promise((r) => setTimeout(r, 20));
        const focusedAfterDismiss = document.activeElement === el;
        const ceAfterDismiss = el.getAttribute('contenteditable');

        // Hold-to-talk recovers immediately (and survives lostpointercapture(buttons=0) before pointerup)
        const startsBeforeHold = (window as any).__voiceCalls.start;
        const stopsBeforeHold = (window as any).__voiceCalls.stop;
        (window as any).__voiceCalls.nextStartResult = true;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
        await new Promise((r) => setTimeout(r, 120));
        el.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 5, pointerType: 'touch', buttons: 0 }));
        await new Promise((r) => setTimeout(r, 90));
        const hudWhileHolding = !!document.querySelector('.voice-hold-hud');
        const startsDuringHold = (window as any).__voiceCalls.start - startsBeforeHold;
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 5, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
        await new Promise((r) => setTimeout(r, 20));
        const stopsAfterRelease = (window as any).__voiceCalls.stop - stopsBeforeHold;

        // Embedded mic button pointerdown + trailing click deduplicates to 1 prime
        const micBtn = document.querySelector('.btn-voice-embedded') as HTMLButtonElement | null;
        const primesBeforeMic = (window as any).__voiceCalls.prime;
        if (micBtn) {
          micBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 6, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 }));
          micBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 6, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }));
          micBtn.click();
          await new Promise((r) => setTimeout(r, 20));
        }
        const primesAfterMic = (window as any).__voiceCalls.prime - primesBeforeMic;

        return {
          focusedAfterTap,
          ceAfterTap,
          focusedWhileKbOpen,
          ceWhileKbOpen,
          focusedAfterDismiss,
          ceAfterDismiss,
          hudWhileHolding,
          startsDuringHold,
          stopsAfterRelease,
          hasMicBtn: !!micBtn,
          primesAfterMic,
        };
      }, { x: cx, y: cy });
      expect(dismissResult.focusedAfterTap).toBe(true);
      expect(dismissResult.ceAfterTap).toBe('true');
      expect(dismissResult.focusedWhileKbOpen).toBe(true);
      expect(dismissResult.ceWhileKbOpen).toBe('true');
      expect(dismissResult.focusedAfterDismiss).toBe(false);
      expect(dismissResult.ceAfterDismiss).toBe('false');
      expect(dismissResult.hudWhileHolding).toBe(true);
      expect(dismissResult.startsDuringHold).toBe(1);
      expect(dismissResult.stopsAfterRelease).toBe(1);
      if (dismissResult.hasMicBtn) {
        expect(dismissResult.primesAfterMic).toBe(1);
      }

      await context.close();
    } finally {
      await browser.close();
    }
  });

  it('programmatic focus intents (pendingPrefillText, quick fill, external inputRef) exit read-only mode on mobile while guarding active voice holds', async () => {
    const inputRef: { current: HTMLDivElement | null } = { current: null };
    const onPendingPrefillApplied = vi.fn();
    const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
    const quickData = makeQuickData();

    const { rerender } = render(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={quickData}
        inputRef={inputRef as any}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        pendingPrefillText={null}
        onPendingPrefillApplied={onPendingPrefillApplied}
      />,
    );

    const input = document.querySelector('.controls-input') as HTMLDivElement;
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(input);

    // 1. pendingPrefillText enters editable typing state & focuses
    rerender(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={quickData}
        inputRef={inputRef as any}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        pendingPrefillText="reply text"
        onPendingPrefillApplied={onPendingPrefillApplied}
      />,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onPendingPrefillApplied).toHaveBeenCalledTimes(1);
    expect(input.textContent).toBe('reply text');
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);

    // Clear prefill prop as parent does on onPendingPrefillApplied
    rerender(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={quickData}
        inputRef={inputRef as any}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
        pendingPrefillText={null}
        onPendingPrefillApplied={onPendingPrefillApplied}
      />,
    );

    // 2. Blur returns mobile composer to unfocused read-only voice-ready state
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(input);

    // 3. External inputRef via focusComposerElement enters editable state when idle
    expect(focusComposerElement(inputRef.current, { moveCursorToEnd: true })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);

    // 4. Blur again -> 240ms hold locks to read-only and refuses focusComposerElement interruption
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('false');
    dispatchPointer(input, 'pointerdown', 180);
    expect(focusComposerElement(inputRef.current)).toBe(false);
    await vi.advanceTimersByTimeAsync(240);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect(readInlineWebkitUserModify(input)).toBe('read-only');
    expect(focusComposerElement(inputRef.current)).toBe(false);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // Release hold in center/cancel -> returns cleanly to unfocused read-only voice-ready state
    dispatchPointer(input, 'pointercancel', 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('false');

    // 5. Short tap still restores contenteditable="true" + focus after round trip
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(25);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('cancelling (even with stalled start/stop) passes abort:true and never deadlocks immediate re-hold, short-tap typing, or click focus', async () => {
    voiceMock.startListening.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>(() => {}));
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

    // 1. Hold 240ms while startListening stalls -> slide left into Cancel -> release
    dispatchPointer(input, 'pointerdown', 200);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    dispatchPointer(input, 'pointermove', 110);
    await vi.advanceTimersByTimeAsync(0);
    dispatchPointer(input, 'pointerup', 110);
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceMock.stopListening).toHaveBeenCalledWith({ abort: true });
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Blur back to voice-ready unfocused state, then immediately re-hold even though previous start/stop never settled
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(100);

    // 2. Immediately re-hold EVEN THOUGH previous start/stop never settled -> works immediately!
    dispatchPointer(input, 'pointerdown', 200);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    dispatchPointer(input, 'pointermove', 110);
    dispatchPointer(input, 'pointerup', 110);
    await vi.advanceTimersByTimeAsync(0);

    // 3. Immediately short-tap (<240ms) -> restores contenteditable="true", focuses, and typing works cleanly
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(140);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    input.textContent = 'Typed after cancel';
    fireEvent.input(input);
    expect(input.textContent).toBe('Typed after cancel');

    // 4. Blur back to voice-ready -> click fallback also unlocks contenteditable="true" and focuses
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(100);
    expect(input.getAttribute('contenteditable')).toBe('false');
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('never blocks short-tap or click-to-type while a prior send drain is still settling, while still protecting its final tail from overlapping holds', async () => {
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
    await vi.advanceTimersByTimeAsync(240);
    const firstResult = voiceMock.partialHandler!;
    firstResult('partial phrase');
    voiceMock.stopListening.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { releaseDrain = r; });
      firstResult('final drained phrase');
    });
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);

    // While send drain is still running: short tap (<240ms) immediately enters typing mode
    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(140);
    dispatchPointer(input, 'pointerup', 180);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);

    // Release drain still delivers the first hold's final tail once without starting a second recording
    releaseDrain();
    await vi.advanceTimersByTimeAsync(300);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'final drained phrase',
    }));
  });

  it.each(['send', 'edit'] as const)('preserves finite slow %s final tail past 15s, prevents overlapping holds from stealing drain ownership, and keeps tap-to-type responsive', async (outcome) => {
    let completeStop!: () => void;
    voiceMock.stopListening.mockReturnValueOnce(new Promise<void>((resolve) => { completeStop = resolve; }));
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
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    voiceMock.partialHandler?.('initial speech');
    if (outcome === 'edit') {
      dispatchPointer(input, 'pointermove', 260);
    }
    dispatchPointer(input, 'pointerup', outcome === 'edit' ? 260 : 180);

    // Advance past 15s (16s) before stop ACK & trailing final arrive
    await vi.advanceTimersByTimeAsync(16_000);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Attempt an overlapping long hold during drain: must NOT start a second recording or steal owner
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(240);
    dispatchPointer(input, 'pointerup', 180, 500, 2);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);

    // Short tap (<240ms) while drain is still active MUST still enter editable focus cleanly
    dispatchPointer(input, 'pointerdown', 180, 500, 3);
    await vi.advanceTimersByTimeAsync(140);
    dispatchPointer(input, 'pointerup', 180, 500, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);

    // Deliver trailing final tail and complete stop drain -> delivered intact once!
    voiceMock.partialHandler?.('initial speech with final tail');
    completeStop();
    await vi.advanceTimersByTimeAsync(outcome === 'send' ? 300 : 0);

    if (outcome === 'send') {
      expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        text: 'initial speech with final tail',
      }));
    } else {
      expect(document.querySelector('.mock-voice-overlay')?.getAttribute('data-initial-text')).toBe('initial speech with final tail');
    }
  });

  it('recovers orphaned leases after lostpointercapture or swallowed pointerup (new/reused pointerId, pending/slop/capture error, and click-to-type), while ignoring genuine 2nd-finger and trailing post-up lostpointercapture', async () => {
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

    // 1. Active hold -> genuine non-primary 2nd finger (isPrimary: false) MUST NOT steal/cancel active hold
    dispatchPointer(input, 'pointerdown', 180, 500, 1);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    const secondFinger = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(secondFinger, { clientX: 200, clientY: 500, pointerId: 2, button: 0, pointerType: 'touch', isPrimary: false });
    fireEvent(input, secondFinger);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();

    // 2. Unexpected lostpointercapture (buttons=0) with swallowed pointerup -> next primary hold (pointerId=2) retires old hold & starts #2
    const lost = new Event('lostpointercapture', { bubbles: true, cancelable: false });
    Object.assign(lost, { pointerId: 1, pointerType: 'touch', isPrimary: true, buttons: 0 });
    fireEvent(input, lost);
    await vi.advanceTimersByTimeAsync(0);
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.stopListening).toHaveBeenCalledWith({ abort: true });
    expect(voiceMock.startListening).toHaveBeenCalledTimes(2);

    // 3. Swallowed terminal event with NO lostpointercapture, then same/reused pointerId=2 -> recovers cleanly & starts #3
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(3);

    // 4. lostpointercapture (buttons=0) -> direct fireEvent.click(input) unlocks contenteditable="true" & focuses
    const lost3 = new Event('lostpointercapture', { bubbles: true, cancelable: false });
    Object.assign(lost3, { pointerId: 2, pointerType: 'touch', isPrimary: true, buttons: 0 });
    fireEvent(input, lost3);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    input.textContent = 'Recovered via click';
    fireEvent.input(input);
    expect(input.textContent).toBe('Recovered via click');

    // Blur back to voice-ready state
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // 5. setPointerCapture failure + swallowed pending pointerup (<240ms) -> new primary tap still enters typing cleanly
    (input as any).setPointerCapture = () => { throw new Error('capture failed'); };
    dispatchPointer(input, 'pointerdown', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(20); // no pointerup!
    dispatchPointer(input, 'pointerdown', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(140);
    dispatchPointer(input, 'pointerup', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(3);

    // Blur back -> trailing lostpointercapture after normal pointerup MUST NOT abort send drain
    input.blur();
    fireEvent.blur(input);
    let releaseSendDrain!: () => void;
    voiceMock.stopListening.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { releaseSendDrain = r; });
      voiceMock.partialHandler?.('tail survives trailing lostcapture');
    });
    dispatchPointer(input, 'pointerdown', 180, 500, 5);
    await vi.advanceTimersByTimeAsync(240);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(4);
    dispatchPointer(input, 'pointerup', 180, 500, 5);
    const trailingLost = new Event('lostpointercapture', { bubbles: true, cancelable: false });
    Object.assign(trailingLost, { pointerId: 5, pointerType: 'touch', isPrimary: true, buttons: 0 });
    fireEvent(input, trailingLost);
    releaseSendDrain();
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'Recovered via click tail survives trailing lostcapture',
    }));
  });

  it('defers setPointerCapture until hold activates, promotes horizontal slide-hold right after 140ms tap-guard (145ms), keeps focused 240ms vs unfocused 175ms distinct, and invokes passive prewarm', async () => {
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
    const setPointerCaptureSpy = vi.fn();
    (input as any).setPointerCapture = setPointerCaptureSpy;

    // passive prewarm ran on mobile voice-ready mount without prompting permission
    expect(voiceMock.prewarm).toHaveBeenCalledWith({ requestPermission: false });
    voiceMock.prewarm.mockClear();

    // 1. pointerdown calls passive prewarm and does NOT call setPointerCapture during pending phase
    dispatchPointer(input, 'pointerdown', 180, 500, 1);
    expect(voiceMock.prewarm).toHaveBeenCalledWith({ requestPermission: false });
    expect(setPointerCaptureSpy).not.toHaveBeenCalled();

    // 2. Horizontal slide past 90ms debounce does NOT prematurely fire inside <=140ms single-tap guard; promotes cleanly at 145ms (<175ms) even if setPointerCapture throws
    setPointerCaptureSpy.mockImplementationOnce(() => { throw new Error('unsupported'); });
    await vi.advanceTimersByTimeAsync(95);
    dispatchPointer(input, 'pointermove', 200, 502, 1); // dx = +20, dy = +2
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(setPointerCaptureSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(45); // total 140ms — still guarded
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5); // total 145ms — slide-intent promotes early (<175ms stationary / <240ms focused)
    expect(setPointerCaptureSpy).toHaveBeenCalledWith(1);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    dispatchPointer(input, 'pointermove', 110, 502, 1); // slide left -> cancel
    dispatchPointer(input, 'pointerup', 110, 502, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).not.toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('false');

    // 3. Focused composer NEVER triggers voice capture or applies touch/selection locks (100% native selection/IME/copy-paste)
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(60);
    dispatchPointer(input, 'pointerup', 180, 500, 2);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('true');

    dispatchPointer(input, 'pointerdown', 180, 500, 3);
    await vi.advanceTimersByTimeAsync(500);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1); // NEVER triggered while already focused
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.querySelector('.controls-composer-voice-pending')).toBeNull();
    expect(document.querySelector('.controls-composer-voice-holding')).toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.style.userSelect).toBe('');
    expect(input.style.getPropertyValue('-webkit-touch-callout')).toBe('');
    expect(document.activeElement).toBe(input);
    const selectEv = new Event('selectstart', { bubbles: true, cancelable: true });
    const ctxEv = new Event('contextmenu', { bubbles: true, cancelable: true });
    expect(input.dispatchEvent(selectEv)).toBe(true);
    expect(input.dispatchEvent(ctxEv)).toBe(true);
    dispatchPointer(input, 'pointerup', 180, 500, 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('true');
  });

  it('guarantees click-to-type fallback across every failed or pre-recording aborted hold path without hijacking strong vertical scroll or explicit slide-to-cancel', async () => {
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
    const resetToUnfocused = async () => {
      input.blur();
      fireEvent.blur(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('false');
    };

    // 1. Small movement slop (<40px vertical scroll, <90ms) aborts pending hold and falls back to typing focus
    dispatchPointer(input, 'pointerdown', 180, 500, 1);
    await vi.advanceTimersByTimeAsync(40);
    dispatchPointer(input, 'pointermove', 204, 504, 1); // dist ~24.3 > 18 slop
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    dispatchPointer(input, 'pointerup', 204, 504, 1);
    await resetToUnfocused();

    // 2. Strong vertical scroll swipe (>=40px vertical & vertical-dominant) aborts without popping open keyboard
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(40);
    dispatchPointer(input, 'pointermove', 182, 452, 2); // dy = -48
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(input);

    // 3. Pending pointercancel (<175ms) falls back cleanly to typing focus
    dispatchPointer(input, 'pointerdown', 180, 500, 3);
    await vi.advanceTimersByTimeAsync(80);
    dispatchPointer(input, 'pointercancel', 180, 500, 3);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    await resetToUnfocused();

    // 4. pointercancel while startListening is still starting (!didStartRecording) aborts cleanly and focuses composer
    let resolvePendingStart!: (ok: boolean) => void;
    voiceMock.startListening.mockImplementationOnce(() => new Promise<boolean>((r) => { resolvePendingStart = r; }));
    dispatchPointer(input, 'pointerdown', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(175);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    dispatchPointer(input, 'pointercancel', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    resolvePendingStart(false);
    await vi.advanceTimersByTimeAsync(0);
    await resetToUnfocused();

    // 5. Blocked by active prior drain -> overlapping hold restores typing focus without disrupting drain
    let resolveSlowStop!: () => void;
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { resolveSlowStop = r; }));
    dispatchPointer(input, 'pointerdown', 180, 500, 5);
    await vi.advanceTimersByTimeAsync(175);
    voiceMock.partialHandler?.('first drain phrase');
    dispatchPointer(input, 'pointerup', 180, 500, 5);
    await vi.advanceTimersByTimeAsync(0);

    dispatchPointer(input, 'pointerdown', 180, 500, 6);
    await vi.advanceTimersByTimeAsync(175);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(2); // did not start 3rd hold
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    dispatchPointer(input, 'pointerup', 180, 500, 6);
    resolveSlowStop();
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'first drain phrase',
    }));
    await resetToUnfocused();

    // 6. startListening rejecting or firing permission_denied immediately falls back to typing focus
    voiceMock.startListening.mockRejectedValueOnce(new Error('permission_denied'));
    dispatchPointer(input, 'pointerdown', 180, 500, 7);
    await vi.advanceTimersByTimeAsync(175);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-error-banner')).not.toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    dispatchPointer(input, 'pointerup', 180, 500, 7);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('fixes Round 1 F1 & F2: restores click focus on lostpointercapture/cancel before recording starts and keeps <=140ms slide-drifted taps safe', async () => {
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
    const dispatchPrimaryPointer = (
      el: EventTarget,
      type: string,
      clientX: number,
      clientY: number,
      pointerId: number,
      buttons: number,
    ) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { clientX, clientY, pointerId, pointerType: 'touch', isPrimary: true, button: 0, buttons });
      fireEvent(el, event);
    };
    const resetToUnfocused = async () => {
      input.blur();
      fireEvent.blur(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('false');
    };

    // F1-A: lostpointercapture during starting (!didStartRecording, buttons=0 from blur/setPointerCapture)
    // must keep the hold alive on window listeners; window pointerup completes/sends once started,
    // and only actual start failure falls back to typing focus.
    let resolveLateStart!: (ok: boolean) => void;
    voiceMock.startListening.mockImplementationOnce((
      onResult: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      voiceMock.partialHandler = onResult;
      voiceMock.listeningHandler = onListeningChange ?? null;
      voiceMock.errorHandler = onError ?? null;
      return new Promise<boolean>((r) => { resolveLateStart = r; });
    });
    dispatchPrimaryPointer(input, 'pointerdown', 180, 500, 11, 1);
    await vi.advanceTimersByTimeAsync(175);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    dispatchPrimaryPointer(input, 'lostpointercapture', 180, 500, 11, 0);
    await vi.advanceTimersByTimeAsync(0);
    // Hold stays alive on window listeners even though lostpointercapture had buttons=0
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    expect(voiceMock.stopListening).not.toHaveBeenCalled();
    resolveLateStart(true);
    voiceMock.listeningHandler?.(true);
    voiceMock.partialHandler?.('captured despite lostpointercapture');
    await vi.advanceTimersByTimeAsync(0);
    dispatchPrimaryPointer(window, 'pointerup', 180, 500, 11, 0);
    await vi.advanceTimersByTimeAsync(300);
    expect(voiceMock.stopListening).toHaveBeenCalled();
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'captured despite lostpointercapture',
    }));
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(input);

    // F1-A2: If start actually fails (resolve(false)) while captureLost=true, still restores focus cleanly
    let resolveFailStart!: (ok: boolean) => void;
    voiceMock.startListening.mockImplementationOnce(() => new Promise<boolean>((r) => { resolveFailStart = r; }));
    dispatchPrimaryPointer(input, 'pointerdown', 180, 500, 110, 1);
    await vi.advanceTimersByTimeAsync(175);
    dispatchPrimaryPointer(input, 'lostpointercapture', 180, 500, 110, 0);
    resolveFailStart(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    await resetToUnfocused();

    // F1-B: lostpointercapture during pending (!tx, buttons=0) is non-terminal: keeps hold alive on window listeners,
    // adopts at 175ms, while window short-tap pointerup/cancel or direct click still focuses composer cleanly
    voiceMock.startListening.mockClear();
    dispatchPrimaryPointer(input, 'pointerdown', 180, 500, 12, 1);
    await vi.advanceTimersByTimeAsync(50);
    dispatchPrimaryPointer(input, 'lostpointercapture', 180, 500, 12, 0);
    await vi.advanceTimersByTimeAsync(125); // 50 + 125 = 175ms
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    dispatchPrimaryPointer(window, 'pointerup', 180, 500, 12, 0);
    await vi.advanceTimersByTimeAsync(0);
    await resetToUnfocused();

    // Pending lostpointercapture at 50ms + window short-tap pointerup at 70ms silently cancels & focuses
    voiceMock.startListening.mockClear();
    dispatchPrimaryPointer(input, 'pointerdown', 180, 500, 13, 1);
    await vi.advanceTimersByTimeAsync(50);
    dispatchPrimaryPointer(input, 'lostpointercapture', 180, 500, 13, 0);
    await vi.advanceTimersByTimeAsync(20);
    dispatchPrimaryPointer(window, 'pointerup', 180, 500, 13, 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    await resetToUnfocused();

    // Pending orphaned lostpointercapture (no pointerup) + direct click retires & focuses
    voiceMock.startListening.mockClear();
    dispatchPrimaryPointer(input, 'pointerdown', 180, 500, 14, 1);
    await vi.advanceTimersByTimeAsync(50);
    dispatchPrimaryPointer(input, 'lostpointercapture', 180, 500, 14, 0);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(200);
    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    await resetToUnfocused();

    // F1-C: startListening fails (resolve(false)) / rejects / emits error AFTER sliding into cancel zone while !didStartRecording -> STILL focuses!
    for (const [idx, failMode] of (['resolveFalse', 'reject', 'onErrorFalse'] as const).entries()) {
      const pid = 20 + idx;
      if (failMode === 'resolveFalse') {
        voiceMock.startListening.mockResolvedValueOnce(false);
      } else if (failMode === 'reject') {
        voiceMock.startListening.mockRejectedValueOnce(new Error('permission_denied'));
      } else {
        voiceMock.startListening.mockImplementationOnce(async (_r, _l, onError) => {
          onError?.('permission_denied');
          return false;
        });
      }
      dispatchPrimaryPointer(input, 'pointerdown', 180, 500, pid, 1);
      await vi.advanceTimersByTimeAsync(175);
      // Slide into cancel zone BEFORE or AFTER startListening fails while !didStartRecording
      dispatchPrimaryPointer(input, 'pointermove', 90, 500, pid, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
      dispatchPrimaryPointer(input, 'pointerup', 90, 500, pid, 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
      await resetToUnfocused();
    }

    // F1-D: Positive control — AFTER didStartRecording=true, lostpointercapture + window slide-to-cancel keeps composer unfocused
    voiceMock.stopListening.mockClear();
    dispatchPrimaryPointer(input, 'pointerdown', 180, 500, 30, 1);
    await vi.advanceTimersByTimeAsync(175);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    dispatchPrimaryPointer(input, 'lostpointercapture', 180, 500, 30, 0);
    await vi.advanceTimersByTimeAsync(0);
    // Recording stays alive on window listener
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('false');
    dispatchPrimaryPointer(window, 'pointermove', 90, 500, 30, 1);
    dispatchPrimaryPointer(window, 'pointerup', 90, 500, 30, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceMock.stopListening).toHaveBeenCalled();
    expect(input.getAttribute('contenteditable')).toBe('false');
    expect(document.activeElement).not.toBe(input);

    // F2: <=140ms taps with thumb drift (dx=14, 15, 18 across 95..140ms) MUST NEVER start voice & MUST focus cleanly without orphaned slide timers
    voiceMock.startListening.mockClear();
    for (const [idx, dx] of ([14, 15, 18] as const).entries()) {
      const pid = 40 + idx;
      dispatchPrimaryPointer(input, 'pointerdown', 180, 500, pid, 1);
      await vi.advanceTimersByTimeAsync(95);
      dispatchPrimaryPointer(input, 'pointermove', 180 + dx, 501, pid, 1);
      expect(voiceMock.startListening).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(45); // total 140ms — still inside single-tap guard
      expect(voiceMock.startListening).not.toHaveBeenCalled();
      dispatchPrimaryPointer(input, 'pointerup', 180 + dx, 501, pid, 0);
      await vi.advanceTimersByTimeAsync(200); // verify slide timer was cleared and never fires orphaned
      expect(voiceMock.startListening).not.toHaveBeenCalled();
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
      await resetToUnfocused();
    }
  });

  it('fixes Round 2 F1-R2 with real VoiceInput: async Web Speech not-allowed after synchronous rec.start() restores focus, while actual audiostart + cancel keeps keyboard closed and fences stale sessions', async () => {
    const realVoice = await vi.importActual<typeof import('../../src/components/VoiceInput.js')>('../../src/components/VoiceInput.js');
    const instances: Array<{
      onstart?: () => void;
      onaudiostart?: () => void;
      onresult?: (e: any) => void;
      onerror?: (e: any) => void;
      onend?: () => void;
      start: () => void;
      stop: () => void;
      abort: () => void;
    }> = [];
    class FakeSpeechRecognition {
      onstart?: () => void;
      onaudiostart?: () => void;
      onresult?: (e: any) => void;
      onerror?: (e: any) => void;
      onend?: () => void;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        instances.push(this);
      }
    }

    const origIsAvailable = voiceMock.isAvailable.getMockImplementation();
    const origPrewarm = voiceMock.prewarm.getMockImplementation();
    const origStart = voiceMock.startListening.getMockImplementation();
    const origStop = voiceMock.stopListening.getMockImplementation();
    const origLevel = voiceMock.onAudioLevel.getMockImplementation();

    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    vi.stubGlobal('SpeechRecognition', FakeSpeechRecognition);
    voiceMock.isAvailable.mockImplementation((...a: Parameters<typeof realVoice.isAvailable>) => realVoice.isAvailable(...a));
    voiceMock.prewarm.mockImplementation((...a: Parameters<typeof realVoice.prewarm>) => realVoice.prewarm(...a));
    voiceMock.startListening.mockImplementation((...a: Parameters<typeof realVoice.startListening>) => realVoice.startListening(...a));
    voiceMock.stopListening.mockImplementation((...a: Parameters<typeof realVoice.stopListening>) => realVoice.stopListening(...a));
    voiceMock.onAudioLevel.mockImplementation((...a: Parameters<typeof realVoice.onAudioLevel>) => realVoice.onAudioLevel(...a));

    try {
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
      const resetToUnfocused = async () => {
        input.blur();
        fireEvent.blur(input);
        await vi.advanceTimersByTimeAsync(0);
        expect(input.getAttribute('contenteditable')).toBe('false');
      };

      // 1. Auditor exact counterexample: 175ms -> rec.start() returns without onstart/onaudiostart -> 176ms async not-allowed -> pointerup -> error banner, no send, CE=true & focused!
      dispatchPointer(input, 'pointerdown', 180, 500, 1);
      await vi.advanceTimersByTimeAsync(175);
      expect(instances).toHaveLength(1);
      expect(instances[0].start).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      instances[0].onerror?.({ error: 'not-allowed' });
      await vi.advanceTimersByTimeAsync(0);
      dispatchPointer(input, 'pointerup', 180, 500, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.voice-hold-error-banner')).not.toBeNull();
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
      await resetToUnfocused();

      // 2. Stale old rec1.onstart/onaudiostart firing after new session starts MUST NOT taint rec2 -> async not-allowed on rec2 STILL focuses!
      dispatchPointer(input, 'pointerdown', 180, 500, 2);
      await vi.advanceTimersByTimeAsync(175);
      expect(instances).toHaveLength(2);
      instances[0].onstart?.();
      instances[0].onaudiostart?.();
      instances[1].onerror?.({ error: 'service-not-allowed' });
      await vi.advanceTimersByTimeAsync(0);
      dispatchPointer(input, 'pointerup', 180, 500, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('true');
      expect(document.activeElement).toBe(input);
      await resetToUnfocused();

      // 3. Positive control: actual rec.onaudiostart fires -> genuine capture -> slide left into cancel & release keeps keyboard closed (CE=false, unfocused)
      dispatchPointer(input, 'pointerdown', 180, 500, 3);
      await vi.advanceTimersByTimeAsync(175);
      expect(instances).toHaveLength(3);
      instances[2].onaudiostart?.();
      dispatchPointer(input, 'pointermove', 90, 500, 3);
      dispatchPointer(input, 'pointerup', 90, 500, 3);
      await vi.advanceTimersByTimeAsync(0);
      expect(instances[2].abort).toHaveBeenCalled();
      expect(input.getAttribute('contenteditable')).toBe('false');
      expect(document.activeElement).not.toBe(input);
      expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    } finally {
      await realVoice.stopListening({ abort: true });
      vi.unstubAllGlobals();
      if (origIsAvailable) voiceMock.isAvailable.mockImplementation(origIsAvailable);
      if (origPrewarm) voiceMock.prewarm.mockImplementation(origPrewarm);
      if (origStart) voiceMock.startListening.mockImplementation(origStart);
      if (origStop) voiceMock.stopListening.mockImplementation(origStop);
      if (origLevel) voiceMock.onAudioLevel.mockImplementation(origLevel);
    }
  });

  it('tapping unfocused composer with existing text moves caret to END and prevents compat mousedown reset, while focused taps keep caret undisturbed and active hold tolerates pre-start lostpointercapture', async () => {
    voiceMock.startListening.mockImplementation(async (
      onResult: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      voiceMock.partialHandler = onResult;
      voiceMock.listeningHandler = onListeningChange ?? null;
      voiceMock.errorHandler = onError ?? null;
      return true;
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

    const dispatchPrimary = (el: EventTarget, type: string, clientX = 180, clientY = 500, pointerId = 1, buttons = 1) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
      Object.assign(ev, { clientX, clientY, pointerId, button: 0, pointerType: 'touch', isPrimary: true, buttons });
      return fireEvent(el, ev);
    };
    const input = document.querySelector('.controls-input') as HTMLElement;
    input.textContent = 'hello world';

    // 1. Short touch tap on unfocused composer puts caret at END (11) and shields compat mousedown targeting input itself
    dispatchPrimary(input, 'pointerdown', 10, 500, 21, 1);
    await vi.advanceTimersByTimeAsync(50);
    dispatchPrimary(input, 'pointerup', 10, 500, 21, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('true');
    const selAfterTap = window.getSelection();
    expect(selAfterTap?.isCollapsed).toBe(true);
    expect(selAfterTap?.focusNode).toBe(input);
    expect(selAfterTap?.focusOffset).toBe(input.childNodes.length);

    const compatMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    input.dispatchEvent(compatMouseDown);
    expect(compatMouseDown.defaultPrevented).toBe(true);
    expect(window.getSelection()?.focusNode).toBe(input);
    expect(window.getSelection()?.focusOffset).toBe(input.childNodes.length);

    // 2. While already focused, user moves caret into middle of text and taps -> caret stays at offset 3 (NOT reset to end)
    const range = document.createRange();
    const textNode = input.firstChild as Text;
    range.setStart(textNode, 3);
    range.collapse(true);
    selAfterTap?.removeAllRanges();
    selAfterTap?.addRange(range);
    dispatchPrimary(input, 'pointerdown', 40, 500, 22, 1);
    dispatchPrimary(input, 'pointerup', 40, 500, 22, 0);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.getSelection()?.focusOffset).toBe(3);

    // 3. After blurring back to unfocused voice-ready, active hold whose lostpointercapture fires with buttons=1 BEFORE didStartRecording keeps recording alive
    input.blur();
    fireEvent.blur(input);
    await vi.advanceTimersByTimeAsync(100);
    expect(input.getAttribute('contenteditable')).toBe('false');

    dispatchPrimary(input, 'pointerdown', 180, 500, 23, 1);
    await vi.advanceTimersByTimeAsync(175);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
    dispatchPrimary(input, 'lostpointercapture', 180, 500, 23, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).not.toBeNull();
    expect(voiceMock.stopListening).not.toHaveBeenCalled();

    voiceMock.listeningHandler?.(true);
    voiceMock.partialHandler?.('voice text ok');
    dispatchPrimary(input, 'pointerup', 180, 500, 23, 0);
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
  });

  it('moves caret to END on initial mobile tap even when VoiceInput is unavailable and focus runs before click, while keeping subsequent middle taps and desktop clicks native', async () => {
    voiceMock.isAvailable.mockReturnValue(false);
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

    const dispatchPrimary = (el: EventTarget, type: string, clientX = 10, clientY = 500, pointerId = 31) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
      Object.assign(ev, { clientX, clientY, pointerId, button: 0, pointerType: 'touch', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1 });
      return fireEvent(el, ev);
    };

    const input = document.querySelector('.controls-input') as HTMLElement;
    expect(input.getAttribute('contenteditable')).toBe('true');
    input.textContent = 'line 1\nexisting message';
    const textNode = input.firstChild as Text;

    // 1. Real mobile tap order when VoiceInput unavailable: pointerdown -> pointerup -> native mousedown/focus at offset 0 -> click
    dispatchPrimary(input, 'pointerdown', 10, 500, 31);
    dispatchPrimary(input, 'pointerup', 10, 500, 31);
    input.focus();
    const sel = window.getSelection();
    const zeroRange = document.createRange();
    zeroRange.setStart(textNode, 0);
    zeroRange.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(zeroRange);
    fireEvent.focus(input);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(0);

    expect(document.activeElement).toBe(input);
    expect(window.getSelection()?.focusNode).toBe(input);
    expect(window.getSelection()?.focusOffset).toBe(input.childNodes.length);

    // 2. Subsequent tap while already focused keeps tapped middle offset (e.g. 5) intact
    const midRange = document.createRange();
    midRange.setStart(textNode, 5);
    midRange.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(midRange);
    dispatchPrimary(input, 'pointerdown', 40, 500, 32);
    dispatchPrimary(input, 'pointerup', 40, 500, 32);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.getSelection()?.focusOffset).toBe(5);

    // 3. Desktop positive control: unfocused click at middle offset MUST NOT jump caret to end
    input.blur();
    fireEvent.blur(input);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    rerender(
      <SessionControls
        ws={ws}
        activeSession={makeSession()}
        quickData={makeQuickData()}
        sessions={[]}
        subSessions={[]}
        serverId="srv-1"
      />,
    );
    fireEvent.pointerDown(input, { clientX: 40, clientY: 500, pointerId: 33, button: 0, pointerType: 'mouse', isPrimary: true });
    input.focus();
    const desktopMid = document.createRange();
    desktopMid.setStart(textNode, 4);
    desktopMid.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(desktopMid);
    fireEvent.focus(input);
    fireEvent.click(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(window.getSelection()?.focusNode).toBe(textNode);
    expect(window.getSelection()?.focusOffset).toBe(4);
  });

  it('recovers hold-to-talk when soft keyboard dismisses without blur while leaving hardware-keyboard and open-IME focus untouched', async () => {
    const origVV = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const origInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const vv = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    vv.height = 844;
    vv.offsetTop = 0;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });

    voiceMock.startListening.mockImplementation(async (
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

    try {
      const ws = { connected: true, send: vi.fn(), sendSessionCommand: vi.fn(), onMessage: vi.fn(() => () => {}) } as any;
      const { unmount } = render(
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
      expect(input.getAttribute('contenteditable')).toBe('false');
      const sendTouchPointer = (target: EventTarget, type: string, pointerId: number, buttons: number) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(ev, { clientX: 120, clientY: 500, pointerId, button: 0, buttons, pointerType: 'touch', isPrimary: true });
        fireEvent(target, ev);
      };

      // 1. Tap to open edit mode; hardware keyboard + synchronous browser-chrome resize (844 -> 780 -> 844) must NEVER auto-blur
      sendTouchPointer(input, 'pointerdown', 1, 1);
      await vi.advanceTimersByTimeAsync(40);
      sendTouchPointer(input, 'pointerup', 1, 0);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('contenteditable')).toBe('true');

      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 780 });
      vv.height = 780;
      window.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(250);
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('contenteditable')).toBe('true');

      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
      vv.height = 844;
      window.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(250);
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('contenteditable')).toBe('true');

      // 2. Soft keyboard opens (844 -> 500) and resizes candidate bar (500 -> 470): must remain focused & editable
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
      vv.height = 470;
      vv.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(250);
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('contenteditable')).toBe('true');

      // Long press while keyboard is open still stays native (must NOT hijack to voice)
      sendTouchPointer(input, 'pointerdown', 2, 1);
      await vi.advanceTimersByTimeAsync(250);
      expect(voiceMock.startListening).not.toHaveBeenCalled();
      sendTouchPointer(input, 'pointerup', 2, 0);

      // 3. WebKit delayed height update on dismiss: resize fires BEFORE vv.height flips back to 844 (no 2nd event)
      vv.dispatchEvent(new Event('resize')); // vv.height is still 470 when event arrives
      vv.height = 844; // geometry updates asynchronously after callback without a second resize event
      await vi.advanceTimersByTimeAsync(250);
      expect(document.activeElement).not.toBe(input);
      expect(input.getAttribute('contenteditable')).toBe('false');

      // Subsequent hold-to-talk works cleanly and sends transcript
      sendTouchPointer(input, 'pointerdown', 3, 1);
      await vi.advanceTimersByTimeAsync(175);
      expect(voiceMock.startListening).toHaveBeenCalledTimes(1);
      voiceMock.partialHandler?.('recovered after keyboard dismiss');
      sendTouchPointer(window, 'pointerup', 3, 0);
      await vi.advanceTimersByTimeAsync(300);
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        text: 'recovered after keyboard dismiss',
      }));

      // 4. Cleanup cancels pending settle timer/frames on unmount without calling blur after unmount
      sendTouchPointer(input, 'pointerdown', 4, 1);
      await vi.advanceTimersByTimeAsync(40);
      sendTouchPointer(input, 'pointerup', 4, 0);
      await vi.advanceTimersByTimeAsync(0);
      vv.height = 500;
      vv.dispatchEvent(new Event('resize'));
      await vi.advanceTimersByTimeAsync(250);
      const blurSpy = vi.spyOn(input, 'blur');
      vv.dispatchEvent(new Event('resize')); // queues rAF + 200ms settle timer
      vv.height = 844;
      unmount();
      await vi.advanceTimersByTimeAsync(250);
      expect(blurSpy).not.toHaveBeenCalled();
    } finally {
      if (origVV) Object.defineProperty(window, 'visualViewport', origVV);
      else Reflect.deleteProperty(window, 'visualViewport');
      if (origInnerHeight) Object.defineProperty(window, 'innerHeight', origInnerHeight);
      else Reflect.deleteProperty(window, 'innerHeight');
    }
  });

  it('tracks honest starting -> listening -> recognizing -> ended transitions and never freezes HUD on zero-level recognition when backend stops', async () => {
    voiceMock.startListening.mockImplementation(async (
      onResult: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      voiceMock.partialHandler = onResult;
      voiceMock.listeningHandler = onListeningChange ?? null;
      voiceMock.errorHandler = onError ?? null;
      return true;
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
    const resetToUnfocused = async () => {
      input.blur();
      fireEvent.blur(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('false');
    };

    // 1. Before listening(true) arrives: starting phase shows voice.starting, NEVER fake recognizing / 0-dot active robot
    dispatchPointer(input, 'pointerdown', 180, 500, 1);
    await vi.advanceTimersByTimeAsync(175);
    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud).not.toBeNull();
    expect(hud.getAttribute('data-phase')).toBe('starting');
    expect(hud.textContent).toContain('voice.starting');
    expect(hud.textContent).not.toContain('voice.recognizing');
    expect(hud.textContent).not.toContain('voice.buffering_hint');
    expect(hud.querySelector('.voice-streaming-robot-cursor.is-active')).toBeNull();
    expect(hud.querySelector('.voice-hold-hud-waveform.is-ambient-wave')).toBeNull();

    // 2. listening(true) without audio level (e.g. mobile Web skipping getUserMedia): recording + ambient wave, voice.listening + speak_now
    voiceMock.listeningHandler?.(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-phase')).toBe('recording');
    expect(hud.textContent).toContain('voice.listening');
    expect(hud.textContent).toContain('voice.speak_now');
    expect(hud.querySelector('.voice-hold-hud-waveform.is-ambient-wave')).not.toBeNull();

    // Real audioLevel disables CSS ambient wave and activates recognizing + live bars
    voiceMock.levelHandler?.(0.5);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.querySelector('.voice-hold-hud-waveform.is-ambient-wave')).toBeNull();
    expect(hud.textContent).toContain('voice.recognizing');
    expect(hud.querySelector('.voice-streaming-robot-cursor.is-active')).not.toBeNull();

    // 3. Backend emits listening(false) cleanly while finger still held -> HUD stops lying, switches to ended / no_speech, flattens bars
    voiceMock.listeningHandler?.(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.getAttribute('data-phase')).toBe('ended');
    expect(hud.textContent).toContain('voice.no_speech');
    expect(hud.textContent).not.toContain('voice.recognizing');
    expect(hud.textContent).not.toContain('voice.buffering_hint');
    expect(hud.querySelector('.voice-streaming-robot-cursor.is-active')).toBeNull();
    expect(hud.querySelector('.voice-hold-hud-waveform.is-ended')).not.toBeNull();
    expect(hud.querySelector('.voice-hold-hud-waveform.is-ambient-wave')).toBeNull();
    Array.from(hud.querySelectorAll('.voice-hold-hud-bar')).forEach((bar) => {
      expect((bar as HTMLElement).style.height).toBe('5px');
    });

    // Slide to cancel after ended still updates zone and closes cleanly without sending
    dispatchPointer(input, 'pointermove', 90, 500, 1);
    expect(hud.getAttribute('data-zone')).toBe('cancel');
    dispatchPointer(input, 'pointerup', 90, 500, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // 4. Premature listening(false) while still in starting (!didStartRecording) fails cleanly with banner & restores typing focus
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(175);
    voiceMock.listeningHandler?.(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.querySelector('.voice-hold-error-banner')).not.toBeNull();
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);
    dispatchPointer(input, 'pointerup', 180, 500, 2);
    await resetToUnfocused();
  });

  it('bounds unconfirmed starting phase via startup timeout, promotes on partial speech, and recovers cleanly for immediate retry', async () => {
    voiceMock.startListening.mockImplementation(async (
      onResult: (partial: string) => void,
      onListeningChange?: (listening: boolean) => void,
      onError?: (error: string) => void,
    ) => {
      voiceMock.partialHandler = onResult;
      voiceMock.listeningHandler = onListeningChange ?? null;
      voiceMock.errorHandler = onError ?? null;
      // Intentionally simulate backend resolving true without emitting onListeningChange(true)
      return true;
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
    const resetToUnfocused = async () => {
      input.blur();
      fireEvent.blur(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(input.getAttribute('contenteditable')).toBe('false');
    };

    // 1. Stuck in 'starting' with never-firing listening(true) fails cleanly after VOICE_HOLD_START_TIMEOUT_MS (10s)
    dispatchPointer(input, 'pointerdown', 180, 500, 1);
    await vi.advanceTimersByTimeAsync(175);
    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud).not.toBeNull();
    expect(hud.getAttribute('data-phase')).toBe('starting');

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(voiceMock.stopListening).toHaveBeenCalledWith({ abort: true });
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.querySelector('.voice-hold-error-banner')?.textContent).toBe('voice.error');
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(document.activeElement).toBe(input);

    // Late release after timeout does not crash or re-open HUD; blurring allows immediate next hold
    dispatchPointer(input, 'pointerup', 180, 500, 1);
    await resetToUnfocused();

    // 2. Partial speech arriving while still in 'starting' promotes phase to 'recording' and cancels timeout
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(175);
    const hud2 = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud2.getAttribute('data-phase')).toBe('starting');

    voiceMock.partialHandler?.('hello mobile');
    await vi.advanceTimersByTimeAsync(0);
    expect(hud2.getAttribute('data-phase')).toBe('recording');
    expect(hud2.textContent).toContain('hello mobile');

    // Advancing past 10s now MUST NOT fail because capture already promoted to 'recording'
    await vi.advanceTimersByTimeAsync(10_500);
    expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-phase')).toBe('recording');

    dispatchPointer(input, 'pointerup', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(300);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: 'hello mobile',
    }));
  });

  it('retired cancelled hold startPromise false/reject cannot disarm next hold 10s starting watchdog (F1)', async () => {
    vi.useFakeTimers();
    try {
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
      const runScenario = async (
        settleA: (resolve: (v: boolean) => void, reject: (err: unknown) => void) => void,
        pointerBase: number,
      ) => {
        expect(input.getAttribute('contenteditable')).toBe('false');
        // Hold A starts and leaves its startListening promise pending
        let resolveA!: (v: boolean) => void;
        let rejectA!: (err: unknown) => void;
        const startPromiseA = new Promise<boolean>((resolve, reject) => {
          resolveA = resolve;
          rejectA = reject;
        });
        voiceMock.startListening.mockReturnValueOnce(startPromiseA);

        dispatchPointer(input, 'pointerdown', 180, 500, pointerBase);
        await vi.advanceTimersByTimeAsync(175);
        expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-phase')).toBe('starting');

        // User slides left into cancel zone and releases pointer -> Hold A cancelled while startPromiseA is pending
        dispatchPointer(input, 'pointermove', 30, 500, pointerBase);
        await vi.advanceTimersByTimeAsync(0);
        dispatchPointer(input, 'pointerup', 30, 500, pointerBase);
        await vi.advanceTimersByTimeAsync(0);
        expect(voiceMock.stopListening).toHaveBeenCalledWith({ abort: true });
        expect(document.querySelector('.voice-hold-hud')).toBeNull();

        // Pre-recording cancel restores typing focus; blur back to unfocused voice-ready mode for Hold B
        input.blur();
        fireEvent.blur(input);
        await vi.advanceTimersByTimeAsync(0);

        // Hold B starts: startListening resolves true, but no listeningState/partial event arrives yet (stays 'starting')
        expect(input.getAttribute('contenteditable')).toBe('false');
        voiceMock.startListening.mockResolvedValueOnce(true);
        dispatchPointer(input, 'pointerdown', 180, 500, pointerBase + 1);
        await vi.advanceTimersByTimeAsync(175);
        const hudB = document.querySelector('.voice-hold-hud') as HTMLElement;
        expect(hudB?.getAttribute('data-phase')).toBe('starting');

        // Stale Hold A startPromise now resolves false / rejects late
        settleA(resolveA, rejectA);
        await vi.advanceTimersByTimeAsync(0);

        // Hold B must still be in 'starting' with its 10s watchdog intact (not failed by A, not disarmed!)
        expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-phase')).toBe('starting');
        await vi.advanceTimersByTimeAsync(10_000);

        // B's 10s watchdog MUST fire cleanly instead of hanging permanently on 'starting'
        expect(document.querySelector('.voice-hold-hud')).toBeNull();
        expect(document.querySelector('.voice-hold-error-banner')?.textContent).toBe('voice.error');

        dispatchPointer(input, 'pointerup', 180, 500, pointerBase + 1);
        input.blur();
        fireEvent.blur(input);
        await vi.advanceTimersByTimeAsync(0);
      };

      await runScenario((resolve) => resolve(false), 10);
      await runScenario((_resolve, reject) => reject(new Error('late A reject')), 20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps HUD & transcript bubble alive in data-phase="draining" while stopListening drains, updates trailing partials live, animates progressive drop-into-composer over 300ms, then sends', async () => {
    let releaseStop!: () => void;
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseStop = r; }));
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

    const composer = document.querySelector('.controls-composer') as HTMLElement;
    const input = document.querySelector('.controls-input') as HTMLElement;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({
      x: 16, y: 740, left: 16, top: 740, right: 336, bottom: 788, width: 320, height: 48, toJSON: () => ({}),
    } as DOMRect);

    dispatchPointer(input, 'pointerdown', 180, 500, 1);
    await vi.advanceTimersByTimeAsync(175);
    voiceMock.listeningHandler?.(true);
    voiceMock.partialHandler?.('初始语音');
    await vi.advanceTimersByTimeAsync(0);

    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    const transcriptEl = hud.querySelector('.voice-hold-hud-transcript') as HTMLElement;
    expect(transcriptEl.textContent).toBe('初始语音');
    vi.spyOn(transcriptEl, 'getBoundingClientRect').mockReturnValue({
      x: 40, y: 240, left: 40, top: 240, right: 320, bottom: 300, width: 280, height: 60, toJSON: () => ({}),
    } as DOMRect);

    // Release finger while stopListening is still pending -> MUST remain open in data-phase="draining"
    dispatchPointer(input, 'pointerup', 180, 500, 1);
    await vi.advanceTimersByTimeAsync(0);

    expect(composer.classList.contains('controls-composer-voice-holding')).toBe(false);
    expect(document.querySelector('.voice-hold-hud')).toBe(hud);
    expect(hud.getAttribute('data-phase')).toBe('draining');
    expect(hud.classList.contains('is-dropping')).toBe(false);
    expect(hud.querySelector('.voice-hold-hud-recognizing.is-recognizing')).not.toBeNull();
    expect(hud.querySelector('.voice-recognizing-dots')).not.toBeNull();
    expect(transcriptEl.textContent).toBe('初始语音');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Late trailing partial arrives during draining -> bubble updates live
    voiceMock.partialHandler?.('初始语音 加上末尾识别词');
    await vi.advanceTimersByTimeAsync(0);
    expect(transcriptEl.textContent).toBe('初始语音 加上末尾识别词');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // stopListening resolves -> transitions to data-phase="dropping" (.is-dropping) sliding down toward composer (764 - 270 = 494px)
    releaseStop();
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('.voice-hold-hud')).toBe(hud);
    expect(hud.getAttribute('data-phase')).toBe('dropping');
    expect(hud.classList.contains('is-dropping')).toBe(true);
    expect(hud.style.getPropertyValue('--voice-drop-y')).toBe('494px');
    expect(composer.classList.contains('controls-composer-voice-dropping')).toBe(true);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Still dropping at 299ms
    await vi.advanceTimersByTimeAsync(299);
    expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-phase')).toBe('dropping');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Completes at 300ms -> closes HUD and sends final text
    await vi.advanceTimersByTimeAsync(1);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(composer.classList.contains('controls-composer-voice-dropping')).toBe(false);
    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
      text: '初始语音 加上末尾识别词',
    }));
  });

  it('keeps draining HUD alive for edit release with trailing partials, skips drop on empty speech/unmount, and respects prefers-reduced-motion CSS & timing', async () => {
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

    // 1. Edit release: draining stays visible and updates trailing partials before opening VoiceOverlay
    let releaseEditStop!: () => void;
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseEditStop = r; }));
    dispatchPointer(input, 'pointerdown', 160, 500, 1);
    await vi.advanceTimersByTimeAsync(175);
    voiceMock.listeningHandler?.(true);
    voiceMock.partialHandler?.('编辑草稿');
    dispatchPointer(input, 'pointermove', 240, 500, 1); // edit zone
    dispatchPointer(input, 'pointerup', 240, 500, 1);
    await vi.advanceTimersByTimeAsync(0);

    const editHud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(editHud).not.toBeNull();
    expect(editHud.getAttribute('data-phase')).toBe('draining');
    voiceMock.partialHandler?.('编辑草稿 完整尾句');
    await vi.advanceTimersByTimeAsync(0);
    expect(editHud.querySelector('.voice-hold-hud-transcript')?.textContent).toBe('编辑草稿 完整尾句');
    expect(document.querySelector('.mock-voice-overlay')).toBeNull();

    releaseEditStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.querySelector('.mock-voice-overlay')?.getAttribute('data-initial-text')).toBe('编辑草稿 完整尾句');
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // Close overlay cleanly before next scenario (advance past Preact useEffect rAF flush)
    overlaySpy.lastProps?.onClose?.();
    await vi.advanceTimersByTimeAsync(50);
    expect(document.querySelector('.mock-voice-overlay')).toBeNull();

    // 2. Empty speech release in send zone closes cleanly without dropping or sending
    let releaseEmptyStop!: () => void;
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseEmptyStop = r; }));
    dispatchPointer(input, 'pointerdown', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(175);
    voiceMock.listeningHandler?.(true);
    dispatchPointer(input, 'pointerup', 180, 500, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-phase')).toBe('draining');
    releaseEmptyStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();

    // 3. prefers-reduced-motion: reduce skips 300ms wait cleanly and sends immediately when drain finishes
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
    try {
      dispatchPointer(input, 'pointerdown', 180, 500, 3);
      await vi.advanceTimersByTimeAsync(175);
      voiceMock.listeningHandler?.(true);
      voiceMock.partialHandler?.('reduced motion voice');
      dispatchPointer(input, 'pointerup', 180, 500, 3);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.voice-hold-hud')).toBeNull();
      expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
      expect(ws.sendSessionCommand).toHaveBeenCalledWith('send', expect.objectContaining({
        text: 'reduced motion voice',
      }));
    } finally {
      matchMediaSpy.mockRestore();
    }

    // 4. Unmount mid-dropping clears 300ms timer cleanly and never fires stale handleVoiceSend
    let releaseDropUnmountStop!: () => void;
    voiceMock.stopListening.mockImplementationOnce(() => new Promise<void>((r) => { releaseDropUnmountStop = r; }));
    dispatchPointer(input, 'pointerdown', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(175);
    voiceMock.listeningHandler?.(true);
    voiceMock.partialHandler?.('should cancel on unmount');
    dispatchPointer(input, 'pointerup', 180, 500, 4);
    await vi.advanceTimersByTimeAsync(0);
    releaseDropUnmountStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud')?.getAttribute('data-phase')).toBe('dropping');
    await vi.advanceTimersByTimeAsync(150);
    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);
    view.unmount();
    await vi.advanceTimersByTimeAsync(500);
    expect(ws.sendSessionCommand).toHaveBeenCalledTimes(1);

    // 5. CSS keyframe progressive shrink (scale(1) -> scale(0.7) -> scale(0.46) -> scale(0.35) over 300ms) & reduced-motion disable rule
    const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css');
    const css = readFileSync(stylesPath, 'utf8');
    expect(css).toContain('@keyframes voice-hold-transcript-drop');
    expect(css).toContain('scale(0.7)');
    expect(css).toContain('scale(0.35)');
    expect(css).toContain('animation: voice-hold-transcript-drop 300ms');
    expect(css).toContain('.voice-hold-hud.is-dropping .voice-hold-hud-transcript');
  });
});
