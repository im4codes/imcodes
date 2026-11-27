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
import {
  resetVoiceHotwordsScopeForTesting,
  setActiveVoiceHotwordProject,
  setProjectVoiceHotwordsRaw,
  setVoiceHotwordsAuthScope,
} from '../../src/voice-hotwords.js';

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
    expect(screen.queryByTestId('voice-model-loading-chip')).toBeNull();

    // MLX helper emits 'loading' while warming model -> loading chip appears, then clears on 'start'
    fake.emit({ type: 'loading', variant: '1.7b' });
    const loadingChip = await screen.findByTestId('voice-model-loading-chip');
    expect(loadingChip.textContent).toContain('voice.loading_model');

    fake.emit({ type: 'start' });
    await waitFor(() => {
      expect(screen.queryByTestId('voice-model-loading-chip')).toBeNull();
    });
    fake.emit({ type: 'result', text: 'hello pc app', isFinal: false });
    await waitFor(() => {
      expect(readComposerElementText(input)).toBe('hello pc app');
    });

    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(fake.bridge.voice!.stopListening).toHaveBeenCalled();
    });

    // Boundary: stopping while model is still loading clears the loading chip immediately
    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(fake.bridge.voice!.startListening).toHaveBeenCalledTimes(2);
    });
    fake.emit({ type: 'loading', variant: '0.6b' });
    await screen.findByTestId('voice-model-loading-chip');
    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('voice-model-loading-chip')).toBeNull();
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

  it('shows active speech service chip above desktop composer during inline dictation and hides it when stopped', async () => {
    const getSpeechModelStatus = vi.fn(async () => ({
      selectedModel: 'qwen3-1.7b' as const,
      activeBackend: 'qwen3-1.7b' as const,
      state: 'ready' as const,
      progress: 1,
      downloadedBytes: 0,
      totalBytes: 0,
      mlxSupported: true,
    }));
    const fake = createFakePcAppBridge({ getSpeechModelStatus });
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
    expect(screen.queryByTestId('inline-voice-service-chip')).toBeNull();

    fireEvent.click(micBtn);
    const chip = await screen.findByTestId('inline-voice-service-chip');
    await waitFor(() => {
      expect(chip.textContent).toContain('Qwen3-ASR 1.7B');
    });

    fireEvent.click(micBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('inline-voice-service-chip')).toBeNull();
    });
  });

  it('portals active voice service chip inline inside visible #imcodes-voice-hud-root, handles dynamic/hidden transitions, and suppresses duplicate loading chip', async () => {
    const getSpeechModelStatus = vi.fn(async () => ({
      selectedModel: 'qwen3-1.7b' as const,
      activeBackend: 'qwen3-1.7b' as const,
      state: 'ready' as const,
      progress: 1,
      downloadedBytes: 0,
      totalBytes: 0,
      mlxSupported: true,
    }));
    const fake = createFakePcAppBridge({ getSpeechModelStatus });
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;

    // Start with hidden pre-existing HUD root (as left after an earlier dictation, matching voice-hud.ts aria-hidden=true).
    const hudRoot = document.createElement('div');
    hudRoot.id = 'imcodes-voice-hud-root';
    hudRoot.setAttribute('aria-hidden', 'true');
    hudRoot.setAttribute('data-mode', 'hidden');
    hudRoot.style.display = 'none';
    const hudLabel = document.createElement('span');
    hudLabel.id = 'imcodes-voice-hud-label';
    hudLabel.textContent = '请说话';
    const hudBars = document.createElement('div');
    hudBars.id = 'imcodes-voice-hud-bars';
    hudRoot.appendChild(hudLabel);
    hudRoot.appendChild(hudBars);
    document.body.appendChild(hudRoot);

    try {
      const { container, unmount } = render(
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

      const controlsWrapper = container.querySelector('.controls-wrapper') as HTMLElement;
      const micBtn = container.querySelector('button[data-voice-trigger="desktop"]') as HTMLButtonElement;
      const getAccessibleVoiceStatuses = () =>
        screen.getAllByRole('status').filter((el) => (
          el.textContent?.includes('Qwen3-ASR') || el.textContent?.includes('voice.loading_model')
        ));

      fireEvent.click(micBtn);
      // Before HUD transitions from hidden -> visible, chip renders only inside the out-of-flow fallback overlay.
      const fallbackChip = await screen.findByTestId('inline-voice-service-chip');
      expect(controlsWrapper.contains(fallbackChip)).toBe(true);
      expect(hudRoot.querySelector('[data-testid="inline-voice-service-chip"]')).toBeNull();
      expect(screen.queryByTestId('voice-hud-sr-status')).toBeNull();
      expect(getAccessibleVoiceStatuses().map((el) => el.textContent)).toEqual(['Qwen3-ASR 1.7B']);

      // Transition HUD to loading mode -> duplicate voice-model-loading-chip is suppressed, service chip moves into HUD,
      // and non-hidden accessible role="status" preserves both model label and loading status despite aria-hidden="true" on HUD.
      fake.emit({ type: 'loading', variant: '1.7b' });
      hudRoot.setAttribute('data-mode', 'loading');
      hudRoot.style.display = 'flex';
      hudLabel.textContent = '正在加载语音模型…';

      await waitFor(() => {
        const hudChip = hudRoot.querySelector('[data-testid="inline-voice-service-chip"]');
        expect(hudChip).not.toBeNull();
        expect(hudChip?.textContent).toContain('Qwen3-ASR 1.7B');
        expect(controlsWrapper.querySelector('[data-testid="inline-voice-service-chip"]')).toBeNull();
        expect(screen.queryByTestId('voice-model-loading-chip')).toBeNull();
        const accessibleStatuses = getAccessibleVoiceStatuses();
        expect(accessibleStatuses).toHaveLength(1);
        expect(accessibleStatuses[0]?.getAttribute('aria-live')).toBe('polite');
        expect(accessibleStatuses[0]?.textContent).toContain('Qwen3-ASR 1.7B');
        expect(accessibleStatuses[0]?.textContent).toContain('voice.loading_model');
      });

      // Transition HUD to listening -> chip remains inline in HUD; accessible role="status" exposes model name cleanly.
      fake.emit({ type: 'start' });
      hudRoot.setAttribute('data-mode', 'listening');
      hudLabel.textContent = '请说话';
      await waitFor(() => {
        const hudChip = hudRoot.querySelector('[data-testid="inline-voice-service-chip"]');
        expect(hudChip).not.toBeNull();
        expect(hudRoot.contains(hudLabel)).toBe(true);
        expect(hudRoot.contains(hudBars)).toBe(true);
        expect(controlsWrapper.querySelector('.voice-inline-chips')).toBeNull();
        const accessibleStatuses = getAccessibleVoiceStatuses();
        expect(accessibleStatuses).toHaveLength(1);
        expect(accessibleStatuses[0]?.textContent).toBe('Qwen3-ASR 1.7B');
      });

      // Hide HUD -> chip falls back out of HUD; sr-status clears so fallback status is never duplicated.
      hudRoot.setAttribute('data-mode', 'hidden');
      hudRoot.style.display = 'none';
      await waitFor(() => {
        expect(hudRoot.querySelector('[data-testid="inline-voice-service-chip"]')).toBeNull();
        expect(controlsWrapper.querySelector('[data-testid="inline-voice-service-chip"]')).not.toBeNull();
        expect(screen.queryByTestId('voice-hud-sr-status')).toBeNull();
        expect(getAccessibleVoiceStatuses()).toHaveLength(1);
      });

      // Dynamically recreate HUD while listening -> chip portals back in, then stopping voice clears accessible status completely.
      hudRoot.remove();
      const recreatedHud = document.createElement('div');
      recreatedHud.id = 'imcodes-voice-hud-root';
      recreatedHud.setAttribute('aria-hidden', 'true');
      recreatedHud.setAttribute('data-mode', 'listening');
      recreatedHud.style.display = 'flex';
      document.body.appendChild(recreatedHud);
      await waitFor(() => {
        expect(recreatedHud.querySelector('[data-testid="inline-voice-service-chip"]')).not.toBeNull();
        expect(getAccessibleVoiceStatuses().map((el) => el.textContent)).toEqual(['Qwen3-ASR 1.7B']);
      });

      fireEvent.click(micBtn);
      await waitFor(() => {
        expect(recreatedHud.querySelector('[data-testid="inline-voice-service-chip"]')).toBeNull();
        expect(screen.queryByTestId('voice-hud-sr-status')).toBeNull();
        expect(getAccessibleVoiceStatuses()).toHaveLength(0);
      });

      unmount();
    } finally {
      document.getElementById('imcodes-voice-hud-root')?.remove();
    }
  });

  it('preserves cross-sentence single hotwords while stripping standalone & intra-sentence hallucinations on PC App native VoiceInput owner results', async () => {
    const fake = createFakePcAppBridge();
    (globalThis as any).__IMCODES_PC_APP__ = fake.bridge;
    setVoiceHotwordsAuthScope({ baseUrl: 'https://relay.example', userId: 'pc-owner-1' }, { sync: false });
    setActiveVoiceHotwordProject('proj-pc-guard');
    setProjectVoiceHotwordsRaw('proj-pc-guard', 'IM.codes\nClaude');

    try {
      const results: Array<[string, boolean]> = [];
      const started = await VoiceInput.startListening(
        (text, isFinal) => results.push([text, isFinal]),
        undefined,
        undefined,
        { projectKey: 'proj-pc-guard' },
      );
      expect(started).toBe(true);
      fake.emit({ type: 'start' });
      fake.emit({ type: 'result', text: '我常用 IM.codes。IM.codes', isFinal: false });
      fake.emit({ type: 'result', text: 'IM.codes。IM.codes 很好用。', isFinal: false });
      fake.emit({ type: 'result', text: 'IM.codes。IM.codes。你好', isFinal: false });
      fake.emit({ type: 'result', text: 'IM.codes，IM.codes。你答的对，就这么来。', isFinal: false });
      fake.emit({ type: 'result', text: '我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。IM.codes，IM.codes。', isFinal: true });
      fake.emit({ type: 'end' });

      expect(results).toEqual([
        ['我常用 IM.codes。IM.codes', false],
        ['IM.codes。IM.codes 很好用。', false],
        ['你好', false],
        ['你答的对，就这么来。', false],
        ['我们是桌面端，在乎那几十兆，不在乎的，我要的是速度。', true],
      ]);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      resetVoiceHotwordsScopeForTesting();
    }
  });
});
