import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CAPABILITY_LIMITS,
  type CapabilityOperationCommitResultFrame,
  type CapabilityOperationCommitAbortFrame,
  type CapabilityOperationAuthorizeFrame,
  type CapabilityOperationActivateFrame,
  type CapabilityOperationProgressFrame,
  type CapabilityOperationManageFrame,
  type CapabilityOperationManageResultFrame,
  type CapabilityInstallRequest,
  type CapabilityOperation,
  type CapabilityAuthorityRecord,
  type CapabilityAuthorizationKey,
} from '../../shared/capability-management.js';
import type { DaemonCapabilityReviewedEvidence, DaemonCapabilityRollbackSnapshot } from './capability-service-adapter.js';

const SCHEMA_VERSION = 1 as const;

export interface DurableCapabilityCommit {
  createdAt?: number;
  expiresAt?: number;
  ownerId: string;
  result: CapabilityOperationCommitResultFrame;
  rollback: DaemonCapabilityRollbackSnapshot;
  authorize?: CapabilityOperationAuthorizeFrame;
  authority?: CapabilityAuthorityRecord;
  authorizationKeys?: readonly CapabilityAuthorizationKey[];
  /** WAL intent written before resolver-visible publication starts. */
  committing?: boolean;
  /** Durable server abort retained until exact local compensation succeeds. */
  abort?: CapabilityOperationCommitAbortFrame;
}

export interface DurableCapabilityManage {
  createdAt?: number;
  expiresAt?: number;
  ownerId: string;
  frame: CapabilityOperationManageFrame;
  result: CapabilityOperationManageResultFrame;
  rollback?: DaemonCapabilityRollbackSnapshot;
  /** Write-ahead intent persisted before the exact local mutation begins. */
  committing?: boolean;
}

export interface DurableCapabilityCandidate {
  operationId: string;
  ownerId: string;
  /** First durable retention boundary; old journals fall back to operation.createdAt. */
  createdAt: number;
  /** Exact bounded cleanup deadline for a candidate without an activation proposal. */
  expiresAt: number;
  request: CapabilityInstallRequest;
  requestDigest: string;
  expectedRevision: number;
  operation: CapabilityOperation;
  /** Original digest-bound deterministic scan and isolated-audit evidence. */
  reviewedEvidence?: DaemonCapabilityReviewedEvidence;
  archiveBase64?: string;
  blobDigest?: string;
  blobByteSize?: number;
  activation?: CapabilityOperationActivateFrame;
  activationExpiresAt?: number;
}

export class CapabilityJournalCapacityError extends Error {
  constructor() {
    super('capability candidate persistence limit exceeded');
    this.name = 'CapabilityJournalCapacityError';
  }
}

interface JournalState {
  schemaVersion: typeof SCHEMA_VERSION;
  serverId: string;
  commits: DurableCapabilityCommit[];
  manages: DurableCapabilityManage[];
  candidates: DurableCapabilityCandidate[];
  progresses: CapabilityOperationProgressFrame[];
}

function journalPath(homeDir: string, serverId: string): string {
  const key = createHash('sha256').update(serverId).digest('hex');
  return join(homeDir, '.imcodes', 'capability-operations', `${key}.json`);
}

