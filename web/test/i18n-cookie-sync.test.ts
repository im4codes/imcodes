// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import i18n from '../src/i18n/index.js';

describe('web i18n language cookie mirror', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('sets imcodes_lang cookie on initialization and updates it on changeLanguage', async () => {
    expect(document.cookie).toContain('imcodes_lang=');

    await i18n.changeLanguage('zh-CN');
    expect(document.cookie).toContain('imcodes_lang=zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');

    await i18n.changeLanguage('ja');
    expect(document.cookie).toContain('imcodes_lang=ja');
    expect(document.documentElement.lang).toBe('ja');
  });
});
