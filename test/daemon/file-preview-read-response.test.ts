import { describe, expect, it } from 'vitest';
import { FS_READ_ERROR_CODES, FS_READ_PREVIEW_REASONS } from '../../shared/fs-read-error-codes.js';
import {
  assemblePreflightTerminal,
  assembleSnapshotTerminal,
} from '../../src/daemon/file-preview-read-response.js';
import type {
  PreviewReadPreflightSuccess,
  PreviewReadSnapshotSuccess,
} from '../../src/daemon/file-preview-read-types.js';

const realPath = '/tmp/imcodes-test-preview-response/project/report.txt';

function basePreflight(overrides: Partial<PreviewReadPreflightSuccess> = {}): PreviewReadPreflightSuccess {
  return {
    phase: 'preflight',
    workerRequestId: 1,
    workerSlotId: 1,
    workerGeneration: 1,
    kind: 'success',
    realPath,
    startSignature: '1000:11',
    size: 11,
    mtimeMs: 1000,
    fileName: 'report.txt',
    classification: {
      previewKind: 'text',
      extension: 'txt',
      mimeType: 'text/plain',
      sizeLimitBytes: 100 * 1024 * 1024,
    },
    ...overrides,
  };
}

function baseSnapshot(overrides: Partial<PreviewReadSnapshotSuccess> = {}): PreviewReadSnapshotSuccess {
  return {
    ...basePreflight(),
    phase: 'snapshot',
    workerRequestId: 2,
    kind: 'success',
    startSignature: '1000:11',
    endSignature: '1000:11',
    payload: { mode: 'text', content: 'hello world' },
    ...overrides,
  };
}

describe('file-preview read public response assembly', () => {
  it('returns text success without public encoding', () => {
    const response = assembleSnapshotTerminal({
      requestId: 'r-text',
      rawPath: '~/report.txt',
      snapshot: baseSnapshot(),
    });

    expect(response).toMatchObject({
      requestId: 'r-text',
      rawPath: '~/report.txt',
      resolvedPath: realPath,
      status: 'ok',
      content: 'hello world',
      downloadId: expect.any(String),
      mtime: 1000,
    });
    expect(response).not.toHaveProperty('encoding');
  });

  it('returns image and office payloads as base64 only', () => {
    const image = assembleSnapshotTerminal({
      requestId: 'r-image',
      rawPath: '/alias/image.png',
      snapshot: baseSnapshot({
        realPath: '/tmp/imcodes-test-preview-response/project/image.png',
        fileName: 'image.png',
        classification: { previewKind: 'image', mimeType: 'image/png', extension: 'png', sizeLimitBytes: 100 },
        payload: { mode: 'base64', content: 'aW1n', encoding: 'base64', mimeType: 'image/png' },
      }),
    });
    const office = assembleSnapshotTerminal({
      requestId: 'r-office',
      rawPath: '/alias/report.pdf',
      snapshot: baseSnapshot({
        realPath: '/tmp/imcodes-test-preview-response/project/report.pdf',
        fileName: 'report.pdf',
        classification: { previewKind: 'office', mimeType: 'application/pdf', extension: 'pdf', sizeLimitBytes: 100 },
        payload: { mode: 'base64', content: 'cGRm', encoding: 'base64', mimeType: 'application/pdf' },
      }),
    });

    expect(image).toMatchObject({ status: 'ok', encoding: 'base64', content: 'aW1n', mimeType: 'image/png' });
    expect(office).toMatchObject({ status: 'ok', encoding: 'base64', content: 'cGRm', mimeType: 'application/pdf' });
  });

  it('returns video stream mode without inline content', () => {
    const response = assembleSnapshotTerminal({
      requestId: 'r-video',
      rawPath: '/alias/movie.mp4',
      snapshot: baseSnapshot({
        realPath: '/tmp/imcodes-test-preview-response/project/movie.mp4',
        fileName: 'movie.mp4',
        size: 4096,
        classification: {
          previewKind: 'video',
          mimeType: 'video/mp4',
          extension: 'mp4',
          sizeLimitBytes: 100 * 1024 * 1024,
          previewMode: 'stream',
        },
        payload: { mode: 'stream', previewMode: 'stream', mimeType: 'video/mp4', size: 4096 },
      }),
    });

    expect(response).toMatchObject({
      status: 'ok',
      previewMode: 'stream',
      mimeType: 'video/mp4',
      size: 4096,
      downloadId: expect.any(String),
    });
    expect(response).not.toHaveProperty('content');
    expect(response).not.toHaveProperty('encoding');
  });

  it('keeps binary and too-large responses downloadable with shared public codes', () => {
    const binary = assembleSnapshotTerminal({
      requestId: 'r-binary',
      rawPath: '/alias/blob.bin',
      snapshot: baseSnapshot({
        realPath: '/tmp/imcodes-test-preview-response/project/blob.bin',
        fileName: 'blob.bin',
        classification: {
          previewKind: 'unknown',
          extension: 'bin',
          sizeLimitBytes: 100 * 1024 * 1024,
          previewReason: FS_READ_PREVIEW_REASONS.BINARY,
        },
        payload: {
          mode: 'unavailable',
          error: FS_READ_ERROR_CODES.BINARY_FILE,
          previewReason: FS_READ_PREVIEW_REASONS.BINARY,
        },
      }),
    });
    const tooLarge = assemblePreflightTerminal({
      requestId: 'r-large',
      rawPath: '/alias/huge.log',
      preflight: basePreflight({
        realPath: '/tmp/imcodes-test-preview-response/project/huge.log',
        fileName: 'huge.log',
        size: 101 * 1024 * 1024,
        classification: {
          previewKind: 'too_large',
          extension: 'log',
          mimeType: 'text/plain',
          sizeLimitBytes: 100 * 1024 * 1024,
          previewReason: FS_READ_PREVIEW_REASONS.TOO_LARGE,
        },
      }),
    });

    expect(binary).toMatchObject({
      status: 'error',
      error: FS_READ_ERROR_CODES.BINARY_FILE,
      previewReason: FS_READ_PREVIEW_REASONS.BINARY,
      downloadId: expect.any(String),
    });
    expect(tooLarge).toMatchObject({
      status: 'error',
      error: FS_READ_ERROR_CODES.FILE_TOO_LARGE,
      previewReason: FS_READ_PREVIEW_REASONS.TOO_LARGE,
      downloadId: expect.any(String),
    });
  });
});
