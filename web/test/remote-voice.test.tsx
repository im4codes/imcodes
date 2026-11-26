/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import type { RemoteVoiceProvidersSnapshot } from '@shared/remote-voice.js';

const { streamingBridge, platformBridge, apiMocks } = vi.hoisted(() => {
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
  return {
    streamingBridge: make(),
    platformBridge: make(),
    apiMocks: {
      fetchRemoteVoiceWsTicket: vi.fn<() => Promise<{ ticket: string }>>(),
      fetchRemoteVoiceProviders: vi.fn<(opts?: { signal?: AbortSignal }) => Promise<RemoteVoiceProvidersSnapshot>>(),
      savePrimaryRemoteVoiceProvider: vi.fn<(id: string | null) => Promise<{ ok: boolean; primaryDeviceId: string | null }>>(),
      saveRemoteVoiceProviderNickname: vi.fn<(id: string, nick: string | null) => Promise<{ ok: boolean; deviceId: string; nickname: string | null }>>(),
      setServerSharedRemoteVoiceProvider: vi.fn<(id: string, shared: boolean) => Promise<{ ok: boolean; deviceId: string; shared: boolean; nickname: string | null }>>(),
      fetchServerAsrServices: vi.fn<() => Promise<{ services: any[]; envDefault: any; encryptionAvailable: boolean }>>(),
      createServerAsrService: vi.fn<(input: any) => Promise<any>>(),
      updateServerAsrService: vi.fn<(id: string, input: any) => Promise<any>>(),
      deleteServerAsrService: vi.fn<(id: string) => Promise<any>>(),
      getApiBaseUrl: vi.fn(() => 'https://relay.example'),
    },
  };
});

vi.mock('@capacitor/core', () => ({ registerPlugin: () => streamingBridge }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: platformBridge }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../src/screen-awake.js', () => ({
  holdScreenAwake: () => () => {},
}));
vi.mock('../src/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    ...apiMocks,
  };
});

import * as VoiceInput from '../src/components/VoiceInput.js';
import { VoiceOverlay } from '../src/components/VoiceOverlay.js';
import { SharedVoiceSection } from '../src/components/SharedVoiceSection.js';
import {
  RemoteVoiceProviderController,
  setLocalPcAppRemoteDeviceIdForTesting,
} from '../src/remote-voice-provider.js';
import {
  StreamingPcmResampler,
  cancelRemoteVoiceCapturePrime,
  decodeBase64ToInt16Pcm,
  drainRemoteVoiceCapturePrimePcm,
  downsampleFloat32ToInt16Le,
  encodeInt16PcmToBase64,
  finishRemoteVoiceCapturePrime,
  getRemoteVoiceState,
  REMOTE_VOICE_CLIENT_READY_TIMEOUT_MS,
  acquireRemoteMicStream,
  formatMicCaptureErrorReason,
  isRemoteMicPermissionKnownGranted,
  primeRemoteVoiceCapture,
  probeRemoteMicPermission,
  refreshRemoteVoiceProviders,
  resetRemoteVoiceClientForTesting,
  resolveRemoteVoiceRoute,
  selectPreferredBuiltInMicDeviceId,
  startRemoteVoiceSession,
} from '../src/remote-voice-client.js';
import { getNativeRawPcmCapture } from '../src/voice-recognition-backend.js';
import type { PcAppRemoteVoiceEvent, PcAppRemoteVoiceProviderInfo } from '../src/native-platform.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  emitMessage(obj: unknown): void {
    this.emit('message', { data: JSON.stringify(obj) });
  }

  emit(type: string, ev: unknown): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) {
      cb(ev);
    }
  }
}

function resetBridge(b: typeof streamingBridge) {
  b.listeners = {};
  b.available.mockReset().mockResolvedValue({ available: true });
  b.checkPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  b.requestPermissions.mockReset().mockResolvedValue({ speechRecognition: 'granted' });
  b.prewarm.mockReset().mockResolvedValue(undefined);
  b.start.mockReset().mockImplementation(async () => {
    b.listeners.listeningState?.({ status: 'started' });
  });
  b.stop.mockReset().mockImplementation(async () => {
    b.listeners.listeningState?.({ status: 'stopped' });
  });
  b.addListener.mockReset().mockImplementation(async (name: string, fn: (data: unknown) => void) => {
    b.listeners[name] = fn;
    return { remove: vi.fn(async () => {}) };
  });
}

function setupFakeWebAudio(options: { sampleRate?: number; throwOnOptions?: boolean } = {}) {
  const stopTrack = vi.fn();
  const fakeStream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => fakeStream);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia },
    maxTouchPoints: 0,
    language: 'en-US',
    languages: ['en-US'],
  });

  const closeCtx = vi.fn(async () => {});
  const contextCtorArgs: unknown[] = [];
  const scriptProcessorBufferSizes: number[] = [];
  let processCb: ((ev: { inputBuffer: { getChannelData: (ch: number) => Float32Array } }) => void) | null = null;
  class FakeAudioContext {
    sampleRate = options.sampleRate ?? 48_000;
    state = 'running';
    destination = {};
    close = closeCtx;
    constructor(opts?: AudioContextOptions) {
      contextCtorArgs.push(opts);
      if (options.throwOnOptions && opts !== undefined) {
        throw new Error('sampleRate option unsupported');
      }
      if (opts?.sampleRate && options.sampleRate === undefined) {
        this.sampleRate = opts.sampleRate;
      }
    }
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
    createScriptProcessor = (bufferSize = 2048) => {
      scriptProcessorBufferSizes.push(bufferSize);
      const node = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        set onaudioprocess(fn: typeof processCb) { processCb = fn; },
        get onaudioprocess() { return processCb; },
      };
      return node;
    };
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return {
    getUserMedia,
    stopTrack,
    closeCtx,
    contextCtorArgs,
    scriptProcessorBufferSizes,
    emitSamples: (samples: Float32Array) => {
      processCb?.({ inputBuffer: { getChannelData: () => samples } });
    },
  };
}

