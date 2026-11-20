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
    expect(getTtsSpeechRate()).toBe(1.1);

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

  it('uses 1.1 default rate and compatible rate options while keeping legacy saved values valid', async () => {
    const tts = await import('../src/tts.js');
    expect(tts.TTS_DEFAULT_RATE).toBe(1.1);
    expect(tts.TTS_RATE_OPTIONS).toEqual([0.9, 1.0, 1.1, 1.25, 1.5]);
    expect(tts.getTtsSpeechRate()).toBe(1.1);

    localStorage.setItem(tts.TTS_SPEECH_RATE_STORAGE_KEY, '0.8');
    expect(tts.getTtsSpeechRate()).toBe(0.8);
  });

  it('folds file paths, filenames, file:// links, technical IDs, and SHAs while preserving normal words', async () => {
    const { prepareTextForTts, segmentTextForTts } = await import('../src/tts.js');

    expect(
      prepareTextForTts('修改了 `web/src/tts.ts`、`web/src/styles.css` 和 `ChatView.tsx:4989-4998`。', 'zh-CN'),
    ).toBe('修改了 相关文件。');

    expect(
      prepareTextForTts('Updated [tts.ts](file:///Users/k/repo/web/src/tts.ts#L10-L20) in `C:\\src\\app.tsx`.', 'en-US'),
    ).toBe('Updated file in file.');

    // Adjacent placeholders with `and` collapse into one
    expect(
      prepareTextForTts('Updated `web/src/tts.ts` and `web/src/styles.css` today.', 'en-US'),
    ).toBe('Updated file today.');

    // Pure file lists are skipped; inline prose keeps non-file lines
    expect(
      prepareTextForTts('构建已通过。\n- `web/src/tts.ts`\n- `web/src/styles.css`\n- `a8cc27b4b59b90a20560f1160d817f7d3e73914f`', 'zh-CN'),
    ).toBe('构建已通过。');

    expect(
      prepareTextForTts('- `web/src/tts.ts`\n- `web/src/styles.css`\ntsk_6b8d2c468d (2315aa88f)', 'zh-CN'),
    ).toBe('');

    // Preserve technical product names, slashes in prose, normal words (including hex-letter words), and numbers
    expect(
      prepareTextForTts('iOS/Android 和 Node.js 与 React API 在 2026 年升级 #6794，defaced 不会误删。', 'zh-CN'),
    ).toBe('iOS/Android 和 Node.js 与 React API 在 2026 年升级 6794，defaced 不会误删。');

    // Empty parens after stripping IDs & natural operator replacements
    expect(
      prepareTextForTts('任务完成 (tsk_6b8d2c468d)，流程 A -> B => C::D && E || F', 'zh-CN'),
    ).toBe('任务完成，流程 A, B, C D, E, F');

    // Localized placeholders across remaining 5 locales
    expect(prepareTextForTts('更新了 src/a.ts', 'zh-TW')).toBe('更新了 相關文件');
    expect(prepareTextForTts('修正しました src/a.ts', 'ja-JP')).toBe('修正しました 関連ファイル');
    expect(prepareTextForTts('수정됨 src/a.ts', 'ko-KR')).toBe('수정됨 관련 파일');
    expect(prepareTextForTts('Actualizado src/a.ts', 'es-ES')).toBe('Actualizado archivo');
    expect(prepareTextForTts('Обновлено src/a.ts', 'ru-RU')).toBe('Обновлено файл');

    // Multi-line unpunctuated prose inserts natural pause punctuation when merging
    const zhSegs = segmentTextForTts('第一项已完成\n第二项正在测试', 'zh-CN');
    expect(zhSegs).toEqual([{ text: '第一项已完成。 第二项正在测试', lang: 'zh-CN' }]);
    const enSegs = segmentTextForTts('First item finished\nSecond item running', 'en-US');
    expect(enSegs).toEqual([{ text: 'First item finished. Second item running', lang: 'en-US' }]);
  });

  it('queries native TTS voice quality safely on native platforms and returns null on web', async () => {
    {
      const tts = await import('../src/tts.js');
      expect(await tts.getNativeTtsVoiceQuality('zh-CN')).toBeNull();
    }

    vi.resetModules();
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    mocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      getTtsVoiceQuality: vi.fn().mockResolvedValue({
        quality: 'enhanced',
        language: 'zh-CN',
        voiceName: 'Tingting (Enhanced)',
        voiceIdentifier: 'com.apple.voice.enhanced.zh-CN.Tingting',
      }),
    };
    const nativeTts = await import('../src/tts.js');
    expect(await nativeTts.getNativeTtsVoiceQuality('zh-CN')).toEqual({
      quality: 'enhanced',
      language: 'zh-CN',
      voiceName: 'Tingting (Enhanced)',
      voiceIdentifier: 'com.apple.voice.enhanced.zh-CN.Tingting',
    });

    const backend = await import('../src/voice-recognition-backend.js');
    expect(backend.isSiriNativeVoiceIdentifier('com.apple.ttsbundle.siri_yu-shu_zh-CN_compact')).toBe(true);
    expect(backend.isSiriNativeVoiceIdentifier('com.apple.voice.compact.zh-CN.Tingting')).toBe(false);
    expect(backend.isHighQualityNativeTtsVoice({ quality: 'premium', language: 'zh-CN' })).toBe(true);
    expect(backend.isHighQualityNativeTtsVoice({ quality: 'enhanced', language: 'zh-CN' })).toBe(true);
    expect(backend.isHighQualityNativeTtsVoice({
      quality: 'default',
      language: 'zh-CN',
      voiceIdentifier: 'com.apple.ttsbundle.siri_yu-shu_zh-CN_compact',
    })).toBe(true);
    expect(backend.isHighQualityNativeTtsVoice({
      quality: 'default',
      language: 'zh-CN',
      voiceIdentifier: 'com.apple.voice.compact.zh-CN.Tingting',
    })).toBe(false);
  });

  it('checks and opens native TTS settings safely with fallback on web, old shells, and UNIMPLEMENTED', async () => {
    {
      const tts = await import('../src/tts.js');
      expect(tts.canOpenNativeTtsSettings()).toBe(false);
      expect(await tts.openNativeTtsSettings()).toBe(false);
    }

    vi.resetModules();
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    mocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
    };
    {
      const oldShellTts = await import('../src/tts.js');
      expect(oldShellTts.canOpenNativeTtsSettings()).toBe(false);
      expect(await oldShellTts.openNativeTtsSettings()).toBe(false);
    }

    vi.resetModules();
    const openSpy = vi.fn()
      .mockResolvedValueOnce({ opened: true })
      .mockResolvedValueOnce({ opened: false })
      .mockRejectedValueOnce({ code: 'UNIMPLEMENTED', message: 'not implemented' });
    mocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      openTtsSettings: openSpy,
    };
    const nativeTts = await import('../src/tts.js');
    expect(nativeTts.canOpenNativeTtsSettings()).toBe(true);
    expect(await nativeTts.openNativeTtsSettings()).toBe(true);
    expect(await nativeTts.openNativeTtsSettings()).toBe(false);
    expect(await nativeTts.openNativeTtsSettings()).toBe(false);
    expect(openSpy).toHaveBeenCalledTimes(3);
  });

  it('queues auto-read items FIFO on web/native, caps queue size, and clears on manual interrupt or stop', async () => {
    const {
      speakText,
      stopSpeaking,
      getTtsState,
      getTtsQueueLength,
      setTtsAutoReadEnabled,
      TTS_MAX_QUEUE_SIZE,
    } = await import('../src/tts.js');

    // 1. Web FIFO queue
    const r1 = await speakText('First notice.', { messageId: 'q1', queue: true });
    const r2 = await speakText('Second notice.', { messageId: 'q2', queue: true });
    const r3 = await speakText('Third notice.', { messageId: 'q3', queue: true });
    expect(r1).toEqual({ started: true });
    expect(r2).toEqual({ started: true, queued: true });
    expect(r3).toEqual({ started: true, queued: true });
    expect(spokenUtterances.map((u) => u.text)).toEqual(['First notice.']);
    expect(getTtsQueueLength()).toBe(2);
    expect(getTtsState()).toEqual({ status: 'speaking', activeMessageId: 'q1', error: null });

    spokenUtterances[0].onend?.();
    expect(spokenUtterances.map((u) => u.text)).toEqual(['First notice.', 'Second notice.']);
    expect(getTtsQueueLength()).toBe(1);
    expect(getTtsState()).toEqual({ status: 'speaking', activeMessageId: 'q2', error: null });

    spokenUtterances[1].onend?.();
    expect(spokenUtterances.map((u) => u.text)).toEqual(['First notice.', 'Second notice.', 'Third notice.']);
    expect(getTtsQueueLength()).toBe(0);
    expect(getTtsState()).toEqual({ status: 'speaking', activeMessageId: 'q3', error: null });

    spokenUtterances[2].onend?.();
    expect(getTtsState()).toEqual({ status: 'idle', activeMessageId: null, error: null });

    // 2. Bounded FIFO cap preserves bursts above 6 items (up to TTS_MAX_QUEUE_SIZE) and only drops oldest overflow past the cap
    expect(TTS_MAX_QUEUE_SIZE).toBeGreaterThanOrEqual(64);
    await speakText('Active item.', { messageId: 'cap-0', queue: true });
    for (let i = 1; i <= TTS_MAX_QUEUE_SIZE + 3; i++) {
      await speakText(`Queued ${i}.`, { messageId: `cap-${i}`, queue: true });
    }
    expect(getTtsQueueLength()).toBe(TTS_MAX_QUEUE_SIZE);
    spokenUtterances[3].onend?.();
    // Oldest kept item after cap-0 should be Queued 4 (dropped 1, 2, 3)
    expect(spokenUtterances[4].text).toBe('Queued 4.');

    // 3. Manual non-queued speakText interrupts active item AND clears queue
    await speakText('Manual read now.', { messageId: 'manual-1' });
    expect(getTtsQueueLength()).toBe(0);
    expect(getTtsState().activeMessageId).toBe('manual-1');
    expect(spokenUtterances.at(-1)?.text).toBe('Manual read now.');

    // 4. setTtsAutoReadEnabled(false) and stopSpeaking() clear queue cleanly
    await speakText('Queued before disable.', { messageId: 'q-dis', queue: true });
    expect(getTtsQueueLength()).toBe(1);
    setTtsAutoReadEnabled(false);
    expect(getTtsQueueLength()).toBe(0);
    await stopSpeaking();
    expect(getTtsState().status).toBe('idle');

    // 5. Native queue draining via stopped events
    vi.resetModules();
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    let nativeListener: ((event: { status: string; message?: string }) => void) | null = null;
    const nativeSpeak = vi.fn().mockResolvedValue(undefined);
    mocks.streamingPlugin = {
      speak: nativeSpeak,
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      addListener: vi.fn(async (_event: string, cb: (event: { status: string; message?: string }) => void) => {
        nativeListener = cb;
        return { remove: vi.fn().mockResolvedValue(undefined) };
      }),
    };
    const nativeTts = await import('../src/tts.js');
    await nativeTts.speakText('Native first.', { messageId: 'nq1', queue: true });
    await nativeTts.speakText('Native second.', { messageId: 'nq2', queue: true });
    expect(nativeSpeak).toHaveBeenCalledTimes(1);
    expect(nativeTts.getTtsQueueLength()).toBe(1);
    nativeListener?.({ status: 'stopped' });
    await vi.waitFor(() => expect(nativeSpeak).toHaveBeenCalledTimes(2));
    expect(nativeSpeak).toHaveBeenNthCalledWith(2, { text: 'Native second.', lang: 'en-US', rate: 1.1 });
    nativeListener?.({ status: 'stopped' });
    await vi.waitFor(() => expect(nativeTts.getTtsState().status).toBe('idle'));
  });
});

