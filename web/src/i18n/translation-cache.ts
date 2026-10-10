import type { i18n as I18nInstance, TFunction } from 'i18next';

/**
 * Memoize option-less translations per translator.
 *
 * `t('some.label')` runs key extraction, namespace/language resolution and the
 * post-processing pipeline every call (~6% of the renderer profile with many
 * windows open, mostly from big components rendering hundreds of static labels).
 * A static label's result only changes when the language or the loaded resources
 * change, so the plain-string result is cached and dropped on languageChanged /
 * loaded (instance) and added / removed (resource store) (and whenever `i18n.language` differs from the one it
 * was cached under). Calls that pass anything besides the key (interpolation,
 * defaults, count/context, returnObjects, ns override) go straight through.
 */
const INSTANCE_EVENTS = ['languageChanged', 'loaded', 'initialized'] as const;
/** Resource bundles emit on the store, not on the i18n instance. */
const STORE_EVENTS = ['added', 'removed'] as const;

type AnyT = (...args: unknown[]) => unknown;

export function installTranslationCache(instance: I18nInstance): { invalidate: () => void; uninstall: () => void } {
  let version = 0;
  const invalidate = () => { version += 1; };
  for (const event of INSTANCE_EVENTS) instance.on(event, invalidate);
  for (const event of STORE_EVENTS) instance.store.on(event, invalidate);

  const wrap = (translate: AnyT): AnyT => {
    const cache = new Map<string, string>();
    let cachedVersion = version;
    let cachedLanguage = instance.language;
    const cached: AnyT = (...args) => {
      const key = args[0];
      if (args.length !== 1 || typeof key !== 'string') return translate(...args);
      if (cachedVersion !== version || cachedLanguage !== instance.language) {
        cache.clear();
        cachedVersion = version;
        cachedLanguage = instance.language;
      }
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const value = translate(key);
      if (typeof value === 'string') cache.set(key, value);
      return value;
    };
    // react-i18next reads properties off the fixed T (lng, ns, keyPrefix, ...).
    return Object.assign(cached, translate);
  };

  const originalT = instance.t;
  const originalGetFixedT = instance.getFixedT;
  const patchedT = wrap(originalT.bind(instance) as unknown as AnyT);
  instance.t = patchedT as unknown as TFunction;
  instance.getFixedT = ((...fixedArgs: unknown[]) => wrap((originalGetFixedT as unknown as AnyT).apply(instance, fixedArgs) as AnyT)) as unknown as typeof instance.getFixedT;

  return {
    invalidate,
    uninstall: () => {
      for (const event of INSTANCE_EVENTS) instance.off(event, invalidate);
      for (const event of STORE_EVENTS) instance.store.off(event, invalidate);
      instance.t = originalT;
      instance.getFixedT = originalGetFixedT;
    },
  };
}
