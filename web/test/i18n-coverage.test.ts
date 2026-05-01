import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

describe('generic i18n coverage guard', () => {
  it('keeps memory post-1.1 translation keys present in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as {
        memory?: { quickSearch?: Record<string, string>; skills?: Record<string, string> };
      };
      expect(messages.memory?.quickSearch?.disabled, locale).toEqual(expect.any(String));
      expect(messages.memory?.quickSearch?.noResults, locale).toEqual(expect.any(String));
      expect(messages.memory?.skills?.disabled, locale).toEqual(expect.any(String));
      expect(messages.memory?.skills?.layerDiagnostics, locale).toEqual(expect.any(String));
    }
  });
});
