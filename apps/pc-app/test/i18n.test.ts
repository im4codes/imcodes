import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BindCoordinator, inspectMacosLaunchAgentPlist } from '../src/bind.js';
import {
  PC_APP_LOCALES,
  PC_APP_MESSAGES,
  PcAppLocaleStore,
  normalizePcAppLocale,
  parseLocaleCookieValue,
  tPcApp,
} from '../src/i18n.js';
import {
  buildServerPromptDataUrl,
  buildWelcomeDataUrl,
  openAddServerPrompt,
} from '../src/server-prompt.js';

describe('PC App i18n normalization, completeness, persistence, and UI localization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-app-i18n-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes all 7 locales and regional variants and fails safely to en', () => {
    expect(normalizePcAppLocale('en')).toBe('en');
    expect(normalizePcAppLocale('en-GB')).toBe('en');
    expect(normalizePcAppLocale('zh')).toBe('zh-CN');
    expect(normalizePcAppLocale('zh-CN')).toBe('zh-CN');
    expect(normalizePcAppLocale('zh_Hans_CN')).toBe('zh-CN');
    expect(normalizePcAppLocale('zh-SG')).toBe('zh-CN');
    expect(normalizePcAppLocale('zh-TW')).toBe('zh-TW');
    expect(normalizePcAppLocale('zh-Hant')).toBe('zh-TW');
    expect(normalizePcAppLocale('zh-HK')).toBe('zh-TW');
    expect(normalizePcAppLocale('zh-MO')).toBe('zh-TW');
    expect(normalizePcAppLocale('es')).toBe('es');
    expect(normalizePcAppLocale('es-MX')).toBe('es');
    expect(normalizePcAppLocale('ru')).toBe('ru');
    expect(normalizePcAppLocale('ru-RU')).toBe('ru');
    expect(normalizePcAppLocale('ja')).toBe('ja');
    expect(normalizePcAppLocale('ja-JP')).toBe('ja');
    expect(normalizePcAppLocale('ko')).toBe('ko');
    expect(normalizePcAppLocale('ko-KR')).toBe('ko');

    expect(normalizePcAppLocale('')).toBe('en');
    expect(normalizePcAppLocale(null)).toBe('en');
    expect(normalizePcAppLocale(undefined)).toBe('en');
    expect(normalizePcAppLocale('fr-FR')).toBe('en');
    expect(normalizePcAppLocale('xx-YY')).toBe('en');
    expect(normalizePcAppLocale('%ZZ')).toBe('en');
  });

  it('parses imcodes_lang cookie values safely without throwing on malformed or empty inputs', () => {
    expect(parseLocaleCookieValue('zh-CN')).toBe('zh-CN');
    expect(parseLocaleCookieValue('zh%2DTW')).toBe('zh-TW');
    expect(parseLocaleCookieValue('ja-JP')).toBe('ja');
    expect(parseLocaleCookieValue('xx-YY')).toBe('en');
    expect(parseLocaleCookieValue('%ZZ')).toBeNull();
    expect(parseLocaleCookieValue('')).toBeNull();
    expect(parseLocaleCookieValue('   ')).toBeNull();
    expect(parseLocaleCookieValue(null)).toBeNull();
  });

  it('has complete non-empty translations and matching template variables across all 7 locales', () => {
    const baseKeys = Object.keys(PC_APP_MESSAGES.en) as Array<keyof typeof PC_APP_MESSAGES.en>;
    const extractVars = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/gu)].map((m) => m[1]).sort();

    for (const locale of PC_APP_LOCALES) {
      const table = PC_APP_MESSAGES[locale];
      expect(Object.keys(table).sort()).toEqual([...baseKeys].sort());
      for (const key of baseKeys) {
        const value = table[key];
        expect(typeof value, `${locale}.${key}`).toBe('string');
        expect(value.trim().length, `${locale}.${key} non-empty`).toBeGreaterThan(0);
        expect(extractVars(value), `${locale}.${key} vars`).toEqual(extractVars(PC_APP_MESSAGES.en[key]));
      }
    }

    expect(tPcApp('zh-CN', 'dialog.removeServer.message', { origin: 'https://a.example' })).toContain(
      'https://a.example',
    );
  });

  it('persists locale.json atomically and fails soft on corrupt or unwritable storage', () => {
    const store = new PcAppLocaleStore(tempDir);
    expect(store.load()).toBeNull();

    for (const locale of PC_APP_LOCALES) {
      store.save(locale);
      expect(store.load()).toBe(locale);
    }

    writeFileSync(path.join(tempDir, 'locale.json'), '{not-valid-json');
    expect(store.load()).toBeNull();

    writeFileSync(path.join(tempDir, 'locale.json'), JSON.stringify({ version: 1, locale: 'xx-YY' }));
    expect(store.load()).toBeNull();

    const blockerFile = path.join(tempDir, 'not-a-dir');
    writeFileSync(blockerFile, 'file');
    const unwritable = new PcAppLocaleStore(blockerFile);
    expect(() => unwritable.save('ja')).not.toThrow();
    expect(unwritable.load()).toBeNull();
  });

  it('renders welcome screen and add-server prompt in all 7 locales', () => {
    for (const locale of PC_APP_LOCALES) {
      const welcomeHtml = decodeURIComponent(
        buildWelcomeDataUrl({ locale }).replace('data:text/html;charset=utf-8,', ''),
      );
      expect(welcomeHtml).toContain(`<html lang="${locale}">`);
      expect(welcomeHtml).toContain(tPcApp(locale, 'welcome.subtitle'));
      expect(welcomeHtml).toContain(tPcApp(locale, 'welcome.connect'));

      const promptHtml = decodeURIComponent(
        buildServerPromptDataUrl({ locale }).replace('data:text/html;charset=utf-8,', ''),
      );
      expect(promptHtml).toContain(`<html lang="${locale}">`);
      expect(promptHtml).toContain(tPcApp(locale, 'prompt.heading'));
      expect(promptHtml).toContain(tPcApp(locale, 'common.cancel'));
    }

    let modalTitle = '';
    const wc = new EventEmitter() as EventEmitter & {
      setWindowOpenHandler: (fn: (d: { url: string }) => { action: 'deny' }) => void;
    };
    wc.setWindowOpenHandler = vi.fn();
    const modalEmitter = new EventEmitter();
    void openAddServerPrompt(
      (opts) => {
        modalTitle = opts.title;
        return {
          isDestroyed: () => false,
          close: () => modalEmitter.emit('closed'),
          loadURL: () => {},
          on: (ev, fn) => modalEmitter.on(ev, fn),
          webContents: wc,
        };
      },
      { locale: 'ja' },
    );
    expect(modalTitle).toBe(tPcApp('ja', 'prompt.heading'));
    modalEmitter.emit('closed');
  });

  it('localizes BindCoordinator dialogs and inspectMacosLaunchAgentPlist while preserving en default', async () => {
    const plistPath = path.join(tempDir, 'imcodes.daemon.plist');
    writeFileSync(
      plistPath,
      `<plist><dict><key>ProgramArguments</key><array><string>/missing/node</string></array></dict></plist>`,
    );

    const enIssue = inspectMacosLaunchAgentPlist({ platform: 'darwin', plistPath });
    expect(enIssue.warningMessage).toContain('cannot start');

    const jaIssue = inspectMacosLaunchAgentPlist({ platform: 'darwin', plistPath, locale: 'ja' });
    expect(jaIssue.warningTitle).toBe(tPcApp('ja', 'launchAgent.missing.title'));
    expect(jaIssue.warningMessage).toBe(tPcApp('ja', 'launchAgent.missing.progMessage'));

    const messageBoxes: Array<{ title: string; buttons: string[] }> = [];
    const coord = new BindCoordinator({
      platform: 'darwin',
      locale: 'zh-CN',
      getCurrentTrustedOrigin: () => null,
      onDidNavigateTrustedOrigin: () => () => {},
      showMessageBox: async (opts) => {
        messageBoxes.push({ title: opts.title, buttons: opts.buttons });
        return { response: 0 };
      },
      showNotification: () => {},
    });

    await coord.triggerManualBind();
    expect(messageBoxes[0]).toEqual({
      title: tPcApp('zh-CN', 'bind.manual.noOrigin.title'),
      buttons: [tPcApp('zh-CN', 'common.ok')],
    });

    coord.setLocale('ko');
    await coord.triggerManualBind();
    expect(messageBoxes[1]).toEqual({
      title: tPcApp('ko', 'bind.manual.noOrigin.title'),
      buttons: [tPcApp('ko', 'common.ok')],
    });
  });
});
