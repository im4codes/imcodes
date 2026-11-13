import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(__dirname, '../src/i18n/locales');
const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru'] as const;

function flattenLeafStrings(obj: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out[key] = v;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenLeafStrings(v, key));
    }
  }
  return out;
}

describe('cloud_docs i18n translations across all 7 locales', () => {
  const loaded = Object.fromEntries(
    LOCALES.map((loc) => [
      loc,
      JSON.parse(readFileSync(resolve(localesDir, `${loc}.json`), 'utf8')) as {
        cloud_docs?: Record<string, unknown>;
      },
    ]),
  );

  const enLeaves = flattenLeafStrings(loaded.en.cloud_docs);
  const enKeys = Object.keys(enLeaves).sort();

  it('defines non-empty cloud_docs keys in en.json including share & shared keys', () => {
    expect(enKeys.length).toBeGreaterThan(30);
    expect(enLeaves['title']).toBeTruthy();
    expect(enLeaves['tabs.shared']).toBeTruthy();
    expect(enLeaves['actions.share']).toBeTruthy();
    expect(enLeaves['share.mode_team']).toBeTruthy();
    expect(enLeaves['share.allow_download']).toBeTruthy();
  });

  for (const locale of LOCALES) {
    if (locale === 'en') continue;
    it(`has exact cloud_docs key parity and localized strings in ${locale}.json`, () => {
      const leaves = flattenLeafStrings(loaded[locale].cloud_docs);
      const keys = Object.keys(leaves).sort();
      expect(keys).toEqual(enKeys);

      const EXEMPT_UNIVERSAL_TERMS = new Set(['blank_type.docx', 'blank_type.xlsx', 'blank_type.pptx']);
      let untranslatedCount = 0;
      for (const key of enKeys) {
        expect(leaves[key]?.trim().length).toBeGreaterThan(0);
        if (!EXEMPT_UNIVERSAL_TERMS.has(key) && leaves[key] === enLeaves[key]) {
          untranslatedCount++;
        }
      }
      // Every non-English locale should translate the vast majority of strings (no bulk English copy).
      expect(untranslatedCount).toBeLessThanOrEqual(1);
    });
  }
});
