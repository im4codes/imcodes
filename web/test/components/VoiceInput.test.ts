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

vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn() }));

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

      // 1. Initial idle bars are fill(0) -> height 2px (2 + 0 * 44), opacity 0.15 (never 90px overflow from fill(2))
      const getBarHeights = () =>
        Array.from(document.querySelectorAll('.voice-waveform-bar')).map(
          (el) => parseFloat((el as HTMLElement).style.height),
        );
      expect(getBarHeights()).toHaveLength(48);
      expect(getBarHeights().every((h) => h === 2)).toBe(true);

      await vi.advanceTimersByTimeAsync(150);
      expect(speechApi.start).toHaveBeenCalledTimes(1);

      // 2. First active audioLevel > 0.01 triggers isEmpty initial burst across all 24 bars (within 2px..46px)
      listeners.audioLevel?.({ level: 0.5 });
      await vi.advanceTimersByTimeAsync(0);
      const burstHeights = getBarHeights();
      expect(burstHeights.every((h) => h > 2 && h <= 46)).toBe(true);

      // 3. Subsequent audioLevel events shift the waveform smoothly and clamp out-of-range values to <= 46px
      listeners.audioLevel?.({ level: 0.25 });
      await vi.advanceTimersByTimeAsync(0);
      expect(getBarHeights().at(-1)).toBeCloseTo(2 + 0.25 * 44, 2);

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
      expect(getBarHeights().every((h) => h === 2)).toBe(true);
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

});
