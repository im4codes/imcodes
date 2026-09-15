/**
 * Every `controlled_nodes.*` key the product actually renders must exist in all
 * seven locales.
 *
 * i18next falls back to printing the raw key when a lookup misses, so a missing
 * key is not a silent English fallback — it puts `controlled_nodes.download_action`
 * on screen where a label belongs. That has now slipped through twice by hand,
 * once for the download label and once for the clipboard-failure message, so it
 * is checked mechanically here rather than trusted to review.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Resolve against this module, never the working directory.
 *
 * These tests run from two different cwds — the repo root via the workspace
 * project, and `web/` via the package's own `npm test`. Repo-root-relative
 * literals resolve to `web/web/src/...` under the second one and throw ENOENT
 * before a single contract is asserted, turning a guard into a false alarm.
 *
 * Deliberately NOT `new URL(..., import.meta.url)`: Vite claims that exact
 * pattern for its asset-URL transform, and a non-literal argument it cannot
 * statically resolve is rewritten to `undefined` — so the idiomatic form
 * silently reads `<testdir>/undefined` under this runner.
 */
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromWebRoot = (relative: string): string => resolve(WEB_ROOT, relative);

const LOCALES = ['en', 'es', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW'] as const;

/** Files that render or return `controlled_nodes.*` translation keys. */
const SOURCES = [
  'src/components/ControlledNodesPanel.tsx',
  'src/api.ts',
];

type Namespace = Record<string, unknown>;

function namespaceOf(locale: string): Namespace {
  const json = JSON.parse(readFileSync(fromWebRoot(`src/i18n/locales/${locale}.json`), 'utf8')) as {
    controlled_nodes?: Namespace;
  };
  return json.controlled_nodes ?? {};
}

/**
 * Flatten to dotted leaf paths. The namespace nests (`share.trust_title`), and
 * comparing only top-level names would miss a leaf that exists in one locale
 * and not another.
 */
function leafPaths(node: Namespace, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of leafPaths(value as Namespace, path)) out.set(k, v);
    } else {
      out.set(path, value);
    }
  }
  return out;
}

function localeKeys(locale: string): Set<string> {
  const ns = namespaceOf(locale);
  // Both leaves and the container names, so a reference to either resolves.
  const keys = new Set<string>(leafPaths(ns).keys());
  for (const key of Object.keys(ns)) keys.add(key);
  return keys;
}

function referencedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of SOURCES) {
    const src = readFileSync(fromWebRoot(file), 'utf8');
    // Capture the whole dotted path so a nested reference is checked at the
    // leaf it actually renders, not at its container.
    for (const m of src.matchAll(/['"`]controlled_nodes\.([a-z0-9_.]+)['"`]/gi)) {
      const key = m[1]!;
      found.set(key, [...(found.get(key) ?? []), file]);
    }
  }
  return found;
}

describe('controlled-node i18n coverage', () => {
  it('finds the keys it is supposed to be guarding', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true.
    const keys = referencedKeys();
    expect(keys.size).toBeGreaterThan(10);
    for (const expected of [
      'download_action', 'copy_install_link', 'copy_install_link_clipboard_error',
      'revoke_install_link', 'revoke_install_link_confirm',
    ]) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  it('defines every rendered key in all seven locales', () => {
    const keys = referencedKeys();
    const missing: string[] = [];
    for (const locale of LOCALES) {
      const defined = localeKeys(locale);
      for (const [key, files] of keys) {
        if (!defined.has(key)) missing.push(`${locale}: controlled_nodes.${key} (used in ${files.join(', ')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the controlled_nodes namespace identical across locales', () => {
    const base = localeKeys('en');
    for (const locale of LOCALES) {
      const keys = localeKeys(locale);
      expect({ locale, missing: [...base].filter((k) => !keys.has(k)).sort() })
        .toEqual({ locale, missing: [] });
      expect({ locale, extra: [...keys].filter((k) => !base.has(k)).sort() })
        .toEqual({ locale, extra: [] });
    }
  });

  it('never ships an empty string where a label belongs', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of leafPaths(namespaceOf(locale))) {
        expect({ locale, key, ok: typeof value === 'string' && value.trim().length > 0 })
          .toEqual({ locale, key, ok: true });
      }
    }
  });
});
