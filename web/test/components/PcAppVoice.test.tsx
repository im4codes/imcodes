/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQuickDataResult } from '../../src/components/QuickInputPanel.js';
import type { PcAppBridge, PcAppVoiceEvent, PcAppVoiceInputDevice } from '../../src/native-platform.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

import { SessionControls, readComposerElementText } from '../../src/components/SessionControls.js';
import * as VoiceInput from '../../src/components/VoiceInput.js';

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

function createFakePcAppBridge(overrides: Partial<NonNullable<PcAppBridge['voice']>> = {}) {
  let subscriber: ((ev: PcAppVoiceEvent) => void) | null = null;
  const bridge: PcAppBridge = {
    platform: 'darwin',
    isElectron: true,
    voice: {
      isNativeSpeechSupported: () => true,
      getPermissions: vi.fn(async () => ({
        mic: 'granted' as const,
        speech: 'granted' as const,
        platform: 'darwin',
        nativeSpeechAvailable: true,
      })),
      requestPermissions: vi.fn(async () => ({
        mic: 'granted' as const,
        speech: 'granted' as const,
        platform: 'darwin',
        nativeSpeechAvailable: true,
      })),
      openPrivacySettings: vi.fn(async () => true),
      startListening: vi.fn(async () => ({ ok: true })),
      stopListening: vi.fn(async () => {
        subscriber?.({ type: 'end' });
      }),
      subscribe: (listener) => {
        subscriber = listener;
        return () => {
          if (subscriber === listener) subscriber = null;
        };
      },
      ...overrides,
    },
  };
  return {
    bridge,
    emit: (ev: PcAppVoiceEvent) => subscriber?.(ev),
  };
}

