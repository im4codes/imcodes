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
