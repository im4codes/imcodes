import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import en from '../src/i18n/locales/en.json';
import es from '../src/i18n/locales/es.json';
import ja from '../src/i18n/locales/ja.json';
import ko from '../src/i18n/locales/ko.json';
import ru from '../src/i18n/locales/ru.json';
import zhCN from '../src/i18n/locales/zh-CN.json';
import zhTW from '../src/i18n/locales/zh-TW.json';
import { validateControlledFileTransferResponse } from '../../shared/transport/file-transfer.js';

/**
 * Volume capacity beside a drive root.
 *
 * The response validator rebuilds each entry field by field and rejects
 * unknown keys, so a new field that is not added in BOTH places is either
 * refused outright or silently dropped on the way to the browser. That is the
 * failure this file exists to catch.
 */

const read = (relative: string) => readFileSync(
  fileURLToPath(new URL(relative, import.meta.url)),
  'utf8',
);

const done = (entry: Record<string, unknown>) => validateControlledFileTransferResponse({
  type: 'file.directory_list_done',
  requestId: 'a'.repeat(32),
  path: ':drives:',
  resolvedPath: '__imcodes_windows_drives__',
  entries: [entry],
});

const DRIVE = { name: 'C:\\', path: 'C:\\', isDir: true, hidden: false };

describe('capacity survives the wire contract', () => {
  it('carries totalBytes and freeBytes through validation', () => {
    const result = done({ ...DRIVE, totalBytes: 511_000_000_000, freeBytes: 120_000_000_000 });
    expect(result.ok, 'a drive with capacity must validate').toBe(true);
    const entry = (result as { value: { entries: Array<Record<string, unknown>> } }).value.entries[0];
    // The validator rebuilds the entry, so "accepted" and "forwarded" are two
    // different things and both have to be checked.
    expect(entry.totalBytes).toBe(511_000_000_000);
    expect(entry.freeBytes).toBe(120_000_000_000);
  });

  it('still accepts an entry with no capacity at all', () => {
    // Every non-root row, and any volume the daemon could not measure.
    const result = done(DRIVE);
    expect(result.ok).toBe(true);
    const entry = (result as { value: { entries: Array<Record<string, unknown>> } }).value.entries[0];
    expect(entry.totalBytes).toBeUndefined();
    expect(entry.freeBytes).toBeUndefined();
  });

  it('rejects capacity that is not a real byte count', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100', null]) {
      expect(done({ ...DRIVE, totalBytes: bad }).ok, `totalBytes=${String(bad)}`).toBe(false);
      expect(done({ ...DRIVE, freeBytes: bad }).ok, `freeBytes=${String(bad)}`).toBe(false);
    }
  });

  it('still rejects genuinely unknown fields', () => {
    // Widening the key set must not have turned the entry into a free-for-all.
    expect(done({ ...DRIVE, somethingElse: 1 }).ok).toBe(false);
  });
});

describe('capacity reaches the tree', () => {
  const fileBrowser = read('../src/components/FileBrowser.tsx');

  it('keeps the fields when building tree nodes', () => {
    // The node builder lists fields explicitly, so an addition to the wire
    // type does not reach the UI on its own.
    expect(fileBrowser).toContain("typeof e.totalBytes === 'number'");
    expect(fileBrowser).toContain("typeof e.freeBytes === 'number'");
  });

  it('renders only when both numbers are present', () => {
    // A bar drawn from a free value with no total would be meaningless.
    expect(fileBrowser).toContain("typeof node.freeBytes === 'number' && typeof node.totalBytes === 'number'");
  });

  it('shows the USED share, so a full volume reads as a full bar', () => {
    expect(fileBrowser).toContain('1 - node.freeBytes / node.totalBytes');
  });
});

describe('capacity labels are translated everywhere', () => {
  const locales = { en, es, ja, ko, ru, 'zh-CN': zhCN, 'zh-TW': zhTW };

  for (const [name, bundle] of Object.entries(locales)) {
    it(`${name} has both capacity strings with their placeholders`, () => {
      const fb = (bundle as Record<string, Record<string, string>>).file_browser;
      expect(fb?.capacity_free, `${name}.capacity_free`).toContain('{{free}}');
      expect(fb?.capacity_detail, `${name}.capacity_detail`).toContain('{{free}}');
      expect(fb?.capacity_detail, `${name}.capacity_detail`).toContain('{{total}}');
    });
  }

  it('does not leave a locale on the English wording', () => {
    for (const [name, bundle] of Object.entries(locales)) {
      if (name === 'en') continue;
      const fb = (bundle as Record<string, Record<string, string>>).file_browser;
      expect(fb.capacity_free, `${name} still shows English`).not.toBe(en.file_browser.capacity_free);
    }
  });
});
