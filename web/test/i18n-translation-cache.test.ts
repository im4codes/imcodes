import { describe, it, expect, vi } from 'vitest';
import i18next from 'i18next';
import { installTranslationCache } from '../src/i18n/translation-cache.js';

async function makeInstance() {
  const instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: { translation: { hello: 'Hello', only_en: 'Only EN', greet: 'Hi {{name}}', nested: { label: 'Nested' } }, other: { hello: 'Other hello' } },
      es: { translation: { hello: 'Hola' } },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe('installTranslationCache', () => {
  it('returns the same results as the uncached translator', async () => {
    const instance = await makeInstance();
    installTranslationCache(instance);
    expect(instance.t('hello')).toBe('Hello');
    expect(instance.t('hello')).toBe('Hello');
    expect(instance.t('missing.key')).toBe('missing.key');
  });

  it('skips the underlying translator on repeat plain-key calls', async () => {
    const instance = await makeInstance();
    const spy = vi.spyOn(instance, 't');
    installTranslationCache(instance);
    // spy sits underneath the wrapper because install captured it first.
    instance.t('hello');
    instance.t('hello');
    instance.t('hello');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when options are passed (interpolation, ns, count)', async () => {
    const instance = await makeInstance();
    installTranslationCache(instance);
    expect(instance.t('greet', { name: 'A' })).toBe('Hi A');
    expect(instance.t('greet', { name: 'B' })).toBe('Hi B');
    expect(instance.t('hello', { ns: 'other' })).toBe('Other hello');
    expect(instance.t('hello')).toBe('Hello');
  });

  it('invalidates on language change and falls back to en for missing keys', async () => {
    const instance = await makeInstance();
    installTranslationCache(instance);
    expect(instance.t('hello')).toBe('Hello');
    await instance.changeLanguage('es');
    expect(instance.t('hello')).toBe('Hola');
    expect(instance.t('only_en')).toBe('Only EN');
    await instance.changeLanguage('en');
    expect(instance.t('hello')).toBe('Hello');
  });

  it('invalidates when resources are added or removed', async () => {
    const instance = await makeInstance();
    installTranslationCache(instance);
    expect(instance.t('late')).toBe('late');
    instance.addResourceBundle('en', 'translation', { late: 'Arrived' }, true, true);
    expect(instance.t('late')).toBe('Arrived');
    instance.removeResourceBundle('en', 'other');
    expect(instance.t('hello')).toBe('Hello');
  });

  it('keeps fixed translators separate per ns and keyPrefix, and caches each', async () => {
    const instance = await makeInstance();
    installTranslationCache(instance);
    const other = instance.getFixedT('en', 'other');
    const nested = instance.getFixedT('en', 'translation', 'nested');
    expect(other('hello')).toBe('Other hello');
    expect(nested('label')).toBe('Nested');
    expect(instance.t('hello')).toBe('Hello');
    expect(other('hello')).toBe('Other hello');
    expect(nested('label')).toBe('Nested');
  });

  it('a fixed translator for a fixed lng is unaffected by other languages changing, and stays correct', async () => {
    const instance = await makeInstance();
    installTranslationCache(instance);
    const es = instance.getFixedT('es');
    expect(es('hello')).toBe('Hola');
    await instance.changeLanguage('es');
    expect(es('hello')).toBe('Hola');
    await instance.changeLanguage('en');
    expect(es('hello')).toBe('Hola');
  });

  it('uninstall restores the original translators', async () => {
    const instance = await makeInstance();
    const originalT = instance.t;
    const handle = installTranslationCache(instance);
    expect(instance.t).not.toBe(originalT);
    handle.uninstall();
    expect(instance.t).toBe(originalT);
  });
});
