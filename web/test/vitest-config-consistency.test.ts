import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every jsdom vitest config in this project must install the storage shim.
 *
 * `vitest.filebrowser.config.ts` shipped without `setupFiles` and every one of
 * its 110 tests died on `localStorage.clear is not a function`, because some
 * vitest/jsdom combinations hand back a plain object instead of a Storage. It
 * went unnoticed for a long time precisely because that config is not a CI job
 * — it exists so a human can run one heavy file in isolation. A debugging tool
 * that disagrees with the config CI gates on is worse than no tool: it makes
 * "it passes/fails in isolation" mean nothing.
 *
 * This is asserted over the config FILES rather than a running environment so
 * a newly added config is covered the moment it exists, without needing anyone
 * to remember to run it.
 */
const CONFIG_NAME = /^vitest\..*config\.ts$/;

function configsIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => CONFIG_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Locate the web project by probing, not by assuming a cwd.
 *
 * The per-config web runs have cwd at `web/`, but `npm run test:coverage` runs
 * from the repo root with `--project web` — where the same relative read finds
 * the ROOT's two vitest configs and silently guards the wrong directory.
 * `import.meta.url` is not an escape hatch either: Vite rewrites it to a
 * `/@fs/...` specifier that fs cannot open.
 *
 * The probe keys on the very thing being counted, so there is no second marker
 * to drift out of sync with a rename.
 */
function resolveWebRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, join(cwd, 'web')];
  let best = cwd;
  for (const candidate of candidates) {
    if (configsIn(candidate).length > configsIn(best).length) best = candidate;
  }
  return best;
}

const WEB_ROOT = resolveWebRoot();

function webVitestConfigs(): string[] {
  return configsIn(WEB_ROOT);
}

const CLEAR_DEFINITION_RE =
  /(?<!\.)\bclear\s*:\s*(?:\(|function\b|\{[^{}]*\bvalue\s*:\s*(?:\(|function\b))|(?<!\.)\bclear\s*\(\s*\)\s*(?::[^{=;]+)?\{/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/.*$/gm, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractImportedIdentifiers(clause: string): string[] {
  const ids: string[] = [];
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch) {
    for (const part of braceMatch[1]!.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || /^type\s+/.test(trimmed)) continue;
      const asParts = trimmed.split(/\s+as\s+/);
      const local = (asParts[1] ?? asParts[0]!).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) ids.push(local);
    }
  }
  const withoutBraces = clause.replace(/\{[^}]*\}/g, '');
  for (const part of withoutBraces.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const nsMatch = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (nsMatch) {
      ids.push(nsMatch[1]!);
    } else if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      ids.push(trimmed);
    }
  }
  return ids;
}

