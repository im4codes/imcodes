/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
const bridges = vi.hoisted(() => ({ legacy: {}, streaming: {}, register: vi.fn() }));
vi.mock('@capgo/capacitor-speech-recognition', () => ({ SpeechRecognition: bridges.legacy }));
vi.mock('@capacitor/core', () => ({ registerPlugin: bridges.register.mockReturnValue(bridges.streaming) }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('shared native voice bridge', () => {
  it.each(['android', 'ios'])('uses offline streaming on a new %s shell', async platform => {
    vi.stubGlobal('Capacitor', { getPlatform: () => platform, isPluginAvailable: (name: string) => name === 'StreamingSpeech' });
    const { getNativeSpeechRecognition } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.streaming);
    expect(bridges.register).toHaveBeenCalledWith('StreamingSpeech');
  });
  it('preserves existing non-bilingual recognition locales', async () => {
    vi.stubGlobal('navigator', { language: 'ja-JP' });
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => true });
    const { getNativeSpeechRecognition } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
  });
  it('keeps an old native binary functional after a web-only update', async () => {
    vi.stubGlobal('Capacitor', { isPluginAvailable: () => false });
    const { getNativeSpeechRecognition } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
  });
  it('does not assume native registration in browsers or older bridge versions', async () => {
    vi.stubGlobal('Capacitor', undefined);
    const { getNativeSpeechRecognition } = await import('../src/voice-recognition-backend.js');
    expect(getNativeSpeechRecognition()).toBe(bridges.legacy);
  });
});
