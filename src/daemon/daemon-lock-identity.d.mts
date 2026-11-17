export type ProcessLiveness =
  | { status: 'alive'; startToken: string }
  | { status: 'reclaimable'; reason: 'absent' }
  | { status: 'reclaimable'; reason: 'reaped'; startToken: string }
  | { status: 'unknown'; reason: string };

export interface DaemonLockIdentityOwner {
  pid?: number;
  startToken: string;
}

export interface InstanceLockMetadataRecord {
  version: 1;
  pid: number;
  startToken: string;
  acquiredAt: number;
  socketPath: string;
  sessionIds: string[];
  residualResources: string[];
}

export const KNOWN_START_TOKEN_SCHEMES: ReadonlySet<string>;
export function isReapedProcessState(state: string): boolean;
export function startTokenScheme(token: string): string;
export function linuxProcStatLiveness(statText: string): ProcessLiveness;
export function psLiveness(output: string): ProcessLiveness;
export function probeProcessLivenessWithExec(
  pid: number,
  platform?: NodeJS.Platform,
  runExecFileSync?: (file: string, args: readonly string[], options: Record<string, unknown>) => string | Buffer,
): ProcessLiveness;
export function probeProcessLiveness(pid: number, platform?: NodeJS.Platform): ProcessLiveness;
export function probeProcessStartToken(pid: number, platform?: NodeJS.Platform): string | null;
export function daemonProcessAppearsRunning(pid: number, probe?: (pid: number) => ProcessLiveness): boolean;
export function ownerRemainsAuthoritative(owner: Pick<DaemonLockIdentityOwner, 'startToken'>, liveness: ProcessLiveness): boolean;
export function ownerMatchesLiveProcess(owner: Pick<DaemonLockIdentityOwner, 'startToken'> | null | undefined, liveness: ProcessLiveness): boolean;
export function readInstanceLockMetadata(metadataPath: string): InstanceLockMetadataRecord | null;
export function defaultDaemonLockMetadataPath(stateDir: string): string;
