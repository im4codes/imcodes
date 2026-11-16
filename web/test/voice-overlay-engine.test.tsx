/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';

const bridges = vi.hoisted(() => {
  const make = () => ({
    available: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    prewarm: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addListener: vi.fn(),
    listeners: {} as Record<string, (data: unknown) => void>,
  });
  return { streaming: make(), platform: make() };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridges.streaming }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: bridges.platform }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../src/screen-awake.js', () => ({
  holdScreenAwake: () => () => {},
}));

import * as VoiceInput from '../src/components/VoiceInput.js';
import { VoiceOverlay } from '../src/components/VoiceOverlay.js';

function resetBridge(bridge: typeof bridges.streaming) {
  bridge.listeners = {};
  bridge.available.mockReset().mockResolvedValue({ available: true });
  bridge.checkPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  bridge.requestPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  bridge.prewarm.mockReset().mockResolvedValue(undefined);
  bridge.start.mockReset().mockImplementation(async () => {
    bridge.listeners.listeningState?.({ status: 'started' });
  });
  bridge.stop.mockReset().mockImplementation(async () => {
    bridge.listeners.listeningState?.({ status: 'stopped' });
  });
  bridge.addListener.mockReset().mockImplementation(async (name: string, fn: (data: unknown) => void) => {
    bridge.listeners[name] = fn;
    return { remove: vi.fn(async () => {}) };
  });
}

describe('VoiceOverlay speech recognition engine switcher', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBridge(bridges.streaming);
    resetBridge(bridges.platform);
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
  });

  afterEach(async () => {
    cleanup();
    await VoiceInput.stopListening({ abort: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows Apple-native label on iOS and System-native label on Android when StreamingSpeech is available', () => {
    const view = render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    const select = screen.getByLabelText('voice.engine_label') as HTMLSelectElement;
    expect(select.value).toBe('builtin');
    const optionValues = Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent }));
    expect(optionValues).toEqual([
      { value: 'builtin', label: 'voice.engine_builtin' },
      { value: 'system', label: 'voice.engine_apple' },
    ]);

    view.unmount();
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    const androidSelect = screen.getByLabelText('voice.engine_label') as HTMLSelectElement;
    expect(Array.from(androidSelect.options).map((o) => o.textContent)).toEqual([
      'voice.engine_builtin',
      'voice.engine_system',
    ]);
  });

  it('hides the engine switcher on desktop browsers and old shells without StreamingSpeech', () => {
    vi.stubGlobal('Capacitor', undefined);
    const desktop = render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('voice.engine_label')).toBeNull();
    desktop.unmount();

    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: () => false,
    });
    render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('voice.engine_label')).toBeNull();
  });

  it('updates preference and prewarms new engine without auto-starting when switched while idle', async () => {
    render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    bridges.platform.prewarm.mockClear();

    const select = screen.getByLabelText('voice.engine_label') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'system' } });

    await waitFor(() => {
      expect(VoiceInput.getVoiceRecognitionEngine()).toBe('system');
      expect(bridges.platform.available).toHaveBeenCalled();
    });
    expect(bridges.streaming.start).not.toHaveBeenCalled();
    expect(bridges.platform.start).not.toHaveBeenCalled();
  });

  it('commits partial text, stops active session, and restarts on new engine while listening', async () => {
    render(<VoiceOverlay open initialText="" onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);

    await waitFor(() => expect(bridges.streaming.start).toHaveBeenCalledTimes(1));
    bridges.streaming.listeners.partialResults?.({ matches: ['hello'], isFinal: false });
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('hello');

    const select = screen.getByLabelText('voice.engine_label') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'system' } });

    await waitFor(() => expect(bridges.platform.start).toHaveBeenCalledTimes(1));
    expect(bridges.streaming.stop).toHaveBeenCalledTimes(1);
    expect(VoiceInput.getVoiceRecognitionEngine()).toBe('system');

    bridges.platform.listeners.partialResults?.({ matches: ['world'], isFinal: true });
    expect(textarea.value).toBe('hello world');
  });

  it('guards against rapid double-switches while stop is in flight', async () => {
    let releaseStop!: () => void;
    bridges.streaming.stop.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseStop = () => {
        bridges.streaming.listeners.listeningState?.({ status: 'stopped' });
        resolve();
      };
    }));

    render(<VoiceOverlay open initialText="" onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    await waitFor(() => expect(bridges.streaming.start).toHaveBeenCalledTimes(1));

    const select = screen.getByLabelText('voice.engine_label') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'system' } });
    fireEvent.change(select, { target: { value: 'builtin' } });

    releaseStop();

    await waitFor(() => expect(bridges.streaming.start).toHaveBeenCalledTimes(2));
    expect(bridges.platform.start).not.toHaveBeenCalled();
    expect(VoiceInput.getVoiceRecognitionEngine()).toBe('builtin');
  });
});
