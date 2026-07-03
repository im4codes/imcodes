import { describe, expect, it } from 'vitest';
import { FS_READ_PREVIEW_REASONS } from '../../shared/fs-read-error-codes.js';
import {
  BINARY_DETECTION_SAMPLE_BYTES,
  FS_READ_SIZE_LIMIT,
  MISSING_FILE_SIGNATURE,
  areFileSignaturesEqual,
  bytesContainNulByte,
  classifyPreviewByPath,
  createFileSignature,
  getFileExtension,
  isLikelyBinaryBuffer,
  isLikelyBinaryText,
  isMissingFileSignature,
  lookupPreviewMimeByExtension,
  lookupPreviewMimeType,
  sampleBytesForBinaryDetection,
  textContainsNulByte,
} from '../../src/daemon/file-preview-classifier.js';

describe('file preview classifier', () => {
  it('classifies known text files', () => {
    expect(classifyPreviewByPath('/repo/README.md', 42)).toMatchObject({
      previewType: 'text',
      previewKind: 'text',
      extension: 'md',
      size: 42,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType: 'text/markdown',
    });
  });

  it('classifies image previews', () => {
    expect(classifyPreviewByPath('/repo/image.PNG', 10)).toMatchObject({
      previewType: 'image',
      previewKind: 'image',
      extension: 'png',
      size: 10,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType: 'image/png',
    });
  });

  it('classifies office previews', () => {
    expect(classifyPreviewByPath('/repo/report.docx', 10)).toMatchObject({
      previewType: 'office',
      extension: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(classifyPreviewByPath('/repo/table.xlsx', 10).previewType).toBe('office');
    expect(classifyPreviewByPath('/repo/file.pdf', 10).mimeType).toBe('application/pdf');
  });

  it('classifies video previews as stream mode', () => {
    expect(classifyPreviewByPath('/repo/movie.mp4', 10)).toMatchObject({
      previewType: 'video',
      previewKind: 'video',
      extension: 'mp4',
      size: 10,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType: 'video/mp4',
      previewMode: 'stream',
    });
  });

  it('classifies audio previews as stream mode', () => {
    expect(classifyPreviewByPath('/repo/voice.MP3', 10)).toMatchObject({
      previewType: 'audio',
      previewKind: 'audio',
      extension: 'mp3',
      size: 10,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType: 'audio/mpeg',
      previewMode: 'stream',
    });
    expect(classifyPreviewByPath('/repo/clip.wav', 10).mimeType).toBe('audio/wav');
    expect(classifyPreviewByPath('/repo/song.flac', 10).previewType).toBe('audio');
    expect(classifyPreviewByPath('/repo/note.ogg', 10)).toMatchObject({
      previewType: 'audio',
      mimeType: 'audio/ogg',
    });
  });

  it('classifies too-large files before inline preview type', () => {
    expect(classifyPreviewByPath('/repo/huge.png', FS_READ_SIZE_LIMIT + 1)).toMatchObject({
      previewType: 'too_large',
      previewKind: 'too_large',
      extension: 'png',
      size: FS_READ_SIZE_LIMIT + 1,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType: 'image/png',
      previewReason: FS_READ_PREVIEW_REASONS.TOO_LARGE,
    });
  });

  it('treats unknown extensions as text candidates for later binary detection', () => {
    expect(classifyPreviewByPath('/repo/blob.unknownext', 10)).toMatchObject({
      previewType: 'text',
      previewKind: 'text',
      extension: 'unknownext',
      size: 10,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType: undefined,
    });
    expect(lookupPreviewMimeByExtension('unknownext')).toBeUndefined();
  });

  it('looks up MIME types and extensions consistently', () => {
    expect(getFileExtension('/repo/archive.TS')).toBe('ts');
    expect(lookupPreviewMimeByExtension('.webm')).toBe('video/webm');
    expect(lookupPreviewMimeByExtension('.mp3')).toBe('audio/mpeg');
    expect(lookupPreviewMimeType('/repo/image.jpeg')).toBe('image/jpeg');
  });

  it('samples and detects binary content with NUL bytes', () => {
    const bytes = Uint8Array.from([65, 66, 0, 67, 68]);
    const longBytes = Uint8Array.from({ length: BINARY_DETECTION_SAMPLE_BYTES + 5 }, (_, index) => index % 255);

    expect(sampleBytesForBinaryDetection(longBytes)).toHaveLength(BINARY_DETECTION_SAMPLE_BYTES);
    expect(bytesContainNulByte(bytes)).toBe(true);
    expect(textContainsNulByte('hello\0world')).toBe(true);
    expect(isLikelyBinaryBuffer(bytes)).toBe(true);
    expect(isLikelyBinaryText('plain text')).toBe(false);
  });

  it('creates and compares file signatures', () => {
    const signature = createFileSignature({ mtimeMs: 123.5, size: 456 });

    expect(signature).toBe('123.5:456');
    expect(areFileSignaturesEqual(signature, '123.5:456')).toBe(true);
    expect(areFileSignaturesEqual(signature, '123.5:457')).toBe(false);
    expect(isMissingFileSignature(MISSING_FILE_SIGNATURE)).toBe(true);
    expect(isMissingFileSignature(signature)).toBe(false);
  });
});
