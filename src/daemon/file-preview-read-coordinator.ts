import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { FS_READ_ERROR_CODES, FS_READ_PREVIEW_REASONS, type FsReadErrorCode } from '../../shared/fs-read-error-codes.js';
import type { FsReadResponse } from '../shared/transport/fs.js';
import {
  DEFAULT_PREVIEW_READ_ATTACHED_CAP,
  PreviewReadAdmissionController,
  type PreviewReadAdmissionDecision,
} from './file-preview-read-admission.js';
import { PreviewReadCacheFacade } from './file-preview-read-cache-facade.js';
import {
  PreviewReadFanOutDispatcher,
  type PreviewReadFanOutClock,
} from './file-preview-read-fanout.js';
import {
  PreviewReadPoolError,
  PreviewReadWorkerPool,
  type PreviewReadWorkerDispatchOptions,
  type PreviewReadWorkerThreadLike,
} from './file-preview-read-pool.js';
import {
  DEFAULT_PREVIEW_READ_SHUTDOWN_BUDGET_MS,
  PreviewReadDrainController,
} from './file-preview-read-shutdown.js';
import {
  assembleSnapshotTerminal,
  type PreviewReadPublicTerminal,
} from './file-preview-read-response.js';
import {
  handlePreviewReadWorkerRequest,
  type PreviewReadWorkerDependencies,
} from './file-preview-read-worker.js';
import { PREVIEW_READ_METRICS, recordPreviewReadMetric } from './file-preview-read-observability.js';
import { expandFilePreviewPath, resolveCanonical, isFilePreviewPathAllowed } from './file-preview-path-policy.js';
import { classifyFile, fileSignatureForStat, isBinaryBuffer } from './file-preview-classifier.js';
import type {
  PreviewReadPreflightSuccess,
  PreviewReadSnapshotSuccess,
  PreviewReadWorkerError,
  PreviewReadWorkerJobInput,
  PreviewReadWorkerRequest,
  PreviewReadWorkerResult,
} from './file-preview-read-types.js';

export interface PreviewReadCoordinatorErrorCodes {
  queueFull: FsReadErrorCode;
  timeout: FsReadErrorCode;
  unavailable: FsReadErrorCode;
  crashed: FsReadErrorCode;
  staleRead: FsReadErrorCode;
  invalidRequest: FsReadErrorCode;
  internalError: FsReadErrorCode;
}

export type PreviewReadAttachmentState =
  | { phase: 'preflight'; key: string }
  | { phase: 'snapshot'; key: string }
  | { phase: 'cache'; key: string }
  | { phase: 'terminal'; reason: string };

export interface ExternalRequestRecord {
  requestId: string;
  rawPath: string;
  admittedAt: number;
  deadlineAt: number;
  terminal: boolean;
  attachmentState: PreviewReadAttachmentState | null;
}

export interface PreviewReadPreflightJobRecord {
  key: string;
  rawPath: string;
  requestIds: Set<string>;
  startedAt: number;
}

export interface PreviewReadSnapshotJobRecord {
  key: string;
  realPath: string;
  startSignature: string;
  resourceGeneration: number;
  requestIds: Set<string>;
  startedAt: number;
}

export interface PreviewReadAssembleResultInput {
  request: ExternalRequestRecord;
  snapshot: PreviewReadSnapshotSuccess;
  fromCache: boolean;
}

export interface PreviewReadAssembleErrorInput {
  requestId: string;
  rawPath: string;
  resolvedPath?: string;
  error: FsReadErrorCode;
  workerError?: PreviewReadWorkerError;
}

