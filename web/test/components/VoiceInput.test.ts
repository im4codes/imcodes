/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

const speechApi = vi.hoisted(() => ({
  available: vi.fn(),
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

  it('bounds a hung native stop() at NATIVE_FINAL_DRAIN_MS, reports error before resolving, and lets next start recover', async () => {
    vi.useFakeTimers();
    try {
      const hungStop = deferred<void>();
      let recordedLastErrorAtCallback: string | null = null;
      const onErr = vi.fn(() => {
        recordedLastErrorAtCallback = VoiceInput.getLastError();
      });
      speechApi.stop.mockReturnValueOnce(hungStop.promise).mockResolvedValue(undefined);

      await expect(VoiceInput.startListening(vi.fn(), undefined, onErr)).resolves.toBe(true);
      expect(VoiceInput.isListening()).toBe(true);

      const stopping = VoiceInput.stopListening();
      expect(VoiceInput.isListening()).toBe(false);

      // Next start queues behind _pendingStop, unblocking at NATIVE_FINAL_DRAIN_MS
      const resumed = VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS - 1);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(onErr).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(onErr).toHaveBeenCalledWith('Speech final drain timed out');
      expect(recordedLastErrorAtCallback).toBe('Speech final drain timed out');
      await expect(resumed).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(VoiceInput.isListening()).toBe(true);
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

  it('VoiceOverlay + VoiceInput: slow native final past NATIVE_FINAL_DRAIN_MS fails explicitly, keeps draft, never sends partial prefix, and recovers cleanly', async () => {
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
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS + 500);

      expect(onSend).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Speech final drain timed out');
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('recognized prefix');
      expect(VoiceInput.isListening()).toBe(false);

      // Late native final / ACK after timeout does not auto-send or wipe the preserved draft
      listeners.partialResults?.({ matches: ['recognized prefix with final tail'], isFinal: true });
      drain.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(onSend).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('recognized prefix');

      // Explicit Retry after timeout clears alert and captures remaining speech cleanly
      fireEvent.click(document.querySelector('.voice-overlay-retry') as HTMLElement);
      await vi.advanceTimersByTimeAsync(0);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      listeners.partialResults?.({ matches: ['with final tail'], isFinal: true });
      fireEvent.click(document.querySelector('.voice-overlay-send') as HTMLElement);
      await vi.advanceTimersByTimeAsync(0);
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

  it('VoiceOverlay + VoiceInput: slow final within NATIVE_FINAL_DRAIN_MS sends merged final tail exactly once without alert', async () => {
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

      // Pause -> Mic while drain is pending; drain times out -> queued resume aborts cleanly without hiding alert
      const micBtn = document.querySelector('.voice-overlay-mic') as HTMLElement;
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(200);
      fireEvent.click(micBtn);
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS);

      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('Speech final drain timed out');
      expect((document.querySelector('.voice-overlay-text') as HTMLTextAreaElement).value).toBe('draft text');

      // Recover via notepad toggle -> starts session cleanly, then Send/openReview hits stop rejection
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
    it(`retires a cancelled pending native start on stop deadline (${outcome}) without wedging fresh start or clobbering the new owner`, async () => {
      vi.useFakeTimers();
      const startGate = deferred<Record<string, never>>();
      speechApi.start.mockReturnValueOnce(startGate.promise).mockResolvedValue({});
      try {
        const oldErr = vi.fn();
        const oldStart = VoiceInput.startListening(vi.fn(), undefined, oldErr);
        await vi.advanceTimersByTimeAsync(0);
        expect(speechApi.start).toHaveBeenCalledTimes(1);

        const stopped = VoiceInput.stopListening();
        await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS + 100);
        await stopped;

        const newResult = vi.fn();
        const newErr = vi.fn();
        const resumed = VoiceInput.startListening(newResult, undefined, newErr);
        await expect(resumed).resolves.toBe(true);
        expect(speechApi.start).toHaveBeenCalledTimes(2);
        expect(VoiceInput.isListening()).toBe(true);
        const stopCountBeforeLateSettle = speechApi.stop.mock.calls.length;

        // Late settle of cancelled startGate must NOT stop, silence, remove listeners, or report error on new owner
        if (outcome === 'resolve') startGate.resolve({});
        else startGate.reject(new Error('late stale start failure'));
        await expect(oldStart).resolves.toBe(false);

        expect(speechApi.stop).toHaveBeenCalledTimes(stopCountBeforeLateSettle);
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

  it('retires pending permission/available checks on stop deadline and lets Stop->Mic->Stop cancel a queued resume', async () => {
    vi.useFakeTimers();
    const permGate = deferred<{ speechRecognition: string }>();
    const availGate = deferred<{ available: boolean }>();
    speechApi.requestPermissions
      .mockReturnValueOnce(permGate.promise)
      .mockResolvedValue({ speechRecognition: 'granted' });
    try {
      // Hung requestPermissions retired on stop timeout -> next start succeeds, late perm grant cannot spawn session 1
      const pStart = VoiceInput.startListening(vi.fn());
      const pStop = VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS + 50);
      await pStop;

      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      permGate.resolve({ speechRecognition: 'granted' });
      await expect(pStart).resolves.toBe(false);
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(true);

      // Stop -> Mic (queued during hung stop) -> Stop (before timeout) cancels queued Mic cleanly
      const hungStop = deferred<void>();
      speechApi.stop.mockReturnValueOnce(hungStop.promise).mockResolvedValue(undefined);
      const stop1 = VoiceInput.stopListening();
      const queuedMic = VoiceInput.startListening(vi.fn());
      const stop2 = VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS + 50);

      await expect(queuedMic).resolves.toBe(false);
      await stop1;
      await stop2;
      expect(speechApi.start).toHaveBeenCalledTimes(1);
      expect(VoiceInput.isListening()).toBe(false);

      // Hung available() check retired on stop timeout -> fresh start succeeds, late available cannot spawn stale session
      speechApi.available
        .mockReturnValueOnce(availGate.promise)
        .mockResolvedValue({ available: true });
      const availStart = VoiceInput.startListening(vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      const availStop = VoiceInput.stopListening();
      await vi.advanceTimersByTimeAsync(VoiceInput.NATIVE_FINAL_DRAIN_MS + 50);
      await availStop;

      await expect(VoiceInput.startListening(vi.fn())).resolves.toBe(true);
      expect(speechApi.start).toHaveBeenCalledTimes(2);
      availGate.resolve({ available: true });
      await expect(availStart).resolves.toBe(false);
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
});


describe('Web Mobile final drain', () => {
  function browser() {
    const instances: any[] = [];
    class Recognizer {
      onresult: any; onend: any; onerror: any;
      start = vi.fn(); stop = vi.fn(); abort = vi.fn();
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
      await vi.advanceTimersByTimeAsync(2000); await stopped;
      expect(instances[0].abort).toHaveBeenCalledOnce();
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

  for (const terminal of ['onend', 'timeout']) {
    it.each(['before', 'during', 'after'])('releases meter grant %s Stop with ' + terminal + ' while retaining final text', async (timing) => {
      vi.useFakeTimers();
      const instances = browser(), meter = meterHarness(), media = meter.stream(), result = vi.fn(), levels = vi.fn();
      try {
        VoiceInput.onAudioLevel(levels);
        await VoiceInput.startListening(result);
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
        else await vi.advanceTimersByTimeAsync(2000);
        await stopped;
        if (timing === 'after') {
          meter.grants[0].resolve(media.value); await Promise.resolve(); await Promise.resolve();
        }
        expect(VoiceInput.isListening()).toBe(false);
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
        else await vi.advanceTimersByTimeAsync(2000);
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

});
