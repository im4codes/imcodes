import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';

const locales = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW } as Record<string, { remote_desktop: Record<string, string> }>;

const REQUIRED = ['window_blocked', 'window_blocked_dismiss'];

const NOTICE_TEXT: Record<string, string> = {
  en: 'Your browser blocked the remote desktop window. Allow pop-ups for this site and try again.',
  es: 'El navegador bloqueó la ventana del escritorio remoto. Permite las ventanas emergentes de este sitio e inténtalo de nuevo.',
  ja: 'ブラウザがリモートデスクトップのウィンドウをブロックしました。このサイトのポップアップを許可してもう一度お試しください。',
  ko: '브라우저가 원격 데스크톱 창을 차단했습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.',
  ru: 'Браузер заблокировал окно удалённого рабочего стола. Разрешите всплывающие окна для этого сайта и повторите попытку.',
  'zh-CN': '浏览器拦截了远程桌面窗口。请允许本站弹出窗口后重试。',
  'zh-TW': '瀏覽器封鎖了遠端桌面視窗。請允許本網站的彈出視窗後重試。',
};

describe('blocked-window texts without installation guidance', () => {
  it.each(Object.keys(locales))('%s keeps translated popup advice and dismissal, not installation guidance', (locale) => {
    const text = locales[locale]!.remote_desktop;
    expect(text.window_blocked).toBe(NOTICE_TEXT[locale]);
    expect(text.window_blocked_dismiss?.trim()).toBeTruthy();
    expect(Object.keys(text).filter(key => key === 'install_app' || key === 'install_app_hint' || key.startsWith('install_guide_'))).toEqual([]);
  });

  it('is translated, not the English text copied into the other six languages', () => {
    for (const locale of Object.keys(locales).filter((name) => name !== 'en')) {
      for (const key of REQUIRED) expect(locales[locale]!.remote_desktop[key]).not.toBe(locales.en!.remote_desktop[key]);
    }
  });

  it('provides all localized labels used by the remaining blocked-window notice', () => {
    const source = readFileSync(resolve(__dirname, '../src/components/RemoteDesktopWindowBlockedNotice.tsx'), 'utf8');
    const used = [...source.matchAll(/t\('remote_desktop\.([a-z_]+)'\)/g)].map(match => match[1]);
    expect(used.sort()).toEqual([...REQUIRED].sort());
  });
});
