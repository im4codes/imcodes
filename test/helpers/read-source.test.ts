import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeLineEndings, readSource } from './read-source.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (): string => { const dir = mkdtempSync(join(tmpdir(), 'imcodes-read-source-')); dirs.push(dir); return dir; };

describe('readSource', () => {
  it('answers with LF whatever line endings the checkout gave the file', () => {
    const dir = temp();
    const lf = 'int main() {\n  Log("a");\n  return 0;\n}\n';
    for (const [name, bytes] of [['lf.cc', lf], ['crlf.cc', lf.replace(/\n/gu, '\r\n')], ['mixed.cc', 'int main() {\r\n  Log("a");\n  return 0;\r\n}\n']] as const) {
      writeFileSync(join(dir, name), bytes);
      expect(readSource(join(dir, name)), name).toBe(lf);
    }
  });

  it('is what makes a multi-line marker findable on a Windows (CRLF) checkout; a plain read is not', async () => {
    const { readFileSync } = await import('node:fs');
    const dir = temp();
    const marker = 'UserDataFolder();\n  Log("window_shown"';
    const crlf = join(dir, 'panel_host.cc');
    writeFileSync(crlf, `void f() {\n  const std::wstring user_data = UserDataFolder();\n  Log("window_shown", S_OK, 1);\n}\n`.replace(/\n/gu, '\r\n'));
    // The failure the Windows CI job showed: the marker is absent from the bytes a CRLF checkout holds...
    expect(readFileSync(crlf, 'utf8').indexOf(marker)).toBe(-1);
    // ...and present in what a spec reads through the helper.
    expect(readSource(crlf).indexOf(marker)).toBeGreaterThan(-1);
  });

  it('only joins CRLF pairs: a lone carriage return is data and stays, and an empty file stays empty', () => {
    expect(normalizeLineEndings('a\rb\r\nc\n\r\n')).toBe('a\rb\nc\n\n');
    expect(normalizeLineEndings('')).toBe('');
    expect(normalizeLineEndings('no newline')).toBe('no newline');
    const dir = temp();
    writeFileSync(join(dir, 'empty'), '');
    expect(readSource(join(dir, 'empty'))).toBe('');
  });
});
