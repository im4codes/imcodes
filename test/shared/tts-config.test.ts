import { describe, expect, it } from 'vitest';
import {
  TTS_API_BASE,
  TTS_CONFIG_PATH,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_RESPONSE_FORMAT,
  TTS_DEFAULT_SPEED,
  TTS_DEFAULT_VOICE,
  TTS_ENGINES,
  TTS_MAX_INPUT_CHARS,
  TTS_MAX_SPEED,
  TTS_MIN_SPEED,
  TTS_OPENAI_PRESET_VOICES,
  TTS_RESPONSE_FORMATS,
  TTS_SPEECH_PATH,
  TTS_VOICES_PATH,
  clampTtsServerSpeed,
  isTtsEngineMode,
  isTtsResponseFormat,
  maskTtsApiKey,
  resolveOpenAiSpeechEndpoint,
  resolveOpenAiVoicesEndpoints,
  ttsAudioContentType,
  validateTtsBaseUrl,
} from '../../shared/tts-config.js';

describe('shared tts-config contract', () => {
  it('exports expected route constants, defaults, and type guards', () => {
    expect(TTS_API_BASE).toBe('/api/tts');
    expect(TTS_CONFIG_PATH).toBe('/api/tts/config');
    expect(TTS_SPEECH_PATH).toBe('/api/tts/speech');
    expect(TTS_VOICES_PATH).toBe('/api/tts/voices');
    expect(TTS_ENGINES).toEqual(['system', 'server']);
    expect(TTS_RESPONSE_FORMATS).toEqual(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
    expect(TTS_OPENAI_PRESET_VOICES).toContain('alloy');
    expect(TTS_OPENAI_PRESET_VOICES).toContain('nova');
    expect(TTS_DEFAULT_MODEL).toBe('gpt-4o-mini-tts');
    expect(TTS_DEFAULT_VOICE).toBe('alloy');
    expect(TTS_DEFAULT_RESPONSE_FORMAT).toBe('mp3');
    expect(TTS_MAX_INPUT_CHARS).toBe(4096);

    expect(isTtsEngineMode('system')).toBe(true);
    expect(isTtsEngineMode('server')).toBe(true);
    expect(isTtsEngineMode('custom')).toBe(false);

    expect(isTtsResponseFormat('mp3')).toBe(true);
    expect(isTtsResponseFormat('wav')).toBe(true);
    expect(isTtsResponseFormat('ogg')).toBe(false);
  });

  it('clamps speed bounds and masks API keys safely', () => {
    expect(clampTtsServerSpeed(undefined)).toBe(TTS_DEFAULT_SPEED);
    expect(clampTtsServerSpeed(Number.NaN)).toBe(TTS_DEFAULT_SPEED);
    expect(clampTtsServerSpeed(0.05)).toBe(TTS_MIN_SPEED);
    expect(clampTtsServerSpeed(9.5)).toBe(TTS_MAX_SPEED);
    expect(clampTtsServerSpeed(1.25)).toBe(1.25);

    expect(maskTtsApiKey('')).toBeNull();
    expect(maskTtsApiKey(null)).toBeNull();
    expect(maskTtsApiKey('short')).toBe('****');
    expect(maskTtsApiKey('sk-1234567890abcdef')).toBe('sk-1...cdef');
  });

  it('normalizes OpenAI /v1/audio/speech endpoints without doubling paths', () => {
    expect(resolveOpenAiSpeechEndpoint('https://api.openai.com')).toBe('https://api.openai.com/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('https://api.openai.com/')).toBe('https://api.openai.com/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('https://api.openai.com/v1/audio/speech')).toBe('https://api.openai.com/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('https://proxy.example.com/openai/v1')).toBe('https://proxy.example.com/openai/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('https://proxy.example.com/openai')).toBe('https://proxy.example.com/openai/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('http://127.0.0.1:8880/v1')).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(resolveOpenAiSpeechEndpoint('http://192.168.1.10:8880')).toBe('http://192.168.1.10:8880/v1/audio/speech');

    expect(resolveOpenAiVoicesEndpoints('https://api.openai.com')).toEqual([
      'https://api.openai.com/v1/audio/voices',
      'https://api.openai.com/v1/voices',
    ]);
    expect(resolveOpenAiVoicesEndpoints('https://api.openai.com/v1/')).toEqual([
      'https://api.openai.com/v1/audio/voices',
      'https://api.openai.com/v1/voices',
    ]);
    expect(resolveOpenAiVoicesEndpoints('https://api.openai.com/v1/audio/speech')).toEqual([
      'https://api.openai.com/v1/audio/voices',
      'https://api.openai.com/v1/voices',
    ]);
    expect(resolveOpenAiVoicesEndpoints('https://proxy.example.com/openai')).toEqual([
      'https://proxy.example.com/openai/v1/audio/voices',
      'https://proxy.example.com/openai/v1/voices',
    ]);
  });

  it('validates baseUrl security boundaries while allowing localhost and LAN HTTP', () => {
    expect(validateTtsBaseUrl('http://127.0.0.1:8880/v1')).toEqual({ ok: true, url: 'http://127.0.0.1:8880/v1' });
    expect(validateTtsBaseUrl('http://localhost:8880/v1/')).toEqual({ ok: true, url: 'http://localhost:8880/v1' });
    expect(validateTtsBaseUrl('http://192.168.1.10:8880')).toEqual({ ok: true, url: 'http://192.168.1.10:8880' });
    expect(validateTtsBaseUrl('https://api.openai.com/v1')).toEqual({ ok: true, url: 'https://api.openai.com/v1' });

    expect(validateTtsBaseUrl('')).toEqual({ ok: false, error: 'empty_base_url' });
    expect(validateTtsBaseUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'unsupported_protocol' });
    expect(validateTtsBaseUrl('ftp://example.com/v1')).toEqual({ ok: false, error: 'unsupported_protocol' });
    expect(validateTtsBaseUrl('https://user:pass@api.openai.com/v1')).toEqual({ ok: false, error: 'embedded_credentials' });
    expect(validateTtsBaseUrl('http://169.254.169.254/latest/meta-data')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(validateTtsBaseUrl('http://metadata.google.internal/computeMetadata/v1')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(validateTtsBaseUrl('http://[fd00:ec2::254]/latest')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(validateTtsBaseUrl('http://[::ffff:169.254.169.254]/latest')).toEqual({ ok: false, error: 'forbidden_host' });
    expect(() => resolveOpenAiSpeechEndpoint('http://169.254.169.254/latest')).toThrow('forbidden_host');
  });

  it('maps response formats to MIME content types', () => {
    expect(ttsAudioContentType('mp3')).toBe('audio/mpeg');
    expect(ttsAudioContentType('opus')).toBe('audio/opus');
    expect(ttsAudioContentType('wav')).toBe('audio/wav');
  });
});
