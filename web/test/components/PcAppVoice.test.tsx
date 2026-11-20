/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQuickDataResult } from '../../src/components/QuickInputPanel.js';
import type { PcAppBridge, PcAppVoiceEvent } from '../../src/native-platform.js';

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
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete (globalThis as any).__IMCODES_PC_APP__;
    delete (globalThis as any).Capacitor;
  });

  afterEach(async () => {
    try {
      await VoiceInput.stopListening({ abort: true });
    } catch { /* ignore */ }
    VoiceInput.clearPcAppPermissionDeniedTarget();
    cleanup();
    document.body.innerHTML = '';
    delete (globalThis as any).__IMCODES_PC_APP__;
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
});
