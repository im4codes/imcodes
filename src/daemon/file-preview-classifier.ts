import * as path from 'node:path';
import { FS_READ_PREVIEW_REASONS, type FsReadPreviewReason } from '../../shared/fs-read-error-codes.js';

export const FS_READ_SIZE_LIMIT = 100 * 1024 * 1024;
export const BINARY_DETECTION_SAMPLE_BYTES = 8192;
export const MISSING_FILE_SIGNATURE = 'missing';

export const IMAGE_MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
} as const;

export const OFFICE_MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

export const VIDEO_MIME_BY_EXTENSION = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  ogg: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
} as const;

export const TEXT_MIME_BY_EXTENSION = {
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  json: 'application/json',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  sql: 'text/x-sql',
  lua: 'text/x-lua',
} as const;

export const PREVIEW_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ...TEXT_MIME_BY_EXTENSION,
  ...IMAGE_MIME_BY_EXTENSION,
  ...OFFICE_MIME_BY_EXTENSION,
  ...VIDEO_MIME_BY_EXTENSION,
};

export type FilePreviewType = 'text' | 'image' | 'office' | 'video' | 'too_large';

export interface FilePreviewClassification {
  previewType: FilePreviewType;
  previewKind: FilePreviewType;
  extension: string;
  size: number;
  sizeLimitBytes: number;
  mimeType?: string;
  previewMode?: 'stream';
  previewReason?: FsReadPreviewReason;
}

export interface FileSignatureStats {
  mtimeMs: number;
  size: number;
}

export function getFileExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

export function lookupPreviewMimeByExtension(extension: string): string | undefined {
  const normalized = extension.startsWith('.') ? extension.slice(1).toLowerCase() : extension.toLowerCase();
  return PREVIEW_MIME_BY_EXTENSION[normalized];
}

export function lookupPreviewMimeType(filePath: string): string | undefined {
  return lookupPreviewMimeByExtension(getFileExtension(filePath));
}

export function classifyPreviewByPath(filePath: string, size: number): FilePreviewClassification {
  const extension = getFileExtension(filePath);
  const imageMime = IMAGE_MIME_BY_EXTENSION[extension as keyof typeof IMAGE_MIME_BY_EXTENSION];
  const officeMime = OFFICE_MIME_BY_EXTENSION[extension as keyof typeof OFFICE_MIME_BY_EXTENSION];
  const videoMime = VIDEO_MIME_BY_EXTENSION[extension as keyof typeof VIDEO_MIME_BY_EXTENSION];
  const textMime = TEXT_MIME_BY_EXTENSION[extension as keyof typeof TEXT_MIME_BY_EXTENSION];
  const mimeType = imageMime ?? officeMime ?? videoMime ?? textMime;

  if (size > FS_READ_SIZE_LIMIT) {
    return {
      previewType: 'too_large',
      previewKind: 'too_large',
      extension,
      size,
      sizeLimitBytes: FS_READ_SIZE_LIMIT,
      mimeType,
      previewReason: FS_READ_PREVIEW_REASONS.TOO_LARGE,
    };
  }

  if (imageMime) {
    return { previewType: 'image', previewKind: 'image', extension, size, sizeLimitBytes: FS_READ_SIZE_LIMIT, mimeType: imageMime };
  }

  if (officeMime) {
    return { previewType: 'office', previewKind: 'office', extension, size, sizeLimitBytes: FS_READ_SIZE_LIMIT, mimeType: officeMime };
  }

  if (videoMime) {
    return { previewType: 'video', previewKind: 'video', extension, size, sizeLimitBytes: FS_READ_SIZE_LIMIT, mimeType: videoMime, previewMode: 'stream' };
  }

  return { previewType: 'text', previewKind: 'text', extension, size, sizeLimitBytes: FS_READ_SIZE_LIMIT, mimeType: textMime };
}

export function classifyFile(input: { realPath: string; size: number; mtimeMs?: number }): FilePreviewClassification {
  return classifyPreviewByPath(input.realPath, input.size);
}

export const classifyFilePreview = classifyFile;
export const classifyPreviewFile = classifyFile;

export function sampleBytesForBinaryDetection(bytes: Uint8Array, maxBytes = BINARY_DETECTION_SAMPLE_BYTES): Uint8Array {
  return bytes.subarray(0, Math.max(0, maxBytes));
}

export function sampleTextForBinaryDetection(text: string, maxChars = BINARY_DETECTION_SAMPLE_BYTES): string {
  return text.slice(0, Math.max(0, maxChars));
}

export function bytesContainNulByte(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

export function textContainsNulByte(text: string): boolean {
  return text.includes('\0');
}

export function isBinaryDetectionSample(sample: Uint8Array | string): boolean {
  return typeof sample === 'string' ? textContainsNulByte(sample) : bytesContainNulByte(sample);
}

export function isLikelyBinaryBuffer(bytes: Uint8Array, maxBytes = BINARY_DETECTION_SAMPLE_BYTES): boolean {
  return isBinaryDetectionSample(sampleBytesForBinaryDetection(bytes, maxBytes));
}

export const isBinaryBuffer = isLikelyBinaryBuffer;

export function isLikelyBinaryText(text: string, maxChars = BINARY_DETECTION_SAMPLE_BYTES): boolean {
  return isBinaryDetectionSample(sampleTextForBinaryDetection(text, maxChars));
}

export function createFileSignature(stats: FileSignatureStats): string {
  return `${stats.mtimeMs}:${stats.size}`;
}

export const fileSignatureForStat = createFileSignature;

export function isMissingFileSignature(signature: string): boolean {
  return signature === MISSING_FILE_SIGNATURE;
}

export function areFileSignaturesEqual(left: string, right: string): boolean {
  return left === right;
}
