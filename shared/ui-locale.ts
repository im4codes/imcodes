/**
 * Which of the product's seven UI languages a person should see.
 *
 * One definition for every surface that has its own language picker: the web
 * app and the controlled node's local panel both resolve the system language
 * through this module, so a language tag can never mean one thing in one and
 * another thing in the other.
 */

export const UI_LOCALES = ['en', 'zh-CN', 'zh-TW', 'es', 'ru', 'ja', 'ko'] as const;
export type UiLocale = (typeof UI_LOCALES)[number];

/** What a person sees when nothing they speak is offered. */
export const UI_LOCALE_DEFAULT: UiLocale = 'en';

/** The stored choice that means "use whatever the system speaks". */
export const UI_LOCALE_FOLLOW_SYSTEM = 'system' as const;
export type UiLocalePreference = UiLocale | typeof UI_LOCALE_FOLLOW_SYSTEM;

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value);
}

// Chinese is the one language whose variant matters: Traditional is used in
// Taiwan, Hong Kong and Macao; everything else (mainland, Singapore, a bare
// "zh") reads Simplified. A script subtag says it outright and beats the region.
const TRADITIONAL_REGIONS: ReadonlySet<string> = new Set(['tw', 'hk', 'mo']);

/** The locale a single BCP-47 language tag maps to, or null when it is not one of ours. */
export function matchUiLocale(tag: unknown): UiLocale | null {
  if (typeof tag !== 'string') return null;
  const parts = tag.trim().toLowerCase().replace(/_/gu, '-').split('-').filter(Boolean);
  const primary = parts[0];
  if (!primary) return null;
  switch (primary) {
    case 'en': return 'en';
    case 'es': return 'es';
    case 'ru': return 'ru';
    case 'ja': return 'ja';
    case 'ko': return 'ko';
    case 'zh': {
      const subtags = parts.slice(1);
      if (subtags.includes('hant')) return 'zh-TW';
      if (subtags.includes('hans')) return 'zh-CN';
      return subtags.some((subtag) => TRADITIONAL_REGIONS.has(subtag)) ? 'zh-TW' : 'zh-CN';
    }
    default: return null;
  }
}

/**
 * The system language, from a preference-ordered list such as
 * `navigator.languages`: the first entry that is one of ours wins, and a
 * language we do not offer (`de`, `fr`) is skipped in favour of a later one.
 * A single tag, nothing, or a list with no match gives the default.
 */
export function resolveUiLocale(languages: readonly unknown[] | string | null | undefined): UiLocale {
  const list = typeof languages === 'string' ? [languages] : Array.isArray(languages) ? languages : [];
  for (const tag of list) {
    const match = matchUiLocale(tag);
    if (match) return match;
  }
  return UI_LOCALE_DEFAULT;
}

/** A stored preference (an explicit locale, "system", or junk) resolved against the system languages. */
export function uiLocaleFromPreference(
  preference: unknown,
  languages: readonly unknown[] | string | null | undefined,
): UiLocale {
  return isUiLocale(preference) ? preference : resolveUiLocale(languages);
}

/** The system languages as the browser reports them (`navigator.languages`, else `navigator.language`). */
export function systemLanguagesOf(navigatorLike: { languages?: readonly string[]; language?: string } | null | undefined): readonly string[] {
  if (!navigatorLike) return [];
  if (navigatorLike.languages && navigatorLike.languages.length > 0) return navigatorLike.languages;
  return navigatorLike.language ? [navigatorLike.language] : [];
}
