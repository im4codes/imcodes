import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

function flatten(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    out.push(...flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

describe('share i18n parity', () => {
  it('keeps the share namespace keys identical across supported locales', () => {
    const entries = SUPPORTED_LOCALES.map((locale) => {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { share?: unknown };
      return [locale, flatten(messages.share).sort()] as const;
    });

    const [, baseKeys] = entries[0];
    for (const [locale, keys] of entries) {
      expect(keys, locale).toEqual(baseKeys);
    }
  });

  it('defines a translated owner role for controlled nodes in every locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = JSON.parse(
        readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8'),
      ) as { share?: { role?: { owner?: unknown } } };
      const owner = messages.share?.role?.owner;

      expect(typeof owner, locale).toBe('string');
      expect(String(owner).trim(), locale).not.toBe('');
      expect(owner, locale).not.toBe('share.role.owner');
    }
  });
});
