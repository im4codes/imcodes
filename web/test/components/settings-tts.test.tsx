/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { SettingsPage } from '../../src/pages/SettingsPage.js';
import { TtsQuickSettingsPopover } from '../../src/components/TtsQuickSettingsPopover.js';
import {
  applyServerTtsConfig,
  getTtsAutoReadEnabled,
  getTtsMode,
  getTtsSpeechRate,
  TTS_DEFAULT_RATE,
  TTS_RATE_OPTIONS,
  __resetTtsForTests,
} from '../../src/tts.js';
import type { NativeTtsVoiceQualityInfo } from '../../src/voice-recognition-backend.js';

const mockState = vi.hoisted(() => ({
  iosNative: false,
  voiceQuality: null as NativeTtsVoiceQualityInfo | null,
}));

const mocks = vi.hoisted(() => ({
  nativePlatform: false,
  pluginAvailable: false,
  platform: 'web' as 'web' | 'ios' | 'android',
  streamingPlugin: {} as Record<string, unknown>,
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => new Proxy({}, {
    get: (_target, prop) => (mocks.streamingPlugin as Record<PropertyKey, unknown>)[prop],
  }),
}));

const mockApi = vi.hoisted(() => ({
  getServerTtsConfig: vi.fn(),
  updateServerTtsConfig: vi.fn(),
  getServerTtsVoices: vi.fn(),
  synthesizeServerTtsSpeech: vi.fn(),
}));

vi.mock('../../src/api.js', () => ({
  apiFetch: vi.fn().mockResolvedValue({ servers: [], machines: [] }),
  getServerTtsConfig: (...args: unknown[]) => mockApi.getServerTtsConfig(...args),
  updateServerTtsConfig: (...args: unknown[]) => mockApi.updateServerTtsConfig(...args),
  getServerTtsVoices: (...args: unknown[]) => mockApi.getServerTtsVoices(...args),
  synthesizeServerTtsSpeech: (...args: unknown[]) => mockApi.synthesizeServerTtsSpeech(...args),
  passwordChange: vi.fn(),
  passkeyVerifyBegin: vi.fn(),
  passwordSetupWithPasskey: vi.fn(),
  updateDisplayName: vi.fn(),
  listPasskeys: vi.fn().mockResolvedValue({ credentials: [] }),
  deletePasskey: vi.fn(),
  passkeyRegisterBegin: vi.fn(),
  passkeyRegisterComplete: vi.fn(),
}));

vi.mock('../../src/voice-recognition-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/voice-recognition-backend.js')>();
  return {
    ...actual,
    isIosNativePlatform: () => mockState.iosNative || mocks.platform === 'ios',
  };
});

vi.mock('../../src/tts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tts.js')>();
  return {
    ...actual,
    getNativeTtsVoiceQuality: vi.fn(async (lang?: string) => (
      mockState.voiceQuality ?? actual.getNativeTtsVoiceQuality(lang)
    )),
  };
});