describe('PC App inline voice dictation and quick permission grant', () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete (globalThis as any).__IMCODES_PC_APP__;
    delete (globalThis as any).Capacitor;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
  });

  afterEach(async () => {
    try {
      await VoiceInput.stopListening({ abort: true });
    } catch { /* ignore */ }
    VoiceInput.clearPcAppPermissionDeniedTarget();
    cleanup();
    document.body.innerHTML = '';
    delete (globalThis as any).__IMCODES_PC_APP__;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
    vi.restoreAllMocks();
  });

  it('routes pc-app mic click to inline composer dictation without VoiceOverlay and streams native transcripts', { timeout: 15000 }, async () => {
    const fake = createFakePcAppBridge();
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;

    expect(VoiceInput.isAvailable()).toBe(true);
    expect(VoiceInput.isPcAppNativeSpeech()).toBe(true);

    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );

    const input = container.querySelector('.controls-input') as HTMLDivElement;
    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    expect(micBtn).not.toBeNull();

    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(fake.bridge.voice!.startListening).toHaveBeenCalledTimes(1);
    });
    expect(document.body.querySelector('.voice-overlay')).toBeNull();

    fake.emit({ type: 'start' });
    fake.emit({ type: 'result', text: 'hello pc app', isFinal: false });
    await waitFor(() => {
      expect(readComposerElementText(input)).toBe('hello pc app');
    });

    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(fake.bridge.voice!.stopListening).toHaveBeenCalled();
    });
  });

  it('surfaces quick-grant & OS Privacy Settings button when macOS TCC permission is denied, and opens Privacy Settings on click', async () => {
    const openPrivacySettings = vi.fn(async () => true);
    const requestPermissions = vi.fn(async () => ({
      mic: 'denied' as const,
      speech: 'not-determined' as const,
      platform: 'darwin',
      nativeSpeechAvailable: true,
    }));
    const fake = createFakePcAppBridge({
      getPermissions: vi.fn(async () => ({
        mic: 'denied' as const,
        speech: 'not-determined' as const,
        platform: 'darwin',
        nativeSpeechAvailable: true,
      })),
      requestPermissions,
      openPrivacySettings,
    });
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;

    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    fireEvent.click(micBtn);

    const banner = await screen.findByTestId('inline-voice-permission-banner');
    expect(banner.textContent).toContain('voice.mic_permission_failed');
    expect(document.body.querySelector('.voice-overlay')).toBeNull();

    const grantBtn = screen.getByTestId('inline-voice-grant-btn');
    fireEvent.click(grantBtn);
    await waitFor(() => {
      expect(openPrivacySettings).toHaveBeenCalledWith('microphone');
    });
  });

  it('preserves standard VoiceOverlay when running in normal web browser (no __IMCODES_PC_APP__ and no Capacitor)', async () => {
    (globalThis as any).SpeechRecognition = class MockWebSpeech {
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    };
    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );
    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    fireEvent.click(micBtn);
    expect(document.body.querySelector('.voice-overlay')).not.toBeNull();
    delete (globalThis as any).SpeechRecognition;
  });

  it('keeps standard VoiceOverlay fallback on Windows PC App when native speech is unsupported', async () => {
    const startListeningMock = vi.fn(async () => ({ ok: true }));
    const fakeWin = createFakePcAppBridge({
      isNativeSpeechSupported: () => false,
      startListening: startListeningMock,
    });
    fakeWin.bridge.platform = 'win32';
    (globalThis as any).__IMCODES_PC_APP__ = fakeWin.bridge;
    (globalThis as any).SpeechRecognition = class MockWebSpeech {
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    };

    expect(VoiceInput.isPcAppNativeSpeech()).toBe(false);
    expect(VoiceInput.isAvailable()).toBe(true);

    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    fireEvent.click(micBtn);
    expect(document.body.querySelector('.voice-overlay')).not.toBeNull();
    expect(startListeningMock).not.toHaveBeenCalled();
    expect(container.querySelector('.voice-streaming-robot-cursor')).toBeNull();
    delete (globalThis as any).SpeechRecognition;
  });

  it('shows selected microphone next to desktop PC App mic button and switches via setInputDevice', async () => {
    const devices: PcAppVoiceInputDevice[] = [
      { uid: 'bt-airpods', name: 'k的AirPods Pro3', transport: 'bluetooth', isDefault: true, isPhysical: false },
      { uid: 'builtin-mic', name: 'MacBook Pro Microphone', transport: 'builtin', isDefault: false, isPhysical: true },
      { uid: 'usb-mic', name: 'Shure MV7', transport: 'usb', isDefault: false, isPhysical: true },
    ];
    const getInputDevices = vi.fn(async () => devices);
    const getInputDevice = vi.fn(async () => 'auto');
    const setInputDevice = vi.fn(async (uid: string) => uid);
    const fake = createFakePcAppBridge({
      getInputDevices,
      getInputDevice,
      setInputDevice,
    });
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;

    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );

    const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
    const select = await screen.findByTestId('pc-voice-mic-select') as HTMLSelectElement;
    expect(micBtn.nextElementSibling).toBe(select);

    await waitFor(() => {
      expect(select.options.length).toBe(4);
    });
    expect(select.value).toBe('auto');
    expect(select.options[0]?.textContent).toContain('MacBook Pro Microphone');
    expect(select.options[2]?.textContent).toBe('MacBook Pro Microphone');
    expect(select.options[3]?.textContent).toBe('Shure MV7');

    fireEvent.change(select, { target: { value: 'usb-mic' } });
    await waitFor(() => {
      expect(setInputDevice).toHaveBeenCalledWith('usb-mic');
      expect(select.value).toBe('usb-mic');
    });
  });

  it('supports getSelectedInputDevice/setSelectedInputDevice aliases and handles device load rejection cleanly', async () => {
    const setSelectedInputDevice = vi.fn(async (uid: string) => uid);
    const fake = createFakePcAppBridge({
      getInputDevices: vi.fn(async () => [
        { uid: 'usb-mic', name: 'Shure MV7', transport: 'usb', isDefault: true, isPhysical: true },
      ]),
      getSelectedInputDevice: vi.fn(async () => 'usb-mic'),
      setSelectedInputDevice,
    });
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;

    render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );

    const select = await screen.findByTestId('pc-voice-mic-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.value).toBe('usb-mic');
    });
    fireEvent.change(select, { target: { value: 'auto' } });
    await waitFor(() => {
      expect(setSelectedInputDevice).toHaveBeenCalledWith('auto');
      expect(select.value).toBe('auto');
    });

    cleanup();
    const broken = createFakePcAppBridge({
      getInputDevices: vi.fn(async () => { throw new Error('helper failed'); }),
      getInputDevice: vi.fn(async () => 'auto'),
    });
    (globalThis as any).__IMCODES_PC_APP__ = broken.bridge;
    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );
    expect(container.querySelector('button[data-voice-trigger="desktop"]')).not.toBeNull();
    expect(screen.queryByTestId('pc-voice-mic-select')).not.toBeNull();
  });

  it('hides microphone selector on mobile layout and outside PC App', async () => {
    const fake = createFakePcAppBridge({
      getInputDevices: vi.fn(async () => [
        { uid: 'builtin-mic', name: 'MacBook Pro Microphone', transport: 'builtin', isDefault: true, isPhysical: true },
      ]),
      getInputDevice: vi.fn(async () => 'auto'),
      setInputDevice: vi.fn(async (uid: string) => uid),
    });
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });

    render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('pc-voice-mic-select')).toBeNull();

    cleanup();
    delete (globalThis as any).__IMCODES_PC_APP__;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
    (globalThis as any).SpeechRecognition = class MockWebSpeech {
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    };
    const { container } = render(
      <SessionControls
        ws={makeWs()}
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
        onSend={vi.fn()}
      />,
    );
    expect(container.querySelector('button[data-voice-trigger="desktop"]')).not.toBeNull();
    expect(screen.queryByTestId('pc-voice-mic-select')).toBeNull();
    delete (globalThis as any).SpeechRecognition;
  });
});
