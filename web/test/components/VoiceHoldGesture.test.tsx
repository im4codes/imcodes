/**
 * @vitest-environment jsdom
 */
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

  it('short tap (<350ms) focuses composer input for keyboard typing without starting voice recording', async () => {
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
    expect(document.activeElement).not.toBe(input);

    dispatchPointer(input, 'pointerdown', 180);
    await vi.advanceTimersByTimeAsync(120);
    dispatchPointer(input, 'pointerup', 180);

    expect(voiceMock.startListening).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-hold-hud')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('holds 350ms -> vibrates & suppresses keyboard -> shows 3-zone HUD with recognizing feedback -> releases in center to auto-send', async () => {
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

    expect(vibrate).toHaveBeenCalledWith(20);
    expect(document.activeElement).not.toBe(input);
    expect(voiceMock.startListening).toHaveBeenCalledTimes(1);

    // HUD shows all 3 gesture prompts and recognizing status
    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud).not.toBeNull();
    expect(hud.getAttribute('data-zone')).toBe('send');
    expect(hud.textContent).toContain('voice.slide_left_cancel');
    expect(hud.textContent).toContain('voice.release_to_send');
    expect(hud.textContent).toContain('voice.slide_right_edit');
    expect(hud.textContent).toContain('voice.recognizing');
    expect(hud.textContent).toContain('voice.buffering_hint');

    voiceMock.levelHandler?.(0.4);
    voiceMock.partialHandler?.('你好 IM.codes');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.voice-hold-hud-transcript')?.textContent).toBe('你好 IM.codes');

    // Release in center zone drains stopListening and sends immediately
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
  });

  it('holds 350ms -> slides left into cancel zone -> highlights red & discards recording on release', async () => {
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
    await vi.advanceTimersByTimeAsync(350);

    voiceMock.partialHandler?.('誤って話した内容');
    dispatchPointer(input, 'pointermove', 130); // dx = -70 <= -44 (left cancel zone)
    await vi.advanceTimersByTimeAsync(0);

    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud.getAttribute('data-zone')).toBe('cancel');
    expect(document.querySelector('.voice-hold-zone-cancel')?.classList.contains('is-active')).toBe(true);
    expect(document.querySelector('.voice-hold-hud-active-hint')?.textContent).toBe('voice.release_to_cancel');

    dispatchPointer(input, 'pointerup', 130);
    await vi.advanceTimersByTimeAsync(0);

    expect(voiceMock.stopListening).toHaveBeenCalledTimes(1);
    expect(ws.sendSessionCommand).not.toHaveBeenCalled();
    expect(document.querySelector('.mock-voice-overlay')).toBeNull();
  });

  it('holds 350ms -> slides right into edit zone -> highlights blue & opens VoiceOverlay in edit mode on release', async () => {
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
    await vi.advanceTimersByTimeAsync(350);

    voiceMock.partialHandler?.('需要二次修改的文字');
    dispatchPointer(input, 'pointermove', 230); // dx = +70 >= +44 (right edit zone)
    await vi.advanceTimersByTimeAsync(0);

    const hud = document.querySelector('.voice-hold-hud') as HTMLElement;
    expect(hud.getAttribute('data-zone')).toBe('edit');
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
});
