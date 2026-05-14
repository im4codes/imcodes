export const DEFAULT_FS_GIT_STATUS_WORKERS_TARGET = 2;
export const MIN_FS_GIT_STATUS_WORKERS_TARGET = 1;
export const HARD_MAX_FS_GIT_STATUS_WORKERS = 3;
export const DEFAULT_FS_GIT_STATUS_POOL_QUEUE_CAP = 12;

export type FsGitStatusWorkerRequestId = number;
export type FsGitStatusWorkerSlotId = number;
export type FsGitStatusWorkerGeneration = number;

export interface FsGitStatusWorkerIdentity {
  workerRequestId: FsGitStatusWorkerRequestId;
  workerSlotId: FsGitStatusWorkerSlotId;
  workerGeneration: FsGitStatusWorkerGeneration;
}

export interface FsGitStatusWorkerFile {
  path: string;
  code: string;
  additions?: number;
  deletions?: number;
}

export interface FsGitStatusBuildJobInput {
  repoRoot: string;
  repoSignature: string;
  requestedPath: string;
  includeStats: boolean;
}

export interface FsGitStatusWorkerRequest extends FsGitStatusBuildJobInput, FsGitStatusWorkerIdentity {}

export interface FsGitStatusWorkerSuccess extends FsGitStatusWorkerIdentity {
  kind: 'success';
  repoRoot: string;
  repoSignature: string;
  requestedPath: string;
  includeStats: boolean;
  files: FsGitStatusWorkerFile[];
}

export interface FsGitStatusWorkerError extends FsGitStatusWorkerIdentity {
  kind: 'error';
  reason: 'worker_internal' | 'git_unavailable';
  sanitized: true;
}

export type FsGitStatusWorkerResult = FsGitStatusWorkerSuccess | FsGitStatusWorkerError;

export function withFsGitStatusWorkerIdentity(
  input: FsGitStatusBuildJobInput,
  identity: FsGitStatusWorkerIdentity,
): FsGitStatusWorkerRequest {
  return { ...input, ...identity };
}

export function isFsGitStatusWorkerResultFor(
  result: FsGitStatusWorkerResult,
  identity: FsGitStatusWorkerIdentity,
): boolean {
  return result.workerRequestId === identity.workerRequestId
    && result.workerSlotId === identity.workerSlotId
    && result.workerGeneration === identity.workerGeneration;
}
