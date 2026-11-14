/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
}));

import { VoiceLanguageSwitcher } from '../../src/components/VoiceLanguageSwitcher.js';
import { LanguageSwitcher } from '../../src/components/LanguageSwitcher.js';
import {
  VOICE_LANG_STORAGE_KEY,
  getVoiceLanguageMode,
  setVoiceLanguageMode,
} from '../../src/components/VoiceInput.js';

describe('VoiceLanguageSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    localStorage.clear();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  });

  it('defaults to follow UI language and persists switching to auto-detect and back', () => {
    const { container } = render(
      <div>
        <LanguageSwitcher />
        <VoiceLanguageSwitcher />
      </div>,
    );
    const select = container.querySelector('select.voice-lang-switcher') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.value).toBe('follow');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(['follow', 'auto']);
    expect(getVoiceLanguageMode()).toBe('follow');

    fireEvent.change(select!, { target: { value: 'auto' } });
    expect(select!.value).toBe('auto');
    expect(localStorage.getItem(VOICE_LANG_STORAGE_KEY)).toBe('auto');
    expect(getVoiceLanguageMode()).toBe('auto');

    fireEvent.change(select!, { target: { value: 'follow' } });
    expect(select!.value).toBe('follow');
    expect(localStorage.getItem(VOICE_LANG_STORAGE_KEY)).toBe('follow');
    expect(getVoiceLanguageMode()).toBe('follow');
  });

  it('synchronizes state across multiple mounted VoiceLanguageSwitcher instances', async () => {
    setVoiceLanguageMode('follow');
    const { container } = render(
      <div>
        <VoiceLanguageSwitcher />
        <VoiceLanguageSwitcher />
      </div>,
    );
    const selects = Array.from(container.querySelectorAll('select.voice-lang-switcher')) as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    expect(selects.map((s) => s.value)).toEqual(['follow', 'follow']);

    selects[0].value = 'auto';
    selects[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem(VOICE_LANG_STORAGE_KEY)).toBe('auto');
    await waitFor(() => {
      expect(selects.map((s) => s.value)).toEqual(['auto', 'auto']);
    });

    // External storage updates (e.g. another tab) also sync mounted switchers
    setVoiceLanguageMode('follow');
    window.dispatchEvent(new StorageEvent('storage', { key: VOICE_LANG_STORAGE_KEY }));
    await waitFor(() => {
      expect(selects.map((s) => s.value)).toEqual(['follow', 'follow']);
    });
  });
});
