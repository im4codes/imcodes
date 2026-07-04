import { parentPort } from 'node:worker_threads';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import type { Stats } from 'node:fs';
import type { FsReadErrorCode, FsReadPreviewReason } from '../../shared/fs-read-error-codes.js';
import type {
  PreviewReadClassification,
  PreviewReadPreflightRequest,
  PreviewReadSnapshotSuccess,
  PreviewReadSnapshotRequest,
  PreviewReadWorkerError,
  PreviewReadWorkerRequest,
  PreviewReadWorkerResult,
  PreviewReadWorkerResultBase,
} from './file-preview-read-types.js';

export interface PreviewReadWorkerErrorCodes {
  binaryFile: FsReadErrorCode;
  forbiddenPath: FsReadErrorCode;
  fileTooLarge: FsReadErrorCode;
  staleRead: FsReadErrorCode;
  invalidRequest: FsReadErrorCode;
  internalError: FsReadErrorCode;
  /** Optional: code returned when the path is a directory. Falls back to
   *  internalError when a caller (e.g. an older test deps) doesn't supply it. */
  isDirectory?: FsReadErrorCode;
}

export interface PreviewReadWorkerPreviewReasons {
  binary: FsReadPreviewReason;
  tooLarge: FsReadPreviewReason;
  unknownType: FsReadPreviewReason;
}

export interface PreviewReadWorkerStatView {
  mtimeMs: number;
  size: number;
  isFile?: () => boolean;
  isDirectory?: () => boolean;
}

export interface PreviewReadWorkerDependencies {
  errorCodes: PreviewReadWorkerErrorCodes;
  previewReasons: PreviewReadWorkerPreviewReasons;
  resolveCanonicalStrict(rawPath: string): Promise<string | null>;
  isPathAllowed(realPath: string): boolean | Promise<boolean>;
  stat(realPath: string): Promise<PreviewReadWorkerStatView>;
  readFile(realPath: string): Promise<Buffer | Uint8Array | string>;
  classifyFile(input: {
    realPath: string;
    size: number;
    mtimeMs: number;
  }): PreviewReadClassification | Promise<PreviewReadClassification>;
  isBinaryBuffer?(buffer: Buffer): boolean;
  signatureForStat?(stats: PreviewReadWorkerStatView): string;
}

type DefaultPolicyModule = Record<string, unknown>;
type DefaultClassifierModule = Record<string, unknown>;
type DefaultSharedCodesModule = Record<string, unknown>;

const BINARY_SCAN_BYTES = 8192;

function statSignature(stats: PreviewReadWorkerStatView): string {
  return `${stats.mtimeMs}:${stats.size}`;
}

function toBuffer(value: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function hasNulByte(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SCAN_BYTES).includes(0);
}

function baseResult(message: PreviewReadWorkerRequest): PreviewReadWorkerResultBase {
  return {
    phase: message.phase,
    workerRequestId: message.workerRequestId,
    workerSlotId: message.workerSlotId,
    workerGeneration: message.workerGeneration,
  };
}

function workerError(
  message: PreviewReadWorkerRequest,
  error: FsReadErrorCode,
  previewReason?: FsReadPreviewReason,
): PreviewReadWorkerError {
  return {
    ...baseResult(message),
    kind: 'error',
    error,
    ...(previewReason ? { previewReason } : {}),
    sanitized: true,
  };
}

function workerPreviewUnavailable(
  message: PreviewReadSnapshotRequest,
  error: FsReadErrorCode,
  previewReason?: FsReadPreviewReason,
): PreviewReadSnapshotSuccess {
  return {
    ...baseResult(message),
    phase: 'snapshot',
    kind: 'success',
    realPath: message.realPath,
    startSignature: message.startSignature,
    endSignature: message.startSignature,
    size: message.size,
    mtimeMs: message.mtimeMs,
    fileName: message.fileName,
    classification: message.classification,
    payload: {
      mode: 'unavailable',
      error,
      ...(previewReason ? { previewReason } : {}),
    },
  };
}