function atomicWrite(path: string, value: JournalState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const file = openSync(temporary, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export class CapabilityOperationJournal {
  private readonly path: string;
  private state: JournalState;

  constructor(serverId: string, homeDir = homedir()) {
    this.path = journalPath(homeDir, serverId);
    this.state = { schemaVersion: SCHEMA_VERSION, serverId, commits: [], manages: [], candidates: [], progresses: [] };
    if (!existsSync(this.path)) return;
    try {
      if (statSync(this.path).size > Math.ceil(CAPABILITY_LIMITS.PERSISTED_CANDIDATE_BYTES * 4 / 3) + 4 * 1024 * 1024) {
        throw new Error('journal too large');
      }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<JournalState>;
      if (parsed.schemaVersion === SCHEMA_VERSION && parsed.serverId === serverId
        && Array.isArray(parsed.commits) && Array.isArray(parsed.manages) && Array.isArray(parsed.candidates ?? [])
        && Array.isArray(parsed.progresses ?? [])) {
        const now = Date.now();
        const alive = <T extends { createdAt?: number; expiresAt?: number }>(entry: T): T | undefined => {
          const createdAt = Number.isSafeInteger(entry.createdAt) && entry.createdAt! > 0 ? entry.createdAt! : now;
          const expiresAt = Number.isSafeInteger(entry.expiresAt) && entry.expiresAt! > createdAt
            ? entry.expiresAt! : createdAt + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS;
          return expiresAt > now ? { ...entry, createdAt, expiresAt } : undefined;
        };
        this.state = {
          schemaVersion: SCHEMA_VERSION,
          serverId,
          commits: (parsed.commits as DurableCapabilityCommit[]).flatMap((entry) => alive(entry) ?? [])
            .slice(-CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS),
          manages: (parsed.manages as DurableCapabilityManage[]).flatMap((entry) => alive(entry) ?? [])
            .slice(-CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS),
          candidates: (parsed.candidates ?? []).slice(0, 256) as DurableCapabilityCandidate[],
          progresses: (parsed.progresses ?? []).slice(0, CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS) as CapabilityOperationProgressFrame[],
        };
      }
    } catch {
      // Corrupt journals are ignored fail-closed. Resolver authority remains
      // empty after restart, so unacknowledged content cannot be loaded.
    }
  }

  commits(): readonly DurableCapabilityCommit[] { return structuredClone(this.state.commits); }
  manages(): readonly DurableCapabilityManage[] { return structuredClone(this.state.manages); }
  candidates(): readonly DurableCapabilityCandidate[] { return structuredClone(this.state.candidates); }
  progresses(): readonly CapabilityOperationProgressFrame[] { return structuredClone(this.state.progresses); }

  putProgress(frame: CapabilityOperationProgressFrame): void {
    this.state.progresses = [
      ...this.state.progresses.filter((item) => item.operationId !== frame.operationId),
      structuredClone(frame),
    ].slice(-CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS);
    this.persist();
  }

  deleteProgress(operationId: string): void {
    this.state.progresses = this.state.progresses.filter((item) => item.operationId !== operationId);
    this.persist();
  }

  putCandidate(entry: DurableCapabilityCandidate): void {
    const next = [...this.state.candidates.filter((item) => item.operationId !== entry.operationId), structuredClone(entry)];
    const aggregateBytes = next.reduce((total, item) => total + (item.blobByteSize ?? 0), 0);
    if (next.length > CAPABILITY_LIMITS.PERSISTED_CANDIDATES
      || aggregateBytes > CAPABILITY_LIMITS.PERSISTED_CANDIDATE_BYTES) {
      throw new CapabilityJournalCapacityError();
    }
    this.state.candidates = next;
    this.persist();
  }

  deleteCandidate(operationId: string): void {
    this.state.candidates = this.state.candidates.filter((item) => item.operationId !== operationId);
    this.persist();
  }

  putActivation(operationId: string, activation: CapabilityOperationActivateFrame, activationExpiresAt: number): boolean {
    const index = this.state.candidates.findIndex((item) => item.operationId === operationId);
    if (index < 0) return false;
    const candidate = this.state.candidates[index]!;
    this.state.candidates[index] = { ...candidate, activation: structuredClone(activation), activationExpiresAt };
    this.persist();
    return true;
  }

  clearActivation(operationId: string): void {
    const index = this.state.candidates.findIndex((item) => item.operationId === operationId);
    if (index < 0) return;
    const candidate = this.state.candidates[index]!;
    const rest = structuredClone(candidate);
    delete rest.activation;
    delete rest.activationExpiresAt;
    this.state.candidates[index] = rest;
    this.persist();
  }

  putCommit(entry: DurableCapabilityCommit): void {
    const now = Date.now();
    const next = [...this.state.commits.filter((item) => item.result.operationId !== entry.result.operationId), {
      ...structuredClone(entry), createdAt: entry.createdAt ?? now,
      expiresAt: entry.expiresAt ?? now + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
    }];
    if (next.length > CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS) throw new CapabilityJournalCapacityError();
    this.state.commits = next;
    this.persist();
  }

  deleteCommit(operationId: string): void {
    this.state.commits = this.state.commits.filter((item) => item.result.operationId !== operationId);
    this.persist();
  }

  putManage(entry: DurableCapabilityManage): void {
    const now = Date.now();
    const next = [...this.state.manages.filter((item) => item.frame.requestId !== entry.frame.requestId), {
      ...structuredClone(entry), createdAt: entry.createdAt ?? now,
      expiresAt: entry.expiresAt ?? now + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
    }];
    if (next.length > CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS) throw new CapabilityJournalCapacityError();
    this.state.manages = next;
    this.persist();
  }

  deleteManage(requestId: string): void {
    this.state.manages = this.state.manages.filter((item) => item.frame.requestId !== requestId);
    this.persist();
  }

  private persist(): void {
    if (this.state.commits.length === 0 && this.state.manages.length === 0
      && this.state.candidates.length === 0 && this.state.progresses.length === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    atomicWrite(this.path, this.state);
  }
}

export const CAPABILITY_OPERATION_JOURNAL_TESTING = { journalPath };