export interface PreviewReadCoordinatorOptions<TResponse extends object> {
  errorCodes: PreviewReadCoordinatorErrorCodes;
  send(response: TResponse): void | Promise<void>;
  assembleResult(input: PreviewReadAssembleResultInput): TResponse;
  assembleError(input: PreviewReadAssembleErrorInput): TResponse;
  pool?: Pick<PreviewReadWorkerPool, 'dispatch' | 'getQueueDepth' | 'shutdown'>;
  admission?: PreviewReadAdmissionController;
  fanout?: PreviewReadFanOutDispatcher<TResponse>;
  cache?: PreviewReadCacheFacade;
  drain?: PreviewReadDrainController;
  attachedCap?: number;
  clock?: PreviewReadFanOutClock;
}

export interface PreviewReadSubmitResult {
  accepted: boolean;
  suppressed?: boolean;
  invalid?: boolean;
  admission?: PreviewReadAdmissionDecision;
}

const realFanOutClock: PreviewReadFanOutClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class PreviewReadCoordinator<TResponse extends object> {
  readonly pool: Pick<PreviewReadWorkerPool, 'dispatch' | 'getQueueDepth' | 'shutdown'>;
  readonly admission: PreviewReadAdmissionController;
  readonly fanout: PreviewReadFanOutDispatcher<TResponse>;
  readonly cache: PreviewReadCacheFacade;
  readonly drain: PreviewReadDrainController;
  readonly attachedCap: number;

  private readonly errorCodes: PreviewReadCoordinatorErrorCodes;
  private readonly assembleResult: (input: PreviewReadAssembleResultInput) => TResponse;
  private readonly assembleError: (input: PreviewReadAssembleErrorInput) => TResponse;
  private readonly externalRequests = new Map<string, ExternalRequestRecord>();
  private readonly preflightJobs = new Map<string, PreviewReadPreflightJobRecord>();
  private readonly snapshotJobs = new Map<string, PreviewReadSnapshotJobRecord>();

  constructor(options: PreviewReadCoordinatorOptions<TResponse>) {
    this.errorCodes = options.errorCodes;
    this.admission = options.admission ?? new PreviewReadAdmissionController();
    this.pool = options.pool ?? new PreviewReadWorkerPool({ clock: this.admission.clock });
    this.cache = options.cache ?? new PreviewReadCacheFacade();
    this.drain = options.drain ?? new PreviewReadDrainController();
    this.attachedCap = Math.max(1, Math.trunc(options.attachedCap ?? this.admission.attachedCap ?? DEFAULT_PREVIEW_READ_ATTACHED_CAP));
    this.assembleResult = options.assembleResult;
    this.assembleError = options.assembleError;
    this.fanout = options.fanout ?? new PreviewReadFanOutDispatcher<TResponse>({
      clock: options.clock ?? realFanOutClock,
      send: options.send,
	      onTerminal: (requestId, reason) => {
	        const record = this.externalRequests.get(requestId);
	        if (!record) return;
	        record.terminal = true;
	        record.attachmentState = { phase: 'terminal', reason };
	        this.externalRequests.delete(requestId);
	      },
    });
  }

  submit(input: { requestId?: unknown; path?: unknown }): PreviewReadSubmitResult {
    if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
      return { accepted: false, suppressed: true };
    }
    if (typeof input.path !== 'string' || input.path.length === 0) {
      this.fanout.sendDetached(this.assembleError({
        requestId: input.requestId,
        rawPath: typeof input.path === 'string' ? input.path : '',
        error: this.errorCodes.invalidRequest,
      }));
      return { accepted: false, invalid: true };
    }

    const admission = this.admission.decide(this.pool.getQueueDepth());
    if (!admission.admitted) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.QUEUE_FULL);
      this.fanout.sendDetached(this.assembleError({
        requestId: input.requestId,
        rawPath: input.path,
        error: this.errorCodes.queueFull,
      }));
      return { accepted: false, admission };
    }

    const { admittedAt, deadlineAt } = this.admission.deadlineFromNow();
    const record: ExternalRequestRecord = {
      requestId: input.requestId,
      rawPath: input.path,
      admittedAt,
      deadlineAt,
      terminal: false,
      attachmentState: null,
    };
    this.externalRequests.set(record.requestId, record);
    this.fanout.register({
      requestId: record.requestId,
      rawPath: record.rawPath,
      deadlineAt: record.deadlineAt,
      onTimeout: () => {
        recordPreviewReadMetric(PREVIEW_READ_METRICS.TIMEOUT);
        return this.assembleError({
          requestId: record.requestId,
          rawPath: record.rawPath,
          error: this.errorCodes.timeout,
        });
      },
    });

    this.attachToPreflight(record);
    return { accepted: true, admission };
  }

  getExternalRequest(requestId: string): ExternalRequestRecord | null {
    return this.externalRequests.get(requestId) ?? null;
  }

  invalidatePath(realPath: string): void {
    this.cache.invalidatePath(realPath);
  }

  async shutdown(budgetMs = DEFAULT_PREVIEW_READ_SHUTDOWN_BUDGET_MS): Promise<void> {
    const activeIds = [...this.externalRequests.values()]
      .filter((record) => !record.terminal)
      .map((record) => record.requestId);
    if (activeIds.length > 0) recordPreviewReadMetric(PREVIEW_READ_METRICS.SHUTDOWN_DRAIN);
    const drain = budgetMs === this.drain.budgetMs
      ? this.drain
      : new PreviewReadDrainController({ budgetMs });
    await drain.drain(activeIds, async (requestId) => {
      const record = this.externalRequests.get(requestId);
      if (!record) return;
      this.fanout.forceTerminal(requestId, () => this.assembleError({
        requestId,
        rawPath: record.rawPath,
        error: this.errorCodes.unavailable,
      }), 'shutdown');
      await this.fanout.flush();
    });
    await this.pool.shutdown();
  }

  private attachToPreflight(record: ExternalRequestRecord): void {
    const key = record.rawPath;
    const existing = this.preflightJobs.get(key);
    if (existing) {
      if (existing.requestIds.size >= this.attachedCap) {
        this.fanout.forceTerminal(record.requestId, () => this.assembleError({
          requestId: record.requestId,
          rawPath: record.rawPath,
          error: this.errorCodes.queueFull,
        }), 'queue_full');
        return;
      }
      existing.requestIds.add(record.requestId);
      record.attachmentState = { phase: 'preflight', key };
      return;
    }

    const job: PreviewReadPreflightJobRecord = {
      key,
      rawPath: record.rawPath,
      requestIds: new Set([record.requestId]),
      startedAt: this.admission.clock.now(),
    };
    this.preflightJobs.set(key, job);
    record.attachmentState = { phase: 'preflight', key };
    void this.runPreflight(job);
  }

  private async runPreflight(job: PreviewReadPreflightJobRecord): Promise<void> {
    const startedAt = this.admission.clock.now();
    try {
      const deadlineAt = this.getWorkerDispatchDeadlineAt(job.requestIds);
      if (deadlineAt === null) return;
      const result = await this.dispatchWorker({ phase: 'preflight', rawPath: job.rawPath }, { deadlineAt });
      this.admission.recordJobDuration(this.admission.clock.now() - startedAt);
      if (result.kind === 'error') {
        this.finishJobWithWorkerError(job.requestIds, result);
        return;
      }
      if (result.phase !== 'preflight') {
        this.finishJobWithError(job.requestIds, this.errorCodes.internalError);
        return;
      }
      for (const requestId of job.requestIds) {
        const record = this.externalRequests.get(requestId);
        if (!record || record.terminal) continue;
        this.attachToSnapshot(record, result);
      }
    } catch (error) {
      this.finishJobWithError(job.requestIds, this.mapDispatchError(error));
    } finally {
      this.preflightJobs.delete(job.key);
    }
  }

  private attachToSnapshot(record: ExternalRequestRecord, preflight: PreviewReadPreflightSuccess): void {
    const generation = this.cache.getGeneration(preflight.realPath);
    const cached = this.cache.getCached(preflight.realPath, preflight.startSignature);
    if (cached) {
      const cacheKey = this.cache.makeSnapshotKey(preflight.realPath, preflight.startSignature, generation);
      record.attachmentState = { phase: 'cache', key: cacheKey };
      this.fanout.sendTerminal(record.requestId, () => this.assembleResult({
        request: record,
        snapshot: cached,
        fromCache: true,
      }), 'success');
      return;
    }

    const key = this.cache.makeSnapshotKey(preflight.realPath, preflight.startSignature, generation);
    const existing = this.snapshotJobs.get(key);
    if (existing) {
      if (existing.requestIds.size >= this.attachedCap) {
        this.fanout.forceTerminal(record.requestId, () => this.assembleError({
          requestId: record.requestId,
          rawPath: record.rawPath,
          resolvedPath: preflight.realPath,
          error: this.errorCodes.queueFull,
        }), 'queue_full');
        return;
      }
      existing.requestIds.add(record.requestId);
      record.attachmentState = { phase: 'snapshot', key };
      return;
    }

    const job: PreviewReadSnapshotJobRecord = {
      key,
      realPath: preflight.realPath,
      startSignature: preflight.startSignature,
      resourceGeneration: generation,
      requestIds: new Set([record.requestId]),
      startedAt: this.admission.clock.now(),
    };
    this.snapshotJobs.set(key, job);
    this.cache.setInflight(key, job);
    record.attachmentState = { phase: 'snapshot', key };
    void this.runSnapshot(job, preflight);
  }

  private async runSnapshot(job: PreviewReadSnapshotJobRecord, preflight: PreviewReadPreflightSuccess): Promise<void> {
    const startedAt = this.admission.clock.now();
    try {
      const deadlineAt = this.getWorkerDispatchDeadlineAt(job.requestIds);
      if (deadlineAt === null) return;
      const result = await this.dispatchWorker({
        phase: 'snapshot',
        realPath: preflight.realPath,
        startSignature: preflight.startSignature,
        size: preflight.size,
        mtimeMs: preflight.mtimeMs,
        fileName: preflight.fileName,
        classification: preflight.classification,
      }, { deadlineAt });
      this.admission.recordJobDuration(this.admission.clock.now() - startedAt);
      if (result.kind === 'error') {
        this.finishJobWithWorkerError(job.requestIds, result);
        return;
      }
      if (result.phase !== 'snapshot') {
        this.finishJobWithError(job.requestIds, this.errorCodes.internalError);
        return;
      }
      if (result.startSignature !== result.endSignature) {
        recordPreviewReadMetric(PREVIEW_READ_METRICS.STALE_READ);
        this.finishJobWithError(job.requestIds, this.errorCodes.staleRead, result.realPath);
        return;
      }

	      const eligibleRequestIds = this.getEligibleRequestIds(job.requestIds);
	      if (eligibleRequestIds.length === 0) return;

	      this.cache.writeSnapshot(result, job.resourceGeneration);
	      this.fanout.sendTerminalMany(eligibleRequestIds, (requestId) => {
	        const request = this.externalRequests.get(requestId);
	        if (!request) {
	          return this.assembleError({ requestId, rawPath: '', error: this.errorCodes.internalError });
	        }
	        return this.assembleResult({ request, snapshot: result, fromCache: false });
      }, 'success');
    } catch (error) {
      this.finishJobWithError(job.requestIds, this.mapDispatchError(error), job.realPath);
    } finally {
      this.snapshotJobs.delete(job.key);
      this.cache.deleteInflight(job.key);
    }
  }

	  private async dispatchWorker(input: PreviewReadWorkerJobInput, options: PreviewReadWorkerDispatchOptions): Promise<PreviewReadWorkerResult> {
	    return await this.pool.dispatch(input, options);
	  }

	  private getEligibleRequestIds(requestIds: Iterable<string>): string[] {
	    const now = this.admission.clock.now();
	    const eligible: string[] = [];
	    for (const requestId of requestIds) {
	      const request = this.externalRequests.get(requestId);
	      if (!request || request.terminal || request.deadlineAt <= now) continue;
	      eligible.push(requestId);
	    }
	    return eligible;
	  }

	  private getWorkerDispatchDeadlineAt(requestIds: Iterable<string>): number | null {
	    const now = this.admission.clock.now();
	    let deadlineAt: number | null = null;
	    for (const requestId of requestIds) {
	      const request = this.externalRequests.get(requestId);
	      if (!request || request.terminal || request.deadlineAt <= now) continue;
	      deadlineAt = Math.max(deadlineAt ?? request.deadlineAt, request.deadlineAt);
	    }
	    return deadlineAt;
	  }

  private finishJobWithWorkerError(requestIds: Iterable<string>, error: PreviewReadWorkerError): void {
    if (error.error === this.errorCodes.internalError) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.SANITIZED_INTERNAL_ERROR);
    }
    if (error.error === this.errorCodes.staleRead) {
      recordPreviewReadMetric(PREVIEW_READ_METRICS.STALE_READ);
    }
    for (const requestId of requestIds) {
      const request = this.externalRequests.get(requestId);
      if (!request || request.terminal) continue;
      this.fanout.sendTerminal(requestId, () => this.assembleError({
        requestId,
        rawPath: request.rawPath,
        error: error.error,
        workerError: error,
      }), 'worker_error');
    }
  }

  private finishJobWithError(requestIds: Iterable<string>, error: FsReadErrorCode, resolvedPath?: string): void {
    for (const requestId of requestIds) {
      const request = this.externalRequests.get(requestId);
      if (!request || request.terminal) continue;
      this.fanout.sendTerminal(requestId, () => this.assembleError({
        requestId,
        rawPath: request.rawPath,
        ...(resolvedPath ? { resolvedPath } : {}),
        error,
      }), 'error');
    }
  }

  private mapDispatchError(error: unknown): FsReadErrorCode {
    if (error instanceof PreviewReadPoolError) {
      switch (error.reason) {
        case 'queue_full':
          return this.errorCodes.queueFull;
	        case 'crashed':
	          return this.errorCodes.crashed;
	        case 'timeout':
	          return this.errorCodes.timeout;
	        case 'shutdown':
	        case 'unavailable':
	          return this.errorCodes.unavailable;
        case 'stale_result':
          return this.errorCodes.staleRead;
      }
    }
    return this.errorCodes.internalError;
  }
}

