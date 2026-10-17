/**
 * Source-reading specs must not depend on the checkout's line endings (a Windows checkout turns LF into CRLF: the `aiDesk panel
 * window host (Windows build)` job failed on a multi-line marker although the source was unchanged). They read through
 * test/helpers/read-source.ts; this guard keeps it that way, and shows the same sources read on a CRLF checkout.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSource } from '../helpers/read-source.js';

const SPEC_DIR = resolve(__dirname);
const ROOT = resolve(__dirname, '..', '..');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A `readFileSync` / `readFile` call with `'utf8'` / `{ encoding: 'utf8' }` / `'utf-8'`: a text read that bypasses the helper. */
const DIRECT_TEXT_READ = /readFile(?:Sync)?\s*\((?:[^()]|\([^()]*\))*?,\s*(?:['"`]utf-?8['"`]|\{[^}]*encoding\s*:\s*['"`]utf-?8['"`][^}]*\})\s*,?\s*\)/giu;

describe('spec tests read checked-in text through readSource', () => {
  const specs = readdirSync(SPEC_DIR).filter((name) => name.endsWith('.test.ts') && name !== 'source-line-endings.test.ts');

  it('no spec reads a file as text with readFileSync directly (a CRLF checkout would break its multi-line markers)', () => {
    const offenders = specs.filter((name) => {
      const text = readFileSync(join(SPEC_DIR, name), 'utf8');
      DIRECT_TEXT_READ.lastIndex = 0;
      return DIRECT_TEXT_READ.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('the guard recognises every spelling of a direct text read', () => {
    for (const sample of [
      "readFileSync(resolve(root, path), 'utf8')", 'readFileSync(path, "utf8")', "readFileSync(join(a, b), 'utf-8')",
      "readFileSync(path, { encoding: 'utf8' })", "await readFile('native/a.h', 'utf8')", "fsp.readFile(resolve(ROOT, 'x'), \"utf-8\")", "fs.readFileSync(resolve(ROOT, 'a'), `utf8`)", "readFileSync(\n    resolve(ROOT, 'x'),\n    'utf8',\n  )",
    ]) { DIRECT_TEXT_READ.lastIndex = 0; expect(DIRECT_TEXT_READ.test(sample), sample).toBe(true); }
    for (const sample of ['readFileSync(path)', 'readFile(value.output)', "readFileSync(path).toString('latin1')", "readSourceAsync('native/a.h')", "readSource(resolve(root, 'a'))"]) {
      DIRECT_TEXT_READ.lastIndex = 0; expect(DIRECT_TEXT_READ.test(sample), sample).toBe(false);
    }
  });

  it('the native and script sources the specs inspect read the same on a CRLF checkout', () => {
    const dir = temp();
    const checked = [
      'native/aidesk-panel-host-windows/panel_host.cc',
      'native/aidesk-panel-host-windows/CMakeLists.txt',
      'native/aidesk-panel-host-windows/panel_host_ids.h',
      'native/aidesk-panel-host-windows/webview2.lock.json',
    ];
    for (const relative of checked) {
      const lf = readSource(resolve(ROOT, relative));
      const crlfCopy = join(dir, relative.replace(/[\\/]/gu, '__'));
      writeFileSync(crlfCopy, lf.replace(/\n/gu, '\r\n'));
      expect(readFileSync(crlfCopy, 'utf8'), relative).not.toBe(lf);
      expect(readSource(crlfCopy), relative).toBe(lf);
    }
  });
});

function temp(): string { const dir = mkdtempSync(join(tmpdir(), 'imcodes-crlf-sources-')); dirs.push(dir); return dir; }
