import { describe, expect, it } from 'vitest';
import {
  UI_LOCALES,
  UI_LOCALE_DEFAULT,
  UI_LOCALE_FOLLOW_SYSTEM,
  isUiLocale,
  matchUiLocale,
  resolveUiLocale,
  systemLanguagesOf,
  uiLocaleFromPreference,
} from '../../shared/ui-locale.js';

describe('matchUiLocale', () => {
  it('maps each offered language by its primary subtag, any region', () => {
    expect(matchUiLocale('en')).toBe('en');
    expect(matchUiLocale('en-GB')).toBe('en');
    expect(matchUiLocale('es-419')).toBe('es');
    expect(matchUiLocale('es_MX')).toBe('es');
    expect(matchUiLocale('ru-RU')).toBe('ru');
    expect(matchUiLocale('ja-JP')).toBe('ja');
    expect(matchUiLocale('ko-KR')).toBe('ko');
  });
  it('splits Chinese into Simplified and Traditional', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN', 'zh-Hans-HK', 'zh_cn', 'ZH-cn']) expect(matchUiLocale(tag), tag).toBe('zh-CN');
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh-Hant-CN', 'zh_tw', 'ZH-hk']) expect(matchUiLocale(tag), tag).toBe('zh-TW');
  });
  it('lets a script subtag beat the region', () => {
    expect(matchUiLocale('zh-Hans-TW')).toBe('zh-CN');
    expect(matchUiLocale('zh-Hant-CN')).toBe('zh-TW');
  });
  it('does not pretend to know other languages or junk', () => {
    for (const tag of ['de', 'fr-FR', 'pt-BR', 'und', 'x-private', '', '   ', '-', 'zhx', 'english', 12, null, undefined, {}, []]) expect(matchUiLocale(tag), String(tag)).toBeNull();
  });
});

describe('resolveUiLocale', () => {
  it('takes the first language in the list that is offered', () => {
    expect(resolveUiLocale(['ja-JP', 'en-US'])).toBe('ja');
    expect(resolveUiLocale(['zh-Hant-TW', 'zh-CN', 'en'])).toBe('zh-TW');
  });
  it('skips a language that is not offered in favour of a later one that is', () => {
    expect(resolveUiLocale(['de-DE', 'fr', 'ko-KR', 'en'])).toBe('ko');
    expect(resolveUiLocale(['pt-BR', 'es-ES'])).toBe('es');
  });
  it('falls back to English for nothing, nonsense or no match', () => {
    for (const input of [[], ['und'], ['de', 'fr', 'it'], [''], undefined, null, 'und', '', [null, 4, {}]]) expect(resolveUiLocale(input as never), JSON.stringify(input)).toBe(UI_LOCALE_DEFAULT);
  });
  it('accepts a single tag as a string', () => {
    expect(resolveUiLocale('ru')).toBe('ru');
    expect(resolveUiLocale('zh-HK')).toBe('zh-TW');
  });
});

describe('uiLocaleFromPreference', () => {
  it('an explicit locale beats the system languages', () => {
    expect(uiLocaleFromPreference('ru', ['ja'])).toBe('ru');
    expect(uiLocaleFromPreference('zh-TW', ['zh-CN'])).toBe('zh-TW');
  });
  it('"system", missing and junk preferences follow the system languages', () => {
    for (const preference of [UI_LOCALE_FOLLOW_SYSTEM, undefined, null, '', 'klingon', 3, {}]) expect(uiLocaleFromPreference(preference, ['ko-KR', 'en']), String(preference)).toBe('ko');
    expect(uiLocaleFromPreference('system', [])).toBe('en');
  });
});

describe('isUiLocale and systemLanguagesOf', () => {
  it('recognises exactly the seven offered locales', () => {
    expect(UI_LOCALES).toEqual(['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko']);
    for (const locale of UI_LOCALES) expect(isUiLocale(locale)).toBe(true);
    for (const value of ['zh', 'zh-cn', 'EN', 'system', '', null, 4]) expect(isUiLocale(value)).toBe(false);
  });
  it('prefers navigator.languages and falls back to navigator.language', () => {
    expect(systemLanguagesOf({ languages: ['ja', 'en'], language: 'ja' })).toEqual(['ja', 'en']);
    expect(systemLanguagesOf({ languages: [], language: 'ko' })).toEqual(['ko']);
    expect(systemLanguagesOf({ language: 'ru-RU' })).toEqual(['ru-RU']);
    expect(systemLanguagesOf({})).toEqual([]);
    expect(systemLanguagesOf(null)).toEqual([]);
  });
});
