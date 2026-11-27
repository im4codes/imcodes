/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

const speechApi = vi.hoisted(() => ({
  available: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

const streamingApi = vi.hoisted(() => ({
  available: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  performHaptic: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn(() => streamingApi) }));

vi.mock('@capgo/capacitor-speech-recognition', () => ({
  SpeechRecognition: speechApi,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts?.error ? `${key}:${opts.error}` : key),
  }),
}));

vi.mock('../../src/screen-awake.js', () => ({
  holdScreenAwake: () => () => {},
}));

type VoiceInputModule = typeof import('../../src/components/VoiceInput.js');

let VoiceInput: VoiceInputModule;
let listeners: Record<string, (data: any) => void>;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
  listeners = {};
  speechApi.available.mockReset().mockResolvedValue({ available: true });
  speechApi.checkPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  speechApi.requestPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  speechApi.addListener.mockReset().mockImplementation(async (eventName: string, handler: (data: any) => void) => {
    listeners[eventName] = handler;
    return { remove: vi.fn(async () => undefined) };
  });
  speechApi.start.mockReset().mockResolvedValue({});
  speechApi.stop.mockReset().mockResolvedValue(undefined);
  streamingApi.available.mockReset().mockResolvedValue({ available: true });
  streamingApi.checkPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  streamingApi.requestPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  streamingApi.addListener.mockReset().mockImplementation(async (eventName: string, handler: (data: any) => void) => {
    listeners[eventName] = handler;
    return { remove: vi.fn(async () => undefined) };
  });
  streamingApi.start.mockReset().mockResolvedValue({});
  streamingApi.stop.mockReset().mockResolvedValue(undefined);
  streamingApi.performHaptic.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  VoiceInput = await import('../../src/components/VoiceInput.js');
});

