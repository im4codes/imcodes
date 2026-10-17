import { resolveUiLocale, systemLanguagesOf, type UiLocale } from '@shared/ui-locale.js';

/**
 * The language this browser speaks, as one of the seven the app offers.
 * The matching itself is shared with every other surface that picks a language
 * from the system (the controlled node's local panel), so it lives in
 * shared/ui-locale.ts and nowhere else.
 */
export function detectUiLanguage(
  navigatorLike: { languages?: readonly string[]; language?: string } | null | undefined = typeof navigator === 'undefined' ? null : navigator,
): UiLocale {
  return resolveUiLocale(systemLanguagesOf(navigatorLike));
}
