import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadPcAppBuildConfig,
  localeMatchesRule as pcAppLocaleMatchesRule,
  resetPcAppBuildConfigCacheForTests,
} from '../src/build-config.js';
import {
  buildWelcomeDataUrl,
  DEFAULT_SERVER_ORIGIN,
  getDefaultServerOrigins,
  isDefaultServerOrigin,
} from '../src/server-prompt.js';
// @ts-expect-error ESM script module
import { writePcAppBuildConfig } from '../scripts/write-build-config.mjs';
import { localeMatchesRule as sharedLocaleMatchesRule } from '../../../shared/locale-default-servers.js';

describe('PC App locale-default servers and build-config', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    resetPcAppBuildConfigCacheForTests();
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('writes dist/build-config.json cleanly from IMCODES_LOCALE_DEFAULT_SERVERS and handles unset/malformed env', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-build-cfg-'));
    tempDirs.push(dir);
    const outFile = path.join(dir, 'dist', 'build-config.json');

    const emptyPayload = writePcAppBuildConfig({ env: {}, outFile });
    expect(emptyPayload).toEqual({ localeDefaultServers: [] });
    expect(loadPcAppBuildConfig(outFile)).toEqual({ localeDefaultServers: [] });

    const warn = vi.fn();
    const badPayload = writePcAppBuildConfig({
      env: { IMCODES_LOCALE_DEFAULT_SERVERS: '{broken' },
      outFile,
      onWarning: warn,
    });
    expect(badPayload).toEqual({ localeDefaultServers: [] });
    expect(warn).toHaveBeenCalledTimes(1);

    const payload = writePcAppBuildConfig({
      env: {
        IMCODES_LOCALE_DEFAULT_SERVERS: JSON.stringify([
          { url: 'https://cn.example.com/path', locales: ['zh'], label: 'China Relay' },
          { url: 'https://app.im.codes/', locales: ['zh'] },
          { url: 'http://insecure.example.com', locales: ['zh'] },
        ]),
      },
      outFile,
    });
    expect(payload).toEqual({
      localeDefaultServers: [
        { url: 'https://cn.example.com', locales: ['zh'], label: 'China Relay' },
      ],
    });
    expect(JSON.parse(readFileSync(outFile, 'utf8'))).toEqual(payload);
    expect(loadPcAppBuildConfig(outFile)).toEqual(payload);
  });

  it('returns empty rules cleanly when build-config.json is missing or invalid', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-build-cfg-missing-'));
    tempDirs.push(dir);
    expect(loadPcAppBuildConfig(path.join(dir, 'missing.json'))).toEqual({ localeDefaultServers: [] });

    const corrupt = path.join(dir, 'corrupt.json');
    writeFileSync(corrupt, 'not json', 'utf8');
    expect(loadPcAppBuildConfig(corrupt)).toEqual({ localeDefaultServers: [] });
  });

  it('matches shared/locale-default-servers BCP-47 rules across zh, zh-CN, zh-TW, and non-matching locales', () => {
    const cases: Array<[string, string[]]> = [
      ['zh-CN', ['zh']],
      ['zh-TW', ['zh']],
      ['zh-Hans', ['zh-CN']],
      ['zh-TW', ['zh-CN']],
      ['zh-HK', ['zh-TW']],
      ['zh-CN', ['zh-TW']],
      ['en-US', ['zh']],
      ['ja-JP', ['ja']],
    ];
    for (const [locale, ruleLocales] of cases) {
      expect(pcAppLocaleMatchesRule(locale, ruleLocales)).toBe(sharedLocaleMatchesRule(locale, ruleLocales));
    }
  });

  it('includes matching locale defaults on Welcome screen with default badge, no remove link, HTML-escaped label, and hides them when locale differs', () => {
    const rules = [
      { url: 'https://cn.example.com', locales: ['zh'], label: 'China <Relay> & "CN"' },
      { url: 'https://tw.example.com', locales: ['zh-tw'], label: 'TW Relay' },
    ];

    expect(getDefaultServerOrigins('zh-CN', rules)).toEqual([
      DEFAULT_SERVER_ORIGIN,
      'https://cn.example.com',
    ]);
    expect(isDefaultServerOrigin('https://cn.example.com', 'zh-CN', rules)).toBe(true);
    expect(isDefaultServerOrigin('https://cn.example.com', 'en', rules)).toBe(false);

    const zhHtml = decodeURIComponent(
      buildWelcomeDataUrl({
        locale: 'zh-CN',
        localeDefaultServers: rules,
        servers: [{ origin: 'https://custom.example.com', label: 'Custom', addedAt: 1 }],
      }).replace('data:text/html;charset=utf-8,', ''),
    );
    expect(zhHtml).toContain('https://app.im.codes');
    expect(zhHtml).toContain('https://cn.example.com');
    expect(zhHtml).not.toContain('https://tw.example.com');
    expect(zhHtml).toContain('China &lt;Relay&gt; &amp; &quot;CN&quot; · 官方默认');
    expect(zhHtml).not.toContain('China <Relay>');
    expect(zhHtml).not.toContain('https://imcodes-welcome.local/remove?url=https%3A%2F%2Fcn.example.com');
    expect(zhHtml).toContain('https://imcodes-welcome.local/remove?url=https%3A%2F%2Fcustom.example.com');

    const enHtml = decodeURIComponent(
      buildWelcomeDataUrl({
        locale: 'en',
        localeDefaultServers: rules,
      }).replace('data:text/html;charset=utf-8,', ''),
    );
    expect(enHtml).toContain('https://app.im.codes');
    expect(enHtml).not.toContain('https://cn.example.com');
  });
});