beforeEach(() => {
  mockApi.getServerTtsConfig.mockReset();
  mockApi.updateServerTtsConfig.mockReset();
  mockApi.getServerTtsVoices.mockReset();
  mockApi.synthesizeServerTtsSpeech.mockReset();
  mockApi.synthesizeServerTtsSpeech.mockResolvedValue(new Blob(['audio'], { type: 'audio/mpeg' }));
  mockApi.getServerTtsVoices.mockResolvedValue({
    voices: [
      { id: 'alloy', name: 'alloy' },
      { id: 'nova', name: 'nova' },
    ],
    source: 'preset',
    endpointConfigured: false,
  });
  mockApi.getServerTtsConfig.mockResolvedValue({
    mode: 'system',
    baseUrl: '',
    hasApiKey: false,
    apiKeyMasked: null,
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    voicesByLang: {},
    responseFormat: 'mp3',
    serverDefaultConfigured: false,
  });
  mockApi.updateServerTtsConfig.mockImplementation(async (body: Record<string, unknown>) => {
    const rawVoices = (body.voicesByLang ?? {}) as Record<string, string>;
    const voicesByLang: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawVoices)) {
      if (typeof v === 'string' && v.trim()) voicesByLang[k] = v.trim();
    }
    return {
      ok: true,
      config: {
        mode: body.mode ?? 'server',
        baseUrl: body.baseUrl ?? 'http://127.0.0.1:8880/v1',
        hasApiKey: body.apiKey === '' ? false : (body.apiKey !== undefined ? Boolean(body.apiKey) : true),
        apiKeyMasked: body.apiKey === '' ? null : 'sk-1...7890',
        model: body.model ?? 'gpt-4o-mini-tts',
        voice: body.voice ?? 'alloy',
        voicesByLang,
        responseFormat: body.responseFormat ?? 'mp3',
        serverDefaultConfigured: false,
      },
    };
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (typeof opts?.defaultValue === 'string') return opts.defaultValue;
      if (key === 'settings.tts_current_voice' && opts?.name && opts?.quality) {
        return `Current voice: ${String(opts.name)} (${String(opts.quality)})`;
      }
      return key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

describe('SettingsPage TTS preferences & 7-locale parity', () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.iosNative = false;
    mockState.voiceQuality = null;
    mocks.nativePlatform = false;
    mocks.pluginAvailable = false;
    mocks.platform = 'web';
    mocks.streamingPlugin = {};
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => mocks.nativePlatform,
      isPluginAvailable: () => mocks.pluginAvailable,
      getPlatform: () => mocks.platform,
    });
  });

  afterEach(async () => {
    cleanup();
    await __resetTtsForTests();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('toggles auto-read and updates speech rate in localStorage', () => {
    render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    const toggle = screen.getByTestId('settings-tts-auto-read-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(getTtsAutoReadEnabled()).toBe(false);
    expect(TTS_DEFAULT_RATE).toBe(1.1);
    expect(TTS_RATE_OPTIONS).toEqual([0.9, 1.0, 1.1, 1.25, 1.5]);
    expect(screen.getByTestId('settings-tts-rate-1.1').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('settings-tts-voice-hint').textContent).toContain('settings.tts_voice_hint');
    expect(screen.queryByTestId('settings-tts-open-settings-btn')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(getTtsAutoReadEnabled()).toBe(true);

    const rateBtn = screen.getByTestId('settings-tts-rate-1.5');
    fireEvent.click(rateBtn);
    expect(rateBtn.getAttribute('aria-pressed')).toBe('true');
    expect(getTtsSpeechRate()).toBe(1.5);
  });

  it('hides the native TTS settings button on legacy native shells without openTtsSettings', () => {
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    mocks.platform = 'android';
    mocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
    };

    render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    expect(screen.queryByTestId('settings-tts-open-settings-btn')).toBeNull();
  });

  it('shows and triggers Android and iOS native TTS settings buttons cleanly', async () => {
    const androidOpen = vi.fn().mockResolvedValue({ opened: true });
    mocks.nativePlatform = true;
    mocks.pluginAvailable = true;
    mocks.platform = 'android';
    mocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      openTtsSettings: androidOpen,
    };

    const { unmount } = render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    const androidBtn = screen.getByTestId('settings-tts-open-settings-btn');
    expect(androidBtn.textContent).toBe('settings.tts_open_android_settings');
    fireEvent.click(androidBtn);
    expect(androidOpen).toHaveBeenCalledTimes(1);
    unmount();

    const iosOpen = vi.fn().mockResolvedValue({ opened: true });
    mocks.platform = 'ios';
    mocks.streamingPlugin = {
      speak: vi.fn().mockResolvedValue(undefined),
      stopSpeaking: vi.fn().mockResolvedValue(undefined),
      getTtsVoiceQuality: vi.fn().mockResolvedValue({ quality: 'default', language: 'zh-CN' }),
      openTtsSettings: iosOpen,
    };

    render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    const iosBtn = screen.getByTestId('settings-tts-open-settings-btn');
    expect(iosBtn.textContent).toBe('settings.tts_open_ios_settings');
    fireEvent.click(iosBtn);
    expect(iosOpen).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(screen.getByTestId('settings-tts-voice-hint').textContent).toContain('settings.tts_ios_enhanced_hint');
    });
  });

  it('defines all TTS i18n keys across all 7 locales', () => {
    const locales = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru'];
    const baseDir = process.cwd().endsWith('/web')
      ? resolve(process.cwd(), 'src/i18n/locales')
      : resolve(process.cwd(), 'web/src/i18n/locales');
    for (const locale of locales) {
      const json = JSON.parse(readFileSync(resolve(baseDir, `${locale}.json`), 'utf8')) as {
        common?: Record<string, string>;
        chat?: Record<string, string>;
        settings?: Record<string, string>;
      };
      expect(json.common?.on, `${locale} common.on`).toBeTruthy();
      expect(json.common?.off, `${locale} common.off`).toBeTruthy();
      expect(json.chat?.tts_speak, `${locale} chat.tts_speak`).toBeTruthy();
      expect(json.chat?.tts_stop, `${locale} chat.tts_stop`).toBeTruthy();
      expect(json.chat?.tts_autoread_on, `${locale} chat.tts_autoread_on`).toBeTruthy();
      expect(json.chat?.tts_autoread_off, `${locale} chat.tts_autoread_off`).toBeTruthy();
      expect(json.chat?.tts_settings, `${locale} chat.tts_settings`).toBeTruthy();
      expect(json.settings?.tts_title, `${locale} settings.tts_title`).toBeTruthy();
      expect(json.settings?.tts_auto_read, `${locale} settings.tts_auto_read`).toBeTruthy();
      expect(json.settings?.tts_auto_read_desc, `${locale} settings.tts_auto_read_desc`).toBeTruthy();
      expect(json.settings?.tts_rate, `${locale} settings.tts_rate`).toBeTruthy();
      expect(json.settings?.tts_rate_desc, `${locale} settings.tts_rate_desc`).toBeTruthy();
      expect(json.settings?.tts_voice_hint, `${locale} settings.tts_voice_hint`).toBeTruthy();
      expect(json.settings?.tts_ios_enhanced_hint, `${locale} settings.tts_ios_enhanced_hint`).toBeTruthy();
      expect(json.settings?.tts_current_voice, `${locale} settings.tts_current_voice`).toBeTruthy();
      expect(json.settings?.tts_quality_premium, `${locale} settings.tts_quality_premium`).toBeTruthy();
      expect(json.settings?.tts_quality_enhanced, `${locale} settings.tts_quality_enhanced`).toBeTruthy();
      expect(json.settings?.tts_quality_siri, `${locale} settings.tts_quality_siri`).toBeTruthy();
      expect(json.settings?.tts_quality_default, `${locale} settings.tts_quality_default`).toBeTruthy();
      expect(json.settings?.tts_open_android_settings, `${locale} settings.tts_open_android_settings`).toBeTruthy();
      expect(json.settings?.tts_open_ios_settings, `${locale} settings.tts_open_ios_settings`).toBeTruthy();
      for (const k of [
        'tts_engine',
        'tts_engine_desc',
        'tts_engine_system',
        'tts_engine_server',
        'tts_server_base_url',
        'tts_server_base_url_placeholder',
        'tts_server_default_configured',
        'tts_server_api_key',
        'tts_server_api_key_placeholder',
        'tts_server_api_key_keep',
        'tts_server_api_key_clear',
        'tts_server_model',
        'tts_server_voice',
        'tts_server_voices_refresh',
        'tts_server_format',
        'tts_server_save',
        'tts_server_saving',
        'tts_server_saved',
        'tts_server_save_error',
        'tts_server_test',
        'tts_server_test_text',
        'tts_server_test_failed',
        'tts_server_unconfigured_hint',
      ]) {
        expect(json.settings?.[k], `${locale} settings.${k}`).toBeTruthy();
      }
    }
  });

  it('displays iOS native voiceName + quality and suppresses standard-voice warning for Enhanced/Premium/Siri', async () => {
    mockState.iosNative = true;

    // 1. Default compact voice shows voiceName + standard warning
    mockState.voiceQuality = {
      quality: 'default',
      language: 'zh-CN',
      voiceName: 'Tingting',
      voiceIdentifier: 'com.apple.voice.compact.zh-CN.Tingting',
    };
    const { unmount } = render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-current-voice').textContent).toBe(
        'Current voice: Tingting (settings.tts_quality_default)',
      );
    });
    expect(screen.getByTestId('settings-tts-ios-enhanced-hint')).toBeTruthy();
    unmount();

    // 2. Siri neural voice reporting quality=default suppresses standard warning and labels Siri
    mockState.voiceQuality = {
      quality: 'default',
      language: 'zh-CN',
      voiceName: 'Yushu',
      voiceIdentifier: 'com.apple.ttsbundle.siri_yu-shu_zh-CN_compact',
    };
    const r2 = render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-current-voice').textContent).toBe(
        'Current voice: Yushu (settings.tts_quality_siri)',
      );
    });
    expect(screen.queryByTestId('settings-tts-ios-enhanced-hint')).toBeNull();
    r2.unmount();

    // 3. Enhanced voice hides standard warning
    mockState.voiceQuality = {
      quality: 'enhanced',
      language: 'zh-CN',
      voiceName: 'Tingting',
      voiceIdentifier: 'com.apple.voice.enhanced.zh-CN.Tingting',
    };
    const r3 = render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-current-voice').textContent).toBe(
        'Current voice: Tingting (settings.tts_quality_enhanced)',
      );
    });
    expect(screen.queryByTestId('settings-tts-ios-enhanced-hint')).toBeNull();
    r3.unmount();

    // 4. Legacy native shell without voiceName/voiceIdentifier omits current-voice row cleanly
    mockState.voiceQuality = {
      quality: 'default',
      language: 'zh-CN',
    };
    render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-ios-enhanced-hint')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-tts-current-voice')).toBeNull();
    expect(screen.getByTestId('settings-tts-voice-hint').textContent).not.toContain('undefined');
    expect(screen.getByTestId('settings-tts-voice-hint').textContent).not.toContain('()');
  });

  it('configures server TTS settings for admins, persists via API, and clears stored API key', async () => {
    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'system',
      baseUrl: 'http://127.0.0.1:8880/v1',
      hasApiKey: true,
      apiKeyMasked: 'sk-o...9999',
      canConfigureEndpoint: true,
      model: 'kokoro',
      voice: 'af_sky',
      responseFormat: 'wav',
      serverDefaultConfigured: false,
    });

    render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        isAdmin={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    await waitFor(() => {
      expect(mockApi.getServerTtsConfig).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByTestId('settings-tts-engine-server'));
    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-server-panel')).toBeTruthy();
    });

    expect((screen.getByTestId('settings-tts-server-baseurl') as HTMLInputElement).value).toBe('http://127.0.0.1:8880/v1');
    expect(screen.getByTestId('settings-tts-server-apikey-hint')).toBeTruthy();

    fireEvent.input(screen.getByTestId('settings-tts-server-voice'), { target: { value: 'af_bella' } });
    fireEvent.click(screen.getByTestId('settings-tts-server-save'));

    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith({
        mode: 'server',
        baseUrl: 'http://127.0.0.1:8880/v1',
        model: 'kokoro',
        voice: 'af_bella',
        voicesByLang: { 'zh-CN': '', 'zh-TW': '', en: '', ja: '', ko: '', es: '', ru: '' },
        responseFormat: 'wav',
      });
    });

    fireEvent.click(screen.getByTestId('settings-tts-server-clear-key'));
    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith({ apiKey: '' });
    });
  });

  it('hides server TTS baseUrl/apiKey for non-admins and fails closed, while keeping model/voice/format/save/test working', async () => {
    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'server',
      baseUrl: '',
      hasApiKey: false,
      apiKeyMasked: null,
      canConfigureEndpoint: false,
      model: 'tts-1',
      voice: 'alloy',
      responseFormat: 'mp3',
      serverDefaultConfigured: true,
    });
    mockApi.updateServerTtsConfig.mockResolvedValueOnce({
      ok: true,
      config: {
        mode: 'server',
        baseUrl: '',
        hasApiKey: false,
        apiKeyMasked: null,
        canConfigureEndpoint: false,
        model: 'tts-1',
        voice: 'nova',
        voicesByLang: {},
        responseFormat: 'opus',
        serverDefaultConfigured: true,
      },
    });

    const { unmount } = render(
      <SettingsPage
        displayName="Member"
        username="member"
        hasPassword={true}
        isAdmin={false}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    await waitFor(() => {
      expect(mockApi.getServerTtsConfig).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-server-panel')).toBeTruthy();
    });

    expect(screen.queryByTestId('settings-tts-server-baseurl')).toBeNull();
    expect(screen.queryByTestId('settings-tts-server-apikey')).toBeNull();
    expect(screen.queryByTestId('settings-tts-server-clear-key')).toBeNull();
    expect(screen.queryByTestId('settings-tts-server-apikey-hint')).toBeNull();

    fireEvent.input(screen.getByTestId('settings-tts-server-voice'), { target: { value: 'nova' } });
    fireEvent.change(screen.getByTestId('settings-tts-server-format'), { target: { value: 'opus' } });
    fireEvent.click(screen.getByTestId('settings-tts-server-save'));

    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledTimes(1);
    });
    const savedPayload = mockApi.updateServerTtsConfig.mock.calls[0]![0] as Record<string, unknown>;
    expect(savedPayload).toEqual({
      mode: 'server',
      model: 'tts-1',
      voice: 'nova',
      voicesByLang: { 'zh-CN': '', 'zh-TW': '', en: '', ja: '', ko: '', es: '', ru: '' },
      responseFormat: 'opus',
    });
    expect(savedPayload).not.toHaveProperty('baseUrl');
    expect(savedPayload).not.toHaveProperty('apiKey');

    fireEvent.click(screen.getByTestId('settings-tts-server-test'));
    await waitFor(() => {
      expect(mockApi.synthesizeServerTtsSpeech).toHaveBeenCalledTimes(1);
    });

    unmount();
  });

  it('fails closed when isAdmin and canConfigureEndpoint are absent, and lets server canConfigureEndpoint=false override stale isAdmin', async () => {
    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'server',
      baseUrl: '',
      hasApiKey: false,
      apiKeyMasked: null,
      model: 'tts-1',
      voice: 'alloy',
      responseFormat: 'mp3',
      serverDefaultConfigured: true,
    });
    const { unmount: unmountLegacy } = render(
      <SettingsPage
        displayName="Legacy"
        username="legacy"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );
    await waitFor(() => {
      expect(mockApi.getServerTtsConfig).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('settings-tts-server-panel')).toBeTruthy();
    });
    expect(screen.queryByTestId('settings-tts-server-baseurl')).toBeNull();
    expect(screen.queryByTestId('settings-tts-server-apikey')).toBeNull();
    unmountLegacy();

    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'server',
      baseUrl: '',
      hasApiKey: false,
      apiKeyMasked: null,
      canConfigureEndpoint: false,
      model: 'tts-1',
      voice: 'alloy',
      responseFormat: 'mp3',
      serverDefaultConfigured: true,
    });
    render(
      <SettingsPage
        displayName="Demoted"
        username="demoted"
        hasPassword={true}
        isAdmin={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );
    await waitFor(() => {
      expect(mockApi.getServerTtsConfig).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('settings-tts-server-baseurl')).toBeNull();
    });
    expect(screen.queryByTestId('settings-tts-server-apikey')).toBeNull();
  });

  it('shows compact engine toggle in TtsQuickSettingsPopover when server TTS is configured', async () => {
    applyServerTtsConfig({
      mode: 'system',
      baseUrl: 'http://127.0.0.1:8880/v1',
      hasApiKey: false,
      apiKeyMasked: null,
      model: 'kokoro',
      voice: 'af_sky',
      responseFormat: 'mp3',
      serverDefaultConfigured: false,
    });

    const anchorRef = { current: document.createElement('div') };
    render(<TtsQuickSettingsPopover anchorRef={anchorRef} onClose={() => {}} />);

    expect(screen.getByTestId('chat-tts-settings-engine-section')).toBeTruthy();
    expect(screen.getByTestId('chat-tts-settings-engine-system').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByTestId('chat-tts-settings-engine-server'));
    expect(getTtsMode()).toBe('server');
    expect(screen.getByTestId('chat-tts-settings-engine-server').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith({ mode: 'server' });
    });
  });

  it('discovers upstream voices in SettingsPage and switches voice roles in TtsQuickSettingsPopover', async () => {
    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'server',
      baseUrl: '',
      hasApiKey: false,
      apiKeyMasked: null,
      model: 'tts-1',
      voice: 'custom_initial_role',
      responseFormat: 'mp3',
      serverDefaultConfigured: true,
    });
    mockApi.getServerTtsVoices.mockResolvedValue({
      voices: [
        { id: 'custom_initial_role', name: 'custom_initial_role' },
        { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', locale: 'zh-CN' },
        { id: 'nova', name: 'nova' },
      ],
      source: 'upstream',
      endpointConfigured: true,
    });

    const settingsRender = render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-server-panel')).toBeTruthy();
      expect(screen.getByTestId('settings-tts-server-voice-select')).toBeTruthy();
    });

    const settingsSelect = screen.getByTestId('settings-tts-server-voice-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(settingsSelect.options).some((opt) => opt.value === 'zh-CN-XiaoxiaoNeural')).toBe(true);
    });
    expect(settingsSelect.value).toBe('custom_initial_role');

    fireEvent.change(settingsSelect, { target: { value: 'zh-CN-XiaoxiaoNeural' } });
    expect((screen.getByTestId('settings-tts-server-voice') as HTMLInputElement).value).toBe('zh-CN-XiaoxiaoNeural');
    fireEvent.click(screen.getByTestId('settings-tts-server-save'));
    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'server',
        voice: 'zh-CN-XiaoxiaoNeural',
      }));
    });
    settingsRender.unmount();

    // Popover renders server voice dropdown when mode === 'server' and persists changes via PUT /api/tts/config
    applyServerTtsConfig({
      mode: 'server',
      baseUrl: '',
      hasApiKey: false,
      apiKeyMasked: null,
      model: 'tts-1',
      voice: 'zh-CN-XiaoxiaoNeural',
      responseFormat: 'mp3',
      serverDefaultConfigured: true,
    });

    const anchorRef = { current: document.createElement('div') };
    render(<TtsQuickSettingsPopover anchorRef={anchorRef} onClose={() => {}} />);

    const popSelect = await screen.findByTestId('chat-tts-settings-voice-select') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(popSelect.options).some((opt) => opt.value === 'nova')).toBe(true);
    });
    fireEvent.change(popSelect, { target: { value: 'nova' } });
    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith({ voice: 'nova' });
    });
  });

  it('renders per-language voice selectors with auto-match labels and persists voicesByLang overrides', async () => {
    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'server',
      baseUrl: '',
      hasApiKey: false,
      apiKeyMasked: null,
      model: 'tts-1',
      voice: 'zh-CN-XiaoxiaoNeural',
      voicesByLang: { ja: 'ja-JP-NanamiNeural' },
      responseFormat: 'mp3',
      serverDefaultConfigured: true,
    });
    mockApi.getServerTtsVoices.mockResolvedValue({
      voices: [
        { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', locale: 'zh-CN' },
        { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US' },
        { id: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB' },
        { id: 'ja-JP-NanamiNeural', name: 'Nanami', locale: 'ja-JP' },
      ],
      source: 'upstream',
      endpointConfigured: true,
    });

    render(
      <SettingsPage
        displayName="Tester"
        username="tester"
        hasPassword={true}
        onBack={() => {}}
        onDisplayNameChanged={() => {}}
        onUserAuthUpdated={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('settings-tts-server-lang-voices')).toBeTruthy();
    });

    const enSelect = screen.getByTestId('settings-tts-lang-voice-en') as HTMLSelectElement;
    const jaSelect = screen.getByTestId('settings-tts-lang-voice-ja') as HTMLSelectElement;
    const ruSelect = screen.getByTestId('settings-tts-lang-voice-ru') as HTMLSelectElement;
    await waitFor(() => {
      expect(jaSelect.value).toBe('ja-JP-NanamiNeural');
      expect(Array.from(enSelect.options).some((opt) => opt.value === 'en-GB-SoniaNeural')).toBe(true);
      expect(enSelect.options[0]?.textContent).toBe('settings.tts_lang_voice_auto_matched');
      expect(ruSelect.options[0]?.textContent).toBe('settings.tts_lang_voice_auto_fallback');
    });

    // Choose explicit en override and revert ja back to auto
    fireEvent.change(enSelect, { target: { value: 'en-GB-SoniaNeural' } });
    fireEvent.change(jaSelect, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('settings-tts-server-save'));

    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith(expect.objectContaining({
        voice: 'zh-CN-XiaoxiaoNeural',
        voicesByLang: {
          'zh-CN': '',
          'zh-TW': '',
          en: 'en-GB-SoniaNeural',
          ja: '',
          ko: '',
          es: '',
          ru: '',
        },
      }));
    });
  });

  it('auditions default and per-language voices in SettingsPage and TtsQuickSettingsPopover without saving and supports force refresh', async () => {
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    const origAudio = globalThis.Audio;
    URL.createObjectURL = vi.fn(() => 'blob:mock/preview');
    URL.revokeObjectURL = vi.fn();
    let lastAudioInstance: { onended: (() => void) | null } | null = null;
    class MockAudio {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = vi.fn(async () => {
        lastAudioInstance = this;
      });
      pause = vi.fn();
    }
    vi.stubGlobal('Audio', MockAudio);

    try {
      mockApi.getServerTtsConfig.mockResolvedValueOnce({
        mode: 'server',
        baseUrl: '',
        hasApiKey: false,
        apiKeyMasked: null,
        model: 'tts-1',
        voice: 'zh-CN-XiaoxiaoNeural',
        voicesByLang: {},
        responseFormat: 'mp3',
        serverDefaultConfigured: true,
      });
      mockApi.getServerTtsVoices.mockResolvedValue({
        voices: [
          { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', locale: 'zh-CN' },
          { id: 'zh-CN-YunxiNeural', name: 'Yunxi', locale: 'zh-CN' },
          { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US' },
          { id: 'ja-JP-NanamiNeural', name: 'Nanami', locale: 'ja-JP' },
        ],
        source: 'upstream',
        endpointConfigured: true,
      });

      const settingsRender = render(
        <SettingsPage
          displayName="Tester"
          username="tester"
          hasPassword={true}
          onBack={() => {}}
          onDisplayNameChanged={() => {}}
          onUserAuthUpdated={() => {}}
        />,
      );

      const voiceSelect = await screen.findByTestId('settings-tts-server-voice-select') as HTMLSelectElement;
      await waitFor(() => {
        expect(Array.from(voiceSelect.options).some((opt) => opt.value === 'zh-CN-YunxiNeural')).toBe(true);
      });

      // Refresh button triggers forceRefresh (?refresh=1)
      fireEvent.click(screen.getByTestId('settings-tts-server-refresh-voices'));
      await waitFor(() => {
        expect(mockApi.getServerTtsVoices).toHaveBeenCalledWith({ refresh: true });
      });

      // Change default voice WITHOUT saving and audition it
      fireEvent.change(voiceSelect, { target: { value: 'zh-CN-YunxiNeural' } });
      fireEvent.click(screen.getByTestId('settings-tts-server-voice-preview'));
      await waitFor(() => {
        expect(mockApi.synthesizeServerTtsSpeech).toHaveBeenCalledWith(
          expect.objectContaining({ voice: 'zh-CN-YunxiNeural', lang: 'zh-CN' }),
          expect.anything(),
        );
        expect(screen.getByTestId('settings-tts-server-voice-preview').textContent).toContain('settings.tts_preview_stop');
      });

      // Repeat click stops preview cleanly
      fireEvent.click(screen.getByTestId('settings-tts-server-voice-preview'));
      await waitFor(() => {
        expect(screen.getByTestId('settings-tts-server-voice-preview').textContent).toContain('settings.tts_preview_voice');
      });

      // Per-language preview auditions selected / auto-matched voice in that language
      mockApi.synthesizeServerTtsSpeech.mockClear();
      fireEvent.click(screen.getByTestId('settings-tts-lang-voice-preview-ja'));
      await waitFor(() => {
        expect(mockApi.synthesizeServerTtsSpeech).toHaveBeenCalledWith(
          expect.objectContaining({ voice: 'ja-JP-NanamiNeural', lang: 'ja' }),
          expect.anything(),
        );
      });
      lastAudioInstance?.onended?.();
      settingsRender.unmount();

      // Quick popover preview button auditions currentServerVoice
      mockApi.synthesizeServerTtsSpeech.mockClear();
      applyServerTtsConfig({
        mode: 'server',
        baseUrl: '',
        hasApiKey: false,
        apiKeyMasked: null,
        model: 'tts-1',
        voice: 'en-US-AriaNeural',
        responseFormat: 'mp3',
        serverDefaultConfigured: true,
      });
      const anchorRef = { current: document.createElement('div') };
      render(<TtsQuickSettingsPopover anchorRef={anchorRef} onClose={() => {}} />);
      const quickPreviewBtn = await screen.findByTestId('chat-tts-settings-voice-preview');
      fireEvent.click(quickPreviewBtn);
      await waitFor(() => {
        expect(mockApi.synthesizeServerTtsSpeech).toHaveBeenCalledWith(
          expect.objectContaining({ voice: 'en-US-AriaNeural', lang: 'en' }),
          expect.anything(),
        );
      });
      lastAudioInstance?.onended?.();
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
      vi.stubGlobal('Audio', origAudio);
    }
  });
});
