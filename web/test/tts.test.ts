/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  nativePlatform: false,
  pluginAvailable: false,
  streamingPlugin: {} as Record<string, unknown>,
  legacySpeech: {} as Record<string, unknown>,
}));

vi.mock('../src/native.js', () => ({
  isNative: () => mocks.nativePlatform,
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => mocks.streamingPlugin,
}));

vi.mock('@capgo/capacitor-speech-recognition', () => ({
  SpeechRecognition: mocks.legacySpeech,
}));

class MockUtterance {
  text: string;
  lang = '';
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

describe('tts service', () => {
  let spokenUtterances: MockUtterance[];
  let cancelMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    localStorage.clear();
    mocks.nativePlatform = false;
    mocks.pluginAvailable = false;
    mocks.streamingPlugin = {};
    spokenUtterances = [];
    cancelMock = vi.fn();
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => mocks.nativePlatform,
      isPluginAvailable: () => mocks.pluginAvailable,
    });
    vi.stubGlobal('SpeechSynthesisUtterance', MockUtterance);
    vi.stubGlobal('speechSynthesis', {
      speak: vi.fn((u: MockUtterance) => {
        spokenUtterances.push(u);
      }),
      cancel: cancelMock,
    });
    vi.resetModules();
  });

  afterEach(async () => {
    const tts = await import('../src/tts.js');
    await tts.__resetTtsForTests();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('cleans markdown prose while stripping fenced code blocks, urls, and hashes', async () => {
    const { prepareTextForTts } = await import('../src/tts.js');
    const input = [
      '<!-- IMCODES_TASK STARTED tsk_1 -->',
      '# Title Here',
      '',
      '> Quoted line with **bold** and `send_im_message` plus [Docs](https://example.com/a).',
      '',
      '```ts',
      'const secret = 123;',
      'console.log(secret);',
      '```',
      '',
      'Commit e4d6e16e534fb232c02cae9a2f73db4b0de40fd7 at https://github.com/im4codes/imcodes is ready.',
    ].join('\n');
    const cleaned = prepareTextForTts(input);
    expect(cleaned).not.toContain('const secret');
    expect(cleaned).not.toContain('IMCODES_TASK');
    expect(cleaned).not.toContain('https://');
    expect(cleaned).not.toContain('e4d6e16e534fb232c02cae9a2f73db4b0de40fd7');
    expect(cleaned).toContain('Title Here');
    expect(cleaned).toContain('Quoted line with bold and send_im_message plus Docs.');
    expect(cleaned).toContain('Commit at is ready.');

    expect(prepareTextForTts('```js\nconst x = 1;\n```')).toBe('');
    expect(prepareTextForTts('--- ***\n```\nunclosed code')).toBe('');
  });

  it('segments mixed Chinese/English text and bounds chunks by maxChunkChars', async () => {
    const { segmentTextForTts } = await import('../src/tts.js');
    const segments = segmentTextForTts('今天天气很好。 Everything is ready now! 日本語のテストです。', 'zh-CN');
    expect(segments).toEqual([
      { text: '今天天气很好。', lang: 'zh-CN' },
      { text: 'Everything is ready now!', lang: 'en-US' },
      { text: '日本語のテストです。', lang: 'ja-JP' },
    ]);

    const longSentence = `${'word '.repeat(60).trim()}, ${'tail '.repeat(60).trim()}.`;
    const chunked = segmentTextForTts(longSentence, 'en-US', 120);
    expect(chunked.length).toBeGreaterThan(2);
    expect(chunked.every((seg) => seg.text.length <= 120 && seg.lang === 'en-US')).toBe(true);
  });

  it('persists and clamps auto-read and speech-rate preferences', async () => {
    const {
      getTtsAutoReadEnabled,
      setTtsAutoReadEnabled,
      getTtsSpeechRate,
      setTtsSpeechRate,
      subscribeTtsPreferences,
      TTS_AUTO_READ_STORAGE_KEY,
      TTS_SPEECH_RATE_STORAGE_KEY,
    } = await import('../src/tts.js');

    const listener = vi.fn();
    const unsub = subscribeTtsPreferences(listener);
    expect(getTtsAutoReadEnabled()).toBe(false);
    expect(getTtsSpeechRate()).toBe(1);

    setTtsAutoReadEnabled(true);
    expect(getTtsAutoReadEnabled()).toBe(true);
    expect(localStorage.getItem(TTS_AUTO_READ_STORAGE_KEY)).toBe('1');

    setTtsSpeechRate(3.5);
    expect(getTtsSpeechRate()).toBe(2);
    expect(localStorage.getItem(TTS_SPEECH_RATE_STORAGE_KEY)).toBe('2');

    setTtsSpeechRate(0.1);
    expect(getTtsSpeechRate()).toBe(0.5);
    expect(listener).toHaveBeenCalledTimes(3);
    unsub();
  });

  it('speaks sequentially via Web speechSynthesis and stops cleanly', async () => {
    const { speakText, stopSpeaking, getTtsState, subscribeTtsState } = await import('../src/tts.js');
    const states: string[] = [];
    const unsub = subscribeTtsState((s) => states.push(`${s.status}:${s.activeMessageId ?? ''}`));

    const empty = await speakText('```ts\nconst onlyCode = true;\n```', { messageId: 'm0' });
    expect(empty).toEqual({ started: false, reason: 'empty' });
    expect(spokenUtterances).toHaveLength(0);

    const res = await speakText('你好。 Hello world.', { messageId: 'm1', lang: 'zh-CN', rate: 1.25 });
    expect(res).toEqual({ started: true });
    expect(getTtsState()).toEqual({ status: 'speaking', activeMessageId: 'm1', error: null });
    expect(spokenUtterances).toHaveLength(1);
    expect(spokenUtterances[0].lang).toBe('zh-CN');
    expect(spokenUtterances[0].rate).toBe(1.25);

    spokenUtterances[0].onend?.();
    expect(spokenUtterances).toHaveLength(2);
    expect(spokenUtterances[1].lang).toBe('en-US');

    spokenUtterances[1].onend?.();
    expect(getTtsState()).toEqual({ status: 'idle', activeMessageId: null, error: null });
    expect(states).toEqual(['speaking:m1', 'idle:']);

    await speakText('Another line', { messageId: 'm2' });
    expect(getTtsState().status).toBe('speaking');
    await stopSpeaking();
    expect(cancelMock).toHaveBeenCalled();
    expect(getTtsState()).toEqual({ status: 'idle', activeMessageId: null, error: null });
    unsub();
  });

  it('prefers native StreamingSpeech TTS and falls back to Web speechSynthesis on old shells returning UNIMPLEMENTED', async () => {
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    let ttsListener: ((event: { status: string; message?: string }) => void) | null = null;
    const nativeSpeak = vi.fn().mockResolvedValue(undefined);
    const nativeStopSpeaking = vi.fn().mockResolvedValue(undefined);
    mocks.streamingPlugin = {
      speak: nativeSpeak,
      stopSpeaking: nativeStopSpeaking,
      addListener: vi.fn(async (_event: string, cb: (event: { status: string; message?: string }) => void) => {
        ttsListener = cb;
        return { remove: vi.fn().mockResolvedValue(undefined) };
      }),
    };

    const { speakText, stopSpeaking, getTtsState } = await import('../src/tts.js');
    const ok = await speakText('你好。 Hello.', { messageId: 'nat1', lang: 'zh-CN', rate: 1.5 });
    expect(ok).toEqual({ started: true });
    expect(nativeSpeak).toHaveBeenCalledTimes(1);
    expect(nativeSpeak).toHaveBeenNthCalledWith(1, { text: '你好。', lang: 'zh-CN', rate: 1.5 });
    expect(getTtsState()).toEqual({ status: 'speaking', activeMessageId: 'nat1', error: null });

    ttsListener?.({ status: 'stopped' });
    await vi.waitFor(() => expect(nativeSpeak).toHaveBeenCalledTimes(2));
    expect(nativeSpeak).toHaveBeenNthCalledWith(2, { text: 'Hello.', lang: 'en-US', rate: 1.5 });
    ttsListener?.({ status: 'stopped' });
    await vi.waitFor(() => expect(getTtsState().status).toBe('idle'));

    // Old shell returning UNIMPLEMENTED falls back cleanly to Web speechSynthesis
    nativeSpeak.mockRejectedValueOnce(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
    const fallback = await speakText('Fallback text', { messageId: 'nat2' });
    expect(fallback).toEqual({ started: true });
    expect(spokenUtterances.map((u) => u.text)).toEqual(['Fallback text']);

    await stopSpeaking();
    expect(nativeStopSpeaking).toHaveBeenCalled();
    expect(getTtsState().status).toBe('idle');
  });

  it('surfaces real native TTS engine error cleanly without throwing', async () => {
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    mocks.streamingPlugin = {
      speak: vi.fn().mockRejectedValue(new Error('System TTS engine unavailable on this device')),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
    };

    const { speakText, getTtsState } = await import('../src/tts.js');
    const res = await speakText('Hello world', { messageId: 'err1' });
    expect(res).toEqual({
      started: false,
      reason: 'error',
      error: 'System TTS engine unavailable on this device',
    });
    expect(getTtsState()).toEqual({
      status: 'idle',
      activeMessageId: null,
      error: 'System TTS engine unavailable on this device',
    });
  });

  it('stops active native/web TTS when VoiceInput starts recording (pauseBackgroundAudio mutual exclusion)', async () => {
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    const nativeStopSpeaking = vi.fn().mockResolvedValue(undefined);
    mocks.streamingPlugin = {
      available: vi.fn().mockResolvedValue({ available: true }),
      requestPermissions: vi.fn().mockResolvedValue({ speechRecognition: 'granted' }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn().mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) }),
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: nativeStopSpeaking,
    };

    const tts = await import('../src/tts.js');
    await tts.speakText('Reading aloud right now', { messageId: 'm-asr' });
    expect(tts.isTtsSpeaking()).toBe(true);

    const { startListening, stopListening } = await import('../src/components/VoiceInput.js');
    const started = await startListening(() => {});
    expect(started).toBe(true);
    expect(cancelMock).toHaveBeenCalled();
    expect(nativeStopSpeaking).toHaveBeenCalled();
    expect(tts.isTtsSpeaking()).toBe(false);
    await stopListening();
  });
});