async function handlePreflight(
  message: PreviewReadPreflightRequest,
  deps: PreviewReadWorkerDependencies,
): Promise<PreviewReadWorkerResult> {
  if (message.rawPath.trim() === '') {
    return workerError(message, deps.errorCodes.invalidRequest);
  }

  const realPath = await deps.resolveCanonicalStrict(message.rawPath);
  if (!realPath) {
    return workerError(message, deps.errorCodes.internalError);
  }

  const allowed = await deps.isPathAllowed(realPath);
  if (!allowed) {
    return workerError(message, deps.errorCodes.forbiddenPath);
  }

  const stats = await deps.stat(realPath);
  if (stats.isFile && !stats.isFile()) {
    // A directory is not a "failed" preview — signal it distinctly so the
    // client can open the folder listing instead of showing a preview error.
    if (stats.isDirectory?.()) {
      return workerError(message, deps.errorCodes.isDirectory ?? deps.errorCodes.internalError);
    }
    return workerError(message, deps.errorCodes.internalError);
  }

  const classification = await deps.classifyFile({
    realPath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  });

  return {
    ...baseResult(message),
    phase: 'preflight',
    kind: 'success',
    realPath,
    startSignature: deps.signatureForStat?.(stats) ?? statSignature(stats),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    fileName: basename(realPath),
    classification,
  };
}

async function handleSnapshot(
  message: PreviewReadSnapshotRequest,
  deps: PreviewReadWorkerDependencies,
): Promise<PreviewReadWorkerResult> {
  const classification = message.classification;
  const mimeType = classification.mimeType;

  if (classification.previewKind === 'too_large') {
    const endStats = await deps.stat(message.realPath);
    return {
      ...workerPreviewUnavailable(message, deps.errorCodes.fileTooLarge, deps.previewReasons.tooLarge),
      endSignature: deps.signatureForStat?.(endStats) ?? statSignature(endStats),
      size: endStats.size,
      mtimeMs: endStats.mtimeMs,
    };
  }

  if ((classification.previewKind === 'video' || classification.previewKind === 'audio') && mimeType) {
    const endStats = await deps.stat(message.realPath);
    return {
      ...baseResult(message),
      phase: 'snapshot',
      kind: 'success',
      realPath: message.realPath,
      startSignature: message.startSignature,
      endSignature: deps.signatureForStat?.(endStats) ?? statSignature(endStats),
      size: endStats.size,
      mtimeMs: endStats.mtimeMs,
      fileName: message.fileName,
      classification,
      payload: {
        mode: 'stream',
        previewMode: 'stream',
        mimeType,
        size: endStats.size,
      },
    };
  }

  const buffer = toBuffer(await deps.readFile(message.realPath));
  const endStats = await deps.stat(message.realPath);
  const endSignature = deps.signatureForStat?.(endStats) ?? statSignature(endStats);

  if ((classification.previewKind === 'image' || classification.previewKind === 'office') && mimeType) {
    return {
      ...baseResult(message),
      phase: 'snapshot',
      kind: 'success',
      realPath: message.realPath,
      startSignature: message.startSignature,
      endSignature,
      size: endStats.size,
      mtimeMs: endStats.mtimeMs,
      fileName: message.fileName,
      classification,
      payload: {
        mode: 'base64',
        content: buffer.toString('base64'),
        encoding: 'base64',
        mimeType,
      },
    };
  }

  const isBinary = deps.isBinaryBuffer ? deps.isBinaryBuffer(buffer) : hasNulByte(buffer);
  if (isBinary) {
    return {
      ...workerPreviewUnavailable(message, deps.errorCodes.binaryFile, deps.previewReasons.binary),
      endSignature,
      size: endStats.size,
      mtimeMs: endStats.mtimeMs,
    };
  }

  return {
    ...baseResult(message),
    phase: 'snapshot',
    kind: 'success',
    realPath: message.realPath,
    startSignature: message.startSignature,
    endSignature,
    size: endStats.size,
    mtimeMs: endStats.mtimeMs,
    fileName: message.fileName,
    classification,
    payload: {
      mode: 'text',
      content: buffer.toString('utf8'),
    },
  };
}

export async function handlePreviewReadWorkerRequest(
  message: PreviewReadWorkerRequest,
  deps: PreviewReadWorkerDependencies,
): Promise<PreviewReadWorkerResult> {
  try {
    switch (message.phase) {
      case 'preflight':
        return await handlePreflight(message, deps);
      case 'snapshot':
        return await handleSnapshot(message, deps);
    }
  } catch {
    return workerError(message, deps.errorCodes.internalError);
  }
}

function pickString(container: unknown, keys: string[]): string {
  if (!container || typeof container !== 'object') {
    throw new Error('missing fs-read worker constants');
  }
  const record = container as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  throw new Error('missing fs-read worker constant');
}

function getCallable<T extends (...args: never[]) => unknown>(module: Record<string, unknown>, names: string[]): T {
  for (const name of names) {
    const value = module[name];
    if (typeof value === 'function') return value as T;
  }
  throw new Error('missing preview-read worker dependency');
}

