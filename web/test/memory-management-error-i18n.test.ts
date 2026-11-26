import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_MANAGEMENT_ERROR_CODES } from '@shared/memory-management.js';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

// The management panel renders `sharedContext.management.error.<code>`; a
// missing translation used to surface the raw key (e.g. action_failed).
describe('memory management error translations', () => {
  for (const locale of SUPPORTED_LOCALES) {
    it(`translates every management error code in ${locale}`, () => {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'));
      const errors = messages.sharedContext?.management?.error ?? {};
      const missing = Object.values(MEMORY_MANAGEMENT_ERROR_CODES).filter(
        (code) => typeof errors[code] !== 'string' || errors[code].trim() === '',
      );
      expect(missing).toEqual([]);
    });
  }
});
