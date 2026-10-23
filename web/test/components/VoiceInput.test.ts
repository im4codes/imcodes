/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';

const speechApi = vi.hoisted(() => ({
  available: vi.fn(),
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@capgo/capacitor-speech-recognition', () => ({
  SpeechRecognition: speechApi,
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

  it('syncs native stopped events back to the listening state callback', async () => {
    const onListeningChange = vi.fn();

    await expect(VoiceInput.startListening(vi.fn(), onListeningChange)).resolves.toBe(true);
    expect(VoiceInput.isListening()).toBe(true);

    listeners.listeningState({ status: 'stopped' });

    await waitFor(() => expect(onListeningChange).toHaveBeenLastCalledWith(false));
    expect(VoiceInput.isListening()).toBe(false);
  });

  it('restarts browser recognition after auto-end and stops after explicit stop', async () => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    const instances: any[] = [];
    class BrowserRecognitionMock {
      static starts = 0;
      onresult: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      start(): void { BrowserRecognitionMock.starts++; }
      stop(): void {}
      abort(): void {}
      constructor() { instances.push(this); }
    }
    vi.stubGlobal('SpeechRecognition', BrowserRecognitionMock);
    vi.useFakeTimers();
    const browserVoice = await import('../../src/components/VoiceInput.js');
    const onResult = vi.fn();
    await expect(browserVoice.startListening(onResult)).resolves.toBe(true);
    instances[0].onresult?.({ results: [{ 0: { transcript: 'hello' }, isFinal: false }] });
    expect(onResult).toHaveBeenCalledWith('hello', false);
    instances[0].onend?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(BrowserRecognitionMock.starts).toBe(2);
    await browserVoice.stopListening();
    instances[1].onend?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(BrowserRecognitionMock.starts).toBe(2);
    vi.useRealTimers();
  });

  it.each(['not-allowed', 'service-not-allowed', 'audio-capture'])('does not restart browser recognition after %s', async (error) => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    const instances: any[] = [];
    class BrowserRecognitionMock {
      static starts = 0;
      onresult: ((event: any) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      start(): void { BrowserRecognitionMock.starts++; }
      stop(): void {}
      abort(): void {}
      constructor() { instances.push(this); }
    }
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', BrowserRecognitionMock);
    vi.useFakeTimers();
    const browserVoice = await import('../../src/components/VoiceInput.js');
    await expect(browserVoice.startListening(vi.fn())).resolves.toBe(true);
    instances[0].onerror?.({ error });
    instances[0].onend?.();
    await vi.advanceTimersByTimeAsync(150);
    expect(BrowserRecognitionMock.starts).toBe(1);
    await browserVoice.stopListening();
    vi.useRealTimers();
  });
});