describe('Phase 2 Shared Remote Voice Recognition', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (globalThis as Record<string, unknown>).__IMCODES_PC_APP__;
    FakeWebSocket.instances = [];
    setLocalPcAppRemoteDeviceIdForTesting(null);
    resetRemoteVoiceClientForTesting();
    resetBridge(streamingBridge);
    resetBridge(platformBridge);
    apiMocks.fetchRemoteVoiceWsTicket.mockReset().mockResolvedValue({ ticket: 'tkt-1' });
    apiMocks.fetchServerAsrServices.mockReset().mockResolvedValue({
      services: [],
      envDefault: null,
      encryptionAvailable: true,
    });
    apiMocks.createServerAsrService.mockReset();
    apiMocks.updateServerAsrService.mockReset();
    apiMocks.deleteServerAsrService.mockReset();
    apiMocks.fetchRemoteVoiceProviders.mockReset().mockResolvedValue({
      primaryDeviceId: null,
      canManageServerSharing: false,
      providers: [],
    });
    apiMocks.savePrimaryRemoteVoiceProvider.mockReset().mockImplementation(async (id) => ({
      ok: true,
      primaryDeviceId: id,
    }));
    apiMocks.saveRemoteVoiceProviderNickname.mockReset().mockImplementation(async (deviceId, nickname) => ({
      ok: true,
      deviceId,
      nickname,
    }));
    apiMocks.setServerSharedRemoteVoiceProvider.mockReset().mockImplementation(async (deviceId, shared) => ({
      ok: true,
      deviceId,
      shared,
      nickname: null,
    }));
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(async () => {
    cleanup();
    await VoiceInput.stopListening({ abort: true });
    setLocalPcAppRemoteDeviceIdForTesting(null);
    resetRemoteVoiceClientForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('PC App provider registers minimal metadata only when Qwen3 model is ready, unregisters on null, and relays PCM sessions', async () => {
    let ipcListener: ((ev: PcAppRemoteVoiceEvent) => void) | null = null;
    let currentInfo: PcAppRemoteVoiceProviderInfo | null = null;
    const startRemoteSessionMock = vi.fn(async () => ({ ok: true }));
    const pushRemotePcmMock = vi.fn(async () => ({ ok: true }));
    const stopRemoteSessionMock = vi.fn(async () => ({ ok: true }));

    const controller = new RemoteVoiceProviderController({
      isSupported: () => true,
      getWsBaseUrl: () => 'https://relay.example',
      fetchTicket: async () => ({ ticket: 'prov-tkt' }),
      getBridge: () => ({
        voice: {
          getRemoteProviderInfo: async () => currentInfo,
          startRemoteSession: startRemoteSessionMock,
          pushRemotePcm: pushRemotePcmMock,
          stopRemoteSession: stopRemoteSessionMock,
          subscribeRemoteEvents: (cb) => {
            ipcListener = cb;
            return () => { ipcListener = null; };
          },
        },
      }),
    });

    // Initially null (system speech / unready): must NOT open WS or register
    await controller.start();
    expect(FakeWebSocket.instances).toHaveLength(0);

    // Model becomes ready -> connects and sends ONLY opaque register fields
    currentInfo = {
      deviceId: 'dev-mac-1',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
      busy: false,
    };
    ipcListener?.({ type: 'provider.info', info: currentInfo });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('wss://relay.example/api/ws/voice-relay?ticket=prov-tkt');
    ws.emitOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'voice.provider.register',
      deviceId: 'dev-mac-1',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
      busy: false,
    });

    // Updating provider.info with resolved machine deviceName, hostname, and localServerId re-sends them in register frame
    ipcListener?.({
      type: 'provider.info',
      info: {
        deviceId: 'dev-mac-1',
        deviceName: 'KOCA’s MacBook Pro (1118)',
        hostname: 'm3-macbook',
        localServerId: 'srv-m3-host',
        model: 'qwen3-1.7b',
        modelLabel: 'Qwen3-ASR 1.7B',
        ready: true,
        busy: false,
      },
    });
    expect(JSON.parse(ws.sent[1]!)).toEqual({
      type: 'voice.provider.register',
      deviceId: 'dev-mac-1',
      deviceName: 'KOCA’s MacBook Pro (1118)',
      hostname: 'm3-macbook',
      localServerId: 'srv-m3-host',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
      busy: false,
    });

    // Handles remote start/audio/stop and forwards ready/result/end without logging transcript
    const logSpy = vi.spyOn(console, 'log');
    ws.emitMessage({ type: 'voice.session.start', sessionId: 's1', locale: 'zh-Hans', sampleRate: 16000 });
    await waitFor(() => expect(startRemoteSessionMock).toHaveBeenCalledWith({ sessionId: 's1', locale: 'zh-Hans' }));
    ipcListener?.({ type: 'voice.session.ready', sessionId: 's1' });
    ws.emitMessage({ type: 'voice.session.audio', sessionId: 's1', pcmBase64: 'AAAA' });
    await waitFor(() => expect(pushRemotePcmMock).toHaveBeenCalledWith({ sessionId: 's1', pcmBase64: 'AAAA' }));
    ipcListener?.({ type: 'voice.session.result', sessionId: 's1', text: '绝密语音文本', isFinal: true });
    ws.emitMessage({ type: 'voice.session.stop', sessionId: 's1' });
    await waitFor(() => expect(stopRemoteSessionMock).toHaveBeenCalledWith({ sessionId: 's1', abort: false }));
    ipcListener?.({ type: 'voice.session.end', sessionId: 's1' });

    const sentFrames = ws.sent.slice(2).map((s) => JSON.parse(s));
    expect(sentFrames).toEqual([
      { type: 'voice.session.ready', sessionId: 's1' },
      { type: 'voice.session.result', sessionId: 's1', text: '绝密语音文本', isFinal: true },
      { type: 'voice.session.end', sessionId: 's1' },
    ]);
    expect(logSpy).not.toHaveBeenCalled();

    // Switching back to system (provider.info: null) closes WS cleanly
    ipcListener?.({ type: 'provider.info', info: null });
    expect(ws.closedWith).not.toBeNull();
    controller.stop();
  });

  it('aborts orphaned main-process remote session on fresh start when provider reports busy with no active renderer session', async () => {
    let busyState = true;
    const stopRemoteSessionMock = vi.fn(async ({ sessionId, abort }: { sessionId: string; abort?: boolean }) => {
      if (sessionId === '*' && abort) {
        busyState = false;
      }
      return { ok: true };
    });

    const controller = new RemoteVoiceProviderController({
      isSupported: () => true,
      getWsBaseUrl: () => 'https://relay.example',
      fetchTicket: async () => ({ ticket: 'prov-tkt-recover' }),
      getBridge: () => ({
        voice: {
          getRemoteProviderInfo: async () => ({
            deviceId: 'dev-mac-orphan',
            model: 'qwen3-1.7b',
            modelLabel: 'Qwen3-ASR 1.7B',
            ready: true,
            busy: busyState,
          }),
          stopRemoteSession: stopRemoteSessionMock,
          subscribeRemoteEvents: () => () => {},
        },
      }),
    });

    await controller.start();
    expect(stopRemoteSessionMock).toHaveBeenCalledWith({ sessionId: '*', abort: true });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'voice.provider.register',
      deviceId: 'dev-mac-orphan',
      model: 'qwen3-1.7b',
      modelLabel: 'Qwen3-ASR 1.7B',
      ready: true,
      busy: false,
    });
    controller.stop();
  });

  it('downsamples 48kHz audio cleanly to 16kHz Int16LE and routes remote -> failback -> auto-switchback when primary returns online', async () => {
    const downsampled = downsampleFloat32ToInt16Le(new Float32Array(480).fill(0.5), 48_000, 16_000);
    expect(downsampled).toHaveLength(160);
    expect(downsampled[0]).toBeGreaterThan(16_000);

    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const audio = setupFakeWebAudio();

    // Step 1: Primary device is configured but currently OFFLINE -> fails back transparently to local 'builtin' WITHOUT clearing primaryDeviceId
    resetRemoteVoiceClientForTesting({ primaryDeviceId: 'dev-mac-1', providers: [], fetchedAt: 0 });
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'dev-mac-1',
      canManageServerSharing: false,
      providers: [],
    });

    const results: Array<{ text: string; isFinal: boolean }> = [];
    const okFallback = await VoiceInput.startListening((t, f) => results.push({ text: t, isFinal: f }));
    expect(okFallback).toBe(true);
    expect(streamingBridge.start).toHaveBeenCalledTimes(1);
    expect(getRemoteVoiceState().primaryDeviceId).toBe('dev-mac-1');
    expect(getRemoteVoiceState().fallbackNotice).toBe('provider_offline');
    await VoiceInput.stopListening();

    // Step 2: Primary device comes BACK ONLINE -> next startListening() automatically switches back to remote provider!
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'dev-mac-1',
      canManageServerSharing: false,
      providers: [
        {
          deviceId: 'dev-mac-1',
          displayName: 'K · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
        },
      ],
    });

    const levels: number[] = [];
    VoiceInput.onAudioLevel((l) => levels.push(l));

    const startPromise = VoiceInput.startListening((t, f) => results.push({ text: t, isFinal: f }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const clientWs = FakeWebSocket.instances[0]!;
    clientWs.emitOpen();
    const startFrame = JSON.parse(clientWs.sent[0]!) as Record<string, unknown>;
    expect(startFrame).toMatchObject({
      type: 'voice.session.start',
      targetDeviceId: 'dev-mac-1',
      sampleRate: 16_000,
    });
    expect(Object.keys(startFrame).sort()).toEqual(['locale', 'sampleRate', 'sessionId', 'targetDeviceId', 'type']);

    clientWs.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    expect(await startPromise).toBe(true);
    expect(streamingBridge.start).toHaveBeenCalledTimes(1); // local was NOT called!
    expect(getRemoteVoiceState().fallbackNotice).toBeNull();

    // Emit >= 3200 downsampled samples (~9600+ input @ 48kHz) -> sends PCM frame + drives level meter
    audio.emitSamples(new Float32Array(12_000).fill(0.25));
    expect(levels.length).toBeGreaterThan(0);
    expect(clientWs.sent.some((raw) => JSON.parse(raw).type === 'voice.session.audio')).toBe(true);

    clientWs.emitMessage({ type: 'voice.session.result', sessionId: startFrame.sessionId, text: '远程识别成功', isFinal: false });
    expect(results).toContainEqual({ text: '远程识别成功', isFinal: false });

    const stopP = VoiceInput.stopListening();
    await waitFor(() => expect(clientWs.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true));
    clientWs.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await stopP;
    expect(audio.stopTrack).toHaveBeenCalled();
    expect(audio.closeCtx).toHaveBeenCalled();
  });

  it('skips remote self-loop on host PC and cancels cleanly without fallback when aborted mid-connect', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });

    // Self-loop guard: local PC device matches primaryDeviceId -> uses local directly, zero WS opened
    setLocalPcAppRemoteDeviceIdForTesting('dev-self');
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-self',
      fetchedAt: Date.now(),
      providers: [
        {
          deviceId: 'dev-self',
          displayName: 'K · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
        },
      ],
    });
    expect(await VoiceInput.startListening(vi.fn())).toBe(true);
    expect(streamingBridge.start).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await VoiceInput.stopListening();

    // Clean cancellation during 1.5s connect/ready window: NO local fallback!
    setLocalPcAppRemoteDeviceIdForTesting(null);
    const audio = setupFakeWebAudio();
    const abortCtrl = new AbortController();
    const sessionPromise = startRemoteVoiceSession({
      targetDeviceId: 'dev-remote',
      onResult: vi.fn(),
      signal: abortCtrl.signal,
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    abortCtrl.abort();
    const outcome = await sessionPromise;
    expect(outcome).toEqual({ ok: false, cancelled: true, reason: 'cancelled' });
    expect(audio.stopTrack).toHaveBeenCalled();
    expect(audio.closeCtx).toHaveBeenCalled();

    // Audio track cleanup causal test 1: getUserMedia succeeds, ws-ticket fails -> track MUST stop
    const stopTrackTicketFail = vi.fn();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrackTicketFail }] }) as unknown as MediaStream),
      },
      maxTouchPoints: 0,
      language: 'en-US',
      languages: ['en-US'],
    });
    const ticketFailRes = await startRemoteVoiceSession({
      targetDeviceId: 'dev-remote',
      onResult: vi.fn(),
      fetchTicket: async () => { throw new Error('ticket_network_error'); },
    });
    expect(ticketFailRes).toEqual({ ok: false, cancelled: false, reason: 'ticket_network_error' });
    expect(stopTrackTicketFail).toHaveBeenCalledTimes(1);

    // Audio track cleanup causal test 2: ws-ticket rejects BEFORE slow getUserMedia resolves -> track STILL stops
    const stopTrackDelayedMic = vi.fn();
    let resolveDelayedMic!: (stream: MediaStream) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(() => new Promise<MediaStream>((res) => { resolveDelayedMic = res; })),
      },
      maxTouchPoints: 0,
      language: 'en-US',
      languages: ['en-US'],
    });
    const delayedResPromise = startRemoteVoiceSession({
      targetDeviceId: 'dev-remote',
      onResult: vi.fn(),
      fetchTicket: async () => { throw new Error('ticket_fast_fail'); },
    });
    const delayedRes = await delayedResPromise;
    expect(delayedRes).toEqual({ ok: false, cancelled: false, reason: 'ticket_fast_fail' });
    resolveDelayedMic({ getTracks: () => [{ stop: stopTrackDelayedMic }] } as unknown as MediaStream);
    await waitFor(() => expect(stopTrackDelayedMic).toHaveBeenCalledTimes(1));
  });

  it('VoiceOverlay renders unified selector with visible model names, switches to remote preserving local preference, and shows fallback banner', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: null,
      canManageServerSharing: false,
      providers: [
        {
          deviceId: 'dev-17b',
          displayName: '客厅主机',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
          customNickname: '客厅主机',
        },
      ],
    });

    render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('客厅主机 (Qwen3-ASR 1.7B)')).toBeTruthy());

    const select = screen.getByLabelText('voice.engine_label') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'remote:dev-17b' } });

    await waitFor(() => {
      expect(apiMocks.savePrimaryRemoteVoiceProvider).toHaveBeenCalledWith('dev-17b');
      expect(VoiceInput.getVoiceRecognitionEngine()).toBe('builtin'); // Local fallback preference preserved!
    });

    // Offline fallback notice displays cleanly
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-17b',
      providers: [],
      fallbackNotice: 'provider_offline',
    });
    await waitFor(() => expect(screen.getByTestId('voice-remote-fallback-notice')).toBeTruthy());
  });

  it('SharedVoiceSection renders modelLabel badges, hides admin toggle for non-admins, and lets desktop PC App users edit nicknames & toggle server sharing', async () => {
    vi.stubGlobal('__IMCODES_PC_APP__', { isElectron: true });
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'dev-own',
      canManageServerSharing: false,
      providers: [
        {
          deviceId: 'dev-own',
          deviceName: 'KOCA’s MacBook Pro (1118)',
          displayName: 'My Studio',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
          customNickname: 'My Studio',
        },
        {
          deviceId: 'dev-shared',
          displayName: 'Desktop · Qwen3-ASR 0.6B',
          model: 'qwen3-0.6b',
          modelLabel: 'Qwen3-ASR 0.6B',
          ready: true,
          busy: false,
          shareScope: 'server',
          isOwnDevice: false,
        },
      ],
    });

    const view = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-model-dev-own').textContent).toBe('Qwen3-ASR 1.7B'));
    expect(screen.getByTestId('settings-shared-voice-device-dev-own').textContent).toBe('KOCA’s MacBook Pro (1118)');
    expect(screen.getByTestId('settings-shared-voice-model-dev-shared').textContent).toBe('Qwen3-ASR 0.6B');
    expect(screen.queryByTestId('settings-shared-voice-device-dev-shared')).toBeNull();
    // Non-admin does NOT see relay-server-wide sharing toggle
    expect(screen.queryByTestId('settings-shared-voice-server-toggle-dev-own')).toBeNull();
    view.unmount();

    // Sequential unbounded refreshRemoteVoiceProviders() calls must not get stuck on stale _inFlightRefresh
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValueOnce({
      primaryDeviceId: 'dev-seq-1',
      canManageServerSharing: false,
      providers: [],
    });
    await refreshRemoteVoiceProviders();
    expect(getRemoteVoiceState().providers).toEqual([]);

    apiMocks.fetchRemoteVoiceProviders.mockResolvedValueOnce({
      primaryDeviceId: 'dev-seq-1',
      canManageServerSharing: false,
      providers: [
        {
          deviceId: 'dev-seq-1',
          displayName: 'K · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
        },
      ],
    });
    await refreshRemoteVoiceProviders();
    expect(getRemoteVoiceState().providers).toHaveLength(1);

    // Active non-admin sees and can toggle server-wide sharing for own PC device while admin ASR panel stays hidden
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'dev-nonadmin',
      canManageServerSharing: false,
      canShareOwnProviderToServer: true,
      providers: [
        {
          deviceId: 'dev-nonadmin',
          displayName: 'Bob · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
          customNickname: null,
        },
      ],
    });
    const nonAdminView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-server-toggle-dev-nonadmin')).toBeTruthy());
    expect(screen.queryByTestId('settings-shared-voice-asr-section')).toBeNull();
    expect(apiMocks.fetchServerAsrServices).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('settings-shared-voice-server-toggle-dev-nonadmin'));
    await waitFor(() => expect(apiMocks.setServerSharedRemoteVoiceProvider).toHaveBeenCalledWith('dev-nonadmin', true, undefined));
    nonAdminView.unmount();

    // Legacy server snapshot omitting canShareOwnProviderToServer falls back cleanly to canManageServerSharing
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValueOnce({
      primaryDeviceId: 'dev-legacy-user',
      canManageServerSharing: false,
      providers: [
        {
          deviceId: 'dev-legacy-user',
          displayName: 'Legacy · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
        },
      ],
    });
    const legacyNonAdminView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-model-dev-legacy-user')).toBeTruthy());
    expect(getRemoteVoiceState().canShareOwnProviderToServer).toBe(false);
    expect(screen.queryByTestId('settings-shared-voice-server-toggle-dev-legacy-user')).toBeNull();
    legacyNonAdminView.unmount();

    // Admin sees toggle & can edit nickname and toggle server sharing (including when canShareOwnProviderToServer is omitted)
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'dev-own',
      canManageServerSharing: true,
      providers: [
        {
          deviceId: 'dev-own',
          displayName: 'K · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
          customNickname: null,
        },
      ],
    });

    render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-server-toggle-dev-own')).toBeTruthy());

    fireEvent.click(screen.getByTestId('settings-shared-voice-edit-nick-dev-own'));
    const input = screen.getByTestId('settings-shared-voice-nick-input-dev-own') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'Lab Mac' } });
    fireEvent.click(screen.getByTestId('settings-shared-voice-save-nick-dev-own'));
    await waitFor(() => expect(apiMocks.saveRemoteVoiceProviderNickname).toHaveBeenCalledWith('dev-own', 'Lab Mac'));

    fireEvent.click(screen.getByTestId('settings-shared-voice-server-toggle-dev-own'));
    await waitFor(() => expect(apiMocks.setServerSharedRemoteVoiceProvider).toHaveBeenCalledWith('dev-own', true, undefined));
  });

  it('hides server-wide sharing toggle on mobile Capacitor (iOS/Android) and non-PC-App browsers while preserving provider selection and admin ASR section', async () => {
    const mobileSnapshot: RemoteVoiceProvidersSnapshot = {
      primaryDeviceId: null,
      canManageServerSharing: false,
      canShareOwnProviderToServer: true,
      providers: [
        {
          deviceId: 'dev-own-mac',
          displayName: 'Studio Mac · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
          customNickname: 'Studio Mac',
        },
      ],
    };

    // 1. iOS Capacitor app (no __IMCODES_PC_APP__): toggle hidden, badges visible, primary selection works
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue(mobileSnapshot);
    const iosView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-model-dev-own-mac').textContent).toBe('Qwen3-ASR 1.7B'));
    expect(screen.getByTestId('settings-shared-voice-scope-dev-own-mac').textContent).toBe('settings.shared_voice_scope_account');
    expect(screen.queryByTestId('settings-shared-voice-server-toggle-dev-own-mac')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-shared-voice-select-dev-own-mac'));
    await waitFor(() => expect(apiMocks.savePrimaryRemoteVoiceProvider).toHaveBeenCalledWith('dev-own-mac'));
    iosView.unmount();

    // 2. Android Capacitor app even with admin account & canShareOwnProviderToServer=true: toggle still hidden, admin ASR section preserved
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      ...mobileSnapshot,
      canManageServerSharing: true,
      canShareOwnProviderToServer: true,
    });
    const androidAdminView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-asr-section')).toBeTruthy());
    expect(screen.queryByTestId('settings-shared-voice-server-toggle-dev-own-mac')).toBeNull();
    androidAdminView.unmount();

    // 3. Designed-for-iPad-on-Mac (native iOS on MacIntel, no __IMCODES_PC_APP__): toggle hidden
    vi.stubGlobal('navigator', {
      platform: 'MacIntel',
      maxTouchPoints: 5,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'ios' });
    const ipadOnMacView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-model-dev-own-mac')).toBeTruthy());
    expect(screen.queryByTestId('settings-shared-voice-server-toggle-dev-own-mac')).toBeNull();
    ipadOnMacView.unmount();

    // 4. Non-PC-App web browser (no Capacitor, no __IMCODES_PC_APP__), even with legacy fallback omitted canShareOwnProviderToServer: toggle hidden
    vi.stubGlobal('Capacitor', undefined);
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: null,
      canManageServerSharing: true,
      providers: mobileSnapshot.providers,
    });
    const webBrowserView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-asr-section')).toBeTruthy());
    expect(screen.queryByTestId('settings-shared-voice-server-toggle-dev-own-mac')).toBeNull();
    webBrowserView.unmount();
  });

  it('hides Server ASR admin UI and makes zero admin calls for non-admins, and lets admins manage ASR services', async () => {
    // Non-admin view with http_asr provider in provider list
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'env-default',
      canManageServerSharing: false,
      providers: [
        {
          deviceId: 'env-default',
          displayName: 'OpenAI Whisper',
          model: 'whisper-1',
          modelLabel: 'whisper-1',
          ready: true,
          busy: false,
          shareScope: 'server',
          providerKind: 'http_asr',
          isOwnDevice: false,
        },
      ],
    });

    const nonAdminView = render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-model-env-default').textContent).toBe('whisper-1'));
    expect(screen.getByTestId('settings-shared-voice-scope-env-default').textContent).toBe('settings.shared_voice_scope_server');
    expect(screen.queryByTestId('settings-shared-voice-asr-section')).toBeNull();
    expect(apiMocks.fetchServerAsrServices).not.toHaveBeenCalled();
    nonAdminView.unmount();

    // Admin view loads /api/voice/server-asr-services, displays envDefault + services, and handles add/edit/toggle/delete
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
      primaryDeviceId: 'asr_1',
      canManageServerSharing: true,
      providers: [],
    });
    apiMocks.fetchServerAsrServices.mockResolvedValue({
      envDefault: {
        id: 'env-default',
        name: 'Env Whisper',
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true,
        apiKeyMasked: 'sk-e...9999',
        model: 'whisper-1',
        enabled: true,
        source: 'env',
      },
      services: [
        {
          id: 'asr_1',
          name: 'Groq Whisper',
          baseUrl: 'https://api.groq.com/openai/v1',
          hasApiKey: true,
          apiKeyMasked: 'gsk-...1234',
          model: 'whisper-large-v3',
          enabled: true,
          source: 'admin',
        },
      ],
      encryptionAvailable: true,
    });
    apiMocks.createServerAsrService.mockResolvedValue({
      ok: true,
      service: {
        id: 'asr_2',
        name: 'Local Faster-Whisper',
        baseUrl: 'http://127.0.0.1:8000',
        hasApiKey: false,
        apiKeyMasked: null,
        model: 'large-v3',
        enabled: true,
        source: 'admin',
      },
      envDefault: null,
      services: [
        {
          id: 'asr_1',
          name: 'Groq Whisper',
          baseUrl: 'https://api.groq.com/openai/v1',
          hasApiKey: true,
          apiKeyMasked: 'gsk-...1234',
          model: 'whisper-large-v3',
          enabled: true,
          source: 'admin',
        },
        {
          id: 'asr_2',
          name: 'Local Faster-Whisper',
          baseUrl: 'http://127.0.0.1:8000',
          hasApiKey: false,
          apiKeyMasked: null,
          model: 'large-v3',
          enabled: true,
          source: 'admin',
        },
      ],
      encryptionAvailable: true,
    });
    apiMocks.updateServerAsrService.mockResolvedValue({
      ok: true,
      service: {
        id: 'asr_1',
        name: 'Groq Whisper Updated',
        baseUrl: 'https://api.groq.com/openai/v1',
        hasApiKey: false,
        apiKeyMasked: null,
        model: 'whisper-large-v3',
        enabled: false,
        source: 'admin',
      },
      envDefault: null,
      services: [
        {
          id: 'asr_2',
          name: 'Local Faster-Whisper',
          baseUrl: 'http://127.0.0.1:8000',
          hasApiKey: false,
          apiKeyMasked: null,
          model: 'large-v3',
          enabled: true,
          source: 'admin',
        },
      ],
      encryptionAvailable: true,
    });
    apiMocks.deleteServerAsrService.mockResolvedValue({
      ok: true,
      deletedId: 'asr_2',
      envDefault: null,
      services: [],
      encryptionAvailable: true,
    });

    render(<SharedVoiceSection />);
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-asr-item-env-default')).toBeTruthy());
    expect(screen.getByTestId('settings-shared-voice-asr-item-asr_1')).toBeTruthy();

    // Add service
    fireEvent.click(screen.getByTestId('settings-shared-voice-asr-add-btn'));
    fireEvent.input(screen.getByTestId('settings-shared-voice-asr-input-name'), { target: { value: 'Local Faster-Whisper' } });
    fireEvent.input(screen.getByTestId('settings-shared-voice-asr-input-base-url'), { target: { value: 'http://127.0.0.1:8000' } });
    fireEvent.input(screen.getByTestId('settings-shared-voice-asr-input-model'), { target: { value: 'large-v3' } });
    fireEvent.click(screen.getByTestId('settings-shared-voice-asr-save'));
    await waitFor(() => expect(apiMocks.createServerAsrService).toHaveBeenCalledWith({
      name: 'Local Faster-Whisper',
      baseUrl: 'http://127.0.0.1:8000',
      model: 'large-v3',
      enabled: true,
    }));

    // Edit service and clear saved key
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-asr-edit-asr_1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('settings-shared-voice-asr-edit-asr_1'));
    fireEvent.click(screen.getByTestId('settings-shared-voice-asr-clear-key'));
    fireEvent.click(screen.getByTestId('settings-shared-voice-asr-save'));
    await waitFor(() => expect(apiMocks.updateServerAsrService).toHaveBeenCalledWith('asr_1', expect.objectContaining({
      name: 'Groq Whisper',
      apiKey: '',
    })));

    // Delete remaining service
    await waitFor(() => expect(screen.getByTestId('settings-shared-voice-asr-delete-asr_2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('settings-shared-voice-asr-delete-asr_2'));
    await waitFor(() => expect(apiMocks.deleteServerAsrService).toHaveBeenCalledWith('asr_2'));
  });

  it('waits longer than 5s stop drain for http_asr providers and delivers delayed final transcript', async () => {
    vi.useFakeTimers();
    try {
      const audio = setupFakeWebAudio();
      resetRemoteVoiceClientForTesting({ primaryDeviceId: 'asr_1', providers: [], fetchedAt: 0 });
      apiMocks.fetchRemoteVoiceProviders.mockResolvedValue({
        primaryDeviceId: 'asr_1',
        canManageServerSharing: false,
        providers: [
          {
            deviceId: 'asr_1',
            displayName: 'OpenAI Whisper',
            model: 'whisper-1',
            modelLabel: 'whisper-1',
            ready: true,
            busy: false,
            shareScope: 'server',
            providerKind: 'http_asr',
            isOwnDevice: false,
          },
        ],
      });

      const results: Array<{ text: string; isFinal: boolean }> = [];
      const startPromise = VoiceInput.startListening((t, f) => results.push({ text: t, isFinal: f }));
      for (let i = 0; i < 10 && FakeWebSocket.instances.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(5);
      }
      expect(FakeWebSocket.instances).toHaveLength(1);
      const clientWs = FakeWebSocket.instances[0]!;
      clientWs.emitOpen();
      const startFrame = JSON.parse(clientWs.sent[0]!) as Record<string, unknown>;
      clientWs.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
      expect(await startPromise).toBe(true);

      audio.emitSamples(new Float32Array(12_000).fill(0.25));

      let stopped = false;
      const stopPromise = VoiceInput.stopListening().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(5);
      expect(clientWs.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true);

      // Advance past standard 5s PC-App drain timeout -> must STILL wait for http_asr up to 28s
      await vi.advanceTimersByTimeAsync(7_000);
      expect(stopped).toBe(false);

      // Server finishes transcription at 7s -> result delivered and stop resolves cleanly
      clientWs.emitMessage({
        type: 'voice.session.result',
        sessionId: startFrame.sessionId,
        text: 'Long HTTP ASR transcript',
        isFinal: true,
      });
      clientWs.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
      await vi.advanceTimersByTimeAsync(0);
      await stopPromise;
      expect(stopped).toBe(true);
      expect(results).toContainEqual({ text: 'Long HTTP ASR transcript', isFinal: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ships complete shared-voice and fallback i18n keys across all 7 locale files', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru'];
    const requiredVoiceKeys = ['engine_local', 'shared_provider_offline_option', 'remote_fallback_notice', 'preparing_wait'];
    const requiredSettingsKeys = [
      'shared_voice_title',
      'shared_voice_desc',
      'shared_voice_refresh',
      'shared_voice_primary_offline',
      'shared_voice_use_local',
      'shared_voice_local_default',
      'shared_voice_local_desc',
      'shared_voice_active',
      'shared_voice_use_this',
      'shared_voice_empty',
      'shared_voice_status_not_ready',
      'shared_voice_status_busy',
      'shared_voice_status_ready',
      'shared_voice_scope_server',
      'shared_voice_scope_account',
      'shared_voice_this_device',
      'shared_voice_nickname_label',
      'shared_voice_nickname_default',
      'shared_voice_nickname_placeholder',
      'shared_voice_nickname_reset',
      'shared_voice_server_share_toggle',
      'shared_voice_server_share_desc',
      'shared_voice_saved',
      'shared_voice_save_error',
      'shared_voice_asr_title',
      'shared_voice_asr_desc',
      'shared_voice_asr_add',
      'shared_voice_asr_edit',
      'shared_voice_asr_delete',
      'shared_voice_asr_env_badge',
      'shared_voice_asr_env_readonly',
      'shared_voice_asr_empty',
      'shared_voice_asr_name_label',
      'shared_voice_asr_name_placeholder',
      'shared_voice_asr_base_url_label',
      'shared_voice_asr_base_url_placeholder',
      'shared_voice_asr_api_key_label',
      'shared_voice_asr_api_key_placeholder',
      'shared_voice_asr_api_key_keep',
      'shared_voice_asr_api_key_clear',
      'shared_voice_asr_model_label',
      'shared_voice_asr_model_placeholder',
      'shared_voice_asr_enabled_label',
      'shared_voice_asr_encryption_warn',
      'shared_voice_asr_saved',
      'shared_voice_asr_deleted',
      'shared_voice_asr_error',
    ];
    for (const loc of locales) {
      const json = JSON.parse(
        readFileSync(resolve(import.meta.dirname, `../src/i18n/locales/${loc}.json`), 'utf8'),
      ) as { voice: Record<string, string>; settings: Record<string, string> };
      for (const k of requiredVoiceKeys) {
        expect(typeof json.voice[k], `${loc}.voice.${k}`).toBe('string');
        expect(json.voice[k]!.length, `${loc}.voice.${k} non-empty`).toBeGreaterThan(0);
      }
      for (const k of requiredSettingsKeys) {
        expect(typeof json.settings[k], `${loc}.settings.${k}`).toBe('string');
        expect(json.settings[k]!.length, `${loc}.settings.${k} non-empty`).toBeGreaterThan(0);
      }
    }
  });

  it('StreamingPcmResampler preserves exact samples across 48kHz blocks, smoothly resamples 44.1kHz, and encodes Int16LE explicitly', () => {
    // 48kHz -> 16kHz across 3 x 4096 callbacks = 12288 samples -> exact 4096 output samples (0 dropped!)
    const resampler48 = new StreamingPcmResampler(48_000, 16_000);
    const out48Chunks: Int16Array[] = [];
    for (let b = 0; b < 3; b += 1) {
      const block = new Float32Array(4096);
      for (let i = 0; i < block.length; i += 1) {
        const globalIdx = b * 4096 + i;
        block[i] = 0.5 * Math.sin((2 * Math.PI * 1_000 * globalIdx) / 48_000);
      }
      out48Chunks.push(resampler48.push(block));
    }
    const tail48 = resampler48.flush();
    const total48 = out48Chunks.reduce((acc, c) => acc + c.length, 0) + tail48.length;
    expect(total48).toBe(4096);

    // 44.1kHz -> 16kHz continuous 1kHz sine wave across multiple 2048-sample callbacks: zero phase discontinuities
    const resampler44 = new StreamingPcmResampler(44_100, 16_000);
    const out44: number[] = [];
    for (let b = 0; b < 10; b += 1) {
      const block = new Float32Array(2048);
      for (let i = 0; i < block.length; i += 1) {
        const globalIdx = b * 2048 + i;
        block[i] = 0.5 * Math.sin((2 * Math.PI * 1_000 * globalIdx) / 44_100);
      }
      const chunk = resampler44.push(block);
      for (let i = 0; i < chunk.length; i += 1) out44.push(chunk[i]!);
    }
    const flushed44 = resampler44.flush();
    for (let i = 0; i < flushed44.length; i += 1) out44.push(flushed44[i]!);
    const expected44 = Math.round((10 * 2048 * 16_000) / 44_100);
    expect(Math.abs(out44.length - expected44)).toBeLessThanOrEqual(2);
    // Max adjacent sample step at 1kHz @ 16kHz (0.5 amplitude): <= 2*pi*1000/16000 * 0.5 * 32768 ~ 6434 (allow small margin)
    for (let i = 20; i < out44.length; i += 1) {
      expect(Math.abs(out44[i]! - out44[i - 1]!)).toBeLessThan(8_500);
    }

    // Explicit little-endian Int16 encoding even on subarrays
    const base = Int16Array.from([0x1234, -0x0102, 0x7fff]);
    const sub = base.subarray(1, 2);
    const decoded = Uint8Array.from(atob(encodeInt16PcmToBase64(sub)), (c) => c.charCodeAt(0));
    const view = new DataView(decoded.buffer);
    expect(view.getInt16(0, true)).toBe(-0x0102);
  });

  it('starts mic capture immediately while ticket/WS handshake is pending, preserves pre-ready audio on early stop(false), and cleans up on abort', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    let resolveTicket!: (v: { ticket: string }) => void;
    const ticketPromise = new Promise<{ ticket: string }>((res) => { resolveTicket = res; });
    const levels: number[] = [];
    const results: Array<{ text: string; isFinal: boolean }> = [];
    let capturedHandle: { stop: (abort?: boolean) => Promise<void> } | null = null;

    const sessionPromise = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: (t, f) => results.push({ text: t, isFinal: f }),
      onLevel: (l) => levels.push(l),
      onCaptureStarted: (h) => { capturedHandle = h; },
      fetchTicket: () => ticketPromise,
    });

    // Mic capture starts immediately BEFORE fetchTicket or WebSocket resolves!
    await waitFor(() => expect(capturedHandle).not.toBeNull());
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(audio.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    expect(audio.contextCtorArgs[0]).toEqual({ sampleRate: 16_000 });
    expect(audio.scriptProcessorBufferSizes[0]).toBe(1024);

    // Emit audio BEFORE ticket/ready -> drives waveform level and buffers PCM
    audio.emitSamples(new Float32Array(2_000).fill(0.25));
    expect(levels.length).toBeGreaterThan(0);

    // Release hold-to-talk (stop(false)) BEFORE voice.session.ready arrives!
    const stopPromise = capturedHandle!.stop(false);
    expect(audio.stopTrack).toHaveBeenCalledTimes(1);

    // Now ticket + WS open + voice.session.ready complete -> buffered PCM must flush before voice.session.stop!
    resolveTicket({ ticket: 'tkt-delayed' });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(startFrame.type).toBe('voice.session.start');

    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(sessionPromise).resolves.toMatchObject({ ok: true });

    await waitFor(() => expect(ws.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true));
    const sentTypes = ws.sent.map((raw) => JSON.parse(raw).type);
    const audioIdx = sentTypes.indexOf('voice.session.audio');
    const stopIdx = sentTypes.indexOf('voice.session.stop');
    expect(audioIdx).toBeGreaterThan(0);
    expect(audioIdx).toBeLessThan(stopIdx);

    ws.emitMessage({ type: 'voice.session.result', sessionId: startFrame.sessionId, text: '提前录音成功', isFinal: true });
    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await stopPromise;
    expect(results).toEqual([{ text: '提前录音成功', isFinal: true }]);
    expect(audio.closeCtx).toHaveBeenCalled();

    // Test AudioContext fallback when options bag is rejected + adaptive 2048 buffer @ 48kHz + abort during pending ticket
    const audioFallback = setupFakeWebAudio({ sampleRate: 48_000, throwOnOptions: true });
    const abortCtrl = new AbortController();
    const abortedSessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: vi.fn(),
      signal: abortCtrl.signal,
      fetchTicket: () => new Promise(() => {}),
    });
    await waitFor(() => expect(audioFallback.scriptProcessorBufferSizes[0]).toBe(2048));
    expect(audioFallback.contextCtorArgs).toEqual([{ sampleRate: 16_000 }, undefined]);
    abortCtrl.abort();
    await expect(abortedSessionP).resolves.toEqual({ ok: false, cancelled: true, reason: 'cancelled' });
    expect(audioFallback.stopTrack).toHaveBeenCalledTimes(1);
    expect(audioFallback.closeCtx).toHaveBeenCalledTimes(1);
  });

  it('resolveRemoteVoiceRoute returns immediately without blocking when cached primary is ready & idle, and refreshes in background when stale', async () => {
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      fetchedAt: Date.now() - 60_000, // stale (> 5s)
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
    let resolveBgRefresh!: (snap: RemoteVoiceProvidersSnapshot) => void;
    apiMocks.fetchRemoteVoiceProviders.mockImplementation(
      () => new Promise<RemoteVoiceProvidersSnapshot>((res) => { resolveBgRefresh = res; }),
    );

    // Must return immediately without awaiting background refresh
    const decision = await resolveRemoteVoiceRoute();
    expect(decision).toMatchObject({ route: 'remote', targetDeviceId: 'dev-mac-1' });
    expect(apiMocks.fetchRemoteVoiceProviders).toHaveBeenCalledTimes(1);
    resolveBgRefresh({ primaryDeviceId: 'dev-mac-1', canManageServerSharing: false, providers: [] });
    await waitFor(() => expect(getRemoteVoiceState().loading).toBe(false));

    // When cached primary is busy or not ready, resolveRemoteVoiceRoute MUST await bounded refresh to detect recovery
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      fetchedAt: Date.now(),
      providers: [
        {
          deviceId: 'dev-mac-1',
          displayName: 'Mac Studio',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: false,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
        },
      ],
    });
    apiMocks.fetchRemoteVoiceProviders.mockResolvedValueOnce({
      primaryDeviceId: 'dev-mac-1',
      canManageServerSharing: false,
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
    const recovered = await resolveRemoteVoiceRoute();
    expect(recovered).toMatchObject({ route: 'remote', targetDeviceId: 'dev-mac-1' });
  });

  it('VoiceInput sets listening active on mic capture before voice.session.ready and drains short utterances released before ready', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
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

    const results: Array<{ text: string; isFinal: boolean }> = [];
    const listeningStates: boolean[] = [];
    const levels: number[] = [];
    VoiceInput.onAudioLevel((l) => levels.push(l));

    const startPromise = VoiceInput.startListening(
      (t, f) => results.push({ text: t, isFinal: f }),
      (l) => listeningStates.push(l),
    );

    // Listening UI becomes active BEFORE voice.session.ready arrives
    await waitFor(() => expect(listeningStates).toEqual([true]));
    audio.emitSamples(new Float32Array(2_000).fill(0.25));
    expect(levels.length).toBeGreaterThan(0);

    // User releases hold-to-talk BEFORE voice.session.ready arrives!
    const stopPromise = VoiceInput.stopListening();
    await waitFor(() => expect(listeningStates).toEqual([true, false]));

    // Handshake finishes afterward -> buffered PCM must still transmit and deliver final transcript!
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(startPromise).resolves.toBe(true);

    await waitFor(() => expect(ws.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true));
    ws.emitMessage({ type: 'voice.session.result', sessionId: startFrame.sessionId, text: '松手也不断句', isFinal: true });
    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await stopPromise;
    expect(results).toEqual([{ text: '松手也不断句', isFinal: true }]);
    expect(streamingBridge.start).not.toHaveBeenCalled();
  });

  it('primes remote capture only when mic permission is known granted, preserves all pre-roll PCM on adoption, bounds buffer, and cleans up cancelled primes', async () => {
    // 1. Permission unknown or prompt -> primeRemoteVoiceCapture refuses synchronously without calling getUserMedia
    const audioPrompt = setupFakeWebAudio({ sampleRate: 16_000 });
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: 'prompt' })) },
    });
    expect(primeRemoteVoiceCapture()).toBe(false);
    await probeRemoteMicPermission();
    expect(primeRemoteVoiceCapture()).toBe(false);
    expect(audioPrompt.getUserMedia).not.toHaveBeenCalled();

    // 2. Permission granted -> prime starts local PCM capture immediately with zero ticket/WS calls and adopts with 0 lost audio
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: 'granted' })) },
    });
    await probeRemoteMicPermission();
    expect(primeRemoteVoiceCapture()).toBe(true);
    await waitFor(() => expect(audioPrompt.getUserMedia).toHaveBeenCalledTimes(1));
    expect(apiMocks.fetchRemoteVoiceWsTicket).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);

    // Emit pre-roll exceeding 15s cap (240_000 samples) -> must stay bounded and deliver non-zero audio
    audioPrompt.emitSamples(new Float32Array(250_000).fill(0.25));

    const levels: number[] = [];
    let capturedHandle: { stop: (abort?: boolean) => Promise<void> } | null = null;
    const sessionPromise = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: vi.fn(),
      onLevel: (lvl) => levels.push(lvl),
      onCaptureStarted: (h) => { capturedHandle = h; },
      fetchTicket: async () => ({ ticket: 'tkt-prime' }),
    });

    // Must reuse existing getUserMedia capture immediately without calling getUserMedia a second time
    expect(audioPrompt.getUserMedia).toHaveBeenCalledTimes(1);
    expect(capturedHandle).not.toBeNull();
    expect(levels.length).toBeGreaterThan(0);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(sessionPromise).resolves.toMatchObject({ ok: true });

    const audioFrames = ws.sent
      .map((raw) => JSON.parse(raw) as { type: string; pcmBase64?: string })
      .filter((f) => f.type === 'voice.session.audio');
    const totalSamplesFlushed = audioFrames.reduce(
      (sum, f) => sum + Math.floor(atob(f.pcmBase64!).length / 2),
      0,
    );
    expect(totalSamplesFlushed).toBeGreaterThan(0);
    expect(totalSamplesFlushed).toBeLessThanOrEqual(16_000 * 15);

    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await capturedHandle!.stop(false);
    expect(audioPrompt.stopTrack).toHaveBeenCalledTimes(1);
    expect(audioPrompt.closeCtx).toHaveBeenCalledTimes(1);

    // 3. Cancel while getUserMedia is still pending stops resolved tracks immediately and creates no AudioContext
    let resolvePendingMic!: (stream: MediaStream) => void;
    const pendingStopTrack = vi.fn();
    const pendingAudio = setupFakeWebAudio({ sampleRate: 16_000 });
    pendingAudio.getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((res) => { resolvePendingMic = res; }),
    );
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: 'granted' })) },
    });
    await probeRemoteMicPermission();
    expect(primeRemoteVoiceCapture()).toBe(true);
    cancelRemoteVoiceCapturePrime();
    resolvePendingMic({ getTracks: () => [{ stop: pendingStopTrack }] } as unknown as MediaStream);
    await new Promise((r) => setTimeout(r, 0));
    expect(pendingStopTrack).toHaveBeenCalledTimes(1);
    expect(pendingAudio.contextCtorArgs).toHaveLength(0);

    // 4. Adoption while getUserMedia is still pending waits on the single primed request without invoking getUserMedia twice
    let resolveDelayedMic!: (stream: MediaStream) => void;
    const delayedStopTrack = vi.fn();
    const delayedAudio = setupFakeWebAudio({ sampleRate: 16_000 });
    delayedAudio.getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((res) => { resolveDelayedMic = res; }),
    );
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn(async () => ({ state: 'granted' })) },
    });
    await probeRemoteMicPermission();
    expect(primeRemoteVoiceCapture()).toBe(true);
    let delayedHandle: { stop: (abort?: boolean) => Promise<void> } | null = null;
    const delayedSessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: vi.fn(),
      onCaptureStarted: (h) => { delayedHandle = h; },
      fetchTicket: async () => ({ ticket: 'tkt-delayed-prime' }),
    });
    expect(delayedAudio.getUserMedia).toHaveBeenCalledTimes(1);
    expect(delayedHandle).toBeNull();
    resolveDelayedMic({ getTracks: () => [{ stop: delayedStopTrack }] } as unknown as MediaStream);
    await waitFor(() => expect(delayedHandle).not.toBeNull());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emitOpen();
    const startFrame2 = JSON.parse(ws2.sent[0]!) as Record<string, unknown>;
    ws2.emitMessage({ type: 'voice.session.ready', sessionId: startFrame2.sessionId });
    await expect(delayedSessionP).resolves.toMatchObject({ ok: true });
    ws2.emitMessage({ type: 'voice.session.end', sessionId: startFrame2.sessionId });
    await delayedHandle!.stop(false);
    expect(delayedStopTrack).toHaveBeenCalledTimes(1);
  });

  it('sanitizes incoming voice.session.result repetition loops and suppresses pure-hallucination partials before onResult', async () => {
    setupFakeWebAudio({ sampleRate: 16_000 });
    const delivered: Array<{ text: string; isFinal: boolean }> = [];
    let handle: { stop: (abort?: boolean) => Promise<void> } | null = null;

    const sessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: (text, isFinal) => delivered.push({ text, isFinal }),
      onCaptureStarted: (h) => { handle = h; },
      fetchTicket: async () => ({ ticket: 'tkt-sanitize' }),
    });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(sessionP).resolves.toMatchObject({ ok: true });

    // Pure hallucination partial suppressed cleanly
    ws.emitMessage({
      type: 'voice.session.result',
      sessionId: startFrame.sessionId,
      text: '想，他'.repeat(60),
      isFinal: false,
    });
    expect(delivered).toHaveLength(0);

    // Normal expression untouched, mixed trailing loop stripped
    ws.emitMessage({
      type: 'voice.session.result',
      sessionId: startFrame.sessionId,
      text: '哈哈哈哈',
      isFinal: false,
    });
    ws.emitMessage({
      type: 'voice.session.result',
      sessionId: startFrame.sessionId,
      text: '明天开会讨论方案，' + '想，他'.repeat(6),
      isFinal: true,
    });

    expect(delivered).toEqual([
      { text: '哈哈哈哈', isFinal: false },
      { text: '明天开会讨论方案，', isFinal: true },
    ]);

    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await handle!.stop(false);
  });

  it('prefers physical built-in mic over Bluetooth/AirPods via enumerateDevices without brittle exact constraint', async () => {
    expect(
      selectPreferredBuiltInMicDeviceId([
        { kind: 'audiooutput', deviceId: 'spk-1', label: 'Built-in Speaker' },
        { kind: 'audioinput', deviceId: 'bt-1', label: 'AirPods Pro Hands-Free' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'iPhone Microphone' },
      ]),
    ).toBe('mic-1');

    expect(
      selectPreferredBuiltInMicDeviceId([
        { kind: 'audioinput', deviceId: 'bt-1', label: 'WH-1000XM5 (Bluetooth)' },
        { kind: 'audioinput', deviceId: 'mic-fallback', label: 'camcorder microphone' },
      ]),
    ).toBe('mic-fallback');

    // Empty labels before permission must return undefined so default constraints stay unconstrained.
    expect(
      selectPreferredBuiltInMicDeviceId([
        { kind: 'audioinput', deviceId: 'default', label: '' },
      ]),
    ).toBeUndefined();

    const fake = setupFakeWebAudio({ sampleRate: 16_000 });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'bt-1', label: 'AirPods Pro' },
        { kind: 'audioinput', deviceId: 'builtin-phone', label: 'Built-in Microphone' },
      ]),
    });

    await probeRemoteMicPermission();
    let handle: { stop: (abort?: boolean) => Promise<void> } | null = null;
    const sessionP = startRemoteVoiceSession({
      targetDeviceId: 'pc-1',
      onResult: () => {},
      onCaptureStarted: (h) => { handle = h; },
      getWsBaseUrl: () => 'https://relay.example',
    });

    await vi.waitFor(() => {
      expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
    });
    expect(fake.getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        deviceId: { ideal: 'builtin-phone' },
      },
    });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(sessionP).resolves.toMatchObject({ ok: true });
    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await handle!.stop(false);
  });

  it('uses native StreamingSpeech raw PCM capture on Capacitor native shells, adopts pre-roll, drains tail on stop, and cleans up on abort', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const fake = setupFakeWebAudio({ sampleRate: 16_000 });
    const removeRawListener = vi.fn(async () => {});
    const startRawPcmCapture = vi.fn(async () => {});
    const stopRawPcmCapture = vi.fn(async () => {
      // Simulate emitting one tail chunk during native drain.
      streamingBridge.listeners.rawPcmChunk?.({
        pcmBase64: encodeInt16PcmToBase64(new Int16Array([300, -300, 150, -150])),
        level: 0.4,
      });
    });
    streamingBridge.addListener.mockImplementation(async (name: string, fn: (data: unknown) => void) => {
      streamingBridge.listeners[name] = fn;
      return { remove: name === 'rawPcmChunk' ? removeRawListener : vi.fn(async () => {}) };
    });
    Object.assign(streamingBridge, { startRawPcmCapture, stopRawPcmCapture });

    try {
      await probeRemoteMicPermission();
      expect(streamingBridge.checkPermissions).toHaveBeenCalled();
      expect(fake.getUserMedia).not.toHaveBeenCalled();

      // Pre-roll during prime adopts into session without opening getUserMedia or calling startRawPcmCapture twice.
      expect(primeRemoteVoiceCapture()).toBe(true);
      await vi.waitFor(() => {
        expect(startRawPcmCapture).toHaveBeenCalledTimes(1);
      });
      const preRollPcm = new Int16Array([100, -100, 200, -200]);
      streamingBridge.listeners.rawPcmChunk?.({
        pcmBase64: encodeInt16PcmToBase64(preRollPcm),
        level: 0.25,
      });

      const levels: number[] = [];
      let handle: { stop: (abort?: boolean) => Promise<void> } | null = null;
      const sessionP = startRemoteVoiceSession({
        targetDeviceId: 'pc-1',
        onResult: () => {},
        onLevel: (lvl) => levels.push(lvl),
        onCaptureStarted: (h) => { handle = h; },
        getWsBaseUrl: () => 'https://relay.example',
      });

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws = FakeWebSocket.instances[0]!;
      ws.emitOpen();
      const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
      ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
      await expect(sessionP).resolves.toMatchObject({ ok: true });
      expect(startRawPcmCapture).toHaveBeenCalledTimes(1);
      expect(fake.getUserMedia).not.toHaveBeenCalled();

      // Pre-roll flushed once ready.
      const framesBeforeLive = ws.sent.slice(1).map((s) => JSON.parse(s) as { type: string; pcmBase64?: string });
      const firstAudio = framesBeforeLive.find((f) => f.type === 'voice.session.audio');
      expect(firstAudio?.pcmBase64).toBeTruthy();
      expect(Array.from(decodeBase64ToInt16Pcm(firstAudio!.pcmBase64!))).toEqual([100, -100, 200, -200]);

      // Live native chunk while active.
      streamingBridge.listeners.rawPcmChunk?.({
        pcmBase64: encodeInt16PcmToBase64(new Int16Array([42, -42])),
        level: 0.5,
      });

      const stopPromise = handle!.stop(false);
      await waitFor(() => {
        expect(stopRawPcmCapture).toHaveBeenCalledTimes(1);
        expect(ws.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true);
      });
      const sentTypes = ws.sent.map((s) => JSON.parse(s) as { type: string; pcmBase64?: string });
      const streamedSamples = sentTypes
        .filter((f) => f.type === 'voice.session.audio' && typeof f.pcmBase64 === 'string')
        .flatMap((f) => Array.from(decodeBase64ToInt16Pcm(f.pcmBase64!)));
      expect(streamedSamples).toEqual([100, -100, 200, -200, 42, -42, 300, -300, 150, -150]);
      expect(sentTypes.some((f) => f.type === 'voice.session.stop')).toBe(true);
      expect(levels).toContain(0.5);

      ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
      await stopPromise;
      expect(removeRawListener).toHaveBeenCalled();
    } finally {
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
    }
  });

  it('falls back to getUserMedia with built-in mic preference if native startRawPcmCapture rejects as unimplemented', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const fake = setupFakeWebAudio({ sampleRate: 16_000 });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'bt-sco', label: 'Galaxy Buds Bluetooth' },
        { kind: 'audioinput', deviceId: 'android-builtin', label: 'Android Built-in Mic' },
      ]),
    });
    Object.assign(streamingBridge, {
      startRawPcmCapture: vi.fn(async () => {
        throw new Error('Plugin method startRawPcmCapture is not implemented');
      }),
      stopRawPcmCapture: vi.fn(async () => {}),
    });

    try {
      let handle: { stop: (abort?: boolean) => Promise<void> } | null = null;
      const sessionP = startRemoteVoiceSession({
        targetDeviceId: 'pc-1',
        onResult: () => {},
        onCaptureStarted: (h) => { handle = h; },
        getWsBaseUrl: () => 'https://relay.example',
      });

      await vi.waitFor(() => {
        expect(fake.getUserMedia).toHaveBeenCalledTimes(1);
      });
      expect(fake.getUserMedia.mock.calls[0]?.[0]).toEqual({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          deviceId: { ideal: 'android-builtin' },
        },
      });

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws = FakeWebSocket.instances[0]!;
      ws.emitOpen();
      const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
      ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
      await expect(sessionP).resolves.toMatchObject({ ok: true });
      // Direct UNIMPLEMENTED fallback must latch native raw PCM unsupported and stream actual PCM frames.
      expect(getNativeRawPcmCapture()).toBeNull();
      fake.emitSamples(new Float32Array(2048).fill(0.25));
      const audioFrames = ws.sent
        .map((raw) => JSON.parse(raw) as { type: string; sessionId: string; pcmBase64?: string })
        .filter((f) => f.type === 'voice.session.audio' && f.sessionId === startFrame.sessionId);
      expect(audioFrames.length).toBeGreaterThan(0);
      const sentPcm = decodeBase64ToInt16Pcm(audioFrames[0]!.pcmBase64!);
      expect(sentPcm.some((sample) => sample > 4000)).toBe(true);
      ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
      await handle!.stop(false);
    } finally {
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
    }
  });

  it('requests Android native mic permission cleanly for both local and remote hold-to-talk and updates cached remote mic permission', async () => {
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const prevAddListener = streamingBridge.addListener;
    Object.assign(streamingBridge, {
      startRawPcmCapture: vi.fn(async () => {}),
      stopRawPcmCapture: vi.fn(async () => {}),
      addListener: vi.fn(async () => ({ remove: async () => {} })),
    });

    try {
      VoiceInput.setVoiceRecognitionEngine('builtin');
      // 1. Remote shared voice enabled: prompt -> grant -> updates isRemoteMicPermissionKnownGranted()
      resetRemoteVoiceClientForTesting({ primaryDeviceId: 'pc-1' });
      streamingBridge.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'prompt' });
      streamingBridge.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'granted' });
      const grantedOutcome = await VoiceInput.ensureNativeMicPermissionForHold();
      expect(grantedOutcome).toEqual({ granted: true, prompted: true });
      expect(streamingBridge.requestPermissions).toHaveBeenCalledTimes(1);
      expect(isRemoteMicPermissionKnownGranted()).toBe(true);

      // 2. Subsequent hold returns cached granted without prompting again
      const cachedOutcome = await VoiceInput.ensureNativeMicPermissionForHold();
      expect(cachedOutcome).toEqual({ granted: true, prompted: false });
      expect(streamingBridge.requestPermissions).toHaveBeenCalledTimes(1);

      // 3. Local voice when denied -> returns { granted: false, prompted: true }
      VoiceInput.setVoiceRecognitionEngine('builtin');
      resetRemoteVoiceClientForTesting({ primaryDeviceId: null });
      streamingBridge.checkPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
      streamingBridge.requestPermissions.mockResolvedValueOnce({ speechRecognition: 'denied' });
      const deniedOutcome = await VoiceInput.ensureNativeMicPermissionForHold();
      expect(deniedOutcome).toEqual({ granted: false, prompted: true });
      expect(isRemoteMicPermissionKnownGranted()).toBe(false);
    } finally {
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      streamingBridge.addListener = prevAddListener;
    }
  });

  it('tracks remote desktop, http_asr, and live remote->local fallback service names in VoiceInput and VoiceOverlay', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    setupFakeWebAudio({ sampleRate: 16_000 });

    // 1. Shared desktop provider shown immediately on start
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      fetchedAt: Date.now(),
      providers: [
        {
          deviceId: 'dev-mac-1',
          displayName: 'K · Qwen3-ASR 1.7B',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
          isOwnDevice: true,
        },
        {
          deviceId: 'srv-asr-1',
          displayName: 'OpenAI Whisper',
          model: 'whisper-1',
          modelLabel: 'whisper-1',
          ready: true,
          busy: false,
          shareScope: 'server',
          providerKind: 'http_asr',
          isOwnDevice: false,
        },
      ],
    });

    const view = render(<VoiceOverlay open initialText="" onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect((await screen.findByTestId('voice-overlay-service-badge')).textContent).toBe('K · Qwen3-ASR 1.7B');

    // Emit ready then trigger live mid-session fallback -> updates immediately to Built-in model (Fallback)
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.emitOpen();
    const start1 = JSON.parse(ws1.sent[0]!) as { sessionId: string };
    ws1.emitMessage({ type: 'voice.session.ready', sessionId: start1.sessionId });
    ws1.emitMessage({ type: 'voice.session.error', sessionId: start1.sessionId, code: 'provider_offline' });

    await waitFor(() => {
      expect(screen.getByTestId('voice-overlay-service-badge').textContent).toBe('voice.engine_builtin (voice.service_fallback_tag)');
    });

    fireEvent.click(screen.getByLabelText('common.close'));
    await waitFor(() => expect(VoiceInput.isListening()).toBe(false));
    view.unmount();

    // 2. Relay HTTP ASR provider displays its configured service displayName
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'srv-asr-1',
      fetchedAt: Date.now(),
      providers: [
        {
          deviceId: 'srv-asr-1',
          displayName: 'OpenAI Whisper',
          model: 'whisper-1',
          modelLabel: 'whisper-1',
          ready: true,
          busy: false,
          shareScope: 'server',
          providerKind: 'http_asr',
          isOwnDevice: false,
        },
      ],
    });
    const startP = VoiceInput.startListening(vi.fn());
    expect(VoiceInput.getActiveVoiceService()).toEqual({ kind: 'remote_http_asr', label: 'OpenAI Whisper' });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emitOpen();
    const start2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };
    ws2.emitMessage({ type: 'voice.session.ready', sessionId: start2.sessionId });
    await expect(startP).resolves.toBe(true);
    await VoiceInput.stopListening({ abort: true });
    expect(VoiceInput.getActiveVoiceService()).toBeNull();
  });

  it('opens utterance #2 mic immediately while utterance #1 WS is still draining, isolates #1 transcript, and flushes #2 pre-roll on WS #2 ready', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
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

    const results1: Array<{ text: string; isFinal: boolean }> = [];
    const start1 = VoiceInput.startListening((t, f) => results1.push({ text: t, isFinal: f }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.emitOpen();
    const frame1 = JSON.parse(ws1.sent[0]!) as { sessionId: string };
    ws1.emitMessage({ type: 'voice.session.ready', sessionId: frame1.sessionId });
    await expect(start1).resolves.toBe(true);

    // Stop utterance #1: mic releases immediately, but ws1 deliberately stays open draining transcript.
    const stop1 = VoiceInput.stopListening();
    await waitFor(() => expect(audio.stopTrack).toHaveBeenCalledTimes(1));
    expect(ws1.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true);

    // Utterance #2 begins IMMEDIATELY while ws1 is still draining: local mic must open right away!
    const results2: Array<{ text: string; isFinal: boolean }> = [];
    const listening2: boolean[] = [];
    const levels2: number[] = [];
    VoiceInput.onAudioLevel((l) => levels2.push(l));

    const start2 = VoiceInput.startListening(
      (t, f) => results2.push({ text: t, isFinal: f }),
      (l) => listening2.push(l),
    );
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listening2).toEqual([true]));
    audio.emitSamples(new Float32Array(2_000).fill(0.3));
    expect(levels2.length).toBeGreaterThan(0);
    // Must not spawn concurrent WS #2 while WS #1 is still draining
    expect(FakeWebSocket.instances).toHaveLength(1);

    // Delayed final transcript on WS #1 must land ONLY in results1, never cross-talking into results2
    ws1.emitMessage({ type: 'voice.session.result', sessionId: frame1.sessionId, text: '第一句收尾', isFinal: true });
    ws1.emitMessage({ type: 'voice.session.end', sessionId: frame1.sessionId });
    await stop1;
    expect(results1).toEqual([{ text: '第一句收尾', isFinal: true }]);
    expect(results2).toEqual([]);

    // Now WS #2 connects and flushes the buffered pre-roll spoken while WS #1 was draining
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emitOpen();
    const frame2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };
    ws2.emitMessage({ type: 'voice.session.ready', sessionId: frame2.sessionId });
    await expect(start2).resolves.toBe(true);
    expect(ws2.sent.some((raw) => JSON.parse(raw).type === 'voice.session.audio')).toBe(true);

    ws2.emitMessage({ type: 'voice.session.result', sessionId: frame2.sessionId, text: '第二句不丢开头', isFinal: true });
    ws2.emitMessage({ type: 'voice.session.end', sessionId: frame2.sessionId });
    await VoiceInput.stopListening();
    expect(results2).toEqual([{ text: '第二句不丢开头', isFinal: true }]);
  });

  it('resolveRemoteVoiceRoute does not block on stale/busy cached primary and getUserMedia never blocks on hung enumerateDevices', async () => {
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      fetchedAt: Date.now() - 60_000,
      providers: [
        {
          deviceId: 'dev-mac-1',
          displayName: 'Mac Studio',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: true,
          shareScope: 'account',
          isOwnDevice: true,
        },
      ],
    });
    apiMocks.fetchRemoteVoiceProviders.mockImplementation(() => new Promise(() => {}));

    const route = await resolveRemoteVoiceRoute();
    expect(route).toMatchObject({ route: 'remote', targetDeviceId: 'dev-mac-1' });
    expect(apiMocks.fetchRemoteVoiceProviders).toHaveBeenCalledTimes(1);

    // Even if enumerateDevices never resolves, startRemoteVoiceSession & primeRemoteVoiceCapture call getUserMedia immediately
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: vi.fn(() => new Promise(() => {})),
    });

    expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(1));
    cancelRemoteVoiceCapturePrime();

    let handle: { stop: (abort?: boolean) => Promise<void> } | null = null;
    const sessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: () => {},
      onCaptureStarted: (h) => { handle = h; },
      getWsBaseUrl: () => 'https://relay.example',
    });
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(sessionP).resolves.toMatchObject({ ok: true });
    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await handle!.stop(false);
  });

  it('preserves early-released pre-roll PCM before WS ready, aborts cleanly on cancel, and avoids double permission prompts on denial', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
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
    expect(VoiceInput.needsPointerDownGesturePrime()).toBe(false);

    // 1. Hold -> capture starts immediately while ticket HTTP is still pending -> user releases BEFORE ticket/WS open
    let resolveTicket!: (res: { ticket: string }) => void;
    apiMocks.fetchRemoteVoiceWsTicket.mockImplementationOnce(
      () => new Promise<{ ticket: string }>((res) => { resolveTicket = res; }),
    );
    const results: Array<{ text: string; isFinal: boolean }> = [];
    const listening: boolean[] = [];
    const startP = VoiceInput.startListening(
      (t, f) => results.push({ text: t, isFinal: f }),
      (l) => listening.push(l),
    );
    await waitFor(() => expect(listening).toEqual([true]));
    audio.emitSamples(new Float32Array(2_000).fill(0.2));

    const stopSendP = VoiceInput.stopListening({ abort: false });
    await waitFor(() => expect(listening).toEqual([true, false]));
    await waitFor(() => expect(audio.stopTrack).toHaveBeenCalledTimes(1));

    // Ticket resolves AFTER release -> WS opens, flushes preserved pre-roll, drains transcript
    resolveTicket({ ticket: 'ticket-early-release' });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    await expect(startP).resolves.toBe(true);
    await waitFor(() => expect(ws.sent.some((raw) => JSON.parse(raw).type === 'voice.session.audio')).toBe(true));
    await waitFor(() => expect(ws.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true));
    ws.emitMessage({ type: 'voice.session.result', sessionId: startFrame.sessionId, text: '早松手完整发送', isFinal: true });
    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });
    await stopSendP;
    expect(results).toEqual([{ text: '早松手完整发送', isFinal: true }]);

    // 2. Abort before WS opens -> tears down mic cleanly, cancels ticket/WS, sends no text or audio
    apiMocks.fetchRemoteVoiceWsTicket.mockImplementationOnce(() => new Promise(() => {}));
    const abortListening: boolean[] = [];
    const abortResults: Array<{ text: string; isFinal: boolean }> = [];
    const startAbortP = VoiceInput.startListening(
      (t, f) => abortResults.push({ text: t, isFinal: f }),
      (l) => abortListening.push(l),
    );
    await waitFor(() => expect(abortListening).toEqual([true]));
    audio.emitSamples(new Float32Array(1_600).fill(0.25));
    await VoiceInput.stopListening({ abort: true });
    await expect(startAbortP).resolves.toBe(false);
    expect(audio.stopTrack).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(abortResults).toEqual([]);

    // 3. Permission denial in eager prime cleans up permission cache and avoids double-prompting getUserMedia
    audio.getUserMedia.mockClear();
    const deniedErr = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    audio.getUserMedia.mockRejectedValueOnce(deniedErr);
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    const errors: string[] = [];
    const deniedOk = await VoiceInput.startListening(vi.fn(), undefined, (e) => errors.push(e));
    expect(deniedOk).toBe(false);
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);
    expect(isRemoteMicPermissionKnownGranted()).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('adopts already-finished eager prime capture on early release while #1 drains without losing #2 PCM or leaking listening state', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
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

    // Utterance #1: open and speak, then release to send while WS #1 stays open draining.
    const r1: Array<{ text: string; isFinal: boolean }> = [];
    const l1: boolean[] = [];
    const start1P = VoiceInput.startListening((t, f) => r1.push({ text: t, isFinal: f }), (l) => l1.push(l));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.emitOpen();
    const s1 = JSON.parse(ws1.sent[0]!) as { sessionId: string };
    ws1.emitMessage({ type: 'voice.session.ready', sessionId: s1.sessionId });
    await expect(start1P).resolves.toBe(true);
    expect(l1).toEqual([true]);

    const stop1P = VoiceInput.stopListening({ abort: false });
    await waitFor(() => expect(l1).toEqual([true, false]));

    // Utterance #2 starts while #1 WS is still draining, buffers audio, and user releases #2 BEFORE #1 finishes draining.
    const r2: Array<{ text: string; isFinal: boolean }> = [];
    const l2: boolean[] = [];
    const start2P = VoiceInput.startListening((t, f) => r2.push({ text: t, isFinal: f }), (l) => l2.push(l));
    await waitFor(() => expect(l2).toEqual([true]));
    audio.emitSamples(new Float32Array(1_600).fill(0.3));
    const stop2P = VoiceInput.stopListening({ abort: false });
    await waitFor(() => expect(l2).toEqual([true, false]));

    // #1 finally drains and closes -> #2 must adopt its already-finished primed capture, open WS #2, upload PCM, send stop, and end idle.
    ws1.emitMessage({ type: 'voice.session.result', sessionId: s1.sessionId, text: '第一句', isFinal: true });
    ws1.emitMessage({ type: 'voice.session.end', sessionId: s1.sessionId });
    await stop1P;

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emitOpen();
    const s2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };
    ws2.emitMessage({ type: 'voice.session.ready', sessionId: s2.sessionId });
    await expect(start2P).resolves.toBe(true);
    await waitFor(() => expect(ws2.sent.some((raw) => JSON.parse(raw).type === 'voice.session.audio')).toBe(true));
    await waitFor(() => expect(ws2.sent.some((raw) => JSON.parse(raw).type === 'voice.session.stop')).toBe(true));
    ws2.emitMessage({ type: 'voice.session.result', sessionId: s2.sessionId, text: '第二句不丢失', isFinal: true });
    ws2.emitMessage({ type: 'voice.session.end', sessionId: s2.sessionId });
    await stop2P;

    expect(r1).toEqual([{ text: '第一句', isFinal: true }]);
    expect(r2).toEqual([{ text: '第二句不丢失', isFinal: true }]);
    expect(VoiceInput.isListening()).toBe(false);
  });

  it('queues utterance #3 behind #2 handoffPromise when #2 was released to send before #1 finished draining', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
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

    // Utterance #1 draining
    const r1: Array<{ text: string; isFinal: boolean }> = [];
    const start1P = VoiceInput.startListening((t, f) => r1.push({ text: t, isFinal: f }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.emitOpen();
    const s1 = JSON.parse(ws1.sent[0]!) as { sessionId: string };
    ws1.emitMessage({ type: 'voice.session.ready', sessionId: s1.sessionId });
    await expect(start1P).resolves.toBe(true);
    const stop1P = VoiceInput.stopListening({ abort: false });

    // Utterance #2 captured and released while #1 still draining
    const r2: Array<{ text: string; isFinal: boolean }> = [];
    const l2: boolean[] = [];
    const start2P = VoiceInput.startListening((t, f) => r2.push({ text: t, isFinal: f }), (l) => l2.push(l));
    await waitFor(() => expect(l2).toEqual([true]));
    audio.emitSamples(new Float32Array(1_600).fill(0.22));
    const stop2P = VoiceInput.stopListening({ abort: false });
    await waitFor(() => expect(l2).toEqual([true, false]));

    // User immediately starts utterance #3 BEFORE #1 drains -> must wait on #2 handoffPromise instead of aborting #2
    const r3: Array<{ text: string; isFinal: boolean }> = [];
    const l3: boolean[] = [];
    const start3P = VoiceInput.startListening((t, f) => r3.push({ text: t, isFinal: f }), (l) => l3.push(l));

    // Finish #1 -> #2 hands off and drains -> #3 begins capturing once #2 hands off
    ws1.emitMessage({ type: 'voice.session.result', sessionId: s1.sessionId, text: '第一句', isFinal: true });
    ws1.emitMessage({ type: 'voice.session.end', sessionId: s1.sessionId });
    await stop1P;

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const ws2 = FakeWebSocket.instances[1]!;
    ws2.emitOpen();
    const s2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };
    ws2.emitMessage({ type: 'voice.session.ready', sessionId: s2.sessionId });
    await expect(start2P).resolves.toBe(true);
    await waitFor(() => expect(ws2.sent.some((raw) => JSON.parse(raw).type === 'voice.session.audio')).toBe(true));

    // While #2 is still waiting on WS #2 transcript drain, #3 has already started local mic capture
    await waitFor(() => expect(l3).toEqual([true]));
    audio.emitSamples(new Float32Array(1_600).fill(0.28));

    ws2.emitMessage({ type: 'voice.session.result', sessionId: s2.sessionId, text: '第二句不覆盖', isFinal: true });
    ws2.emitMessage({ type: 'voice.session.end', sessionId: s2.sessionId });
    await stop2P;

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    const ws3 = FakeWebSocket.instances[2]!;
    ws3.emitOpen();
    const s3 = JSON.parse(ws3.sent[0]!) as { sessionId: string };
    ws3.emitMessage({ type: 'voice.session.ready', sessionId: s3.sessionId });
    await expect(start3P).resolves.toBe(true);
    const stop3P = VoiceInput.stopListening({ abort: false });
    await waitFor(() => expect(l3).toEqual([true, false]));
    ws3.emitMessage({ type: 'voice.session.result', sessionId: s3.sessionId, text: '第三句正常', isFinal: true });
    ws3.emitMessage({ type: 'voice.session.end', sessionId: s3.sessionId });
    await stop3P;

    expect(r1).toEqual([{ text: '第一句', isFinal: true }]);
    expect(r2).toEqual([{ text: '第二句不覆盖', isFinal: true }]);
    expect(r3).toEqual([{ text: '第三句正常', isFinal: true }]);
    expect(VoiceInput.isListening()).toBe(false);
  });

  it('resets listening HUD to false when eager remote capture falls back to local speech and local permission fails', async () => {
    setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
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
    // Force ticket failure so remote session triggers fallback to local speech after eager capture started.
    apiMocks.fetchRemoteVoiceWsTicket.mockRejectedValueOnce(new Error('provider_offline'));

    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    streamingBridge.available.mockResolvedValue({ available: true });
    streamingBridge.requestPermissions.mockResolvedValue({ speechRecognition: 'denied' });
    platformBridge.available.mockResolvedValue({ available: false });

    const listening: boolean[] = [];
    const errors: string[] = [];
    const ok = await VoiceInput.startListening(
      vi.fn(),
      (l) => listening.push(l),
      (err) => errors.push(err),
    );
    expect(ok).toBe(false);
    expect(listening).toEqual([true, false]);
    expect(VoiceInput.isListening()).toBe(false);
    expect(errors).toEqual(['permission_denied']);

    // Also verify Web Speech fallback permission/start failure (async onerror/onend and sync throw) cleans up eager listening HUD
    apiMocks.fetchRemoteVoiceWsTicket.mockRejectedValueOnce(new Error('provider_offline'));
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
    class AsyncFailingWebSpeechRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start(): void {
        queueMicrotask(() => {
          this.onerror?.({ error: 'not-allowed' });
          this.onend?.();
        });
      }
      stop(): void {}
      abort(): void {}
    }
    vi.stubGlobal('SpeechRecognition', AsyncFailingWebSpeechRecognition);
    vi.stubGlobal('webkitSpeechRecognition', undefined);

    const webListening: boolean[] = [];
    const webErrors: string[] = [];
    const webOk = await VoiceInput.startListening(
      vi.fn(),
      (l) => webListening.push(l),
      (err) => webErrors.push(err),
    );
    expect(webOk).toBe(true);
    await waitFor(() => expect(webListening).toEqual([true, false]));
    expect(VoiceInput.isListening()).toBe(false);
    expect(webErrors).toEqual(['permission_denied']);

    apiMocks.fetchRemoteVoiceWsTicket.mockRejectedValueOnce(new Error('provider_offline'));
    class SyncFailingWebSpeechRecognition {
      lang = '';
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      start(): void {
        throw new Error('Permission denied');
      }
      stop(): void {}
      abort(): void {}
    }
    vi.stubGlobal('SpeechRecognition', SyncFailingWebSpeechRecognition);

    const syncWebListening: boolean[] = [];
    const syncWebErrors: string[] = [];
    const syncWebOk = await VoiceInput.startListening(
      vi.fn(),
      (l) => syncWebListening.push(l),
      (err) => syncWebErrors.push(err),
    );
    expect(syncWebOk).toBe(false);
    expect(syncWebListening).toEqual([true, false]);
    expect(VoiceInput.isListening()).toBe(false);
    expect(syncWebErrors).toEqual(['permission_denied']);
  });

  it('preserves primed and bounded fallback PCM across pre-ready/mid-session/post-stop failures and clears after transcript or abort', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });

    // 1. drainRemoteVoiceCapturePrimePcm returns captured PCM in order without losing pre-fallback speech.
    expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(1));
    audio.emitSamples(new Float32Array([0.1, -0.1, 0.2, -0.2]));
    const drained = await drainRemoteVoiceCapturePrimePcm();
    expect(Array.from(drained).length).toBeGreaterThanOrEqual(4);
    expect(Array.from(drained).slice(0, 4)).toEqual([3277, -3277, 6553, -6554]);
    expect(await drainRemoteVoiceCapturePrimePcm()).toHaveLength(0);

    // 2. Pre-ready ticket failure returns bufferedPcm containing [primed] + [pre-ready] samples.
    expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(2));
    audio.emitSamples(new Float32Array([0.25, -0.25]));
    const ticketDeferred = new Promise<{ ticket: string }>((_res, rej) => {
      setTimeout(() => rej(new Error('ws_ticket_failed')), 20);
    });
    const preReadyRes = await startRemoteVoiceSession({
      targetDeviceId: 'pc-1',
      onResult: () => {},
      fetchTicket: () => ticketDeferred,
      getWsBaseUrl: () => 'https://relay.example',
      createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    expect(preReadyRes.ok).toBe(false);
    if (!preReadyRes.ok) {
      expect(preReadyRes.bufferedPcm).toBeDefined();
      expect(Array.from(preReadyRes.bufferedPcm!).slice(0, 2)).toEqual([8192, -8192]);
    }

    // 3. Post-ready fallback preserves 30s-capped PCM even after voice.session.audio flushed, AND works on stoppedByCaller=true.
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValue({ ticket: 't-post-stop' });
    let handle: { stop: (abort?: boolean) => Promise<void> } | null = null;
    let fallbackReason = '';
    let fallbackInfo: { bufferedPcm?: Int16Array; stoppedByCaller?: boolean } | undefined;
    const sessionP = startRemoteVoiceSession({
      targetDeviceId: 'pc-1',
      onResult: () => {},
      onCaptureStarted: (h) => { handle = h; },
      onFallback: (reason, info) => {
        fallbackReason = reason;
        fallbackInfo = info;
      },
      getWsBaseUrl: () => 'https://relay.example',
      createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws1 = FakeWebSocket.instances[0]!;
    ws1.emitOpen();
    const s1 = JSON.parse(ws1.sent[0]!) as { sessionId: string };
    ws1.emitMessage({ type: 'voice.session.ready', sessionId: s1.sessionId });
    await expect(sessionP).resolves.toMatchObject({ ok: true });

    // Emit >30s total samples (500k samples): first 20k should trim out leaving 480k cap ending with latest marker!
    const largeChunk = new Float32Array(250_000).fill(0.05);
    largeChunk[0] = 0.9;
    audio.emitSamples(largeChunk);
    const secondChunk = new Float32Array(250_000).fill(-0.05);
    secondChunk[secondChunk.length - 1] = 0.5;
    audio.emitSamples(secondChunk);

    const stopP = handle!.stop(false);
    await waitFor(() => expect(ws1.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
    ws1.emitMessage({ type: 'voice.session.error', sessionId: s1.sessionId, code: 'helper_error' });
    await stopP;

    expect(fallbackReason).toBe('helper_error');
    expect(fallbackInfo?.stoppedByCaller).toBe(true);
    expect(fallbackInfo?.bufferedPcm?.length).toBe(480_000);
    expect(fallbackInfo?.bufferedPcm?.[479_999]).toBe(16384);

    // 4. Transcript delivered -> clears fallback buffer and triggers onError instead of onFallback on subsequent failure.
    FakeWebSocket.instances.length = 0;
    const onFallbackAfterTx = vi.fn();
    const onErrorAfterTx = vi.fn();
    const session2P = startRemoteVoiceSession({
      targetDeviceId: 'pc-1',
      onResult: () => {},
      onFallback: onFallbackAfterTx,
      onError: onErrorAfterTx,
      getWsBaseUrl: () => 'https://relay.example',
      createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws2 = FakeWebSocket.instances[0]!;
    ws2.emitOpen();
    const s2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };
    ws2.emitMessage({ type: 'voice.session.ready', sessionId: s2.sessionId });
    await expect(session2P).resolves.toMatchObject({ ok: true });
    audio.emitSamples(new Float32Array(1_600).fill(0.2));
    ws2.emitMessage({ type: 'voice.session.result', sessionId: s2.sessionId, text: '已出字', isFinal: false });
    ws2.emitMessage({ type: 'voice.session.error', sessionId: s2.sessionId, code: 'provider_offline' });
    expect(onFallbackAfterTx).not.toHaveBeenCalled();
    expect(onErrorAfterTx).toHaveBeenCalledWith('provider_offline');

    // 5. Explicit abort cancels without invoking onFallback.
    FakeWebSocket.instances.length = 0;
    let h3: { stop: (abort?: boolean) => Promise<void> } | null = null;
    const onFallbackAbort = vi.fn();
    const session3P = startRemoteVoiceSession({
      targetDeviceId: 'pc-1',
      onResult: () => {},
      onCaptureStarted: (h) => { h3 = h; },
      onFallback: onFallbackAbort,
      getWsBaseUrl: () => 'https://relay.example',
      createSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws3 = FakeWebSocket.instances[0]!;
    ws3.emitOpen();
    const s3 = JSON.parse(ws3.sent[0]!) as { sessionId: string };
    ws3.emitMessage({ type: 'voice.session.ready', sessionId: s3.sessionId });
    await expect(session3P).resolves.toMatchObject({ ok: true });
    audio.emitSamples(new Float32Array(1_600).fill(0.2));
    await h3!.stop(true);
    expect(onFallbackAbort).not.toHaveBeenCalled();
  });

  it('forwards preserved PCM on route/pre-ready/mid-session/post-stop fallbacks across mobile Qwen3, old shell, system engine, and PC App', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    const transcribePcm = vi.fn(async (_opts: { pcmBase64: string; language?: string }) => ({ text: '离线兜底识别结果' }));

    const setupMobileCaps = (withTranscribePcm: boolean) => {
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'ios',
        isNativePlatform: () => true,
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [
          {
            name: 'StreamingSpeech',
            methods: [
              { name: 'available', rtype: 'promise' },
              { name: 'checkPermissions', rtype: 'promise' },
              { name: 'requestPermissions', rtype: 'promise' },
              { name: 'start', rtype: 'promise' },
              { name: 'stop', rtype: 'promise' },
              ...(withTranscribePcm ? [{ name: 'transcribePcm', rtype: 'promise' }] : []),
            ],
          },
        ],
      });
      streamingBridge.available.mockResolvedValue({ available: true });
      streamingBridge.checkPermissions.mockResolvedValue({ speechRecognition: 'granted' });
      streamingBridge.requestPermissions.mockResolvedValue({ speechRecognition: 'granted' });
      streamingBridge.start.mockResolvedValue({});
      streamingBridge.stop.mockResolvedValue(undefined);
      if (withTranscribePcm) {
        (streamingBridge as Record<string, unknown>).transcribePcm = transcribePcm;
      } else {
        delete (streamingBridge as Record<string, unknown>).transcribePcm;
      }
    };

    try {
      // Case A: route local_fallback preserves eager pre-roll PCM into StreamingSpeech.start({ initialPcmBase64 })
      setupMobileCaps(true);
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: 0,
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      let routeStartResolve!: () => void;
      apiMocks.fetchRemoteVoiceProviders.mockImplementationOnce(() => new Promise((res) => {
        routeStartResolve = () => res({
          primaryDeviceId: 'dev-mac-1',
          canManageServerSharing: false,
          canShareOwnProviderToServer: false,
          providers: [
            { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: false, busy: false, shareScope: 'account', isOwnDevice: true },
          ],
        });
      }));
      const lRoute: boolean[] = [];
      const routeStartP = VoiceInput.startListening(vi.fn(), (l) => lRoute.push(l));
      await waitFor(() => expect(lRoute).toEqual([true]));
      audio.emitSamples(new Float32Array([0.2, -0.2, 0.3, -0.3]));
      routeStartResolve();
      await expect(routeStartP).resolves.toBe(true);
      expect(streamingBridge.start).toHaveBeenCalledTimes(1);
      const startOptsA = streamingBridge.start.mock.calls[0]?.[0] as { initialPcmBase64?: string };
      expect(startOptsA?.initialPcmBase64).toBeTruthy();
      expect(Array.from(decodeBase64ToInt16Pcm(startOptsA!.initialPcmBase64!)).slice(0, 4)).toEqual([6553, -6554, 9830, -9830]);
      await VoiceInput.stopListening({ abort: true });

      // Case B: mid-session onFallback keeps hold-to-talk listening=true and passes initialPcmBase64
      streamingBridge.start.mockClear();
      FakeWebSocket.instances.length = 0;
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: Date.now(),
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-mid' });
      const lMid: boolean[] = [];
      const midStartP = VoiceInput.startListening(vi.fn(), (l) => lMid.push(l));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsMid = FakeWebSocket.instances[0]!;
      wsMid.emitOpen();
      const sMid = JSON.parse(wsMid.sent[0]!) as { sessionId: string };
      wsMid.emitMessage({ type: 'voice.session.ready', sessionId: sMid.sessionId });
      await expect(midStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.125, -0.125]));
      wsMid.emitMessage({ type: 'voice.session.error', sessionId: sMid.sessionId, code: 'helper_error' });
      await waitFor(() => expect(streamingBridge.start).toHaveBeenCalledTimes(1));
      expect(lMid).toEqual([true]); // Never flashed false during mid-session fallback!
      const startOptsB = streamingBridge.start.mock.calls[0]?.[0] as { initialPcmBase64?: string };
      expect(startOptsB?.initialPcmBase64).toBeTruthy();
      expect(Array.from(decodeBase64ToInt16Pcm(startOptsB!.initialPcmBase64!)).slice(0, 2)).toEqual([4096, -4096]);
      await VoiceInput.stopListening({ abort: true });

      // Case C: post-stop fallback before transcript uses mobile transcribePcm without calling start()
      streamingBridge.start.mockClear();
      transcribePcm.mockClear();
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-fin-mob' });
      const rFin: Array<{ text: string; isFinal: boolean }> = [];
      const finStartP = VoiceInput.startListening((t, f) => rFin.push({ text: t, isFinal: f }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsFin = FakeWebSocket.instances[0]!;
      wsFin.emitOpen();
      const sFin = JSON.parse(wsFin.sent[0]!) as { sessionId: string };
      wsFin.emitMessage({ type: 'voice.session.ready', sessionId: sFin.sessionId });
      await expect(finStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.25, -0.25]));
      const stopFinP = VoiceInput.stopListening({ abort: false });
      await waitFor(() => expect(wsFin.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
      wsFin.emitMessage({ type: 'voice.session.error', sessionId: sFin.sessionId, code: 'helper_error' });
      await stopFinP;
      expect(streamingBridge.start).not.toHaveBeenCalled();
      expect(transcribePcm).toHaveBeenCalledTimes(1);
      expect(rFin).toEqual([{ text: '离线兜底识别结果', isFinal: true }]);

      // Case D: older mobile shell without transcribePcm in PluginHeaders never invokes transcribePcm and never hangs stopListening
      setupMobileCaps(false);
      transcribePcm.mockClear();
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-old-shell' });
      const oldStartP = VoiceInput.startListening(vi.fn());
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsOld = FakeWebSocket.instances[0]!;
      wsOld.emitOpen();
      const sOld = JSON.parse(wsOld.sent[0]!) as { sessionId: string };
      wsOld.emitMessage({ type: 'voice.session.ready', sessionId: sOld.sessionId });
      await expect(oldStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.25, -0.25]));
      const stopOldP = VoiceInput.stopListening({ abort: false });
      await waitFor(() => expect(wsOld.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
      wsOld.emitMessage({ type: 'voice.session.error', sessionId: sOld.sessionId, code: 'helper_error' });
      await expect(stopOldP).resolves.toBeUndefined();
      expect(transcribePcm).not.toHaveBeenCalled();

      // Case E: PC App post-stop fallback routes via startListening({ initialPcmBase64, finalizeOnly: true })
      const pcEvents: Set<(ev: any) => void> = new Set();
      const pcStartListening = vi.fn(async () => {
        queueMicrotask(() => {
          for (const cb of pcEvents) {
            cb({ type: 'start' });
            cb({ type: 'result', text: 'PC 本地兜底结果', isFinal: true });
            cb({ type: 'end' });
          }
        });
        return { ok: true };
      });
      vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
      (globalThis as any).__IMCODES_PC_APP__ = {
        isElectron: true,
        voice: {
          isNativeSpeechSupported: () => true,
          supportsPcmFinalize: true,
          getPermissions: async () => ({ mic: 'granted', speech: 'granted', speechAvailable: true }),
          requestPermissions: async () => ({ mic: 'granted', speech: 'granted', speechAvailable: true }),
          startListening: pcStartListening,
          stopListening: vi.fn(async () => {}),
          subscribe: (cb: (ev: any) => void) => {
            pcEvents.add(cb);
            return () => pcEvents.delete(cb);
          },
        },
      };
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-pc-fin' });
      const rPc: Array<{ text: string; isFinal: boolean }> = [];
      const pcStartP = VoiceInput.startListening((t, f) => rPc.push({ text: t, isFinal: f }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsPc = FakeWebSocket.instances[0]!;
      wsPc.emitOpen();
      const sPc = JSON.parse(wsPc.sent[0]!) as { sessionId: string };
      wsPc.emitMessage({ type: 'voice.session.ready', sessionId: sPc.sessionId });
      await expect(pcStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.1, -0.1]));
      const stopPcP = VoiceInput.stopListening({ abort: false });
      await waitFor(() => expect(wsPc.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
      wsPc.emitMessage({ type: 'voice.session.error', sessionId: sPc.sessionId, code: 'helper_error' });
      await stopPcP;
      expect(pcStartListening).toHaveBeenCalledWith(expect.objectContaining({ finalizeOnly: true, initialPcmBase64: expect.any(String) }));
      expect(rPc).toEqual([{ text: 'PC 本地兜底结果', isFinal: true }]);
    } finally {
      delete (streamingBridge as Record<string, unknown>).transcribePcm;
      delete (globalThis as any).__IMCODES_PC_APP__;
      VoiceInput.setVoiceRecognitionEngine('builtin');
      await VoiceInput.stopListening({ abort: true });
    }
  });

  it('preserves speech across delayed route, pre-ready errors, repeated stop during native prime drain, tail rawPcmChunk drain, and old/system PC bridges', async () => {
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    const transcribePcm = vi.fn(async (opts: { pcmBase64: string; language?: string }) => {
      const pcm = decodeBase64ToInt16Pcm(opts.pcmBase64);
      return { text: `pcm:${pcm.length}:${pcm[0] ?? 0}:${pcm[pcm.length - 1] ?? 0}` };
    });

    const installMobileShell = () => {
      vi.stubGlobal('Capacitor', {
        getPlatform: () => 'ios',
        isNativePlatform: () => true,
        isPluginAvailable: (name: string) => name === 'StreamingSpeech',
        PluginHeaders: [
          {
            name: 'StreamingSpeech',
            methods: [
              { name: 'available', rtype: 'promise' },
              { name: 'checkPermissions', rtype: 'promise' },
              { name: 'requestPermissions', rtype: 'promise' },
              { name: 'start', rtype: 'promise' },
              { name: 'stop', rtype: 'promise' },
              { name: 'transcribePcm', rtype: 'promise' },
              { name: 'startRawPcmCapture', rtype: 'promise' },
              { name: 'stopRawPcmCapture', rtype: 'promise' },
            ],
          },
        ],
      });
      streamingBridge.available.mockResolvedValue({ available: true });
      streamingBridge.checkPermissions.mockResolvedValue({ speechRecognition: 'granted' });
      streamingBridge.requestPermissions.mockResolvedValue({ speechRecognition: 'granted' });
      streamingBridge.start.mockResolvedValue({});
      streamingBridge.stop.mockResolvedValue(undefined);
      (streamingBridge as Record<string, unknown>).transcribePcm = transcribePcm;
    };

    try {
      // 1A. P0-1a (route unresolved -> release -> remote WS pre-ready error): must invoke transcribePcm ONCE.
      installMobileShell();
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: 0,
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: false, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      let resolveDelayedRoute!: () => void;
      apiMocks.fetchRemoteVoiceProviders.mockImplementationOnce(() => new Promise((res) => {
        resolveDelayedRoute = () => res({
          primaryDeviceId: 'dev-mac-1',
          canManageServerSharing: false,
          canShareOwnProviderToServer: false,
          providers: [
            { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
          ],
        });
      }));
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-pre-ready-err' });
      const resultsPreReady: Array<{ text: string; isFinal: boolean }> = [];
      const startPreP = VoiceInput.startListening((t, f) => resultsPreReady.push({ text: t, isFinal: f }));
      await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(1));
      audio.emitSamples(new Float32Array([0.5, -0.5]));
      // User releases button normally BEFORE route resolves or WS reaches ready!
      const stopPreP = VoiceInput.stopListening({ abort: false });
      resolveDelayedRoute();
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsPre = FakeWebSocket.instances[0]!;
      wsPre.emitOpen();
      const sPre = JSON.parse(wsPre.sent[0]!) as { sessionId: string };
      wsPre.emitMessage({ type: 'voice.session.error', sessionId: sPre.sessionId, code: 'helper_error' });
      await expect(startPreP).resolves.toBe(false);
      await expect(stopPreP).resolves.toBeUndefined();
      expect(streamingBridge.start).not.toHaveBeenCalled();
      expect(transcribePcm).toHaveBeenCalledTimes(1);
      expect(resultsPreReady).toHaveLength(1);
      expect(resultsPreReady[0]!.isFinal).toBe(true);
      expect(resultsPreReady[0]!.text).toContain('16384:-16384');

      // 1B. P0-1a (captureStarted already fired while WS awaiting ready -> user releases -> pre-ready voice.session.error):
      // Must ALSO invoke transcribePcm ONCE without opening live local mic!
      FakeWebSocket.instances.length = 0;
      transcribePcm.mockClear();
      streamingBridge.start.mockClear();
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: Date.now(),
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-capture-started-pre-ready-err' });
      const resultsCapStarted: Array<{ text: string; isFinal: boolean }> = [];
      const startCapP = VoiceInput.startListening((t, f) => resultsCapStarted.push({ text: t, isFinal: f }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsCap = FakeWebSocket.instances[0]!;
      wsCap.emitOpen();
      audio.emitSamples(new Float32Array([0.375, -0.375]));
      // User releases BEFORE voice.session.ready (after onCaptureStarted already promoted _activeRemoteSession)
      const stopCapP = VoiceInput.stopListening({ abort: false });
      const sCap = JSON.parse(wsCap.sent[0]!) as { sessionId: string };
      wsCap.emitMessage({ type: 'voice.session.error', sessionId: sCap.sessionId, code: 'helper_error' });
      await expect(startCapP).resolves.toBe(false);
      await expect(stopCapP).resolves.toBeUndefined();
      expect(streamingBridge.start).not.toHaveBeenCalled();
      expect(transcribePcm).toHaveBeenCalledTimes(1);
      expect(resultsCapStarted).toHaveLength(1);
      expect(resultsCapStarted[0]!.text).toContain('12288:-12288');

      // 2. P0-1b & P0-2: Native rawPcmCapture with deferred stopRawPcmCapture emitting final tail chunk + repeated stopListening({ abort: false }) during drain.
      FakeWebSocket.instances.length = 0;
      transcribePcm.mockClear();
      streamingBridge.start.mockClear();
      let resolveNativeStop!: () => void;
      const tailChunk = new Int16Array([777, -888]);
      const startRawPcmCapture = vi.fn(async () => {});
      const stopRawPcmCapture = vi.fn(() => new Promise<void>((res) => {
        resolveNativeStop = () => {
          streamingBridge.listeners.rawPcmChunk?.({
            pcmBase64: encodeInt16PcmToBase64(tailChunk),
            level: 0.3,
          });
          res();
        };
      }));
      streamingBridge.addListener.mockImplementation(async (name: string, fn: (data: unknown) => void) => {
        streamingBridge.listeners[name] = fn;
        return { remove: vi.fn(async () => {}) };
      });
      Object.assign(streamingBridge, { startRawPcmCapture, stopRawPcmCapture });

      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: 0,
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: false, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      let resolveRouteLocal!: () => void;
      apiMocks.fetchRemoteVoiceProviders.mockImplementationOnce(() => new Promise((res) => {
        resolveRouteLocal = () => res({
          primaryDeviceId: 'dev-mac-1',
          canManageServerSharing: false,
          canShareOwnProviderToServer: false,
          providers: [
            { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: false, busy: false, shareScope: 'account', isOwnDevice: true },
          ],
        });
      }));
      const resultsSlowDrain: Array<{ text: string; isFinal: boolean }> = [];
      const slowStartP = VoiceInput.startListening((t, f) => resultsSlowDrain.push({ text: t, isFinal: f }));
      await waitFor(() => expect(startRawPcmCapture).toHaveBeenCalledTimes(1));
      streamingBridge.listeners.rawPcmChunk?.({
        pcmBase64: encodeInt16PcmToBase64(new Int16Array([111, -111])),
        level: 0.2,
      });
      // Release normally, AND trigger a duplicate normal stopListening({ abort: false }) while stopRawPcmCapture is still pending.
      const stop1P = VoiceInput.stopListening({ abort: false });
      const stop2P = VoiceInput.stopListening({ abort: false });
      resolveRouteLocal();
      await waitFor(() => expect(stopRawPcmCapture).toHaveBeenCalledTimes(1));
      resolveNativeStop();
      await expect(slowStartP).resolves.toBe(false);
      await Promise.all([stop1P, stop2P]);
      expect(streamingBridge.start).not.toHaveBeenCalled();
      expect(transcribePcm).toHaveBeenCalledTimes(1);
      // Tail chunk emitted inside stopRawPcmCapture MUST be present alongside pre-stop chunk!
      expect(resultsSlowDrain).toEqual([{ text: 'pcm:4:111:-888', isFinal: true }]);

      // 3. P0-2 mid-session ws.close fallback also drains tail rawPcmChunk emitted inside stopRawPcmCapture.
      FakeWebSocket.instances.length = 0;
      transcribePcm.mockClear();
      streamingBridge.start.mockClear();
      const midTail = new Int16Array([999, -999]);
      (streamingBridge as Record<string, unknown>).stopRawPcmCapture = vi.fn(async () => {
        streamingBridge.listeners.rawPcmChunk?.({
          pcmBase64: encodeInt16PcmToBase64(midTail),
          level: 0.25,
        });
      });
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: Date.now(),
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-mid-tail' });
      const midTailStartP = VoiceInput.startListening(vi.fn());
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsMidTail = FakeWebSocket.instances[0]!;
      wsMidTail.emitOpen();
      const sMidTail = JSON.parse(wsMidTail.sent[0]!) as { sessionId: string };
      wsMidTail.emitMessage({ type: 'voice.session.ready', sessionId: sMidTail.sessionId });
      await expect(midTailStartP).resolves.toBe(true);
      streamingBridge.listeners.rawPcmChunk?.({
        pcmBase64: encodeInt16PcmToBase64(new Int16Array([222, -222])),
        level: 0.2,
      });
      wsMidTail.close(1006, 'drop');
      await waitFor(() => expect(streamingBridge.start).toHaveBeenCalledTimes(1));
      const midPcm = decodeBase64ToInt16Pcm((streamingBridge.start.mock.calls[0]?.[0] as { initialPcmBase64: string }).initialPcmBase64);
      expect(Array.from(midPcm)).toEqual([222, -222, 999, -999]);
      await VoiceInput.stopListening({ abort: true });

      // 4. P0-1 abort while native prime drain is pending must NOT run local transcription.
      transcribePcm.mockClear();
      let resolveAbortDrain!: () => void;
      (streamingBridge as Record<string, unknown>).startRawPcmCapture = vi.fn(async () => {});
      (streamingBridge as Record<string, unknown>).stopRawPcmCapture = vi.fn(() => new Promise<void>((res) => {
        resolveAbortDrain = () => {
          streamingBridge.listeners.rawPcmChunk?.({
            pcmBase64: encodeInt16PcmToBase64(new Int16Array([333, -333])),
            level: 0.2,
          });
          res();
        };
      }));
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: 0,
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: false, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      apiMocks.fetchRemoteVoiceProviders.mockResolvedValueOnce({
        primaryDeviceId: 'dev-mac-1',
        canManageServerSharing: false,
        canShareOwnProviderToServer: false,
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: false, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      const abortStartP = VoiceInput.startListening(vi.fn());
      await waitFor(() => expect((streamingBridge as any).startRawPcmCapture).toHaveBeenCalledTimes(1));
      const abortStopP = VoiceInput.stopListening({ abort: true });
      await waitFor(() => expect((streamingBridge as any).stopRawPcmCapture).toHaveBeenCalledTimes(1));
      resolveAbortDrain();
      await abortStartP;
      await abortStopP;
      expect(transcribePcm).not.toHaveBeenCalled();

      // 5. P0-3: Old PC App bridge without supportsPcmFinalize/finalizePcmListening NEVER calls startListening/requestPermissions on post-stop fallback;
      // and new PC App bridge uses finalizePcmListening directly (except 'system' speech model).
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      vi.stubGlobal('Capacitor', { isNativePlatform: () => false });
      const oldPcStart = vi.fn(async () => ({ ok: true }));
      const oldPcReqPerm = vi.fn(async () => ({ mic: 'granted', speech: 'granted', speechAvailable: true }));
      (globalThis as any).__IMCODES_PC_APP__ = {
        isElectron: true,
        voice: {
          isNativeSpeechSupported: () => true,
          getPermissions: async () => ({ mic: 'granted', speech: 'granted', speechAvailable: true }),
          requestPermissions: oldPcReqPerm,
          startListening: oldPcStart,
          stopListening: vi.fn(async () => {}),
          subscribe: () => () => {},
        },
      };
      FakeWebSocket.instances.length = 0;
      resetRemoteVoiceClientForTesting({
        primaryDeviceId: 'dev-mac-1',
        fetchedAt: Date.now(),
        providers: [
          { deviceId: 'dev-mac-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
        ],
      });
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-old-pc' });
      const oldPcStartP = VoiceInput.startListening(vi.fn());
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsOldPc = FakeWebSocket.instances[0]!;
      wsOldPc.emitOpen();
      const sOldPc = JSON.parse(wsOldPc.sent[0]!) as { sessionId: string };
      wsOldPc.emitMessage({ type: 'voice.session.ready', sessionId: sOldPc.sessionId });
      await expect(oldPcStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.2, -0.2]));
      const oldPcStopP = VoiceInput.stopListening({ abort: false });
      await waitFor(() => expect(wsOldPc.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
      wsOldPc.emitMessage({ type: 'voice.session.error', sessionId: sOldPc.sessionId, code: 'helper_error' });
      await expect(oldPcStopP).resolves.toBeUndefined();
      expect(oldPcStart).not.toHaveBeenCalled();
      expect(oldPcReqPerm).not.toHaveBeenCalled();

      // New PC App bridge: prefers finalizePcmListening over startListening, and skips when PC speech model is 'system'.
      let pcModelChoice: 'qwen3-0.6b' | 'system' = 'qwen3-0.6b';
      const newPcEvents = new Set<(ev: any) => void>();
      const newPcStart = vi.fn(async () => ({ ok: true }));
      const newPcFinalize = vi.fn(async () => {
        queueMicrotask(() => {
          for (const cb of newPcEvents) {
            cb({ type: 'start' });
            cb({ type: 'result', text: 'PC finalizePcmListening result', isFinal: true });
            cb({ type: 'end' });
          }
        });
        return { ok: true };
      });
      (globalThis as any).__IMCODES_PC_APP__ = {
        isElectron: true,
        voice: {
          isNativeSpeechSupported: () => true,
          supportsPcmFinalize: true,
          getSpeechModel: async () => pcModelChoice,
          getPermissions: async () => ({ mic: 'granted', speech: 'granted', speechAvailable: true }),
          requestPermissions: oldPcReqPerm,
          startListening: newPcStart,
          finalizePcmListening: newPcFinalize,
          stopListening: vi.fn(async () => {}),
          subscribe: (cb: (ev: any) => void) => {
            newPcEvents.add(cb);
            return () => newPcEvents.delete(cb);
          },
        },
      };
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-new-pc' });
      const newPcRes: Array<{ text: string; isFinal: boolean }> = [];
      const newPcStartP = VoiceInput.startListening((t, f) => newPcRes.push({ text: t, isFinal: f }));
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsNewPc = FakeWebSocket.instances[0]!;
      wsNewPc.emitOpen();
      const sNewPc = JSON.parse(wsNewPc.sent[0]!) as { sessionId: string };
      wsNewPc.emitMessage({ type: 'voice.session.ready', sessionId: sNewPc.sessionId });
      await expect(newPcStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.3, -0.3]));
      const newPcStopP = VoiceInput.stopListening({ abort: false });
      await waitFor(() => expect(wsNewPc.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
      wsNewPc.emitMessage({ type: 'voice.session.error', sessionId: sNewPc.sessionId, code: 'helper_error' });
      await newPcStopP;
      expect(newPcFinalize).toHaveBeenCalledTimes(1);
      expect(newPcStart).not.toHaveBeenCalled();
      expect(newPcRes).toEqual([{ text: 'PC finalizePcmListening result', isFinal: true }]);

      // 'system' model never enters offline PCM finalize path on PC App.
      newPcFinalize.mockClear();
      pcModelChoice = 'system';
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-sys-skip' });
      const sysStartP = VoiceInput.startListening(vi.fn());
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsSys = FakeWebSocket.instances[0]!;
      wsSys.emitOpen();
      const sSys = JSON.parse(wsSys.sent[0]!) as { sessionId: string };
      wsSys.emitMessage({ type: 'voice.session.ready', sessionId: sSys.sessionId });
      await expect(sysStartP).resolves.toBe(true);
      audio.emitSamples(new Float32Array([0.3, -0.3]));
      const sysStopP = VoiceInput.stopListening({ abort: false });
      await waitFor(() => expect(wsSys.sent.some((s) => JSON.parse(s).type === 'voice.session.stop')).toBe(true));
      wsSys.emitMessage({ type: 'voice.session.error', sessionId: sSys.sessionId, code: 'helper_error' });
      await expect(sysStopP).resolves.toBeUndefined();
      expect(newPcFinalize).not.toHaveBeenCalled();
      expect(newPcStart).not.toHaveBeenCalled();
    } finally {
      delete (streamingBridge as Record<string, unknown>).transcribePcm;
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      delete (globalThis as any).__IMCODES_PC_APP__;
      VoiceInput.setVoiceRecognitionEngine('builtin');
      await VoiceInput.stopListening({ abort: true });
    }
  });

  it('locks terminal failure across native drain against late voice.session.ready, late result, and async prime startup', async () => {
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-1',
      fetchedAt: Date.now(),
      providers: [
        { deviceId: 'dev-1', displayName: 'Mac Studio', model: 'qwen3-1.7b', modelLabel: 'Qwen3-ASR 1.7B', ready: true, busy: false, shareScope: 'account', isOwnDevice: true },
      ],
    });
    const listeners = new Map<string, Array<(ev: any) => void>>();
    let resolveStop!: () => void;
    let resolveStart!: () => void;
    let deferredStart = false;
    const prevAddListener = streamingBridge.addListener.getMockImplementation();
    const stopRawPcmCapture = vi.fn(() => new Promise<void>((res) => { resolveStop = res; }));
    const startRawPcmCapture = vi.fn(() => {
      if (!deferredStart) return Promise.resolve();
      return new Promise<void>((res) => { resolveStart = res; });
    });
    streamingBridge.addListener.mockImplementation(async (eventName: string, cb: (ev: any) => void) => {
      const list = listeners.get(eventName) ?? [];
      list.push(cb);
      listeners.set(eventName, list);
      return {
        remove: vi.fn(async () => {
          const cur = listeners.get(eventName) ?? [];
          listeners.set(eventName, cur.filter((x) => x !== cb));
        }),
      };
    });
    Object.assign(streamingBridge, { startRawPcmCapture, stopRawPcmCapture });
    const emitChunk = (samples: number[]) => {
      const pcmBase64 = encodeInt16PcmToBase64(Int16Array.from(samples));
      for (const cb of [...(listeners.get('rawPcmChunk') ?? [])]) {
        cb({ pcmBase64, level: 0.4 });
      }
    };
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });

    try {
      // A: Auditor's exact P0-1 repro: readyTimeoutMs=100 fires and sends abort; while native stopRawPcmCapture
      // is still pending, a late voice.session.ready arrives, followed by a tail [777, -888] chunk before resolveStop().
      // Expected: { ok: false, reason: 'ready_timeout', bufferedPcm: Int16Array([111, -111, 777, -888]) } (NOT { ok: true }).
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-late-ready' });
      expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
      await waitFor(() => expect(startRawPcmCapture).toHaveBeenCalledTimes(1));
      emitChunk([111, -111]);

      const sessionP = startRemoteVoiceSession({
        targetDeviceId: 'dev-1',
        readyTimeoutMs: 100,
        onResult: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback: vi.fn(),
      });
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.emitOpen();
      const s1 = JSON.parse(ws1.sent[0]!) as { sessionId: string };

      await waitFor(() => expect(ws1.sent.some((raw) => JSON.parse(raw).type === 'voice.session.abort')).toBe(true));
      expect(stopRawPcmCapture).toHaveBeenCalledTimes(1);

      // Late ready arrives DURING native drain -> must be ignored because termination was already locked.
      ws1.emitMessage({ type: 'voice.session.ready', sessionId: s1.sessionId });
      emitChunk([777, -888]);
      resolveStop();

      const res1 = await sessionP;
      expect(res1.ok).toBe(false);
      if (!res1.ok) {
        expect(res1.reason).toBe('ready_timeout');
        expect(Array.from(res1.bufferedPcm ?? [])).toEqual([111, -111, 777, -888]);
      }

      // B: Async native startRawPcmCapture() inside prime where voice.session.error arrives BEFORE start resolves.
      // Must preserve pre-error & drain-tail chunks without setupFailed clearing prime.pcmQueue prematurely.
      listeners.clear();
      startRawPcmCapture.mockClear();
      stopRawPcmCapture.mockClear();
      deferredStart = true;
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-async-prime' });
      expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
      await waitFor(() => expect(startRawPcmCapture).toHaveBeenCalledTimes(1));

      const asyncPrimeP = startRemoteVoiceSession({
        targetDeviceId: 'dev-1',
        readyTimeoutMs: 2000,
        onResult: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback: vi.fn(),
      });
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws2 = FakeWebSocket.instances[0]!;
      ws2.emitOpen();
      const s2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };

      // Emit pre-error chunk while startRawPcmCapture is still pending, then fail WS before ready.
      emitChunk([111, -111]);
      ws2.emitMessage({ type: 'voice.session.error', sessionId: s2.sessionId, code: 'upstream_down' });
      // Resolve async native start; stopRawPcmCapture runs inside prime.stopOnReady drain, receives tail, then resolves.
      resolveStart();
      await waitFor(() => expect(stopRawPcmCapture).toHaveBeenCalledTimes(1));
      emitChunk([777, -888]);
      resolveStop();

      const res2 = await asyncPrimeP;
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.reason).toBe('upstream_down');
        expect(Array.from(res2.bufferedPcm ?? [])).toEqual([111, -111, 777, -888]);
      }

      // C: Mid-session error followed by late voice.session.result during native drain does NOT wipe fallbackPcmQueue.
      listeners.clear();
      startRawPcmCapture.mockClear();
      stopRawPcmCapture.mockClear();
      deferredStart = false;
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 't-late-result' });
      const onResultC = vi.fn();
      const onFallbackC = vi.fn(() => true);
      const midSessionP = startRemoteVoiceSession({
        targetDeviceId: 'dev-1',
        readyTimeoutMs: 2000,
        onResult: onResultC,
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback: onFallbackC,
      });
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws3 = FakeWebSocket.instances[0]!;
      ws3.emitOpen();
      const s3 = JSON.parse(ws3.sent[0]!) as { sessionId: string };
      ws3.emitMessage({ type: 'voice.session.ready', sessionId: s3.sessionId });
      await expect(midSessionP).resolves.toMatchObject({ ok: true });
      await waitFor(() => expect(startRawPcmCapture).toHaveBeenCalledTimes(1));
      emitChunk([222, -222]);

      ws3.emitMessage({ type: 'voice.session.error', sessionId: s3.sessionId, code: 'asr_crash' });
      // Late result during drain must be ignored so onFallback receives preserved PCM.
      ws3.emitMessage({ type: 'voice.session.result', sessionId: s3.sessionId, text: 'stale late text', isFinal: true });
      emitChunk([333, -333]);
      resolveStop();

      await waitFor(() => expect(onFallbackC).toHaveBeenCalledTimes(1));
      expect(onResultC).not.toHaveBeenCalled();
      expect(Array.from(onFallbackC.mock.calls[0]?.[1]?.bufferedPcm ?? [])).toEqual([222, -222, 333, -333]);
    } finally {
      if (prevAddListener) {
        streamingBridge.addListener.mockImplementation(prevAddListener);
      }
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      vi.unstubAllGlobals();
    }
  });

  it('latches unsupported on Capacitor UNIMPLEMENTED inside primeRemoteVoiceCapture, completes via getUserMedia without local fallback, and skips native probe on subsequent utterances', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const fake = setupFakeWebAudio({ sampleRate: 16_000 });
    const startRawPcmCapture = vi.fn(async () => {
      const err = new Error('"StreamingSpeech.startRawPcmCapture()" is not implemented on ios') as Error & { code?: string };
      err.code = 'UNIMPLEMENTED';
      throw err;
    });
    const stopRawPcmCapture = vi.fn(async () => {});
    Object.assign(streamingBridge, { startRawPcmCapture, stopRawPcmCapture });

    try {
      // Utterance 1: prime hits UNIMPLEMENTED -> latches unsupported + seamlessly falls back to getUserMedia -> WS session succeeds without onFallback
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-unimpl-1' });
      const onPrimeErr = vi.fn();
      const onFallback = vi.fn(() => true);
      const onResult = vi.fn();
      expect(primeRemoteVoiceCapture({ allowPrompt: true, onError: onPrimeErr })).toBe(true);

      const sessionP1 = startRemoteVoiceSession({
        targetDeviceId: 'dev-m3',
        onResult,
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback,
        getWsBaseUrl: () => 'https://relay.example',
      });

      await waitFor(() => expect(startRawPcmCapture).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(fake.getUserMedia).toHaveBeenCalledTimes(1));
      expect(getNativeRawPcmCapture()).toBeNull();
      expect(onPrimeErr).not.toHaveBeenCalled();

      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.emitOpen();
      const start1 = JSON.parse(ws1.sent[0]!) as { type: string; sessionId: string };
      expect(start1.type).toBe('voice.session.start');
      ws1.emitMessage({ type: 'voice.session.ready', sessionId: start1.sessionId });
      const res1 = await sessionP1;
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        fake.emitSamples(new Float32Array(2048).fill(0.25));
        const audioFrames = ws1.sent
          .map((raw) => JSON.parse(raw) as { type: string; sessionId: string; pcmBase64?: string })
          .filter((f) => f.type === 'voice.session.audio' && f.sessionId === start1.sessionId);
        expect(audioFrames.length).toBeGreaterThan(0);
        const streamedPcm = audioFrames.flatMap((f) => Array.from(decodeBase64ToInt16Pcm(f.pcmBase64!)));
        expect(streamedPcm.length).toBeGreaterThanOrEqual(1600);
        expect(streamedPcm.every((sample) => sample > 7000 && sample < 9000)).toBe(true);
        ws1.emitMessage({ type: 'voice.session.result', sessionId: start1.sessionId, text: 'hello m3', isFinal: true });
        ws1.emitMessage({ type: 'voice.session.end', sessionId: start1.sessionId });
        await res1.handle.stop(false);
      }
      expect(onResult).toHaveBeenCalledWith('hello m3', true);
      expect(onFallback).not.toHaveBeenCalled();

      // Utterance 2: subsequent prime + session skip startRawPcmCapture entirely and open getUserMedia directly
      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-unimpl-2' });
      expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
      const sessionP2 = startRemoteVoiceSession({
        targetDeviceId: 'dev-m3',
        onResult: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback: vi.fn(),
        getWsBaseUrl: () => 'https://relay.example',
      });
      await waitFor(() => expect(fake.getUserMedia).toHaveBeenCalledTimes(2));
      expect(startRawPcmCapture).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const ws2 = FakeWebSocket.instances[0]!;
      ws2.emitOpen();
      const start2 = JSON.parse(ws2.sent[0]!) as { sessionId: string };
      ws2.emitMessage({ type: 'voice.session.ready', sessionId: start2.sessionId });
      await expect(sessionP2).resolves.toMatchObject({ ok: true });
      if ((await sessionP2).ok) {
        await (await sessionP2 as { ok: true; handle: { stop: (a?: boolean) => Promise<void> } }).handle.stop(true);
      }
    } finally {
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      vi.unstubAllGlobals();
    }
  });

  it('respects permission denial, abort teardown, and quick tap stopOnReady boundaries during native UNIMPLEMENTED fallback', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'android',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const fake = setupFakeWebAudio({ sampleRate: 16_000 });
    const stopRawPcmCapture = vi.fn(async () => {});

    try {
      // A: Permission denied in native prime must NOT latch unsupported and must NOT call getUserMedia
      const startPermDenied = vi.fn(async () => {
        throw new Error('Microphone permission denied');
      });
      Object.assign(streamingBridge, { startRawPcmCapture: startPermDenied, stopRawPcmCapture });
      const onPrimeErrA = vi.fn();
      expect(primeRemoteVoiceCapture({ allowPrompt: true, onError: onPrimeErrA })).toBe(true);
      await waitFor(() => expect(onPrimeErrA).toHaveBeenCalledWith('Microphone permission denied', true));
      expect(fake.getUserMedia).not.toHaveBeenCalled();
      expect(getNativeRawPcmCapture()).not.toBeNull();

      // B: Cancellation while getUserMedia fallback is pending stops acquired tracks immediately without leaking mic
      resetRemoteVoiceClientForTesting();
      let resolveNativeUnimpl!: () => void;
      const startDeferredUnimpl = vi.fn(() => new Promise<void>((_, rej) => {
        resolveNativeUnimpl = () => rej(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
      }));
      let resolveGum!: (stream: MediaStream) => void;
      const leakedTrackStop = vi.fn();
      const delayedStream = { getTracks: () => [{ stop: leakedTrackStop }] } as unknown as MediaStream;
      fake.getUserMedia.mockImplementationOnce(() => new Promise((res) => { resolveGum = res; }));
      Object.assign(streamingBridge, { startRawPcmCapture: startDeferredUnimpl, stopRawPcmCapture });

      expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
      await waitFor(() => expect(startDeferredUnimpl).toHaveBeenCalledTimes(1));
      resolveNativeUnimpl();
      await waitFor(() => expect(fake.getUserMedia).toHaveBeenCalledTimes(1));
      cancelRemoteVoiceCapturePrime();
      resolveGum(delayedStream);
      await waitFor(() => expect(leakedTrackStop).toHaveBeenCalledTimes(1));

      // C: Quick tap (finishRemoteVoiceCapturePrime -> stopOnReady) while native UNIMPLEMENTED falls back to Web getUserMedia
      // preserves captured pre-roll PCM and flushes voice.session.audio when adopted by startRemoteVoiceSession.
      resetRemoteVoiceClientForTesting();
      let resolveNativeQuickTap!: () => void;
      const startQuickTap = vi.fn(() => new Promise<void>((_, rej) => {
        resolveNativeQuickTap = () => rej(Object.assign(new Error('is not implemented'), { code: 'UNIMPLEMENTED' }));
      }));
      Object.assign(streamingBridge, { startRawPcmCapture: startQuickTap, stopRawPcmCapture });
      // Inject known non-zero audio right when the Web fallback AudioContext graph connects on quick tap.
      const prevAudioContextCtor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext!;
      vi.stubGlobal('AudioContext', class QuickTapAudioContext extends prevAudioContextCtor {
        override createGain = (() => ({
          gain: { value: 1 },
          connect: () => {
            fake.emitSamples(new Float32Array(2048).fill(0.5));
            return {} as AudioNode;
          },
          disconnect: vi.fn(),
        })) as typeof prevAudioContextCtor.prototype.createGain;
      });

      expect(primeRemoteVoiceCapture({ allowPrompt: true })).toBe(true);
      await waitFor(() => expect(startQuickTap).toHaveBeenCalledTimes(1));
      const finishP = finishRemoteVoiceCapturePrime();
      resolveNativeQuickTap();
      await finishP;
      expect(fake.getUserMedia).toHaveBeenCalledTimes(2);
      expect(fake.stopTrack).toHaveBeenCalled();

      FakeWebSocket.instances.length = 0;
      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-quick-tap' });
      const quickTapSessionP = startRemoteVoiceSession({
        targetDeviceId: 'dev-m3',
        onResult: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback: vi.fn(),
        getWsBaseUrl: () => 'https://relay.example',
      });
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
      const wsQuick = FakeWebSocket.instances[0]!;
      wsQuick.emitOpen();
      const startQuick = JSON.parse(wsQuick.sent[0]!) as { sessionId: string };
      wsQuick.emitMessage({ type: 'voice.session.ready', sessionId: startQuick.sessionId });
      const quickRes = await quickTapSessionP;
      expect(quickRes.ok).toBe(true);
      const quickAudioFrames = wsQuick.sent
        .map((raw) => JSON.parse(raw) as { type: string; sessionId: string; pcmBase64?: string })
        .filter((f) => f.type === 'voice.session.audio' && f.sessionId === startQuick.sessionId);
      expect(quickAudioFrames.length).toBeGreaterThan(0);
      const quickPcm = quickAudioFrames.flatMap((f) => Array.from(decodeBase64ToInt16Pcm(f.pcmBase64!)));
      expect(quickPcm.length).toBeGreaterThanOrEqual(1600);
      expect(quickPcm.every((sample) => sample > 15000 && sample < 17000)).toBe(true);
      if (quickRes.ok) {
        await quickRes.handle.stop(true);
      }
    } finally {
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      vi.unstubAllGlobals();
    }
  });

  it('stops acquired MediaStream tracks and cleans up partial AudioContext nodes when buildRemoteAudioGraph throws after native UNIMPLEMENTED fallback', async () => {
    vi.stubGlobal('Capacitor', {
      getPlatform: () => 'ios',
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'StreamingSpeech',
    });
    const stopTrackA = vi.fn();
    const stopTrackB = vi.fn();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopTrackA }] } as unknown as MediaStream)
      .mockResolvedValueOnce({ getTracks: () => [{ stop: stopTrackB }] } as unknown as MediaStream);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
      maxTouchPoints: 0,
      language: 'en-US',
      languages: ['en-US'],
    });
    const startRawPcmCapture = vi.fn(async () => {
      throw Object.assign(new Error('"StreamingSpeech.startRawPcmCapture()" is not implemented on ios'), { code: 'UNIMPLEMENTED' });
    });
    const stopRawPcmCapture = vi.fn(async () => {});
    Object.assign(streamingBridge, { startRawPcmCapture, stopRawPcmCapture });

    try {
      // Case 1: prime fallback -> getUserMedia succeeds -> AudioContext constructor throws twice -> tracks stopped exactly once & error reported
      vi.stubGlobal('AudioContext', class ThrowingAudioContext {
        constructor() {
          throw new Error('audio_graph_failed');
        }
      });
      const onPrimeError = vi.fn();
      expect(primeRemoteVoiceCapture({ allowPrompt: true, onError: onPrimeError })).toBe(true);
      await waitFor(() => expect(onPrimeError).toHaveBeenCalledWith('audio_graph_failed', false));
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(stopTrackA).toHaveBeenCalledTimes(1);
      expect(getNativeRawPcmCapture()).toBeNull();
      expect(isRemoteMicPermissionKnownGranted()).toBe(true);
      cancelRemoteVoiceCapturePrime();
      expect(stopTrackA).toHaveBeenCalledTimes(1);

      // Case 2: direct startRemoteVoiceSession -> native UNIMPLEMENTED -> getUserMedia succeeds -> connect() throws mid-graph -> nodes disconnected, ctx closed, tracks stopped once
      resetRemoteVoiceClientForTesting();
      const disconnectSource = vi.fn();
      const disconnectProc = vi.fn();
      const disconnectGain = vi.fn();
      const closeCtx = vi.fn(async () => {});
      vi.stubGlobal('AudioContext', class PartialFailAudioContext {
        sampleRate = 16_000;
        state = 'running';
        destination = {};
        close = closeCtx;
        createMediaStreamSource = () => ({
          connect: () => { throw new Error('connect_failed'); },
          disconnect: disconnectSource,
        });
        createScriptProcessor = () => ({
          connect: vi.fn(),
          disconnect: disconnectProc,
          onaudioprocess: null,
        });
        createGain = () => ({
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: disconnectGain,
        });
      });

      apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-graph-fail' });
      const res = await startRemoteVoiceSession({
        targetDeviceId: 'dev-m3',
        onResult: vi.fn(),
        onError: vi.fn(),
        onEnd: vi.fn(),
        onFallback: vi.fn(),
        getWsBaseUrl: () => 'https://relay.example',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe('connect_failed');
      }
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(stopTrackB).toHaveBeenCalledTimes(1);
      expect(disconnectSource).toHaveBeenCalledTimes(1);
      expect(disconnectProc).toHaveBeenCalledTimes(1);
      expect(disconnectGain).toHaveBeenCalledTimes(1);
      expect(closeCtx).toHaveBeenCalledTimes(1);
    } finally {
      delete (streamingBridge as Record<string, unknown>).startRawPcmCapture;
      delete (streamingBridge as Record<string, unknown>).stopRawPcmCapture;
      vi.unstubAllGlobals();
    }
  });

  it('uses 3000ms ready timeout, retries constrained getUserMedia once on non-permission errors, never retries permission denials, and preserves error names + sanitized fallbackNotice in VoiceOverlay', async () => {
    expect(REMOTE_VOICE_CLIENT_READY_TIMEOUT_MS).toBe(3_000);

    // 1. formatMicCaptureErrorReason preserves err.name on Error, DOMException-like objects, and plain objects
    expect(formatMicCaptureErrorReason(Object.assign(new Error('Invalid constraint'), { name: 'OverconstrainedError' }))).toBe(
      'OverconstrainedError: Invalid constraint',
    );
    expect(formatMicCaptureErrorReason({ name: 'NotFoundError', message: '' })).toBe('NotFoundError');
    expect(formatMicCaptureErrorReason(new Error('plain failure'))).toBe('plain failure');
    expect(formatMicCaptureErrorReason(null)).toBe('mic_unavailable');

    // 2. acquireRemoteMicStream retries once with { audio: true } on non-permission rejection, never on NotAllowedError/PermissionDeniedError or cancelled predicate
    const fallbackStream = { getTracks: () => [] } as unknown as MediaStream;
    const gumRetry = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Constraint failed'), { name: 'OverconstrainedError' }))
      .mockResolvedValueOnce(fallbackStream);
    await expect(acquireRemoteMicStream({ getUserMedia: gumRetry }, 'usb-mic-1')).resolves.toBe(fallbackStream);
    expect(gumRetry).toHaveBeenCalledTimes(2);
    expect(gumRetry).toHaveBeenNthCalledWith(2, { audio: true });

    for (const permName of ['NotAllowedError', 'PermissionDeniedError'] as const) {
      const gumDenied = vi.fn().mockRejectedValueOnce(
        Object.assign(new Error('Permission denied'), { name: permName }),
      );
      await expect(acquireRemoteMicStream({ getUserMedia: gumDenied }, 'usb-mic-1')).rejects.toMatchObject({
        name: permName,
      });
      expect(gumDenied).toHaveBeenCalledTimes(1);
    }

    const gumCancelledHelper = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('Constraint failed'), { name: 'OverconstrainedError' }),
    );
    await expect(
      acquireRemoteMicStream({ getUserMedia: gumCancelledHelper }, 'usb-mic-1', () => false),
    ).rejects.toMatchObject({ name: 'OverconstrainedError' });
    expect(gumCancelledHelper).toHaveBeenCalledTimes(1);

    // 2b. Entry-level primeRemoteVoiceCapture & startRemoteVoiceSession cancellation/timeout guards
    const audio = setupFakeWebAudio({ sampleRate: 16_000 });
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      fetchedAt: Date.now(),
      providers: [
        {
          deviceId: 'dev-mac-1',
          displayName: 'Studio Mac',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
        },
      ],
    });

    // Delayed rejection AFTER primeRemoteVoiceCapture is cancelled -> must NOT trigger { audio: true } retry
    let rejectDelayedPrime!: (err: unknown) => void;
    audio.getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((_res, rej) => { rejectDelayedPrime = rej; }),
    );
    const { cancelRemoteVoiceCapturePrime } = await import('../src/remote-voice-client.js');
    const primeErrs: string[] = [];
    expect(primeRemoteVoiceCapture({
      allowPrompt: true,
      onError: (r) => primeErrs.push(r),
    })).toBe(true);
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(1));
    cancelRemoteVoiceCapturePrime();
    rejectDelayedPrime(Object.assign(new Error('Constraint failed'), { name: 'OverconstrainedError' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

    // Delayed rejection AFTER AbortSignal cancels startRemoteVoiceSession -> must NOT trigger { audio: true } retry
    audio.getUserMedia.mockClear();
    let rejectDelayedAbortSession!: (err: unknown) => void;
    audio.getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((_res, rej) => { rejectDelayedAbortSession = rej; }),
    );
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-abort-late' });
    const abortCtrl = new AbortController();
    const abortedSessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      signal: abortCtrl.signal,
      onResult: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
      getWsBaseUrl: () => 'https://relay.example',
    });
    await waitFor(() => expect(audio.getUserMedia).toHaveBeenCalledTimes(1));
    abortCtrl.abort();
    await expect(abortedSessionP).resolves.toMatchObject({ ok: false, cancelled: true });
    rejectDelayedAbortSession(Object.assign(new Error('Constraint failed'), { name: 'OverconstrainedError' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

    // Delayed rejection AFTER readyTimeoutMs terminates startRemoteVoiceSession -> must NOT trigger { audio: true } retry
    audio.getUserMedia.mockClear();
    let rejectDelayedTimeoutSession!: (err: unknown) => void;
    audio.getUserMedia.mockImplementationOnce(
      () => new Promise<MediaStream>((_res, rej) => { rejectDelayedTimeoutSession = rej; }),
    );
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-timeout-late' });
    const timeoutSessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      readyTimeoutMs: 40,
      onResult: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
      getWsBaseUrl: () => 'https://relay.example',
    });
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1));
    FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.emitOpen();
    await expect(timeoutSessionP).resolves.toMatchObject({ ok: false, reason: 'ready_timeout' });
    rejectDelayedTimeoutSession(Object.assign(new Error('Constraint failed'), { name: 'OverconstrainedError' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

    // Active primeRemoteVoiceCapture retries once on OverconstrainedError and succeeds, while PermissionDeniedError requests once
    audio.getUserMedia.mockClear();
    const primeFallbackStop = vi.fn();
    audio.getUserMedia
      .mockRejectedValueOnce(Object.assign(new Error('bad sample rate'), { name: 'OverconstrainedError' }))
      .mockResolvedValueOnce({ getTracks: () => [{ stop: primeFallbackStop }] } as unknown as MediaStream);
    const activePrimeStarted = vi.fn();
    expect(primeRemoteVoiceCapture({ allowPrompt: true, onCaptureStarted: activePrimeStarted })).toBe(true);
    await waitFor(() => expect(activePrimeStarted).toHaveBeenCalledTimes(1));
    expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
    cancelRemoteVoiceCapturePrime();
    expect(primeFallbackStop).toHaveBeenCalledTimes(1);

    audio.getUserMedia.mockClear();
    audio.getUserMedia.mockRejectedValueOnce(Object.assign(new Error('Denied'), { name: 'PermissionDeniedError' }));
    const permDeniedCb = vi.fn();
    expect(primeRemoteVoiceCapture({ allowPrompt: true, onError: permDeniedCb })).toBe(true);
    await waitFor(() => expect(permDeniedCb).toHaveBeenCalledWith('PermissionDeniedError: Denied', true));
    expect(audio.getUserMedia).toHaveBeenCalledTimes(1);

    // 3. startRemoteVoiceSession recovers seamlessly when constrained capture rejects non-permission and { audio: true } succeeds
    audio.getUserMedia.mockClear();
    FakeWebSocket.instances.length = 0;
    audio.getUserMedia
      .mockRejectedValueOnce(Object.assign(new Error('sampleRate unsupported'), { name: 'OverconstrainedError' }))
      .mockResolvedValueOnce({ getTracks: () => [{ stop: audio.stopTrack }] } as unknown as MediaStream);
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      fetchedAt: Date.now(),
      providers: [
        {
          deviceId: 'dev-mac-1',
          displayName: 'Studio Mac',
          model: 'qwen3-1.7b',
          modelLabel: 'Qwen3-ASR 1.7B',
          ready: true,
          busy: false,
          shareScope: 'account',
        },
      ],
    });
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-retry-ok' });
    const onFallback = vi.fn();
    const onResult = vi.fn();
    const sessionP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult,
      onError: vi.fn(),
      onEnd: vi.fn(),
      onFallback,
      getWsBaseUrl: () => 'https://relay.example',
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    ws.emitOpen();
    await waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(1));
    const startFrame = JSON.parse(ws.sent[0]!) as { sessionId: string };
    ws.emitMessage({ type: 'voice.session.ready', sessionId: startFrame.sessionId });
    const res = await sessionP;
    expect(res.ok).toBe(true);
    expect(audio.getUserMedia).toHaveBeenCalledTimes(2);
    expect(onFallback).not.toHaveBeenCalled();
    ws.emitMessage({ type: 'voice.session.end', sessionId: startFrame.sessionId });

    // 4. When both constrained + unconstrained fail, err.name is preserved in startRemoteVoiceSession reason
    audio.getUserMedia
      .mockRejectedValueOnce(Object.assign(new Error('bad constraint'), { name: 'OverconstrainedError' }))
      .mockRejectedValueOnce(Object.assign(new Error('device busy'), { name: 'NotReadableError' }));
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-retry-fail' });
    const failRes = await startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      onResult: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
      onFallback,
      getWsBaseUrl: () => 'https://relay.example',
    });
    expect(failRes).toMatchObject({ ok: false, reason: 'NotReadableError: device busy' });

    // 5. VoiceOverlay allowlists protocol codes / standard browser error names, strips URLs/tickets & long unspaced text, and preserves localized notice
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      providers: [],
      fallbackNotice: 'NotReadableError: https://example.invalid/?ticket=TEST_ONLY',
    });
    const overlay = render(<VoiceOverlay open autoStartListening={false} onSend={vi.fn(() => 'accepted')} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('voice-remote-fallback-reason')).toBeTruthy());
    const reasonNode = screen.getByTestId('voice-remote-fallback-reason');
    expect(reasonNode.textContent).toBe('NotReadableError');
    expect(reasonNode.textContent).not.toContain('TEST_ONLY');
    expect(reasonNode.textContent).not.toContain('example.invalid');
    expect(screen.getByTestId('voice-remote-fallback-notice').textContent).toContain('voice.remote_fallback_notice');

    // Unknown raw URL / unbroken long string collapses to controlled generic code 'remote_start_failed'
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      providers: [],
      fallbackNotice: `https://example.invalid/?ticket=${'a'.repeat(120)}`,
    });
    await waitFor(() => expect(screen.getByTestId('voice-remote-fallback-reason').textContent).toBe('remote_start_failed'));

    // Known protocol code renders cleanly and wrapping CSS stays wired
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      providers: [],
      fallbackNotice: 'provider_offline',
    });
    await waitFor(() => expect(screen.getByTestId('voice-remote-fallback-reason').textContent).toBe('provider_offline'));
    expect(reasonNode.className).toContain('voice-remote-fallback-reason');

    // Whitespace-only / cleared notice omits empty reason badge without breaking banner
    resetRemoteVoiceClientForTesting({
      primaryDeviceId: 'dev-mac-1',
      providers: [],
      fallbackNotice: '   \n  ',
    });
    await waitFor(() => expect(screen.queryByTestId('voice-remote-fallback-reason')).toBeNull());
    overlay.unmount();
  });

  it('detects half-open provider WS via pongTimeoutMs, handles voice.provider.ping, recovers on online/visibilitychange, and aborts deferred start on disconnect', async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.instances.length = 0;
      let deferredResolve: ((v: { ok: boolean }) => void) | null = null;
      let startCallCount = 0;
      const startRemoteSessionMock = vi.fn(async () => {
        startCallCount += 1;
        if (startCallCount === 1) {
          return new Promise<{ ok: boolean }>((resolve) => { deferredResolve = resolve; });
        }
        return { ok: true };
      });
      const stopRemoteSessionMock = vi.fn(async () => ({ ok: true }));
      let ipcListener: ((ev: PcAppRemoteVoiceEvent) => void) | null = null;

      const controller = new RemoteVoiceProviderController({
        isSupported: () => true,
        getWsBaseUrl: () => 'https://relay.example',
        fetchTicket: async () => ({ ticket: 't-liveness' }),
        pingIntervalMs: 100,
        pongTimeoutMs: 250,
        getBridge: () => ({
          voice: {
            getRemoteProviderInfo: async () => ({
              deviceId: 'dev-half-open',
              model: 'qwen3-1.7b',
              modelLabel: 'Qwen3-ASR 1.7B',
              ready: true,
              busy: false,
            }),
            startRemoteSession: startRemoteSessionMock,
            stopRemoteSession: stopRemoteSessionMock,
            subscribeRemoteEvents: (cb) => {
              ipcListener = cb;
              return () => { ipcListener = null; };
            },
          },
        }),
      });

      await controller.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(1);
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.emitOpen();

      // App probe ping -> immediately sends voice.provider.pong
      ws1.emitMessage({ type: 'voice.provider.ping' });
      expect(ws1.sent.some((raw) => JSON.parse(raw).type === 'voice.provider.pong')).toBe(true);

      // Healthy pong keeps ws1 alive past pongTimeoutMs (250ms)
      await vi.advanceTimersByTimeAsync(110);
      expect(ws1.sent.some((raw) => JSON.parse(raw).type === 'ping')).toBe(true);
      ws1.emitMessage({ type: 'pong' });
      await vi.advanceTimersByTimeAsync(160);
      expect(ws1.closedWith).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(1);

      // Start an in-flight session whose native startRemoteSession IPC is still pending when half-open timeout triggers!
      ws1.emitMessage({ type: 'voice.session.start', sessionId: 's-deferred', locale: 'zh-Hans', sampleRate: 16000 });
      expect(startRemoteSessionMock).toHaveBeenCalledTimes(1);

      // Stop replying pong -> after >= 250ms from last activity (voice.session.start at t=280), next pingTimer tick detects half-open WS, aborts orphaned session, closes ws1(4000), and reconnects!
      await vi.advanceTimersByTimeAsync(360);
      expect(ws1.closedWith).toMatchObject({ code: 4000, reason: 'heartbeat_timeout' });
      expect(stopRemoteSessionMock).toHaveBeenCalledWith({ sessionId: 's-deferred', abort: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(2);
      const ws2 = FakeWebSocket.instances[1]!;
      ws2.emitOpen();
      const ws2SentBeforeDeferred = ws2.sent.length;

      // Late deferred startRemoteSession resolves { ok: true } AFTER disconnect & reconnect -> triggers compensating abort and sends NOTHING to ws2!
      deferredResolve!({ ok: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(stopRemoteSessionMock).toHaveBeenCalledTimes(2);
      expect(stopRemoteSessionMock).toHaveBeenLastCalledWith({ sessionId: 's-deferred', abort: true });
      ipcListener?.({ type: 'voice.session.ready', sessionId: 's-deferred' });
      ipcListener?.({ type: 'voice.session.result', sessionId: 's-deferred', text: 'stale', isFinal: true });
      expect(ws2.sent.length).toBe(ws2SentBeforeDeferred);

      // Disconnected socket waiting on backoff recovers immediately on window 'online'
      ws2.close();
      expect(FakeWebSocket.instances).toHaveLength(2);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(3);
      const ws3 = FakeWebSocket.instances[2]!;
      ws3.emitOpen();

      // And also recovers on document 'visibilitychange' while visible
      ws3.close();
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(4);
      const ws4 = FakeWebSocket.instances[3]!;
      ws4.emitOpen();

      // stop() removes window/document wake listeners cleanly
      controller.stop();
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up CLOSING socket active session before online/visibilitychange replacement and ignores delayed old close/IPC', async () => {
    vi.useFakeTimers();
    try {
      FakeWebSocket.instances.length = 0;
      const startRemoteSessionMock = vi.fn(async () => ({ ok: true }));
      const stopRemoteSessionMock = vi.fn(async () => ({ ok: true }));
      let ipcListener: ((ev: PcAppRemoteVoiceEvent) => void) | null = null;

      const controller = new RemoteVoiceProviderController({
        isSupported: () => true,
        getWsBaseUrl: () => 'https://relay.example',
        fetchTicket: async () => ({ ticket: 't-closing-race' }),
        pingIntervalMs: 100,
        pongTimeoutMs: 250,
        getBridge: () => ({
          voice: {
            getRemoteProviderInfo: async () => ({
              deviceId: 'dev-closing-race',
              model: 'qwen3-1.7b',
              modelLabel: 'Qwen3-ASR 1.7B',
              ready: true,
              busy: false,
            }),
            startRemoteSession: startRemoteSessionMock,
            stopRemoteSession: stopRemoteSessionMock,
            subscribeRemoteEvents: (cb) => {
              ipcListener = cb;
              return () => { ipcListener = null; };
            },
          },
        }),
      });

      await controller.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(1);
      const ws1 = FakeWebSocket.instances[0]!;
      ws1.emitOpen();

      // Active session on ws1, then ws1 enters CLOSING (2) before its close event fires
      ws1.emitMessage({ type: 'voice.session.start', sessionId: 's-closing-1', locale: 'zh-Hans', sampleRate: 16000 });
      await vi.advanceTimersByTimeAsync(0);
      ws1.readyState = 2; // CLOSING, close event delayed until after replacement socket opens

      window.dispatchEvent(new Event('online'));
      expect(stopRemoteSessionMock).toHaveBeenCalledTimes(1);
      expect(stopRemoteSessionMock).toHaveBeenCalledWith({ sessionId: 's-closing-1', abort: true });

      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(2);
      const ws2 = FakeWebSocket.instances[1]!;
      ws2.emitOpen();
      ws2.emitMessage({ type: 'voice.session.start', sessionId: 's-new-2', locale: 'zh-Hans', sampleRate: 16000 });
      await vi.advanceTimersByTimeAsync(0);
      const ws2SentBeforeDelayedEvents = ws2.sent.length;

      // Delayed close and delayed IPC for s-closing-1 arrive AFTER ws2 + s-new-2 are live
      ws1.readyState = FakeWebSocket.CLOSED;
      ws1.emit('close', {});
      ipcListener?.({ type: 'voice.session.ready', sessionId: 's-closing-1' });
      ipcListener?.({ type: 'voice.session.result', sessionId: 's-closing-1', text: 'stale-old', isFinal: true });
      await vi.advanceTimersByTimeAsync(20);

      expect(stopRemoteSessionMock).toHaveBeenCalledTimes(1);
      expect(ws2.closedWith).toBeNull();
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(ws2.sent.slice(ws2SentBeforeDelayedEvents)).toEqual([]);

      // s-new-2 still works normally on ws2, then visibilitychange while ws2 is CLOSING cleans up s-new-2 cleanly too
      ipcListener?.({ type: 'voice.session.ready', sessionId: 's-new-2' });
      expect(ws2.sent.slice(ws2SentBeforeDelayedEvents).map((raw) => JSON.parse(raw))).toEqual([
        { type: 'voice.session.ready', sessionId: 's-new-2' },
      ]);
      ws2.readyState = 2; // CLOSING
      document.dispatchEvent(new Event('visibilitychange'));
      expect(stopRemoteSessionMock).toHaveBeenCalledTimes(2);
      expect(stopRemoteSessionMock).toHaveBeenLastCalledWith({ sessionId: 's-new-2', abort: true });

      await vi.advanceTimersByTimeAsync(10);
      expect(FakeWebSocket.instances).toHaveLength(3);
      const ws3 = FakeWebSocket.instances[2]!;
      ws3.emitOpen();
      const ws3SentBefore = ws3.sent.length;
      ws2.readyState = FakeWebSocket.CLOSED;
      ws2.emit('close', {});
      ipcListener?.({ type: 'voice.session.result', sessionId: 's-new-2', text: 'stale-2', isFinal: true });
      await vi.advanceTimersByTimeAsync(20);
      expect(stopRemoteSessionMock).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(3);
      expect(ws3.sent.slice(ws3SentBefore)).toEqual([]);

      controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes ws_open_timeout (socket never opens) from ready_timeout (socket opened without ready) in startRemoteVoiceSession', async () => {
    const audio = setupFakeWebAudio();
    FakeWebSocket.instances.length = 0;

    // 1. Socket stays CONNECTING past readyTimeoutMs -> 'ws_open_timeout'
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-never-open' });
    const openTimeoutP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      readyTimeoutMs: 100,
      onResult: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
      getWsBaseUrl: () => 'https://relay.example',
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1), { interval: 5 });
    await expect(openTimeoutP).resolves.toMatchObject({ ok: false, reason: 'ws_open_timeout' });

    // 2. Socket opens and sends voice.session.start, provider never sends ready -> 'ready_timeout'
    apiMocks.fetchRemoteVoiceWsTicket.mockResolvedValueOnce({ ticket: 'tkt-opened-no-ready' });
    const readyTimeoutP = startRemoteVoiceSession({
      targetDeviceId: 'dev-mac-1',
      readyTimeoutMs: 100,
      onResult: vi.fn(),
      onError: vi.fn(),
      onEnd: vi.fn(),
      getWsBaseUrl: () => 'https://relay.example',
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { interval: 5 });
    FakeWebSocket.instances[1]!.emitOpen();
    await expect(readyTimeoutP).resolves.toMatchObject({ ok: false, reason: 'ready_timeout' });
    expect(audio.stopTrack).toHaveBeenCalled();
  });
});
