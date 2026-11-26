/**
 * Reading a checked-in text file (a native source, a script, a manifest, a workflow) for a spec test.
 *
 * The same file is bytes-identical on every machine only if its line endings are: a Windows checkout with `core.autocrlf=true`
 * (the Git for Windows default, and what the CI runner's `actions/checkout` produces) turns every LF of a file that has no `eol`
 * attribute into CRLF. A spec that looks for a multi-line marker (`'foo();\n  bar()'`), splits on `\n` or anchors a regex with
 * `^`/`$` then passes on Linux/macOS and fails on Windows although the source is unchanged. Specs read sources through this
 * helper, which always answers with LF; a spec that asserts the BYTES of a file (a CRLF-only batch file, a hash) reads it
 * with `readFileSync` and says so.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/** `\r\n` -> `\n` (a lone `\r` is data and stays). */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/gu, '\n');
}

/** The text of a checked-in file with LF line endings, whatever the checkout did to them. */
export function readSource(path: string): string {
  return normalizeLineEndings(readFileSync(path, 'utf8'));
}

/** `readSource` for a spec that reads asynchronously. */
export async function readSourceAsync(path: string): Promise<string> {
  return normalizeLineEndings(await readFile(path, 'utf8'));
}