type FsReadSend = (message: FsReadResponse) => void | Promise<void>;

function toFsReadResponse(terminal: PreviewReadPublicTerminal): FsReadResponse {
  const { rawPath, ...rest } = terminal;
  return {
    type: 'fs.read_response',
    path: rawPath,
    ...rest,
  } as FsReadResponse;
}

function assembleDefaultError(input: PreviewReadAssembleErrorInput): FsReadResponse {
  return {
    type: 'fs.read_response',
    requestId: input.requestId,
    path: input.rawPath,
    ...(input.resolvedPath ? { resolvedPath: input.resolvedPath } : {}),
    status: 'error',
    error: input.error,
  };
}

export class DefaultPreviewReadCoordinator {
  private readonly sendByRequestId = new Map<string, FsReadSend>();
  private readonly coordinator: PreviewReadCoordinator<FsReadResponse>;

  constructor() {
    const pool = shouldUseInProcessPreviewReadPoolForTests()
      ? new PreviewReadWorkerPool({ createWorker: () => createDirectPreviewReadWorkerThread() })
      : undefined;
    this.coordinator = new PreviewReadCoordinator<FsReadResponse>({
      errorCodes: {
        queueFull: FS_READ_ERROR_CODES.PREVIEW_WORKER_QUEUE_FULL,
        timeout: FS_READ_ERROR_CODES.PREVIEW_WORKER_TIMEOUT,
        unavailable: FS_READ_ERROR_CODES.PREVIEW_WORKER_UNAVAILABLE,
        crashed: FS_READ_ERROR_CODES.PREVIEW_WORKER_CRASHED,
        staleRead: FS_READ_ERROR_CODES.STALE_READ,
        invalidRequest: FS_READ_ERROR_CODES.INVALID_REQUEST,
        internalError: FS_READ_ERROR_CODES.INTERNAL_ERROR,
      },
      send: async (message) => {
        const send = this.sendByRequestId.get(message.requestId);
        if (!send) return;
        this.sendByRequestId.delete(message.requestId);
        await send(message);
      },
      assembleResult: ({ request, snapshot }) => toFsReadResponse(assembleSnapshotTerminal({
        requestId: request.requestId,
        rawPath: request.rawPath,
        snapshot,
      })),
      assembleError: assembleDefaultError,
      ...(pool ? { pool } : {}),
    });
  }