export async function createDefaultPreviewReadWorkerDependencies(): Promise<PreviewReadWorkerDependencies> {
  const policyModuleName = './file-preview-path-policy.js';
  const classifierModuleName = './file-preview-classifier.js';
  const sharedCodesModuleName = '../../shared/fs-read-error-codes.js';
  const [policyModule, classifierModule, sharedCodesModule] = await Promise.all([
    import(policyModuleName) as Promise<DefaultPolicyModule>,
    import(classifierModuleName) as Promise<DefaultClassifierModule>,
    import(sharedCodesModuleName) as Promise<DefaultSharedCodesModule>,
  ]);

  const errorContainer = sharedCodesModule.FS_READ_ERROR_CODES;
  const previewReasonContainer = sharedCodesModule.FS_READ_PREVIEW_REASONS;
  const expandFilePreviewPath = typeof policyModule.expandFilePreviewPath === 'function'
    ? policyModule.expandFilePreviewPath as (rawPath: string) => string
    : (rawPath: string) => rawPath;
  const isPathAllowed = getCallable<(realPath: string) => boolean | Promise<boolean>>(
    policyModule,
    ['isFilePreviewPathAllowed', 'isPathAllowed', 'isPreviewPathAllowed'],
  );
  const classifyFile = getCallable<
    (input: { realPath: string; size: number; mtimeMs: number }) => PreviewReadClassification | Promise<PreviewReadClassification>
  >(classifierModule, ['classifyFilePreview', 'classifyPreviewFile', 'classifyFile']);
  const isBinaryBuffer = typeof classifierModule.isBinaryBuffer === 'function'
    ? classifierModule.isBinaryBuffer as (buffer: Buffer) => boolean
    : undefined;
  const signatureForStat = typeof classifierModule.fileSignatureForStat === 'function'
    ? classifierModule.fileSignatureForStat as (stats: PreviewReadWorkerStatView) => string
    : undefined;

  return {
    errorCodes: {
      binaryFile: pickString(errorContainer, ['BINARY_FILE', 'binaryFile']) as FsReadErrorCode,
      forbiddenPath: pickString(errorContainer, ['FORBIDDEN_PATH', 'forbiddenPath']) as FsReadErrorCode,
      fileTooLarge: pickString(errorContainer, ['FILE_TOO_LARGE', 'fileTooLarge']) as FsReadErrorCode,
      staleRead: pickString(errorContainer, ['STALE_READ', 'staleRead']) as FsReadErrorCode,
      invalidRequest: pickString(errorContainer, ['INVALID_REQUEST', 'invalidRequest']) as FsReadErrorCode,
      internalError: pickString(errorContainer, ['INTERNAL_ERROR', 'internalError']) as FsReadErrorCode,
      isDirectory: pickString(errorContainer, ['IS_DIRECTORY', 'isDirectory']) as FsReadErrorCode,
    },
    previewReasons: {
      binary: pickString(previewReasonContainer, ['BINARY', 'binary']) as FsReadPreviewReason,
      tooLarge: pickString(previewReasonContainer, ['TOO_LARGE', 'tooLarge']) as FsReadPreviewReason,
      unknownType: pickString(previewReasonContainer, ['UNKNOWN_TYPE', 'unknownType']) as FsReadPreviewReason,
    },
    async resolveCanonicalStrict(rawPath) {
      return await realpath(resolvePath(expandFilePreviewPath(rawPath)));
    },
    isPathAllowed,
    stat: async (realPath: string) => stat(realPath) as Promise<Stats>,
    readFile: async (realPath: string) => readFile(realPath),
    classifyFile,
    ...(isBinaryBuffer ? { isBinaryBuffer } : {}),
    ...(signatureForStat ? { signatureForStat } : {}),
  };
}

let defaultDepsPromise: Promise<PreviewReadWorkerDependencies> | null = null;

async function getDefaultDependencies(): Promise<PreviewReadWorkerDependencies> {
  defaultDepsPromise ??= createDefaultPreviewReadWorkerDependencies();
  return await defaultDepsPromise;
}

function getTestWorkerDelayMs(): number {
  const value = Number(process.env.IMCODES_TEST_PREVIEW_WORKER_DELAY_MS ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

async function applyTestWorkerDelay(): Promise<void> {
  const delayMs = getTestWorkerDelayMs();
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (parentPort) {
  parentPort.on('message', (message: PreviewReadWorkerRequest) => {
    void (async () => {
      const deps = await getDefaultDependencies();
      await applyTestWorkerDelay();
      const response = await handlePreviewReadWorkerRequest(message, deps);
      parentPort?.postMessage(response);
    })().catch(() => {
      // If default dependencies cannot load, there is no shared error-code set
      // available here. Let the worker crash so the main pool returns the
      // configured stable worker-unavailable/crashed code.
      process.exit(1);
    });
  });
}
