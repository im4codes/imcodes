import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import es from './locales/es.json';
import ru from './locales/ru.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

const savedLang = (() => {
  try { return localStorage.getItem('imcodes_lang') ?? undefined; } catch { return undefined; }
})();

function detectLang(): string {
  const nav = navigator.language;
  if (nav.startsWith('zh-TW') || nav.startsWith('zh-HK') || nav.startsWith('zh-MO')) return 'zh-TW';
  if (nav.startsWith('zh')) return 'zh-CN';
  if (nav.startsWith('es')) return 'es';
  if (nav.startsWith('ru')) return 'ru';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('ko')) return 'ko';
  return 'en';
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      es: { translation: es },
      ru: { translation: ru },
      ja: { translation: ja },
      ko: { translation: ko },
    },
    lng: savedLang ?? detectLang(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

export default i18n;
