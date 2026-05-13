import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TIMELINE_MESSAGES } from '../../shared/timeline-protocol.js';

const TIMELINE_PROTOCOL_MESSAGES = new Set<string>([
  TIMELINE_MESSAGES.HISTORY_REQUEST,
  TIMELINE_MESSAGES.HISTORY,
  TIMELINE_MESSAGES.REPLAY_REQUEST,
  TIMELINE_MESSAGES.REPLAY,
  TIMELINE_MESSAGES.PAGE_REQUEST,
  TIMELINE_MESSAGES.PAGE,
  TIMELINE_MESSAGES.DETAIL_REQUEST,
  TIMELINE_MESSAGES.DETAIL,
]);

const SCAN_ROOTS = [
  'shared',
  'src',
  'server/src',
  'web/src',
  'test',
  'server/test',
  'web/test',
];

const ALLOWED_EXACT_PATHS = new Set([
  'shared/timeline-protocol.ts',
  'test/shared/timeline-protocol-magic-string.test.ts',
]);

const KNOWN_COMPATIBILITY_TESTS = new Set([
  'server/test/bridge.test.ts',
  'test/daemon/command-handler-bad-input.test.ts',
  'test/daemon/command-handler-timeline-history-parity.test.ts',
  'test/daemon/command-handler-timeline-history-projection.test.ts',
  'web/test/use-timeline-cache.test.ts',
  'web/test/use-timeline-optimistic.test.ts',
]);

const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);

interface LiteralOccurrence {
  path: string;
  line: number;
  column: number;
  value: string;
}

function toPosixPath(path: string): string {
  return path.split('\\').join('/');
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index) : '';
}

function isFixtureOrSnapshotPath(path: string): boolean {
  return /(^|\/)(?:__fixtures__|fixtures|__snapshots__|snapshots)(?:\/|$)/.test(path);
}

function isAllowedPath(path: string): boolean {
  return (
    ALLOWED_EXACT_PATHS.has(path)
    || KNOWN_COMPATIBILITY_TESTS.has(path)
    || isFixtureOrSnapshotPath(path)
  );
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const entries = readdirSync(root);
  for (const entry of entries) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
      out.push(...walkFiles(path));
      continue;
    }
    if (stats.isFile() && SOURCE_EXTENSIONS.has(extensionOf(entry))) out.push(path);
  }
  return out;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectTimelineLiterals(path: string): LiteralOccurrence[] {
  const sourceText = readFileSync(path, 'utf8');
  if (!sourceText.includes('timeline.')) return [];

  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const relativePath = toPosixPath(relative(process.cwd(), path));
  const occurrences: LiteralOccurrence[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      const text = (node as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
      if (TIMELINE_PROTOCOL_MESSAGES.has(text)) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        occurrences.push({
          path: relativePath,
          line: position.line + 1,
          column: position.character + 1,
          value: text,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return occurrences;
}

describe('timeline protocol magic strings', () => {
  it('keeps shared timeline message names centralized outside compatibility fixtures', () => {
    const violations = SCAN_ROOTS
      .flatMap((root) => walkFiles(root))
      .flatMap(collectTimelineLiterals)
      .filter((occurrence) => !isAllowedPath(occurrence.path))
      .map((occurrence) => `${occurrence.path}:${occurrence.line}:${occurrence.column} ${occurrence.value}`);

    expect(violations, [
      'Timeline protocol message names must come from shared/timeline-protocol.ts.',
      'Move implementation code to TIMELINE_MESSAGES imports, or add a narrowly named compatibility test/fixture exemption.',
      ...violations,
    ].join('\n')).toEqual([]);
  });
});
