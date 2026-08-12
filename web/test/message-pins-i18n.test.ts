import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const REQUIRED_KEYS = [
  'title',
  'summary',
  'currentTab',
  'allTab',
  'searchPlaceholder',
  'searchLabel',
  'filterLabel',
  'filterAll',
  'noMatches',
  'noCurrent',
  'noPins',
  'pin',
  'unpin',
  'userMessage',
  'assistantMessage',
  'previewTitle',
  'previewMode',
  'renderedMode',
  'textMode',
  'jump',
  'requestFailed',
  'locateFailed',
] as const;

describe('message pin translations', () => {
  it('defines every message pin label in all supported locales', async () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = (await import(`../src/i18n/locales/${locale}.json`)).default as {
        messagePins?: Record<string, string>;
      };
      for (const key of REQUIRED_KEYS) {
        expect(messages.messagePins?.[key], `${locale}:messagePins.${key}`).toEqual(expect.any(String));
        expect(messages.messagePins?.[key]?.trim().length, `${locale}:messagePins.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