  handle(path: unknown, requestId: unknown, send: FsReadSend): void {
    if (typeof requestId === 'string' && requestId.length > 0) {
      this.sendByRequestId.set(requestId, send);
    }
    this.coordinator.submit({ path, requestId });
  }

  invalidatePath(realPath: string): void {
    this.coordinator.invalidatePath(realPath);
  }

  invalidate(realPath: string): void {
    this.invalidatePath(realPath);
  }

  async shutdown(): Promise<void> {
    await this.coordinator.shutdown();
    this.sendByRequestId.clear();
  }
}

export function shouldUseInProcessPreviewReadPoolForTests(): boolean {
  return process.env.VITEST === 'true'
    || process.env.VITEST_WORKER_ID !== undefined;
}

let defaultPreviewReadCoordinator: DefaultPreviewReadCoordinator | null = null;

export function getDefaultPreviewReadCoordinator(): DefaultPreviewReadCoordinator {
  defaultPreviewReadCoordinator ??= new DefaultPreviewReadCoordinator();
  return defaultPreviewReadCoordinator;
}

export async function shutdownDefaultPreviewReadCoordinatorForDaemon(): Promise<void> {
  await getDefaultPreviewReadCoordinator().shutdown();
}

export function __resetPreviewReadCoordinatorForTests(): void {
  const current = defaultPreviewReadCoordinator;
  defaultPreviewReadCoordinator = null;
  current?.shutdown().catch(() => {});
}

