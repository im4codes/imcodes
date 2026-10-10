import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '../src/i18n/locales/index.js';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

function flatten(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key));
}

describe('MCP & Skills locale parity', () => {
  it('ships the complete non-empty capability surface in all seven locales', () => {
    const keysets = SUPPORTED_LOCALES.map((locale) => {
      const messages = JSON.parse(readFileSync(join(WEB_ROOT, 'src/i18n/locales', `${locale}.json`), 'utf8')) as { capabilities?: unknown };
      const keys = flatten(messages.capabilities).sort();
      expect(keys.length, locale).toBeGreaterThan(70);
      for (const key of keys) {
        const value = key.split('.').reduce<unknown>((current, part) => (
          current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined
        ), messages.capabilities);
        expect(typeof value === 'string' && value.trim().length > 0, `${locale}:${key}`).toBe(true);
      }
      return keys;
    });
    for (const keys of keysets.slice(1)) expect(keys).toEqual(keysets[0]);
  });
});
