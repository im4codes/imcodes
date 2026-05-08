import { describe, expect, it, vi } from 'vitest';
import {
  FS_READ_ERROR_CODES,
  FS_READ_PREVIEW_REASONS,
} from '../../shared/fs-read-error-codes.js';
import { classifyFile } from '../../src/daemon/file-preview-classifier.js';
import {
  handlePreviewReadWorkerRequest,
  type PreviewReadWorkerDependencies,
} from '../../src/daemon/file-preview-read-worker.js';
import type { PreviewReadSnapshotRequest, PreviewReadWorkerRequest } from '../../src/daemon/file-preview-read-types.js';

const identity = {
  workerRequestId: 1,
  workerSlotId: 2,
  workerGeneration: 3,
};

function deps(overrides: Partial<PreviewReadWorkerDependencies> = {}): PreviewReadWorkerDependencies {
  return {
    errorCodes: {
      binaryFile: FS_READ_ERROR_CODES.BINARY_FILE,
      forbiddenPath: FS_READ_ERROR_CODES.FORBIDDEN_PATH,
      fileTooLarge: FS_READ_ERROR_CODES.FILE_TOO_LARGE,
      staleRead: FS_READ_ERROR_CODES.STALE_READ,
      invalidRequest: FS_READ_ERROR_CODES.INVALID_REQUEST,
      internalError: FS_READ_ERROR_CODES.INTERNAL_ERROR,
    },
    previewReasons: {
      binary: FS_READ_PREVIEW_REASONS.BINARY,
      tooLarge: FS_READ_PREVIEW_REASONS.TOO_LARGE,
      unknownType: FS_READ_PREVIEW_REASONS.UNKNOWN_TYPE,
    },
    resolveCanonicalStrict: vi.fn(async (rawPath: string) => `/real/${rawPath.replace(/^\/+/, '')}`),
    isPathAllowed: vi.fn(async () => true),
    stat: vi.fn(async () => ({ mtimeMs: 1000, size: 11, isFile: () => true })),
    readFile: vi.fn(async () => Buffer.from('hello world')),
    classifyFile: vi.fn((input) => classifyFile(input)),
    ...overrides,
  };
}

function snapshotRequest(path = '/real/file.txt'): PreviewReadSnapshotRequest {
  const classification = classifyFile({ realPath: path, size: 11, mtimeMs: 1000 });
  return {
    ...identity,
    phase: 'snapshot',
    realPath: path,
    startSignature: '1000:11',
    size: 11,
    mtimeMs: 1000,
    fileName: path.split('/').pop() ?? 'file.txt',
    classification,
  };
}

describe('file preview read worker', () => {
  it('preflights with strict canonical path, signature, classification, and no forbidden public fields', async () => {
    const result = await handlePreviewReadWorkerRequest({
      ...identity,
      phase: 'preflight',
      rawPath: 'file.txt',
    }, deps());

    expect(result).toMatchObject({
      ...identity,
      phase: 'preflight',
      kind: 'success',
      realPath: '/real/file.txt',
      startSignature: '1000:11',
      size: 11,
      mtimeMs: 1000,
      classification: { previewKind: 'text' },
    });
    expect(result).not.toHaveProperty('requestId');
    expect(result).not.toHaveProperty('downloadId');
    expect(result).not.toHaveProperty('serverLink');
    expect(result).not.toHaveProperty('stack');
  });

  it('returns forbidden_path when policy rejects the canonical path', async () => {
    const result = await handlePreviewReadWorkerRequest({
      ...identity,
      phase: 'preflight',
      rawPath: 'secret.txt',
    }, deps({ isPathAllowed: vi.fn(async () => false) }));

    expect(result).toMatchObject({
      phase: 'preflight',
      kind: 'error',
      error: FS_READ_ERROR_CODES.FORBIDDEN_PATH,
      sanitized: true,
    });
  });

  it('snapshots text, base64 image, video metadata, too-large, and binary responses', async () => {
    const text = await handlePreviewReadWorkerRequest(snapshotRequest('/real/file.txt'), deps());
    expect(text).toMatchObject({ phase: 'snapshot', kind: 'success', payload: { mode: 'text', content: 'hello world' } });

    const imageReq = snapshotRequest('/real/image.png');
    imageReq.classification = classifyFile({ realPath: imageReq.realPath, size: 4, mtimeMs: 1000 });
    const image = await handlePreviewReadWorkerRequest(imageReq, deps({
      stat: vi.fn(async () => ({ mtimeMs: 1000, size: 4, isFile: () => true })),
      readFile: vi.fn(async () => Buffer.from([1, 2, 3, 4])),
    }));
    expect(image).toMatchObject({ payload: { mode: 'base64', encoding: 'base64', mimeType: 'image/png' } });

    const videoReq = snapshotRequest('/real/movie.mp4');
    videoReq.classification = classifyFile({ realPath: videoReq.realPath, size: 11, mtimeMs: 1000 });
    const video = await handlePreviewReadWorkerRequest(videoReq, deps());
    expect(video).toMatchObject({ payload: { mode: 'stream', previewMode: 'stream', mimeType: 'video/mp4', size: 11 } });

    const hugeReq = snapshotRequest('/real/huge.txt');
    hugeReq.classification = { ...hugeReq.classification, previewKind: 'too_large', previewReason: FS_READ_PREVIEW_REASONS.TOO_LARGE };
    const huge = await handlePreviewReadWorkerRequest(hugeReq, deps());
    expect(huge).toMatchObject({
      payload: {
        mode: 'unavailable',
        error: FS_READ_ERROR_CODES.FILE_TOO_LARGE,
        previewReason: FS_READ_PREVIEW_REASONS.TOO_LARGE,
      },
    });

    const binary = await handlePreviewReadWorkerRequest(snapshotRequest('/real/blob.bin'), deps({
      readFile: vi.fn(async () => Buffer.from([65, 0, 66])),
    }));
    expect(binary).toMatchObject({
      payload: {
        mode: 'unavailable',
        error: FS_READ_ERROR_CODES.BINARY_FILE,
        previewReason: FS_READ_PREVIEW_REASONS.BINARY,
      },
    });
  });

  it('reports start and end signatures so the coordinator can reject stale snapshots', async () => {
    const req = snapshotRequest('/real/file.txt');
    const result = await handlePreviewReadWorkerRequest(req, deps({
      stat: vi.fn(async () => ({ mtimeMs: 2000, size: 12, isFile: () => true })),
    }));

    expect(result).toMatchObject({
      phase: 'snapshot',
      kind: 'success',
      startSignature: '1000:11',
      endSignature: '2000:12',
    });
  });

  it('sanitizes thrown worker errors to internal_error', async () => {
    const request: PreviewReadWorkerRequest = { ...identity, phase: 'preflight', rawPath: 'boom.txt' };
    const result = await handlePreviewReadWorkerRequest(request, deps({
      resolveCanonicalStrict: vi.fn(async () => {
        throw new Error('/home/user/project/boom.txt ENOENT stack');
      }),
    }));

    expect(result).toMatchObject({
      kind: 'error',
      error: FS_READ_ERROR_CODES.INTERNAL_ERROR,
      sanitized: true,
    });
    expect(JSON.stringify(result)).not.toContain('/home/user/project');
  });
});
