import { useTranslation } from 'react-i18next';
import i18n from '../i18n/index.js';

const LANGUAGES = [
  { code: 'en',    label: 'English' },
  { code: 'zh-CN', label: '中文（简体）' },
  { code: 'zh-TW', label: '中文（繁體）' },
  { code: 'es',    label: 'Español' },
  { code: 'ru',    label: 'Русский' },
  { code: 'ja',    label: '日本語' },
  { code: 'ko',    label: '한국어' },
];

export function LanguageSwitcher() {
  const { t } = useTranslation();
  const current = i18n.language;

  const onChange = (e: Event) => {
    const next = (e.target as HTMLSelectElement).value;
    i18n.changeLanguage(next);
    try { localStorage.setItem('imcodes_lang', next); } catch { /* ignore */ }
  };

  return (
    <select
      class="lang-switcher"
      value={current}
      onChange={onChange}
      title={t('language.label')}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>{l.label}</option>
      ))}
    </select>
  );
}
