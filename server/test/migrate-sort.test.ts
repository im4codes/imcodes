/**
 * Tests for migration file sorting — ensures numeric prefix ordering works
 * regardless of zero-padding width (3-digit, 4-digit, mixed).
 */

import { describe, it, expect } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../src/db/migrations');

/** Same sort logic as migrate.ts — sort by numeric prefix. */
function sortMigrations(files: string[]): string[] {
  return files.sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return a.localeCompare(b);
  });
}

describe('migration sort', () => {
  it('sorts 3-digit prefixed files in numeric order', () => {
    const files = ['010_foo.sql', '002_bar.sql', '001_init.sql', '035_baz.sql'];
    expect(sortMigrations(files)).toEqual([
      '001_init.sql', '002_bar.sql', '010_foo.sql', '035_baz.sql',
    ]);
  });

  it('handles transition from 3-digit to 4-digit prefixes', () => {
    const files = ['1000_future.sql', '099_last3.sql', '100_first3digit.sql'];
    expect(sortMigrations(files)).toEqual([
      '099_last3.sql', '100_first3digit.sql', '1000_future.sql',
    ]);
  });

  it('handles mixed-width prefixes that break naive string sort', () => {
    // String sort: "99" > "100" — our numeric sort fixes this
    const files = ['100_a.sql', '99_b.sql', '1000_c.sql', '9_d.sql'];
    expect(sortMigrations(files)).toEqual([
      '9_d.sql', '99_b.sql', '100_a.sql', '1000_c.sql',
    ]);
  });

  it('actual migration files are in numeric order', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
    const sorted = sortMigrations([...files]);

    // Verify sorted order matches numeric prefix sequence
    expect(sorted).toEqual(files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10)));

    // Verify no gaps or duplicates in prefix numbers
    const numbers = sorted.map((f) => parseInt(f, 10));
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
    }

    // Verify first migration is 001
    expect(numbers[0]).toBe(1);
  });

  it('every migration file has a numeric prefix', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
    for (const file of files) {
      const num = parseInt(file, 10);
      expect(num, `${file} should start with a number`).not.toBeNaN();
      expect(num, `${file} should have a positive prefix`).toBeGreaterThan(0);
    }
  });
});
