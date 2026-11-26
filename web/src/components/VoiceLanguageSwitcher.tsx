import { useEffect, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  VOICE_LANG_STORAGE_KEY,
  getVoiceLanguageMode,
  setVoiceLanguageMode,
  type VoiceLanguageMode,
} from './VoiceInput.js';

const listeners = new Set<(mode: VoiceLanguageMode) => void>();

export function VoiceLanguageSwitcher() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<VoiceLanguageMode>(() => getVoiceLanguageMode());

  useEffect(() => {
    const syncFromStorage = () => setMode(getVoiceLanguageMode());
    syncFromStorage();
    const onPeerChange = (next: VoiceLanguageMode) => setMode(next);
    const onStorage = (e: StorageEvent) => {
      if (e.key === VOICE_LANG_STORAGE_KEY || e.key === null) syncFromStorage();
    };
    listeners.add(onPeerChange);
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(onPeerChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const onChange = (e: Event) => {
    const next: VoiceLanguageMode = (e.currentTarget as HTMLSelectElement).value === 'auto' ? 'auto' : 'follow';
    setVoiceLanguageMode(next);
    setMode(next);
    for (const listener of listeners) listener(next);
  };

  return (
    <select
      class="lang-switcher voice-lang-switcher"
      value={mode}
      onChange={onChange}
      title={t('voiceLang.label')}
      aria-label={t('voiceLang.label')}
    >
      <option value="follow" selected={mode === 'follow'}>{t('voiceLang.follow')}</option>
      <option value="auto" selected={mode === 'auto'}>{t('voiceLang.auto')}</option>
    </select>
  );
}
