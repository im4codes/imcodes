/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { SettingsPage } from '../../src/pages/SettingsPage.js';
import {
  getTtsAutoReadEnabled,
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

vi.mock('../../src/api.js', () => ({
  apiFetch: vi.fn().mockResolvedValue({ servers: [], machines: [] }),
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
    isIosNativePlatform: () => mockState.iosNative,
  };
});

vi.mock('../../src/tts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tts.js')>();
  return {
    ...actual,
    getNativeTtsVoiceQuality: vi.fn(async () => mockState.voiceQuality),
  };
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
    i18n: { language: 'en' },
  }),
}));

describe('SettingsPage TTS preferences & 7-locale parity', () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.iosNative = false;
    mockState.voiceQuality = null;
  });

  afterEach(async () => {
    cleanup();
    await __resetTtsForTests();
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

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(getTtsAutoReadEnabled()).toBe(true);

    const rateBtn = screen.getByTestId('settings-tts-rate-1.5');
    fireEvent.click(rateBtn);
    expect(rateBtn.getAttribute('aria-pressed')).toBe('true');
    expect(getTtsSpeechRate()).toBe(1.5);
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
});