function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates: string[] = [];
  if (/\.[cm]?jsx?$/.test(base)) {
    const stem = base.replace(/\.[cm]?jsx?$/, '');
    if (base.endsWith('.mjs')) {
      candidates.push(`${stem}.mts`, base);
    } else if (base.endsWith('.cjs')) {
      candidates.push(`${stem}.cts`, base);
    } else {
      candidates.push(`${stem}.ts`, `${stem}.tsx`, base);
    }
  } else if (/\.[cm]?tsx?$/.test(base)) {
    candidates.push(base);
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.js`,
      `${base}.mjs`,
      join(base, 'index.ts'),
      join(base, 'index.js'),
    );
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep trying remaining candidate extensions.
    }
  }
  return null;
}

function moduleDefinesStorageClear(filePath: string, visited = new Set<string>()): boolean {
  const absPath = resolve(filePath);
  if (visited.has(absPath)) return false;
  visited.add(absPath);

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return false;
  }

  const code = stripComments(raw);
  if (CLEAR_DEFINITION_RE.test(code)) return true;

  const nonImportCode = code
    .replace(/^\s*import\s+(?:type\b\s+)?(?:(?!\bimport\b)[^;])*?\bfrom\s+['"][^'"]+['"]\s*;?/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"]\s*;?/gm, '');

  const importRe = /^\s*import\s+(?!type\b)((?:(?!\bimport\b)[^;])*?)\s+from\s+['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(code)) !== null) {
    const clause = match[1]!;
    const specifier = match[2]!;
    if (!specifier.startsWith('.')) continue;
    const ids = extractImportedIdentifiers(clause);
    const invoked = ids.some((id) => new RegExp(`\\b${escapeRegExp(id)}(?:\\.\\w+)*\\s*\\(`).test(nonImportCode));
    if (!invoked) continue;
    const resolved = resolveRelativeModule(absPath, specifier);
    if (resolved && moduleDefinesStorageClear(resolved, visited)) {
      return true;
    }
  }
  return false;
}

function findJsdomStorageOffenders(rootDir: string): string[] {
  const offenders: string[] = [];
  for (const name of configsIn(rootDir)) {
    const source = readFileSync(join(rootDir, name), 'utf8');
    if (!source.includes("environment: 'jsdom'")) continue;
    const setup = source.match(/setupFiles:\s*\[([^\]]*)\]/)?.[1] ?? '';
    const files = [...setup.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    if (files.length === 0) {
      offenders.push(`${name}: no setupFiles`);
      continue;
    }
    // The setup must actually establish storage, not merely exist.
    const establishesStorage = files.some((file) => moduleDefinesStorageClear(join(rootDir, file)));
    if (!establishesStorage) offenders.push(`${name}: ${files.join(', ')} never defines Storage.clear`);
  }
  return offenders;
}

describe('web vitest configs', () => {
  it('finds the configs it is supposed to be guarding', () => {
    // A rename or a bad glob must fail loudly instead of vacuously passing
    // over an empty list.
    expect(webVitestConfigs().length).toBeGreaterThanOrEqual(4);
  });

  it('gives every jsdom config a setup that guarantees a real Storage', () => {
    expect(findJsdomStorageOffenders(WEB_ROOT)).toEqual([]);
  });

  it('flags missing, empty, unused, nonexistent, and cyclic storage setups cleanly', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'vitest-config-consistency-'));
    try {
      writeFileSync(join(tmp, 'vitest.empty.config.ts'), `export default { test: { environment: 'jsdom' } };\n`);
      writeFileSync(
        join(tmp, 'vitest.missing.config.ts'),
        `export default { test: { environment: 'jsdom', setupFiles: ['./missing.ts'] } };\n`,
      );
      writeFileSync(
        join(tmp, 'vitest.unused.config.ts'),
        `export default { test: { environment: 'jsdom', setupFiles: ['./unused-setup.ts'] } };\n`,
      );
      writeFileSync(
        join(tmp, 'vitest.cyclic.config.ts'),
        `export default { test: { environment: 'jsdom', setupFiles: ['./cycle-a.ts'] } };\n`,
      );
      writeFileSync(
        join(tmp, 'vitest.valid.config.ts'),
        `export default { test: { environment: 'jsdom', setupFiles: ['./valid-setup.ts'] } };\n`,
      );

      writeFileSync(
        join(tmp, 'memory-storage.ts'),
        `export function ensureJsdomStorage() {\n  const t = {};\n  Object.defineProperties(t, { clear: { value: () => {} } });\n}\n`,
      );
      writeFileSync(
        join(tmp, 'unused-setup.ts'),
        `import { ensureJsdomStorage } from './memory-storage.js';\nexport const noop = true;\n`,
      );
      writeFileSync(
        join(tmp, 'valid-setup.ts'),
        `import { ensureJsdomStorage } from './memory-storage.js';\nensureJsdomStorage();\n`,
      );
      writeFileSync(join(tmp, 'cycle-a.ts'), `import { b } from './cycle-b.js';\nb();\n`);
      writeFileSync(join(tmp, 'cycle-b.ts'), `import { a } from './cycle-a.js';\nexport function b() { a(); }\n`);

      expect(findJsdomStorageOffenders(tmp)).toEqual([
        'vitest.cyclic.config.ts: ./cycle-a.ts never defines Storage.clear',
        'vitest.empty.config.ts: no setupFiles',
        'vitest.missing.config.ts: ./missing.ts never defines Storage.clear',
        'vitest.unused.config.ts: ./unused-setup.ts never defines Storage.clear',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
