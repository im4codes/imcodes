import { describe, expect, it } from 'vitest';
import { detectUiLanguage } from '../src/i18n/detect-language.js';

describe('detectUiLanguage', () => {
  it('uses the whole preference list, not just the first language', () => {
    expect(detectUiLanguage({ languages: ['de-DE', 'ja-JP', 'en'], language: 'de-DE' })).toBe('ja');
  });
  it('splits Chinese by script and region', () => {
    expect(detectUiLanguage({ languages: ['zh-Hant'], language: 'zh-Hant' })).toBe('zh-TW');
    expect(detectUiLanguage({ languages: ['zh-HK'], language: 'zh-HK' })).toBe('zh-TW');
    expect(detectUiLanguage({ languages: ['zh-Hans-CN'], language: 'zh-Hans-CN' })).toBe('zh-CN');
    expect(detectUiLanguage({ language: 'zh' })).toBe('zh-CN');
  });
  it('falls back to English for an unknown, empty or missing language', () => {
    expect(detectUiLanguage({ languages: ['und'], language: 'und' })).toBe('en');
    expect(detectUiLanguage({ languages: [], language: '' })).toBe('en');
    expect(detectUiLanguage(null)).toBe('en');
  });
  it('reads this browser by default', () => {
    expect(['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']).toContain(detectUiLanguage());
  });
});
