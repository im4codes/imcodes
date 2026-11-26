import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A raw 0x00 byte inside a source file is silently survivable: TypeScript,
 * esbuild and the test runner all treat it as an ordinary string character, so
 * it compiles, bundles and passes every behavioural test. What it breaks is the
 * tooling nobody re-runs on purpose — `grep` and `rg` classify the file as
 * binary and report "binary file matches" instead of the matching lines, so the
 * file goes dark to code search.
 *
 * This has happened twice in ChatView.tsx, both times as a separator inside a
 * cache-key template literal, and both times it hid the whole 200KB file from
 * search until someone noticed the missing grep output. A behavioural test
 * cannot catch it — only a byte-level scan can.
 */
const ROOTS = ['web/src', 'web/test', 'shared', 'src', 'server/src'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

function collect(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // root not present in this checkout
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
}

describe('source files', () => {
  it('contain no NUL bytes', () => {
    const repoRoot = resolve(__dirname, '../..');
    const files: string[] = [];
    for (const root of ROOTS) collect(join(repoRoot, root), files);

    // Guard the guard: if the walk finds nothing the assertion below is vacuous.
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter((file) => readFileSync(file).includes(0x00))
      .map((file) => relative(repoRoot, file));

    expect(offenders).toEqual([]);
  });
});
