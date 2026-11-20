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
}));

vi.mock('../../src/api.js', () => ({
  apiFetch: vi.fn().mockResolvedValue({ servers: [], machines: [] }),
  getServerTtsConfig: (...args: unknown[]) => mockApi.getServerTtsConfig(...args),
  updateServerTtsConfig: (...args: unknown[]) => mockApi.updateServerTtsConfig(...args),
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
  mockApi.getServerTtsConfig.mockClear();
  mockApi.updateServerTtsConfig.mockClear();
  mockApi.getServerTtsConfig.mockResolvedValue({
    mode: 'system',
    baseUrl: '',
    hasApiKey: false,
    apiKeyMasked: null,
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    responseFormat: 'mp3',
    serverDefaultConfigured: false,
  });
  mockApi.updateServerTtsConfig.mockImplementation(async (body: Record<string, unknown>) => ({
    ok: true,
    config: {
      mode: body.mode ?? 'server',
      baseUrl: body.baseUrl ?? 'http://127.0.0.1:8880/v1',
      hasApiKey: body.apiKey === '' ? false : (body.apiKey !== undefined ? Boolean(body.apiKey) : true),
      apiKeyMasked: body.apiKey === '' ? null : 'sk-1...7890',
      model: body.model ?? 'gpt-4o-mini-tts',
      voice: body.voice ?? 'alloy',
      responseFormat: body.responseFormat ?? 'mp3',
      serverDefaultConfigured: false,
    },
  }));
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

  it('configures server TTS settings, persists via API, and clears stored API key', async () => {
    mockApi.getServerTtsConfig.mockResolvedValueOnce({
      mode: 'system',
      baseUrl: 'http://127.0.0.1:8880/v1',
      hasApiKey: true,
      apiKeyMasked: 'sk-o...9999',
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
        responseFormat: 'wav',
      });
    });

    fireEvent.click(screen.getByTestId('settings-tts-server-clear-key'));
    await waitFor(() => {
      expect(mockApi.updateServerTtsConfig).toHaveBeenCalledWith({ apiKey: '' });
    });
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
});
