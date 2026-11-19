/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
const bridges = vi.hoisted(() => ({ legacy: {}, streaming: {}, register: vi.fn() }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: bridges.legacy }));
vi.mock('@capacitor/core', () => ({ registerPlugin: bridges.register.mockReturnValue(bridges.streaming) }));
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('shared native voice bridge', () => {
  it.each(['android', 'ios'])('uses offline streaming on a new %s shell', async platform => {
    vi.stubGlobal('Capacitor', { getPlatform: () => platform, isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const { getNativeSpeechRecognition, getVoiceRecognitionEngine } = await import('../src/voice-recognition-backend.js');
    expect(getVoiceRecognitionEngine()).toBe('builtin');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
    expect(bridges.register).toHaveBeenCalledWith('StreamingSpeech');
  });
  it.each(['android', 'ios'])('switches between builtin and system/Apple recognizer on %s when persisted', async platform => {
    vi.stubGlobal('Capacitor', { getPlatform: () => platform, isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const {
      VOICE_ENGINE_STORAGE_KEY,
      getNativeSpeechRecognition,
      getVoiceRecognitionEngine,
      isIosNativePlatform,
      setVoiceRecognitionEngine,
    } = await import('../src/voice-recognition-backend.js');
    expect(isIosNativePlatform()).toBe(platform === 'ios');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);

    setVoiceRecognitionEngine('system');
    expect(localStorage.getItem(VOICE_ENGINE_STORAGE_KEY)).toBe('system');
    expect(getVoiceRecognitionEngine()).toBe('system');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);

    setVoiceRecognitionEngine('builtin');
    expect(localStorage.getItem(VOICE_ENGINE_STORAGE_KEY)).toBe('builtin');
    expect(getVoiceRecognitionEngine()).toBe('builtin');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
  });
  it.each(['en-US', 'ja-JP', 'zh-TW', 'fr-FR', 'ru-RU'])('uses multilingual offline recognition for %s', async language => {
    vi.stubGlobal('navigator', { language });
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => true });
    const { getNativeSpeechRecognition } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
  });
  it('keeps an old native binary functional after a web-only update', async () => {
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => false });
    const { getNativeSpeechRecognition, setVoiceRecognitionEngine } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
    setVoiceRecognitionEngine('builtin');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
  });
  it('does not assume native registration in browsers or older bridge versions', async () => {
    vi.stubGlobal('Capacitor', undefined);
    const { getNativeSpeechRecognition, getNativeSystemTts } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
    expect(getNativeSystemTts()).toBeNull();
  });
  it('exposes getNativeSystemTts only when StreamingSpeech provides native TTS methods', async () => {
    vi.stubGlobal('Capacitor', { getPlatform: () => 'ios', isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const modEmpty = await import('../src/voice-recognition-backend.js');
    expect(modEmpty.getNativeSystemTts()).toBeNull();

    vi.resetModules();
    Object.assign(bridges.streaming, { speak: vi.fn(), stopSpeaking: vi.fn() });
    const modReady = await import('../src/voice-recognition-backend.js');
    expect(modReady.getNativeSystemTts()).toBe(bridges.streaming);
    delete (bridges.streaming as Record<string, unknown>).speak;
    delete (bridges.streaming as Record<string, unknown>).stopSpeaking;
  });
});
