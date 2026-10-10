import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import es from './locales/es.json';
import ru from './locales/ru.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import { installTranslationCache } from './translation-cache.js';
import { detectUiLanguage } from './detect-language.js';

const savedLang = (() => {
  try { return localStorage.getItem('imcodes_lang') ?? undefined; } catch { return undefined; }
})();

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
    lng: savedLang ?? detectUiLanguage(),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });

installTranslationCache(i18n);

export default i18n;
