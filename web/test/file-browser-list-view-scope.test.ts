/** @vitest-environment node */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FILE_TRANSFER_DIRECTORY_MAX_ENTRIES } from '@shared/transport/file-transfer.js';

// The table view renders every row of a directory, without windowing: in a real
// browser 512 rows take about 0.3 s to draw and 10,000 take 5 s or more. That is
// safe only because the one place that enables it, a controlled node's listing,
// can never carry more than FILE_TRANSFER_DIRECTORY_MAX_ENTRIES entries per
// directory (the node cuts after ordering, and every validator on the way
// rejects more). If a path with more rows per directory is ever given the table
// view, it needs a render window first (for example 1,000 rows plus a "show
// more" row): do not just let it through.
describe('the table view is enabled only where a directory is bounded', () => {
  const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
  const tsxFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });

  it('is turned on by the remote desktop panel and nothing else', () => {
    const enabling = tsxFiles(sourceRoot)
      .filter((file) => /<FileBrowser\b[^>]*\blistView\b/s.test(readFileSync(file, 'utf8')))
      .map((file) => file.split('/').pop());
    expect(enabling).toEqual(['RemoteDesktopPanel.tsx']);
  });

  it('relies on a 512-entry bound', () => {
    expect(FILE_TRANSFER_DIRECTORY_MAX_ENTRIES).toBe(512);
  });
});
