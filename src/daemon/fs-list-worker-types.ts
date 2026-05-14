export const DEFAULT_FS_LIST_WORKERS_TARGET = 2;
export const MIN_FS_LIST_WORKERS_TARGET = 1;
export const HARD_MAX_FS_LIST_WORKERS = 3;
export const DEFAULT_FS_LIST_POOL_QUEUE_CAP = 16;

export type FsListWorkerRequestId = number;
export type FsListWorkerSlotId = number;
export type FsListWorkerGeneration = number;

export interface FsListWorkerIdentity {
  workerRequestId: FsListWorkerRequestId;
  workerSlotId: FsListWorkerSlotId;
  workerGeneration: FsListWorkerGeneration;
}

export interface FsListWorkerEntry {
  name: string;
  path: string;
  isDir: boolean;
  hidden: boolean;
  size?: number;
  mime?: string;
}

export interface FsListBuildJobInput {
  realPath: string;
  includeFiles: boolean;
  includeMetadata: boolean;
}

export interface FsListWorkerRequest extends FsListBuildJobInput, FsListWorkerIdentity {}

export interface FsListWorkerSuccess extends FsListWorkerIdentity {
  kind: 'success';
  resolvedPath: string;
  dirSignature: string;
  entries: FsListWorkerEntry[];
}

export interface FsListWorkerError extends FsListWorkerIdentity {
  kind: 'error';
  reason: 'worker_internal';
  sanitized: true;
}

export type FsListWorkerResult = FsListWorkerSuccess | FsListWorkerError;

export function withFsListWorkerIdentity(
  input: FsListBuildJobInput,
  identity: FsListWorkerIdentity,
): FsListWorkerRequest {
  return { ...input, ...identity };
}

export function isFsListWorkerResultFor(
  result: FsListWorkerResult,
  identity: FsListWorkerIdentity,
): boolean {
  return result.workerRequestId === identity.workerRequestId
    && result.workerSlotId === identity.workerSlotId
    && result.workerGeneration === identity.workerGeneration;
}
