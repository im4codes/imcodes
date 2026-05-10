import { describe, expect, expectTypeOf, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FS_GENERIC_ERROR_CODES,
  FS_GENERIC_ERROR_CODE_VALUES,
  isFsGenericErrorCode,
  type FsGenericErrorCode,
} from '../../shared/fs-error-codes.js';
import {
  FS_READ_ERROR_CODES,
  FS_READ_ERROR_CODE_VALUES,
  FS_READ_PREVIEW_REASONS,
  FS_READ_PREVIEW_REASON_VALUES,
  isFsReadErrorCode,
  isFsReadPreviewReason,
  type FsReadErrorCode,
  type FsReadPreviewReason,
} from '../../shared/fs-read-error-codes.js';

const PRODUCTION_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const ALLOWED_NON_FS_READ_LITERAL_FILES = new Map<string, ReadonlySet<string>>([
  ['server/src/routes/file-transfer.ts', new Set(['file_too_large'])],
  ['server/src/routes/session-mgmt.ts', new Set(['invalid_request', 'internal_error'])],
  ['server/src/routes/terminal.ts', new Set(['internal_error'])],
  ['server/src/ws/bridge.ts', new Set(['invalid_request'])],
  ['src/daemon/file-preview-read-observability.ts', new Set(['stale_read'])],
  ['src/daemon/session-group-clone.ts', new Set(['invalid_request', 'internal_error'])],
  ['web/src/components/CloneSessionGroupDialog.tsx', new Set(['internal_error'])],
  ['web/src/components/SessionControls.tsx', new Set(['file_too_large'])],
]);

function collectProductionSources(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const relative = fullPath.slice(root.length + 1);
      if (
        relative.includes('/test/')
        || relative.includes('/__fixtures__/')
        || relative.includes('/dist/')
        || relative.includes('/build/')
        || relative.endsWith('.test.ts')
        || relative.endsWith('.test.tsx')
        || relative.endsWith('.spec.ts')
        || relative.endsWith('.spec.tsx')
      ) {
        continue;
      }
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath);
        continue;
      }
      const extension = fullPath.slice(fullPath.lastIndexOf('.'));
      if (PRODUCTION_SOURCE_EXTENSIONS.has(extension)) result.push(fullPath);
    }
  };
  visit(root);
  return result;
}

describe('fs-read shared error constants', () => {
  it('exports generic fs error codes for non-read filesystem commands', () => {
    expect(FS_GENERIC_ERROR_CODES.FORBIDDEN_PATH).toBe('forbidden_path');
    expect(FS_GENERIC_ERROR_CODES.FILE_TOO_LARGE).toBe('file_too_large');
    expect(FS_GENERIC_ERROR_CODES.INVALID_REQUEST).toBe('invalid_request');
    expect(FS_GENERIC_ERROR_CODES.INTERNAL_ERROR).toBe('internal_error');
    expect(new Set(FS_GENERIC_ERROR_CODE_VALUES).size).toBe(FS_GENERIC_ERROR_CODE_VALUES.length);

    const value: unknown = 'internal_error';
    expect(isFsGenericErrorCode(value)).toBe(true);
    if (isFsGenericErrorCode(value)) {
      expectTypeOf(value).toEqualTypeOf<FsGenericErrorCode>();
    }
  });

  it('preserves legacy public wire values', () => {
    expect(FS_READ_ERROR_CODES.BINARY_FILE).toBe('binary_file');
    expect(FS_READ_ERROR_CODES.FORBIDDEN_PATH).toBe('forbidden_path');
    expect(FS_READ_ERROR_CODES.FILE_TOO_LARGE).toBe('file_too_large');
  });

  it('exports stable worker and control error codes', () => {
    expect(FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL).toBe('preview_worker_queue_full');
    expect(FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT).toBe('preview_worker_timeout');
    expect(FS_READ_ERROR_CODES.PREVIEW_WORKER_UNAVAILABLE).toBe('preview_worker_unavailable');
    expect(FS_READ_ERROR_CODES.PREVIEW_WORKER_CRASHED).toBe('preview_worker_crashed');
    expect(FS_READ_ERROR_CODES.STALE_READ).toBe('stale_read');
    expect(FS_READ_ERROR_CODES.INVALID_REQUEST).toBe('invalid_request');
    expect(FS_READ_ERROR_CODES.INTERNAL_ERROR).toBe('internal_error');
    expect(new Set(FS_READ_ERROR_CODE_VALUES).size).toBe(FS_READ_ERROR_CODE_VALUES.length);
  });

  it('exports preview reasons and guards their wire values', () => {
    expect(FS_READ_PREVIEW_REASONS.TOO_LARGE).toBe('too_large');
    expect(FS_READ_PREVIEW_REASONS.BINARY).toBe('binary');
    expect(FS_READ_PREVIEW_REASONS.UNKNOWN_TYPE).toBe('unknown_type');
    expect(new Set(FS_READ_PREVIEW_REASON_VALUES).size).toBe(FS_READ_PREVIEW_REASON_VALUES.length);
  });

  it('narrows error codes and preview reasons with type guards', () => {
    const error: unknown = 'preview_worker_timeout';
    const reason: unknown = 'binary';

    expect(isFsReadErrorCode(error)).toBe(true);
    expect(isFsReadErrorCode('preview_worker_missing')).toBe(false);
    expect(isFsReadPreviewReason(reason)).toBe(true);
    expect(isFsReadPreviewReason('text')).toBe(false);

    if (isFsReadErrorCode(error)) {
      expectTypeOf(error).toEqualTypeOf<FsReadErrorCode>();
    }
    if (isFsReadPreviewReason(reason)) {
      expectTypeOf(reason).toEqualTypeOf<FsReadPreviewReason>();
    }
  });

  it('keeps fs-read production consumers importing shared wire error values instead of redefining them', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const productionConsumers = [
      ...collectProductionSources(join(repoRoot, 'src')),
      ...collectProductionSources(join(repoRoot, 'web/src')),
      ...collectProductionSources(join(repoRoot, 'server/src')),
    ];
    const forbiddenLiterals = [
      'binary_file',
      'forbidden_path',
      'file_too_large',
      'preview_worker_queue_full',
      'preview_worker_timeout',
      'preview_worker_unavailable',
      'preview_worker_crashed',
      'stale_read',
      'invalid_request',
      'internal_error',
    ];

    for (const fullPath of productionConsumers) {
      const relativePath = fullPath.slice(repoRoot.length + 1);
      const source = readFileSync(fullPath, 'utf8');
      for (const literal of forbiddenLiterals) {
        if (ALLOWED_NON_FS_READ_LITERAL_FILES.get(relativePath)?.has(literal)) continue;
        expect(source, `${relativePath} should use FS_READ_ERROR_CODES for ${literal}`).not.toContain(`'${literal}'`);
        expect(source, `${relativePath} should use FS_READ_ERROR_CODES for ${literal}`).not.toContain(`"${literal}"`);
      }
    }
  });
});