describe('VoiceInput', () => {
  it('coalesces overlapping starts and routes partials to the latest caller', async () => {
    const started = deferred<Record<string, never>>();
    speechApi.start.mockReturnValueOnce(started.promise);
    const firstResult = vi.fn();
    const latestResult = vi.fn();

    const firstStart = VoiceInput.startListening(firstResult);
    const latestStart = VoiceInput.startListening(latestResult);

    await waitFor(() => expect(speechApi.start).toHaveBeenCalledTimes(1));
    listeners.partialResults({ matches: ['hello'] });
    started.resolve({});

    await expect(firstStart).resolves.toBe(true);
    await expect(latestStart).resolves.toBe(true);
    expect(firstResult).not.toHaveBeenCalled();
    expect(latestResult).toHaveBeenCalledWith('hello', false);
    expect(VoiceInput.isListening()).toBe(true);
  });

  it('keeps full cumulative bilingual results and the offline final marker', async () => {
    const onResult = vi.fn();
    await VoiceInput.startListening(onResult);
    listeners.partialResults({ matches: ['你好 hello'], isFinal: false });
    listeners.partialResults({ matches: ['你好 hello world'], isFinal: true });
    expect(onResult.mock.calls).toEqual([['你好 hello', false], ['你好 hello world', true]]);
    await VoiceInput.stopListening();
  });

  it('keeps the final listener until native stop has drained the last word', async () => {
    const stopped = deferred<void>();
    speechApi.stop.mockReturnValueOnce(stopped.promise);
    const onResult = vi.fn();
    await VoiceInput.startListening(onResult);
    const stopping = VoiceInput.stopListening();
    listeners.partialResults({ matches: ['请上传 GitHub'], isFinal: true });
    expect(onResult).toHaveBeenLastCalledWith('请上传 GitHub', true);
    stopped.resolve();
    await stopping;
    listeners.partialResults({ matches: ['stale'], isFinal: true });
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('syncs native stopped events back to the listening state callback', async () => {
    const onListeningChange = vi.fn();

    await expect(VoiceInput.startListening(vi.fn(), onListeningChange)).resolves.toBe(true);
    expect(VoiceInput.isListening()).toBe(true);

    listeners.listeningState({ status: 'stopped' });

    await waitFor(() => expect(onListeningChange).toHaveBeenLastCalledWith(false));
    expect(VoiceInput.isListening()).toBe(false);
  });

  it('reports permission_denied when microphone permission is not granted', async () => {
    speechApi.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
    const onError = vi.fn();
    VoiceInput.onRecognitionError(onError);

    await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith('permission_denied');
    expect(VoiceInput.getLastError()).toBe('permission_denied');
    VoiceInput.onRecognitionError(null);
  });

  it('forwards native recognitionError events to error listeners, retires the dying session, and waits for stop drain before a fresh start', async () => {
    const drain = deferred<void>();
    speechApi.stop.mockReturnValueOnce(drain.promise);
    const onError = vi.fn();
    const firstPartials = vi.fn();
    const secondPartials = vi.fn();
    VoiceInput.onRecognitionError(onError);

    await expect(VoiceInput.startListening(firstPartials)).resolves.toBe(true);
    expect(speechApi.start).toHaveBeenCalledTimes(1);

    // Native emits recognitionError before endCapture's serial worker drain and stopped event
    listeners.recognitionError?.({ message: 'Offline audio conversion failed: format mismatch' });

    expect(onError).toHaveBeenCalledWith('Offline audio conversion failed: format mismatch');
    expect(VoiceInput.getLastError()).toBe('Offline audio conversion failed: format mismatch');
    expect(VoiceInput.isListening()).toBe(false);
    expect(speechApi.stop).toHaveBeenCalledTimes(1);

    // Retrying immediately before stop drain resolves must wait for the drain and start a 2nd session
    const retryPromise = VoiceInput.startListening(secondPartials);
    listeners.partialResults?.({ matches: ['final tail before drain'], isFinal: true });
    expect(firstPartials).toHaveBeenLastCalledWith('final tail before drain', true);
    listeners.listeningState?.({ status: 'stopped' });
    drain.resolve();

    await expect(retryPromise).resolves.toBe(true);
    expect(speechApi.start).toHaveBeenCalledTimes(2);
    expect(VoiceInput.isListening()).toBe(true);

    await VoiceInput.stopListening();
    VoiceInput.onRecognitionError(null);
  });

  it('integrates real VoiceOverlay + real VoiceInput across recognitionError -> immediate Retry -> delayed final tail & stopped/ACK', async () => {
    vi.useFakeTimers();
    try {
      const drain = deferred<void>();
      speechApi.stop.mockReturnValueOnce(drain.promise);
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');

      render(h(VoiceOverlay, {
        open: true,
        initialText: '',
        onSend: () => 'accepted',
        onClose: () => {},
      }));
      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(true);

      listeners.partialResults?.({ matches: ['hello'], isFinal: false });
      listeners.recognitionError?.({ message: 'Offline audio conversion failed: test' });
      await vi.advanceTimersByTimeAsync(0);

      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Offline audio conversion failed: test');
      expect(speechApi.stop).toHaveBeenCalledTimes(1);

      // Click Retry twice before native stop drain or listeningState: stopped arrives
      const retryBtn = document.querySelector('.voice-overlay-retry') as HTMLElement;
      fireEvent.click(retryBtn);
      fireEvent.click(retryBtn);
      await vi.advanceTimersByTimeAsync(0);

      // Final transcript tail arrives while native worker drains before stop ACK
      listeners.partialResults?.({ matches: ['hello world'], isFinal: true });
      listeners.listeningState?.({ status: 'stopped' });
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(speechApi.stop).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(true);
      expect(document.querySelector('[role="alert"]')).toBeNull();

      listeners.partialResults?.({ matches: ['next phrase'], isFinal: true });
      const ta = document.querySelector('textarea') as HTMLTextAreaElement;
      expect(ta.value).toBe('hello world next phrase');
    } finally {
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('VoiceOverlay + VoiceInput native: stays in voice.starting while speechApi.start is pending and promotes cleanly on listeningState: started', async () => {
    vi.useFakeTimers();
    try {
      const startGate = deferred<void>();
      speechApi.start.mockReturnValueOnce(startGate.promise);
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');

      render(h(VoiceOverlay, {
        open: true,
        initialText: '',
        onSend: () => 'accepted',
        onClose: () => {},
      }));
      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(false);

      const status = document.querySelector('.voice-overlay-status [role="status"]') as HTMLElement;
      const mic = document.querySelector('.voice-overlay-mic') as HTMLButtonElement;
      expect(status.textContent).toBe('voice.starting');
      expect(mic.classList.contains('voice-overlay-mic-active')).toBe(false);

      listeners.listeningState?.({ status: 'started' });
      startGate.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(VoiceInput.isListening()).toBe(true);
      expect(status.textContent).toBe('voice.listening');
      expect(mic.classList.contains('voice-overlay-mic-active')).toBe(true);

      listeners.partialResults?.({ matches: ['native confirmed'], isFinal: false });
      await vi.advanceTimersByTimeAsync(0);
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('native confirmed');
      expect(status.textContent).toBe('voice.recognizing');
    } finally {
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('initializes VoiceOverlay waveform bars at 0 (2px idle height), animates on audioLevel > 0.01, resets to 0 on stop, and isolates stale audioLevel events during stop drain', async () => {
    vi.useFakeTimers();
    try {
      const stopDrain = deferred<void>();
      speechApi.stop.mockReturnValueOnce(stopDrain.promise);
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');

      render(h(VoiceOverlay, {
        open: true,
        initialText: '',
        onSend: () => 'accepted',
        onClose: () => {},
      }));

      // 1. Initial idle bars are fill(0) -> GPU scaleY equivalent to 2px (2 + 0 * 44 of 46px), opacity 0.15
      const getBarHeights = () =>
        Array.from(document.querySelectorAll('.voice-waveform-bar')).map((el) => {
          const match = /scaleY\(([^)]+)\)/.exec((el as HTMLElement).style.transform);
          return match ? parseFloat(match[1]!) * 46 : NaN;
        });
      expect(getBarHeights()).toHaveLength(48);
      getBarHeights().forEach((h) => expect(h).toBeCloseTo(2, 2));

      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      // 2. First active audioLevel > 0.01 triggers isEmpty initial burst across all 48 bars (within 2px..46px)
      listeners.audioLevel?.({ level: 0.5 });
      await vi.advanceTimersByTimeAsync(0);
      const burstHeights = getBarHeights();
      expect(burstHeights.every((h) => h > 2 && h <= 46)).toBe(true);

      // 3. Subsequent audioLevel events shift the normalized waveform smoothly and clamp out-of-range values to <= 46px
      listeners.audioLevel?.({ level: 0.02 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getBarHeights().at(-1)).toBeGreaterThan(10);

      listeners.audioLevel?.({ level: 0.25 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getBarHeights().at(-1)).toBeCloseTo(2 + VoiceInput.normalizeVoiceWaveformLevel(0.25) * 44, 2);

      listeners.audioLevel?.({ level: 3.0 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getBarHeights().at(-1)).toBeCloseTo(46, 2);

      // 4. Tapping mic to stop immediately suppresses stale native audioLevel events during final stop drain,
      //    and resets waveform bars back to 2px (fill(0)) once stop completes.
      const micBtn = document.querySelector('.voice-overlay-mic') as HTMLElement;
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(0);

      const heightsBeforeStaleEvent = getBarHeights();
      listeners.audioLevel?.({ level: 0.9 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getBarHeights()).toEqual(heightsBeforeStaleEvent);

      stopDrain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      getBarHeights().forEach((h) => expect(h).toBeCloseTo(2, 2));
    } finally {
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('waits cleanly for a slow native stop() past 15s without timing out, lets next start serialize behind it, and still surfaces genuine stop errors', async () => {
    vi.useFakeTimers();
    try {
      const slowStop = deferred<void>();
      const onErr = vi.fn();
      speechApi.stop.mockReturnValueOnce(slowStop.promise).mockResolvedValue(undefined);

      await expect(VoiceInput.startListening(vi.fn(), undefined, onErr)).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);

      const stopping = VoiceInput.stopListening();
      expect(VoiceInput.isListening()).toBe(false);

      // Next start serializes behind slow stop even past 15s without ever emitting a timeout error.
      const resumed = VoiceInput.startListening(vi.fn(), undefined, onErr);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(onErr).not.toHaveBeenCalled();
      expect(VoiceInput.getLastError()).toBeNull();

      slowStop.resolve();
      await stopping;
      await expect(resumed).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(VoiceInput.isListening()).toBe(true);
      expect(onErr).not.toHaveBeenCalled();

      // Genuine native stop rejection STILL surfaces the underlying error.
      speechApi.stop.mockRejectedValueOnce(new Error('native decoder error'));
      await VoiceInput.stopListening();
      expect(onErr).toHaveBeenCalledWith('native decoder error');
      expect(VoiceInput.getLastError()).toBe('native decoder error');
    } finally {
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('never times out during a 60s silent hold with zero recognition partials', async () => {
    vi.useFakeTimers();
    try {
      const onResult = vi.fn();
      const onErr = vi.fn();
      await expect(VoiceInput.startListening(onResult, undefined, onErr)).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);

      for (let i = 0; i < 6; i++) {
        listeners.audioLevel?.({ level: 0 });
        await vi.advanceTimersByTimeAsync(10_000);
      }

      expect(VoiceInput.isListening()).toBe(true);
      expect(onErr).not.toHaveBeenCalled();
      expect(VoiceInput.getLastError()).toBeNull();
      expect(onResult).not.toHaveBeenCalled();
    } finally {
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('VoiceOverlay + VoiceInput: coalesces Pause->Mic during slow drain, cancels queued resume on Send, and avoids false error on Pause during warmup', async () => {
    vi.useFakeTimers();
    try {
      const permGate = deferred<{ speechRecognition: string }>();
      speechApi.requestPermissions
        .mockReturnValueOnce(permGate.promise)
        .mockResolvedValue({ speechRecognition: 'granted' });
      const onSend = vi.fn(() => 'accepted' as const);
      const onClose = vi.fn();
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');

      const view = render(h(VoiceOverlay, {
        open: true,
        initialText: '',
        onSend,
        onClose,
      }));
      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.requestPermissions).toHaveBeenCalledTimes(1);

      // Pause while warmup/permission is still in flight: no false permission_denied alert
      const micBtn = document.querySelector('.voice-overlay-mic') as HTMLElement;
      fireEvent.click(micBtn);
      permGate.resolve({ speechRecognition: 'granted' });
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('[role="alert"]')).toBeNull();

      // Resume listening and capture speech
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      listeners.partialResults?.({ matches: ['first sentence'], isFinal: false });

      // Tap Pause -> slow native drain blocks stop()
      const slowStop1 = deferred<void>();
      speechApi.stop.mockReturnValueOnce(slowStop1.promise);
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(400);

      // Tap Mic twice while stop drain is still in flight -> coalesces to one resume
      fireEvent.click(micBtn);
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      listeners.partialResults?.({ matches: ['first sentence final'], isFinal: true });
      slowStop1.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(VoiceInput.isListening()).toBe(true);

      // Now Pause -> Mic (queued) -> Send BEFORE drain settles: Send cancels queued resume and sends cleanly
      const slowStop2 = deferred<void>();
      speechApi.stop.mockReturnValueOnce(slowStop2.promise);
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(400);
      fireEvent.click(micBtn);
      const sendBtn = document.querySelector('.voice-overlay-send') as HTMLElement;
      fireEvent.click(sendBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(onSend).not.toHaveBeenCalled();

      listeners.partialResults?.({ matches: ['second sentence'], isFinal: true });
      slowStop2.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('first sentence final second sentence');
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('VoiceOverlay + VoiceInput: sends immediately when already paused and recovers when native stop() rejects', async () => {
    vi.useFakeTimers();
    try {
      const onSend = vi.fn(() => 'accepted' as const);
      const onClose = vi.fn();
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');

      const view = render(h(VoiceOverlay, {
        open: true,
        initialText: '',
        onSend,
        onClose,
      }));
      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      listeners.partialResults?.({ matches: ['captured text'], isFinal: true });

      // If native stop() rejects on Pause, Pause stops capture, preserves draft, shows alert, and recovers cleanly
      speechApi.stop.mockRejectedValueOnce(new Error('native stop transient error'));
      const micBtn = document.querySelector('.voice-overlay-mic') as HTMLElement;
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(VoiceInput.isListening()).toBe(false);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('native stop transient error');
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('captured text');

      // Pause then Mic clears the error and works normally afterward
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(VoiceInput.isListening()).toBe(true);

      // Pause cleanly and wait for drain, then Send does not invoke another redundant stop()
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.stop).toHaveBeenCalledTimes(2);

      const sendBtn = document.querySelector('.voice-overlay-send') as HTMLElement;
      fireEvent.click(sendBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.stop).toHaveBeenCalledTimes(2);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('captured text');
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('VoiceOverlay + VoiceInput: slow native final past 15s waits cleanly without timeout alert and sends merged final tail once', async () => {
    vi.useFakeTimers();
    const drain = deferred<void>();
    speechApi.stop.mockReturnValueOnce(drain.promise).mockResolvedValue(undefined);
    const onSend = vi.fn(() => 'accepted' as const);
    const onClose = vi.fn();
    try {
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');
      const view = render(h(VoiceOverlay, { open: true, initialText: '', onSend, onClose }));
      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      listeners.partialResults?.({ matches: ['recognized prefix'], isFinal: false });
      await vi.advanceTimersByTimeAsync(0);

      fireEvent.click(document.querySelector('.voice-overlay-send') as HTMLElement);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(onSend).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('recognized prefix');

      // Late native final arrives after >15s cold decode -> merges tail and sends cleanly without error.
      listeners.partialResults?.({ matches: ['recognized prefix with final tail'], isFinal: true });
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('recognized prefix with final tail');
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      drain.resolve();
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('VoiceOverlay + VoiceInput: slow final within 4s sends merged final tail exactly once without alert', async () => {
    vi.useFakeTimers();
    const drain = deferred<void>();
    speechApi.stop.mockReturnValueOnce(drain.promise).mockResolvedValue(undefined);
    const onSend = vi.fn(() => 'accepted' as const);
    const onClose = vi.fn();
    try {
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');
      const view = render(h(VoiceOverlay, { open: true, initialText: '', onSend, onClose }));
      await vi.advanceTimersByTimeAsync(150);

      listeners.partialResults?.({ matches: ['recognized prefix'], isFinal: false });
      await vi.advanceTimersByTimeAsync(0);
      fireEvent.click(document.querySelector('.voice-overlay-send') as HTMLElement);
      await vi.advanceTimersByTimeAsync(500);
      expect(onSend).not.toHaveBeenCalled();

      listeners.partialResults?.({ matches: ['recognized prefix with final tail'], isFinal: true });
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith('recognized prefix with final tail');
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    } finally {
      drain.resolve();
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('VoiceOverlay + VoiceInput: queued Pause->Mic resume and notepad review respect drain failure without masking alert or clearing draft', async () => {
    vi.useFakeTimers();
    const slowDrain = deferred<void>();
    speechApi.stop
      .mockReturnValueOnce(slowDrain.promise)
      .mockRejectedValueOnce(new Error('review stop failed'))
      .mockResolvedValue(undefined);
    const onSend = vi.fn(() => 'accepted' as const);
    const onClose = vi.fn();
    try {
      const { VoiceOverlay } = await import('../../src/components/VoiceOverlay.js');
      const view = render(h(VoiceOverlay, { open: true, initialText: '', onSend, onClose }));
      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      listeners.partialResults?.({ matches: ['draft text'], isFinal: false });

      // Pause -> Mic while slow drain is pending; once slow drain settles, queued resume starts cleanly without error
      const micBtn = document.querySelector('.voice-overlay-mic') as HTMLElement;
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(200);
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(6000);
      expect(document.querySelector('[role="alert"]')).toBeNull();

      slowDrain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('draft text');

      // Switch to notepad cleanly -> Send/openReview hits genuine stop rejection
      fireEvent.click(document.querySelector('.voice-notepad-toggle') as HTMLElement);
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      listeners.partialResults?.({ matches: ['notepad line'], isFinal: true });

      fireEvent.click(document.querySelector('.voice-overlay-send') as HTMLElement);
      await vi.advanceTimersByTimeAsync(0);

      expect(document.querySelector('.voice-notepad-review')).toBeNull();
      expect(onSend).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('review stop failed');
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toContain('notepad line');
      view.unmount();
    } finally {
      slowDrain.resolve();
      cleanup();
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});


describe('mobile capture defenses', () => {
  it('pauses app playback before activating the native microphone', async () => {
    const media = document.createElement('audio');
    Object.defineProperty(media, 'paused', { value: false });
    const pause = vi.fn(); media.pause = pause; document.body.append(media);
    const cancel = vi.fn(); vi.stubGlobal('speechSynthesis', { cancel });
    speechApi.start.mockImplementationOnce(async () => {
      expect(pause).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
    });
    try { expect(await VoiceInput.startListening(vi.fn())).toBe(true); }
    finally { await VoiceInput.stopListening(); media.remove(); vi.unstubAllGlobals(); }
  });

  it('does not hard-stop a long native recording at 60 seconds', async () => {
    vi.useFakeTimers();
    try {
      await VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(120_000);
      expect(VoiceInput.isListening()).toBe(true);
      expect(speechApi.stop).not.toHaveBeenCalled();
    } finally { await VoiceInput.stopListening(); vi.useRealTimers(); }
  });

  it('cancelling via stopListening while requestPermissions is pending prevents late permission grant from starting native capture', async () => {
    const permGate = deferred<{ speechRecognition: string }>();
    speechApi.requestPermissions.mockReturnValueOnce(permGate.promise);
    try {
      const startTask = VoiceInput.startListening(vi.fn());
      const stopTask = VoiceInput.stopListening();
      permGate.resolve({ speechRecognition: 'granted' });
      expect(await startTask).toBe(false);
      await stopTask;
      expect(speechApi.start).not.toHaveBeenCalled();
      expect(VoiceInput.isListening()).toBe(false);

      // Next start succeeds normally
      expect(await VoiceInput.startListening(vi.fn())).toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
    } finally {
      await VoiceInput.stopListening();
    }
  });

  it('cancels a queued startListening waiting on an in-flight error stop drain when stopListening is called before the old stop ACK arrives', async () => {
    const oldStop = deferred<void>();
    speechApi.stop.mockReturnValueOnce(oldStop.promise).mockResolvedValue(undefined);
    try {
      expect(await VoiceInput.startListening(vi.fn())).toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      // Runtime recognitionError triggers asynchronous stop drain (oldStop pending)
      listeners.recognitionError?.({ message: 'decoder interrupted' });
      expect(speechApi.stop).toHaveBeenCalledTimes(1);

      // Retry start queues behind _pendingStop, then user releases (stopListening) before oldStop settles
      const retryStart = VoiceInput.startListening(vi.fn());
      const retryStop = VoiceInput.stopListening();

      oldStop.resolve();
      expect(await retryStart).toBe(false);
      await retryStop;

      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(false);
    } finally {
      oldStop.resolve();
      await VoiceInput.stopListening();
    }
  });

  for (const outcome of ['resolve', 'reject'] as const) {
    it(`retires a cancelled pending native start on stop (${outcome}) without wedging fresh start or clobbering the new owner`, async () => {
      vi.useFakeTimers();
      const startGate = deferred<Record<string, never>>();
      speechApi.start.mockReturnValueOnce(startGate.promise).mockResolvedValue({});
      try {
        const oldErr = vi.fn();
        const oldStart = VoiceInput.startListening(vi.fn(), undefined, oldErr);
        await vi.advanceTimersByTimeAsync(0);
        expect(speechApi.start).toHaveBeenCalledTimes(1);

        const stopped = VoiceInput.stopListening();
        if (outcome === 'resolve') startGate.resolve({});
        else startGate.reject(new Error('late stale start failure'));
        await expect(oldStart).resolves.toBe(false);
        await stopped;
        expect(oldErr).not.toHaveBeenCalled();

        const newResult = vi.fn();
        const newErr = vi.fn();
        const resumed = VoiceInput.startListening(newResult, undefined, newErr);
        await expect(resumed).resolves.toBe(true);
        expect(speechApi.start).toHaveBeenCalledTimes(2);
        expect(VoiceInput.isListening()).toBe(true);
        expect(newErr).not.toHaveBeenCalled();

        listeners.partialResults?.({ matches: ['new owner live speech'], isFinal: false });
        expect(newResult).toHaveBeenCalledWith('new owner live speech', false);
      } finally {
        startGate.resolve({});
        await vi.advanceTimersByTimeAsync(0);
        await VoiceInput.stopListening();
        await vi.advanceTimersByTimeAsync(0);
        vi.useRealTimers();
      }
    });
  }

  it('retires pending permission/available checks on stop and lets Stop->Mic->Stop cancel a queued resume', async () => {
    vi.useFakeTimers();
    const permGate = deferred<{ speechRecognition: string }>();
    const availGate = deferred<{ available: boolean }>();
    speechApi.requestPermissions
      .mockReturnValueOnce(permGate.promise)
      .mockResolvedValue({ speechRecognition: 'granted' });
    try {
      // Cancelled requestPermissions -> once old permission resolves, fresh start succeeds and stale attempt returns false
      const pStart = VoiceInput.startListening(vi.fn());
      const pStop = VoiceInput.stopListening();
      permGate.resolve({ speechRecognition: 'granted' });
      await expect(pStart).resolves.toBe(false);
      await pStop;

      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(true);

      // Stop -> Mic (queued during slow stop) -> Stop cancels queued Mic cleanly
      const slowStop = deferred<void>();
      speechApi.stop.mockReturnValueOnce(slowStop.promise).mockResolvedValue(undefined);
      const stop1 = VoiceInput.stopListening();
      const queuedMic = VoiceInput.startListening(vi.fn());
      const stop2 = VoiceInput.stopListening();
      slowStop.resolve();

      await expect(queuedMic).resolves.toBe(false);
      await stop1;
      await stop2;
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(false);

      // Cancelled available() check -> fresh start succeeds, stale available cannot spawn session 1
      speechApi.available
        .mockReturnValueOnce(availGate.promise)
        .mockResolvedValue({ available: true });
      const availStart = VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      const availStop = VoiceInput.stopListening();
      availGate.resolve({ available: true });
      await expect(availStart).resolves.toBe(false);
      await availStop;

      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(VoiceInput.isListening()).toBe(true);
    } finally {
      permGate.resolve({ speechRecognition: 'granted' });
      availGate.resolve({ available: true });
      await VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it('runs requestPermissions + available and all 4 addListener registrations concurrently, and cleans up handles on cancellation or partial failure', async () => {
    const permGate = deferred<{ speechRecognition: string }>();
    const availGate = deferred<{ available: boolean }>();
    speechApi.requestPermissions.mockReturnValueOnce(permGate.promise);
    speechApi.available.mockReturnValueOnce(availGate.promise);

    const listenerGates: Record<string, ReturnType<typeof deferred<{ remove: ReturnType<typeof vi.fn> }>>> = {};
    const removeSpies: Record<string, ReturnType<typeof vi.fn>> = {};
    speechApi.addListener.mockImplementation((eventName: string, handler: (data: any) => void) => {
      listeners[eventName] = handler;
      const gate = deferred<{ remove: ReturnType<typeof vi.fn> }>();
      listenerGates[eventName] = gate;
      removeSpies[eventName] = vi.fn(async () => undefined);
      return gate.promise;
    });

    try {
      const startPromise = VoiceInput.startListening(vi.fn());
      // Both permission and availability checks start concurrently in the initial round-trip.
      expect(speechApi.requestPermissions).toHaveBeenCalledTimes(1);
      expect(speechApi.available).toHaveBeenCalledTimes(1);

      permGate.resolve({ speechRecognition: 'granted' });
      availGate.resolve({ available: true });
      await waitFor(() => expect(speechApi.addListener).toHaveBeenCalledTimes(4));

      // Resolve 2 listeners and cancel before the remaining 2 settle.
      listenerGates.partialResults.resolve({ remove: removeSpies.partialResults });
      listenerGates.audioLevel.resolve({ remove: removeSpies.audioLevel });
      const stopPromise = VoiceInput.stopListening();

      listenerGates.listeningState.resolve({ remove: removeSpies.listeningState });
      listenerGates.recognitionError.resolve({ remove: removeSpies.recognitionError });

      await expect(startPromise).resolves.toBe(false);
      await stopPromise;
      expect(speechApi.start).not.toHaveBeenCalled();
      for (const name of ['partialResults', 'audioLevel', 'listeningState', 'recognitionError']) {
        expect(removeSpies[name]).toHaveBeenCalledOnce();
      }

      // Partial listener registration rejection cleans up resolved & late-resolving handles without leaking.
      speechApi.addListener.mockReset();
      const partialGates: Record<string, ReturnType<typeof deferred<{ remove: ReturnType<typeof vi.fn> }>>> = {};
      const partialRemovals: Record<string, ReturnType<typeof vi.fn>> = {};
      speechApi.addListener.mockImplementation((eventName: string) => {
        const gate = deferred<{ remove: ReturnType<typeof vi.fn> }>();
        partialGates[eventName] = gate;
        partialRemovals[eventName] = vi.fn(async () => undefined);
        return gate.promise;
      });

      const onError = vi.fn();
      const failedStart = VoiceInput.startListening(vi.fn(), undefined, onError);
      await waitFor(() => expect(speechApi.addListener).toHaveBeenCalledTimes(4));
      partialGates.partialResults.resolve({ remove: partialRemovals.partialResults });
      partialGates.audioLevel.reject(new Error('listener registration failed'));
      await expect(failedStart).resolves.toBe(false);
      expect(onError).toHaveBeenCalledWith('listener registration failed');
      expect(partialRemovals.partialResults).toHaveBeenCalledOnce();

      // Remaining listeners that resolve after abort are also immediately removed.
      partialGates.listeningState.resolve({ remove: partialRemovals.listeningState });
      partialGates.recognitionError.resolve({ remove: partialRemovals.recognitionError });
      await Promise.resolve();
      await Promise.resolve();
      expect(partialRemovals.listeningState).toHaveBeenCalledOnce();
      expect(partialRemovals.recognitionError).toHaveBeenCalledOnce();
      expect(speechApi.start).not.toHaveBeenCalled();
    } finally {
      permGate.resolve({ speechRecognition: 'granted' });
      availGate.resolve({ available: true });
      await VoiceInput.stopListening();
    }
  });

  it('bounds stalled native start/stop calls during stopListening({ abort: true }) so subsequent holds never wedge', async () => {
    vi.useFakeTimers();
    try {
      const hungStart = deferred<Record<string, never>>();
      const hungStop = deferred<void>();
      speechApi.start
        .mockReturnValueOnce(hungStart.promise)
        .mockResolvedValue({});
      speechApi.stop
        .mockReturnValueOnce(hungStop.promise)
        .mockResolvedValue(undefined);

      const firstStart = VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      let abortSettled = false;
      const aborted = VoiceInput.stopListening({ abort: true }).then(() => { abortSettled = true; });
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_ABORT_DRAIN_MS - 1);
      expect(abortSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await aborted;
      expect(abortSettled).toBe(true);
      expect(VoiceInput.isListening()).toBe(false);

      // Fresh start proceeds cleanly without needing an app restart even though old start/stop never resolved
      const onFreshResult = vi.fn();
      await expect(VoiceInput.startListening(onFreshResult)).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(VoiceInput.isListening()).toBe(true);

      // Clean up the abandoned hung promise cleanly after the fresh session is active
      hungStart.resolve({});
      hungStop.resolve();
      await vi.advanceTimersByTimeAsync(0);
      listeners.partialResults?.({ matches: ['new capture'], isFinal: false });
      expect(onFreshResult).toHaveBeenCalledWith('new capture', false);
      void firstStart;
    } finally {
      await VoiceInput.stopListening({ abort: true });
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});


describe('Web Mobile final drain', () => {
  function browser(opts: { autoStart?: boolean } = {}) {
    const autoStart = opts.autoStart ?? true;
    const instances: any[] = [];
    class Recognizer {
      onstart: any; onaudiostart: any; onresult: any; onend: any; onerror: any;
      start = vi.fn(() => {
        if (autoStart) this.onaudiostart?.();
      });
      stop = vi.fn();
      abort = vi.fn();
      constructor() { instances.push(this); }
    }
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    vi.stubGlobal('SpeechRecognition', Recognizer);
    return instances;
  }
  function final(rec: any, text: string) {
    const result: any = [{ transcript: text }]; result.isFinal = true;
    rec.onresult?.({ results: [result] });
  }

  it('retains final results after stop and serializes a new capture behind onend', async () => {
    const instances = browser(), first = vi.fn(), next = vi.fn();
    try {
      await VoiceInput.startListening(first);
      const rec = instances[0];
      const stop = VoiceInput.stopListening();
      const start = VoiceInput.startListening(next);
      expect(instances).toHaveLength(1);
      expect(rec.abort).not.toHaveBeenCalled();
      final(rec, 'before last word');
      expect(first).toHaveBeenLastCalledWith('before last word', true);
      rec.onend(); await stop; await start;
      expect(instances).toHaveLength(2);
      expect(next).not.toHaveBeenCalled();
      const stopped = VoiceInput.stopListening(); instances[1].onend(); await stopped;
    } finally { vi.unstubAllGlobals(); }
  });

  it('bounds a missing stop ACK without timing out a 120s active recording', async () => {
    vi.useFakeTimers();
    const instances = browser();
    try {
      await VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(120_000);
      expect(VoiceInput.isListening()).toBe(true);
      expect(instances[0].stop).not.toHaveBeenCalled();
      const stopped = VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(VoiceInput.WEB_FINAL_DRAIN_MS); await stopped;
      expect(instances[0].abort).toHaveBeenCalledOnce();
      expect(VoiceInput.getLastError()).toBeNull();
      expect(VoiceInput.isListening()).toBe(false);
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  function meterHarness() {
    const grants: ReturnType<typeof deferred<MediaStream>>[] = [];
    const frames: FrameRequestCallback[] = [];
    const created = vi.fn(), close = vi.fn(async () => {});
    const analyse = vi.fn((data: Uint8Array) => data.fill(128));
    const raf = vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal('navigator', {
      language: 'en-US',
      mediaDevices: { getUserMedia: vi.fn(() => {
        const grant = deferred<MediaStream>(); grants.push(grant); return grant.promise;
      }) },
    });
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    class MeterContext {
      constructor() { created(); }
      close = close;
      createMediaStreamSource() { return { connect: vi.fn() }; }
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 1, getByteTimeDomainData: analyse }; }
    }
    vi.stubGlobal('AudioContext', MeterContext);
    const stream = () => {
      const track = { stop: vi.fn() };
      return { track, value: { getTracks: () => [track] } as unknown as MediaStream };
    };
    return { grants, frames, created, close, analyse, raf, stream };
  }

  for (const terminal of ['onend', 'silent-fallback'] as const) {
    it.each(['before', 'during', 'after'])('releases meter grant %s Stop with ' + terminal + ' while retaining final text without error', async (timing) => {
      vi.useFakeTimers();
      const instances = browser(), meter = meterHarness(), media = meter.stream(), result = vi.fn(), levels = vi.fn(), onErr = vi.fn();
      try {
        VoiceInput.onAudioLevel(levels);
        await VoiceInput.startListening(result, undefined, onErr);
        if (timing === 'before') {
          meter.grants[0].resolve(media.value); await Promise.resolve(); await Promise.resolve();
          expect(meter.created).toHaveBeenCalledOnce();
        }
        const stopped = VoiceInput.stopListening();
        if (timing === 'during') {
          meter.grants[0].resolve(media.value); await Promise.resolve(); await Promise.resolve();
          expect(media.track.stop).toHaveBeenCalledOnce();
          expect(meter.created).not.toHaveBeenCalled();
        }
        if (timing === 'before') {
          // Even an already-dispatched frame must neither publish nor rearm
          // after capture stops, although transcript generation stays alive.
          meter.frames[0](0);
          expect(levels).not.toHaveBeenCalled();
          expect(meter.analyse).not.toHaveBeenCalled();
          expect(meter.raf).toHaveBeenCalledOnce();
        }
        final(instances[0], 'retained final tail');
        expect(result).toHaveBeenLastCalledWith('retained final tail', true);
        if (terminal === 'onend') instances[0].onend();
        else await vi.advanceTimersByTimeAsync(VoiceInput.WEB_FINAL_DRAIN_MS);
        await stopped;
        if (timing === 'after') {
          meter.grants[0].resolve(media.value); await Promise.resolve(); await Promise.resolve();
        }
        expect(VoiceInput.isListening()).toBe(false);
        expect(onErr).not.toHaveBeenCalled();
        expect(VoiceInput.getLastError()).toBeNull();
        expect(media.track.stop).toHaveBeenCalledOnce();
        expect(meter.created).toHaveBeenCalledTimes(timing === 'before' ? 1 : 0);
        expect(meter.close).toHaveBeenCalledTimes(timing === 'before' ? 1 : 0);
      } finally {
        const cleanup = VoiceInput.stopListening(); instances.at(-1)?.onend?.(); await cleanup;
        vi.useRealTimers(); vi.unstubAllGlobals();
      }
    });

    it('rejects the old delayed grant without closing the new owner after ' + terminal, async () => {
      vi.useFakeTimers();
      const instances = browser(), meter = meterHarness(), old = meter.stream(), current = meter.stream(), levels = vi.fn();
      try {
        VoiceInput.onAudioLevel(levels);
        await VoiceInput.startListening(vi.fn());
        const stopped = VoiceInput.stopListening();
        if (terminal === 'onend') instances[0].onend();
        else await vi.advanceTimersByTimeAsync(VoiceInput.WEB_FINAL_DRAIN_MS);
        await stopped;
        await VoiceInput.startListening(vi.fn());
        meter.grants[1].resolve(current.value); await Promise.resolve(); await Promise.resolve();
        meter.grants[0].resolve(old.value); await Promise.resolve(); await Promise.resolve();
        expect(old.track.stop).toHaveBeenCalledOnce();
        expect(current.track.stop).not.toHaveBeenCalled();
        expect(meter.created).toHaveBeenCalledOnce();
        expect(meter.close).not.toHaveBeenCalled();
        meter.frames[0](0);
        expect(levels).toHaveBeenCalledOnce(); // positive control: current owner still works
        const stopCurrent = VoiceInput.stopListening(); instances[1].onend(); await stopCurrent;
        expect(current.track.stop).toHaveBeenCalledOnce(); expect(meter.close).toHaveBeenCalledOnce();
      } finally {
        const cleanup = VoiceInput.stopListening(); instances.at(-1)?.onend?.(); await cleanup;
        vi.useRealTimers(); vi.unstubAllGlobals();
      }
    });
  }

  it('ignores an old already-dispatched meter frame after a new recording starts', async () => {
    const instances = browser(), meter = meterHarness(), old = meter.stream(), current = meter.stream(), levels = vi.fn();
    try {
      VoiceInput.onAudioLevel(levels);
      await VoiceInput.startListening(vi.fn());
      meter.grants[0].resolve(old.value); await Promise.resolve(); await Promise.resolve();
      const oldFrame = meter.frames[0];
      const stopped = VoiceInput.stopListening(); instances[0].onend(); await stopped;
      await VoiceInput.startListening(vi.fn());
      meter.grants[1].resolve(current.value); await Promise.resolve(); await Promise.resolve();
      oldFrame(0);
      expect(levels).not.toHaveBeenCalled(); expect(meter.raf).toHaveBeenCalledTimes(2);
      meter.frames[1](0);
      expect(levels).toHaveBeenCalledOnce();
      expect(old.track.stop).toHaveBeenCalledOnce(); expect(current.track.stop).not.toHaveBeenCalled();
      const stopCurrent = VoiceInput.stopListening(); instances[1].onend(); await stopCurrent;
      expect(current.track.stop).toHaveBeenCalledOnce(); expect(meter.close).toHaveBeenCalledTimes(2);
    } finally {
      const cleanup = VoiceInput.stopListening(); instances.at(-1)?.onend?.(); await cleanup;
      vi.unstubAllGlobals();
    }
  });

  it('aborts Web Speech immediately without waiting for WEB_FINAL_DRAIN_MS and keeps subsequent sessions clean', async () => {
    vi.useFakeTimers();
    const instances = browser();
    try {
      const staleResult = vi.fn();
      await expect(VoiceInput.startListening(staleResult)).resolves.toBe(true);
      expect(instances).toHaveLength(1);

      let settled = false;
      const abortStop = VoiceInput.stopListening({ abort: true }).then(() => { settled = true; });
      await abortStop;
      expect(settled).toBe(true);
      expect(instances[0].abort).toHaveBeenCalledTimes(1);
      expect(instances[0].stop).not.toHaveBeenCalled();

      // Stale result or delayed onend timer cannot leak or bump generation for a new session
      final(instances[0], 'cancelled tail');
      expect(staleResult).not.toHaveBeenCalled();

      const freshResult = vi.fn();
      await expect(VoiceInput.startListening(freshResult)).resolves.toBe(true);
      expect(instances).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(VoiceInput.WEB_FINAL_DRAIN_MS + 100);
      final(instances[1], 'fresh capture');
      expect(freshResult).toHaveBeenCalledWith('fresh capture', true);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('does not confirm Web Speech capture on synchronous rec.start() alone, surfaces async not-allowed cleanly, deduplicates onstart+onaudiostart, and fences retired sessions', async () => {
    const instances = browser({ autoStart: false });
    const meter = meterHarness();
    const listeningEvents: boolean[] = [];
    const errors: string[] = [];
    try {
      // 1. Async permission denial after rec.start() returns synchronously
      const accepted = await VoiceInput.startListening(
        vi.fn(),
        (v) => listeningEvents.push(v),
        (err) => errors.push(err),
      );
      expect(accepted).toBe(true);
      expect(instances).toHaveLength(1);
      expect(VoiceInput.isListening()).toBe(false);
      expect(listeningEvents).toEqual([]);
      expect(meter.grants).toHaveLength(0);

      // Browser rejects permission asynchronously before onstart/onaudiostart
      instances[0].onerror?.({ error: 'not-allowed' });
      expect(errors).toEqual(['permission_denied']);
      expect(listeningEvents).toEqual([]);
      expect(VoiceInput.isListening()).toBe(false);
      instances[0].onend?.();
      await Promise.resolve();

      // 2. Old aborted session's late onstart/onaudiostart must NOT taint a fresh pending session
      const secondListening: boolean[] = [];
      const secondErrors: string[] = [];
      await VoiceInput.startListening(vi.fn(), (v) => secondListening.push(v), (e) => secondErrors.push(e));
      expect(instances).toHaveLength(2);
      const staleRec = instances[0];
      const freshRec = instances[1];
      staleRec.onstart?.();
      staleRec.onaudiostart?.();
      expect(secondListening).toEqual([]);
      expect(VoiceInput.isListening()).toBe(false);

      // 3. Real capture confirmation via onstart + onaudiostart fires listening(true) once & starts meter
      freshRec.onstart?.();
      freshRec.onaudiostart?.();
      expect(secondListening).toEqual([true]);
      expect(VoiceInput.isListening()).toBe(true);
      expect(meter.grants).toHaveLength(1);

      // Clean abort retires capture and ignores late handlers
      await VoiceInput.stopListening({ abort: true });
      expect(VoiceInput.isListening()).toBe(false);
      expect(secondErrors).toEqual([]);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.unstubAllGlobals();
    }
  });

  it('fences retired native stop rejections/resolutions and hung starts from polluting a fresh post-abort owner, detaches handles immediately on abort, and still reports real errors to the current owner', async () => {
    vi.useFakeTimers();
    const removeSpies: Array<ReturnType<typeof vi.fn>> = [];
    speechApi.addListener.mockImplementation(async (eventName: string, handler: (data: any) => void) => {
      listeners[eventName] = handler;
      const remove = vi.fn(async () => undefined);
      removeSpies.push(remove);
      return { remove };
    });

    const oldStop = deferred<void>();
    speechApi.stop
      .mockReturnValueOnce(oldStop.promise)
      .mockResolvedValue(undefined);
    try {
      const staleError = vi.fn();
      await expect(VoiceInput.startListening(vi.fn(), undefined, staleError)).resolves.toBe(true);
      const sessionARemoveCount = removeSpies.length;
      expect(sessionARemoveCount).toBe(4);

      // 1. Real native stopped event starts an ordinary stop drain that hangs.
      listeners.listeningState?.({ status: 'stopped' });
      expect(speechApi.stop).toHaveBeenCalledTimes(1);

      // 2. Abort retires session A and detaches session A listener handles immediately even while oldStop is still hung.
      const cancelled = VoiceInput.stopListening({ abort: true });
      await vi.advanceTimersByTimeAsync(0);
      for (const remove of removeSpies.slice(0, sessionARemoveCount)) {
        expect(remove).toHaveBeenCalledTimes(1);
      }
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_ABORT_DRAIN_MS);
      await cancelled;

      // 3. Fresh owner B starts cleanly.
      const freshResult = vi.fn();
      const freshListening = vi.fn();
      const freshError = vi.fn();
      await expect(VoiceInput.startListening(freshResult, freshListening, freshError)).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);

      // 4. Retired stop from A rejects late -> MUST NOT reach freshError, overwrite getLastError, or corrupt B's listening state.
      oldStop.reject(new Error('old owner stop failed late'));
      await vi.advanceTimersByTimeAsync(0);
      expect(freshError).not.toHaveBeenCalled();
      expect(staleError).not.toHaveBeenCalled();
      expect(VoiceInput.getLastError()).toBeNull();
      expect(VoiceInput.isListening()).toBe(true);
      listeners.partialResults?.({ matches: ['fresh capture B'], isFinal: false });
      expect(freshResult).toHaveBeenCalledWith('fresh capture B', false);

      // 5. Positive control: a real stop failure belonging to the CURRENT owner IS still surfaced.
      speechApi.stop.mockRejectedValueOnce(new Error('current owner decoder error'));
      await VoiceInput.stopListening();
      expect(freshError).toHaveBeenCalledWith('current owner decoder error');
      expect(VoiceInput.getLastError()).toBe('current owner decoder error');
      expect(VoiceInput.isListening()).toBe(false);
    } finally {
      oldStop.resolve();
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
    }
  });

  it('never lets a retired native hung start() stop a newer session when that old start finally resolves', async () => {
    vi.useFakeTimers();
    const hungA = deferred<Record<string, never>>();
    speechApi.start.mockReturnValueOnce(hungA.promise).mockResolvedValue({});
    speechApi.stop.mockImplementation(() => new Promise<void>(() => {}));
    try {
      const startAPromise = VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      const abortPromise = VoiceInput.stopListening({ abort: true });
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_ABORT_DRAIN_MS);
      await abortPromise;
      expect(speechApi.stop).toHaveBeenCalledTimes(1);

      speechApi.stop.mockResolvedValue(undefined);
      const startBPromise = VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      await expect(startBPromise).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);

      hungA.resolve({});
      await vi.advanceTimersByTimeAsync(0);
      await expect(startAPromise).resolves.toBe(false);
      // Hung A resolving must NOT issue an extra stop() against active session B
      expect(speechApi.stop).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(true);
      await VoiceInput.stopListening({ abort: true });
    } finally {
      hungA.resolve({});
      vi.useRealTimers();
    }
  });

  it('prewarm deduplicates concurrent checks, caches ready state for startListening, and invalidates on TTL or failure', async () => {
    vi.useFakeTimers();
    try {
      const checkGate = deferred<{ speechRecognition: string }>();
      const availGate = deferred<{ available: boolean }>();
      speechApi.checkPermissions.mockReturnValueOnce(checkGate.promise);
      speechApi.available.mockReturnValueOnce(availGate.promise);

      const p1 = VoiceInput.prewarm({ requestPermission: false });
      const p2 = VoiceInput.prewarm({ requestPermission: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.checkPermissions).toHaveBeenCalledTimes(1);
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();

      checkGate.resolve({ speechRecognition: 'granted' });
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.available).toHaveBeenCalledTimes(1);
      availGate.resolve({ available: true });
      await Promise.all([p1, p2]);

      // Subsequent startListening reuses cached prewarm state with zero extra IPC roundtrips
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();
      expect(speechApi.available).toHaveBeenCalledTimes(1);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      await VoiceInput.stopListening({ abort: true });

      // When checkPermissions is not granted yet, passive prewarm skips OS permission prompt cleanly
      speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'prompt' });
      speechApi.available.mockResolvedValueOnce({ available: true });
      await vi.advanceTimersByTimeAsync(16_000); // expire TTL
      await VoiceInput.prewarm({ requestPermission: false });
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();

      // Holding calls startListening -> requests permission once without re-querying available()
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.requestPermissions).toHaveBeenCalledTimes(1);
      expect(speechApi.available).toHaveBeenCalledTimes(2);
      await VoiceInput.stopListening({ abort: true });

      // Permission denied or start failure after TTL never throws out of prewarm and invalidates cache
      await vi.advanceTimersByTimeAsync(16_000);
      speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
      speechApi.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
      await expect(VoiceInput.prewarm()).resolves.toBeUndefined();
      expect(speechApi.requestPermissions).toHaveBeenCalledTimes(2);
      speechApi.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
      speechApi.available.mockResolvedValueOnce({ available: true });
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.requestPermissions).toHaveBeenCalledTimes(3);
      await VoiceInput.stopListening({ abort: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips competing getUserMedia level meter across all touch browsers (including Request Desktop Website UAs) while preserving non-touch desktop meter', async () => {
    const instances = browser({ autoStart: false });
    const meter = meterHarness();
    const origUa = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    const origTouch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    const listening: boolean[] = [];
    const errors: string[] = [];
    const partials: Array<[string, boolean]> = [];
    const runProfile = async (ua: string, touchPoints: number, expectedGrants: number, phrase: string) => {
      meter.grants.length = 0;
      Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: touchPoints, configurable: true });
      await expect(VoiceInput.startListening(
        (text, isFinal) => partials.push([text, isFinal]),
        (v) => listening.push(v),
        (err) => errors.push(err),
      )).resolves.toBe(true);
      const rec = instances[instances.length - 1];
      rec.onstart?.();
      rec.onaudiostart?.();
      await Promise.resolve();
      expect(meter.grants).toHaveLength(expectedGrants);
      final(rec, phrase);
      const stopPromise = VoiceInput.stopListening();
      rec.onend?.();
      await stopPromise;
    };
    try {
      // 1. Mobile iPhone UA + touch -> 0 getUserMedia grants
      await runProfile(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
        5,
        0,
        'iphone transcript',
      );
      // 2. iPad Safari "Request Desktop Website" (Macintosh UA + touch) -> 0 getUserMedia grants
      await runProfile(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        5,
        0,
        'ipad desktop mode transcript',
      );
      // 3. Android Chrome "Desktop site" (X11 Linux UA + touch) -> 0 getUserMedia grants
      await runProfile(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        5,
        0,
        'android desktop mode transcript',
      );
      // 4. Non-touch desktop browser -> keeps optional Web level meter (1 grant)
      await runProfile(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        0,
        1,
        'desktop meter transcript',
      );
      expect(listening).toEqual([true, false, true, false, true, false, true, false]);
      expect(partials).toEqual([
        ['iphone transcript', true],
        ['ipad desktop mode transcript', true],
        ['android desktop mode transcript', true],
        ['desktop meter transcript', true],
      ]);
      expect(errors).toEqual([]);

      // Stopping before onstart drains cleanly without spurious permission_denied
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
      await expect(VoiceInput.startListening(
        (text, isFinal) => partials.push([text, isFinal]),
        undefined,
        (err) => errors.push(err),
      )).resolves.toBe(true);
      const earlyStop = VoiceInput.stopListening();
      const drainRec = instances[instances.length - 1];
      drainRec.onstart?.();
      drainRec.onend?.();
      await earlyStop;
      expect(errors).toEqual([]);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      if (origUa) Object.defineProperty(navigator, 'userAgent', origUa);
      else delete (navigator as any).userAgent;
      if (origTouch) Object.defineProperty(navigator, 'maxTouchPoints', origTouch);
      else delete (navigator as any).maxTouchPoints;
      vi.unstubAllGlobals();
    }
  });

  it('supports synchronous primeWebGesture adoption, silent short-tap cancel, and buffered pre-adopt errors/results', async () => {
    const instances = browser({ autoStart: false });
    const origTouch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    try {
      // 1. Short tap: prime synchronously in pointerdown, then cancelWebGesturePrime() before hold activates -> aborts with 0 errors
      const globalErr = vi.fn();
      VoiceInput.onRecognitionError(globalErr);
      expect(VoiceInput.primeWebGesture({ deferAudioPause: true })).toBe(true);
      expect(instances).toHaveLength(1);
      expect(instances[0].start).toHaveBeenCalledTimes(1);
      VoiceInput.cancelWebGesturePrime();
      expect(instances[0].abort).toHaveBeenCalledTimes(1);
      expect(globalErr).not.toHaveBeenCalled();

      // 2. Real hold / overlay open: prime synchronously, then startListening adopts the SAME instance without abort/re-create
      expect(VoiceInput.primeWebGesture({ deferAudioPause: true })).toBe(true);
      expect(instances).toHaveLength(2);
      const primedRec = instances[1];
      primedRec.onstart?.();
      primedRec.onresult?.({
        results: {
          length: 1,
          0: { 0: { transcript: 'early hello' }, isFinal: false },
        },
      });
      const results: Array<[string, boolean]> = [];
      const listening: boolean[] = [];
      const errors: string[] = [];
      await expect(VoiceInput.startListening(
        (text, isFinal) => results.push([text, isFinal]),
        (v) => listening.push(v),
        (err) => errors.push(err),
      )).resolves.toBe(true);
      expect(instances).toHaveLength(2);
      expect(primedRec.abort).not.toHaveBeenCalled();
      expect(listening).toEqual([true]);
      expect(results).toEqual([['early hello', false]]);
      // cancelWebGesturePrime() is a no-op once adopted
      VoiceInput.cancelWebGesturePrime();
      expect(primedRec.abort).not.toHaveBeenCalled();
      const stopped = VoiceInput.stopListening();
      primedRec.onend?.();
      await stopped;
      // Interim-only transcript promoted to final on clean stop
      expect(results).toEqual([['early hello', false], ['early hello', true]]);
      expect(errors).toEqual([]);

      // 3. Buffered early not-allowed during prime stays silent until adopted, then reports cleanly
      expect(VoiceInput.primeWebGesture({ deferAudioPause: true })).toBe(true);
      expect(instances).toHaveLength(3);
      instances[2].onerror?.({ error: 'not-allowed' });
      expect(globalErr).not.toHaveBeenCalled();
      const errResults: string[] = [];
      await expect(VoiceInput.startListening(
        vi.fn(),
        undefined,
        (err) => errResults.push(err),
      )).resolves.toBe(false);
      expect(errResults).toEqual(['permission_denied']);
      // 4. Primed capture ending cleanly with empty text before startListening adopts must NOT restart outside user gesture
      expect(VoiceInput.primeWebGesture({ deferAudioPause: true })).toBe(true);
      expect(instances).toHaveLength(4);
      const emptyPrimedRec = instances[3];
      emptyPrimedRec.onstart?.();
      emptyPrimedRec.onend?.();
      const emptyListening: boolean[] = [];
      const emptyErrors: string[] = [];
      await expect(VoiceInput.startListening(
        vi.fn(),
        (v) => emptyListening.push(v),
        (err) => emptyErrors.push(err),
      )).resolves.toBe(true);
      expect(instances).toHaveLength(4);
      expect(emptyListening).toEqual([true, false]);
      expect(emptyErrors).toEqual([]);
      expect(VoiceInput.isListening()).toBe(false);
    } finally {
      VoiceInput.onRecognitionError(null);
      await VoiceInput.stopListening({ abort: true });
      if (origTouch) Object.defineProperty(navigator, 'maxTouchPoints', origTouch);
      else delete (navigator as any).maxTouchPoints;
      vi.unstubAllGlobals();
    }
  });

  it('promotes interim-only result to final on natural rec.onend and resolves subsequent stopListening immediately without 10s drain wait', async () => {
    vi.useFakeTimers();
    const instances = browser({ autoStart: false });
    const origTouch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
    try {
      const results: Array<[string, boolean]> = [];
      const listening: boolean[] = [];
      await expect(VoiceInput.startListening(
        (text, isFinal) => results.push([text, isFinal]),
        (v) => listening.push(v),
      )).resolves.toBe(true);
      const rec = instances[0];
      rec.onstart?.();
      rec.onresult?.({
        results: {
          length: 1,
          0: { 0: { transcript: 'mobile speech works' }, isFinal: false },
        },
      });
      // Browser auto-ends (e.g. iOS Safari) before user calls stopListening
      rec.onend?.();
      expect(results).toEqual([['mobile speech works', false], ['mobile speech works', true]]);
      expect(listening).toEqual([true, false]);

      // Subsequent stopListening() resolves immediately without calling rec.stop() or waiting WEB_FINAL_DRAIN_MS
      let resolved = false;
      const stopPromise = VoiceInput.stopListening().then(() => { resolved = true; });
      await stopPromise;
      expect(resolved).toBe(true);
      expect(rec.stop).not.toHaveBeenCalled();
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
      if (origTouch) Object.defineProperty(navigator, 'maxTouchPoints', origTouch);
      else delete (navigator as any).maxTouchPoints;
      vi.unstubAllGlobals();
    }
  });

  it('bounds native prewarm, available/start hangs, and hung stop drains so startup never deadlocks and promotes on live partialResults', async () => {
    vi.useFakeTimers();
    try {
      // 1. Hung passive prewarm (checkPermissions never resolves) must NOT wedge startListening past NATIVE_PREWARM_CALL_TIMEOUT_MS
      speechApi.checkPermissions.mockReturnValueOnce(new Promise(() => {}));
      const prewarmPromise = VoiceInput.prewarm({ requestPermission: false });
      const errLog: string[] = [];
      const listenLog: boolean[] = [];
      const resultsLog: Array<[string, boolean]> = [];
      const startAfterHungPrewarm = VoiceInput.startListening(
        (t, f) => resultsLog.push([t, f]),
        (l) => listenLog.push(l),
        (e) => errLog.push(e),
      );

      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_PREWARM_CALL_TIMEOUT_MS + 10);
      await expect(startAfterHungPrewarm).resolves.toBe(true);
      await prewarmPromise;
      expect(VoiceInput.isListening()).toBe(true);
      expect(errLog).toEqual([]);
      expect(listenLog).toEqual([true]);
      await VoiceInput.stopListening({ abort: true });

      // 2. Hung native start() times out cleanly after NATIVE_START_TIMEOUT_MS, issues best-effort stop, emits timeout error, and unlocks next retry
      speechApi.start.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce({});
      speechApi.stop.mockResolvedValue(undefined);
      const hungStartErrors: string[] = [];
      const hungStartListening: boolean[] = [];
      const hungStartPromise = VoiceInput.startListening(
        vi.fn(),
        (l) => hungStartListening.push(l),
        (e) => hungStartErrors.push(e),
      );
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_START_TIMEOUT_MS);
      await expect(hungStartPromise).resolves.toBe(false);
      expect(hungStartErrors).toEqual(['Speech recognition timed out']);
      expect(hungStartListening).toEqual([false]);
      expect(VoiceInput.isListening()).toBe(false);
      expect(speechApi.stop).toHaveBeenCalled();

      // Immediate retry succeeds cleanly (and partialResults promotes listening=true even if listeningState: started arrived late)
      const deferredStart = deferred<Record<string, never>>();
      speechApi.start.mockReturnValueOnce(deferredStart.promise);
      const retryListening: boolean[] = [];
      const retryResults: Array<[string, boolean]> = [];
      const retryPromise = VoiceInput.startListening(
        (t, f) => retryResults.push([t, f]),
        (l) => retryListening.push(l),
      );
      await vi.advanceTimersByTimeAsync(0);
      listeners.partialResults?.({ matches: ['early partial'], isFinal: false });
      expect(retryListening).toEqual([true]);
      expect(retryResults).toEqual([['early partial', false]]);
      expect(VoiceInput.isListening()).toBe(true);
      deferredStart.resolve({});
      await expect(retryPromise).resolves.toBe(true);

      // 3. Hung normal stop() past NATIVE_STOP_DRAIN_MS releases _pendingStop so subsequent starts recover cleanly
      speechApi.stop.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(undefined);
      const stuckStop = VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_STOP_DRAIN_MS);
      await stuckStop;
      expect(VoiceInput.isListening()).toBe(false);
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
    }
  });

  it('bounds silent Web Speech stalls (missing onstart/onaudiostart/onerror/onend) via WEB_START_CONFIRM_TIMEOUT_MS and unlocks immediate retry', async () => {
    vi.useFakeTimers();
    const instances = browser({ autoStart: false });
    try {
      const listening: boolean[] = [];
      const errors: string[] = [];
      await expect(VoiceInput.startListening(
        vi.fn(),
        (v) => listening.push(v),
        (e) => errors.push(e),
      )).resolves.toBe(true);

      expect(VoiceInput.isListening()).toBe(false);
      expect(errors).toEqual([]);

      await vi.advanceTimersByTimeAsync(VoiceInput.WEB_START_CONFIRM_TIMEOUT_MS);
      expect(instances[0].abort).toHaveBeenCalledOnce();
      expect(errors).toEqual(['Speech recognition timed out']);
      expect(listening).toEqual([false]);
      expect(VoiceInput.isListening()).toBe(false);

      // Next session recovers immediately once Web Speech fires onstart
      const nextListening: boolean[] = [];
      const nextErrors: string[] = [];
      await expect(VoiceInput.startListening(
        vi.fn(),
        (v) => nextListening.push(v),
        (e) => nextErrors.push(e),
      )).resolves.toBe(true);
      instances[1].onstart?.();
      expect(nextListening).toEqual([true]);
      expect(nextErrors).toEqual([]);
      expect(VoiceInput.isListening()).toBe(true);
      const stopped = VoiceInput.stopListening();
      instances[1].onend?.();
      await stopped;
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('retired native start timeout never stops a newer session in either catch branch (F1)', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.useFakeTimers();
    try {
      // Subcase 1: primary recognition.start() hangs past abort drain, B starts, then A's 8s timeout fires (startErr catch)
      const hungStartA = deferred<Record<string, never>>();
      speechApi.start.mockReturnValueOnce(hungStartA.promise);
      const errorsA: string[] = [];
      const startA = VoiceInput.startListening(vi.fn(), vi.fn(), (e) => errorsA.push(e));
      await vi.advanceTimersByTimeAsync(100);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      const abortA = VoiceInput.stopListening({ abort: true });
      expect(speechApi.stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_ABORT_DRAIN_MS);
      await abortA;

      const resultsB: Array<[string, boolean]> = [];
      const listeningB: boolean[] = [];
      const errorsB: string[] = [];
      speechApi.start.mockResolvedValueOnce({});
      const startedB = await VoiceInput.startListening(
        (t, f) => resultsB.push([t, f]),
        (v) => listeningB.push(v),
        (e) => errorsB.push(e),
      );
      expect(startedB).toBe(true);
      expect(VoiceInput.isListening()).toBe(true);
      expect(speechApi.stop).toHaveBeenCalledTimes(1);

      // Advance past A's 8s start timeout while B is actively recording
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_START_TIMEOUT_MS + 100);
      await expect(startA).resolves.toBe(false);
      expect(speechApi.stop).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(true);
      expect(errorsB).toEqual([]);
      expect(listeningB).not.toContain(false);

      // B completes cleanly
      await VoiceInput.stopListening();
      expect(speechApi.stop).toHaveBeenCalledTimes(2);

      // Subcase 2: requestPermissions() hangs past abort drain, B starts, then A's 5s permission timeout fires (outer catch)
      await VoiceInput.stopListening({ abort: true });
      speechApi.stop.mockClear();
      const hungPermsA = deferred<{ speechRecognition: string }>();
      speechApi.requestPermissions.mockReturnValueOnce(hungPermsA.promise);
      const startA2 = VoiceInput.startListening(vi.fn(), vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(50);

      const abortA2 = VoiceInput.stopListening({ abort: true });
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_ABORT_DRAIN_MS);
      await abortA2;
      const stopCountBeforeB2 = speechApi.stop.mock.calls.length;

      speechApi.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
      speechApi.start.mockResolvedValueOnce({});
      await expect(VoiceInput.startListening(vi.fn(), vi.fn(), vi.fn())).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);

      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_PERMISSION_TIMEOUT_MS + 100);
      await expect(startA2).resolves.toBe(false);
      expect(speechApi.stop).toHaveBeenCalledTimes(stopCountBeforeB2);
      expect(VoiceInput.isListening()).toBe(true);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
    }
  });

  it('cleans up late-resolving native addListener handle after registration timeout (F2)', async () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.useFakeTimers();
    try {
      const delayedListener = deferred<{ remove: ReturnType<typeof vi.fn> }>();
      const lateRemoveSpy = vi.fn(async () => undefined);
      const earlyRemoveSpies: Array<ReturnType<typeof vi.fn>> = [];
      speechApi.addListener.mockImplementation(async (eventName: string) => {
        if (eventName === 'listeningState') {
          return delayedListener.promise;
        }
        const remove = vi.fn(async () => undefined);
        earlyRemoveSpies.push(remove);
        return { remove };
      });

      const errors: string[] = [];
      const startPromise = VoiceInput.startListening(vi.fn(), vi.fn(), (e) => errors.push(e));
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_PREWARM_CALL_TIMEOUT_MS + 50);

      await expect(startPromise).resolves.toBe(false);
      expect(errors).toEqual(['Speech listener registration timed out']);
      for (const remove of earlyRemoveSpies) {
        expect(remove).toHaveBeenCalledTimes(1);
      }
      expect(lateRemoveSpy).not.toHaveBeenCalled();

      // Plugin finally resolves addListener well after timeout expired -> handle must be removed immediately
      delayedListener.resolve({ remove: lateRemoveSpy });
      await vi.advanceTimersByTimeAsync(0);
      expect(lateRemoveSpy).toHaveBeenCalledTimes(1);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      vi.useRealTimers();
    }
  });

  it('invokes native prewarm?.() during prewarm, ignores prewarm failures, overlaps uncached addListener with checks, and does not stall start on slow passive prewarm', async () => {
    const prewarmSpy = vi.fn(async () => undefined);
    (speechApi as any).prewarm = prewarmSpy;
    try {
      // 1. Concurrent prewarm triggers native prewarm() once and caches checks cleanly
      await Promise.all([
        VoiceInput.prewarm({ requestPermission: false }),
        VoiceInput.prewarm({ requestPermission: false }),
      ]);
      expect(prewarmSpy).toHaveBeenCalledTimes(1);

      // Subsequent start consumes warm cache with 0 extra permission/available IPC calls
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();
      expect(speechApi.available).toHaveBeenCalledTimes(1);
      await VoiceInput.stopListening({ abort: true });

      // 2. Native prewarm() rejection never breaks VoiceInput.prewarm() or cache population
      vi.resetModules();
      speechApi.available.mockClear();
      speechApi.checkPermissions.mockClear();
      prewarmSpy.mockRejectedValueOnce(new Error('metal warmup skipped'));
      VoiceInput = await import('../../src/components/VoiceInput.js');
      await expect(VoiceInput.prewarm({ requestPermission: false })).resolves.toBeUndefined();
      expect(prewarmSpy).toHaveBeenCalledTimes(2);

      // 3. Uncached start overlaps addListener with pending requestPermissions + available and skips stalled passive prewarm
      vi.resetModules();
      delete (speechApi as any).prewarm;
      speechApi.addListener.mockClear();
      speechApi.requestPermissions.mockClear();
      speechApi.available.mockClear();
      VoiceInput = await import('../../src/components/VoiceInput.js');

      const slowPassiveCheck = deferred<{ speechRecognition: string }>();
      speechApi.checkPermissions.mockReturnValueOnce(slowPassiveCheck.promise);
      const passivePrewarm = VoiceInput.prewarm({ requestPermission: false });

      const permGate = deferred<{ speechRecognition: string }>();
      const availGate = deferred<{ available: boolean }>();
      speechApi.requestPermissions.mockReturnValueOnce(permGate.promise);
      speechApi.available.mockReturnValueOnce(availGate.promise);

      const startPromise = VoiceInput.startListening(vi.fn());
      // Listeners register in parallel immediately without waiting for slow passive prewarm or sequential perm/avail settle
      await waitFor(() => expect(speechApi.addListener).toHaveBeenCalledTimes(4));
      expect(speechApi.requestPermissions).toHaveBeenCalledTimes(1);
      expect(speechApi.available).toHaveBeenCalledTimes(1);

      permGate.resolve({ speechRecognition: 'granted' });
      availGate.resolve({ available: true });
      await expect(startPromise).resolves.toBe(true);
      slowPassiveCheck.resolve({ speechRecognition: 'granted' });
      await passivePrewarm;
      await VoiceInput.stopListening({ abort: true });
    } finally {
      delete (speechApi as any).prewarm;
      await VoiceInput.stopListening({ abort: true });
    }
  });

  it('passes dynamic UI language in follow mode (including fallback and post-prewarm updates) and omits language in auto-detect mode on native and Web Speech', async () => {
    const mockStorage = (() => {
      const store = new Map<string, string>();
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
      };
    })();
    vi.stubGlobal('localStorage', mockStorage);
    try {
      // 1. Default mode is 'follow': prewarm first, then change UI language to ja -> native start receives ja-JP
      expect(VoiceInput.getVoiceLanguageMode()).toBe('follow');
      await VoiceInput.prewarm({ requestPermission: false });
      mockStorage.setItem('imcodes_lang', 'ja');
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledWith(expect.objectContaining({ language: 'ja-JP' }));
      await VoiceInput.stopListening({ abort: true });

      // 2. Switching UI language to zh-TW updates next start without re-prewarm
      speechApi.start.mockClear();
      mockStorage.setItem('imcodes_lang', 'zh-TW');
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledWith(expect.objectContaining({ language: 'zh-Hant' }));
      await VoiceInput.stopListening({ abort: true });

      // 3. Auto-detect mode omits language property completely on native start
      speechApi.start.mockClear();
      VoiceInput.setVoiceLanguageMode('auto');
      expect(VoiceInput.getVoiceLanguageMode()).toBe('auto');
      expect(VoiceInput.pickRecognitionLocale()).toBeUndefined();
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      const autoArgs = speechApi.start.mock.calls[0]?.[0] as Record<string, unknown>;
      expect('language' in autoArgs).toBe(false);
      await VoiceInput.stopListening({ abort: true });

      // 4. Web Speech follows UI language in 'follow' mode and resolves browser system locale (never '') in 'auto' mode
      const instances = browser();
      VoiceInput.setVoiceLanguageMode('follow');
      mockStorage.setItem('imcodes_lang', 'ja');
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(instances[0].lang).toBe('ja-JP');
      await VoiceInput.stopListening({ abort: true });

      vi.stubGlobal('navigator', { languages: ['zh-CN', 'en-US'], language: 'zh-CN' });
      VoiceInput.setVoiceLanguageMode('auto');
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(instances[1].lang).toBe('zh-CN');
      await VoiceInput.stopListening({ abort: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('primes native gesture on finger down once authorized, defers audio pause, replays buffered partials on adopt, and never prompts inside primeVoiceGesture', async () => {
    const audioPause = vi.fn();
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    audio.pause = audioPause;
    document.body.appendChild(audio);
    try {
      // Uncached/unauthorized state -> primeVoiceGesture refuses synchronously and never prompts permissions
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(false);
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();
      expect(speechApi.start).not.toHaveBeenCalled();

      // Passive prewarm confirms granted permission + availability without prompting
      speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
      speechApi.available.mockResolvedValueOnce({ available: true });
      await VoiceInput.prewarm({ requestPermission: false });
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();

      // Finger down: primeVoiceGesture starts native capture immediately with deferred audio pause
      const earlyLevels: number[] = [];
      VoiceInput.onAudioLevel((lvl) => earlyLevels.push(lvl));
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
      await waitFor(() => expect(speechApi.start).toHaveBeenCalledTimes(1));
      expect(audioPause).not.toHaveBeenCalled();

      // Early audio level while primed stays suppressed; early first-syllable partial is buffered
      listeners.audioLevel?.({ level: 0.7 });
      expect(earlyLevels).toEqual([]);
      listeners.partialResults?.({ matches: ['你好'], isFinal: false });
      listeners.listeningState?.({ status: 'started' });

      // Hold threshold clears: startListening adopts without re-calling start/requestPermissions, pauses media, and replays buffered state
      const results: Array<[string, boolean]> = [];
      const listeningStates: boolean[] = [];
      const errors: string[] = [];
      await expect(VoiceInput.startListening(
        (txt, fin) => results.push([txt, fin]),
        (l) => listeningStates.push(l),
        (e) => errors.push(e),
      )).resolves.toBe(true);

      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();
      expect(audioPause).toHaveBeenCalledTimes(1);
      expect(listeningStates).toEqual([true]);
      expect(results).toEqual([['你好', false]]);
      expect(errors).toEqual([]);

      // Live audio levels and subsequent partials flow once adopted
      listeners.audioLevel?.({ level: 0.9 });
      expect(earlyLevels).toEqual([0.9]);
      listeners.partialResults?.({ matches: ['你好世界'], isFinal: true });
      expect(results).toEqual([['你好', false], ['你好世界', true]]);

      await VoiceInput.stopListening({ abort: true });
    } finally {
      VoiceInput.onAudioLevel(null);
      audio.remove();
    }
  });

  it('cancels primed native short taps cleanly without media pause or errors, skips stop before startInvoked, and serializes Tap1->Hold2', async () => {
    const audioPause = vi.fn();
    const audio = document.createElement('audio');
    Object.defineProperty(audio, 'paused', { value: false, configurable: true });
    audio.pause = audioPause;
    document.body.appendChild(audio);
    try {
      speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
      speechApi.available.mockResolvedValueOnce({ available: true });
      await VoiceInput.prewarm({ requestPermission: false });

      // 1. Tap cancelled BEFORE async addListener completes -> never invokes native start() or stop()
      const gateListener = deferred<{ remove: () => Promise<void> }>();
      speechApi.addListener.mockReturnValueOnce(gateListener.promise);
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
      VoiceInput.cancelVoiceGesturePrime();
      gateListener.resolve({ remove: async () => {} });
      await new Promise((r) => setTimeout(r, 0));
      expect(speechApi.start).not.toHaveBeenCalled();
      expect(speechApi.stop).not.toHaveBeenCalled();
      expect(audioPause).not.toHaveBeenCalled();

      // 2. Tap1 starts native capture then releases -> cancelVoiceGesturePrime stops & drains cleanly; immediate Hold2 serializes behind drain
      const stopDrain1 = deferred<void>();
      speechApi.stop.mockReturnValueOnce(stopDrain1.promise);
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
      await waitFor(() => expect(speechApi.start).toHaveBeenCalledTimes(1));
      VoiceInput.cancelVoiceGesturePrime();
      listeners.recognitionError?.({ message: 'dying primed tap error' });
      expect(speechApi.stop).toHaveBeenCalledTimes(1);
      expect(audioPause).not.toHaveBeenCalled();

      // Recognition error during dying primed tap must NEVER surface to hold error callback
      const onError = vi.fn();
      const hold2Results: Array<[string, boolean]> = [];
      const hold2Promise = VoiceInput.startListening(
        (t, f) => hold2Results.push([t, f]),
        undefined,
        onError,
      );
      // Hold2 waits for Tap1 stop drain before starting
      await Promise.resolve();
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      stopDrain1.resolve();
      await expect(hold2Promise).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(audioPause).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      listeners.partialResults?.({ matches: ['第二段'], isFinal: true });
      expect(hold2Results).toEqual([['第二段', true]]);

      await VoiceInput.stopListening({ abort: true });
    } finally {
      audio.remove();
    }
  });

  it('retains 120s authorized prime readiness past 15s prewarm TTL, invalidates on permission revocation, and routes triggerHapticFeedback cleanly', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-15T00:00:00Z'));
      speechApi.checkPermissions.mockResolvedValue({ speechRecognition: 'granted' });
      speechApi.available.mockResolvedValue({ available: true });
      await VoiceInput.prewarm({ requestPermission: false });

      // Past 15s prewarm TTL (30s < 120s), finger-down priming still works immediately
      await vi.advanceTimersByTimeAsync(30_000);
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
      VoiceInput.cancelVoiceGesturePrime();
      await vi.advanceTimersByTimeAsync(0);

      // Permission revoked in OS settings -> passive prewarm clears authorized prime readiness
      speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
      await VoiceInput.prewarm({ requestPermission: false });
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    // Haptics: both Android and iOS Capacitor shells invoke native performHaptic({ style }),
    // falling back cleanly to navigator.vibrate when missing or rejected (never throwing).
    const vibrateSpy = vi.fn(() => true);
    const origVibrate = navigator.vibrate;
    Object.defineProperty(navigator, 'vibrate', { value: vibrateSpy, configurable: true });
    const performHaptic = vi.fn().mockResolvedValue(undefined);
    (speechApi as any).performHaptic = performHaptic;
    const origCap = (globalThis as any).Capacitor;
    try {
      (globalThis as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
      await VoiceInput.triggerHapticFeedback(20, 'medium');
      expect(performHaptic).toHaveBeenCalledTimes(1);
      expect(performHaptic).toHaveBeenLastCalledWith({ style: 'medium' });
      expect(vibrateSpy).not.toHaveBeenCalled();

      performHaptic.mockRejectedValueOnce(new Error('haptic disabled'));
      await VoiceInput.triggerHapticFeedback(20, 'medium');
      expect(vibrateSpy).toHaveBeenCalledWith(20);

      vibrateSpy.mockClear();
      (globalThis as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
      await VoiceInput.triggerHapticFeedback(12, 'selection');
      await VoiceInput.triggerHapticFeedback(18, 'success');
      await VoiceInput.triggerHapticFeedback(15, 'warning');
      await VoiceInput.triggerHapticFeedback(12, 'light');
      expect(performHaptic).toHaveBeenCalledTimes(6);
      expect(performHaptic).toHaveBeenNthCalledWith(3, { style: 'selection' });
      expect(performHaptic).toHaveBeenNthCalledWith(4, { style: 'success' });
      expect(performHaptic).toHaveBeenNthCalledWith(5, { style: 'warning' });
      expect(performHaptic).toHaveBeenNthCalledWith(6, { style: 'light' });
      expect(vibrateSpy).not.toHaveBeenCalled();

      // Legacy native shell rejecting performHaptic degrades cleanly without throwing
      performHaptic.mockRejectedValueOnce(new Error('UNIMPLEMENTED'));
      await expect(VoiceInput.triggerHapticFeedback(15, 'warning')).resolves.toBeUndefined();
      expect(vibrateSpy).toHaveBeenCalledWith(15);

      vibrateSpy.mockClear();
      delete (speechApi as any).performHaptic;
      await expect(VoiceInput.triggerHapticFeedback(20)).resolves.toBeUndefined();
      expect(vibrateSpy).toHaveBeenCalledWith(20);
    } finally {
      delete (speechApi as any).performHaptic;
      (globalThis as any).Capacitor = origCap;
      Object.defineProperty(navigator, 'vibrate', { value: origVibrate, configurable: true });
    }
  });

  it.each(['ios', 'android'] as const)(
    'routes triggerHapticFeedback to StreamingSpeech even when imcodes_voice_engine=system uses platform SpeechRecognition on %s',
    async (platform) => {
      const vibrateSpy = vi.fn(() => true);
      const origVibrate = navigator.vibrate;
      Object.defineProperty(navigator, 'vibrate', { value: vibrateSpy, configurable: true });
      const origCap = (globalThis as any).Capacitor;
      try {
        (globalThis as any).Capacitor = {
          isNativePlatform: () => true,
          getPlatform: () => platform,
          isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        };
        VoiceInput.setVoiceRecognitionEngine('system');

        // Speech recognition still uses @capgo/capacitor-speech-recognition (speechApi), NOT streamingApi.
        const started = await VoiceInput.startListening(() => {}, () => {});
        expect(started).toBe(true);
        expect(speechApi.start).toHaveBeenCalledTimes(1);
        expect(streamingApi.start).not.toHaveBeenCalled();

        // Native haptics still route to StreamingSpeech.performHaptic without falling back to navigator.vibrate.
        await VoiceInput.triggerHapticFeedback(20, 'medium');
        await VoiceInput.triggerHapticFeedback(12, 'selection');
        await VoiceInput.triggerHapticFeedback(12, 'light');
        await VoiceInput.triggerHapticFeedback(18, 'success');
        await VoiceInput.triggerHapticFeedback(15, 'warning');

        expect(streamingApi.performHaptic.mock.calls).toEqual([
          [{ style: 'medium' }],
          [{ style: 'selection' }],
          [{ style: 'light' }],
          [{ style: 'success' }],
          [{ style: 'warning' }],
        ]);
        expect(vibrateSpy).not.toHaveBeenCalled();

        // Rejection on StreamingSpeech still degrades cleanly without throwing.
        streamingApi.performHaptic.mockRejectedValueOnce(new Error('UNIMPLEMENTED'));
        await expect(VoiceInput.triggerHapticFeedback(15, 'warning')).resolves.toBeUndefined();
        expect(vibrateSpy).toHaveBeenCalledWith(15);

        await VoiceInput.stopListening({ abort: true });
      } finally {
        localStorage.clear();
        (globalThis as any).Capacitor = origCap;
        Object.defineProperty(navigator, 'vibrate', { value: origVibrate, configurable: true });
      }
    },
  );

  it('skips local primeVoiceGesture when an online primary remote voice provider is configured', async () => {
    speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
    speechApi.available.mockResolvedValueOnce({ available: true });
    await VoiceInput.prewarm({ requestPermission: false });

    const remoteClient = await import('../../src/remote-voice-client.js');
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
      permissions: { query: vi.fn(async () => ({ state: 'prompt' })) },
      language: 'en-US',
      languages: ['en-US'],
    });
    try {
      remoteClient.resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: Date.now(),
        providers: [
          {
            deviceId: 'dev-mac-1',
            displayName: 'Mac Studio',
            model: 'qwen3-1.7b',
            modelLabel: 'Qwen3-ASR 1.7B',
            ready: true,
            busy: false,
            shareScope: 'account',
            isOwnDevice: true,
          },
        ],
      });
      await VoiceInput.prewarm({ requestPermission: false });
      await new Promise((r) => setTimeout(r, 0));
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(false);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(speechApi.start).not.toHaveBeenCalled();
    } finally {
      remoteClient.resetRemoteVoiceClientForTesting();
      vi.unstubAllGlobals();
    }
  });

  it('primes remote PCM capture without touching local SpeechRecognition when mic permission is known granted', async () => {
    const remoteClient = await import('../../src/remote-voice-client.js');
    const stopTrack = vi.fn();
    const closeCtx = vi.fn(async () => {});
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
      permissions: { query: vi.fn(async () => ({ state: 'granted' })) },
      language: 'en-US',
      languages: ['en-US'],
    });
    vi.stubGlobal('AudioContext', class {
      sampleRate = 16_000;
      state = 'running';
      destination = {};
      close = closeCtx;
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null });
      createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
    });

    try {
      remoteClient.resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: Date.now(),
        providers: [
          {
            deviceId: 'dev-mac-1',
            displayName: 'Mac Studio',
            model: 'qwen3-1.7b',
            modelLabel: 'Qwen3-ASR 1.7B',
            ready: true,
            busy: false,
            shareScope: 'account',
            isOwnDevice: true,
          },
        ],
      });
      await VoiceInput.prewarm({ requestPermission: false });
      await new Promise((r) => setTimeout(r, 0));

      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      expect(speechApi.start).not.toHaveBeenCalled();

      VoiceInput.cancelVoiceGesturePrime();
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(closeCtx).toHaveBeenCalledTimes(1);
      // Remote voice provider must NOT require t=0 pointerdown gesture prime on single taps
      expect(VoiceInput.needsPointerDownGesturePrime()).toBe(false);
    } finally {
      remoteClient.resetRemoteVoiceClientForTesting();
      vi.unstubAllGlobals();
    }
  });

  it('needsPointerDownGesturePrime returns true only for browser Web Speech API and false for native Capacitor or remote voice', async () => {
    const remoteClient = await import('../../src/remote-voice-client.js');
    const origCap = (globalThis as any).Capacitor;
    class StubSpeechRecognition {
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    }
    try {
      // 1. Browser Web Speech without remote provider -> true
      (globalThis as any).Capacitor = { isNativePlatform: () => false };
      vi.stubGlobal('SpeechRecognition', StubSpeechRecognition);
      remoteClient.resetRemoteVoiceClientForTesting({ primaryDeviceId: null, providers: [] });
      expect(VoiceInput.needsPointerDownGesturePrime()).toBe(true);

      // 2. Capacitor native -> false
      (globalThis as any).Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true };
      expect(VoiceInput.needsPointerDownGesturePrime()).toBe(false);
    } finally {
      (globalThis as any).Capacitor = origCap;
      remoteClient.resetRemoteVoiceClientForTesting();
      vi.unstubAllGlobals();
    }
  });

  it('activates TTS suppression across active capture lifecycles without interrupting un-adopted deferAudioPause taps, and never leaks suppression on failure or abort', async () => {
    const tts = await import('../../src/tts.js');
    await tts.__resetTtsForTests();
    const synth = { speak: vi.fn(), cancel: vi.fn() };
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      text: string;
      lang = '';
      rate = 1;
      onend: (() => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      constructor(text: string) { this.text = text; }
    });

    try {
      // 1. Un-adopted deferAudioPause tap must NOT interrupt or suppress active TTS.
      speechApi.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
      speechApi.available.mockResolvedValueOnce({ available: true });
      await VoiceInput.prewarm({ requestPermission: false });
      await expect(tts.speakText('Background reply playing', { messageId: 'bg-1', lang: 'en-US' })).resolves.toEqual({ started: true });
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true })).toBe(true);
      await waitFor(() => expect(speechApi.start).toHaveBeenCalledTimes(1));
      listeners.listeningState?.({ status: 'started' });
      expect(tts.isTtsVoiceCaptureActive()).toBe(false);
      expect(tts.getTtsState().status).toBe('speaking');
      VoiceInput.cancelVoiceGesturePrime();
      await new Promise((r) => setTimeout(r, 0));
      expect(tts.isTtsVoiceCaptureActive()).toBe(false);
      expect(tts.getTtsState().status).toBe('speaking');

      // 2. Active native capture immediately stops TTS, suppresses new speakText calls, and releases on stop/error.
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(tts.isTtsVoiceCaptureActive()).toBe(true);
      await waitFor(() => expect(tts.getTtsState().status).toBe('idle'));
      await expect(tts.speakText('Suppressed mid-dictation', { messageId: 'bg-2', lang: 'en-US' })).resolves.toEqual({
        started: false,
        reason: 'suppressed',
      });

      await VoiceInput.stopListening();
      expect(tts.isTtsVoiceCaptureActive()).toBe(false);

      // 3. Error / abort cleanly releases suppression.
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(tts.isTtsVoiceCaptureActive()).toBe(true);
      listeners.recognitionError?.({ message: 'audio_error' });
      await waitFor(() => expect(tts.isTtsVoiceCaptureActive()).toBe(false));

      // 4. Web Speech capture + onend releases suppression cleanly.
      (globalThis as any).Capacitor = { isNativePlatform: () => false };
      let webRec: any = null;
      vi.stubGlobal('SpeechRecognition', class {
        lang = '';
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onstart: (() => void) | null = null;
        onaudiostart: (() => void) | null = null;
        onresult: ((ev: any) => void) | null = null;
        onerror: ((ev: any) => void) | null = null;
        onend: (() => void) | null = null;
        start = vi.fn(() => { webRec = this; });
        stop = vi.fn();
        abort = vi.fn();
      });
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(tts.isTtsVoiceCaptureActive()).toBe(true);
      webRec.onstart?.();
      webRec.onend?.();
      expect(tts.isTtsVoiceCaptureActive()).toBe(false);
    } finally {
      await VoiceInput.stopListening({ abort: true });
      await tts.__resetTtsForTests();
      vi.unstubAllGlobals();
    }
  });

  it('normalizes raw voice waveform levels with noise-floor cutoff and perceptual boost for mobile RMS', () => {
    expect(VoiceInput.normalizeVoiceWaveformLevel(Number.NaN)).toBe(0);
    expect(VoiceInput.normalizeVoiceWaveformLevel(-0.5)).toBe(0);
    expect(VoiceInput.normalizeVoiceWaveformLevel(0)).toBe(0);
    expect(VoiceInput.normalizeVoiceWaveformLevel(0.004)).toBe(0);
    const low = VoiceInput.normalizeVoiceWaveformLevel(0.02);
    const mid = VoiceInput.normalizeVoiceWaveformLevel(0.08);
    const high = VoiceInput.normalizeVoiceWaveformLevel(0.8);
    expect(low).toBeGreaterThan(0.18);
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeLessThan(0.95);
    expect(VoiceInput.normalizeVoiceWaveformLevel(1.5)).toBe(1);
  });

  it('reuses 5-minute _lastAuthorizedPrewarm cache past 15s PREWARM_CACHE_TTL_MS without repeating requestPermissions/available IPC', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-25T06:00:00Z'));
      speechApi.checkPermissions.mockResolvedValue({ speechRecognition: 'granted' });
      speechApi.available.mockResolvedValue({ available: true });
      await VoiceInput.prewarm({ requestPermission: false });
      expect(speechApi.checkPermissions).toHaveBeenCalledTimes(1);
      expect(speechApi.available).toHaveBeenCalledTimes(1);

      speechApi.checkPermissions.mockClear();
      speechApi.requestPermissions.mockClear();
      speechApi.available.mockClear();

      // Advance 60s: past 15s PREWARM_CACHE_TTL_MS, within 300s NATIVE_PRIME_CACHE_TTL_MS
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(speechApi.requestPermissions).not.toHaveBeenCalled();
      expect(speechApi.available).not.toHaveBeenCalled();
      await VoiceInput.stopListening({ abort: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes project hotwords during warm-cache prime and restarts mismatched native capture cleanly without clearing prewarm', async () => {
    const origCap = (globalThis as any).Capacitor;
    (globalThis as any).Capacitor = {
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
      getPlatform: () => 'ios',
    };
    const hotwordsMod = await import('../../src/voice-hotwords.js');
    hotwordsMod.resetVoiceHotwordsScopeForTesting();
    hotwordsMod.setProjectVoiceHotwordsRaw('proj-a', 'AlphaTerm\nalpha term => AlphaTerm');
    hotwordsMod.setProjectVoiceHotwordsRaw('proj-b', 'BetaTerm\nbeta term => BetaTerm');

    try {
      await VoiceInput.prewarm({ requestPermission: false });
      streamingApi.checkPermissions.mockClear();
      streamingApi.requestPermissions.mockClear();
      streamingApi.available.mockClear();

      // 1. Prime with proj-a: StreamingSpeech.start receives proj-a hotwords immediately.
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true, projectKey: 'proj-a' })).toBe(true);
      await waitFor(() => expect(streamingApi.start).toHaveBeenCalledTimes(1));
      expect(streamingApi.start.mock.calls[0]?.[0]).toMatchObject({ hotwords: ['AlphaTerm'] });

      // Adopt with matching proj-a: reuses primed session with zero restart, and applies proj-a post-processing.
      const resA = vi.fn();
      await expect(VoiceInput.startListening(resA, undefined, undefined, { projectKey: 'proj-a' })).resolves.toBe(true);
      expect(streamingApi.start).toHaveBeenCalledTimes(1);
      listeners.partialResults?.({ matches: ['check alpha term now'], isFinal: true });
      expect(resA).toHaveBeenLastCalledWith('check AlphaTerm now', true);
      await VoiceInput.stopListening({ abort: true });

      // 2. Prime without project (empty/global) while native start fires, then adopt with proj-b:
      //    must stop the mismatched primed capture and restart native start with proj-b hotwords
      //    without clearing prewarm / re-calling requestPermissions or available.
      streamingApi.start.mockClear();
      streamingApi.stop.mockClear();
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true, projectKey: null })).toBe(true);
      await waitFor(() => expect(streamingApi.start).toHaveBeenCalledTimes(1));
      expect(streamingApi.start.mock.calls[0]?.[0]?.hotwords).toBeUndefined();

      const resB = vi.fn();
      await expect(VoiceInput.startListening(resB, undefined, undefined, { projectKey: 'proj-b' })).resolves.toBe(true);
      expect(streamingApi.stop).toHaveBeenCalledTimes(1);
      expect(streamingApi.start).toHaveBeenCalledTimes(2);
      expect(streamingApi.start.mock.calls[1]?.[0]).toMatchObject({ hotwords: ['BetaTerm'] });
      expect(streamingApi.requestPermissions).not.toHaveBeenCalled();
      expect(streamingApi.available).not.toHaveBeenCalled();
      listeners.partialResults?.({ matches: ['using beta term here'], isFinal: true });
      expect(resB).toHaveBeenLastCalledWith('using BetaTerm here', true);

      await VoiceInput.stopListening({ abort: true });

      // 3. Ended native prime with proj-a must be discarded when startListening adopts for proj-b.
      streamingApi.start.mockClear();
      streamingApi.stop.mockClear();
      expect(VoiceInput.primeVoiceGesture({ deferAudioPause: true, projectKey: 'proj-a' })).toBe(true);
      await waitFor(() => expect(streamingApi.start).toHaveBeenCalledTimes(1));
      listeners.listeningState?.({ status: 'started' });
      listeners.partialResults?.({ matches: ['stale alpha term'], isFinal: true });
      listeners.listeningState?.({ status: 'stopped' });

      const resAfterEnd = vi.fn();
      await expect(VoiceInput.startListening(resAfterEnd, undefined, undefined, { projectKey: 'proj-b' })).resolves.toBe(true);
      expect(resAfterEnd).not.toHaveBeenCalled();
      expect(streamingApi.start).toHaveBeenCalledTimes(2);
      expect(streamingApi.start.mock.calls[1]?.[0]).toMatchObject({ hotwords: ['BetaTerm'] });
      listeners.partialResults?.({ matches: ['fresh beta term'], isFinal: true });
      expect(resAfterEnd).toHaveBeenLastCalledWith('fresh BetaTerm', true);
      await VoiceInput.stopListening({ abort: true });

      // 4. Native primary fails and falls back to platform speechApi (no hotwords): same-project adoption
      //    reuses the working fallback session cleanly without spurious mismatch restart.
      streamingApi.start.mockReset().mockRejectedValueOnce(new Error('offline engine unavailable'));
      speechApi.start.mockClear().mockResolvedValue({});
      speechApi.stop.mockClear();

      const resFallback1 = vi.fn();
      await expect(VoiceInput.startListening(resFallback1, undefined, undefined, { projectKey: 'proj-a' })).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect((speechApi.start.mock.calls[0]?.[0] as Record<string, unknown> | undefined)?.hotwords).toBeUndefined();

      const resFallback2 = vi.fn();
      await expect(VoiceInput.startListening(resFallback2, undefined, undefined, { projectKey: 'proj-a' })).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(speechApi.stop).not.toHaveBeenCalled();
      listeners.partialResults?.({ matches: ['using alpha term fallback'], isFinal: true });
      expect(resFallback2).toHaveBeenLastCalledWith('using AlphaTerm fallback', true);
      await VoiceInput.stopListening({ abort: true });
    } finally {
      hotwordsMod.resetVoiceHotwordsScopeForTesting();
      (globalThis as any).Capacitor = origCap;
    }
  });

});
