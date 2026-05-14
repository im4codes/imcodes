import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  TIMELINE_DETAIL_FIELD_PATHS,
  TIMELINE_MESSAGES,
  TIMELINE_PROTOCOL_CAPABILITY,
  TIMELINE_RESPONSE_SOURCES,
} from '../../shared/timeline-protocol.js';
import {
  TIMELINE_DETAIL_ERROR_REASONS,
  TIMELINE_HISTORY_ERROR_REASONS,
  TIMELINE_PAGE_ERROR_REASONS,
  TIMELINE_REQUEST_ERROR_REASONS,
} from '../../shared/timeline-history-errors.js';

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

const TIMELINE_PROTOCOL_LITERALS = new Set<string>([
  ...TIMELINE_PROTOCOL_MESSAGES,
  TIMELINE_PROTOCOL_CAPABILITY,
  TIMELINE_RESPONSE_SOURCES.RING_BUFFER,
  TIMELINE_RESPONSE_SOURCES.WORKER_SQLITE,
  TIMELINE_RESPONSE_SOURCES.MAIN_SQLITE,
  TIMELINE_RESPONSE_SOURCES.JSONL_TAIL,
  TIMELINE_RESPONSE_SOURCES.RING_BUFFER_JSONL,
  TIMELINE_RESPONSE_SOURCES.OPENCODE_EXPORT,
  TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_TEXT,
  TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_OUTPUT,
  TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_ERROR,
  TIMELINE_DETAIL_FIELD_PATHS.PAYLOAD_DETAIL_OUTPUT,
  TIMELINE_HISTORY_ERROR_REASONS.DEADLINE_EXCEEDED,
  TIMELINE_HISTORY_ERROR_REASONS.REQUEST_CANCELED,
  TIMELINE_HISTORY_ERROR_REASONS.PROJECTION_UNAVAILABLE,
  TIMELINE_DETAIL_ERROR_REASONS.EXPIRED,
  TIMELINE_DETAIL_ERROR_REASONS.MISSING,
  TIMELINE_DETAIL_ERROR_REASONS.UNAUTHORIZED,
  TIMELINE_DETAIL_ERROR_REASONS.OVERSIZED,
  TIMELINE_DETAIL_ERROR_REASONS.MALFORMED,
  TIMELINE_DETAIL_ERROR_REASONS.EPOCH_MISMATCH,
  TIMELINE_DETAIL_ERROR_REASONS.GENERATION_MISMATCH,
  TIMELINE_PAGE_ERROR_REASONS.CURSOR_RESET,
  TIMELINE_PAGE_ERROR_REASONS.MALFORMED,
]);

const TIMELINE_PROTOCOL_LITERAL_NEEDLES = [...TIMELINE_PROTOCOL_LITERALS];

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
  'shared/timeline-history-errors.ts',
  'shared/timeline-protocol.ts',
  'test/shared/timeline-protocol-magic-string.test.ts',
]);

const KNOWN_COMPATIBILITY_TESTS = new Set([
  'server/test/bridge.test.ts',
  'test/daemon/command-handler-bad-input.test.ts',
  'test/daemon/command-handler-timeline-history-parity.test.ts',
  'test/daemon/command-handler-timeline-history-projection.test.ts',
  'test/daemon/command-handler-transport-queue.test.ts',
  'test/daemon/timeline-detail-store.test.ts',
  'test/daemon/timeline-history-sanitize.test.ts',
  'test/daemon/timeline-response-shaper.test.ts',
  'test/daemon/timeline-store.projection-fallback.test.ts',
  'test/shared/timeline-merge.test.ts',
  'web/test/timeline-db.test.ts',
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
  if (!TIMELINE_PROTOCOL_LITERAL_NEEDLES.some((needle) => sourceText.includes(needle))) return [];

  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const relativePath = toPosixPath(relative(process.cwd(), path));
  const occurrences: LiteralOccurrence[] = [];

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      const text = (node as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
      if (TIMELINE_PROTOCOL_LITERALS.has(text)) {
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
  it('keeps shared timeline protocol literals centralized outside compatibility fixtures', () => {
    const violations = SCAN_ROOTS
      .flatMap((root) => walkFiles(root))
      .flatMap(collectTimelineLiterals)
      .filter((occurrence) => !isAllowedPath(occurrence.path))
      .map((occurrence) => `${occurrence.path}:${occurrence.line}:${occurrence.column} ${occurrence.value}`);

    expect(violations, [
      'Timeline protocol literals must come from shared/timeline-protocol.ts or shared/timeline-history-errors.ts.',
      'Move implementation code to shared constant imports, or add a narrowly named compatibility test/fixture exemption.',
      ...violations,
    ].join('\n')).toEqual([]);
  });

  it('keeps required timeline terminal error reasons stable in shared constants', () => {
    expect(TIMELINE_REQUEST_ERROR_REASONS).toMatchObject({
      MALFORMED_REQUEST: 'malformed_request',
      QUEUE_FULL: 'queue_full',
      DEADLINE_EXCEEDED: 'deadline_exceeded',
      REQUEST_CANCELED: 'request_canceled',
      UNAVAILABLE: 'unavailable',
      CRASHED: 'crashed',
      SHUTDOWN: 'shutdown',
      TIMEOUT: 'timeout',
      PROJECTION_UNAVAILABLE: 'projection_unavailable',
      INTERNAL_ERROR: 'internal_error',
      EXPIRED: 'detail_expired',
      MISSING: 'detail_missing',
      UNAUTHORIZED: 'detail_unauthorized',
      OVERSIZED: 'detail_oversized',
      DETAIL_MALFORMED: 'detail_malformed',
      EPOCH_MISMATCH: 'detail_epoch_mismatch',
      GENERATION_MISMATCH: 'detail_generation_mismatch',
      CURSOR_RESET: 'page_cursor_reset',
      PAGE_MALFORMED: 'page_malformed',
    });
  });
});