function createDirectPreviewReadWorkerThread(): PreviewReadWorkerThreadLike {
  let messageListener: ((message: PreviewReadWorkerResult) => void) | null = null;
  let errorListener: ((error: Error) => void) | null = null;
  const deps = createDirectPreviewReadWorkerDependencies();
  const directWorker: PreviewReadWorkerThreadLike = {
    postMessage(message: PreviewReadWorkerRequest): void {
      void handlePreviewReadWorkerRequest(message, deps)
        .then((result) => messageListener?.(result))
        .catch((error) => errorListener?.(error instanceof Error ? error : new Error(String(error))));
    },
    on(event: 'message' | 'error' | 'exit', listener: ((arg: PreviewReadWorkerResult | Error | number) => void)) {
      if (event === 'message') messageListener = listener as (message: PreviewReadWorkerResult) => void;
      if (event === 'error') errorListener = listener as (error: Error) => void;
      return this;
    },
    async terminate(): Promise<unknown> {
      return 0;
    },
    unref(): void {},
  } as PreviewReadWorkerThreadLike;
  return directWorker;
}

function createDirectPreviewReadWorkerDependencies(): PreviewReadWorkerDependencies {
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
	    async resolveCanonicalStrict(rawPath) {
	      return await realpath(resolvePath(expandFilePreviewPath(rawPath)));
	    },
    isPathAllowed: isFilePreviewPathAllowed,
    stat,
    readFile,
    classifyFile,
    isBinaryBuffer,
    signatureForStat: fileSignatureForStat,
  };
}
