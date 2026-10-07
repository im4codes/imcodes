import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LOCAL_PANEL_WINDOW_TITLE } from '../../shared/local-panel-window.js';
import { localPanelStringsEmbedSource, LOCAL_PANEL_STRINGS, UI_LOCALE_AUTONYMS, localPanelText } from '../../shared/local-panel-strings.js';
import {
  UI_LOCALES, isUiLocale, matchUiLocale, resolveUiLocale, systemLanguagesOf, uiLocaleEmbedSource, uiLocaleFromPreference,
} from '../../shared/ui-locale.js';
import { LOCAL_PANEL_PAGE_CSS } from '../../src/node/local-panel-page-style.js';
import { LOCAL_PANEL_PAGE_SCRIPT } from '../../src/node/local-panel-page-script.js';
import { renderLocalPanelPage } from '../../src/node/local-panel-page.js';

const page = renderLocalPanelPage({ publicNodeId: '1234567890', manageUrl: 'https://example.test/?m=1', shareUrl: 'https://example.test/?s=1', csrf: 'token' });

describe('the panel page is one self-contained document', () => {
  it('has the constant window title and loads nothing from anywhere', () => {
    expect(page).toContain(`<title>${LOCAL_PANEL_WINDOW_TITLE}</title>`);
    // No external script, stylesheet, font, image or frame; the only link is the inline icon.
    expect(page).not.toMatch(/<script[^>]*\ssrc=/iu);
    expect(page).not.toMatch(/<link[^>]*rel=["']?(?:stylesheet|preload|prefetch|modulepreload)/iu);
    expect(page).not.toMatch(/<(?:iframe|img|video|audio|embed|object|source)\b/iu);
    expect(page).not.toMatch(/@import/iu);
    expect(LOCAL_PANEL_PAGE_CSS).not.toMatch(/url\((?!["']?data:)/iu);
    const links = [...page.matchAll(/<link\b[^>]*>/giu)].map((match) => match[0]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/rel="icon" href="data:image\/svg\+xml,/u);
    // Every absolute URL in the document is either the SVG namespace or the node-built management URLs in the bootstrap data.
    const urls = [...page.matchAll(/https?:\/\/[^\s"'<>)\\]+/giu)].map((match) => match[0]).filter((url) => !url.startsWith('http://www.w3.org/'));
    expect(urls.sort()).toEqual(['https://example.test/?m=1', 'https://example.test/?s=1']);
    expect(page).not.toMatch(/<a\b[^>]*\shref=/iu);
  });

  it('puts the bootstrap data in as JSON that cannot close the script element', () => {
    const hostile = renderLocalPanelPage({ publicNodeId: '1</script><script>alert(1)', manageUrl: 'https://x/', shareUrl: 'https://x/', csrf: 'c' });
    expect(hostile).not.toContain('1</script><script>alert(1)');
    expect(hostile.match(/<script>/gu)).toHaveLength(1);
  });

  it('keeps the page shell free of features WKWebView 15 (macOS 12) does not have', () => {
    const forbiddenCss = [':has(', '@container', 'subgrid', 'color-mix(', '@layer', 'dvh', 'svh', 'lvh', 'aspect-ratio', 'inset:', 'accent-color', '@scope', '&:', 'text-wrap'];
    for (const token of forbiddenCss) expect(LOCAL_PANEL_PAGE_CSS, token).not.toContain(token);
    expect(page).not.toMatch(/<dialog\b/iu);
    // No CSS nesting: a style rule may only open inside an @media / @supports block, never inside another style rule.
    const stack: boolean[] = [];
    let prelude = '';
    for (const ch of LOCAL_PANEL_PAGE_CSS) {
      if (ch === '{') {
        const isAt = prelude.trim().startsWith('@');
        if (!isAt && stack.includes(false)) throw new Error(`nested style rule near: ${prelude.trim()}`);
        stack.push(isAt);
        prelude = '';
      } else if (ch === '}') { stack.pop(); prelude = ''; } else if (ch === ';') prelude = '';
      else prelude += ch;
    }
    // The focus ring keeps a fallback for engines without :focus-visible.
    expect(LOCAL_PANEL_PAGE_CSS).toContain(':focus{outline');
    expect(LOCAL_PANEL_PAGE_CSS).toContain(':focus:not(:focus-visible){outline:none}');
  });

  it('keeps the script to syntax and APIs of Safari 15 / WebView2 (no newer operators, methods or top-level await)', () => {
    const script = `${uiLocaleEmbedSource()}\n${localPanelStringsEmbedSource()}\n${LOCAL_PANEL_PAGE_SCRIPT}`;
    const forbidden: Array<[string, RegExp]> = [
      ['logical assignment', /(?:\|\||&&|\?\?)=/u],
      ['private fields', /#[A-Za-z_]\w*\s*[=;(]/u],
      ['static blocks', /static\s*\{/u],
      ['Array.prototype.at', /\.at\(/u],
      ['String.replaceAll', /\.replaceAll\(/u],
      ['Object.hasOwn', /Object\.hasOwn\(/u],
      ['structuredClone', /structuredClone\(/u],
      ['regex lookbehind', /\(\?<[=!]/u],
      ['dynamic import', /\bimport\s*\(/u],
      ['top-level await', /^\s*await\s/mu],
      ['findLast', /\.findLast(?:Index)?\(/u],
      ['Array.prototype.group', /\.group(?:ToMap)?\(/u],
      ['template literal in page script', /`/u],
    ];
    for (const [label, pattern] of forbidden) expect(script, label).not.toMatch(pattern);
    // It must also simply parse and run as a classic script.
    expect(() => new Function(script)).not.toThrow();
  });

  it('answers no fetch to any host but its own origin (only relative paths and window.open of the node-built URLs)', () => {
    expect(LOCAL_PANEL_PAGE_SCRIPT).not.toMatch(/fetch\(\s*['"]https?:/u);
    expect(LOCAL_PANEL_PAGE_SCRIPT).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts/u);
    expect(LOCAL_PANEL_PAGE_SCRIPT).not.toMatch(/location\s*(?:\.href)?\s*=/u);
  });
});

describe('the embedded shared code is the shared code', () => {
  const evaluate = (source: string, expression: string): unknown => runInNewContext(`${source}\n(${expression})`, {}, { timeout: 2_000 });

  it('the system-language resolver, evaluated alone in an empty sandbox, answers exactly like the module', () => {
    const source = uiLocaleEmbedSource();
    const inputs: unknown[] = [
      [], ['en'], ['de', 'ja-JP'], ['zh-Hant'], ['zh-Hant-TW', 'en'], ['zh-HK'], ['zh-MO'], ['zh-SG'], ['zh'], ['zh-Hans-TW'], ['zh-Hant-CN'],
      ['es-419'], ['ru-RU'], ['ko_KR'], ['und'], [''], [null, 4], undefined, null, 'fr', 'ko', ['pt-BR', 'de', 'it', 'ru'],
    ];
    for (const input of inputs) {
      expect(evaluate(source, `resolveUiLocale(${JSON.stringify(input)})`), JSON.stringify(input)).toBe(resolveUiLocale(input as never));
    }
    for (const tag of ['en', 'zh-TW', 'ja', 'xx', 'zh-Hans', '', 7, null]) {
      expect(evaluate(source, `matchUiLocale(${JSON.stringify(tag)})`), String(tag)).toBe(matchUiLocale(tag));
      expect(evaluate(source, `isUiLocale(${JSON.stringify(tag)})`), String(tag)).toBe(isUiLocale(tag));
    }
    for (const preference of ['system', 'ru', 'klingon', null, undefined]) {
      expect(evaluate(source, `uiLocaleFromPreference(${JSON.stringify(preference ?? null)}, ["ko-KR"])`)).toBe(uiLocaleFromPreference(preference ?? null, ['ko-KR']));
    }
    expect(evaluate(source, 'systemLanguagesOf({languages:["a","b"],language:"a"}).join()')).toBe(systemLanguagesOf({ languages: ['a', 'b'], language: 'a' }).join());
    expect(evaluate(source, 'UI_LOCALES.join()')).toBe(UI_LOCALES.join());
    // No hidden dependency on the module: the source refers to nothing outside itself and carries no compiler helper.
    expect(source).not.toMatch(/__name|__publicField|__defProp|require\(|import /u);
  });

  it('the strings table and lookup, evaluated alone, answer exactly like the module for every locale and key', () => {
    const source = localPanelStringsEmbedSource();
    expect(source).not.toMatch(/__name|__publicField|__defProp|require\(|import /u);
    for (const locale of UI_LOCALES) {
      for (const key of Object.keys(LOCAL_PANEL_STRINGS.en)) {
        expect(evaluate(source, `localPanelText(${JSON.stringify(locale)}, ${JSON.stringify(key)}, {n: 3})`), `${locale}.${key}`)
          .toBe(localPanelText(locale, key as never, { n: 3 }));
      }
    }
    expect(evaluate(source, 'UI_LOCALE_AUTONYMS["zh-TW"]')).toBe(UI_LOCALE_AUTONYMS['zh-TW']);
    expect(evaluate(source, 'localPanelText("xx","share")')).toBe('Share');
  });
});

describe('the server-connection banner', () => {
  it('is part of the page, hidden until the node reports an unreachable server, and filled with textContent only', () => {
    expect(page).toContain('id="serverBanner"');
    expect(page).toMatch(/id="serverBanner"[^>]*\shidden>/u);
    expect(LOCAL_PANEL_PAGE_SCRIPT).toContain("$('serverText').textContent = T('serverText'");
    expect(LOCAL_PANEL_PAGE_SCRIPT).not.toMatch(/serverText'\)\.innerHTML/u);
  });

  it('every language has a title, a sentence with {{host}} and {{reason}}, and every reason', () => {
    for (const locale of UI_LOCALES) {
      const text = LOCAL_PANEL_STRINGS[locale].serverText;
      expect(text, locale).toContain('{{host}}');
      expect(text, locale).toContain('{{reason}}');
      expect(localPanelText(locale, 'serverText', { host: 'im.example:443', reason: localPanelText(locale, 'reasonTimeout') }), locale)
        .not.toContain('{{');
      for (const key of ['serverTitle', 'reasonTimeout', 'reasonRefused', 'reasonDns', 'reasonTls', 'reasonReset', 'reasonRejected', 'reasonOther'] as const) {
        expect(LOCAL_PANEL_STRINGS[locale][key].length, `${locale}.${key}`).toBeGreaterThan(2);
      }
    }
  });
});