describe('server TTS playback', () => {
  const realFetch = globalThis.fetch;
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(async () => {
    const tts = await import('../src/tts.js');
    await tts.__resetTtsForTests();
    globalThis.fetch = realFetch;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('plays segments sequentially with prefetch and revokes every blob URL on completion', async () => {
    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    let urlCounter = 0;
    URL.createObjectURL = vi.fn(() => {
      const url = `blob:mock/${++urlCounter}`;
      createdUrls.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });

    interface MockAudioInstance {
      src: string;
      onended: (() => void) | null;
      onerror: (() => void) | null;
      play: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    }
    const audioInstances: MockAudioInstance[] = [];
    class MockAudio {
      src: string;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = vi.fn(async () => {});
      pause = vi.fn();
      constructor(src = '') {
        this.src = src;
        audioInstances.push(this);
      }
    }
    vi.stubGlobal('Audio', MockAudio);

    const fetchMock = vi.fn(async () => new Response(new Blob(['audio'], { type: 'audio/mpeg' }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const tts = await import('../src/tts.js');
    tts.setTtsMode('server');
    const res = await tts.speakText('第一句中文。 Second sentence in English.', { messageId: 'srv-1', rate: 1.25 });
    expect(res).toEqual({ started: true });
    expect(tts.getTtsState()).toEqual({ status: 'speaking', activeMessageId: 'srv-1', error: null });

    // Segment 1 is played and segment 2 is prefetched
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(audioInstances).toHaveLength(1);
    expect(audioInstances[0]!.src).toBe('blob:mock/1');

    // Finish segment 1 -> revokes blob 1 and starts segment 2
    audioInstances[0]!.onended?.();
    await vi.waitFor(() => expect(audioInstances).toHaveLength(2));
    expect(revokedUrls).toContain('blob:mock/1');
    expect(audioInstances[1]!.src).toBe('blob:mock/2');

    // Finish segment 2 -> revokes blob 2 and returns to idle
    audioInstances[1]!.onended?.();
    await vi.waitFor(() => expect(tts.getTtsState().status).toBe('idle'));
    expect(revokedUrls).toEqual(['blob:mock/1', 'blob:mock/2']);
    expect(createdUrls).toEqual(['blob:mock/1', 'blob:mock/2']);
  });

  it('aborts active HTTP request on stopSpeaking() mid-fetch and cleans up playback', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:mock/unused');
    URL.revokeObjectURL = vi.fn();
    vi.stubGlobal('Audio', class { play = vi.fn(async () => {}); pause = vi.fn(); });

    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn((_url, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    }) as typeof fetch;

    const tts = await import('../src/tts.js');
    tts.setTtsMode('server');
    const speakPromise = tts.speakText('Cancel while fetching.', { messageId: 'srv-abort' });
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    await tts.stopSpeaking();

    const result = await speakPromise;
    expect(capturedSignal?.aborted).toBe(true);
    expect(result).toEqual({ started: false, reason: 'superseded' });
    expect(tts.getTtsState()).toEqual({ status: 'idle', activeMessageId: null, error: null });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('syncs server config without breaking when offline or unauthenticated', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      mode: 'server',
      baseUrl: 'http://127.0.0.1:8880/v1',
      hasApiKey: true,
      apiKeyMasked: 'sk-a...wxyz',
      model: 'kokoro',
      voice: 'af_sky',
      responseFormat: 'mp3',
      serverDefaultConfigured: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const tts = await import('../src/tts.js');
    const cfg = await tts.syncTtsConfigFromServer();
    expect(cfg?.mode).toBe('server');
    expect(tts.getTtsMode()).toBe('server');
    expect(tts.isServerTtsConfigured()).toBe(true);
  });
});
