/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { SettingsPage } from '../../src/pages/SettingsPage.js';
import {
  getTtsAutoReadEnabled,
  getTtsSpeechRate,
  __resetTtsForTests,
} from '../../src/tts.js';

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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

describe('SettingsPage TTS preferences & 7-locale parity', () => {
  beforeEach(() => {
    localStorage.clear();
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
      expect(json.settings?.tts_title, `${locale} settings.tts_title`).toBeTruthy();
      expect(json.settings?.tts_auto_read, `${locale} settings.tts_auto_read`).toBeTruthy();
      expect(json.settings?.tts_auto_read_desc, `${locale} settings.tts_auto_read_desc`).toBeTruthy();
      expect(json.settings?.tts_rate, `${locale} settings.tts_rate`).toBeTruthy();
      expect(json.settings?.tts_rate_desc, `${locale} settings.tts_rate_desc`).toBeTruthy();
    }
  });
});
