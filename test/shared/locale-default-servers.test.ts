import { describe, expect, it, vi } from 'vitest';
import {
  formatLocaleDefaultServersForBuild,
  localeMatchesRule,
  normalizeDefaultServerOrigin,
  parseLocaleDefaultServers,
  PRIMARY_DEFAULT_SERVER_ORIGIN,
  resolveLocaleDefaultServers,
} from '../../shared/locale-default-servers.js';

describe('shared/locale-default-servers', () => {
  it('parses array format (locales and locale shorthand) and normalizes origins', () => {
    const raw = JSON.stringify([
      { url: 'https://cn.example.com/app?x=1#y', locales: ['zh'], label: 'China Relay' },
      { url: 'https://tw.example.com/', locale: 'zh-TW', label: 'Taiwan Relay' },
      { url: 'http://localhost:8787/dev', locales: ['en'] },
    ]);
    expect(parseLocaleDefaultServers(raw)).toEqual([
      { url: 'https://cn.example.com', locales: ['zh'], label: 'China Relay' },
      { url: 'https://tw.example.com', locales: ['zh-tw'], label: 'Taiwan Relay' },
      { url: 'http://localhost:8787', locales: ['en'] },
    ]);
  });

  it('parses compact locale map format and merges duplicate origins across keys', () => {
    const raw = JSON.stringify({
      zh: 'https://cn.example.com/',
      'zh-CN': ['https://cn.example.com', 'https://cn2.example.com'],
      ja: [{ url: 'https://jp.example.com', label: 'Japan' }],
    });
    expect(parseLocaleDefaultServers(raw)).toEqual([
      { url: 'https://cn.example.com', locales: ['zh', 'zh-cn'] },
      { url: 'https://cn2.example.com', locales: ['zh-cn'] },
      { url: 'https://jp.example.com', locales: ['ja'], label: 'Japan' },
    ]);
  });

  it('rejects insecure, credential-bearing, malformed, and primary default URLs', () => {
    const warn = vi.fn();
    expect(parseLocaleDefaultServers(undefined)).toEqual([]);
    expect(parseLocaleDefaultServers('   ')).toEqual([]);
    expect(parseLocaleDefaultServers('{bad json', { onWarning: warn })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    const mixed = JSON.stringify([
      { url: 'https://app.im.codes/', locales: ['zh'] },
      { url: 'HTTPS://APP.IM.CODES', locales: ['en'] },
      { url: 'http://insecure.example.com', locales: ['zh'] },
      { url: 'javascript:alert(1)', locales: ['zh'] },
      { url: 'https://user:pass@secret.example.com', locales: ['zh'] },
      { url: 'https://valid.example.com', locales: [] },
      { url: 'https://valid.example.com', locales: ['zh-CN'] },
    ]);
    expect(formatLocaleDefaultServersForBuild(mixed)).toEqual([
      { url: 'https://valid.example.com', locales: ['zh-cn'] },
    ]);
    expect(normalizeDefaultServerOrigin(PRIMARY_DEFAULT_SERVER_ORIGIN)).toBeNull();
  });

  it('matches BCP-47 locales accurately for zh, zh-CN, zh-TW, and other tags', () => {
    expect(localeMatchesRule('zh', ['zh'])).toBe(true);
    expect(localeMatchesRule('zh-CN', ['zh'])).toBe(true);
    expect(localeMatchesRule('zh_TW', ['zh'])).toBe(true);
    expect(localeMatchesRule('zh-Hans-CN', ['zh'])).toBe(true);
    expect(localeMatchesRule('zh-Hant', ['zh'])).toBe(true);
    expect(localeMatchesRule('en-US', ['zh'])).toBe(false);

    expect(localeMatchesRule('zh-CN', ['zh-CN'])).toBe(true);
    expect(localeMatchesRule('zh-Hans', ['zh-CN'])).toBe(true);
    expect(localeMatchesRule('zh-Hans-CN', ['zh-CN'])).toBe(true);
    expect(localeMatchesRule('zh-TW', ['zh-CN'])).toBe(false);
    expect(localeMatchesRule('zh-Hant', ['zh-CN'])).toBe(false);
    expect(localeMatchesRule('zh-HK', ['zh-CN'])).toBe(false);

    expect(localeMatchesRule('zh-TW', ['zh-TW'])).toBe(true);
    expect(localeMatchesRule('zh-Hant', ['zh-TW'])).toBe(true);
    expect(localeMatchesRule('zh-HK', ['zh-TW'])).toBe(true);
    expect(localeMatchesRule('zh-MO', ['zh-TW'])).toBe(true);
    expect(localeMatchesRule('zh-CN', ['zh-TW'])).toBe(false);
    expect(localeMatchesRule('zh-Hans', ['zh-TW'])).toBe(false);

    expect(localeMatchesRule('ja-JP', ['ja'])).toBe(true);
    expect(localeMatchesRule('en-US', ['en'])).toBe(true);
    expect(localeMatchesRule('en-GB', ['en-US'])).toBe(false);
    expect(localeMatchesRule('en-US', ['en-US'])).toBe(true);
  });

  it('resolveLocaleDefaultServers filters by locale and deduplicates origins', () => {
    const rules = parseLocaleDefaultServers(JSON.stringify([
      { url: 'https://cn.example.com', locales: ['zh'], label: 'CN' },
      { url: 'https://hk.example.com', locales: ['zh-TW'] },
      { url: 'https://jp.example.com', locales: ['ja'] },
    ]));
    expect(resolveLocaleDefaultServers(rules, 'zh-CN')).toEqual([
      { url: 'https://cn.example.com', locales: ['zh'], label: 'CN' },
    ]);
    expect(resolveLocaleDefaultServers(rules, 'zh-TW')).toEqual([
      { url: 'https://cn.example.com', locales: ['zh'], label: 'CN' },
      { url: 'https://hk.example.com', locales: ['zh-tw'] },
    ]);
    expect(resolveLocaleDefaultServers(rules, 'en')).toEqual([]);
  });
});
