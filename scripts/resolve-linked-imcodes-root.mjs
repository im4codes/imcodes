import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const ENTRY_PARTS = ['dist', 'src', 'index.js'];
const WRAPPER_BYTES_MAX = 8 * 1024;

function exactPackageRootForEntry(entryPath) {
  if (!isAbsolute(entryPath) || /\s/.test(entryPath)) return null;
  let entry;
  try {
    entry = realpathSync(entryPath);
    if (!statSync(entry).isFile()) return null;
  } catch {
    return null;
  }

  if (basename(entry) !== ENTRY_PARTS[2]
    || basename(dirname(entry)) !== ENTRY_PARTS[1]
    || basename(dirname(dirname(entry))) !== ENTRY_PARTS[0]) return null;

  const root = realpathSync(dirname(dirname(dirname(entry))));
  const expectedEntry = join(root, ...ENTRY_PARTS);
  try {
    if (realpathSync(expectedEntry) !== entry) return null;
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return manifest?.name === 'imcodes' ? root : null;
  } catch {
    return null;
  }
}

/** Parse shell quoting only; never expand variables, escapes or operators. */
function literalShellWords(line) {
  const words = [];
  let index = 0;
  while (index < line.length) {
    while (/\s/.test(line[index] ?? '')) index += 1;
    if (index >= line.length) break;
    const quote = line[index] === '"' || line[index] === "'" ? line[index++] : null;
    let word = '';
    while (index < line.length) {
      const char = line[index];
      if (quote ? char === quote : /\s/.test(char)) break;
      if (char === '\\' || (!quote && /["';&|<>]/.test(char))) return null;
      word += char;
      index += 1;
    }
    if (quote) {
      if (line[index] !== quote) return null;
      index += 1;
      if (index < line.length && !/\s/.test(line[index])) return null;
    }
    if (!word) return null;
    words.push(word);
  }
  return words;
}

function wrapperEntryCandidate(cliPath) {
  let text;
  try {
    if (!lstatSync(cliPath).isFile()) return null;
    text = readFileSync(cliPath, 'utf8');
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > WRAPPER_BYTES_MAX || text.includes('\0')) return null;

  const body = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index) => line && !(index === 0 && line.startsWith('#!')) && !line.startsWith('#'));
  const execLines = body.filter((line) => line.startsWith('exec '));
  if (execLines.length > 1) {
    throw new Error(`ambiguous linked imcodes package roots from ${cliPath}: multiple exec commands`);
  }
  // A wrapper with setup/branching/substitution is deliberately outside the
  // accepted grammar. Only one literal exec line may follow its shebang.
  if (body.length !== 1 || execLines.length !== 1) return null;
  const words = literalShellWords(execLines[0]);
  if (!words || words.length !== 4 || words[0] !== 'exec' || words[3] !== '$@') return null;

  const nodePath = words[1];
  const entryPath = words[2];
  if (!isAbsolute(nodePath) || !isAbsolute(entryPath)
    || /\s/.test(nodePath) || /\s/.test(entryPath)) return null;
  try {
    const canonicalNode = realpathSync(nodePath);
    if (!statSync(canonicalNode).isFile() || basename(canonicalNode) !== 'node') return null;
    accessSync(canonicalNode, constants.X_OK);
  } catch {
    return null;
  }
  return entryPath;
}

/**
 * Resolve the npm-linked `imcodes` package without executing a PATH wrapper.
 * Accepted forms are deliberately finite: a symlink directly to the canonical
 * dist entry, or one literal `exec <absolute-node> <absolute-entry> "$@"`.
 */
export function resolveLinkedImcodesPackageRoot(cliPath) {
  const absoluteCli = resolve(cliPath);
  let canonicalCli;
  try {
    canonicalCli = realpathSync(absoluteCli);
  } catch {
    throw new Error(`could not locate linked imcodes package root from ${cliPath}`);
  }

  const directRoot = exactPackageRootForEntry(canonicalCli);
  if (directRoot) return directRoot;

  const wrapperEntry = wrapperEntryCandidate(absoluteCli);
  const wrapperRoot = wrapperEntry ? exactPackageRootForEntry(wrapperEntry) : null;
  if (wrapperRoot) return wrapperRoot;
  throw new Error(`could not locate linked imcodes package root from ${cliPath}`);
}
